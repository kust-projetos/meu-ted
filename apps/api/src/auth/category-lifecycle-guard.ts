import type { PoolClient } from 'pg';
import { DomainError } from '../writes/errors.js';

/**
 * Serializes category deactivation against every transaction that can persist
 * a category reference in the same household. Shared locks coexist; the
 * deactivation path takes the matching exclusive lock before inspecting any
 * category/reference rows. Keep this lock after the workspace lifecycle lock
 * and before category/account/domain row locks.
 */
export const lockCategoryReferencesInTx = async (
  client: PoolClient,
  householdId: string,
): Promise<void> => {
  await client.query(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, [
    `category.lifecycle:${householdId}`,
  ]);
};

export const lockCategoryDeactivationInTx = async (
  client: PoolClient,
  householdId: string,
): Promise<void> => {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `category.lifecycle:${householdId}`,
  ]);
};

/** Count every persisted category dependency, including soft-deleted rows. */
export const assertCategoryHasNoPersistedReferencesInTx = async (
  client: PoolClient,
  householdId: string,
  categoryId: string,
): Promise<void> => {
  const result = await client.query<{ used: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM categories WHERE household_id = $1 AND parent_id = $2)
       OR EXISTS (SELECT 1 FROM transactions WHERE household_id = $1 AND (category_id = $2 OR subcategory_id = $2))
       OR EXISTS (SELECT 1 FROM budgets WHERE household_id = $1 AND category_id = $2)
       OR EXISTS (SELECT 1 FROM goals WHERE household_id = $1 AND category_id = $2)
       OR EXISTS (SELECT 1 FROM accounts_payable WHERE household_id = $1 AND category_id = $2)
       OR EXISTS (SELECT 1 FROM card_purchases WHERE household_id = $1 AND (category_id = $2 OR subcategory_id = $2))
       OR EXISTS (SELECT 1 FROM recurring_purchases WHERE household_id = $1 AND category_id = $2)
     ) AS used`,
    [householdId, categoryId],
  );
  if (result.rows[0]?.used) {
    throw new DomainError(
      'in_use',
      'Categoria possui referências persistidas; resolva-as antes de desativar.',
      409,
    );
  }
};
