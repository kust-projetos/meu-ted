/**
 * V4.1 PHASE 4 Task 4.13 — Legacy × Canonical parity suite (seed of the
 * Phase 10 parity report).
 *
 * Runs equivalent command sequences against both store families and asserts
 * equivalent outcomes (balances, statuses, invariants):
 * - Part A (always runs): canonical in-memory stores — full sequence with
 *   a balance == ledger-derived invariant recomputed from the ledger.
 * - Part B (PG-gated): canonical Postgres stores vs legacy Postgres stores
 *   on isolated schemas — happy-path equivalence on every command.
 * - Part C (PG-gated): former D1 divergence, now convergence — an
 *   over-balance plain expense is booked with the exact negative delta by
 *   BOTH canonical (materialized balance) and legacy (computed balances).
 *   The negative-balance rule closed the migration-blocker input.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryPayableStore } from '../../src/payables/in-memory.js';
import { createInMemoryGoalStore } from '../../src/goals/in-memory.js';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import type { InMemoryState } from '../../src/writes/in-memory.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { createLegacyPostgresPayableStore } from '../../src/payables/legacy-postgres.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';
import { createLegacyPostgresGoalStore } from '../../src/goals/legacy-postgres.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createLegacyPostgresCardStore } from '../../src/cards/legacy-postgres.js';

// ── Part A: in-memory canonical sequence (no PG needed) ────────────────

const H = '00000000-0000-4000-8000-00000000d413';

/** Recompute an in-memory account balance purely from the ledger. */
const ledgerBalanceOf = (state: InMemoryState, accountId: string, initial: number): number => {
  let bal = initial;
  for (const t of state.transactions) {
    if (t.householdId !== H || state.deletedTransactions.has(t.id)) continue;
    if (t.kind === 'expense' && t.accountId === accountId) bal -= t.amountCents;
    else if (t.kind === 'income' && t.accountId === accountId) bal += t.amountCents;
    else if (t.kind === 'transfer') {
      if (t.accountId === accountId) bal -= t.amountCents;
      if (t.transferToAccountId === accountId) bal += t.amountCents;
    }
  }
  return bal;
};

describe('Legacy × Canonical parity — Part A: canonical in-memory sequence + ledger invariant', () => {
  it('equivalent command sequence keeps balance == ledger through pay/unpay/update', async () => {
    const { state, writes } = createInMemoryStores();
    const payables = createInMemoryPayableStore(state);
    const goals = createInMemoryGoalStore(state);
    const cards = createInMemoryCardStore(state);

    const a = await writes.createAccount(H, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const b = await writes.createAccount(H, { name: 'B', kind: 'bank', initialBalanceCents: 50000 });
    const catExp = await writes.createCategory(H, { name: 'Food', kind: 'expense' });
    const catInc = await writes.createCategory(H, { name: 'Salary', kind: 'income' });
    const balanceOf = (id: string): number => state.accounts.find((x) => x.id === id)!.balanceCents;

    await writes.createExpense(H, {
      description: 'Lunch', amountCents: 20000, date: '2026-09-01', accountId: a.id, categoryId: catExp.id,
    });
    await writes.createIncome(H, {
      description: 'Pay', amountCents: 10000, date: '2026-09-01', accountId: b.id, categoryId: catInc.id,
    });
    await writes.createTransfer(H, {
      description: 'Save', amountCents: 30000, date: '2026-09-02', fromAccountId: a.id, toAccountId: b.id,
    });
    expect(balanceOf(a.id)).toBe(50000);
    expect(balanceOf(b.id)).toBe(90000);

    const patched = await writes.updateTransaction(H, state.transactions[0]!.id, { amountCents: 25000 });
    expect(patched.amountCents).toBe(25000);
    expect(balanceOf(a.id)).toBe(45000);

    const payable = await payables.createPayable(H, {
      accountId: b.id, description: 'Bill', amountCents: 15000, dueDate: '2026-09-05', categoryId: catExp.id,
    });
    const paid = await payables.markPayablePaid(H, payable.id, { paidDate: '2026-09-05' });
    expect(paid.status).toBe('paid');
    expect(balanceOf(b.id)).toBe(75000);
    const paidTxId = paid.paidTransactionId!;
    await payables.undoPayablePayment(H, payable.id, { expectedPaidTransactionId: paidTxId });
    expect(balanceOf(b.id)).toBe(90000);

    const goal = await goals.createGoal(H, {
      name: 'Trip', goalType: 'savings', targetAmountCents: 100000, startDate: '2026-09-01',
    });
    await goals.contributeToGoal(H, goal.id, { amountCents: 2500, contributionDate: '2026-09-02' });

    const card = await cards.createCard(H, {
      name: 'Nubank', creditLimitCents: 500000, closingDay: 15, dueDay: 25,
    });
    await cards.createCardPurchase(H, {
      accountId: card.id, description: 'Book', amountCents: 11000, date: '2026-09-03',
    });

    // Invariants: materialized balances equal the ledger derivation; the
    // undone payment no longer counts; goal and statement effects exist.
    expect(balanceOf(a.id)).toBe(ledgerBalanceOf(state, a.id, 100000));
    expect(balanceOf(b.id)).toBe(ledgerBalanceOf(state, b.id, 50000));
    expect(state.deletedTransactions.has(paidTxId)).toBe(true);
    const stored = state.transactions.filter((t) => !state.deletedTransactions.has(t.id));
    expect(stored.filter((t) => t.kind === 'expense')).toHaveLength(2);
    expect(stored.filter((t) => t.kind === 'income')).toHaveLength(1);
    expect(stored.filter((t) => t.kind === 'transfer')).toHaveLength(1);
  });
});

// ── Parts B/C: PG-gated Legacy × Canonical ─────────────────────────────

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[legacy-canonical-parity] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const suffix = `${process.pid}_${Date.now()}`;
const CANON_SCHEMA = `v41par_c_${suffix}`;
const LEG_SCHEMA = `v41par_l_${suffix}`;

const scopedPool = (schema: string, max: number): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max });
};

let adminPool: Pool | undefined;
let canonPool: Pool | undefined;
let legPool: Pool | undefined;

const createCanonicalTables = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, balance_cents BIGINT NOT NULL DEFAULT 0,
      initial_balance_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      credit_limit_cents BIGINT, closing_day INTEGER, due_day INTEGER,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT accounts_balance_nonnegative_card_chk CHECK (kind <> 'credit_card' OR balance_cents >= 0)
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', parent_id UUID,
      icon TEXT, color TEXT, sort_order INTEGER,
      is_default BOOLEAN NOT NULL DEFAULT false, is_system BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      account_id UUID NOT NULL, category_id UUID, subcategory_id UUID, notes TEXT,
      transfer_to_account_id UUID, statement_id UUID,
      installments_total INTEGER, installment_number INTEGER,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT statements_cycle_uniq UNIQUE (household_id, account_id, cycle_year_month)
    );
    CREATE TABLE card_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      statement_id UUID NOT NULL, description TEXT NOT NULL,
      amount_cents BIGINT NOT NULL, date DATE NOT NULL, category_id UUID,
      subcategory_id UUID, notes TEXT,
      installments_total INTEGER, installment_number INTEGER,
      is_recurring BOOLEAN NOT NULL DEFAULT false, transaction_id UUID,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE recurring_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, frequency TEXT NOT NULL,
      start_date DATE NOT NULL, end_date DATE, category_id UUID,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE accounts_payable (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, due_date DATE NOT NULL,
      type TEXT NOT NULL DEFAULT 'one_time', frequency TEXT, end_date DATE,
      status TEXT NOT NULL DEFAULT 'pending', paid_date DATE,
      paid_amount_cents BIGINT, paid_transaction_id UUID,
      reminder_days_before INTEGER NOT NULL DEFAULT 0, notes TEXT, category_id UUID,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE payable_templates (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL, amount_cents BIGINT NOT NULL,
      frequency TEXT NOT NULL, day_of_month INTEGER NOT NULL,
      reminder_days_before INTEGER NOT NULL DEFAULT 0, notes TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE goals (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      description TEXT, goal_type TEXT NOT NULL,
      target_amount_cents BIGINT NOT NULL, current_amount_cents BIGINT NOT NULL DEFAULT 0,
      start_date DATE NOT NULL, target_date DATE,
      category_id UUID, account_id UUID,
      status TEXT NOT NULL DEFAULT 'active', notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE goal_contributions (
      id UUID PRIMARY KEY, goal_id UUID NOT NULL,
      amount_cents BIGINT NOT NULL, contribution_date DATE NOT NULL,
      source TEXT, notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const createLegacyTables = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      initial_balance_cents BIGINT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true,
      is_credit_card BOOLEAN NOT NULL DEFAULT false, credit_limit_cents BIGINT,
      closing_day INTEGER, due_day INTEGER, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, parent_id UUID,
      icon TEXT, color TEXT, sort_order INTEGER,
      is_default BOOLEAN NOT NULL DEFAULT false, is_system BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      from_account_id UUID, to_account_id UUID, category_id UUID, subcategory_id UUID,
      notes TEXT, is_credit_card_purchase BOOLEAN NOT NULL DEFAULT false,
      statement_id UUID, installments_total INTEGER, installment_number INTEGER,
      is_recurring BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT statements_cycle_uniq UNIQUE (household_id, account_id, cycle_year_month)
    );
    CREATE TABLE card_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      statement_id UUID NOT NULL, description TEXT NOT NULL,
      amount_cents BIGINT NOT NULL, date DATE NOT NULL, category_id UUID,
      subcategory_id UUID, notes TEXT,
      installments_total INTEGER, installment_number INTEGER,
      is_recurring BOOLEAN NOT NULL DEFAULT false, transaction_id UUID,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE recurring_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, frequency TEXT NOT NULL,
      start_date DATE NOT NULL, next_due_date DATE NOT NULL, end_date DATE,
      category_id UUID, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE accounts_payable (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, due_date DATE NOT NULL,
      type TEXT NOT NULL, frequency TEXT, end_date DATE, paid_date DATE,
      reminder_days_before INTEGER NOT NULL DEFAULT 0, notes TEXT, category_id UUID,
      status TEXT NOT NULL, paid_transaction_id UUID, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE payable_templates (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL, amount_cents BIGINT NOT NULL,
      frequency TEXT NOT NULL, day_of_month INTEGER NOT NULL, reminder_days_before INTEGER NOT NULL DEFAULT 0,
      notes TEXT, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE goals (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL, goal_type TEXT NOT NULL,
      target_amount_cents BIGINT NOT NULL, current_amount_cents BIGINT NOT NULL DEFAULT 0,
      start_date DATE NOT NULL, target_date DATE, description TEXT, category_id UUID, account_id UUID,
      notes TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE goal_contributions (
      id UUID PRIMARY KEY, goal_id UUID NOT NULL, household_id UUID NOT NULL,
      amount_cents BIGINT NOT NULL, contribution_date DATE NOT NULL, source TEXT, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

/** Legacy computed balance (same formula as the legacy read model). */
const legacyComputedBalance = async (pool: Pool, householdId: string, accountId: string): Promise<number> => {
  const r = await pool.query(
    `SELECT COALESCE((SELECT initial_balance_cents FROM accounts WHERE id = $1 AND household_id = $2), 0)
       + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE household_id = $2 AND to_account_id = $1 AND kind IN ('income', 'transfer') AND deleted_at IS NULL), 0)
       - COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE household_id = $2 AND from_account_id = $1 AND kind IN ('expense', 'transfer') AND deleted_at IS NULL), 0)
       AS balance`,
    [accountId, householdId],
  );
  return Number(r.rows[0]!['balance']);
};

describeIfDb('Legacy × Canonical parity — Parts B/C (PG-gated)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    await requireTestDatabase(adminPool, 'schema-create');
    canonPool = scopedPool(CANON_SCHEMA, 8);
    legPool = scopedPool(LEG_SCHEMA, 8);
    await adminPool.query(`CREATE SCHEMA ${CANON_SCHEMA}`);
    await adminPool.query(`CREATE SCHEMA ${LEG_SCHEMA}`);
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await createCanonicalTables(canonPool);
    await createLegacyTables(legPool);
  }, 120_000);

  afterAll(async () => {
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${CANON_SCHEMA} CASCADE`).catch(() => undefined);
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${LEG_SCHEMA} CASCADE`).catch(() => undefined);
    await canonPool?.end();
    await legPool?.end();
    await adminPool?.end();
  });

  it('Part B: equivalent happy-path sequence yields equivalent outcomes on both families', async () => {
    const cw = createPostgresWriteStore({ pool: canonPool! });
    const lw = createLegacyPostgresWriteStore({ pool: legPool! });
    const cp = createPostgresPayableStore(canonPool!);
    const lp = createLegacyPostgresPayableStore(legPool!);
    const cg = createPostgresGoalStore(canonPool!);
    const lg = createLegacyPostgresGoalStore(legPool!);
    const cc = createPostgresCardStore(canonPool!);
    const lc = createLegacyPostgresCardStore(legPool!);

    const chh = randomUUID();
    const lhh = randomUUID();

    // accounts
    const ca = await cw.createAccount(chh, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const cb = await cw.createAccount(chh, { name: 'B', kind: 'bank', initialBalanceCents: 50000 });
    const la = await lw.createAccount(lhh, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const lb = await lw.createAccount(lhh, { name: 'B', kind: 'bank', initialBalanceCents: 50000 });

    // categories
    const cExp = (
      await canonPool!.query(
        `INSERT INTO categories (id, household_id, name, kind, status) VALUES (gen_random_uuid(), $1, $2, 'expense', 'active') RETURNING id`,
        [chh, `Food-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!['id'] as string;
    const cInc = (
      await canonPool!.query(
        `INSERT INTO categories (id, household_id, name, kind, status) VALUES (gen_random_uuid(), $1, $2, 'income', 'active') RETURNING id`,
        [chh, `Pay-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!['id'] as string;
    const lExp = (
      await legPool!.query(
        `INSERT INTO categories (id, household_id, name, kind, active) VALUES ($1, $2, $3, 'expense', true) RETURNING id`,
        [randomUUID(), lhh, `Food-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!['id'] as string;
    const lInc = (
      await legPool!.query(
        `INSERT INTO categories (id, household_id, name, kind, active) VALUES ($1, $2, $3, 'income', true) RETURNING id`,
        [randomUUID(), lhh, `Pay-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!['id'] as string;

    // expense / income / transfer
    await cw.createExpense(chh, { description: 'Lunch', amountCents: 20000, date: '2026-09-01', accountId: ca.id, categoryId: cExp });
    await lw.createExpense(lhh, { description: 'Lunch', amountCents: 20000, date: '2026-09-01', accountId: la.id, categoryId: lExp });
    await cw.createIncome(chh, { description: 'Pay', amountCents: 10000, date: '2026-09-01', accountId: cb.id, categoryId: cInc });
    await lw.createIncome(lhh, { description: 'Pay', amountCents: 10000, date: '2026-09-01', accountId: lb.id, categoryId: lInc });
    await cw.createTransfer(chh, { description: 'Save', amountCents: 30000, date: '2026-09-02', fromAccountId: ca.id, toAccountId: cb.id });
    await lw.createTransfer(lhh, { description: 'Save', amountCents: 30000, date: '2026-09-02', fromAccountId: la.id, toAccountId: lb.id });

    const canonA = Number((await canonPool!.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [ca.id])).rows[0]!['balance_cents']);
    const canonB = Number((await canonPool!.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [cb.id])).rows[0]!['balance_cents']);
    expect(canonA).toBe(await legacyComputedBalance(legPool!, lhh, la.id));
    expect(canonB).toBe(await legacyComputedBalance(legPool!, lhh, lb.id));
    expect(canonA).toBe(50000);
    expect(canonB).toBe(90000);

    // patch (amount-only)
    const [cTx] = (await canonPool!.query(`SELECT id FROM transactions WHERE household_id = $1 AND description = 'Lunch'`, [chh])).rows;
    const [lTx] = (await legPool!.query(`SELECT id FROM transactions WHERE household_id = $1 AND description = 'Lunch'`, [lhh])).rows;
    await cw.updateTransaction(chh, cTx!['id'] as string, { amountCents: 25000 });
    await lw.updateTransaction(lhh, lTx!['id'] as string, { amountCents: 25000 });
    expect(Number((await canonPool!.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [ca.id])).rows[0]!['balance_cents'])).toBe(
      await legacyComputedBalance(legPool!, lhh, la.id),
    );

    // payable pay / unpay
    const cPay = await cp.createPayable(chh, { accountId: cb.id, description: 'Bill', amountCents: 15000, dueDate: '2026-09-05' });
    const lPay = await lp.createPayable(lhh, { accountId: lb.id, description: 'Bill', amountCents: 15000, dueDate: '2026-09-05' });
    const cPaid = await cp.markPayablePaid(chh, cPay.id, { paidDate: '2026-09-05' });
    const lPaid = await lp.markPayablePaid(lhh, lPay.id, { paidDate: '2026-09-05' });
    expect(cPaid.status).toBe(lPaid.status);
    expect(cPaid.status).toBe('paid');
    expect(Number((await canonPool!.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [cb.id])).rows[0]!['balance_cents'])).toBe(
      await legacyComputedBalance(legPool!, lhh, lb.id),
    );
    await cp.undoPayablePayment(chh, cPay.id, { expectedPaidTransactionId: cPaid.paidTransactionId });
    await lp.undoPayablePayment(lhh, lPay.id, { expectedPaidTransactionId: lPaid.paidTransactionId });
    const cUndone = (await canonPool!.query(`SELECT status FROM accounts_payable WHERE id = $1`, [cPay.id])).rows[0]!['status'];
    const lUndone = (await legPool!.query(`SELECT status FROM accounts_payable WHERE id = $1`, [lPay.id])).rows[0]!['status'];
    expect(cUndone).toBe(lUndone);
    expect(Number((await canonPool!.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [cb.id])).rows[0]!['balance_cents'])).toBe(
      await legacyComputedBalance(legPool!, lhh, lb.id),
    );

    // goal contribute
    const cGoal = await cg.createGoal(chh, { name: 'Trip', goalType: 'savings', targetAmountCents: 100000, startDate: '2026-09-01' });
    const lGoal = await lg.createGoal(lhh, { name: 'Trip', goalType: 'savings', targetAmountCents: 100000, startDate: '2026-09-01' });
    await cg.contributeToGoal(chh, cGoal.id, { amountCents: 2500, contributionDate: '2026-09-02' });
    await lg.contributeToGoal(lhh, lGoal.id, { amountCents: 2500, contributionDate: '2026-09-02' });
    const cCur = Number((await canonPool!.query(`SELECT current_amount_cents FROM goals WHERE id = $1`, [cGoal.id])).rows[0]!['current_amount_cents']);
    const lCur = Number((await legPool!.query(`SELECT current_amount_cents FROM goals WHERE id = $1`, [lGoal.id])).rows[0]!['current_amount_cents']);
    expect(cCur).toBe(lCur);
    expect(cCur).toBe(2500);

    // card purchase → statement totals
    const cCard = await cc.createCard(chh, { name: 'Nubank', creditLimitCents: 500000, closingDay: 15, dueDay: 25 });
    const lCard = await lc.createCard(lhh, { name: 'Nubank', creditLimitCents: 500000, closingDay: 15, dueDay: 25 });
    await cc.createCardPurchase(chh, { accountId: cCard.id, description: 'Book', amountCents: 11000, date: '2026-09-03' });
    await lc.createCardPurchase(lhh, { accountId: lCard.id, description: 'Book', amountCents: 11000, date: '2026-09-03' });
    const cTotal = Number(
      (await canonPool!.query(`SELECT total_cents FROM statements WHERE household_id = $1 AND account_id = $2`, [chh, cCard.id])).rows[0]!['total_cents'],
    );
    const lTotal = Number(
      (await legPool!.query(`SELECT total_cents FROM statements WHERE household_id = $1 AND account_id = $2`, [lhh, lCard.id])).rows[0]!['total_cents'],
    );
    expect(cTotal).toBe(lTotal);
    expect(cTotal).toBe(11000);
  });

  it('Part C: over-balance expense converges — booked-negative on canonical AND legacy', async () => {
    const cw = createPostgresWriteStore({ pool: canonPool! });
    const lw = createLegacyPostgresWriteStore({ pool: legPool! });
    const chh = randomUUID();
    const lhh = randomUUID();
    const ca = await cw.createAccount(chh, { name: 'A', kind: 'bank', initialBalanceCents: 2000 });
    const la = await lw.createAccount(lhh, { name: 'A', kind: 'bank', initialBalanceCents: 2000 });
    const cExp = (
      await canonPool!.query(
        `INSERT INTO categories (id, household_id, name, kind, status) VALUES (gen_random_uuid(), $1, $2, 'expense', 'active') RETURNING id`,
        [chh, `Food-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!['id'] as string;
    const lExp = (
      await legPool!.query(
        `INSERT INTO categories (id, household_id, name, kind, active) VALUES ($1, $2, $3, 'expense', true) RETURNING id`,
        [randomUUID(), lhh, `Food-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]!['id'] as string;

    // Canonical (negative-balance rule): books with the exact negative
    // delta, balance == ledger-derived afterwards.
    const ctx = await cw.createExpense(chh, { description: 'Too big', amountCents: 10000, date: '2026-09-01', accountId: ca.id, categoryId: cExp });
    expect(ctx.amountCents).toBe(10000);
    expect(Number((await canonPool!.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [ca.id])).rows[0]!['balance_cents'])).toBe(2000 - 10000);

    // Legacy (production behavior, computed balances): books the expense
    // and the computed balance goes negative — same outcome.
    await lw.createExpense(lhh, { description: 'Too big', amountCents: 10000, date: '2026-09-01', accountId: la.id, categoryId: lExp });
    expect(await legacyComputedBalance(legPool!, lhh, la.id)).toBe(2000 - 10000);
  });
});
