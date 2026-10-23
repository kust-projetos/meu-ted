import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Goal, } from '../types/domain.js';
import type { GoalStore } from './store.js';
import { domainErrors } from '../writes/errors.js';
import { withTransaction } from '../db/pool.js';
import { assertWorkspaceWritableInTx } from '../auth/workspace-lifecycle-guard.js';
import { lockCategoryReferencesInTx } from '../auth/category-lifecycle-guard.js';
type Row = Record<string, unknown>;

type CreateGoalInput = Parameters<GoalStore['createGoal']>[1];
type ContributeGoalInput = Parameters<GoalStore['contributeToGoal']>[2];
type UpdateGoalInput = Parameters<GoalStore['updateGoal']>[2];

/**
 * V4.1 Phase 3 (UOW2) — client-bound goal cores (no transaction handling).
 * The plain store methods run them in their own transaction; keyed route
 * producers (see goals/keyed-mutations.ts) run them on the open idempotency
 * claim client, so claim + effect + completion commit atomically in ONE
 * transaction. The atomic increment (§9.6) holds inside the merged tx.
 */
export const createGoalInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateGoalInput,
  categoryShape: 'status' | 'active' = 'status',
): Promise<Goal> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  if (input.categoryId) {
    await lockCategoryReferencesInTx(client, householdId);
    const category = await client.query<Row>(
      `SELECT id FROM categories WHERE id = $1 AND household_id = $2 AND ${categoryShape === 'status' ? "status = 'active'" : 'active = true'} AND deleted_at IS NULL`,
      [input.categoryId, householdId],
    );
    if ((category.rowCount ?? 0) === 0) throw domainErrors.notFound('Categoria');
  }
  const id = randomUUID();
  await client.query(`INSERT INTO goals (id,household_id,name,goal_type,target_amount_cents,start_date,target_date,description,category_id,account_id,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, householdId, input.name, input.goalType, input.targetAmountCents, input.startDate, input.targetDate ?? null, input.description ?? null, input.categoryId ?? null, input.accountId ?? null, input.notes ?? null]);
  return { id, householdId, name: input.name, goalType: input.goalType as Goal['goalType'], targetAmountCents: input.targetAmountCents, currentAmountCents: 0, startDate: input.startDate, status: 'active' as const };
};

const contributeToGoalInTx = async (
  client: PoolClient,
  householdId: string,
  goalId: string,
  input: ContributeGoalInput,
) => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  // V4.1 SPEC §9.6: atomic increment — never read-modify-write. The
  // single UPDATE both adds the contribution and flips status, so N
  // concurrent contributions sum exactly (goal.current == SUM).
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
  await client.query(`INSERT INTO goal_contributions (id,goal_id,amount_cents,contribution_date,source,notes) VALUES ($1,$2,$3,$4,$5,$6)`, [cid, goalId, input.amountCents, input.contributionDate ?? new Date().toISOString().slice(0, 10), input.source ?? null, input.notes ?? null]);
  return { id: cid, goalId, amountCents: input.amountCents, contributionDate: input.contributionDate ?? new Date().toISOString().slice(0, 10) };
};

const updateGoalInTx = async (
  client: PoolClient,
  householdId: string,
  goalId: string,
  input: UpdateGoalInput,
): Promise<Goal> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const existing = await client.query<Row>(`SELECT * FROM goals WHERE id=$1 AND household_id=$2`, [goalId, householdId]);
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound('Meta');

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 2;
  if (input.name !== undefined) { sets.push(`name = $${++idx}`); params.push(input.name); }
  if (input.targetAmountCents !== undefined) { sets.push(`target_amount_cents = $${++idx}`); params.push(input.targetAmountCents); }
  if (input.targetDate !== undefined) { sets.push(`target_date = $${++idx}`); params.push(input.targetDate); }
  if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');

  params.unshift(goalId, householdId);
  const res = await client.query<Row>(
    `UPDATE goals SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1 AND household_id=$2 RETURNING *`,
    params,
  );
  const r = res.rows[0]!;
  return { id: r['id'] as string, householdId: r['household_id'] as string, name: r['name'] as string, goalType: r['goal_type'] as Goal['goalType'], targetAmountCents: Number(r['target_amount_cents']), currentAmountCents: Number(r['current_amount_cents']), startDate: (r['start_date'] as Date).toISOString().slice(0, 10), ...(r['target_date'] ? { targetDate: (r['target_date'] as Date).toISOString().slice(0, 10) } : {}), status: r['status'] as Goal['status'] } as Goal;
};

/**
 * FIX-WS-D2-R3 item 2 — core client-bound do cancelamento: guarda
 * FOR SHARE + efeito no MESMO cliente (antes era check-then-act fora de
 * transação). Sem efeito em workspace arquivado/excluído.
 */
const cancelGoalInTx = async (
  client: PoolClient,
  householdId: string,
  goalId: string,
) => {
  await assertWorkspaceWritableInTx(client, householdId);
  const existing = await client.query<Row>(`SELECT * FROM goals WHERE id=$1 AND household_id=$2`, [goalId, householdId]);
  if (existing.rowCount === 0 || existing.rows.length === 0) throw domainErrors.notFound('Meta');
  await client.query(`UPDATE goals SET status='cancelled', updated_at=NOW() WHERE id=$1 AND household_id=$2`, [goalId, householdId]);
  const r = existing.rows[0]!;
  return { id: goalId, householdId, name: r['name'] as string, goalType: r['goal_type'] as Goal['goalType'], targetAmountCents: Number(r['target_amount_cents']), currentAmountCents: Number(r['current_amount_cents']), startDate: (r['start_date'] as Date).toISOString().slice(0, 10), status: 'cancelled' as const };
};

export const createPostgresGoalStore = (pool: Pool): GoalStore => {
  const query = async <R extends Row = Row>(t: string, v: unknown[] = []) => { const r = await pool.query<R>(t, v); return r.rows; };
  const store: GoalStore = {
    async listGoals(householdId) {
      const rows = await query<Row>(`SELECT * FROM goals WHERE household_id=$1 AND status<>'cancelled' ORDER BY target_amount_cents DESC`, [householdId]);
      return rows.map(r => ({ id: r['id'] as string, householdId, name: r['name'] as string, goalType: r['goal_type'] as Goal['goalType'], targetAmountCents: Number(r['target_amount_cents']), currentAmountCents: Number(r['current_amount_cents']), startDate: (r['start_date'] as Date).toISOString().slice(0,10), status: r['status'] as Goal['status'] }));
    },
    async createGoal(householdId, input) {
      return withTransaction(pool, (client) => createGoalInTx(client, householdId, input));
    },
    async contributeToGoal(householdId, goalId, input) {
      return withTransaction(pool, (client) => contributeToGoalInTx(client, householdId, goalId, input));
    },
    async cancelGoal(householdId, goalId, _reason) {
      // FIX-WS-D2-R3 item 2: guarda FOR SHARE + efeito na mesma
      // transação (antes era check-then-act fora de transação).
      return withTransaction(pool, (client) => cancelGoalInTx(client, householdId, goalId));
    },

    async updateGoal(householdId, goalId, input) {
      return withTransaction(pool, (client) => updateGoalInTx(client, householdId, goalId, input));
    },
  };
  // V4.1 Phase 3 (UOW2): expose the client-bound cores as non-contractual
  // extensions (see GoalStoreTxExtensions in goals/keyed-mutations.ts).
  // The declared factory return type stays GoalStore.
  return Object.assign(store, {
    createGoalInTx,
    contributeToGoalInTx,
    updateGoalInTx,
    cancelGoalInTx,
  });
};
