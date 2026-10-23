import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  assertCategoryHasNoPersistedReferencesInTx,
  lockCategoryDeactivationInTx,
  lockCategoryReferencesInTx,
} from '../../src/auth/category-lifecycle-guard.js';

const clientWith = (used: boolean) => {
  const query = vi.fn(async () => ({ rows: [{ used }], rowCount: 1 }));
  return { client: { query } as unknown as PoolClient, query };
};

describe('category lifecycle guard SQL contract', () => {
  it('uses a matching workspace-scoped advisory lock namespace', async () => {
    const writer = clientWith(false);
    const deactivation = clientWith(false);
    await lockCategoryReferencesInTx(writer.client, 'household-a');
    await lockCategoryDeactivationInTx(deactivation.client, 'household-a');

    expect(writer.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock_shared(hashtext($1))'),
      ['category.lifecycle:household-a'],
    );
    expect(deactivation.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock(hashtext($1))'),
      ['category.lifecycle:household-a'],
    );
  });

  it('checks all persisted references without live-row filters', async () => {
    const { client, query } = clientWith(false);
    await assertCategoryHasNoPersistedReferencesInTx(client, 'household-a', 'category-a');
    const sql = String(query.mock.calls[0]?.[0]);
    for (const table of [
      'categories', 'transactions', 'budgets', 'goals', 'accounts_payable',
      'card_purchases', 'recurring_purchases',
    ]) expect(sql).toContain(`FROM ${table}`);
    expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL|status\s*=\s*'active'|active\s*=\s*true/i);
    expect(query.mock.calls[0]?.[1]).toEqual(['household-a', 'category-a']);
  });

  it('fails closed when any persisted reference exists', async () => {
    const { client } = clientWith(true);
    await expect(
      assertCategoryHasNoPersistedReferencesInTx(client, 'household-a', 'category-a'),
    ).rejects.toMatchObject({ code: 'in_use', statusCode: 409 });
  });
});
