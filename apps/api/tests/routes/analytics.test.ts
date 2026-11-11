import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';

const H = { 'x-device-token': TOKEN_A, 'content-type': 'application/json' };
const _HB = { 'x-device-token': TOKEN_B, 'content-type': 'application/json' };
const CLOCK = () => new Date('2026-09-07T12:00:00.000Z');

/**
 * Deterministic fixture: bank account with balance, 6 expense macros +
 * income, September income/expense, one subscription, one budget and one
 * credit-card statement due 2026-09-10 (within 3 days of the clock).
 */
const seedAnalytics = async (app: ReturnType<typeof buildTestApp>['app']) => {
  const post = (url: string, payload: unknown, headers = { ...H, 'idempotency-key': crypto.randomUUID() }) =>
    app.inject({ method: 'POST', url, headers, payload });
  const account = await post('/accounts', { name: 'Nubank', kind: 'bank', initialBalanceCents: 100_000 });
  expect(account.statusCode).toBe(201);
  const accountId = account.json().id as string;

  const macroIds: string[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const macro = await post('/categories', { name: `Macro ${i}`, kind: 'expense' });
    expect(macro.statusCode).toBe(201);
    macroIds.push(macro.json().id as string);
  }
  const salary = await post('/categories', { name: 'Renda Extra', kind: 'income' });
  expect(salary.statusCode).toBe(201);
  const salaryId = salary.json().id as string;

  const expense = (description: string, amountCents: number, date: string, categoryId: string) =>
    post('/transactions/expense', { description, amountCents, date, accountId, categoryId });
  // September: income 20k, expenses spread across 6 macros + concentrated days.
  await post('/transactions/income', {
    description: 'Salário',
    amountCents: 200_000,
    date: '2026-09-02',
    accountId,
    categoryId: salaryId,
  });
  const expenseDates = ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-06', '2026-09-06', '2026-09-07'];
  for (let i = 0; i < 6; i += 1) {
    const res = await expense(`Gasto ${i + 1}`, 10_000 * (i + 1), expenseDates[i]!, macroIds[i]!);
    expect(res.statusCode).toBe(201);
  }
  // August baseline for previous-period deltas.
  await post('/transactions/income', {
    description: 'Salário ago',
    amountCents: 100_000,
    date: '2026-08-05',
    accountId,
    categoryId: salaryId,
  });
  const augExpense = await expense('Aluguel ago', 50_000, '2026-08-05', macroIds[0]!);
  expect(augExpense.statusCode).toBe(201);

  const subscription = await post('/subscriptions', {
    name: 'Streaming',
    amountCents: 5_000,
    cycle: 'monthly',
    day: 10,
    paymentMethod: 'card',
  });
  expect(subscription.statusCode).toBe(201);

  const budget = await post('/budgets', {
    categoryId: macroIds[0],
    name: 'Teto Macro 1',
    amountCents: 15_000,
    period: 'monthly',
    startDate: '2026-09-01',
  });
  expect(budget.statusCode).toBe(201);

  const card = await post('/cards', { name: 'Nubank Card', creditLimitCents: 100_000, closingDay: 5, dueDay: 10 });
  expect(card.statusCode).toBe(201);
  const cardId = card.json().id as string;
  const purchase = await post('/cards/purchases', {
    accountId: cardId,
    description: 'Notebook',
    amountCents: 30_000,
    date: '2026-08-20',
    categoryId: macroIds[1],
  });
  expect(purchase.statusCode).toBe(201);
  return { accountId, macroIds, salaryId, cardId };
};

describe('GET /analytics/kpis', () => {
  it('sums a complete custom calendar year without including adjacent dates', async () => {
    const { app } = buildTestApp({}, CLOCK);
    const post = (url: string, payload: unknown) => app.inject({
      method: 'POST', url, headers: { ...H, 'idempotency-key': crypto.randomUUID() }, payload,
    });
    const account = await post('/accounts', { name: 'Anual', kind: 'bank', initialBalanceCents: 100_000 });
    expect(account.statusCode).toBe(201);
    const category = await post('/categories', { name: 'Anual', kind: 'expense' });
    expect(category.statusCode).toBe(201);
    for (const [date, amountCents] of [['2019-12-31', 100], ['2020-01-01', 200], ['2020-12-31', 300], ['2021-01-01', 400]] as const) {
      const response = await post('/transactions/expense', {
        description: 'Teste anual', amountCents, date, accountId: account.json().id, categoryId: category.json().id,
      });
      expect(response.statusCode).toBe(201);
    }
    const response = await app.inject({
      method: 'GET', url: '/analytics/kpis?period=custom&from=2020-01-01&to=2020-12-31', headers: H,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      expenseCents: 500,
      effectiveFilter: { period: 'custom', from: '2020-01-01', to: '2020-12-31' },
      basis: 'liquidez',
    });
  });
  it('computes net liquid, invoices, savings rate and fixed share with isolation', async () => {
    const { app } = buildTestApp({}, CLOCK);
    await seedAnalytics(app);
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/kpis?period=custom&from=2026-09-01&to=2026-09-30',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Statement due 2026-09-10 is within 3 days of the 2026-09-07 clock.
    expect(body.dueSoonCents).toBe(30_000);
    expect(body.accountsTotalCents).toBeGreaterThanOrEqual(100_000);
    expect(body.netLiquidBalanceCents).toBe(body.accountsTotalCents - 30_000);
    expect(body.openInvoices.committedCents).toBe(30_000);
    expect(body.openInvoices.limitCents).toBe(100_000);
    expect(body.openInvoices.utilizationPct).toBe(30);
    // September: income 200k, expenses 10k+20k+30k+40k+50k+60k = 210k.
    expect(body.incomeCents).toBe(200_000);
    expect(body.expenseCents).toBe(210_000);
    expect(body.savingsRatePct).toBe(-5);
    expect(body.savingsRateTargetPct).toBe(20);
    // Fixed = 5k subscription; income 200k → 2.5% engessada.
    expect(body.fixedVsDiscretionary.fixedCents).toBe(5_000);
    expect(body.fixedVsDiscretionary.fixedPctOfIncome).toBe(2.5);
    expect(body.netWorthCents).toBe(body.accountsTotalCents - 30_000);

    const other = await app.inject({
      method: 'GET',
      url: '/analytics/kpis?period=custom&from=2026-09-01&to=2026-09-30',
      headers: { 'x-device-token': TOKEN_B, 'idempotency-key': crypto.randomUUID() },
    });
    expect(other.json().incomeCents).toBe(0);
    expect(other.json().expenseCents).toBe(0);
    expect(other.json().netLiquidBalanceCents).toBe(0);
  });

  it('requires auth and validates the query', async () => {
    const { app } = buildTestApp({}, CLOCK);
    expect((await app.inject({ method: 'GET', url: '/analytics/kpis' })).statusCode).toBe(401);
    const badPeriod = await app.inject({
      method: 'GET',
      url: '/analytics/kpis?period=never',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(badPeriod.statusCode).toBe(400);
    const badCustom = await app.inject({
      method: 'GET',
      url: '/analytics/kpis?period=custom&from=2026-09-01',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(badCustom.statusCode).toBe(400);
  });
});

describe('GET /analytics/cashflow-series', () => {
  it('returns cumulative current + previous lines', async () => {
    const { app } = buildTestApp({}, CLOCK);
    await seedAnalytics(app);
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/cashflow-series?period=custom&from=2026-09-01&to=2026-09-07',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toHaveLength(7);
    expect(body.previous).toHaveLength(7);
    // Cumulative: 09-01 (-10k), 09-02 (+200k-10k=190k).
    expect(body.current[0]).toMatchObject({ date: '2026-09-01', valueCents: -10_000 });
    expect(body.current[1]).toMatchObject({ date: '2026-09-02', valueCents: 190_000 });
    for (let i = 1; i < body.current.length; i += 1) {
      expect(body.current[i].date > body.current[i - 1].date).toBe(true);
    }
  });
});

describe('GET /analytics/category-breakdown', () => {
  it('caps at 5 slices plus gray Outras rolling subs up', async () => {
    const { app } = buildTestApp({}, CLOCK);
    const { macroIds } = await seedAnalytics(app);
    const sub = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { ...H, 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Aluguel Loja', kind: 'expense', parentId: macroIds[0] },
    });
    expect(sub.statusCode).toBe(201);
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/category-breakdown?period=custom&from=2026-09-01&to=2026-09-30',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('expense');
    expect(body.totalCents).toBe(210_000);
    expect(body.slices.length).toBeLessThanOrEqual(6);
    const outras = body.slices.find((s: { name: string }) => s.name === 'Outras');
    expect(outras).toBeDefined();
    expect(outras.color).toBe('#9AA5A0');
    expect(body.slices.some((s: { categoryId: string }) => s.categoryId === sub.json().id)).toBe(false);
  });
});

describe('GET /analytics/budget-consumption', () => {
  it('flags budgets over 100% as overBudget', async () => {
    const { app } = buildTestApp({}, CLOCK);
    const { macroIds } = await seedAnalytics(app);
    // Macro 1 already spent 10k in September against a 15k budget; add 10k more.
    const extra = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { ...H, 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Extra',
        amountCents: 10_000,
        date: '2026-09-06',
        accountId: (await app.inject({ method: 'GET', url: '/accounts', headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } })).json().items[0].id,
        categoryId: macroIds[0],
      },
    });
    expect(extra.statusCode).toBe(201);
    const res = await app.inject({ method: 'GET', url: '/analytics/budget-consumption', headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((b: { name: string }) => b.name === 'Teto Macro 1');
    expect(item).toMatchObject({ spentCents: 20_000, amountCents: 15_000, overBudget: true });
    expect(item.pctUsed).toBeGreaterThan(100);
  });
});

describe('GET /analytics/daily-heatmap', () => {
  it('returns a 7x4 grid scaled to the busiest day', async () => {
    const { app } = buildTestApp({}, CLOCK);
    await seedAnalytics(app);
    const res = await app.inject({ method: 'GET', url: '/analytics/daily-heatmap', headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.endDate).toBe('2026-09-07');
    expect(body.weeks).toHaveLength(4);
    for (const week of body.weeks) expect(week.days).toHaveLength(7);
    const flat = body.weeks.flatMap((w: { days: { date: string; level: number }[] }) => w.days);
    // Busiest day is 2026-09-06 (40k + 50k); 2026-09-07 (60k) scales to level 3.
    expect(flat.find((d: { date: string }) => d.date === '2026-09-06')!.level).toBe(4);
    expect(flat.find((d: { date: string }) => d.date === '2026-09-07')!.level).toBe(3);
    expect(flat.find((d: { date: string }) => d.date === '2026-09-04')!.level).toBe(0);
  });
});

describe('GET /analytics/net-worth-history', () => {
  it('returns 12 ascending months ending at the current net worth', async () => {
    const { app } = buildTestApp({}, CLOCK);
    await seedAnalytics(app);
    const res = await app.inject({ method: 'GET', url: '/analytics/net-worth-history', headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    expect(res.statusCode).toBe(200);
    const months = res.json().months;
    expect(months).toHaveLength(12);
    expect(months[11]).toMatchObject({ month: '2026-09' });
    expect(months[0]).toMatchObject({ month: '2025-10' });
    const kpis = await app.inject({
      method: 'GET',
      url: '/analytics/kpis?period=custom&from=2026-09-01&to=2026-09-30',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(months[11]!.netWorthCents).toBe(kpis.json().netWorthCents);
  });
});
