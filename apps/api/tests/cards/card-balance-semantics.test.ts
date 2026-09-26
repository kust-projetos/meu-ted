/**
 * Card balance-semantics discriminator (card-balance-semantics-contract).
 *
 * The PWA historically inferred the card layout from the balance VALUE
 * (see apps/pwa/src/lib/cards/card-debt.ts: "No reliable explicit layout
 * flag exists in the current API contract, so this helper uses an
 * explicit, conservative rule"). A negative or zero-against-nonzero
 * balance is not proof of layout — it is the legacy computed shape
 * (`initial + income − expense …` over `from_account_id` expenses).
 *
 * Contract pinned here:
 * - canonical store → `balanceSemantics: 'outstanding_debt'`
 *   (accounts.balance_cents IS outstanding debt, ADR-018);
 * - legacy store → `balanceSemantics: 'legacy_calculated'`
 *   (balance computed from the ledger, NOT outstanding debt);
 * - the field is an additive, optional, plain-JSON string: consumers
 *   (PWA) MUST treat a missing/unknown value as `unknown` fallback
 *   (statement-fallback display), never infer layout from the value;
 * - no raw persistence detail leaks (no `is_credit_card`,
 *   `initial_balance_cents`, `DB_SCHEMA`/schema names on the DTO).
 *
 * No live PostgreSQL needed: fake pools return canned rows (proving the
 * mapping); the discriminator is a mapper constant, not a new column —
 * no persisted-schema change.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createLegacyPostgresCardStore } from '../../src/cards/legacy-postgres.js';

const H = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

/** Minimal fake pool: canned rows in call order. */
const fakePool = (rowsByCall: Row[][]): Pool => {
  let n = 0;
  return {
    query: async () => {
      const rows = rowsByCall[Math.min(n, rowsByCall.length - 1)]!;
      n += 1;
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
};

/**
 * Consumer-side mirror of the parsing rule the PWA must apply:
 * known literals pass through, anything else (missing, future, garbage)
 * falls back to 'unknown' → statement-fallback display. Kept test-local
 * on purpose: the wire contract is what this suite pins; the PWA owns
 * its own parser (apps/pwa/src/lib/cards/card-debt.ts).
 */
const parseBalanceSemantics = (value: unknown): 'outstanding_debt' | 'legacy_calculated' | 'unknown' =>
  value === 'outstanding_debt' || value === 'legacy_calculated' ? value : 'unknown';

const LEAK_KEYS = [
  'is_credit_card',
  'initial_balance_cents',
  'db_schema',
  'DB_SCHEMA',
  'schema',
  'kind_flag',
];

describe('card read DTO — balanceSemantics discriminator', () => {
  it('canonical listCreditCardAccounts marks every card outstanding_debt', async () => {
    const store = createPostgresCardStore(
      fakePool([
        [
          {
            id: 'card-canon-1',
            household_id: H,
            name: 'Canonical Card',
            kind: 'credit_card',
            balance_cents: 9000,
            status: 'active',
            credit_limit_cents: 20000,
            closing_day: 10,
            due_day: 20,
          },
        ],
      ]),
    );

    const cards = await store.listCreditCardAccounts(H);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'card-canon-1', balanceCents: 9000 });
    expect(cards[0]!.balanceSemantics).toBe('outstanding_debt');
  });

  it('legacy listCreditCardAccounts marks every card legacy_calculated (even debt-like values)', async () => {
    const store = createLegacyPostgresCardStore(
      fakePool([
        [
          {
            id: 'card-legacy-1',
            household_id: H,
            name: 'Legacy Card',
            active: true,
            credit_limit_cents: 1200000,
            closing_day: 10,
            due_day: 20,
            // Legacy computed shape: purchases read back zero/NEGATIVE.
            // The value must NOT decide the layout — the discriminator does.
            balance_cents: -4180,
          },
        ],
      ]),
    );

    const cards = await store.listCreditCardAccounts(H);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'card-legacy-1', balanceCents: -4180 });
    expect(cards[0]!.balanceSemantics).toBe('legacy_calculated');
  });

  it('canonical createCard carries outstanding_debt without a new schema column', async () => {
    const store = createPostgresCardStore(
      fakePool([
        [
          {
            id: 'card-canon-new',
            household_id: H,
            name: 'Novo',
            kind: 'credit_card',
            balance_cents: 0,
            status: 'active',
            credit_limit_cents: 100000,
            closing_day: 10,
            due_day: 20,
          },
        ],
      ]),
    );

    const card = await store.createCard(H, {
      name: 'Novo',
      creditLimitCents: 100000,
      closingDay: 10,
      dueDay: 20,
    });

    expect(card.balanceSemantics).toBe('outstanding_debt');
  });

  it('legacy createCard carries legacy_calculated', async () => {
    const store = createLegacyPostgresCardStore(
      fakePool([
        [], // INSERT (no RETURNING rows consumed)
        [
          {
            id: 'card-legacy-new',
            household_id: H,
            name: 'Novo',
            active: true,
            credit_limit_cents: 100000,
            closing_day: 10,
            due_day: 20,
          },
        ],
      ]),
    );

    const card = await store.createCard(H, {
      name: 'Novo',
      creditLimitCents: 100000,
      closingDay: 10,
      dueDay: 20,
    });

    expect(card.balanceSemantics).toBe('legacy_calculated');
  });

  it('consumer parsing: known literals pass, missing/unknown stays fallback', () => {
    expect(parseBalanceSemantics('outstanding_debt')).toBe('outstanding_debt');
    expect(parseBalanceSemantics('legacy_calculated')).toBe('legacy_calculated');
    expect(parseBalanceSemantics(undefined)).toBe('unknown');
    expect(parseBalanceSemantics('canonical')).toBe('unknown');
    expect(parseBalanceSemantics(42)).toBe('unknown');
    expect(parseBalanceSemantics(null)).toBe('unknown');
  });

  it('card DTOs leak no raw persistence/schema detail', async () => {
    const canonical = createPostgresCardStore(
      fakePool([
        [
          {
            id: 'c1',
            household_id: H,
            name: 'C',
            kind: 'credit_card',
            balance_cents: 100,
            status: 'active',
            credit_limit_cents: 5000,
            closing_day: 1,
            due_day: 10,
          },
        ],
      ]),
    );
    const legacy = createLegacyPostgresCardStore(
      fakePool([
        [
          {
            id: 'l1',
            household_id: H,
            name: 'L',
            active: true,
            credit_limit_cents: 5000,
            closing_day: 1,
            due_day: 10,
            balance_cents: 0,
          },
        ],
      ]),
    );

    const [c] = await canonical.listCreditCardAccounts(H);
    const [l] = await legacy.listCreditCardAccounts(H);
    for (const dto of [c, l]) {
      for (const leaked of LEAK_KEYS) {
        expect(dto, `must not leak ${leaked}`).not.toHaveProperty(leaked);
      }
      expect(['outstanding_debt', 'legacy_calculated']).toContain(dto!.balanceSemantics);
    }
  });
});
