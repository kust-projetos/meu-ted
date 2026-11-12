import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { validationDatabaseProfileFromEnvironment } from '../../src/db/validation-preflight.js';
import { prepareAccountValidationDatabases } from './validation-db-fixture.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';

const DATABASE_URL = process.env.DATABASE_URL_TEST;
const MARKER = process.env.DB_TEST_MARKER;
const describeIfDb = DATABASE_URL && MARKER ? describe : describe.skip;
if (!DATABASE_URL || !MARKER) console.log('[goal-keyed-pg] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');

describeIfDb('goal contribution idempotency PostgreSQL', () => {
  let pool: Pool;
  const households: string[] = [];
  beforeAll(async () => {
    const prepared = await prepareAccountValidationDatabases({ baseUrl: DATABASE_URL!, profile: validationDatabaseProfileFromEnvironment() });
    pool = prepared.main;
  }, 240_000);
  afterAll(async () => {
    if (pool) {
      await requireTestDatabase(pool as never, 'goal-keyed-pg-cleanup');
      for (const householdId of households) {
        await pool.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id=$1)', [householdId]).catch(() => undefined);
        await pool.query('DELETE FROM goals WHERE household_id=$1', [householdId]).catch(() => undefined);
      }
      await pool.end();
    }
  });

  const newGoal = async (status: 'active' | 'cancelled' = 'active') => {
    const householdId = randomUUID();
    households.push(householdId);
    const store = createPostgresGoalStore(pool);
    const goal = await store.createGoal(householdId, { name: 'Goal', goalType: 'savings', targetAmountCents: 100_000, startDate: '2026-01-01' });
    if (status === 'cancelled') await store.cancelGoal(householdId, goal.id);
    return { store, householdId, goal };
  };

  it('replay of same key creates one row and increments once; cancelled rollback and missing goal are domain errors', async () => {
    const { store, householdId, goal } = await newGoal();
    const input = { amountCents: 2500, contributionDate: '2026-11-10' };
    const first = await store.contributeToGoal(householdId, goal.id, input, { idempotencyKey: 'replay-key' });
    const replay = await store.contributeToGoal(householdId, goal.id, input, { idempotencyKey: 'replay-key' });
    expect(replay.id).toBe(first.id);
    await expect(store.contributeToGoal(householdId, goal.id, { ...input, amountCents: 3000 }, { idempotencyKey: 'replay-key' }))
      .rejects.toMatchObject({ code: 'validation.invalid' });
    expect((await store.listGoals(householdId))[0]?.currentAmountCents).toBe(2500);
    expect((await pool.query('SELECT id FROM goal_contributions WHERE goal_id=$1', [goal.id])).rowCount).toBe(1);

    const cancelled = await newGoal('cancelled');
    await expect(cancelled.store.contributeToGoal(cancelled.householdId, cancelled.goal.id, input, { idempotencyKey: 'cancelled-key' }))
      .rejects.toMatchObject({ code: 'validation.invalid' });
    expect((await pool.query('SELECT id FROM goal_contributions WHERE goal_id=$1', [cancelled.goal.id])).rowCount).toBe(0);

    await expect(store.contributeToGoal(householdId, randomUUID(), input, { idempotencyKey: 'missing-key' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});
