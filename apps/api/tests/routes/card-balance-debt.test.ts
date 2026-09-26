/**
 * Canonical card write debt (slice 1): credit_card.balance_cents is
 * outstanding debt, nonnegative (ADR-018).
 *
 * - New card initialBalance = 0.
 * - Purchase / each installment adds exact amount once.
 * - Payment subtracts exact amount from card (payer debited separately).
 * - PATCH purchase amount applies delta; cancel subtracts once.
 * - Negative attempt fails closed, no clamp; scoped writes only.
 */
import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  CARD_A1,
  CATEGORY_FOOD_A,
  HOUSEHOLD_A,
} from '../fixtures/seed.js';

const seed = {
  accounts: [ACCOUNT_A1, ACCOUNT_A2, CARD_A1],
  categories: [CATEGORY_FOOD_A],
  transactions: [],
};

function freshSeed() {
  return JSON.parse(JSON.stringify(seed)) as typeof seed;
}

function auth(token: string) {
  return {
    'x-device-token': token,
    'idempotency-key': crypto.randomUUID(),
    'Content-Type': 'application/json',
  };
}

/** Headers for bodyless requests (DELETE): no Content-Type so the JSON parser is skipped. */
function authNoBody(token: string) {
  return {
    'x-device-token': token,
    'idempotency-key': crypto.randomUUID(),
  };
}

function cardBalance(state: { accounts: { id: string; balanceCents: number }[] }, id: string): number {
  return state.accounts.find((a) => a.id === id)!.balanceCents;
}

describe('canonical card debt balance', () => {
  it('new card starts at zero debt', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: auth(TOKEN_A),
      payload: { name: 'Novo', creditLimitCents: 1_000_00, closingDay: 10, dueDay: 20 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().balanceCents).toBe(0);
  });

  it('purchase adds exact amount once and leaves other accounts untouched', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const beforeCard = cardBalance(state, CARD_A1.id);
    const beforeBank = cardBalance(state, ACCOUNT_A1.id);
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra',
        amountCents: 150_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(cardBalance(state, CARD_A1.id)).toBe(beforeCard + 150_00);
    expect(cardBalance(state, ACCOUNT_A1.id)).toBe(beforeBank);
  });

  it('installments add the exact total once across parcels', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/installments',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Parcelado',
        totalAmountCents: 1_000_00,
        purchaseDate: '2026-06-10',
        installmentsTotal: 4,
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const items = res.json().items as { amountCents: number }[];
    expect(items).toHaveLength(4);
    const parcelSum = items.reduce((s, t) => s + t.amountCents, 0);
    expect(parcelSum).toBe(1_000_00);
    expect(cardBalance(state, CARD_A1.id)).toBe(1_000_00);
  });

  it('partial then full payment subtracts card and payer separately', async () => {
    const { app, state } = buildTestApp(freshSeed());
    await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra',
        amountCents: 500_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const stmtId = (
      await app.inject({ method: 'GET', url: `/cards/statements?accountId=${CARD_A1.id}`, headers: { 'x-device-token': TOKEN_A } })
    ).json().items[0].id as string;
    const payerBefore = cardBalance(state, ACCOUNT_A1.id);

    const p1 = await app.inject({
      method: 'POST',
      url: `/cards/statements/${stmtId}/pay`,
      headers: auth(TOKEN_A),
      payload: { amountCents: 200_00, fromAccountId: ACCOUNT_A1.id },
    });
    expect(p1.statusCode).toBe(200);
    // Card debt: 500 - 200 = 300; payer debited 200 separately.
    expect(cardBalance(state, CARD_A1.id)).toBe(300_00);
    expect(cardBalance(state, ACCOUNT_A1.id)).toBe(payerBefore - 200_00);

    const p2 = await app.inject({
      method: 'POST',
      url: `/cards/statements/${stmtId}/pay`,
      headers: auth(TOKEN_A),
      payload: { amountCents: 300_00, fromAccountId: ACCOUNT_A1.id },
    });
    expect(p2.statusCode).toBe(200);
    expect(cardBalance(state, CARD_A1.id)).toBe(0);
    expect(cardBalance(state, ACCOUNT_A1.id)).toBe(payerBefore - 500_00);
  });

  it('concurrent same-key replay applies the purchase exactly once', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const key = 'debt-dedup-key-001';
    const payload = {
      accountId: CARD_A1.id,
      description: 'Replay',
      amountCents: 50_00,
      date: '2026-06-10',
      categoryId: CATEGORY_FOOD_A.id,
    };
    const headers = { 'x-device-token': TOKEN_A, 'Content-Type': 'application/json', 'idempotency-key': key };
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/cards/purchases', headers, payload }),
      app.inject({ method: 'POST', url: '/cards/purchases', headers, payload }),
    ]);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(cardBalance(state, CARD_A1.id)).toBe(50_00);
  });

  it('concurrent distinct purchases in one cycle converge on one statement with summed debt', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const mk = (description: string) => ({
      method: 'POST' as const,
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description,
        amountCents: 100_00,
        date: '2026-08-20',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const [r1, r2] = await Promise.all([app.inject(mk('A')), app.inject(mk('B'))]);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(cardBalance(state, CARD_A1.id)).toBe(200_00);
    const stmts = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(stmts.json().items).toHaveLength(1);
  });

  it('PATCH purchase amount applies the delta to card debt', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 35);
    const date = d.toISOString().slice(0, 10);
    const create = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra',
        amountCents: 100_00,
        date,
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const purchaseId = create.json().items[0].id as string;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/cards/purchases/${purchaseId}`,
      headers: auth(TOKEN_A),
      payload: { amountCents: 150_00 },
    });
    expect(patch.statusCode).toBe(200);
    // Debt: 100 + delta(50) = 150.
    expect(cardBalance(state, CARD_A1.id)).toBe(150_00);
  });

  it('cancel subtracts once and is idempotent without double subtract', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 35);
    const date = d.toISOString().slice(0, 10);
    const create = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Cancelar',
        amountCents: 123_45,
        date,
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const purchaseId = create.json().items[0].id as string;
    expect(cardBalance(state, CARD_A1.id)).toBe(123_45);
    const first = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: authNoBody(TOKEN_A) });
    expect(first.statusCode).toBe(200);
    expect(cardBalance(state, CARD_A1.id)).toBe(0);
    const second = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: authNoBody(TOKEN_A) });
    expect(second.statusCode).toBe(200);
    expect(cardBalance(state, CARD_A1.id)).toBe(0);
  });

  it('overpay attempt fails closed with card debt unchanged (no clamp)', async () => {
    const { app, state } = buildTestApp(freshSeed());
    await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra',
        amountCents: 200_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const stmtId = (
      await app.inject({ method: 'GET', url: `/cards/statements?accountId=${CARD_A1.id}`, headers: { 'x-device-token': TOKEN_A } })
    ).json().items[0].id as string;
    const beforeCard = cardBalance(state, CARD_A1.id);
    const beforePayer = cardBalance(state, ACCOUNT_A1.id);
    const res = await app.inject({
      method: 'POST',
      url: `/cards/statements/${stmtId}/pay`,
      headers: auth(TOKEN_A),
      payload: { amountCents: 999_00, fromAccountId: ACCOUNT_A1.id },
    });
    expect(res.statusCode).toBe(400);
    expect(cardBalance(state, CARD_A1.id)).toBe(beforeCard);
    expect(cardBalance(state, ACCOUNT_A1.id)).toBe(beforePayer);
  });

  it('failed purchase rolls back with no card write', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Invalida',
        amountCents: 100_00,
        date: '2026-06-10',
        categoryId: '22222222-2222-4222-8222-222222222224', // household B category
      },
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(cardBalance(state, CARD_A1.id)).toBe(0);
  });

  it('cross-household cancel is 404 with no balance change', async () => {
    const { app, state } = buildTestApp(freshSeed());
    const create = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: auth(TOKEN_A),
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra A',
        amountCents: 50_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const purchaseId = create.json().items[0].id as string;
    void HOUSEHOLD_A;
    const res = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: authNoBody(TOKEN_B) });
    expect(res.statusCode).toBe(404);
    expect(cardBalance(state, CARD_A1.id)).toBe(50_00);
  });
});
