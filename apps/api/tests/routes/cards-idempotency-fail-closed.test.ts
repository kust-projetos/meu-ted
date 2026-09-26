/**
 * TASK card-route-idempotency (TDD RED):
 * Every financial card POST/PATCH/DELETE must fail closed without a valid
 * Idempotency-Key (400 + zero financial effect) and must replay once on
 * same-key retry (single effect + `Idempotent-Replayed: true`).
 *
 * Covers all 8 mutating card routes:
 * - POST /cards/purchases, POST /cards/installments, POST /cards/recurring,
 *   POST /cards/statements/:id/pay, DELETE /cards/purchases/:id (keyed today,
 *   handler falls back to direct fn() when the header is absent — legacy bypass)
 * - POST /cards, PATCH /cards/:id, PATCH /cards/purchases/:id (no key handling
 *   at all today: no atomic claim, no replay — same key executes N times)
 */
import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  CARD_A1,
  CATEGORY_FOOD_A,
} from '../fixtures/seed.js';

const seed = {
  accounts: [ACCOUNT_A1, ACCOUNT_A2, CARD_A1],
  categories: [CATEGORY_FOOD_A],
  transactions: [],
};

const freshSeed = () => JSON.parse(JSON.stringify(seed)) as typeof seed;
const noKey = { 'x-device-token': TOKEN_A, 'content-type': 'application/json' };
const withKey = (key: string) => ({ ...noKey, 'idempotency-key': key });

/** Future date keeps the attaching statement genuinely 'open' under the real clock. */
const openDate = () => new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

const purchasePayload = () => ({
  accountId: CARD_A1.id,
  description: 'Mercado',
  amountCents: 150_00,
  date: openDate(),
  categoryId: CATEGORY_FOOD_A.id,
});

const createPurchase = async (app: ReturnType<typeof buildTestApp>['app']) => {
  const res = await app.inject({
    method: 'POST',
    url: '/cards/purchases',
    headers: withKey(crypto.randomUUID()),
    payload: purchasePayload(),
  });
  expect(res.statusCode).toBe(201);
  return res.json().items[0].id as string;
};

const statementIdFor = async (app: ReturnType<typeof buildTestApp>['app']) => {
  const res = await app.inject({
    method: 'GET',
    url: `/cards/statements?accountId=${CARD_A1.id}`,
    headers: withKey(crypto.randomUUID()),
  });
  expect(res.statusCode).toBe(200);
  return res.json().items[0].id as string;
};

describe('card routes fail closed without Idempotency-Key', () => {
  it('POST /cards/purchases sem chave → 400 validation.required, zero efeito', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const before = state.transactions.length;
    const res = await app.inject({ method: 'POST', url: '/cards/purchases', headers: noKey, payload: purchasePayload() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    expect(state.transactions.length).toBe(before);
  });

  it('POST /cards/installments sem chave → 400, zero efeito', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const before = state.transactions.length;
    const res = await app.inject({
      method: 'POST',
      url: '/cards/installments',
      headers: noKey,
      payload: {
        accountId: CARD_A1.id,
        description: 'Notebook 3x',
        totalAmountCents: 3_000_00,
        purchaseDate: openDate(),
        installmentsTotal: 3,
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    expect(state.transactions.length).toBe(before);
  });

  it('POST /cards/recurring sem chave → 400, zero efeito', async () => {
    const { app } = buildTestApp(freshSeed());
    const before = (
      await app.inject({ method: 'GET', url: '/cards/recurring', headers: withKey(crypto.randomUUID()) })
    ).json().total as number;
    const res = await app.inject({
      method: 'POST',
      url: '/cards/recurring',
      headers: noKey,
      payload: {
        accountId: CARD_A1.id,
        description: 'Netflix',
        amountCents: 39_90,
        frequency: 'monthly',
        startDate: openDate(),
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    const after = (
      await app.inject({ method: 'GET', url: '/cards/recurring', headers: withKey(crypto.randomUUID()) })
    ).json().total as number;
    expect(after).toBe(before);
  });

  it('POST /cards/statements/:id/pay sem chave → 400, fatura intocada', async () => {
    const { app } = buildTestApp(freshSeed());
    const purchaseId = await createPurchase(app);
    expect(purchaseId).toBeTruthy();
    const stmtId = await statementIdFor(app);
    const paidBefore = (
      await app.inject({ method: 'GET', url: `/cards/statements/${stmtId}`, headers: withKey(crypto.randomUUID()) })
    ).json().paidCents as number;
    const res = await app.inject({
      method: 'POST',
      url: `/cards/statements/${stmtId}/pay`,
      headers: noKey,
      payload: { amountCents: 150_00, fromAccountId: ACCOUNT_A1.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    const paidAfter = (
      await app.inject({ method: 'GET', url: `/cards/statements/${stmtId}`, headers: withKey(crypto.randomUUID()) })
    ).json().paidCents as number;
    expect(paidAfter).toBe(paidBefore);
  });

  it('POST /cards sem chave → 400, nenhuma conta criada', async () => {
    const { app } = buildTestApp(freshSeed());
    const before = (
      await app.inject({ method: 'GET', url: '/cards/accounts', headers: withKey(crypto.randomUUID()) })
    ).json().total as number;
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: noKey,
      payload: { name: 'Novo Cartão', creditLimitCents: 10_000_00, closingDay: 10, dueDay: 20 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    const after = (
      await app.inject({ method: 'GET', url: '/cards/accounts', headers: withKey(crypto.randomUUID()) })
    ).json().total as number;
    expect(after).toBe(before);
  });

  it('PATCH /cards/:id sem chave → 400, cartão intocado', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const nameBefore = state.accounts.find((a) => a.id === CARD_A1.id)!.name;
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: noKey,
      payload: { name: 'Hack' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    expect(state.accounts.find((a) => a.id === CARD_A1.id)!.name).toBe(nameBefore);
  });

  it('PATCH /cards/purchases/:id sem chave → 400, compra intocada', async () => {
    const { app } = buildTestApp(freshSeed());
    const purchaseId = await createPurchase(app);
    const stmtId = await statementIdFor(app);
    const descBefore = (
      await app.inject({ method: 'GET', url: `/cards/statements/${stmtId}`, headers: withKey(crypto.randomUUID()) })
    ).json().purchases[0].description as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/purchases/${purchaseId}`,
      headers: noKey,
      payload: { description: 'Hack' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    const descAfter = (
      await app.inject({ method: 'GET', url: `/cards/statements/${stmtId}`, headers: withKey(crypto.randomUUID()) })
    ).json().purchases[0].description as string;
    expect(descAfter).toBe(descBefore);
  });

  it('DELETE /cards/purchases/:id sem chave → 400, compra preservada', async () => {
    const { app } = buildTestApp(freshSeed());
    const purchaseId = await createPurchase(app);
    const stmtId = await statementIdFor(app);
    const res = await app.inject({
      method: 'DELETE',
      url: `/cards/purchases/${purchaseId}`,
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
    const detail = await app.inject({
      method: 'GET',
      url: `/cards/statements/${stmtId}`,
      headers: withKey(crypto.randomUUID()),
    });
    expect(detail.json().purchases).toHaveLength(1);
  });

  it('chave em branco → 400 validation.invalid, zero efeito', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const before = state.transactions.length;
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...noKey, 'idempotency-key': '   ' },
      payload: purchasePayload(),
    });
    expect(res.statusCode).toBe(400);
    expect(state.transactions.length).toBe(before);
  });
});

describe('card routes replay once on same-key retry', () => {
  it('POST /cards com a mesma chave → 1 cartão, replay preservado', async () => {
    const { app } = buildTestApp(freshSeed());
    const key = `card-create-${crypto.randomUUID()}`;
    const payload = { name: 'Visa', creditLimitCents: 100_000, closingDay: 10, dueDay: 20 };
    const first = await app.inject({ method: 'POST', url: '/cards', headers: withKey(key), payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/cards', headers: withKey(key), payload });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    const list = await app.inject({ method: 'GET', url: '/cards/accounts', headers: withKey(crypto.randomUUID()) });
    expect(list.json().items.filter((a: { name: string }) => a.name === 'Visa')).toHaveLength(1);
  });

  it('PATCH /cards/:id com a mesma chave → replay preservado, efeito único', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = `card-patch-${crypto.randomUUID()}`;
    const payload = { name: 'Renomeado' };
    const first = await app.inject({ method: 'PATCH', url: `/cards/${CARD_A1.id}`, headers: withKey(key), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'PATCH', url: `/cards/${CARD_A1.id}`, headers: withKey(key), payload });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(state.accounts.find((a) => a.id === CARD_A1.id)!.name).toBe('Renomeado');
  });

  it('PATCH /cards/purchases/:id com a mesma chave → replay preservado', async () => {
    const { app } = buildTestApp(freshSeed());
    const purchaseId = await createPurchase(app);
    const key = `purchase-patch-${crypto.randomUUID()}`;
    const payload = { description: 'Feira' };
    const first = await app.inject({ method: 'PATCH', url: `/cards/purchases/${purchaseId}`, headers: withKey(key), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'PATCH', url: `/cards/purchases/${purchaseId}`, headers: withKey(key), payload });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('controle: POST /cards/purchases com a mesma chave → 1 efeito (preservado)', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = `card-buy-${crypto.randomUUID()}`;
    const payload = purchasePayload();
    const first = await app.inject({ method: 'POST', url: '/cards/purchases', headers: withKey(key), payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/cards/purchases', headers: withKey(key), payload });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(state.transactions.filter((t) => t.description === 'Mercado')).toHaveLength(1);
  });
});
