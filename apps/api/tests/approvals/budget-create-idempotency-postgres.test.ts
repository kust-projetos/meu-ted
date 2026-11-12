import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { validationDatabaseProfileFromEnvironment } from '../../src/db/validation-preflight.js';
import { prepareAccountValidationDatabases } from './validation-db-fixture.js';
import { createPostgresBudgetStore } from '../../src/budgets/postgres.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';

const DATABASE_URL = process.env.DATABASE_URL_TEST;
const MARKER = process.env.DB_TEST_MARKER;
const describeIfDb = DATABASE_URL && MARKER ? describe : describe.skip;
if (!DATABASE_URL || !MARKER) console.log('[budget-keyed-pg] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');

describeIfDb('budget create idempotency PostgreSQL', () => {
  let pool: Pool;
  const households: string[] = [];
  beforeAll(async () => {
    const prepared = await prepareAccountValidationDatabases({ baseUrl: DATABASE_URL!, profile: validationDatabaseProfileFromEnvironment() });
    pool = prepared.main;
  }, 240_000);
  afterAll(async () => {
    if (!pool) return;
    await requireTestDatabase(pool as never, 'budget-keyed-pg-cleanup');
    for (const householdId of households) {
      await pool.query('DELETE FROM budgets WHERE household_id=$1', [householdId]).catch(() => undefined);
      await pool.query('DELETE FROM categories WHERE household_id=$1', [householdId]).catch(() => undefined);
    }
    await pool.end();
  });
  it('replays one id for the same key and rejects a divergent amount', async () => {
    const householdId = randomUUID();
    households.push(householdId);
    const category = await createPostgresWriteStore(pool).createCategory(householdId, { name: 'Food', kind: 'expense' });
    const store = createPostgresBudgetStore(pool);
    const input = { categoryId: category.id, name: 'Food', amountCents: 50000, period: 'monthly' as const, startDate: '2026-11-01' };
    const first = await store.createBudget(householdId, input, { idempotencyKey: 'same' });
    const replay = await store.createBudget(householdId, input, { idempotencyKey: 'same' });
    expect(replay.id).toBe(first.id);
    await expect(store.createBudget(householdId, { ...input, amountCents: 60000 }, { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'validation.invalid' });
    expect((await pool.query('SELECT id FROM budgets WHERE household_id=$1', [householdId])).rowCount).toBe(1);
  });
});
