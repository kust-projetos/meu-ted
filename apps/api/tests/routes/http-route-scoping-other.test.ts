/**
 * Scope-other HTTP claims — cross-route isolation for accounts/categories (+envelope compat).
 *
 * - Two financial routes sharing the same key+payload conflict (409), never replay.
 * - Same-route retry replays with Idempotent-Replayed.
 * - A legacy raw claim never replays as an enveloped claim (conflict).
 */
import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import {
  createInMemoryIdempotencyStore,
  httpIdempotencyPayload,
} from '../../src/writes/idempotency.js';
import { ACCOUNT_A1, CATEGORY_FOOD_A } from '../fixtures/seed.js';

const auth = (key?: string) => ({
  'x-device-token': TOKEN_A,
  'content-type': 'application/json',
  ...(key ? { 'idempotency-key': key } : {}),
});

const seed = {
  accounts: [ACCOUNT_A1],
  categories: [CATEGORY_FOOD_A],
  transactions: [],
};

const freshSeed = () => JSON.parse(JSON.stringify(seed)) as typeof seed;

describe('scope-other HTTP claims — route isolation', () => {
  it('same key+payload across PATCH /accounts/:id and PATCH /categories/:id => 409', async () => {
    const { app } = buildTestApp(freshSeed());
    const key = `scope-other-${crypto.randomUUID()}`;
    const body = { name: 'Shared Rename' };

    const first = await app.inject({
      method: 'PATCH',
      url: `/accounts/${ACCOUNT_A1.id}`,
      headers: auth(key),
      payload: body,
    });
    expect(first.statusCode).toBe(200);

    const cross = await app.inject({
      method: 'PATCH',
      url: `/categories/${CATEGORY_FOOD_A.id}`,
      headers: auth(key),
      payload: body,
    });
    expect(cross.statusCode).toBe(409);
    expect(cross.json().code).toBe('idempotency.conflict');
  });

  it('same-route retry replays the original receipt', async () => {
    const { app } = buildTestApp(freshSeed());
    const key = `scope-other-replay-${crypto.randomUUID()}`;
    const body = {
      categoryId: CATEGORY_FOOD_A.id,
      name: 'Mercado mensal',
      amountCents: 50000,
      period: 'monthly',
      startDate: '2026-06-01',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/budgets',
      headers: auth(key),
      payload: body,
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: 'POST',
      url: '/budgets',
      headers: auth(key),
      payload: body,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
  });

  it('legacy raw claim never replays as an enveloped claim', async () => {
    const store = createInMemoryIdempotencyStore();
    const household = 'household-scope-other';
    const key = `raw-compat-${crypto.randomUUID()}`;
    const raw = { name: 'Raw Claim' };

    const first = await store.lookupOrRecord(household, key, raw, async () => ({ ok: true as const }));
    expect(first.replayed).toBe(false);

    await expect(
      store.lookupOrRecord(
        household,
        key,
        httpIdempotencyPayload({ route: 'PATCH /accounts/:id', resourceId: ACCOUNT_A1.id }, raw),
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });
});
