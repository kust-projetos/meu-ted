/**
 * Legacy Postgres implementation of BudgetStore (V4.1 Task 2.15).
 *
 * The canonical store (`postgres.ts`) is schema-compatible for every
 * method EXCEPT the new category gate, which queries the `status` column
 * that does not exist on the legacy schema (`active` boolean instead).
 * This twin inherits everything and overrides only `createBudget` with
 * the legacy-shaped gate (same 404/400 shapes) over the shared insert
 * core. `updateBudget` takes no category field, so it needs no gate.
 */

import type { Pool, PoolClient } from 'pg';
import { domainErrors } from '../writes/errors.js';
import { assertCategoryKind } from '../categories/resolve.js';
import { assertBudgetReplayMatches, budgetFromRow, createPostgresBudgetStore, deterministicBudgetId, insertBudgetRow } from './postgres.js';
import { withTransaction } from '../db/pool.js';
import { lockCategoryReferencesInTx } from '../auth/category-lifecycle-guard.js';
import type { BudgetStore } from './store.js';

type Row = Record<string, unknown>;

type CreateBudgetInput = Parameters<BudgetStore['createBudget']>[1];

/**
 * V4.1 Phase 3 (UOW2) — legacy client-bound budget-creation core: the
 * legacy-shaped category gate (`active` boolean) over the shared insert
 * core, on the caller's client.
 */
const createBudgetInTxLegacy = async (
  client: PoolClient,
  householdId: string,
  input: CreateBudgetInput,
) => {
  await lockCategoryReferencesInTx(client, householdId);
  const gate = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> =>
    (await client.query<R>(text, values)).rows;
  const rows = await gate<Row>(
    `SELECT id, kind FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
    [input.categoryId, householdId],
  );
  if (rows.length === 0) throw domainErrors.notFound('Categoria');
  assertCategoryKind(
    { id: input.categoryId, householdId, kind: String(rows[0]!['kind']), status: 'active' },
    'expense',
  );
  return insertBudgetRow(gate, householdId, input);
};

export const createLegacyPostgresBudgetStore = (pool: Pool): BudgetStore => {
  const base = createPostgresBudgetStore(pool);

  const store: BudgetStore = {
    ...base,
    async createBudget(householdId, input, opts) {
      if (!opts?.idempotencyKey) return withTransaction(pool, (client) => createBudgetInTxLegacy(client, householdId, input));
      return withTransaction(pool, async (client) => {
        const id = deterministicBudgetId(householdId, opts.idempotencyKey!);
        const existing = await client.query<Row>(`SELECT * FROM budgets WHERE id=$1 AND household_id=$2`, [id, householdId]);
        if (existing.rows[0]) {
          assertBudgetReplayMatches(existing.rows[0], input);
          return budgetFromRow(existing.rows[0], householdId);
        }
        await lockCategoryReferencesInTx(client, householdId);
        const gate = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => (await client.query<R>(text, values)).rows;
        const categories = await gate<Row>(`SELECT id, kind FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`, [input.categoryId, householdId]);
        if (categories.length === 0) throw domainErrors.notFound('Categoria');
        assertCategoryKind({ id: input.categoryId, householdId, kind: String(categories[0]!['kind']), status: 'active' }, 'expense');
        await insertBudgetRow(gate, householdId, input, { id, onConflictDoNothing: true });
        const row = (await client.query<Row>(`SELECT * FROM budgets WHERE id=$1 AND household_id=$2`, [id, householdId])).rows[0];
        if (!row) throw domainErrors.invalid('budget', 'idempotency key reutilizada');
        assertBudgetReplayMatches(row, input);
        return budgetFromRow(row, householdId);
      });
    },
  };
  // UOW2: override the inherited canonical extension with the legacy core
  // (updateBudget takes no category field — its extension is inherited as-is).
  return Object.assign(store, {
    createBudgetInTx: createBudgetInTxLegacy,
  });
};
