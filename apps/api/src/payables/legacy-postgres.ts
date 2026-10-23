/**
 * Legacy Postgres implementation of PayableStore.
 *
 * Maps the canonical PayableStore contract onto the existing pi_financeiro
 * schema (Agent Pi migrations). Activated by DB_SCHEMA=legacy.
 *
 * Key differences from the canonical store:
 * - accounts_payable: no `paid_amount_cents` column.
 * - transactions: payment transactions insert into `from_account_id`
 *   (not `account_id`).
 * - accounts: no `kind`/`balance_cents`/`status` columns; balance computed.
 *
 * Reuses the canonical Postgres store for methods whose SQL is schema-compatible
 * (listPayables, createPayable, cancelPayable, template CRUD/automation,
 * reminders, notifications).
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Payable, PayableStore } from './store.js';
import { createPostgresPayableStore, insertPayableRow, mapTemplate } from './postgres.js';
import { domainErrors, DomainError } from '../writes/errors.js';
import { assertCategoryKind } from '../categories/resolve.js';
import { addMonthsSafe } from '../shared/billing-month.js';
import { withTransaction } from '../db/pool.js';
import { lockCategoryReferencesInTx } from '../auth/category-lifecycle-guard.js';

type Row = Record<string, unknown>;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function getNextDue(dueDate: string, frequency: 'monthly' | 'quarterly' | 'yearly'): string | undefined {
  // V4.1 REVIEWFIX F10: single clamped implementation shared by all three
  // stores (parity by construction — Jan 31 → Feb 28, never Mar 3).
  switch (frequency) {
    case 'monthly': return addMonthsSafe(dueDate, 1);
    case 'quarterly': return addMonthsSafe(dueDate, 3);
    case 'yearly': return addMonthsSafe(dueDate, 12);
  }
}

// V4.1 DEBT-CODER-BULKTX — template day-of-month → next due date, mirrored
// from the canonical store (same clamping rule; parity by construction).
function nextTemplateDue(dayOfMonth: number, today: Date): string {
  const daysInMonth = (year: number, month: number): number =>
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
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

const mapPayable = (r: Row): Payable => {
  const base: Payable = {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    accountId: r['account_id'] as string,
    description: r['description'] as string,
    amountCents: Number(r['amount_cents']),
    dueDate: (r['due_date'] as Date).toISOString().slice(0, 10),
    type: r['type'] as Payable['type'],
    status: r['status'] as Payable['status'],
  };
  if (r['paid_date']) base.paidDate = (r['paid_date'] as Date).toISOString().slice(0, 10);
  if (r['paid_transaction_id']) base.paidTransactionId = r['paid_transaction_id'] as string;
  if (r['frequency']) base.frequency = r['frequency'] as NonNullable<Payable['frequency']>;
  if (r['end_date']) base.endDate = (r['end_date'] as Date).toISOString().slice(0, 10);
  if (r['reminder_days_before'] != null) base.reminderDaysBefore = Number(r['reminder_days_before']);
  if (r['notes']) base.notes = r['notes'] as string;
  if (r['category_id'] != null) base.categoryId = r['category_id'] as string;
  return base;
};

type CreatePayableInput = Parameters<PayableStore["createPayable"]>[1];
type PayPayableInput = Parameters<PayableStore["markPayablePaid"]>[2];
type UpdatePayableInput = Parameters<PayableStore["updatePayable"]>[2];
type WithTemplateInput = Parameters<PayableStore["createPayableWithTemplate"]>[1];
type FromTemplateInput = Parameters<PayableStore["createPayableFromTemplate"]>[1];

type RowQueryFn = <R extends Row = Row>(text: string, values?: unknown[]) => Promise<R[]>;

const legacyClientQueryFn = (client: PoolClient): RowQueryFn =>
  async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> =>
    (await client.query<R>(text, values)).rows;

/**
 * V4.1 Task 2.15 legacy gate (module-level so both the plain path and the
 * UOW2 client-bound core share it): same 404/400 shapes as canonical, but
 * the lookup uses the legacy `active` boolean (no `status` column).
 */
const assertPayableCategoryLegacy = async (
  client: PoolClient,
  householdId: string,
  categoryId: string,
): Promise<void> => {
  const res = await client.query<Row>(
    `SELECT id, kind FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
    [categoryId, householdId],
  );
  if ((res.rowCount ?? 0) === 0 || res.rows.length === 0) throw domainErrors.notFound('Categoria');
  assertCategoryKind(
    { id: categoryId, householdId, kind: String(res.rows[0]!['kind']), status: 'active' },
    'expense',
  );
};

/**
 * V4.1 Phase 3 (UOW2) — legacy client-bound payable cores (no transaction
 * handling). Same member names as the canonical extensions so route
 * producers stay schema-agnostic; legacy SQL (from_account_id payments,
 * computed balances, paid-transaction sync on update) is preserved.
 */
const createPayableInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  input: CreatePayableInput,
): Promise<Payable> => {
  if (input.categoryId !== undefined) await lockCategoryReferencesInTx(client, householdId);
  // The canonical gate inside base.createPayable would query the `status`
  // column, which does not exist on the legacy schema.
  if (input.categoryId !== undefined) {
    await assertPayableCategoryLegacy(client, householdId, input.categoryId);
  }
  return insertPayableRow(legacyClientQueryFn(client), householdId, input);
};

const createPayableWithTemplateInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  input: WithTemplateInput,
): Promise<Payable> => {
  if (input.payable.categoryId !== undefined) await lockCategoryReferencesInTx(client, householdId);
  // V4.1 Task 2.15: same category gate as createPayable.
  if (input.payable.categoryId !== undefined) {
    await assertPayableCategoryLegacy(client, householdId, input.payable.categoryId);
  }
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
  const initialStatus = todayISO() <= input.payable.dueDate ? 'pending' : 'overdue';
  // V4.1 Phase 4 Task 4.11: code→schema alignment (mirrors canonical) —
  // accounts_payable has no template_id column and nothing reads it.
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
      input.payable.type ?? 'recurring',
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

const createPayableFromTemplateInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  input: FromTemplateInput,
): Promise<Payable> => {
  let t: import('../types/domain.js').PayableTemplate | undefined;
  if (input.templateId) {
    const rows = await client.query<Row>(
      `SELECT * FROM payable_templates WHERE id = $1 AND household_id = $2`,
      [input.templateId, householdId],
    );
    if ((rows.rowCount ?? 0) > 0) t = mapTemplate(rows.rows[0]!);
  } else if (input.templateName) {
    const rows = await client.query<Row>(
      `SELECT * FROM payable_templates WHERE name = $1 AND household_id = $2`,
      [input.templateName, householdId],
    );
    if ((rows.rowCount ?? 0) > 0) t = mapTemplate(rows.rows[0]!);
  }
  if (!t) throw domainErrors.notFound('Template');
  return createPayableInTxLegacy(client, householdId, {
    accountId: t.accountId,
    description: t.description,
    amountCents: input.amountOverrideCents ?? t.amountCents,
    dueDate: input.dueDate,
    type: 'recurring',
    frequency: t.frequency,
    ...(t.reminderDaysBefore != null ? { reminderDaysBefore: t.reminderDaysBefore } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
  });
};

const updatePayableInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  payableId: string,
  input: UpdatePayableInput,
): Promise<Payable> => {
  if (input.categoryId !== undefined) await lockCategoryReferencesInTx(client, householdId);
  const existing = await client.query<Row>(`SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [payableId, householdId]);
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound('Conta a pagar');
  if (existing.rows[0]!.status === 'cancelled') throw new DomainError('validation.invalid', 'Conta cancelada não pode ser editada', 409);

  // V4.1 Task 2.15: same category gate as createPayable.
  if (input.categoryId !== undefined) {
    await assertPayableCategoryLegacy(client, householdId, input.categoryId);
  }

  // Build update sets for accounts_payable
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (input.amountCents !== undefined) { sets.push(`amount_cents = $${idx++}`); params.push(input.amountCents); }
  if (input.dueDate !== undefined) { sets.push(`due_date = $${idx++}`); params.push(input.dueDate); }
  if (input.accountId !== undefined) { sets.push(`account_id = $${idx++}`); params.push(input.accountId); }
  if (input.categoryId !== undefined) { sets.push(`category_id = $${idx++}`); params.push(input.categoryId); }

  // If status is paid and there's a linked transaction, sync it
  const paidTxId = existing.rows[0]!.paid_transaction_id as string | null;
  if (paidTxId && (input.description !== undefined || input.amountCents !== undefined || input.accountId !== undefined || input.categoryId !== undefined)) {
    const txSets: string[] = [];
    const txParams: unknown[] = [];
    let txIdx = 1;
    if (input.description !== undefined) { txSets.push(`description = $${txIdx++}`); txParams.push(input.description); }
    if (input.amountCents !== undefined) { txSets.push(`amount_cents = $${txIdx++}`); txParams.push(input.amountCents); }
    if (input.accountId !== undefined) { txSets.push(`from_account_id = $${txIdx++}`); txParams.push(input.accountId); }
    if (input.categoryId !== undefined) { txSets.push(`category_id = $${txIdx++}`); txParams.push(input.categoryId); }
    txParams.push(paidTxId);
    txParams.push(householdId);
    await client.query(`UPDATE transactions SET ${txSets.join(', ')} WHERE id = $${txIdx} AND household_id = $${txIdx + 1}`, txParams);
  }

  if (sets.length > 0) {
    sets.push(`updated_at = NOW()`);
    params.push(payableId);
    params.push(householdId);
    await client.query(`UPDATE accounts_payable SET ${sets.join(', ')} WHERE id = $${idx} AND household_id = $${idx + 1}`, params);
  }

  const rows = await client.query<Row>(`SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`, [payableId, householdId]);
  return mapPayable(rows.rows[0]!);
};

const markPayablePaidInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  payableId: string,
  input: PayPayableInput,
): Promise<Payable> => {
  // V4.1 Task 2.2: legacy had no status guard at all — serialize on
  // the row and validate after the lock, mirroring canonical.
  const existing = await client.query<Row>(`SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [payableId, householdId]);
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound('Conta a pagar');
  const p = mapPayable(existing.rows[0]!);
  if (p.status === 'paid' || p.status === 'cancelled') {
    throw new DomainError(
      'validation.invalid',
      `Conta a pagar já está ${p.status === 'paid' ? 'paga' : 'cancelada'}`,
      409,
    );
  }
  // V4.1 REVIEWFIX F4 [major]: legacy validated neither account nor
  // type nor balance. Mirror the canonical gates: the paying account
  // is locked and must exist, be active and not be a credit card
  // (same messages/codes). Negative-balance rule (user-approved): the
  // computed legacy balance (initial_balance + ledger, same formula as
  // the legacy read model) may cross below zero — no insufficient-balance
  // rejection, in parity with canonical/in-memory.
  const accRows = await client.query<Row>(
    `SELECT id, is_credit_card, active, initial_balance_cents FROM accounts WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [p.accountId, householdId],
  );
  if (accRows.rowCount === 0 || accRows.rows.length === 0) throw domainErrors.notFound('Conta');
  const acc = accRows.rows[0]!;
  if (acc['active'] !== true) throw domainErrors.notFound('Conta');
  if (acc['is_credit_card'] === true) {
    throw new DomainError('validation.invalid', 'compra no cartão deve usar /cards/purchases.', 422);
  }
  const paidDate = input.paidDate ?? todayISO();

  // V4.1 Task 2.3 (D3): the payment always creates the transaction
  // (legacy uses from_account_id). Legacy balances are computed, so
  // there is no materialized balance to debit.
  const txId = randomUUID();
  await client.query(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, from_account_id, category_id)
     VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7)`,
    [txId, householdId, p.description, p.amountCents, paidDate, p.accountId, p.categoryId ?? null],
  );

  await client.query(
    `UPDATE accounts_payable SET status = 'paid', paid_date = $1, paid_transaction_id = $2, updated_at = NOW() WHERE id = $3 AND household_id = $4`,
    [paidDate, txId, payableId, householdId],
  );

  if (p.type === 'recurring' && p.frequency && !input.prepayMonths) {
    const nextDue = getNextDue(p.dueDate, p.frequency);
    if (nextDue && (!p.endDate || nextDue <= p.endDate)) {
      await client.query(
        `INSERT INTO accounts_payable (id, household_id, account_id, description, amount_cents, due_date, type, frequency, end_date, reminder_days_before, notes, category_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'recurring',$7,$8,$9,$10,$11,'pending')`,
        [randomUUID(), householdId, p.accountId, p.description, p.amountCents, nextDue, p.frequency, p.endDate ?? null, p.reminderDaysBefore ?? 0, p.notes ?? null, p.categoryId ?? null],
      );
    }
  }

  const rows = await client.query<Row>(`SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`, [payableId, householdId]);
  return mapPayable(rows.rows[0]!);
};

export const createLegacyPostgresPayableStore = (pool: Pool): PayableStore => {
  const base = createPostgresPayableStore(pool);

  // V4.1 DEBT-CODER-BULKTX — legacy client-bound bulk cores (same member
  // names as the canonical extensions). The per-row work uses the legacy
  // from-template core so legacy SQL semantics (from_account_id payments,
  // `active` category gate) hold inside the shared transaction.
  const autoCreateFromTemplatesInTxLegacy = async (
    client: PoolClient,
    householdId: string,
    daysAhead = 30,
  ): Promise<Payable[]> => {
    const q = legacyClientQueryFn(client);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const limit = new Date(today.getTime() + daysAhead * 86_400_000).toISOString().slice(0, 10);
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
      created.push(await createPayableFromTemplateInTxLegacy(client, householdId, {
        templateId: template.id,
        dueDate,
      }));
    }
    return created;
  };

  const refreshPayableStatusInTxLegacy = async (
    client: PoolClient,
    householdId: string,
  ): Promise<Payable[]> => {
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

  const store: PayableStore = {
    ...base,
    async createPayable(householdId, input) {
      // V4.1 Task 2.15: legacy gate BEFORE the shared insert core — the
      // canonical gate inside base.createPayable would query the `status`
      // column, which does not exist on the legacy schema.
      return withTransaction(pool, (client) => createPayableInTxLegacy(client, householdId, input));
    },
    async createPayableWithTemplate(householdId, input) {
      return withTransaction(pool, (client) => createPayableWithTemplateInTxLegacy(client, householdId, input));
    },

    async updatePayable(householdId, payableId, input) {
      return withTransaction(pool, (client) => updatePayableInTxLegacy(client, householdId, payableId, input));
    },

    async undoPayablePayment(householdId, payableId, opts) {
      return withTransaction(pool, async (client) => {
        const existing = await client.query<Row>(`SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`, [payableId, householdId]);
        if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound('Conta a pagar');
        if (existing.rows[0]!.status !== 'paid') throw new DomainError('validation.invalid', 'Apenas contas pagas podem ter pagamento desfeito', 409);
        const paidTxId = existing.rows[0]!.paid_transaction_id as string | null;
        // V4.1 Task 2.x (D4): same paidTransactionId contract as canonical.
        if (opts?.expectedPaidTransactionId !== undefined && paidTxId !== opts.expectedPaidTransactionId) {
          throw new DomainError('validation.invalid', 'paidTransactionId não confere com o pagamento vinculado', 409);
        }
        const dueDate = (existing.rows[0]!.due_date as Date).toISOString().slice(0, 10);
        const newStatus = todayISO() <= dueDate ? 'pending' : 'overdue';
        await client.query(
          `UPDATE accounts_payable SET status = $1, paid_date = NULL, paid_transaction_id = NULL, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
          [newStatus, payableId, householdId],
        );
        if (paidTxId) {
          await client.query(`UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`, [paidTxId, householdId]);
        }
        const rows = await client.query<Row>(`SELECT * FROM accounts_payable WHERE id = $1 AND household_id = $2`, [payableId, householdId]);
        return mapPayable(rows.rows[0]!);
      });
    },

    async markPayablePaid(householdId, payableId, input) {
      return withTransaction(pool, (client) => markPayablePaidInTxLegacy(client, householdId, payableId, input));
    },

    // V4.1 DEBT-CODER-BULKTX — bulk plain methods run the legacy bulk cores
    // in ONE transaction (parity with the canonical store).
    async autoCreateFromTemplates(householdId, daysAhead = 30) {
      return withTransaction(pool, (client) => autoCreateFromTemplatesInTxLegacy(client, householdId, daysAhead));
    },
    async refreshPayableStatus(householdId) {
      return withTransaction(pool, (client) => refreshPayableStatusInTxLegacy(client, householdId));
    },
  };
  // V4.1 Phase 3 (UOW2): legacy client-bound cores override the canonical
  // extensions inherited via `...base` (same member names — the inherited
  // createTemplateInTx is schema-compatible and kept as-is).
  return Object.assign(store, {
    createPayableInTx: createPayableInTxLegacy,
    createPayableWithTemplateInTx: createPayableWithTemplateInTxLegacy,
    markPayablePaidInTx: markPayablePaidInTxLegacy,
    updatePayableInTx: updatePayableInTxLegacy,
    createPayableFromTemplateInTx: createPayableFromTemplateInTxLegacy,
    autoCreateFromTemplatesInTx: autoCreateFromTemplatesInTxLegacy,
    refreshPayableStatusInTx: refreshPayableStatusInTxLegacy,
  });
};
