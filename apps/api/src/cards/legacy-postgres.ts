/**
 * Legacy Postgres implementation of CardStore.
 *
 * Maps the canonical CardStore contract onto the existing pi_financeiro
 * schema (Agent Pi migrations). Activated by DB_SCHEMA=legacy.
 *
 * Key differences from the canonical store:
 * - accounts: credit cards flagged by `is_credit_card` boolean (no `kind`),
 *   `active` boolean (no `status`), balance computed from
 *   `initial_balance_cents` + transactions (no stored `balance_cents`).
 * - transactions: card purchases use `from_account_id` (no `account_id`)
 *   and `is_credit_card_purchase = true`.
 * - recurring_purchases: `next_due_date` is NOT NULL → seeded to start_date.
 * - payStatement debits the payer account via an expense transaction and
 *   does NOT mutate the card balance (mirrors the Agent Pi pay_statement
 *   tool; the card balance is computed from its purchase transactions).
 *
 * Statement and recurring read columns match the canonical schema, so the
 * statement read queries are the same shape as cards/postgres.ts.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Account, Transaction, Statement, StatementDetail, StatementPurchase, RecurringPurchase } from '../types/domain.js';
import type { CardStore } from './store.js';
import { withTransaction } from '../db/pool.js';
import { domainErrors } from '../writes/errors.js';
import { resolveExpenseCategoryLegacy, resolveSubcategoryLegacy } from '../writes/legacy-postgres.js';
import { installmentDates } from '../shared/billing-month.js';
import { splitInstallmentAmounts } from './installments.js';

type Row = Record<string, unknown>;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Statement date/status math ───────────────────────────────────

function getClosingDate(purchaseDate: string, closingDay: number): string {
  const d = new Date(purchaseDate + 'T00:00:00.000Z');
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() > closingDay) { m += 1; if (m > 11) { m = 0; y += 1; } }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(closingDay, lastDay);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDueDate(closingDate: string, dueDay: number): string {
  const d = new Date(closingDate + 'T00:00:00.000Z');
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const cDay = d.getUTCDate();
  if (dueDay <= cDay) { m += 1; if (m > 11) { m = 0; y += 1; } }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(dueDay, lastDay);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function computeStatus(s: Statement, today: string): Statement['status'] {
  if (s.status === 'cancelled') return 'cancelled';
  if (s.paidCents >= s.totalCents) return 'paid';
  if (s.paidCents > 0 && today > s.dueDate) return 'overdue';
  if (s.paidCents > 0) return 'partial';
  if (today > s.dueDate) return 'overdue';
  if (today >= s.closingDate) return 'closed';
  return 'open';
}

/** Spread conditional optional properties to satisfy exactOptionalPropertyTypes. */
function opt<T extends Record<string, unknown>>(obj: T, props: Partial<T>): T {
  const result = { ...obj };
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

// ── Row mappers ──────────────────────────────────────────────────

const mapAccount = (r: Row): Account => opt<Account>(
  {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    name: r['name'] as string,
    kind: 'credit_card',
    balanceCents: Number(r['balance_cents'] ?? 0),
    status: r['active'] ? 'active' : 'inactive',
    // Legacy semantics: balance is computed from the ledger
    // (initial + income − expense …), NOT outstanding debt.
    // Mapper constant — no persisted-schema change, no raw config leak.
    balanceSemantics: 'legacy_calculated',
  },
  {
    creditLimitCents: r['credit_limit_cents'] != null ? Number(r['credit_limit_cents']) : undefined,
    closingDay: r['closing_day'] != null ? Number(r['closing_day']) : undefined,
    dueDay: r['due_day'] != null ? Number(r['due_day']) : undefined,
  } as Partial<Account>,
);

const mapStatement = (r: Row): Statement => ({
  id: r['id'] as string,
  householdId: r['household_id'] as string,
  accountId: r['account_id'] as string,
  cycleYearMonth: r['cycle_year_month'] as string,
  closingDate: (r['closing_date'] as Date).toISOString().slice(0, 10),
  dueDate: (r['due_date'] as Date).toISOString().slice(0, 10),
  totalCents: Number(r['total_cents']),
  paidCents: Number(r['paid_cents']),
  status: r['status'] as Statement['status'],
});

const mapRecurring = (r: Row): RecurringPurchase => opt<RecurringPurchase>(
  {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    accountId: r['account_id'] as string,
    description: r['description'] as string,
    amountCents: Number(r['amount_cents']),
    frequency: r['frequency'] as RecurringPurchase['frequency'],
    startDate: (r['start_date'] as Date).toISOString().slice(0, 10),
    status: r['status'] as RecurringPurchase['status'],
  },
  {
    endDate: r['end_date'] instanceof Date ? r['end_date'].toISOString().slice(0, 10) : r['end_date'] as string | undefined,
    categoryId: r['category_id'] as string | undefined,
  } as Partial<RecurringPurchase>,
);

// ── CardStore implementation ──────────────────────────────────────

export const createLegacyPostgresCardStore = (pool: Pool): CardStore => {
  const query = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => {
    const res = await pool.query<R>(text, values);
    return res.rows;
  };

  /** Find-or-create the statement for a card cycle, returning its id (H-04).
   *
   * Race-safe: INSERT ... ON CONFLICT DO NOTHING (unique index on
   * household/account/cycle from V047) followed by SELECT, so two concurrent
   * purchases in the same cycle converge on a single statement. */
  const findOrCreateStatement = async (
    householdId: string,
    accountId: string,
    cycle: string,
    closing: string,
    due: string,
    client?: PoolClient,
  ): Promise<string> => {
    const exec = client ? client.query.bind(client) : pool.query.bind(pool);
    await exec(
      `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 0, 0, 'open', NOW(), NOW())
       ON CONFLICT (household_id, account_id, cycle_year_month) DO NOTHING`,
      [householdId, accountId, cycle, closing, due],
    );
    const found = await exec(
      `SELECT id FROM statements WHERE account_id = $1 AND household_id = $2 AND cycle_year_month = $3 FOR UPDATE`,
      [accountId, householdId, cycle],
    );
    const id = found.rows[0]?.['id'] as string | undefined;
    if (!id) throw new Error('statement upsert did not converge');
    return id;
  };

  /** Recalculate a statement's total from its purchases and refresh status.
   *
   * Task 2.8 (SPEC §9.4): the statement row is locked (SELECT ... FOR
   * UPDATE) before SUM → persist, so concurrent purchases/payments
   * serialize instead of lost-updating total_cents/paid_cents. */
  const recalcStatement = async (statementId: string, householdId: string, client?: PoolClient): Promise<void> => {
    const exec = client ? client.query.bind(client) : pool.query.bind(pool);
    const locked = await exec(`SELECT * FROM statements WHERE id = $1 AND household_id = $2 FOR UPDATE`, [statementId, householdId]);
    if (locked.rowCount === 0 || locked.rows.length === 0) throw domainErrors.notFound('Fatura');
    const totalResult = await exec(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE statement_id = $1 AND household_id = $2 AND deleted_at IS NULL`,
      [statementId, householdId],
    );
    const total = Number(totalResult.rows[0]!['total']);
    const stmt = mapStatement(locked.rows[0]!);
    const newStatus = computeStatus({ ...stmt, totalCents: total }, todayISO());
    await exec(`UPDATE statements SET total_cents = $1, status = $2, updated_at = NOW() WHERE id = $3 AND household_id = $4`, [total, newStatus, statementId, householdId]);
  };

  /** Load and validate a credit card account for writes. */
  const requireCard = async (householdId: string, accountId: string, client?: PoolClient): Promise<{ closingDay: number; dueDay: number }> => {
    const exec = client ? client.query.bind(client) : pool.query.bind(pool);
    const res = await exec(
      `SELECT id, is_credit_card, closing_day, due_day FROM accounts WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
      [accountId, householdId],
    );
    if (res.rowCount === 0 || res.rows.length === 0) throw domainErrors.notFound('Conta');
    const card = res.rows[0]!;
    if (card['is_credit_card'] !== true) throw domainErrors.invalid('accountId', 'não é cartão de crédito');
    if (card['closing_day'] == null || card['due_day'] == null) {
      throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
    }
    return { closingDay: Number(card['closing_day']), dueDay: Number(card['due_day']) };
  };

  type CreateCardPurchaseInput = Parameters<CardStore['createCardPurchase']>[1];
  type CreateCardInstallmentsInput = Parameters<CardStore['createCardInstallments']>[1];
  type CreateRecurringPurchaseInput = Parameters<CardStore['createRecurringPurchase']>[1];
  type PayStatementInput = Parameters<CardStore['payStatement']>[2];
  type CreateCardInput = Parameters<CardStore['createCard']>[1];
  type UpdateCardInput = Parameters<CardStore['updateCard']>[2];
  type UpdatePurchaseInput = Parameters<CardStore['updatePurchase']>[2];

  /**
   * V4.1 Phase 3 (UOW2) — legacy client-bound card cores (no transaction
   * handling; same member names as the canonical extensions). Legacy SQL
   * (from_account_id, is_credit_card_purchase, computed balances) preserved.
   */
  const createCardPurchaseInTx = async (
    client: PoolClient,
    householdId: string,
    input: CreateCardPurchaseInput,
  ): Promise<Transaction[]> => {
    // M-05: same active/expense-kind category rule as plain entries.
    if (input.categoryId) {
      await resolveExpenseCategoryLegacy(client, householdId, input.categoryId);
    }
    if (input.subcategoryId) {
      await resolveSubcategoryLegacy(client, householdId, input.subcategoryId, 'expense', input.categoryId);
    }

    const card = await requireCard(householdId, input.accountId, client);


    const closing = getClosingDate(input.date, card.closingDay);
    const cycle = closing.slice(0, 7);
    const due = getDueDate(closing, card.dueDay);

    const statementId = await findOrCreateStatement(householdId, input.accountId, cycle, closing, due, client);

    const purchaseId = randomUUID();
    const txId = randomUUID();
    await client.query(
      `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, from_account_id, category_id, subcategory_id, notes, is_credit_card_purchase, statement_id, installments_total, installment_number)
       VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12)`,
      [txId, householdId, input.description, input.amountCents, input.date, input.accountId, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, statementId, input.installmentsTotal ?? null, input.installmentNumber ?? null],
    );

    await client.query(
      `INSERT INTO card_purchases (id, household_id, account_id, statement_id, description, amount_cents, date, category_id, subcategory_id, notes, installments_total, installment_number, is_recurring, transaction_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, NOW(), NOW())`,
      [purchaseId, householdId, input.accountId, statementId, input.description, input.amountCents, input.date, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, input.installmentsTotal ?? null, input.installmentNumber ?? null, txId],
    );

    await recalcStatement(statementId, householdId, client);

    return [
      opt<Transaction>(
        { id: txId, householdId, kind: 'expense', description: input.description, amountCents: input.amountCents, date: input.date, accountId: input.accountId },
        { categoryId: input.categoryId, subcategoryId: input.subcategoryId, notes: input.notes } as Partial<Transaction>,
      ),
    ];
  };

  const createCardInstallmentsInTx = async (
    client: PoolClient,
    householdId: string,
    input: CreateCardInstallmentsInput,
  ): Promise<Transaction[]> => {
    const card = await requireCard(householdId, input.accountId, client);

    // M-05: same active/expense-kind category rule as plain entries.
    if (input.categoryId) {
      await resolveExpenseCategoryLegacy(client, householdId, input.categoryId);
    }
    if (input.subcategoryId) {
      await resolveSubcategoryLegacy(client, householdId, input.subcategoryId, 'expense', input.categoryId);
    }

    // L-01: single distribution rule (remainder absorbed by the last parcel).
    const amounts = splitInstallmentAmounts(input.totalAmountCents, input.installmentsTotal);
    const txs: Transaction[] = [];
    // V4.1 Task 2.16: clamped billing-month arithmetic (no setUTCMonth
    // overflow: 2026-01-31 + 1 → 2026-02-28, not 2026-03-03).
    const dates = installmentDates(input.purchaseDate, input.installmentsTotal);
    const touchedStatements = new Set<string>();

    for (let i = 0; i < input.installmentsTotal; i++) {
      const dateStr = dates[i]!;
      const amount = amounts[i]!;

      const closing = getClosingDate(dateStr, card.closingDay);
      const cycle = closing.slice(0, 7);
      const due = getDueDate(closing, card.dueDay);

      const statementId = await findOrCreateStatement(householdId, input.accountId, cycle, closing, due, client);
      touchedStatements.add(statementId);

      const purchaseId = randomUUID();
      const txId = randomUUID();
      await client.query(
        `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, from_account_id, category_id, subcategory_id, notes, is_credit_card_purchase, statement_id, installments_total, installment_number)
         VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12)`,
        [txId, householdId, input.description, amount, dateStr, input.accountId, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, statementId, input.installmentsTotal, i + 1],
      );

      await client.query(
        `INSERT INTO card_purchases (id, household_id, account_id, statement_id, description, amount_cents, date, category_id, subcategory_id, notes, installments_total, installment_number, is_recurring, transaction_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, NOW(), NOW())`,
        [purchaseId, householdId, input.accountId, statementId, input.description, amount, dateStr, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, input.installmentsTotal, i + 1, txId],
      );

      txs.push(
        opt<Transaction>(
          { id: txId, householdId, kind: 'expense', description: input.description, amountCents: amount, date: dateStr, accountId: input.accountId },
          { categoryId: input.categoryId, subcategoryId: input.subcategoryId, notes: input.notes } as Partial<Transaction>,
        ),
      );
    }

    for (const stmtId of touchedStatements) {
      await recalcStatement(stmtId, householdId, client);
    }

    return txs;
  };

  const createRecurringPurchaseInTx = async (
    client: PoolClient,
    householdId: string,
    input: CreateRecurringPurchaseInput,
  ): Promise<RecurringPurchase> => {
    // Task 2.18: same validation as the normal purchase path — active
    // credit card with closing/due configured; active expense-kind
    // category (shared requireCard + category resolvers).
    await requireCard(householdId, input.accountId, client);

    if (input.categoryId) {
      await resolveExpenseCategoryLegacy(client, householdId, input.categoryId);
    }

    const id = randomUUID();
    await client.query(
      `INSERT INTO recurring_purchases (id, household_id, account_id, description, amount_cents, frequency, start_date, next_due_date, end_date, category_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 'active', NOW(), NOW())`,
      [id, householdId, input.accountId, input.description, input.amountCents, input.frequency, input.startDate, input.endDate ?? null, input.categoryId ?? null],
    );
    return opt<RecurringPurchase>(
      { id, householdId, accountId: input.accountId, description: input.description, amountCents: input.amountCents, frequency: input.frequency, startDate: input.startDate, status: 'active' as const },
      { endDate: input.endDate, categoryId: input.categoryId } as Partial<RecurringPurchase>,
    );
  };

  const payStatementInTx = async (
    client: PoolClient,
    householdId: string,
    statementId: string,
    input: PayStatementInput,
  ): Promise<Statement> => {
    // Task 2.9 (SPEC §9.5): the whole payment runs inside ONE transaction —
    // BEGIN → lock statement → read paid → compute remaining → validate →
    // create payment → update paid/status → COMMIT.
    const stmtRows = await client.query<Row>(
      `SELECT id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status
         FROM statements WHERE id = $1 AND household_id = $2 FOR UPDATE`,
      [statementId, householdId],
    );
    if (stmtRows.rows.length === 0) throw domainErrors.notFound('Fatura');
    const stmt = mapStatement(stmtRows.rows[0]!);

    const remaining = stmt.totalCents - stmt.paidCents;
    if (remaining <= 0) throw domainErrors.invalid('amountCents', 'fatura já está paga');
    if (input.amountCents > remaining) throw domainErrors.invalid('amountCents', 'valor excede o saldo da fatura');

    // Lock the payer so concurrent payments from the same account
    // serialize. NOTE: legacy balances are computed from the ledger
    // (initial_balance_cents + transactions) — there is no stored
    // balance_cents to gate on; the payment expense below IS the debit.
    const fromRows = await client.query<Row>(
      `SELECT id, is_credit_card FROM accounts WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL FOR UPDATE`,
      [input.fromAccountId, householdId],
    );
    if (fromRows.rows.length === 0) throw domainErrors.notFound('Conta de origem');
    if (fromRows.rows[0]!['is_credit_card'] === true) throw domainErrors.invalid('fromAccountId', 'não pode pagar fatura com cartão de crédito');

    const newPaid = stmt.paidCents + input.amountCents;
    await client.query(
      `UPDATE statements SET paid_cents = $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
      [newPaid, statementId, householdId],
    );

    const today = todayISO();
    await client.query(
      `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, from_account_id, is_credit_card_purchase)
       VALUES ($1, $2, 'expense', $3, $4, $5, $6, false)`,
      [randomUUID(), householdId, `Pagamento fatura ${stmt.cycleYearMonth}`, input.amountCents, today, input.fromAccountId],
    );

    const newStatus = computeStatus({ ...stmt, paidCents: newPaid }, today);
    if (newStatus !== stmt.status) {
      await client.query(
        `UPDATE statements SET status = $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
        [newStatus, statementId, householdId],
      );
    }

    return { ...stmt, paidCents: newPaid, status: newStatus };
  };

  const cancelPurchaseInTx = async (
    client: PoolClient,
    householdId: string,
    purchaseId: string,
  ): Promise<void> => {
    // Idempotência: se já soft-deletado, retornar
    const alreadyCp = await client.query<Row>(`SELECT id FROM card_purchases WHERE id = $1 AND household_id = $2 AND deleted_at IS NOT NULL`, [purchaseId, householdId]);
    if ((alreadyCp.rowCount ?? 0) > 0) return;
    const alreadyTx = await client.query<Row>(`SELECT id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NOT NULL`, [purchaseId, householdId]);
    if ((alreadyTx.rowCount ?? 0) > 0) return;

    // Tentar card_purchases com transaction_id explícito
    const cpRow = await client.query<Row>(`SELECT id, statement_id, amount_cents, date, transaction_id FROM card_purchases WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [purchaseId, householdId]);
    if ((cpRow.rowCount ?? 0) > 0) {
      const cp = cpRow.rows[0]!;
      const stmtId = cp['statement_id'] as string;
      // V4.1 REVIEWFIX F6 [major]: lock the statement BEFORE the status
      // gate (was: unlocked read → TOCTOU) and recompute through the
      // locked recalcStatement helper (was: unlocked SUM + UPDATE).
      const stmtRes = await client.query<Row>(`SELECT * FROM statements WHERE id = $1 AND household_id = $2 FOR UPDATE`, [stmtId, householdId]);
      if ((stmtRes.rowCount ?? 0) === 0) throw domainErrors.notFound('Compra');
      const stmt = mapStatement(stmtRes.rows[0]!);
      if (stmt.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para cancelamento.');
      const txId = cp['transaction_id'] as string | null;
      if (txId) {
        await client.query(`UPDATE card_purchases SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND household_id = $2`, [purchaseId, householdId]);
        await client.query(`UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [txId, householdId]);
      } else {
        // Legado sem vínculo: buscar transação candidata única
        const candidates = await client.query<Row>(
          `SELECT id FROM transactions WHERE household_id = $1 AND statement_id = $2 AND amount_cents = $3 AND date = $4 AND deleted_at IS NULL`,
          [householdId, stmtId, cp['amount_cents'], (cp['date'] instanceof Date ? (cp['date'] as Date).toISOString().slice(0, 10) : String(cp['date']).slice(0, 10))],
        );
        if (candidates.rows.length !== 1) throw domainErrors.conflict('Compra legada sem vínculo único: intervenção manual necessária.');
        await client.query(`UPDATE card_purchases SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND household_id = $2`, [purchaseId, householdId]);
        await client.query(`UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`, [candidates.rows[0]!['id'], householdId]);
      }
      await recalcStatement(stmtId, householdId, client);
      return;
    }

    // Tentar transactions diretamente (compra criada apenas como transação)
    const txRow = await client.query<Row>(`SELECT id, statement_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [purchaseId, householdId]);
    if ((txRow.rowCount ?? 0) > 0) {
      const stmtId = txRow.rows[0]!['statement_id'] as string | null;
      if (!stmtId) throw domainErrors.notFound('Compra');
      // V4.1 REVIEWFIX F6: same locked read + locked recalc as above.
      const stmtRes = await client.query<Row>(`SELECT * FROM statements WHERE id = $1 AND household_id = $2 FOR UPDATE`, [stmtId, householdId]);
      if ((stmtRes.rowCount ?? 0) === 0) throw domainErrors.notFound('Compra');
      const stmt = mapStatement(stmtRes.rows[0]!);
      if (stmt.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para cancelamento.');
      await client.query(`UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`, [purchaseId, householdId]);
      // FINAL REVIEW: projection failure must roll the tx back (ledger and
      // projection cancel atomically — no silent catch).
      await client.query(`UPDATE card_purchases SET deleted_at = NOW(), updated_at = NOW() WHERE transaction_id = $1 AND household_id = $2 AND deleted_at IS NULL`, [purchaseId, householdId]);
      await recalcStatement(stmtId, householdId, client);
      return;
    }

    throw domainErrors.notFound('Compra');
  };

  /**
   * Client-bound statement detail read (same 3-source shape as the pool
   * `getStatementDetail`: card_purchases → transactions by statement →
   * transactions by account+period). Used by `updatePurchaseInTx` so the
   * returned detail reflects the uncommitted change — reading through
   * the pool before commit would return the pre-update projection.
   */
  const getStatementDetailInTx = async (
    client: PoolClient,
    householdId: string,
    statementId: string,
  ): Promise<StatementDetail | null> => {
    const stmtRows = await client.query<Row>(
      `SELECT id, household_id, account_id, cycle_year_month,
              closing_date, due_date, total_cents, paid_cents, status
         FROM statements
        WHERE id = $1 AND household_id = $2`,
      [statementId, householdId],
    );
    if (stmtRows.rows.length === 0) return null;
    const s = mapStatement(stmtRows.rows[0]!);

    let purchaseRows = (
      await client.query<Row>(
        `SELECT cp.id, cp.description, cp.amount_cents, cp.date::text AS date,
                cp.installments_total, cp.installment_number,
                c.id AS category_id, c.name AS category_name
           FROM card_purchases cp
           LEFT JOIN categories c ON cp.category_id = c.id AND c.household_id = $2
          WHERE cp.statement_id = $1 AND cp.household_id = $2 AND cp.deleted_at IS NULL
          ORDER BY cp.date ASC, cp.created_at ASC`,
        [statementId, householdId],
      )
    ).rows;

    if (purchaseRows.length === 0) {
      purchaseRows = (
        await client.query<Row>(
          `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                  t.installments_total, t.installment_number, t.is_recurring,
                  c.id AS category_id, c.name AS category_name
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $2
            WHERE t.statement_id = $1
              AND t.household_id = $2
              AND t.deleted_at IS NULL
            ORDER BY t.date ASC, t.created_at ASC`,
          [statementId, householdId],
        )
      ).rows;
    }

    if (purchaseRows.length === 0) {
      const closing = new Date(s.closingDate + 'T00:00:00.000Z');
      const prevClosing = new Date(closing);
      prevClosing.setUTCMonth(prevClosing.getUTCMonth() - 1);
      const periodStart = prevClosing.toISOString().slice(0, 10);

      purchaseRows = (
        await client.query<Row>(
          `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                  t.installments_total, t.installment_number, t.is_recurring,
                  c.id AS category_id, c.name AS category_name
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $4
            WHERE t.from_account_id = $1
              AND t.household_id = $4
              AND t.is_credit_card_purchase = true
              AND t.date > $2
              AND t.date <= $3
              AND t.deleted_at IS NULL
            ORDER BY t.date ASC, t.created_at ASC`,
          [s.accountId, periodStart, s.closingDate, householdId],
        )
      ).rows;
    }

    const purchases: StatementPurchase[] = purchaseRows.map((r) => {
      const instNum = r['installment_number'];
      const instTotal = r['installments_total'];
      const dateStr = r['date'] instanceof Date ? (r['date'] as Date).toISOString().slice(0, 10) : String(r['date']).slice(0, 10);
      return opt<StatementPurchase>(
        {
          id: r['id'] as string,
          description: r['description'] as string,
          amountCents: Number(r['amount_cents']),
          date: dateStr,
          isRecurring: Boolean(r['is_recurring']),
        },
        {
          categoryId: (r['category_id'] as string) ?? undefined,
          categoryName: (r['category_name'] as string) ?? undefined,
          ...(instNum != null ? { installmentNumber: Number(instNum) } : {}),
          ...(instTotal != null ? { installmentsTotal: Number(instTotal) } : {}),
        } as Partial<StatementPurchase>,
      );
    });

    return { ...s, purchases };
  };

  /**
   * Client-bound purchase-PATCH core (no transaction handling, no detail
   * read): the exact body previously inline in the plain `updatePurchase`
   * — lock order STATEMENT → TRANSACTION → projection, open-statement
   * gate under lock, ledger + projection sync, locked total recompute.
   * Returns the pinned statement id; the caller reads the detail on the
   * same client (`updatePurchaseInTx`) or after commit (plain method).
   */
  const updatePurchaseCoreInTx = async (
    client: PoolClient,
    householdId: string,
    purchaseId: string,
    input: UpdatePurchaseInput,
  ): Promise<string> => {
    if (input.categoryId) {
      const catRows = await client.query<Row>(
        `SELECT id FROM categories WHERE id = $1 AND household_id = $2`,
        [input.categoryId, householdId],
      );
      if (catRows.rowCount === 0 || catRows.rows.length === 0) throw domainErrors.notFound('Categoria');
    }

    // Task 2.6 (SPEC §9.3): one dynamic SET builder shared by both
    // tables — placeholders derived from the key prefix length ($1/$2
    // are the row keys), so any single field or combination binds.
    const buildPatch = (): { clause: string; values: unknown[] } => {
      const sets: string[] = [];
      const values: unknown[] = [];
      const next = (): number => 2 + values.length + 1;
      if (input.description !== undefined) { sets.push(`description = $${next()}`); values.push(input.description); }
      if (input.amountCents !== undefined) { sets.push(`amount_cents = $${next()}`); values.push(input.amountCents); }
      if (input.date !== undefined) { sets.push(`date = $${next()}`); values.push(input.date); }
      if (input.categoryId !== undefined) { sets.push(`category_id = $${next()}`); values.push(input.categoryId); }
      if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');
      return { clause: sets.join(', '), values };
    };

    // V4.1 REVIEWFIX F5 [major]: global lock order STATEMENT →
    // TRANSACTION → projection (was: projection → transaction →
    // statement, deadlocking against cancelPurchase). Rows are peeked
    // WITHOUT locks to discover the statement; the statement row is
    // locked first, then the purchase rows.
    const cpPeek = await client.query<Row>(
      `SELECT id, statement_id, account_id, amount_cents, date, transaction_id FROM card_purchases WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
      [purchaseId, householdId],
    );

    let stmtId: string | null = null;
    let viaProjection = false;

    if (cpPeek.rows.length > 0) {
      viaProjection = true;
      stmtId = cpPeek.rows[0]!['statement_id'] as string ?? null;
    } else {
      const txPeek = await client.query<Row>(
        `SELECT id, statement_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
        [purchaseId, householdId],
      );
      if (txPeek.rowCount === 0 || txPeek.rows.length === 0) throw domainErrors.notFound('Compra');
      stmtId = txPeek.rows[0]!['statement_id'] as string ?? null;
    }
    if (!stmtId) throw domainErrors.notFound('Compra');
    // Pin the peeked statement: rows re-read under lock must agree.
    const peekStmtId: string = stmtId;

    // V4.1 REVIEWFIX F7 [major]: like cancelPurchase, PATCH only edits
    // purchases of an open statement (checked under the statement lock).
    const stmtLocked = await client.query<Row>(
      `SELECT * FROM statements WHERE id = $1 AND household_id = $2 FOR UPDATE`,
      [stmtId, householdId],
    );
    if ((stmtLocked.rowCount ?? 0) === 0) throw domainErrors.notFound('Compra');
    const lockedStmt = mapStatement(stmtLocked.rows[0]!);
    if (lockedStmt.status !== 'open') {
      throw domainErrors.conflict('Fatura não está aberta para edição.');
    }

    // Linked-date cycle guard (same rule as the canonical store): a date
    // edit must not silently cross into another billing cycle — the
    // purchase would stay linked to the old statement while its date
    // belongs to a new one. Rejected BEFORE any mutation.
    const assertDateInLockedCycle = async (accountId: string | null, newDate: string): Promise<void> => {
      if (!accountId) throw domainErrors.notFound('Cartão');
      const cardDayRows = await client.query<Row>(
        `SELECT closing_day FROM accounts
           WHERE id = $1 AND household_id = $2 AND is_credit_card = true
             AND active = true AND deleted_at IS NULL`,
        [accountId, householdId],
      );
      if ((cardDayRows.rowCount ?? 0) === 0 || cardDayRows.rows.length === 0) {
        throw domainErrors.notFound('Cartão');
      }
      const dayRaw = cardDayRows.rows[0]!['closing_day'];
      if (dayRaw == null) {
        throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
      }
      const newCycle = getClosingDate(newDate, Number(dayRaw)).slice(0, 7);
      if (newCycle !== lockedStmt.cycleYearMonth) {
        throw domainErrors.invalid('date', 'nova data pertence a outro ciclo de fatura; cancele e recrie a compra');
      }
    };

    if (viaProjection) {
      // Lock the projection row, then the ledger row (STMT already held).
      const cpExists = await client.query<Row>(
        `SELECT id, statement_id, account_id, amount_cents, date, transaction_id FROM card_purchases WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [purchaseId, householdId],
      );
      if (cpExists.rows.length === 0) throw domainErrors.notFound('Compra');
      const cp = cpExists.rows[0]!;
      const patch = buildPatch();
      const txId = cp['transaction_id'] as string | null;

      // HIGH fail-closed: an orphan projection (no transaction_id) cannot
      // prove a unique ledger candidate from household/statement/amount/
      // date heuristics — even 1 candidate could be the wrong row. Any
      // amount/date/description edit that would need the ledger is
      // rejected with 409 BEFORE any write (no heuristic guessing, no
      // ledger sync). Category-only edits stay projection-only.
      if (!txId) {
        const needsLedger =
          input.description !== undefined ||
          input.amountCents !== undefined ||
          input.date !== undefined;
        if (needsLedger) {
          throw domainErrors.conflict('Compra legada sem vínculo com o lançamento: intervenção manual necessária.');
        }
      }

      // Linked purchase with a date edit: same cross-cycle guard as the
      // canonical store, resolved via the card closing_day.
      if (txId && input.date !== undefined) {
        await assertDateInLockedCycle(cp['account_id'] as string | null, input.date);
      }

      await client.query(
        `UPDATE card_purchases SET ${patch.clause}, updated_at = NOW() WHERE id = $1 AND household_id = $2`,
        [purchaseId, householdId, ...patch.values],
      );

      // Task 2.7 (D2): the same fields land on the linked ledger row in
      // the same transaction — never a silent projection divergence.
      // Orphan rows never reach here with ledger-touching fields (rejected
      // above); category-only orphan edits stay projection-only.
      if (txId) {
        const txLock = await client.query<Row>(
          `SELECT id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [txId, householdId],
        );
        if ((txLock.rowCount ?? 0) === 0) throw domainErrors.notFound('Compra');
        const txPatch = buildPatch();
        await client.query(
          `UPDATE transactions SET ${txPatch.clause}, updated_at = NOW() WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
          [txId, householdId, ...txPatch.values],
        );
      }
    } else {
      // Try transactions table (purchase created only as a transaction).
      const txExists = await client.query<Row>(
        `SELECT id, statement_id, from_account_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [purchaseId, householdId],
      );
      if (txExists.rowCount === 0 || txExists.rows.length === 0) throw domainErrors.notFound('Compra');

      // Same cross-cycle guard for the ledger-only path.
      if (input.date !== undefined) {
        await assertDateInLockedCycle(txExists.rows[0]!['from_account_id'] as string | null, input.date);
      }

      const patch = buildPatch();
      await client.query(
        `UPDATE transactions SET ${patch.clause}, updated_at = NOW() WHERE id = $1 AND household_id = $2`,
        [purchaseId, householdId, ...patch.values],
      );
      // Sync live projection rows pointing at this transaction.
      const projPatch = buildPatch();
      await client.query(
        `UPDATE card_purchases SET ${projPatch.clause}, updated_at = NOW() WHERE transaction_id = $1 AND household_id = $2 AND deleted_at IS NULL`,
        [purchaseId, householdId, ...projPatch.values],
      );
      stmtId = txExists.rows[0]!['statement_id'] as string ?? null;
      if (!stmtId || stmtId !== peekStmtId) throw domainErrors.notFound('Compra');
    }

    // Task 2.8: recompute under the statement row lock (already held —
    // recalcStatement re-locks the same row in the same tx, a no-op).
    // peekStmtId pins the statement: both branches re-validated it.
    await recalcStatement(peekStmtId, householdId, client);
    return peekStmtId;
  };

  /**
   * V4.1 Phase 4 (card-atomic-three) — legacy client-bound card
   * create/update cores (no transaction handling; legacy SQL preserved).
   */
  const createCardInTx = async (
    client: PoolClient,
    householdId: string,
    input: CreateCardInput,
  ): Promise<Account> => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, household_id, name, is_credit_card, active, credit_limit_cents, closing_day, due_day, initial_balance_cents, created_at, updated_at)
       VALUES ($1, $2, $3, true, true, $4, $5, $6, 0, NOW(), NOW())`,
      [id, householdId, input.name, input.creditLimitCents, input.closingDay, input.dueDay],
    );
    const res = await client.query<Row>(
      `SELECT id, household_id, name, active, credit_limit_cents, closing_day, due_day
         FROM accounts WHERE id = $1 AND household_id = $2`,
      [id, householdId],
    );
    return mapAccount(res.rows[0]!);
  };

  const updateCardInTx = async (
    client: PoolClient,
    householdId: string,
    id: string,
    input: UpdateCardInput,
  ): Promise<Account> => {
    // Task 2.5 (SPEC §9.3): placeholders derived from params.length —
    // fixed $3..$6 nullified/misbound every partial PATCH.
    const sets: string[] = [];
    const params: unknown[] = [id, householdId];
    if (input.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(input.name); }
    if (input.creditLimitCents !== undefined) { sets.push(`credit_limit_cents = $${params.length + 1}`); params.push(input.creditLimitCents); }
    if (input.closingDay !== undefined) { sets.push(`closing_day = $${params.length + 1}`); params.push(input.closingDay); }
    if (input.dueDay !== undefined) { sets.push(`due_day = $${params.length + 1}`); params.push(input.dueDay); }
    if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');

    const res = await client.query<Row>(
      `UPDATE accounts
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND household_id = $2 AND is_credit_card = true AND active = true AND deleted_at IS NULL
        RETURNING id, household_id, name, active, credit_limit_cents, closing_day, due_day`,
      params,
    );
    if (res.rowCount === 0 || res.rows.length === 0) throw domainErrors.notFound('Cartão');
    return mapAccount(res.rows[0]!);
  };

  /**
   * Client-bound purchase PATCH: the core runs on the caller's client and
   * the StatementDetail is read back on that SAME client, so the response
   * reflects the uncommitted change (a pool read before commit would
   * return the pre-update projection). No nested transaction.
   */
  const updatePurchaseInTx = async (
    client: PoolClient,
    householdId: string,
    purchaseId: string,
    input: UpdatePurchaseInput,
  ): Promise<StatementDetail> => {
    const stmtId = await updatePurchaseCoreInTx(client, householdId, purchaseId, input);
    const detail = await getStatementDetailInTx(client, householdId, stmtId);
    if (!detail) throw domainErrors.notFound('Fatura');
    return detail;
  };

  const store: CardStore = {
    async listCreditCardAccounts(householdId) {
      const rows = await query<Row>(
        `SELECT a.id, a.household_id, a.name, a.active,
                a.credit_limit_cents, a.closing_day, a.due_day,
                COALESCE(a.initial_balance_cents, 0)
                + COALESCE(totals.income, 0)
                - COALESCE(totals.expense, 0)
                - COALESCE(totals.transfer_out, 0)
                + COALESCE(totals.transfer_in, 0)
                AS balance_cents
           FROM accounts a
           LEFT JOIN LATERAL (
             SELECT
               COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'income' AND t.to_account_id = a.id), 0) AS income,
               COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense' AND t.from_account_id = a.id), 0) AS expense,
               COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.from_account_id = a.id), 0) AS transfer_out,
               COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.to_account_id = a.id), 0) AS transfer_in
             FROM transactions t
             WHERE t.household_id = $1 AND t.deleted_at IS NULL
           ) totals ON true
          WHERE a.household_id = $1
            AND a.is_credit_card = true
            AND a.active = true
            AND a.deleted_at IS NULL
          ORDER BY a.name ASC`,
        [householdId],
      );
      return rows.map(mapAccount);
    },

    async listStatements(householdId, accountId, opts) {
      const params: unknown[] = [householdId];
      const conditions: string[] = ['s.household_id = $1'];
      if (accountId) { params.push(accountId); conditions.push(`s.account_id = $${params.length}`); }
      if (opts?.status) { params.push(opts.status); conditions.push(`s.status = $${params.length}`); }
      const limit = opts?.limit ?? 12;
      params.push(limit);

      const rows = await query<Row>(
        `SELECT s.id, s.household_id, s.account_id, s.cycle_year_month,
                s.closing_date, s.due_date, s.total_cents, s.paid_cents, s.status
           FROM statements s
          WHERE ${conditions.join(' AND ')}
          ORDER BY s.closing_date DESC
          LIMIT $${params.length}`,
        params,
      );
      return rows.map(mapStatement);
    },

    async getStatementDetail(householdId, statementId) {
      const stmtRows = await query<Row>(
        `SELECT id, household_id, account_id, cycle_year_month,
                closing_date, due_date, total_cents, paid_cents, status
           FROM statements
          WHERE id = $1 AND household_id = $2`,
        [statementId, householdId],
      );
      if (stmtRows.length === 0) return null;
      const s = mapStatement(stmtRows[0]!);

      // Primary source: card_purchases table (legacy Agent Pi era).
      // Secondary: transactions by statement_id (new API inserts).
      // Tertiary: transactions by account + cycle period (unlinked legacy).
      const includeCatId = `, c.id AS category_id, c.name AS category_name`;
      const includeTxCat = `, c.id AS category_id, c.name AS category_name`;
      let purchaseRows = await query<Row>(
        `SELECT cp.id, cp.description, cp.amount_cents, cp.date::text AS date,
                cp.installments_total, cp.installment_number${includeCatId}
           FROM card_purchases cp
           LEFT JOIN categories c ON cp.category_id = c.id AND c.household_id = $2
          WHERE cp.statement_id = $1 AND cp.household_id = $2 AND cp.deleted_at IS NULL
          ORDER BY cp.date ASC, cp.created_at ASC`,
        [statementId, householdId],
      );

      if (purchaseRows.length === 0) {
        purchaseRows = await query<Row>(
          `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                  t.installments_total, t.installment_number, t.is_recurring${includeTxCat}
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $2
            WHERE t.statement_id = $1
              AND t.household_id = $2
              AND t.deleted_at IS NULL
            ORDER BY t.date ASC, t.created_at ASC`,
          [statementId, householdId],
        );
      }

      if (purchaseRows.length === 0) {
        const closing = new Date(s.closingDate + 'T00:00:00.000Z');
        const prevClosing = new Date(closing);
        prevClosing.setUTCMonth(prevClosing.getUTCMonth() - 1);
        const periodStart = prevClosing.toISOString().slice(0, 10);

        purchaseRows = await query<Row>(
          `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                  t.installments_total, t.installment_number, t.is_recurring${includeTxCat}
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $4
            WHERE t.from_account_id = $1
              AND t.household_id = $4
              AND t.is_credit_card_purchase = true
              AND t.date > $2
              AND t.date <= $3
              AND t.deleted_at IS NULL
            ORDER BY t.date ASC, t.created_at ASC`,
          [s.accountId, periodStart, s.closingDate, householdId],
        );
      }

      const purchases: StatementPurchase[] = purchaseRows.map(r => {
        const instNum = r['installment_number'];
        const instTotal = r['installments_total'];
        const dateStr = r['date'] instanceof Date ? r['date'].toISOString().slice(0, 10) : String(r['date']).slice(0, 10);
        return opt<StatementPurchase>(
          {
            id: r['id'] as string,
            description: r['description'] as string,
            amountCents: Number(r['amount_cents']),
            date: dateStr,
            isRecurring: Boolean(r['is_recurring']),
          },
          {
            categoryId: (r['category_id'] as string) ?? undefined,
            categoryName: (r['category_name'] as string) ?? undefined,
            ...(instNum != null ? { installmentNumber: Number(instNum) } : {}),
            ...(instTotal != null ? { installmentsTotal: Number(instTotal) } : {}),
          } as Partial<StatementPurchase>,
        );
      });

      return { ...s, purchases };
    },

    async createCardPurchase(householdId, input) {
      return withTransaction(pool, (client) => createCardPurchaseInTx(client, householdId, input));
    },

    async createCardInstallments(householdId, input) {
      return withTransaction(pool, (client) => createCardInstallmentsInTx(client, householdId, input));
    },

    async listRecurringPurchases(householdId, opts) {
      const params: unknown[] = [householdId];
      const conditions: string[] = ['household_id = $1'];
      if (opts?.accountId) { params.push(opts.accountId); conditions.push(`account_id = $${params.length}`); }
      if (opts?.status) { params.push(opts.status); conditions.push(`status = $${params.length}`); }

      const rows = await query<Row>(
        `SELECT id, household_id, account_id, description, amount_cents, frequency, start_date, end_date, category_id, status
           FROM recurring_purchases
          WHERE ${conditions.join(' AND ')}
          ORDER BY start_date DESC, created_at DESC`,
        params,
      );
      return rows.map(mapRecurring);
    },

    async createRecurringPurchase(householdId, input) {
      return withTransaction(pool, (client) => createRecurringPurchaseInTx(client, householdId, input));
    },

    async payStatement(householdId, statementId, input) {
      return withTransaction(pool, (client) => payStatementInTx(client, householdId, statementId, input));
    },

    async createCard(householdId, input) {
      const id = randomUUID();
      await query(
        `INSERT INTO accounts (id, household_id, name, is_credit_card, active, credit_limit_cents, closing_day, due_day, initial_balance_cents, created_at, updated_at)
         VALUES ($1, $2, $3, true, true, $4, $5, $6, 0, NOW(), NOW())`,
        [id, householdId, input.name, input.creditLimitCents, input.closingDay, input.dueDay],
      );
      const res = await query<Row>(
        `SELECT id, household_id, name, active, credit_limit_cents, closing_day, due_day
           FROM accounts WHERE id = $1 AND household_id = $2`,
        [id, householdId],
      );
      return mapAccount(res[0]!);
    },

    async updateCard(householdId, id, input) {
      return withTransaction(pool, async (client) => {
        // Task 2.5 (SPEC §9.3): placeholders derived from params.length —
        // fixed $3..$6 nullified/misbound every partial PATCH.
        const sets: string[] = [];
        const params: unknown[] = [id, householdId];
        if (input.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(input.name); }
        if (input.creditLimitCents !== undefined) { sets.push(`credit_limit_cents = $${params.length + 1}`); params.push(input.creditLimitCents); }
        if (input.closingDay !== undefined) { sets.push(`closing_day = $${params.length + 1}`); params.push(input.closingDay); }
        if (input.dueDay !== undefined) { sets.push(`due_day = $${params.length + 1}`); params.push(input.dueDay); }
        if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');

        const res = await client.query<Row>(
          `UPDATE accounts
              SET ${sets.join(', ')}, updated_at = NOW()
            WHERE id = $1 AND household_id = $2 AND is_credit_card = true AND active = true AND deleted_at IS NULL
            RETURNING id, household_id, name, active, credit_limit_cents, closing_day, due_day`,
          params,
        );
        if (res.rowCount === 0 || res.rows.length === 0) throw domainErrors.notFound('Cartão');
        return mapAccount(res.rows[0]!);
      });
    },

    async updatePurchase(householdId, purchaseId, input) {
      // Task 2.7: the detail is read AFTER commit — getStatementDetail
      // queries through the pool, which cannot see this transaction's
      // uncommitted writes (reading it inside the tx always returned the
      // pre-update projection). The mutation core is shared with
      // `updatePurchaseInTx` (claim-tx path), which reads the detail back
      // on the same client instead.
      const stmtId = await withTransaction(pool, (client) =>
        updatePurchaseCoreInTx(client, householdId, purchaseId, input),
      );
      return (await this.getStatementDetail(householdId, stmtId))!;
    },

    async cancelPurchase(householdId, purchaseId) {
      return withTransaction(pool, (client) => cancelPurchaseInTx(client, householdId, purchaseId));
    },
  };
  // V4.1 Phase 3 (UOW2): expose the legacy client-bound cores as
  // non-contractual extensions (see CardStoreTxExtensions in
  // cards/keyed-mutations.ts). The declared factory return type stays
  // CardStore.
  return Object.assign(store, {
    createCardPurchaseInTx,
    createCardInstallmentsInTx,
    createRecurringPurchaseInTx,
    payStatementInTx,
    cancelPurchaseInTx,
    createCardInTx,
    updateCardInTx,
    updatePurchaseInTx,
  });
};
