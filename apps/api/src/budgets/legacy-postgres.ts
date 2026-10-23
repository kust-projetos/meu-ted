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
import { createPostgresBudgetStore, insertBudgetRow } from './postgres.js';
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
    async createBudget(householdId, input) {
      return withTransaction(pool, (client) => createBudgetInTxLegacy(client, householdId, input));
    },
  };
  // UOW2: override the inherited canonical extension with the legacy core
  // (updateBudget takes no category field — its extension is inherited as-is).
  return Object.assign(store, {
    createBudgetInTx: createBudgetInTxLegacy,
  });
};
