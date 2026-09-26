/**
 * TASK card-atomic-three (TDD):
 * POST /cards, PATCH /cards/:id and PATCH /cards/purchases/:id run their
 * effect inside the idempotency claim (atomic claim + effect + completion):
 * - same key + same payload → single effect, exact replay;
 * - same key + different payload → 409 idempotency.conflict, first effect kept;
 * - the PATCH purchase response reflects the edit (detail read).
 */
import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import { ACCOUNT_A1, CARD_A1, CATEGORY_FOOD_A } from '../fixtures/seed.js';

const seed = {
  accounts: [ACCOUNT_A1, CARD_A1],
  categories: [CATEGORY_FOOD_A],
  transactions: [],
};

const freshSeed = () => JSON.parse(JSON.stringify(seed)) as typeof seed;
const noKey = { 'x-device-token': TOKEN_A, 'content-type': 'application/json' };
const withKey = (key: string) => ({ ...noKey, 'idempotency-key': key });

/** Future date keeps the attaching statement genuinely 'open' under the real clock. */
const openDate = () => new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

describe('card-atomic-three routes: atomic claim + replay + conflict', () => {
  it('POST /cards mesma chave + payload divergente → 409, 1 cartão (primeiro preservado)', async () => {
    const { app } = buildTestApp(freshSeed());
    const key = `card-create-${crypto.randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: withKey(key),
      payload: { name: 'Visa', creditLimitCents: 100_000, closingDay: 10, dueDay: 20 },
    });
    expect(first.statusCode).toBe(201);
    const conflict = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: withKey(key),
      payload: { name: 'Master', creditLimitCents: 100_000, closingDay: 10, dueDay: 20 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency.conflict');
    const list = await app.inject({ method: 'GET', url: '/cards/accounts', headers: withKey(crypto.randomUUID()) });
    expect(list.json().items.filter((a: { name: string }) => a.name === 'Visa')).toHaveLength(1);
    expect(list.json().items.filter((a: { name: string }) => a.name === 'Master')).toHaveLength(0);
  });

  it('PATCH /cards/:id mesma chave + payload divergente → 409, primeiro efeito preservado', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = `card-patch-${crypto.randomUUID()}`;
    const first = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: withKey(key),
      payload: { name: 'Renomeado' },
    });
    expect(first.statusCode).toBe(200);
    const conflict = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: withKey(key),
      payload: { name: 'Outro' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency.conflict');
    expect(state.accounts.find((a) => a.id === CARD_A1.id)!.name).toBe('Renomeado');
  });

  it('PATCH /cards/purchases/:id mesma chave + payload divergente → 409, resposta reflete a edição', async () => {
    const { app } = buildTestApp(freshSeed());
    const created = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: withKey(crypto.randomUUID()),
      payload: {
        accountId: CARD_A1.id,
        description: 'Mercado',
        amountCents: 150_00,
        date: openDate(),
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const purchaseId = created.json().items[0].id as string;

    const key = `purchase-patch-${crypto.randomUUID()}`;
    const first = await app.inject({
      method: 'PATCH',
      url: `/cards/purchases/${purchaseId}`,
      headers: withKey(key),
      payload: { description: 'Feira' },
    });
    expect(first.statusCode).toBe(200);
    // The returned detail reflects the edit (same-client read semantics).
    expect(first.json().purchases.map((p: { description: string }) => p.description)).toContain('Feira');

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/cards/purchases/${purchaseId}`,
      headers: withKey(key),
      payload: { description: 'Hack' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency.conflict');

    const replay = await app.inject({
      method: 'PATCH',
      url: `/cards/purchases/${purchaseId}`,
      headers: withKey(key),
      payload: { description: 'Feira' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
  });
});
