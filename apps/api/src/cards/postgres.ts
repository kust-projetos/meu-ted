/**
 * Postgres implementation of CardStore.
 *
 * Uses the V004 schema (statements table, credit_limit_cents /
 * closing_day / due_day on accounts, installments_total /
 * installment_number / statement_id on transactions).
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Account, Transaction, Statement, StatementDetail, StatementPurchase, RecurringPurchase } from '../types/domain.js';
import type { CardStore } from './store.js';
import { withTransaction } from '../db/pool.js';
import { domainErrors } from '../writes/errors.js';
import { resolveExpenseCategoryInTx, resolveSubcategoryInTx } from '../writes/postgres.js';
import { installmentDates } from '../shared/billing-month.js';
import { splitInstallmentAmounts } from './installments.js';

type Row = Record<string, unknown>;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Statement helpers (adapted for kind='credit_card') ───────────

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

/**
 * Find-or-create the statement for a card cycle (H-04).
 *
 * Race-safe: INSERT ... ON CONFLICT DO NOTHING (unique index on
 * household/account/cycle from V047) followed by SELECT, so two concurrent
 * purchases in the same cycle converge on a single statement instead of
 * duplicating it.
 */
export const findOrCreateStatementTx = async (
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> },
  householdId: string,
  accountId: string,
  cycle: string,
  closing: string,
  due: string,
): Promise<string> => {
  await client.query(
    `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 0, 0, 'open')
      ON CONFLICT (household_id, account_id, cycle_year_month) DO NOTHING`,
    [householdId, accountId, cycle, closing, due],
  );
  const found = await client.query(
    `SELECT id FROM statements WHERE account_id = $1 AND household_id = $2 AND cycle_year_month = $3 FOR UPDATE`,
    [accountId, householdId, cycle],
  );
  const id = found.rows[0]?.['id'] as string | undefined;
  if (!id) throw new Error('statement upsert did not converge');
  return id;
};
/** Helper: spread conditional optional properties to satisfy exactOptionalPropertyTypes. */
function opt<T extends Record<string, unknown>>(obj: T, props: Partial<T>): T {
  const result = { ...obj };
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null) (result as any)[k] = v;
  }
  return result;
}

type TxClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * Task 2.8 (SPEC §9.4): lock the statement row before recomputing its
 * total so concurrent purchases serialize instead of lost-updating.
 */
const lockStatementForUpdateTx = async (
  client: TxClient,
  statementId: string,
  householdId: string,
): Promise<Statement> => {
  const res = await client.query(
    `SELECT * FROM statements WHERE id = $1 AND household_id = $2 FOR UPDATE`,
    [statementId, householdId],
  );
  if (res.rowCount === 0 || res.rows.length === 0) throw domainErrors.notFound('Fatura');
  return mapStatement(res.rows[0]!);
};

/** Recompute SUM(transactions) → persist total + status under the row lock. */
const recalcStatementLockedTx = async (
  client: TxClient,
  statementId: string,
  householdId: string,
): Promise<void> => {
  const stmt = await lockStatementForUpdateTx(client, statementId, householdId);
  const totalResult = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE statement_id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [statementId, householdId],
  );
  const total = Number(totalResult.rows[0]!['total']);
  const newStatus = computeStatus({ ...stmt, totalCents: total }, todayISO());
  await client.query(
    `UPDATE statements SET total_cents = $1, status = $2, updated_at = NOW() WHERE id = $3 AND household_id = $4`,
    [total, newStatus, statementId, householdId],
  );
};

/**
 * Client-bound statement detail read (same shape as the pool
 * `getStatementDetail`). Used by `updatePurchaseInTx` so the returned
 * detail reflects the uncommitted change — reading through the pool
 * before commit would return the pre-update projection.
 */
const getStatementDetailInTx = async (
  client: TxClient,
  householdId: string,
  statementId: string,
): Promise<StatementDetail | null> => {
  const stmtRes = await client.query(
    `SELECT id, household_id, account_id, cycle_year_month,
            closing_date, due_date, total_cents, paid_cents, status
       FROM statements
      WHERE id = $1 AND household_id = $2`,
    [statementId, householdId],
  );
  if (stmtRes.rowCount === 0 || stmtRes.rows.length === 0) return null;
  const s = mapStatement(stmtRes.rows[0]!);

  let purchaseRows = (
    await client.query(
      `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
              t.installments_total, t.installment_number,
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

  if (purchaseRows.length === 0) {
    const closing = new Date(s.closingDate + 'T00:00:00.000Z');
    const prevClosing = new Date(closing);
    prevClosing.setUTCMonth(prevClosing.getUTCMonth() - 1);
    const periodStart = prevClosing.toISOString().slice(0, 10);

    purchaseRows = (
      await client.query(
        `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                t.installments_total, t.installment_number,
                c.id AS category_id, c.name AS category_name
           FROM transactions t
           LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $4
          WHERE t.account_id = $1
            AND t.household_id = $4
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
        isRecurring: false,
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
 * Canonical debt (ADR-018): credit_card.balance_cents is outstanding debt,
 * nonnegative. Applies `deltaCents` to the card in the caller's transaction —
 * AFTER the statement lock, preserving STATEMENT → TRANSACTION → accounts
 * order. Scoped by household/kind/status; a delta that would drive the debt
 * below zero fails closed (no clamp). Callers must invoke this inside the
 * same tx as the ledger + projection + statement writes.
 *
 * Exact arithmetic: both operands are validated as safe integers and the
 * final UPDATE re-checks `balance_cents + $1 >= 0` in Postgres bigint, so
 * the write fails closed even if the balance moved under the SELECT lock.
 */
const applyCardDebtDeltaTx = async (
  client: TxClient,
  householdId: string,
  accountId: string,
  deltaCents: number,
): Promise<void> => {
  if (deltaCents === 0) return;
  if (!Number.isSafeInteger(deltaCents)) {
    throw domainErrors.invalid('amountCents', 'valor fora do intervalo suportado');
  }
  // Lock the card row after the statement lock so concurrent writers on the
  // same card serialize; the guard fails closed on short debt.
  // REVIEWFIX (HIGH — FK KEY SHARE vs FOR UPDATE deadlock): the statement
  // INSERT above references accounts(id), so each tx holds a KEY SHARE lock
  // on the card row until commit. SELECT ... FOR UPDATE conflicts with a
  // concurrent KEY SHARE, so two different-cycle purchases on the same card
  // (each holding KEY SHARE + requesting FOR UPDATE) deadlocked (40P01).
  // FOR NO KEY UPDATE is compatible with KEY SHARE and sufficient here:
  // the follow-up UPDATE mutates only non-key columns (balance_cents,
  // updated_at) — PK id/household/kind are never written — so concurrent
  // holders serialize on the row lock instead of deadlocking.
  const locked = await client.query(
    `SELECT balance_cents FROM accounts
      WHERE id = $1 AND household_id = $2 AND kind = 'credit_card'
        AND status = 'active' AND deleted_at IS NULL FOR NO KEY UPDATE`,
    [accountId, householdId],
  );
  if ((locked.rowCount ?? 0) === 0 || locked.rows.length === 0) throw domainErrors.notFound('Cartão');
  const balance = Number(locked.rows[0]!['balance_cents']);
  if (!Number.isSafeInteger(balance)) {
    throw domainErrors.invalid('amountCents', 'saldo do cartão fora do intervalo suportado');
  }
  const next = balance + deltaCents;
  if (!Number.isSafeInteger(next)) {
    throw domainErrors.invalid('amountCents', 'valor fora do intervalo suportado');
  }
  if (next < 0) {
    throw domainErrors.invalid('amountCents', 'saldo devedor do cartão não permite a operação');
  }
  const updated = await client.query(
    `UPDATE accounts SET balance_cents = balance_cents + $1, updated_at = NOW()
      WHERE id = $2 AND household_id = $3 AND kind = 'credit_card'
        AND status = 'active' AND deleted_at IS NULL
        AND balance_cents + $1 >= 0`,
    [deltaCents, accountId, householdId],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw domainErrors.invalid('amountCents', 'saldo devedor do cartão não permite a operação');
  }
};

// ── Row mappers ──────────────────────────────────────────────────

/**
 * JSON boundary (reviewer P2): this store advertises `balanceCents` as
 * outstanding debt consumed as a JS Number. pg BIGINT money may arrive as
 * a string/bigint/number; emitting it via `Number()` would silently round
 * past 2^53-1. Every money-cent column mapped here fails closed on a
 * non-safe integer instead of rounding (future real money).
 */
const MONEY_SAFE_RE = /^-?\d+$/;

const toSafeMoneyCents = (value: unknown, field: string): number => {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw domainErrors.invalid(field, 'valor fora do intervalo suportado');
    }
    return Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw domainErrors.invalid(field, 'valor fora do intervalo suportado');
    }
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!MONEY_SAFE_RE.test(text)) {
      throw domainErrors.invalid(field, 'valor fora do intervalo suportado');
    }
    const parsed = BigInt(text);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw domainErrors.invalid(field, 'valor fora do intervalo suportado');
    }
    return Number(parsed);
  }
  throw domainErrors.invalid(field, 'valor fora do intervalo suportado');
};

const mapAccount = (r: Row): Account => opt<Account>(
  {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    name: r['name'] as string,
    kind: r['kind'] as Account['kind'],
    balanceCents: toSafeMoneyCents(r['balance_cents'], 'balanceCents'),
    status: r['status'] as Account['status'],
    // Canonical semantics (ADR-018): balance_cents IS outstanding debt.
    // Mapper constant — no persisted-schema change, no raw config leak.
    balanceSemantics: 'outstanding_debt',
  },
  {
    creditLimitCents: r['credit_limit_cents'] != null ? toSafeMoneyCents(r['credit_limit_cents'], 'creditLimitCents') : undefined,
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

type CreateCardPurchaseInput = Parameters<CardStore['createCardPurchase']>[1];
type CreateCardInstallmentsInput = Parameters<CardStore['createCardInstallments']>[1];
type CreateRecurringPurchaseInput = Parameters<CardStore['createRecurringPurchase']>[1];
type PayStatementInput = Parameters<CardStore['payStatement']>[2];
type CreateCardInput = Parameters<CardStore['createCard']>[1];
type UpdateCardInput = Parameters<CardStore['updateCard']>[2];
type UpdatePurchaseInput = Parameters<CardStore['updatePurchase']>[2];

/**
 * V4.1 Phase 3 (UOW2) — client-bound card cores (no transaction handling).
 * The plain store methods run them in their own transaction; keyed route
 * producers (see cards/keyed-mutations.ts) run them on the open idempotency
 * claim client, so claim + effect + completion commit atomically in ONE
 * transaction. Phase 2 guarantees (statement locks, remaining validation,
 * ledger/projection sync) hold inside the merged tx — same client.
 */
const createCardPurchaseInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateCardPurchaseInput,
): Promise<Transaction[]> => {
  // M-05: same active/expense-kind category rule as plain entries.
  if (input.categoryId) {
    await resolveExpenseCategoryInTx(client, householdId, input.categoryId);
  }
  if (input.subcategoryId) {
    await resolveSubcategoryInTx(client, householdId, input.subcategoryId, 'expense', input.categoryId);
  }

  // Validate credit card account
  const cardRows = await client.query<Row>(
    `SELECT id, kind, closing_day, due_day, credit_limit_cents
       FROM accounts
      WHERE id = $1 AND household_id = $2 AND status = 'active' AND deleted_at IS NULL`,
    [input.accountId, householdId],
  );
  if (cardRows.rowCount === 0 || cardRows.rows.length === 0) throw domainErrors.notFound('Conta');
  const card = cardRows.rows[0]!;
  if (card['kind'] !== 'credit_card') throw domainErrors.invalid('accountId', 'não é cartão de crédito');
  if (card['closing_day'] == null || card['due_day'] == null) {
    throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
  }


  const closingDay = Number(card['closing_day']);
  const dueDay = Number(card['due_day']);

  const closing = getClosingDate(input.date, closingDay);
  const cycle = closing.slice(0, 7);
  const due = getDueDate(closing, dueDay);

  // H-04: race-safe find-or-create (single statement per cycle).
  const statementId = await findOrCreateStatementTx(client, householdId, input.accountId, cycle, closing, due);

  // Insert transaction (M-04: subcategory + notes preserved)
  const txId = randomUUID();
  await client.query(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id, subcategory_id, notes, statement_id, installments_total, installment_number)
     VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [txId, householdId, input.description, input.amountCents, input.date, input.accountId, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, statementId, input.installmentsTotal ?? null, input.installmentNumber ?? null],
  );
  // M-04: the card_purchases link is mandatory — a failure here rolls
  // back the whole purchase instead of leaving an unlinkable invoice
  // entry (no more silent best-effort catch).
  await client.query(
    `INSERT INTO card_purchases (id, household_id, account_id, statement_id, description, amount_cents, date, category_id, subcategory_id, notes, installments_total, installment_number, transaction_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
    [householdId, input.accountId, statementId, input.description, input.amountCents, input.date, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, input.installmentsTotal ?? null, input.installmentNumber ?? null, txId],
  );

  // Task 2.8: recompute under the statement row lock (no lost updates).
  await recalcStatementLockedTx(client, statementId, householdId);

  // Canonical debt (ADR-018): purchase adds the exact amount once, same tx.
  await applyCardDebtDeltaTx(client, householdId, input.accountId, input.amountCents);

  const created: Transaction[] = [
    opt<Transaction>(
      { id: txId, householdId, kind: 'expense', description: input.description, amountCents: input.amountCents, date: input.date, accountId: input.accountId },
      {
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
        notes: input.notes,
      } as Partial<Transaction>,
    ),
  ];

  return created;
};

const createCardInstallmentsInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateCardInstallmentsInput,
): Promise<Transaction[]> => {
  const cardRows = await client.query<Row>(
    `SELECT id, kind, closing_day, due_day FROM accounts WHERE id = $1 AND household_id = $2 AND status = 'active' AND deleted_at IS NULL`,
    [input.accountId, householdId],
  );
  if (cardRows.rowCount === 0 || cardRows.rows.length === 0) throw domainErrors.notFound('Conta');
  const card = cardRows.rows[0]!;
  if (card['kind'] !== 'credit_card') throw domainErrors.invalid('accountId', 'não é cartão de crédito');
  if (card['closing_day'] == null || card['due_day'] == null) throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento');

  // M-05: same active/expense-kind category rule as plain entries.
  if (input.categoryId) {
    await resolveExpenseCategoryInTx(client, householdId, input.categoryId);
  }
  if (input.subcategoryId) {
    await resolveSubcategoryInTx(client, householdId, input.subcategoryId, 'expense', input.categoryId);
  }

  const closingDay = Number(card['closing_day']);
  const dueDay = Number(card['due_day']);

  // L-01: single distribution rule (remainder absorbed by the last parcel).
  const amounts = splitInstallmentAmounts(input.totalAmountCents, input.installmentsTotal);
  const txs: Transaction[] = [];
  // V4.1 Task 2.16: clamped billing-month arithmetic (no setUTCMonth
  // overflow: 2026-01-31 + 1 → 2026-02-28, not 2026-03-03).
  const dates = installmentDates(input.purchaseDate, input.installmentsTotal);

  // REVIEWFIX (HIGH — installments deadlock): precompute every parcel's
  // statement cycle up front, then acquire ALL statement locks in stable
  // (ascending-cycle) order BEFORE any transaction insert or card debt
  // write. The previous per-parcel loop interleaved statement locks with
  // the card-account lock (stmt_A → card → stmt_B), so two installment
  // sets with different initial cycles on the same card could deadlock
  // (one holds stmt_X + card waiting on stmt_Y while the other holds
  // stmt_Y waiting on card). Locking statements sorted-first and touching
  // the card exactly once preserves the global
  // STATEMENT → TRANSACTION → accounts order shared with the single
  // purchase, PATCH, cancel and payment paths.
  const plan = dates.map((dateStr, i) => {
    const closing = getClosingDate(dateStr, closingDay);
    const cycle = closing.slice(0, 7);
    return {
      dateStr,
      amount: amounts[i]!,
      closing,
      cycle,
      due: getDueDate(closing, dueDay),
      installmentNumber: i + 1,
    };
  });
  const cyclesSorted = [...new Set(plan.map((p) => p.cycle))].sort();
  const statementByCycle = new Map<string, string>();
  for (const cycle of cyclesSorted) {
    const first = plan.find((p) => p.cycle === cycle)!;
    // H-04: race-safe find-or-create (single statement per cycle).
    statementByCycle.set(
      cycle,
      await findOrCreateStatementTx(client, householdId, input.accountId, cycle, first.closing, first.due),
    );
  }

  let debtTotal = 0;
  for (const item of plan) {
    const statementId = statementByCycle.get(item.cycle)!;

    const txId = randomUUID();
    await client.query(
      `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id, subcategory_id, notes, statement_id, installments_total, installment_number)
       VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [txId, householdId, input.description, item.amount, item.dateStr, input.accountId, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, statementId, input.installmentsTotal, item.installmentNumber],
    );
    // M-04: mandatory link (fail-closed inside the same transaction).
    await client.query(
      `INSERT INTO card_purchases (id, household_id, account_id, statement_id, description, amount_cents, date, category_id, subcategory_id, notes, installments_total, installment_number, transaction_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
      [householdId, input.accountId, statementId, input.description, item.amount, item.dateStr, input.categoryId ?? null, input.subcategoryId ?? null, input.notes ?? null, input.installmentsTotal, item.installmentNumber, txId],
    );

    debtTotal += item.amount;

    txs.push(
      opt<Transaction>(
        { id: txId, householdId, kind: 'expense', description: input.description, amountCents: item.amount, date: item.dateStr, accountId: input.accountId },
        {
          categoryId: input.categoryId,
          subcategoryId: input.subcategoryId,
          notes: input.notes,
        } as Partial<Transaction>,
      ),
    );
  }

  // Task 2.8: recompute under the statement row locks in the same stable
  // order (re-locking rows already held by this tx is a no-op).
  for (const cycle of cyclesSorted) {
    await recalcStatementLockedTx(client, statementByCycle.get(cycle)!, householdId);
  }

  // Canonical debt (ADR-018): one exact delta for the whole set, same tx —
  // the single card lock is taken AFTER all statement locks.
  if (debtTotal !== 0) {
    await applyCardDebtDeltaTx(client, householdId, input.accountId, debtTotal);
  }
  return txs;
};

const createRecurringPurchaseInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateRecurringPurchaseInput,
): Promise<RecurringPurchase> => {
  // Task 2.18: same validation as the normal purchase path — card must
  // exist, be active and be a credit card with closing/due configured;
  // category must be an active expense-kind category.
  const cardRows = await client.query<Row>(
    `SELECT id, kind, closing_day, due_day FROM accounts WHERE id = $1 AND household_id = $2 AND status = 'active' AND deleted_at IS NULL`,
    [input.accountId, householdId],
  );
  if (cardRows.rowCount === 0 || cardRows.rows.length === 0) throw domainErrors.notFound('Conta');
  const card = cardRows.rows[0]!;
  if (card['kind'] !== 'credit_card') throw domainErrors.invalid('accountId', 'não é cartão de crédito');
  if (card['closing_day'] == null || card['due_day'] == null) {
    throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
  }

  if (input.categoryId) {
    await resolveExpenseCategoryInTx(client, householdId, input.categoryId);
  }

  const id = randomUUID();
  await client.query(
    `INSERT INTO recurring_purchases (id, household_id, account_id, description, amount_cents, frequency, start_date, end_date, category_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
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
  // Task 2.9 (SPEC §9.5): BEGIN → lock statement → read paid → compute
  // remaining → validate → create payment → update paid/status → COMMIT.
  // Two concurrent payments serialize on the row lock: the second sees
  // the first's paid amount and is rejected when nothing remains.
  const s = await lockStatementForUpdateTx(client, statementId, householdId);

  const remaining = s.totalCents - s.paidCents;
  if (remaining <= 0) throw domainErrors.invalid('amountCents', 'fatura já está paga');
  if (input.amountCents > remaining) throw domainErrors.invalid('amountCents', 'valor excede o restante da fatura');

  // Lock the payer before the funds check so concurrent payments from
  // the same account cannot jointly overdraw it.
  const fromRows = await client.query<Row>(
    `SELECT id, kind, balance_cents FROM accounts WHERE id = $1 AND household_id = $2 AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
    [input.fromAccountId, householdId],
  );
  if (fromRows.rowCount === 0) throw domainErrors.notFound('Conta de origem');
  if (fromRows.rows[0]!['kind'] === 'credit_card') throw domainErrors.invalid('fromAccountId', 'não pode pagar fatura com cartão de crédito');

  // Negative-balance rule (user-approved): a bank/cash payer may cross
  // below zero — no insufficient-balance rejection. The row lock above
  // stays so concurrent payments from the same account serialize.
  await client.query(
    `UPDATE accounts SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
    [input.amountCents, input.fromAccountId, householdId],
  );

  // D3-pattern: the payment creates its own expense transaction
  // (previously missing — the debit had no ledger record). V056: the
  // canonical structured origin (transactions.statement_payment_id →
  // statements.id) is written here; canonical reconciliation joins on it
  // and never on the free-text description. `statement_id` (purchase
  // link feeding statement_total) stays NULL so the payment does not
  // inflate invoice totals. Description kept for display/back-compat.
  const today = todayISO();
  await client.query(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, statement_payment_id)
     VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7)`,
    [randomUUID(), householdId, `Pagamento fatura ${s.cycleYearMonth}`, input.amountCents, today, input.fromAccountId, statementId],
  );

  // Apply to statement (locked — no lost update on paid_cents).
  await client.query(
    `UPDATE statements SET paid_cents = paid_cents + $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
    [input.amountCents, statementId, householdId],
  );

  // Recalculate status
  const updated = await client.query<Row>(`SELECT * FROM statements WHERE id = $1 AND household_id = $2`, [statementId, householdId]);
  const updatedStmt = mapStatement(updated.rows[0]!);
  const newStatus = computeStatus(updatedStmt, today);
  if (newStatus !== updatedStmt.status) {
    await client.query(
      `UPDATE statements SET status = $1, updated_at = NOW() WHERE id = $2 AND household_id = $3`,
      [newStatus, statementId, householdId],
    );
  }

  // Canonical debt (ADR-018): payment subtracts the exact amount from the
  // card (payer debited separately above); fails closed on short debt, same tx.
  await applyCardDebtDeltaTx(client, householdId, s.accountId, -input.amountCents);

  return { ...updatedStmt, status: newStatus };
};

const cancelPurchaseInTx = async (
  client: PoolClient,
  householdId: string,
  purchaseId: string,
): Promise<void> => {
  // Idempotência: se já deletado, retorna
  const already = await client.query<Row>(
    `SELECT id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NOT NULL`,
    [purchaseId, householdId],
  );
  if ((already.rowCount ?? 0) > 0) return;

  const txExists = await client.query<Row>(
    `SELECT id, statement_id, amount_cents, date FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [purchaseId, householdId],
  );
  if ((txExists.rowCount ?? 0) === 0) {
    throw domainErrors.notFound('Compra');
  }
  const stmtId = txExists.rows[0]!['statement_id'] as string | null;
  if (!stmtId) throw domainErrors.notFound('Compra');
  // Task 2.8: status gate on the locked row (no TOCTOU between the
  // open-check and the total recompute).
  const locked = await lockStatementForUpdateTx(client, stmtId, householdId);
  if (locked.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para cancelamento.');

  // V4.1 REVIEWFIX F5: explicit transaction-row lock AFTER the
  // statement lock — same STATEMENT → TRANSACTION → projection order
  // as updatePurchase, so the two paths serialize instead of
  // deadlocking. Re-checks liveness under the lock.
  const lockedTx = await client.query<Row>(
    `SELECT id, amount_cents, account_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [purchaseId, householdId],
  );
  if ((lockedTx.rowCount ?? 0) === 0) throw domainErrors.notFound('Compra');
  const cancelAmount = Number(lockedTx.rows[0]!['amount_cents']);
  const cancelAccountId = lockedTx.rows[0]!['account_id'] as string;

  await client.query(`UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`, [purchaseId, householdId]);
  // FINAL REVIEW: projection soft-delete must not fail silently — a swallowed
  // error here would confirm the ledger tombstone while leaving an active
  // card_purchases row. Let the failure roll the whole tx back.
  await client.query(`UPDATE card_purchases SET deleted_at = NOW(), updated_at = NOW() WHERE transaction_id = $1 AND household_id = $2 AND deleted_at IS NULL`, [purchaseId, householdId]);

  // Task 2.8: recompute under the statement row lock.
  await recalcStatementLockedTx(client, stmtId, householdId);

  // Canonical debt (ADR-018): cancel subtracts the amount once, same tx.
  await applyCardDebtDeltaTx(client, householdId, cancelAccountId, -cancelAmount);
};

/**
 * Client-bound purchase-PATCH core: statement/tx locks, cycle guard,
 * ledger + projection writes, total recompute and card debt delta — all
 * on the caller's client, no transaction handling, no detail read.
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
    // FINAL REVIEW: PATCH must apply the same active/expense rule as
    // creation (M-05) — not just existence.
    await resolveExpenseCategoryInTx(client, householdId, input.categoryId);
  }

  // V4.1 REVIEWFIX F5 [major]: global lock order STATEMENT →
  // TRANSACTION → projection. The ledger row is peeked WITHOUT a lock
  // to discover the statement; the statement row is locked first, then
  // the transaction row. (cancelPurchase already locks in this order —
  // the previous TX-first order here deadlocked against it.)
  const peek = await client.query<Row>(
    `SELECT id, statement_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    [purchaseId, householdId],
  );
  if (peek.rowCount === 0 || peek.rows.length === 0) throw domainErrors.notFound('Compra');
  const peekStmtId = peek.rows[0]!['statement_id'] as string | null;
  if (!peekStmtId) throw domainErrors.notFound('Compra');

  // V4.1 REVIEWFIX F7 [major]: like cancelPurchase, the PATCH path
  // only edits purchases of an open statement (checked under the
  // statement lock — no TOCTOU).
  const locked = await lockStatementForUpdateTx(client, peekStmtId, householdId);
  if (locked.status !== 'open') throw domainErrors.conflict('Fatura não está aberta para edição.');

  const txExists = await client.query<Row>(
    `SELECT id, statement_id, amount_cents, account_id FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [purchaseId, householdId],
  );
  if (txExists.rowCount === 0 || txExists.rows.length === 0) throw domainErrors.notFound('Compra');
  const oldAmount = Number(txExists.rows[0]!['amount_cents']);
  const purchaseAccountId = txExists.rows[0]!['account_id'] as string;

  // REVIEWFIX (Security — PATCH date cycle): a date edit must not
  // silently cross into another billing cycle — the purchase would
  // stay linked to the old statement while its date belongs to a new
  // one. Smallest fix: reject a date that resolves to a different
  // statement cycle BEFORE any mutation.
  if (input.date !== undefined) {
    const cardDayRows = await client.query<Row>(
      `SELECT closing_day FROM accounts
        WHERE id = $1 AND household_id = $2 AND kind = 'credit_card'
          AND status = 'active' AND deleted_at IS NULL`,
      [purchaseAccountId, householdId],
    );
    if (cardDayRows.rowCount === 0 || cardDayRows.rows.length === 0) {
      throw domainErrors.notFound('Cartão');
    }
    const dayRaw = cardDayRows.rows[0]!['closing_day'];
    if (dayRaw == null) {
      throw domainErrors.invalid('accountId', 'cartão sem fechamento/vencimento configurado');
    }
    const newCycle = getClosingDate(input.date, Number(dayRaw)).slice(0, 7);
    if (newCycle !== locked.cycleYearMonth) {
      throw domainErrors.invalid('date', 'nova data pertence a outro ciclo de fatura; cancele e recrie a compra');
    }
  }

  // SPEC §9.3: placeholders are derived from the key prefix — $1/$2
  // are the row keys, so the first patched column binds at $3.
  // (The previous `let idx = 1` base bound the first column to the
  // household id: text fields silently took the household UUID and
  // amount_cents raised a bigint-vs-uuid error.)
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 2;
  if (input.description !== undefined) { sets.push(`description = $${++idx}`); params.push(input.description); }
  if (input.amountCents !== undefined) { sets.push(`amount_cents = $${++idx}`); params.push(input.amountCents); }
  if (input.date !== undefined) { sets.push(`date = $${++idx}`); params.push(input.date); }
  if (input.categoryId !== undefined) { sets.push(`category_id = $${++idx}`); params.push(input.categoryId); }
  if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');

  params.unshift(purchaseId, householdId);
  await client.query(
    `UPDATE transactions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND household_id = $2`,
    params,
  );

  // D2: ledger = transactions → the card_purchases projection row
  // linked by transaction_id carries the same fields in the same tx.
  const projSets: string[] = [];
  const projParams: unknown[] = [];
  let pIdx = 2;
  if (input.description !== undefined) { projSets.push(`description = $${++pIdx}`); projParams.push(input.description); }
  if (input.amountCents !== undefined) { projSets.push(`amount_cents = $${++pIdx}`); projParams.push(input.amountCents); }
  if (input.date !== undefined) { projSets.push(`date = $${++pIdx}`); projParams.push(input.date); }
  if (input.categoryId !== undefined) { projSets.push(`category_id = $${++pIdx}`); projParams.push(input.categoryId); }
  projParams.unshift(purchaseId, householdId);
  await client.query(
    `UPDATE card_purchases SET ${projSets.join(', ')}, updated_at = NOW() WHERE transaction_id = $1 AND household_id = $2 AND deleted_at IS NULL`,
    projParams,
  );

  const stmtId = txExists.rows[0]!['statement_id'] as string | null;

  if (!stmtId || stmtId !== peekStmtId) throw domainErrors.notFound('Compra');
  // Task 2.8: recompute under the statement row lock (already held —
  // re-locking the same row in the same tx is a no-op).
  await recalcStatementLockedTx(client, stmtId, householdId);
  // Canonical debt (ADR-018): PATCH amount applies the delta, same tx.
  if (input.amountCents !== undefined && input.amountCents !== oldAmount) {
    await applyCardDebtDeltaTx(client, householdId, purchaseAccountId, input.amountCents - oldAmount);
  }
  return stmtId;
};

/**
 * V4.1 Phase 4 (card-atomic-three) — client-bound card create/update and
 * purchase-PATCH cores. Plain store methods run them in their own
 * boundary; keyed route producers (see cards/keyed-mutations.ts) run
 * them on the open idempotency claim client, so claim + effect +
 * completion commit atomically in ONE transaction.
 */
const createCardInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateCardInput,
): Promise<Account> => {
  const res = await client.query<Row>(
    `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day)
     VALUES (gen_random_uuid(), $1, $2, 'credit_card', 0, 'active', $3, $4, $5)
     RETURNING id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day`,
    [householdId, input.name, input.creditLimitCents, input.closingDay, input.dueDay],
  );
  return mapAccount(res.rows[0]!);
};

const updateCardInTx = async (
  client: PoolClient,
  householdId: string,
  id: string,
  input: UpdateCardInput,
): Promise<Account> => {
  // SPEC §9.3: $1/$2 are the row keys — first column binds at $3.
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 2;
  if (input.name !== undefined) { sets.push(`name = $${++idx}`); params.push(input.name); }
  if (input.creditLimitCents !== undefined) { sets.push(`credit_limit_cents = $${++idx}`); params.push(input.creditLimitCents); }
  if (input.closingDay !== undefined) { sets.push(`closing_day = $${++idx}`); params.push(input.closingDay); }
  if (input.dueDay !== undefined) { sets.push(`due_day = $${++idx}`); params.push(input.dueDay); }
  if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');
  params.unshift(id, householdId);
  const res = await client.query<Row>(
    `UPDATE accounts SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1 AND household_id = $2 AND kind = 'credit_card' AND status = 'active' AND deleted_at IS NULL
      RETURNING id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day`,
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

export const createPostgresCardStore = (pool: Pool): CardStore => {
  const query = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => {
    const res = await pool.query<R>(text, values);
    return res.rows;
  };

  const store: CardStore = {
    async listCreditCardAccounts(householdId) {
      const rows = await query<Row>(
        `SELECT id, household_id, name, kind, balance_cents, status,
                credit_limit_cents, closing_day, due_day
           FROM accounts
          WHERE household_id = $1
            AND kind = 'credit_card'
            AND status = 'active'
            AND deleted_at IS NULL`,
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

      // Primary query: purchases linked by statement_id, scoped to category household
      const includeCatId = `, c.id AS category_id, c.name AS category_name`;

      let purchaseRows = await query<Row>(
        `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                t.installments_total, t.installment_number${includeCatId}
           FROM transactions t
           LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $2
          WHERE t.statement_id = $1
            AND t.household_id = $2
            AND t.deleted_at IS NULL
          ORDER BY t.date ASC, t.created_at ASC`,
        [statementId, householdId],
      );

      // Fallback: when statement_id query is empty, find purchases by
      // account + cycle period (handles data where statement_id was not set).
      if (purchaseRows.length === 0) {
        const closing = new Date(s.closingDate + 'T00:00:00.000Z');
        const prevClosing = new Date(closing);
        prevClosing.setUTCMonth(prevClosing.getUTCMonth() - 1);
        const periodStart = prevClosing.toISOString().slice(0, 10);

        purchaseRows = await query<Row>(
          `SELECT t.id, t.description, t.amount_cents, t.date::text AS date,
                  t.installments_total, t.installment_number${includeCatId}
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id AND c.household_id = $4
            WHERE t.account_id = $1
              AND t.household_id = $4
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
            isRecurring: false,
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
      if (opts?.accountId) {
        params.push(opts.accountId);
        conditions.push(`account_id = $${params.length}`);
      }
      if (opts?.status) {
        params.push(opts.status);
        conditions.push(`status = $${params.length}`);
      }
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

    async updatePurchase(householdId, purchaseId, input) {
      // Task 2.7: the detail is read AFTER commit — getStatementDetail
      // queries through the pool, which cannot see this transaction's
      // uncommitted writes. The mutation core is shared with
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

    async createCard(householdId, input) {
      const res = await query<Row>(
        `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day)
         VALUES (gen_random_uuid(), $1, $2, 'credit_card', 0, 'active', $3, $4, $5)
         RETURNING id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day`,
        [householdId, input.name, input.creditLimitCents, input.closingDay, input.dueDay],
      );
      return mapAccount(res[0]!);
    },

    async updateCard(householdId, id, input) {
      return withTransaction(pool, async (client) => {
        // SPEC §9.3: $1/$2 are the row keys — first column binds at $3.
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 2;
        if (input.name !== undefined) { sets.push(`name = $${++idx}`); params.push(input.name); }
        if (input.creditLimitCents !== undefined) { sets.push(`credit_limit_cents = $${++idx}`); params.push(input.creditLimitCents); }
        if (input.closingDay !== undefined) { sets.push(`closing_day = $${++idx}`); params.push(input.closingDay); }
        if (input.dueDay !== undefined) { sets.push(`due_day = $${++idx}`); params.push(input.dueDay); }
        if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');
        params.unshift(id, householdId);
        const res = await client.query<Row>(
          `UPDATE accounts SET ${sets.join(', ')}, updated_at = NOW()
            WHERE id = $1 AND household_id = $2 AND kind = 'credit_card' AND status = 'active' AND deleted_at IS NULL
            RETURNING id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day`,
          params,
        );
        if (res.rowCount === 0 || res.rows.length === 0) throw domainErrors.notFound('Cartão');
        return mapAccount(res.rows[0]!);
      });
    },
  };
  // V4.1 Phase 3 (UOW2): expose the client-bound cores as non-contractual
  // extensions (see CardStoreTxExtensions in cards/keyed-mutations.ts).
  // The declared factory return type stays CardStore.
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
