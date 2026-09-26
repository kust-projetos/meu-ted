import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';
import { createLegacyPostgresGoalStore } from '../../src/goals/legacy-postgres.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';

// V4.1 tasks 2.10/2.11/2.13 — PG-gated proofs (SPEC §9.6 + §9.7).
// Dedicated DB; rows isolated by marker household; legacy tables live in an
// isolated schema created per run (same pattern as
// tests/integration/postgres-unit-of-work.test.ts).
// V4.1 REVIEWFIX F9 [minor]: gate on BOTH env vars + requireTestDatabase,
// like postgres-payable-double-pay.test.ts — DATABASE_URL_TEST alone must
// never enable destructive PG tests.
const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;
const HOUSEHOLD = '00000000-0000-4000-8000-00000000d00d';
const LEGACY_SCHEMA = `g41_patch_${process.pid}_${Date.now()}`;

const scopedPool = (admin: Pool, schema: string): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  // 10 concurrent contributeToGoal tx serialize on one goal row (SELECT FOR
  // UPDATE): each holds 1 connection for the whole tx, so max must exceed
  // the fan-out or waiters hit the 10s connection timeout on a reused
  // (second-run) database. Test-only sizing; production defaults untouched.
  return createPool({ connectionString: url.toString(), max: 16, connectionTimeoutMillis: 30_000 });
};

const createLegacyTables = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      initial_balance_cents BIGINT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true,
      is_credit_card BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
      parent_id UUID, icon TEXT, color TEXT, sort_order INTEGER,
      is_default BOOLEAN, is_system BOOLEAN, deleted_at TIMESTAMPTZ
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      from_account_id UUID, to_account_id UUID, category_id UUID,
      subcategory_id UUID, notes TEXT,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

describeIfDb('V4.1 PG proofs — goals atomicity + transaction PATCH contract', () => {
  let pool: Pool;
  let legacyPool: Pool;

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 16, connectionTimeoutMillis: 30_000 });
    // V4.1 REVIEWFIX F9: fail-closed marker check before any DDL/DML.
    await requireTestDatabase(pool, 'postgres-goals-transactions-v41');
    await runMigrations(pool);
    await pool.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = $1)', [HOUSEHOLD]);
    await pool.query('DELETE FROM goals WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM transactions WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM categories WHERE household_id = $1', [HOUSEHOLD]);
    await pool.query('DELETE FROM accounts WHERE household_id = $1', [HOUSEHOLD]);
    legacyPool = scopedPool(pool, LEGACY_SCHEMA);
    await legacyPool.query(`CREATE SCHEMA ${LEGACY_SCHEMA}`);
    await createLegacyTables(legacyPool);
  }, 60_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = $1)', [HOUSEHOLD]);
    await pool?.query('DELETE FROM goals WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM transactions WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM categories WHERE household_id = $1', [HOUSEHOLD]);
    await pool?.query('DELETE FROM accounts WHERE household_id = $1', [HOUSEHOLD]);
    await legacyPool?.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`);
    await legacyPool?.end();
    await pool?.end();
  });

  it('canonical: 10 concurrent contributions sum exactly (SPEC §9.6)', async () => {
    const goals = createPostgresGoalStore(pool);
    const goal = await goals.createGoal(HOUSEHOLD, {
      name: 'PG concorrente', goalType: 'savings', targetAmountCents: 1_000_000, startDate: '2026-09-01',
    });
    const amounts = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    await Promise.all(
      amounts.map((amountCents) =>
        goals.contributeToGoal(HOUSEHOLD, goal.id, { amountCents, contributionDate: '2026-09-02' }),
      ),
    );
    const row = await pool.query('SELECT current_amount_cents FROM goals WHERE id = $1', [goal.id]);
    expect(Number(row.rows[0]!.current_amount_cents)).toBe(5500);
    const sum = await pool.query('SELECT COALESCE(SUM(amount_cents),0) AS s FROM goal_contributions WHERE goal_id = $1', [goal.id]);
    expect(Number(sum.rows[0]!.s)).toBe(5500);
  }, 30_000);

  it('legacy: 10 concurrent contributions sum exactly (SPEC §9.6)', async () => {
    const goals = createLegacyPostgresGoalStore(legacyPool);
    const goal = await goals.createGoal(HOUSEHOLD, {
      name: 'PG legado concorrente', goalType: 'savings', targetAmountCents: 1_000_000, startDate: '2026-09-01',
    });
    const amounts = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    await Promise.all(
      amounts.map((amountCents) =>
        goals.contributeToGoal(HOUSEHOLD, goal.id, { amountCents, contributionDate: '2026-09-02' }),
      ),
    );
    const row = await legacyPool.query('SELECT current_amount_cents FROM goals WHERE id = $1', [goal.id]);
    expect(Number(row.rows[0]!.current_amount_cents)).toBe(5500);
  }, 30_000);

  it('canonical + legacy: contribution to a cancelled goal is rejected', async () => {
    for (const goals of [createPostgresGoalStore(pool), createLegacyPostgresGoalStore(legacyPool)]) {
      const goal = await goals.createGoal(HOUSEHOLD, {
        name: 'PG cancelada', goalType: 'savings', targetAmountCents: 10_000, startDate: '2026-09-01',
      });
      await goals.cancelGoal(HOUSEHOLD, goal.id);
      await expect(
        goals.contributeToGoal(HOUSEHOLD, goal.id, { amountCents: 100, contributionDate: '2026-09-02' }),
      ).rejects.toMatchObject({ code: 'validation.invalid' });
    }
  }, 30_000);

  it('legacy: updateTransaction applies accountId + categoryId on expense', async () => {
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const a1 = await writes.createAccount(HOUSEHOLD, { name: 'L1', kind: 'bank', initialBalanceCents: 0 });
    const a2 = await writes.createAccount(HOUSEHOLD, { name: 'L2', kind: 'bank', initialBalanceCents: 0 });
    const c1 = await writes.createCategory(HOUSEHOLD, { name: 'LFood', kind: 'expense' });
    const c2 = await writes.createCategory(HOUSEHOLD, { name: 'LHealth', kind: 'expense' });
    const tx = await writes.createExpense(HOUSEHOLD, {
      description: 'LBase', amountCents: 1000, date: '2026-09-10', accountId: a1.id, categoryId: c1.id,
    });
    const upd = await writes.updateTransaction(HOUSEHOLD, tx.id, { accountId: a2.id, categoryId: c2.id });
    expect(upd.accountId).toBe(a2.id);
    expect(upd.categoryId).toBe(c2.id);
  }, 30_000);

  it('legacy + canonical: transfer update with restricted fields is 422 unsupported', async () => {
    const canonical = createPostgresWriteStore({ pool });
    const acc = await canonical.createAccount(HOUSEHOLD, { name: 'C1', kind: 'bank', initialBalanceCents: 100000 });
    const acc2 = await canonical.createAccount(HOUSEHOLD, { name: 'C2', kind: 'bank', initialBalanceCents: 0 });
    const tx = await canonical.createTransfer(HOUSEHOLD, {
      description: 'CT', amountCents: 100, date: '2026-09-10', fromAccountId: acc.id, toAccountId: acc2.id,
    });
    await expect(canonical.updateTransaction(HOUSEHOLD, tx.id, { amountCents: 200 })).rejects.toMatchObject({
      code: 'unsupported', statusCode: 422,
    });
    await expect(canonical.updateTransaction(HOUSEHOLD, tx.id, { notes: 'x' })).rejects.toMatchObject({
      code: 'unsupported', statusCode: 422,
    });

    const legacy = createLegacyPostgresWriteStore({ pool: legacyPool });
    const la = await legacy.createAccount(HOUSEHOLD, { name: 'LA', kind: 'bank', initialBalanceCents: 0 });
    const lb = await legacy.createAccount(HOUSEHOLD, { name: 'LB', kind: 'bank', initialBalanceCents: 0 });
    const ltx = await legacy.createTransfer(HOUSEHOLD, {
      description: 'LT', amountCents: 100, date: '2026-09-10', fromAccountId: la.id, toAccountId: lb.id,
    });
    await expect(legacy.updateTransaction(HOUSEHOLD, ltx.id, { amountCents: 200 })).rejects.toMatchObject({
      code: 'unsupported', statusCode: 422,
    });
    await expect(legacy.updateTransaction(HOUSEHOLD, ltx.id, { notes: 'x' })).rejects.toMatchObject({
      code: 'unsupported', statusCode: 422,
    });
  }, 30_000);
});
