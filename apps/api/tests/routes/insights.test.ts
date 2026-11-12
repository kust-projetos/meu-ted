import { describe, it, expect } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_RENT_A,
  CATEGORY_FOOD_B,
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
  it('returns comparison and income-share insights with the competence basis', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({
      method: 'GET', url: '/insights/spending?yearMonth=2026-06&insightType=all',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true, yearMonth: '2026-06', basis: 'competencia', transactionCount: 4 });
    expect(body.insights).toHaveLength(2);
    expect(body.insights[0]).toMatchObject({
      type: 'comparison', basis: 'competencia', yearMonth: '2026-06', previousYearMonth: '2026-05',
      currentExpenseCents: expect.any(Number), previousExpenseCents: expect.any(Number), averageExpenseCents: expect.any(Number),
      deltaVsPreviousCents: expect.any(Number),
      deltaVsAverageCents: expect.any(Number),
    });
    expect(body.insights[1]).toMatchObject({
      type: 'income-share', basis: 'competencia', yearMonth: '2026-06',
      expenseCents: expect.any(Number), incomeCents: expect.any(Number), sharePercent: expect.any(Number),
    });
    expect(body.insights[0].deltaVsPreviousPercent === null || typeof body.insights[0].deltaVsPreviousPercent === 'number').toBe(true);
    expect(body.insights[0].deltaVsAveragePercent === null || typeof body.insights[0].deltaVsAveragePercent === 'number').toBe(true);
  });

  it('filters comparison and leaves anomalies empty', async () => {
    const { app } = buildTestApp(seed);
    for (const [type, expectedCount] of [['comparison', 1], ['anomalies', 0]] as const) {
      const res = await app.inject({
        method: 'GET', url: `/insights/spending?yearMonth=2026-06&insightType=${type}`,
        headers: { 'x-device-token': TOKEN_A },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().insights).toHaveLength(expectedCount);
    }
  });

  it('continues to reject an invalid lookbackMonths', async () => {
    const { app } = buildTestApp(seed);
    const res = await app.inject({
      method: 'GET', url: '/insights/spending?lookbackMonths=13',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(400);
  });
});
