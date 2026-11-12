import { describe, it, expect } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_RENT_A,
  CATEGORY_FOOD_B,
  CATEGORY_SALARY_A,
  TRANSACTIONS,
} from '../fixtures/seed.js';

const seed = {
  accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
  categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_FOOD_B],
  transactions: TRANSACTIONS,
};

describe('GET /insights/quick', () => {
  it('returns 200 with at most 5 insights', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({
      method: 'GET',
      url: '/insights/quick',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeLessThanOrEqual(5);
  });

  it('returns insights scoped to the household', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({
      method: 'GET',
      url: '/insights/quick',
      headers: { 'x-device-token': TOKEN_A },
    });
    for (const item of res.json().items) {
      expect(['info', 'warn', 'good']).toContain(item.severity);
      expect(typeof item.title).toBe('string');
      expect(typeof item.body).toBe('string');
    }
  });

  it('requires auth', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({ method: 'GET', url: '/insights/quick' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /insights/quick with unified authenticatedContext (session-first)', () => {
  it('resolves the household from the unified preHandler context without a device token', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerInsightRoutes } = await import('../../src/routes/insights.js');
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      (request as unknown as { authenticatedContext: { householdId: string } }).authenticatedContext = {
        householdId: 'household-session',
      };
    });
    registerInsightRoutes(app, {
      store: {
        listAccounts: async () => [],
        listCategories: async () => [],
        listAllTransactions: async () => [],
      },
      // Legacy fallback must NOT be reachable in this path.
      resolveToken: async () => {
        throw new Error('device resolver must not be called when authenticatedContext exists');
      },
    } as never);

    const res = await app.inject({ method: 'GET', url: '/insights/quick' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });
});

describe('GET /insights/spending with unified authenticatedContext (session-first)', () => {
  it('resolves the household from the unified preHandler context without a device token', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerInsightRoutes } = await import('../../src/routes/insights.js');
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      (request as unknown as { authenticatedContext: { householdId: string } }).authenticatedContext = {
        householdId: 'household-session',
      };
    });
    registerInsightRoutes(app, {
      store: {
        listAccounts: async () => [],
        listCategories: async () => [],
        listAllTransactions: async () => [],
      },
      // Legacy fallback must NOT be reachable in this path.
      resolveToken: async () => {
        throw new Error('device resolver must not be called when authenticatedContext exists');
      },
    } as never);

    const res = await app.inject({ method: 'GET', url: '/insights/spending' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.transactionCount).toBe(0);
  });
});

describe('GET /insights/spending', () => {
  const insightSeed = {
    ...seed,
    transactions: [
      { ...TRANSACTIONS[0], id: 'spending-test-1', date: '2026-05-05', amountCents: 10000 },
      { ...TRANSACTIONS[1], id: 'spending-test-2', date: '2026-05-06', amountCents: 20000 },
      { ...TRANSACTIONS[0], id: 'spending-test-3', date: '2026-06-10', amountCents: 30000, description: 'Large grocery purchase' },
      { ...TRANSACTIONS[1], id: 'spending-test-4', date: '2026-06-12', amountCents: 15000 },
      { ...TRANSACTIONS[2], id: 'spending-test-5', categoryId: CATEGORY_SALARY_A.id, date: '2026-06-01', amountCents: 100000 },
      TRANSACTIONS[4],
    ],
  };

  const getInsights = async (query = 'insightType=all', testSeed = insightSeed) => {
    const { app } = buildTestApp(testSeed);
    return app.inject({
      method: 'GET', url: `/insights/spending?yearMonth=2026-06&${query}`,
      headers: { 'x-device-token': TOKEN_A },
    });
  };

  it('returns all applicable insight types with basis and lookbackMonths', async () => {
    const res = await getInsights();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true, yearMonth: '2026-06', basis: 'competencia', lookbackMonths: 3, transactionCount: 5 });
    expect(typeof body.message).toBe('string');
    expect(body.insights.map((item: { type: string }) => item.type)).toEqual([
      'category-comparison', 'category-comparison', 'anomaly', 'income-share', 'income-share',
    ]);
    expect(body.insights[0]).toMatchObject({
      type: 'category-comparison', category: 'Mercado', currentCents: 30000,
      averageCents: 3333, deltaCents: 26667, deltaPercent: 800, trend: 'up',
    });
    expect(body.insights[2]).toMatchObject({ type: 'anomaly', category: 'Mercado', currentCents: 30000, averageTransactionCents: 10000 });
    expect(body.insights[3]).toMatchObject({ type: 'income-share', category: 'Mercado', expenseCents: 30000, incomeCents: 100000, sharePercent: 30 });
  });

  it('returns only category comparisons for comparison', async () => {
    const res = await getInsights('insightType=comparison');
    expect(res.statusCode).toBe(200);
    expect(res.json().insights.every((item: { type: string }) => item.type === 'category-comparison')).toBe(true);
    expect(res.json().insights).toHaveLength(2);
  });

  it('returns only anomalies for anomalies', async () => {
    const res = await getInsights('insightType=anomalies');
    expect(res.statusCode).toBe(200);
    expect(res.json().insights.map((item: { type: string }) => item.type)).toEqual(['anomaly']);
  });

  it('returns only income-share items for income-share', async () => {
    const res = await getInsights('insightType=income-share');
    expect(res.statusCode).toBe(200);
    expect(res.json().insights.map((item: { type: string }) => item.type)).toEqual(['income-share', 'income-share']);
  });

  it('continues to reject invalid yearMonth values', async () => {
    for (const yearMonth of ['2026-6', '2026-13', '2026-00']) {
      const { app } = buildTestApp(seed);
      const res = await app.inject({
        method: 'GET', url: `/insights/spending?yearMonth=${yearMonth}`,
        headers: { 'x-device-token': TOKEN_A },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('requires auth', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({ method: 'GET', url: '/insights/spending' });
    expect(res.statusCode).toBe(401);
  });

  it('continues to reject an invalid lookbackMonths', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({
      method: 'GET', url: '/insights/spending?lookbackMonths=13',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts lookbackMonths at both bounds and rejects zero', async () => {
    for (const lookbackMonths of [1, 12]) {
      expect((await getInsights(`lookbackMonths=${lookbackMonths}`)).statusCode).toBe(200);
    }
    expect((await getInsights('lookbackMonths=0')).statusCode).toBe(400);
  });

  it('returns no income-share items when the period has zero income', async () => {
    const noIncomeSeed = {
      ...insightSeed,
      transactions: insightSeed.transactions.filter((transaction) => transaction.kind !== 'income'),
    };
    const res = await getInsights('insightType=income-share', noIncomeSeed);
    expect(res.statusCode).toBe(200);
    expect(res.json().insights).toEqual([]);
  });

  it('excludes transactions from another household', async () => {
    const res = await getInsights();
    const body = res.json();
    const foodComparison = body.insights.find((item: { type: string; category: string }) =>
      item.type === 'category-comparison' && item.category === 'Mercado');
    expect(foodComparison.currentCents).toBe(30000);
    expect(body.transactionCount).toBe(5);
  });
});
