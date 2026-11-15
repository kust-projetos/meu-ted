import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createLegacyPostgresReadModelStore } from '../../src/read-models/legacy-postgres-store.js';

/**
 * FIX-API-LEGACY-ACCOUNT-LIST-CARDS — TDD guard.
 *
 * Legacy schema flags cards with `is_credit_card` (no `kind` column), so the
 * generic `listAccounts` read model must exclude `is_credit_card = true`,
 * in parity with the canonical store (`kind <> 'credit_card'`). Otherwise a
 * card row is mapped with the default `kind: 'bank'` and leaks into
 * `GET /accounts`, kind filters, and balance consumers.
 *
 * No live PostgreSQL needed: a fake pool captures the emitted SQL (proves
 * the WHERE predicate + household binding) and returns canned rows (proves
 * the mapping). True end-to-end exclusion by the DB engine still requires a
 * disposable PG (legacy-canonical-parity, PG-gated Parts B/C).
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

describe('legacy read model — listAccounts excludes credit cards', () => {
  it("emits an is_credit_card exclusion predicate (parity with canonical kind <> 'credit_card')", async () => {
    const captured: Captured[] = [];
    const store = createLegacyPostgresReadModelStore({
      pool: fakePool([], captured),
    });

    await store.listAccounts(H);

    expect(captured).toHaveLength(1);
    const sql = captured[0]!.text;
    // RED before fix: legacy SQL has no is_credit_card predicate at all.
    expect(sql).toMatch(/is_credit_card/i);
    expect(sql).toMatch(/IS NOT TRUE|= *false|<> *true|NOT\s+a\.is_credit_card/i);
  });

  it('stays household-scoped, active-only and soft-delete guarded', async () => {
    const captured: Captured[] = [];
    const store = createLegacyPostgresReadModelStore({
      pool: fakePool([], captured),
    });

    await store.listAccounts(H);

    const { text, values } = captured[0]!;
    expect(values).toEqual([H]);
    expect(text).toMatch(/a\.household_id = \$1/);
    expect(text).toMatch(/a\.active = true/);
    expect(text).toMatch(/a\.deleted_at IS NULL/);
  });

  it('maps surviving non-card rows with computed balance, kind bank and status', async () => {
    const captured: Captured[] = [];
    const store = createLegacyPostgresReadModelStore({
      pool: fakePool(
        [
          {
            id: 'acc-bank-1',
            household_id: H,
            name: 'Banco',
            balance_cents: 50000,
            active: true,
          },
        ],
        captured,
      ),
    });

    const accounts = await store.listAccounts(H);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: 'acc-bank-1',
      householdId: H,
      name: 'Banco',
      kind: 'bank',
      balanceCents: 50000,
      status: 'active',
      institutionId: null,
      cardProductId: null,
    });
    expect(captured[0]!.text).not.toMatch(/institution_id|card_product_id/i);
  });
});
