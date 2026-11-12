/**
 * Legacy Postgres GoalStore for the pi_financeiro schema (DB_SCHEMA=legacy).
 *
 * The legacy `goals` table matches the canonical contract (list/create/cancel
 * work as-is), so this decorates the canonical store and overrides only
 * contributeToGoal: the legacy `goal_contributions` table has a NOT NULL
 * `household_id` column that the canonical INSERT omits.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GoalStore } from './store.js';
import { createGoalInTx, createPostgresGoalStore } from './postgres.js';
import { domainErrors } from '../writes/errors.js';
import { withTransaction } from '../db/pool.js';

type Row = Record<string, unknown>;

type ContributeGoalInput = Parameters<GoalStore['contributeToGoal']>[2];

/**
 * V4.1 Phase 3 (UOW2) — legacy client-bound contribution core: the atomic
 * increment (same contract as canonical) + legacy household_id on the
 * contribution row.
 */
const contributeToGoalInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  goalId: string,
  input: ContributeGoalInput,
  opts?: { idempotencyKey?: string },
) => {
  const date = input.contributionDate ?? new Date().toISOString().slice(0, 10);
  if (opts?.idempotencyKey) {
    const bytes = createHash('sha256').update(`${householdId}:${opts.idempotencyKey}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const cid = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
    const inserted = await client.query<Row>(`INSERT INTO goal_contributions (id, goal_id, household_id, amount_cents, contribution_date, source, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`, [cid, goalId, householdId, input.amountCents, date, input.source ?? null, input.notes ?? null]);
    if ((inserted.rowCount ?? 0) === 0) {
      const prior = await client.query<Row>(`SELECT id, goal_id, amount_cents, contribution_date FROM goal_contributions WHERE id=$1`, [cid]);
      if (!prior.rows[0]) throw new Error('goal_contribution.idempotency_conflict_missing');
      if (prior.rows[0]['goal_id'] !== goalId) throw domainErrors.invalid('goal', 'idempotency key reutilizada');
      return { id: prior.rows[0]['id'] as string, goalId, amountCents: Number(prior.rows[0]['amount_cents']), contributionDate: String(prior.rows[0]['contribution_date']).slice(0, 10) };
    }
    const updated = await client.query<Row>(`UPDATE goals SET current_amount_cents=current_amount_cents+$3, status=CASE WHEN current_amount_cents+$3>=target_amount_cents THEN 'achieved' ELSE status END, updated_at=NOW() WHERE id=$1 AND household_id=$2 AND status <> 'cancelled'`, [goalId, householdId, input.amountCents]);
    if ((updated.rowCount ?? 0) === 0) {
      const existing = await client.query<Row>(`SELECT status FROM goals WHERE id=$1 AND household_id=$2`, [goalId, householdId]);
      if (!existing.rows[0]) throw domainErrors.notFound('Meta');
      throw domainErrors.invalid('goal', 'meta cancelada não aceita aportes');
    }
    return { id: cid, goalId, amountCents: input.amountCents, contributionDate: date };
  }
  const updated = await client.query<Row>(
    `UPDATE goals
        SET current_amount_cents = current_amount_cents + $3,
            status = CASE WHEN current_amount_cents + $3 >= target_amount_cents THEN 'achieved' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND household_id = $2 AND status <> 'cancelled'`,
    [goalId, householdId, input.amountCents],
  );
  if ((updated.rowCount ?? 0) === 0) {
    const existing = await client.query<Row>(`SELECT status FROM goals WHERE id=$1 AND household_id=$2`, [goalId, householdId]);
    if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound('Meta');
    throw domainErrors.invalid('goal', 'meta cancelada não aceita aportes');
  }
  const cid = randomUUID();
  await client.query(
    `INSERT INTO goal_contributions (id, goal_id, household_id, amount_cents, contribution_date, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [cid, goalId, householdId, input.amountCents, date, input.source ?? null, input.notes ?? null],
  );
  return { id: cid, goalId, amountCents: input.amountCents, contributionDate: date };
};

export const createLegacyPostgresGoalStore = (pool: Pool): GoalStore => {
  const base = createPostgresGoalStore(pool);

  const store: GoalStore = {
    ...base,
    async createGoal(householdId, input) {
      return withTransaction(pool, (client) => createGoalInTx(client, householdId, input, 'active'));
    },
    async contributeToGoal(householdId, goalId, input, opts) {
      return withTransaction(pool, (client) => contributeToGoalInTxLegacy(client, householdId, goalId, input, opts));
    },
  };
  // UOW2: override the inherited canonical extension with the legacy core
  // (create/update extensions are schema-compatible and inherited as-is).
  return Object.assign(store, {
    createGoalInTx: (client: PoolClient, householdId: string, input: Parameters<GoalStore['createGoal']>[1]) =>
      createGoalInTx(client, householdId, input, 'active'),
    contributeToGoalInTx: contributeToGoalInTxLegacy,
  });
};
