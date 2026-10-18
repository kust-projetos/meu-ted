import { describe, it, expect } from 'vitest';
import { buildTestApp, TOKEN_A, } from '../test-app.js';
import { ACCOUNT_A1, CATEGORY_FOOD_A, CATEGORY_RENT_A } from '../fixtures/seed.js';

const seed = { accounts: [ACCOUNT_A1], categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A], transactions: [] };
function auth(t: string) { return { 'x-device-token': t, 'idempotency-key': crypto.randomUUID() }; }

describe('GET /budgets', () => {
  it('returns empty when no budgets', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const res = await app.inject({ method: 'GET', url: '/budgets', headers: auth(TOKEN_A) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });
  it('requires auth', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const res = await app.inject({ method: 'GET', url: '/budgets' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /budgets', () => {
  it('creates a budget and returns 201', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const res = await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Mercado');
    expect(res.json().amountCents).toBe(1_000_00);
  });
  it('appears in list with computed status', async () => {
    const { app, state } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01' },
    });
    // Add an expense to compute spent
    state.transactions.push({ id: 'tx1', householdId: seed.accounts[0]!.householdId ?? 'h1', kind: 'expense', description: 'Feira', amountCents: 500_00, date: '2026-06-15', accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id });
    const list = await app.inject({ method: 'GET', url: '/budgets', headers: auth(TOKEN_A) });
    expect(list.json().items[0].spentCents).toBe(500_00);
    expect(list.json().items[0].percentUsed).toBe(50);
  });
  it('validates required fields', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const res = await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /budgets/:id', () => {
  it('updates budget amount', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const create = await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01' },
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'PATCH', url: `/budgets/${id}`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { amountCents: 2_000_00 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amountCents).toBe(2_000_00);
  });
  it('returns 404 for non-existent', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const res = await app.inject({
      method: 'PATCH', url: '/budgets/00000000-0000-0000-0000-000000000000',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { amountCents: 100_00 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /budgets/check', () => {
  it('returns budgets above alert threshold', async () => {
    const { app, state } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01', alertThreshold: 50 },
    });
    state.transactions.push({ id: 'tx1', householdId: seed.accounts[0]!.householdId ?? 'h1', kind: 'expense', description: 'Feira', amountCents: 600_00, date: '2026-06-15', accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id });
    const res = await app.inject({ method: 'GET', url: '/budgets/check', headers: auth(TOKEN_A) });
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /budgets/check (API-06 functional)', () => {
  it('returns total equal to the filtered items length', async () => {
    const { app, state } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01', alertThreshold: 50 },
    });
    state.transactions.push({ id: 'tx1', householdId: seed.accounts[0]!.householdId ?? 'h1', kind: 'expense', description: 'Feira', amountCents: 600_00, date: '2026-06-15', accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id });
    const res = await app.inject({ method: 'GET', url: '/budgets/check', headers: auth(TOKEN_A) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBe(body.items.length);
  });

  it('returns total 0 with empty items', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const res = await app.inject({ method: 'GET', url: '/budgets/check', headers: auth(TOKEN_A) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    expect(res.json().total).toBe(0);
  });
});

describe('GET /budgets/:id/trends query validation (API-06)', () => {
  const createBudget = async (app: ReturnType<typeof buildTestApp>['app']) => {
    const create = await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01' },
    });
    return create.json().id as string;
  };

  it.each(['abc', '0', '13', '1.5', ''])('returns 400 with validation code for monthsBack=%s', async (monthsBack) => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const id = await createBudget(app);
    const res = await app.inject({ method: 'GET', url: `/budgets/${id}/trends?monthsBack=${monthsBack}`, headers: auth(TOKEN_A) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.error');
  });

  it('defaults to 3 months when monthsBack is absent', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const id = await createBudget(app);
    const res = await app.inject({ method: 'GET', url: `/budgets/${id}/trends`, headers: auth(TOKEN_A) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(3);
  });
});

describe('GET /budgets/:id/trends', () => {
  it('returns N months of trend data', async () => {
    const { app } = buildTestApp(seed, () => new Date('2026-06-15T12:00:00Z'));
    const create = await app.inject({
      method: 'POST', url: '/budgets',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { categoryId: CATEGORY_FOOD_A.id, name: 'Mercado', amountCents: 1_000_00, period: 'monthly', startDate: '2026-06-01' },
    });
    const id = create.json().id;
    const res = await app.inject({ method: 'GET', url: `/budgets/${id}/trends?monthsBack=3`, headers: auth(TOKEN_A) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(3);
    for (const t of res.json().items) {
      expect(t.yearMonth).toBeTruthy();
      expect(typeof t.budgetCents).toBe('number');
      expect(typeof t.spentCents).toBe('number');
    }
  });
});
