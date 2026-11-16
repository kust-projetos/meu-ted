import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const describeDb = DB_URL ? describe : describe.skip;
const HOUSEHOLD = '00000000-0000-4000-8000-0000000000e5';
const LEGACY_SCHEMA = `g2225_l_${process.pid}_${Date.now()}`;

const scopedPool = (schema: string): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max: 8 });
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
      kind TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, deleted_at TIMESTAMPTZ
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    CREATE TABLE recurring_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, frequency TEXT NOT NULL,
      start_date DATE NOT NULL, end_date DATE, category_id UUID, status TEXT NOT NULL,
      next_due_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

const failingPool = (pool: Pool, needle: string): Pool => {
  const wrapped = Object.create(pool) as Pool;
  wrapped.query = pool.query.bind(pool);
  wrapped.connect = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        return async <R extends QueryResultRow = QueryResultRow>(
          text: string | QueryConfig,
          values?: unknown[],
        ): Promise<QueryResult<R>> => {
          const sql = typeof text === 'string' ? text : text.text;
          if (sql.includes(needle)) throw new Error(`injected UoW failure: ${needle}`);
          return query<R>(text as never, values);
        };
      },
    });
  };
  return wrapped;
};

type QueryConfig = { text: string };

describeDb('G2.2.5 — Postgres Unit of Work rollback', () => {
  let pool: Pool;
  let legacyPool: Pool;

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    legacyPool = scopedPool(LEGACY_SCHEMA);
    await legacyPool.query(`CREATE SCHEMA ${LEGACY_SCHEMA}`);
    await createLegacyTables(legacyPool);
    await runMigrations(pool);
    await pool.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = $1)', [HOUSEHOLD]);
    await pool.query('DELETE FROM goals WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM recurring_purchases WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM payable_templates WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM accounts_payable WHERE household_id = $1', [HOUSEHOLD]);
    // V4.1 Phase 4 Task 4.12: card_purchases.transaction_id references
    // transactions(id) — delete projections before the ledger rows.
    await pool.query('DELETE FROM card_purchases WHERE household_id = $1', [HOUSEHOLD]).catch(() => undefined);
    await pool.query('DELETE FROM transactions WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM statements WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM categories WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM accounts WHERE household_id = $1', [HOUSEHOLD]);
  }, 30_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = $1)', [HOUSEHOLD]);
    await pool?.query('DELETE FROM goals WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM recurring_purchases WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM payable_templates WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM accounts_payable WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM card_purchases WHERE household_id = $1', [HOUSEHOLD]).catch(() => undefined);
    await pool?.query('DELETE FROM transactions WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM statements WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM categories WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM accounts WHERE household_id = $1', [HOUSEHOLD]);
    if (process.env.PRINT_G2_GATE_AUDIT === '1' && pool) {
      const clean = await pool.query<{ accounts: string; transactions: string; statements: string; payables: string; templates: string; goals: string; contributions: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM accounts WHERE household_id = $1) AS accounts,
           (SELECT COUNT(*)::text FROM transactions WHERE household_id = $1) AS transactions,
           (SELECT COUNT(*)::text FROM statements WHERE household_id = $1) AS statements,
           (SELECT COUNT(*)::text FROM accounts_payable WHERE household_id = $1) AS payables,
           (SELECT COUNT(*)::text FROM payable_templates WHERE household_id = $1) AS templates,
           (SELECT COUNT(*)::text FROM goals WHERE household_id = $1) AS goals,
           (SELECT COUNT(*)::text FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = $1)) AS contributions`,
        [HOUSEHOLD],
      );
      console.log('G2_GATE_UOW_CLEANUP', JSON.stringify(clean.rows[0]));
    }
    await pool?.end();
    await legacyPool?.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`);
    await legacyPool?.end();
  });

  it('commits all compound financial effects together (V4.1 Phase 4 Task 4.11: template_id code/schema mismatch resolved by code alignment — accounts_payable carries no template_id column)', async () => {
    const writes = createPostgresWriteStore({ pool });
    const account = await writes.createAccount(HOUSEHOLD, { name: 'UoW commit account', kind: 'bank', initialBalanceCents: 100000 });
    const payables = createPostgresPayableStore(pool);
    const payable = await payables.createPayableWithTemplate(HOUSEHOLD, {
      payable: { accountId: account.id, description: 'UoW commit payable', amountCents: 800, dueDate: '2026-08-03', type: 'recurring', frequency: 'monthly' },
      template: { accountId: account.id, name: 'UoW commit template', description: 'UoW commit payable', amountCents: 800, frequency: 'monthly', dayOfMonth: 3 },
    });
    const paid = await payables.markPayablePaid(HOUSEHOLD, payable.id, { paidDate: '2026-08-03' });
    expect(paid.status).toBe('paid');
    expect((await pool.query('SELECT id FROM payable_templates WHERE household_id = $1 AND name = $2', [HOUSEHOLD, 'UoW commit template'])).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM transactions WHERE household_id = $1 AND description = $2', [HOUSEHOLD, 'UoW commit payable'])).rows).toHaveLength(1);

    const cards = createPostgresCardStore(pool);
    const card = await cards.createCard(HOUSEHOLD, { name: 'UoW commit card', creditLimitCents: 100000, closingDay: 15, dueDay: 25 });
    await cards.createCardPurchase(HOUSEHOLD, { accountId: card.id, description: 'UoW commit purchase', amountCents: 1100, date: '2026-08-05' });
    await cards.createRecurringPurchase(HOUSEHOLD, { accountId: card.id, description: 'UoW commit recurring', amountCents: 500, frequency: 'monthly', startDate: '2026-08-05' });
    expect((await pool.query('SELECT id FROM statements WHERE household_id = $1 AND account_id = $2 AND total_cents = 1100', [HOUSEHOLD, card.id])).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM recurring_purchases WHERE household_id = $1 AND description = $2', [HOUSEHOLD, 'UoW commit recurring'])).rows).toHaveLength(1);

    const goals = createPostgresGoalStore(pool);
    const goal = await goals.createGoal(HOUSEHOLD, { name: 'UoW commit goal', goalType: 'savings', targetAmountCents: 10000, startDate: '2026-08-01' });
    const contribution = await goals.contributeToGoal(HOUSEHOLD, goal.id, { amountCents: 2500, contributionDate: '2026-08-04' });
    expect(contribution.amountCents).toBe(2500);
    expect((await pool.query('SELECT current_amount_cents FROM goals WHERE id = $1', [goal.id])).rows[0]?.current_amount_cents).toBe('2500');
  }, 30_000);

  it('rolls back payable, payment transaction, and next recurrence together', async () => {
    const writes = createPostgresWriteStore({ pool });
    const account = await writes.createAccount(HOUSEHOLD, { name: 'UoW payable account', kind: 'bank', initialBalanceCents: 100000 });
    const payables = createPostgresPayableStore(pool);
    const payable = await payables.createPayable(HOUSEHOLD, {
      accountId: account.id, description: 'UoW payable', amountCents: 1200, dueDate: '2026-08-01', type: 'recurring', frequency: 'monthly',
    });

    const broken = createPostgresPayableStore(failingPool(pool, 'paid_transaction_id'));
    await expect(broken.markPayablePaid(HOUSEHOLD, payable.id, { paidDate: '2026-08-01' })).rejects.toThrow('injected UoW failure');

    const state = await pool.query<{ status: string; paid_transaction_id: string | null }>('SELECT status, paid_transaction_id FROM accounts_payable WHERE id = $1', [payable.id]);
    const effects = await pool.query('SELECT id FROM transactions WHERE household_id = $1 AND description = $2', [HOUSEHOLD, 'UoW payable']);
    const next = await pool.query('SELECT id FROM accounts_payable WHERE household_id = $1 AND due_date = $2', [HOUSEHOLD, '2026-09-01']);
    expect(state.rows[0]).toMatchObject({ status: 'pending', paid_transaction_id: null });
    expect(effects.rows).toHaveLength(0);
    expect(next.rows).toHaveLength(0);
  }, 30_000);

  it('undoes a canonical payable payment and soft-deletes its transaction (V4.1 D4: undo contract returns paidTransactionId)', async () => {
    const writes = createPostgresWriteStore({ pool });
    const account = await writes.createAccount(HOUSEHOLD, { name: 'UoW undo account', kind: 'bank', initialBalanceCents: 100000 });
    const payables = createPostgresPayableStore(pool);
    const payable = await payables.createPayable(HOUSEHOLD, { accountId: account.id, description: 'UoW undo payable', amountCents: 600, dueDate: '2026-08-08' });
    const paid = await payables.markPayablePaid(HOUSEHOLD, payable.id, { paidDate: '2026-08-08' });
    expect(paid.paidTransactionId).toBeDefined();
    await payables.undoPayablePayment(HOUSEHOLD, payable.id);
    const row = await pool.query<{ status: string; paid_transaction_id: string | null }>('SELECT status, paid_transaction_id FROM accounts_payable WHERE id = $1', [payable.id]);
    const transaction = await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM transactions WHERE id = $1', [paid.paidTransactionId]);
    // V4.1: undo reopens the payable (pending when due today/future,
    // overdue when past due) and clears the link.
    expect(row.rows[0]).toMatchObject({ paid_transaction_id: null });
    expect(['pending', 'overdue']).toContain(row.rows[0]?.status);
    expect(transaction.rows[0]?.deleted_at).not.toBeNull();
  }, 30_000);

  it('rolls back canonical card editing on failure', async () => {
    const cards = createPostgresCardStore(pool);
    const card = await cards.createCard(HOUSEHOLD, { name: 'UoW edit card', creditLimitCents: 100000, closingDay: 15, dueDay: 25 });
    const broken = createPostgresCardStore(failingPool(pool, 'UPDATE accounts SET'));
    await expect(broken.updateCard(HOUSEHOLD, card.id, { name: 'should rollback' })).rejects.toThrow('injected UoW failure');
    expect((await pool.query('SELECT name FROM accounts WHERE id = $1', [card.id])).rows[0]?.name).toBe('UoW edit card');
  }, 30_000);

  it('rolls back card statement and purchase together', async () => {
    const writes = createPostgresWriteStore({ pool });
    const cardStore = createPostgresCardStore(pool);
    const card = await cardStore.createCard(HOUSEHOLD, { name: 'UoW card', creditLimitCents: 100000, closingDay: 15, dueDay: 25 });
    const broken = createPostgresCardStore(failingPool(pool, 'UPDATE statements SET total_cents'));

    await expect(broken.createCardPurchase(HOUSEHOLD, {
      accountId: card.id, description: 'UoW card purchase', amountCents: 2300, date: '2026-08-05',
    })).rejects.toThrow('injected UoW failure');

    expect((await pool.query('SELECT id FROM statements WHERE household_id = $1 AND account_id = $2', [HOUSEHOLD, card.id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM transactions WHERE household_id = $1 AND description = $2', [HOUSEHOLD, 'UoW card purchase'])).rows).toHaveLength(0);
    void writes;
  }, 30_000);

  it('rolls back goal accumulated amount and contribution together', async () => {
    const goals = createPostgresGoalStore(pool);
    const goal = await goals.createGoal(HOUSEHOLD, { name: 'UoW goal', goalType: 'savings', targetAmountCents: 10000, startDate: '2026-08-01' });
    const broken = createPostgresGoalStore(failingPool(pool, 'INSERT INTO goal_contributions'));

    await expect(broken.contributeToGoal(HOUSEHOLD, goal.id, { amountCents: 3000, contributionDate: '2026-08-02' })).rejects.toThrow('injected UoW failure');

    const state = await pool.query<{ current_amount_cents: string; status: string }>('SELECT current_amount_cents, status FROM goals WHERE id = $1', [goal.id]);
    expect(state.rows[0]).toMatchObject({ current_amount_cents: '0', status: 'active' });
    expect((await pool.query('SELECT id FROM goal_contributions WHERE goal_id = $1', [goal.id])).rows).toHaveLength(0);
  }, 30_000);

  it('rolls back payable and template together', async () => {
    const writes = createPostgresWriteStore({ pool });
    const account = await writes.createAccount(HOUSEHOLD, { name: 'UoW template account', kind: 'bank', initialBalanceCents: 100000 });
    const broken = createPostgresPayableStore(failingPool(pool, 'INSERT INTO payable_templates'));

    await expect(broken.createPayableWithTemplate(HOUSEHOLD, {
      payable: { accountId: account.id, description: 'UoW template payable', amountCents: 700, dueDate: '2026-08-10' },
      template: { accountId: account.id, name: 'UoW template', description: 'UoW template payable', amountCents: 700, frequency: 'monthly', dayOfMonth: 10 },
    })).rejects.toThrow('injected UoW failure');

    expect((await pool.query('SELECT id FROM accounts_payable WHERE household_id = $1 AND description = $2', [HOUSEHOLD, 'UoW template payable'])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM payable_templates WHERE household_id = $1 AND name = $2', [HOUSEHOLD, 'UoW template'])).rows).toHaveLength(0);
  }, 30_000);

});
