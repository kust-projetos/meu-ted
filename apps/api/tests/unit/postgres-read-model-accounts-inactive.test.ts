import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresReadModelStore } from '../../src/read-models/postgres-store.js';

/**
 * A08: `includeInactive` at the SQL level.
 *
 * The behaviour is proven by the route test; this file proves the emitted SQL
 * keeps the invariants that a route test cannot see:
 * - the DEFAULT still carries `status = 'active'` (the default never moves);
 * - the opt-in drops ONLY that predicate;
 * - `household_id = $1` and the single bind stay in both branches, so the
 *   widening can never escape the workspace (repo rule #2);
 * - the card and soft-delete exclusions survive the opt-in.
 *
 * Same convention as the legacy counterpart: a fake pool captures the SQL, so
 * no live PostgreSQL is needed (the engine-level check is the PG CI twin).
 */

const H = '11111111-1111-4111-8111-111111111111';

type Captured = { text: string; values: unknown[] };

const fakePool = (rows: Array<Record<string, unknown>>, captured: Captured[]): Pool =>
  ({
    query: async (text: string, values: unknown[] = []) => {
      captured.push({ text, values });
      return { rows };
    },
  }) as unknown as Pool;

const INACTIVE_ROW = {
  id: '22222222-2222-4222-8222-222222222222',
  household_id: H,
  name: 'Conta desativada',
  kind: 'cash',
  balance_cents: 0,
  status: 'inactive',
};

describe('canonical read model — listAccounts includeInactive SQL', () => {
  it('keeps the active-only predicate and the household bind by default', async () => {
    const captured: Captured[] = [];
    const store = createPostgresReadModelStore({ pool: fakePool([], captured) });

    await store.listAccounts(H);

    const { text, values } = captured[0]!;
    expect(values).toEqual([H]);
    expect(text).toMatch(/household_id = \$1/);
    expect(text).toMatch(/status = 'active'/);
    expect(text).toMatch(/kind <> 'credit_card'/);
    expect(text).toMatch(/deleted_at IS NULL/);
  });

  it('drops ONLY the availability predicate when opted in, still household-scoped', async () => {
    const captured: Captured[] = [];
    const store = createPostgresReadModelStore({ pool: fakePool([INACTIVE_ROW], captured) });

    const rows = await store.listAccounts(H, { includeInactive: true });

    const { text, values } = captured[0]!;
    expect(values).toEqual([H]);
    expect(text).not.toMatch(/status = 'active'/);
    // Unchanged scope guards — the opt-in is availability-only.
    expect(text).toMatch(/household_id = \$1/);
    expect(text).toMatch(/kind <> 'credit_card'/);
    expect(text).toMatch(/deleted_at IS NULL/);
    // The inactive row comes back with its status, not as an active row.
    expect(rows).toEqual([
      { id: INACTIVE_ROW.id, householdId: H, name: 'Conta desativada', kind: 'cash', balanceCents: 0, status: 'inactive' },
    ]);
  });

  it('treats an explicit false exactly like the omitted default', async () => {
    const captured: Captured[] = [];
    const store = createPostgresReadModelStore({ pool: fakePool([], captured) });

    await store.listAccounts(H, { includeInactive: false });

    expect(captured[0]!.text).toMatch(/status = 'active'/);
  });
});