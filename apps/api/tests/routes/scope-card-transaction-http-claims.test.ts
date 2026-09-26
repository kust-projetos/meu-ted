/**
 * TASK scope-card-transaction-http-claims — HTTP claim scoping.
 *
 * Every lookupOrRecord in cards.ts / transactions-write.ts wraps the body in
 * `httpIdempotencyPayload` (v3 envelope: METHOD + route-template + resourceId
 * + origin). Cross-route / cross-origin reuse must 409, never replay.
 */
import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import {
  ACCOUNT_A1,
  CARD_A1,
  CATEGORY_FOOD_A,
} from '../fixtures/seed.js';
import {
  createInMemoryIdempotencyStore,
  httpIdempotencyPayload,
} from '../../src/writes/idempotency.js';

const seed = {
  accounts: [ACCOUNT_A1, CARD_A1],
  categories: [CATEGORY_FOOD_A],
  transactions: [],
};

const freshSeed = () => JSON.parse(JSON.stringify(seed)) as typeof seed;
const auth = (key?: string) => ({
  'x-device-token': TOKEN_A,
  'content-type': 'application/json',
  ...(key ? { 'idempotency-key': key } : {}),
});

describe('scope-card-transaction-http-claims', () => {
  it('cross-route same-key same-body → 409 with zero 2nd effect', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = `cross-${crypto.randomUUID()}`;
    const body = {
      accountId: ACCOUNT_A1.id,
      description: 'Cross route',
      amountCents: 1500,
      date: '2026-06-10',
      categoryId: CATEGORY_FOOD_A.id,
    };
    const first = await app.inject({
      method: 'POST', url: '/transactions/expense', headers: auth(key), payload: body,
    });
    expect(first.statusCode).toBe(201);
    const afterFirst = state.transactions.length;

    const second = await app.inject({
      method: 'POST', url: '/cards/purchases', headers: auth(key), payload: body,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('idempotency.conflict');
    expect(state.transactions.length).toBe(afterFirst);
  });

  it('same-route retry replays the same receipt with a single effect', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = `replay-${crypto.randomUUID()}`;
    const body = {
      accountId: CARD_A1.id,
      description: 'Mercado',
      amountCents: 150_00,
      date: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10),
      categoryId: CATEGORY_FOOD_A.id,
    };
    const first = await app.inject({
      method: 'POST', url: '/cards/purchases', headers: auth(key), payload: body,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST', url: '/cards/purchases', headers: auth(key), payload: body,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(state.transactions.filter((t) => t.description === 'Mercado')).toHaveLength(1);
  });

  it('same-route expense retry replays the same receipt', async () => {
    const { app } = buildTestApp(freshSeed());
    const key = `exp-${crypto.randomUUID()}`;
    const body = {
      accountId: ACCOUNT_A1.id,
      description: 'Lanche',
      amountCents: 1500,
      date: '2026-06-10',
      categoryId: CATEGORY_FOOD_A.id,
    };
    const first = await app.inject({
      method: 'POST', url: '/transactions/expense', headers: auth(key), payload: body,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST', url: '/transactions/expense', headers: auth(key), payload: body,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('old raw hash never replays as an enveloped claim → 409', async () => {
    const store = createInMemoryIdempotencyStore();
    const household = 'household-legacy';
    const key = `legacy-${crypto.randomUUID()}`;
    const raw = { amountCents: 100 };
    const first = await store.lookupOrRecord(household, key, raw, async () => ({ ok: true as const }));
    expect(first.replayed).toBe(false);
    await expect(
      store.lookupOrRecord(
        household,
        key,
        httpIdempotencyPayload({ route: 'POST /cards/purchases' }, raw),
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('origin mismatch cardId=X vs accountId=X (same value) → 409, no false replay', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = `origin-${crypto.randomUUID()}`;
    const common = {
      description: 'Origin clash',
      amountCents: 1500,
      date: '2026-06-10',
      categoryId: CATEGORY_FOOD_A.id,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: auth(key),
      payload: { ...common, cardId: CARD_A1.id },
    });
    expect(first.statusCode).toBe(201);
    const afterFirst = state.transactions.length;

    const second = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: auth(key),
      payload: { ...common, accountId: CARD_A1.id },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('idempotency.conflict');
    expect(state.transactions.length).toBe(afterFirst);
  });
});
