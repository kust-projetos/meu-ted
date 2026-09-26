/**
 * TASK_ID card-money-json-boundary: API card mapAccount must require safe
 * integers for every money-cent column it emits (balance_cents,
 * credit_limit_cents) and throw instead of rounding past 2^53-1.
 *
 * No live PostgreSQL: fake pools return canned rows (pg BIGINT may arrive
 * as string/bigint/number); the mapper must accept 2^53-1 exactly and
 * fail closed at 2^53 in every representation.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresCardStore } from '../../src/cards/postgres.js';

const H = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

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

const cardRow = (over: Partial<Row> = {}): Row => ({
  id: 'card-boundary-1',
  household_id: H,
  name: 'Boundary Card',
  kind: 'credit_card',
  balance_cents: 0,
  status: 'active',
  credit_limit_cents: 100000,
  closing_day: 10,
  due_day: 20,
  ...over,
});

describe('card mapAccount JSON boundary (2^53±1)', () => {
  it('accepts 2^53-1 exactly in every pg representation', async () => {
    for (const safe of ['9007199254740991', 9007199254740991n, 9007199254740991]) {
      const store = createPostgresCardStore(fakePool([[cardRow({ balance_cents: safe, credit_limit_cents: safe })]]));
      const cards = await store.listCreditCardAccounts(H);
      expect(cards[0]).toMatchObject({ balanceCents: 9007199254740991, creditLimitCents: 9007199254740991 });
    }
  });

  it('throws instead of rounding balance_cents at 2^53', async () => {
    for (const unsafe of ['9007199254740992', 9007199254740992n, 9007199254740993, '9007199254740993', 9007199254740992.5]) {
      const store = createPostgresCardStore(fakePool([[cardRow({ balance_cents: unsafe as unknown as number })]]));
      await expect(store.listCreditCardAccounts(H)).rejects.toThrow(/intervalo suportado/i);
    }
  });

  it('throws instead of rounding credit_limit_cents at 2^53', async () => {
    const store = createPostgresCardStore(
      fakePool([[cardRow({ balance_cents: 100, credit_limit_cents: '9007199254740992' })]]),
    );
    await expect(store.listCreditCardAccounts(H)).rejects.toThrow(/intervalo suportado/i);
  });
});
