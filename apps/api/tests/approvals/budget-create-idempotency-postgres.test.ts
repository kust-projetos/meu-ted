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
  let poolPromise: Promise<Pool> | undefined;
  const ensurePool = (): Promise<Pool> => poolPromise ??= prepareAccountValidationDatabases({ baseUrl: DATABASE_URL!, profile: validationDatabaseProfileFromEnvironment() }).then((prepared) => {
    if (!prepared.main) throw new Error('budget-keyed-pg: validation database setup did not provide a main pool');
    return prepared.main;
  });
  const households: string[] = [];
  beforeAll(async () => {
    await ensurePool();
  }, 240_000);
  afterAll(async () => {
    if (!poolPromise) return;
    const pool = await poolPromise;
    await requireTestDatabase(pool as never, 'budget-keyed-pg-cleanup');
    for (const householdId of households) {
      await pool.query('DELETE FROM budgets WHERE household_id=$1', [householdId]).catch(() => undefined);
      await pool.query('DELETE FROM categories WHERE household_id=$1', [householdId]).catch(() => undefined);
    }
    await pool.end();
  });
  it('replays concurrent key, converges after category deactivation and rejects divergent args', async () => {
    const pool = await ensurePool();
    const householdId = randomUUID();
    households.push(householdId);
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(householdId, { name: 'Food', kind: 'expense' });
    const store = createPostgresBudgetStore(pool);
    const input = { categoryId: category.id, name: 'Food', amountCents: 50000, period: 'monthly' as const, startDate: '2026-11-01' };
    const first = await store.createBudget(householdId, input, { idempotencyKey: 'same' });
    const replay = await Promise.all([store.createBudget(householdId, input, { idempotencyKey: 'same' }), store.createBudget(householdId, input, { idempotencyKey: 'same' })]);
    expect(replay.map((budget) => budget.id)).toEqual([first.id, first.id]);
    await writes.deactivateCategory(householdId, category.id, { idempotencyKey: 'deactivate-category', expectedName: 'Food' });
    expect((await store.createBudget(householdId, input, { idempotencyKey: 'same' })).id).toBe(first.id);
    await expect(store.createBudget(householdId, { ...input, amountCents: 60000 }, { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'validation.invalid' });
    for (const changed of [{ name: 'Other' }, { startDate: '2026-12-01' }, { alertThreshold: 90 }]) {
      await expect(store.createBudget(householdId, { ...input, ...changed }, { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'validation.invalid' });
    }
    await expect(store.createBudget(householdId, { ...input, categoryId: randomUUID() }, { idempotencyKey: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query('SELECT id FROM budgets WHERE household_id=$1', [householdId])).rowCount).toBe(1);
  });
});
