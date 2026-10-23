import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  NotificationConfig,
  Payable,
  PayableTemplate,
} from "../types/domain.js";
import { DomainError, domainErrors } from "../writes/errors.js";
import { assertCategoryKind } from "../categories/resolve.js";
import { addMonthsSafe } from "../shared/billing-month.js";
import { withTransaction, } from "../db/pool.js";
import { assertWorkspaceWritableInTx } from "../auth/workspace-lifecycle-guard.js";
import { lockCategoryReferencesInTx } from "../auth/category-lifecycle-guard.js";
import type { PayableStore } from "./store.js";

type Row = Record<string, unknown>;

type QueryFn = <R extends Row = Row>(text: string, values?: unknown[]) => Promise<R[]>;

type CreatePayableInput = Parameters<PayableStore["createPayable"]>[1];
type PayPayableInput = Parameters<PayableStore["markPayablePaid"]>[2];
type UpdatePayableInput = Parameters<PayableStore["updatePayable"]>[2];
type CreateTemplateInput = Parameters<PayableStore["createTemplate"]>[1];
type FromTemplateInput = Parameters<PayableStore["createPayableFromTemplate"]>[1];
type WithTemplateInput = Parameters<PayableStore["createPayableWithTemplate"]>[1];

/**
 * V4.1 Phase 3 (UOW2) — client-bound payable cores (no transaction
 * handling). The plain store methods run them in their own transaction;
 * keyed route producers (see payables/keyed-mutations.ts) run them on the
 * open idempotency claim client, so claim + effect + completion commit
 * atomically in ONE transaction. Phase 2 guarantees (row locks, status
 * guards) hold inside the merged tx — they run on the same client.
 */
const clientQueryFn = (client: PoolClient): QueryFn =>
  async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> =>
    (await client.query<R>(text, values)).rows;

const createPayableInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreatePayableInput,
): Promise<Payable> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  if (input.categoryId !== undefined) await lockCategoryReferencesInTx(client, householdId);
  // V4.1 Task 2.15: same category gate as the plain path.
  if (input.categoryId !== undefined) {
    await assertPayableCategoryInTx(clientQueryFn(client), householdId, input.categoryId);
  }
  return insertPayableRow(clientQueryFn(client), householdId, input);
};

const markPayablePaidInTx = async (
  client: PoolClient,
  householdId: string,
  payableId: string,
  input: PayPayableInput,
): Promise<Payable> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  // V4.1 Task 2.2: serialize concurrent payments on the payable row.
  // The status check below the lock is the single decision point, so
  // two concurrent payers converge on exactly one financial effect.
  const existing = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [payableId, householdId],
  );
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound("Conta a pagar");
  const p = mapPayable(existing.rows[0]!);
  if (p.status === "paid" || p.status === "cancelled") {
    throw new DomainError(
      "validation.invalid",
      `Conta a pagar já está ${p.status === "paid" ? "paga" : "cancelada"}`,
      409,
    );
  }
  // V4.1 Task 2.3 (D1/D3): the payment always creates the expense
  // transaction AND debits the paying account in the same tx.
  // Negative-balance rule (user-approved): bank/cash payers may cross
  // below zero — no insufficient-balance rejection. The row lock above
  // stays so concurrent payments still serialize on the account.
  const accRows = await client.query<Row>(
    `SELECT id, kind, balance_cents, status FROM accounts WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [p.accountId, householdId],
  );
  if (accRows.rowCount === 0 || accRows.rows.length === 0) throw domainErrors.notFound("Conta");
  const acc = accRows.rows[0]!;
  if (acc["status"] !== "active") throw domainErrors.notFound("Conta");
  if (acc["kind"] === "credit_card") {
    throw new DomainError("validation.invalid", "compra no cartão deve usar /cards/purchases.", 422);
  }
  const paidDate = input.paidDate ?? todayISO();
  const paidTxId = randomUUID();
  await client.query(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id)
     VALUES ($1,$2,'expense',$3,$4,$5,$6,$7)`,
    [
      paidTxId,
      householdId,
      p.description,
      p.amountCents,
      paidDate,
      p.accountId,
      p.categoryId ?? null,
    ],
  );
  await client.query(
    `UPDATE accounts SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
    [p.amountCents, p.accountId, householdId],
  );
  await client.query(
    `UPDATE accounts_payable SET status = 'paid', paid_date = $1, paid_amount_cents = amount_cents, paid_transaction_id = $2, updated_at = NOW() WHERE id = $3 AND household_id = $4`,
    [paidDate, paidTxId, payableId, householdId],
  );

  if (p.type === "recurring" && p.frequency && !input.prepayMonths) {
    const nextDue = getNextDue(p.dueDate, p.frequency);
    if (nextDue && (!p.endDate || nextDue <= p.endDate)) {
      const nextId = randomUUID();
      await client.query(
        `INSERT INTO accounts_payable (id, household_id, account_id, description, amount_cents, due_date, type, frequency, end_date, reminder_days_before, notes, category_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'recurring',$7,$8,$9,$10,$11,'pending')`,
        [
          nextId,
          householdId,
          p.accountId,
          p.description,
          p.amountCents,
          nextDue,
          p.frequency,
          p.endDate ?? null,
          p.reminderDaysBefore ?? 0,
          p.notes ?? null,
          p.categoryId ?? null,
        ],
      );
    }
  }

  const rows = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`,
    [payableId, householdId],
  );
  return mapPayable(rows.rows[0]!);
};

const updatePayableInTx = async (
  client: PoolClient,
  householdId: string,
  payableId: string,
  input: UpdatePayableInput,
): Promise<Payable> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  if (input.categoryId !== undefined) await lockCategoryReferencesInTx(client, householdId);
  const existing = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [payableId, householdId],
  );
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound("Conta a pagar");
  if (existing.rows[0]!.status === "cancelled")
    throw new DomainError(
      "validation.invalid",
      "Conta cancelada não pode ser editada",
      409,
    );
  // V4.1 Task 2.15: same category gate as createPayable.
  if (input.categoryId !== undefined) {
    await assertPayableCategoryInTx(clientQueryFn(client), householdId, input.categoryId);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (input.description !== undefined) {
    sets.push(`description = $${idx++}`);
    params.push(input.description);
  }
  if (input.amountCents !== undefined) {
    sets.push(`amount_cents = $${idx++}`);
    params.push(input.amountCents);
  }
  if (input.dueDate !== undefined) {
    sets.push(`due_date = $${idx++}`);
    params.push(input.dueDate);
  }
  if (input.accountId !== undefined) {
    sets.push(`account_id = $${idx++}`);
    params.push(input.accountId);
  }
  if (input.categoryId !== undefined) {
    sets.push(`category_id = $${idx++}`);
    params.push(input.categoryId);
  }
  if (sets.length === 0) return mapPayable(existing.rows[0]!);
  sets.push(`updated_at = NOW()`);
  params.push(payableId);
  params.push(householdId);
  await client.query(
    `UPDATE accounts_payable SET ${sets.join(", ")} WHERE id = $${idx} AND household_id = $${idx + 1}`,
    params,
  );
  const rows = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`,
    [payableId, householdId],
  );
  return mapPayable(rows.rows[0]!);
};

const createTemplateInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateTemplateInput,
): Promise<PayableTemplate> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const id = randomUUID();
  await client.query(
    `INSERT INTO payable_templates (id, household_id, account_id, name, description, amount_cents, frequency, day_of_month, reminder_days_before, notes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
    [
      id,
      householdId,
      input.accountId,
      input.name,
      input.description,
      input.amountCents,
      input.frequency,
      input.dayOfMonth,
      input.reminderDaysBefore ?? 0,
      input.notes ?? null,
    ],
  );
  const rows = await client.query<Row>(
    `SELECT * FROM payable_templates WHERE id = $1 AND household_id = $2`,
    [id, householdId],
  );
  return mapTemplate(rows.rows[0]!);
};

const createPayableFromTemplateInTx = async (
  client: PoolClient,
  householdId: string,
  input: FromTemplateInput,
): Promise<Payable> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  let t: PayableTemplate | undefined;
  if (input.templateId) {
    const rows = await client.query<Row>(
      `SELECT * FROM payable_templates WHERE id = $1 AND household_id = $2`,
      [input.templateId, householdId],
    );
    if (rows.rowCount !== null && (rows.rowCount ?? 0) > 0) t = mapTemplate(rows.rows[0]!);
  } else if (input.templateName) {
    const rows = await client.query<Row>(
      `SELECT * FROM payable_templates WHERE name = $1 AND household_id = $2`,
      [input.templateName, householdId],
    );
    if (rows.rowCount !== null && (rows.rowCount ?? 0) > 0) t = mapTemplate(rows.rows[0]!);
  }
  if (!t) throw domainErrors.notFound("Template");

  // Client-bound core directly (never `this.createPayable`, which would
  // open an independent transaction outside the claim tx).
  return createPayableInTx(client, householdId, {
    accountId: t.accountId,
    description: t.description,
    amountCents: input.amountOverrideCents ?? t.amountCents,
    dueDate: input.dueDate,
    type: "recurring",
    frequency: t.frequency,
    ...(t.reminderDaysBefore != null
      ? { reminderDaysBefore: t.reminderDaysBefore }
      : {}),
    ...(t.notes ? { notes: t.notes } : {}),
  });
};

const createPayableWithTemplateInTx = async (
  client: PoolClient,
  householdId: string,
  input: WithTemplateInput,
): Promise<Payable> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  if (input.payable.categoryId !== undefined) await lockCategoryReferencesInTx(client, householdId);
  const templateId = randomUUID();
  await client.query(
    `INSERT INTO payable_templates (id, household_id, account_id, name, description, amount_cents, frequency, day_of_month, reminder_days_before, notes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
    [
      templateId,
      householdId,
      input.template.accountId,
      input.template.name,
      input.template.description,
      input.template.amountCents,
      input.template.frequency,
      input.template.dayOfMonth,
      input.template.reminderDaysBefore ?? 0,
      input.template.notes ?? null,
    ],
  );

  const payableId = randomUUID();
  const initialStatus = todayISO() <= input.payable.dueDate ? "pending" : "overdue";
  // V4.1 Phase 4 Task 4.11: code→schema alignment — accounts_payable has
  // no template_id column (V005; nothing reads it), so the link is not
  // persisted. The template row above remains the record of origin.
  await client.query(
    `INSERT INTO accounts_payable (id, household_id, account_id, category_id, description, amount_cents, due_date, type, frequency, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      payableId,
      householdId,
      input.payable.accountId,
      input.payable.categoryId ?? null,
      input.payable.description,
      input.payable.amountCents,
      input.payable.dueDate,
      input.payable.type ?? "recurring",
      input.payable.frequency ?? null,
      initialStatus,
      input.payable.notes ?? null,
    ],
  );
  const rows = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`,
    [payableId, householdId],
  );
  return mapPayable(rows.rows[0]!);
};

/**
 * V4.1 DEBT-CODER-BULKTX — client-bound bulk cores (no transaction
 * handling). `autoCreateFromTemplates` used to fan out into one
 * `createPayableFromTemplate` transaction PER ROW (plus a detached
 * idempotency claim tx at the route), so a mid-batch failure left partial
 * effects behind. Both bulk effects now run all row writes on the caller's
 * client: the plain store methods wrap them in ONE withTransaction, and
 * keyed route producers (see payables/keyed-mutations.ts
 * `runPayableBulkMutation`) run them on the open idempotency claim client,
 * so claim + every row + completion commit atomically.
 */
const autoCreateFromTemplatesInTx = async (
  client: PoolClient,
  householdId: string,
  daysAhead = 30,
): Promise<Payable[]> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const q = clientQueryFn(client);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const limit = new Date(today.getTime() + daysAhead * 86_400_000).toISOString().slice(0, 10);
  // ORDER BY keeps bulk processing deterministic (was: undefined heap order).
  const templates = (await q<Row>(
    `SELECT * FROM payable_templates WHERE household_id = $1 AND active = true ORDER BY name ASC, id ASC`,
    [householdId],
  )).map(mapTemplate);
  const created: Payable[] = [];
  for (const template of templates) {
    const dueDate = nextTemplateDue(template.dayOfMonth, today);
    if (dueDate > limit) continue;
    const existing = await q<Row>(
      `SELECT id FROM accounts_payable WHERE household_id = $1 AND description = $2 AND due_date = $3::date AND deleted_at IS NULL LIMIT 1`,
      [householdId, template.description, dueDate],
    );
    if (existing.length > 0) continue;
    // Client-bound core directly (never `this.createPayableFromTemplate`,
    // which would open an independent transaction per row).
    created.push(await createPayableFromTemplateInTx(client, householdId, {
      templateId: template.id,
      dueDate,
    }));
  }
  return created;
};

const refreshPayableStatusInTx = async (
  client: PoolClient,
  householdId: string,
): Promise<Payable[]> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  // Single UPDATE statement: already atomic row-wise, but it must still run
  // on the caller's client so it joins the claim tx under idempotency.
  const today = todayISO();
  await client.query(
    `UPDATE accounts_payable SET status = 'overdue', updated_at = NOW()
      WHERE household_id = $1 AND deleted_at IS NULL AND status = 'pending' AND due_date < $2::date`,
    [householdId, today],
  );
  const rows = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE household_id = $1 AND deleted_at IS NULL ORDER BY due_date ASC, id ASC`,
    [householdId],
  );
  return rows.rows.map(mapPayable);
};

/**
 * Canonical-schema category gate for payable writes (V4.1 Task 2.15,
 * SPEC §9.8): an explicitly provided categoryId must be an active
 * expense-kind category of the household — 404 when unknown/inactive,
 * 400 on kind mismatch. The lookup stays schema-local (status column);
 * the legacy twin in legacy-postgres.ts mirrors it with `active`.
 */
export const assertPayableCategoryInTx = async (
  query: QueryFn,
  householdId: string,
  categoryId: string,
): Promise<void> => {
  const rows = await query<Row>(
    `SELECT id, kind, status FROM categories WHERE id = $1 AND household_id = $2`,
    [categoryId, householdId],
  );
  if (rows.length === 0) throw domainErrors.notFound("Categoria");
  const cat = rows[0]!;
  if (cat["status"] !== "active") throw domainErrors.notFound("Categoria");
  assertCategoryKind(
    { id: categoryId, householdId, kind: String(cat["kind"]), status: "active" },
    "expense",
  );
};

/**
 * Shared payable-row insert core (schema-compatible INSERT): the canonical
 * store runs it after the canonical category gate; the legacy override in
 * legacy-postgres.ts runs it after the legacy (`active`) gate.
 */
export const insertPayableRow = async (
  query: QueryFn,
  householdId: string,
  input: CreatePayableInput,
): Promise<Payable> => {
  const id = randomUUID();
  await query(
    `INSERT INTO accounts_payable (id, household_id, account_id, description, amount_cents, due_date, type, frequency, end_date, reminder_days_before, notes, category_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
    [
      id,
      householdId,
      input.accountId,
      input.description,
      input.amountCents,
      input.dueDate,
      input.type ?? "one_time",
      input.frequency ?? null,
      input.endDate ?? null,
      input.reminderDaysBefore ?? 0,
      input.notes ?? null,
      input.categoryId ?? null,
    ],
  );
  const rows = await query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`,
    [id, householdId],
  );
  return mapPayable(rows[0]!);
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function nextTemplateDue(dayOfMonth: number, today: Date): string {
  let year = today.getUTCFullYear();
  let month = today.getUTCMonth();
  let candidate = new Date(Date.UTC(year, month, Math.min(dayOfMonth, daysInMonth(year, month))));
  if (candidate < today) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    candidate = new Date(Date.UTC(year, month, Math.min(dayOfMonth, daysInMonth(year, month))));
  }
  return candidate.toISOString().slice(0, 10);
}

function opt<T extends Record<string, unknown>>(obj: T, props: Partial<T>): T {
  const result = { ...obj };
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null) (result as any)[k] = v;
  }
  return result;
}

const mapPayable = (r: Row): Payable =>
  opt<Payable>(
    {
      id: r["id"] as string,
      householdId: r["household_id"] as string,
      accountId: r["account_id"] as string,
      description: r["description"] as string,
      amountCents: Number(r["amount_cents"]),
      dueDate: (r["due_date"] as Date).toISOString().slice(0, 10),
      type: r["type"] as Payable["type"],
      status: r["status"] as Payable["status"],
    },
    {
      frequency: (r["frequency"] as Payable["frequency"]) ?? undefined,
      endDate: r["end_date"]
        ? (r["end_date"] as Date).toISOString().slice(0, 10)
        : undefined,
      paidDate: r["paid_date"]
        ? (r["paid_date"] as Date).toISOString().slice(0, 10)
        : undefined,
      paidAmountCents:
        r["paid_amount_cents"] != null
          ? Number(r["paid_amount_cents"])
          : undefined,
      paidTransactionId:
        r["paid_transaction_id"] != null
          ? String(r["paid_transaction_id"])
          : undefined,
      reminderDaysBefore:
        r["reminder_days_before"] != null
          ? Number(r["reminder_days_before"])
          : undefined,
      notes: (r["notes"] as string) ?? undefined,
      categoryId: (r["category_id"] as string) ?? undefined,
    } as Partial<Payable>,
  );

export const mapTemplate = (r: Row): PayableTemplate =>
  opt<PayableTemplate>(
    {
      id: r["id"] as string,
      householdId: r["household_id"] as string,
      accountId: r["account_id"] as string,
      name: r["name"] as string,
      description: r["description"] as string,
      amountCents: Number(r["amount_cents"]),
      frequency: r["frequency"] as PayableTemplate["frequency"],
      dayOfMonth: Number(r["day_of_month"]),
      active: r["active"] as boolean,
    },
    {
      reminderDaysBefore:
        r["reminder_days_before"] != null
          ? Number(r["reminder_days_before"])
          : undefined,
      notes: (r["notes"] as string) ?? undefined,
    } as Partial<PayableTemplate>,
  );

const mapNotification = (r: Row): NotificationConfig =>
  opt<NotificationConfig>(
    {
      id: r["id"] as string,
      householdId: r["household_id"] as string,
      chatId: r["chat_id"] as string,
      notificationType: r[
        "notification_type"
      ] as NotificationConfig["notificationType"],
      enabled: r["enabled"] as boolean,
      daysOfWeek: (r["days_of_week"] as number[]) ?? [1, 2, 3, 4, 5],
    },
    {
      scheduleHour:
        r["schedule_hour"] != null ? Number(r["schedule_hour"]) : undefined,
      scheduleWindowMinutes:
        r["schedule_window_minutes"] != null
          ? Number(r["schedule_window_minutes"])
          : undefined,
      scheduleMinute:
        r["schedule_minute"] != null ? Number(r["schedule_minute"]) : undefined,
      thresholdDays:
        r["threshold_days"] != null ? Number(r["threshold_days"]) : undefined,
      timezone: (r["timezone"] as string) ?? undefined,
      lastRunAt: r["last_run_at"]
        ? new Date(r["last_run_at"] as string).toISOString()
        : undefined,
      lastSuccessAt: r["last_success_at"]
        ? new Date(r["last_success_at"] as string).toISOString()
        : undefined,
      lastFailureAt: r["last_failure_at"]
        ? new Date(r["last_failure_at"] as string).toISOString()
        : undefined,
      lastRunStatus:
        (r["last_run_status"] as NotificationConfig["lastRunStatus"]) ??
        undefined,
      lastSentCount:
        r["last_sent_count"] != null ? Number(r["last_sent_count"]) : undefined,
      lastRemovedCount:
        r["last_removed_count"] != null
          ? Number(r["last_removed_count"])
          : undefined,
      lastError: (r["last_error"] as string) ?? undefined,
    } as Partial<NotificationConfig>,
  );

function getNextDue(currentDue: string, frequency: string): string | null {
  // V4.1 REVIEWFIX F10: clamped month arithmetic (Jan 31 → Feb 28), never
  // the raw setUTCMonth overflow (Jan 31 → Mar 3). Parity with legacy.
  switch (frequency) {
    case "monthly":
      return addMonthsSafe(currentDue, 1);
    case "quarterly":
      return addMonthsSafe(currentDue, 3);
    case "yearly":
      return addMonthsSafe(currentDue, 12);
    default:
      return null;
  }
}

/**
 * FIX-WS-D2-R3 item 2 — cores client-bound: guarda FOR SHARE + efeito no
 * MESMO cliente (antes eram check-then-act fora de transação, com janela
 * delete-vs-create / archive-vs-create). Sem efeito em workspace
 * arquivado/excluído.
 */
const cancelPayableInTx = async (
  client: PoolClient,
  householdId: string,
  payableId: string,
): Promise<Payable> => {
  await assertWorkspaceWritableInTx(client, householdId);
  const existing = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [payableId, householdId],
  );
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound("Conta a pagar");
  await client.query(
    `UPDATE accounts_payable SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND household_id = $2`,
    [payableId, householdId],
  );
  const rows = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`,
    [payableId, householdId],
  );
  return mapPayable(rows.rows[0]!);
};

type ConfigureNotificationInput = Parameters<PayableStore["configureNotification"]>[1];

const configureNotificationInTx = async (
  client: PoolClient,
  householdId: string,
  input: ConfigureNotificationInput,
): Promise<NotificationConfig> => {
  await assertWorkspaceWritableInTx(client, householdId);
  const q = clientQueryFn(client);
  const existing = await q<Row>(
    `SELECT * FROM notification_configs WHERE household_id = $1 AND chat_id = $2 AND notification_type = $3`,
    [householdId, input.chatId, input.notificationType],
  );
  if (existing.length > 0) {
    await q(
      `UPDATE notification_configs SET enabled = $1, schedule_hour = $2, schedule_minute = $3, schedule_window_minutes = $4, days_of_week = $5, threshold_days = $6, timezone = $7, updated_at = NOW()
       WHERE id = $8 AND household_id = $9`,
      [
        input.enabled,
        input.scheduleHour ?? 9,
        input.scheduleMinute ?? 0,
        input.scheduleWindowMinutes ?? 60,
        input.daysOfWeek ?? [1, 2, 3, 4, 5],
        input.thresholdDays ?? 1,
        input.timezone ?? "UTC",
        existing[0]!["id"],
        householdId,
      ],
    );
    const rows = await q<Row>(
      `SELECT * FROM notification_configs WHERE id = $1 AND household_id = $2`,
      [existing[0]!["id"], householdId],
    );
    const row = rows[0];
    if (!row) throw domainErrors.notFound("Notificação");
    return mapNotification(row);
  }
  const id = randomUUID();
  await q(
    `INSERT INTO notification_configs (id, household_id, chat_id, notification_type, enabled, schedule_hour, schedule_minute, schedule_window_minutes, days_of_week, threshold_days, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      householdId,
      input.chatId,
      input.notificationType,
      input.enabled,
      input.scheduleHour ?? 9,
      input.scheduleMinute ?? 0,
      input.scheduleWindowMinutes ?? 60,
      input.daysOfWeek ?? [1, 2, 3, 4, 5],
      input.thresholdDays ?? 1,
      input.timezone ?? "UTC",
    ],
  );
  const rows = await q<Row>(
    `SELECT * FROM notification_configs WHERE id = $1 AND household_id = $2`,
    [id, householdId],
  );
  const row = rows[0];
  if (!row) throw domainErrors.notFound("Notificação");
  return mapNotification(row);
};

/**
 * Client-bound payment-undo core (no transaction handling): shared by the
 * plain path (own tx) and keyed route producers that join the idempotency
 * claim transaction (T06 single-tx — no duplicated payment reversal).
 */
export const undoPayablePaymentInTx = async (
  client: PoolClient,
  householdId: string,
  payableId: string,
  opts?: {
    expectedPaidTransactionId?: string;
  },
): Promise<Payable> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const existing = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [payableId, householdId],
  );
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound("Conta a pagar");
  if (existing.rows[0]!.status !== "paid")
    throw new DomainError(
      "validation.invalid",
      "Apenas contas pagas podem ter pagamento desfeito",
      409,
    );
  const p = mapPayable(existing.rows[0]!);
  // V4.1 Task 2.x (D4): the undo contract carries the linked
  // paidTransactionId; a caller that knows it must present the right
  // one, otherwise the undo is rejected instead of reversing the
  // wrong financial effect.
  if (
    opts?.expectedPaidTransactionId !== undefined &&
    p.paidTransactionId !== opts.expectedPaidTransactionId
  ) {
    throw new DomainError(
      "validation.invalid",
      "paidTransactionId não confere com o pagamento vinculado",
      409,
    );
  }
  const newStatus = todayISO() <= p.dueDate ? "pending" : "overdue";
  await client.query(
    `UPDATE accounts_payable SET status = $1, paid_date = NULL, paid_amount_cents = NULL, paid_transaction_id = NULL, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
    [newStatus, payableId, householdId],
  );
  if (p.paidTransactionId) {
    // Reverse the debit booked by markPayablePaid in the same tx, then
    // soft-delete the linked expense. The recurring successor (if any)
    // is intentionally kept (D4).
    const txRows = await client.query<Row>(
      `SELECT amount_cents, account_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
      [p.paidTransactionId, householdId],
    );
    if ((txRows.rowCount ?? 0) > 0) {
      await client.query(
        `SELECT id FROM accounts WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [txRows.rows[0]!["account_id"], householdId],
      );
      await client.query(
        `UPDATE accounts SET balance_cents = balance_cents + $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
        [Number(txRows.rows[0]!["amount_cents"]), txRows.rows[0]!["account_id"], householdId],
      );
    }
    await client.query(
      `UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`,
      [p.paidTransactionId, householdId],
    );
  }
  const rows = await client.query<Row>(
    `SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`,
    [payableId, householdId],
  );
  return mapPayable(rows.rows[0]!);
};

export const createPostgresPayableStore = (pool: Pool): PayableStore => {
  const query = async <R extends Row = Row>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> => {
    const res = await pool.query<R>(text, values);
    return res.rows;
  };

  const store: PayableStore = {
    async listPayables(householdId, filters) {
      const params: unknown[] = [householdId];
      const conditions: string[] = ['household_id = $1', 'deleted_at IS NULL'];
      if (filters?.status) {

        params.push(filters.status);
        conditions.push(`status = $${params.length}`);
      }
      if (filters?.type) {
        params.push(filters.type);
        conditions.push(`type = $${params.length}`);
      }
      if (filters?.dueWithinDays) {
        const today = todayISO();
        const limit = new Date();
        limit.setDate(limit.getDate() + filters.dueWithinDays);
        params.push(today);
        conditions.push(`due_date >= $${params.length}`);
        params.push(limit.toISOString().slice(0, 10));
        conditions.push(`due_date <= $${params.length}`);
        conditions.push(`status = 'pending'`);
      }
      const rows = await query<Row>(
        `SELECT * FROM accounts_payable WHERE ${conditions.join(" AND ")} ORDER BY due_date ASC`,
        params,
      );
      return rows.map(mapPayable);
    },

    async createPayable(householdId, input) {
      return withTransaction(pool, (client) => createPayableInTx(client, householdId, input));
    },

    async markPayablePaid(householdId, payableId, input) {
      return withTransaction(pool, (client) => markPayablePaidInTx(client, householdId, payableId, input));
    },


    async cancelPayable(householdId, payableId, _reason) {
      // FIX-WS-D2-R3 item 2: guarda FOR SHARE + efeito na mesma
      // transação (antes era check-then-act fora de transação).
      return withTransaction(pool, (client) => cancelPayableInTx(client, householdId, payableId));
    },

    async updatePayable(householdId, payableId, input) {
      return withTransaction(pool, (client) => updatePayableInTx(client, householdId, payableId, input));
    },

    async undoPayablePayment(householdId, payableId, opts) {
      return withTransaction(pool, (client) => undoPayablePaymentInTx(client, householdId, payableId, opts));
    },


    async listTemplates(householdId, activeOnly) {
      const conditions: string[] = ['household_id = $1'];
      if (activeOnly !== false) conditions.push("active = true");

      const rows = await query<Row>(
        `SELECT * FROM payable_templates WHERE ${conditions.join(" AND ")} ORDER BY name ASC`,
        [householdId],
      );
      return rows.map(mapTemplate);
    },

    async createTemplate(householdId, input) {
      return withTransaction(pool, (client) => createTemplateInTx(client, householdId, input));
    },

    async createPayableFromTemplate(householdId, input) {
      return withTransaction(pool, (client) => createPayableFromTemplateInTx(client, householdId, input));
    },
    async createPayableWithTemplate(householdId, input) {
      return withTransaction(pool, (client) => createPayableWithTemplateInTx(client, householdId, input));
    },

    async autoCreateFromTemplates(householdId, daysAhead = 30) {
      return withTransaction(pool, (client) => autoCreateFromTemplatesInTx(client, householdId, daysAhead));
    },

    async refreshPayableStatus(householdId) {
      return withTransaction(pool, (client) => refreshPayableStatusInTx(client, householdId));
    },

    async listReminders(householdId) {
      const today = todayISO();
      const rows = await query<Row>(
        `SELECT * FROM accounts_payable WHERE household_id = $1 AND deleted_at IS NULL AND status IN ('overdue', 'pending') AND due_date <= $2 ORDER BY due_date ASC`,
        [householdId, today],
      );
      return rows.map(mapPayable);
    },

    async listNotifications(householdId) {
      const rows = await query<Row>(
        `SELECT * FROM notification_configs WHERE household_id = $1`,
        [householdId],
      );
      return rows.map(mapNotification);
    },

    async listAllNotifications() {
      const rows = await query<Row>(
        `SELECT * FROM notification_configs WHERE enabled = true ORDER BY household_id, id`,
      );
      return rows.map(mapNotification);
    },
    async updateNotificationExecution(notificationId, householdId, state) {
      await query(
        `UPDATE notification_configs SET
           last_run_at = $1,
           last_run_status = $2,
           last_sent_count = $3,
           last_removed_count = $4,
           last_error = $5,
           last_success_at = CASE WHEN $2 IN ('sent', 'deduplicated') THEN $1 ELSE last_success_at END,
           last_failure_at = CASE WHEN $2 = 'failed' THEN $1 ELSE last_failure_at END,
           updated_at = NOW()
          WHERE id = $6 AND household_id = $7`,
        [
          state.executedAt,
          state.status,
          state.sent,
          state.removed,
          state.error ?? null,
          notificationId,
          householdId,
        ],
      );
    },
    async configureNotification(householdId, input) {
      // FIX-WS-D2-R3 item 2: guarda FOR SHARE + efeito na mesma
      // transação (antes era check-then-act fora de transação).
      return withTransaction(pool, (client) => configureNotificationInTx(client, householdId, input));
    },
  };
  // V4.1 Phase 3 (UOW2): expose the client-bound cores as non-contractual
  // extensions (see PayableStoreTxExtensions in payables/keyed-mutations.ts
  // for the member contract). The declared factory return type stays
  // PayableStore, so existing callers are unaffected.
  return Object.assign(store, {
    createPayableInTx,
    createPayableWithTemplateInTx,
    markPayablePaidInTx,
    undoPayablePaymentInTx,
    cancelPayableInTx,
    updatePayableInTx,
    createTemplateInTx,
    createPayableFromTemplateInTx,
    autoCreateFromTemplatesInTx,
    refreshPayableStatusInTx,
  });
};
