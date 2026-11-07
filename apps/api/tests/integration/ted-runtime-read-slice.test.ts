/**
 * TED runtime read slice against the ACTUAL API handlers over loopback HTTP.
 *
 * Test-only bridge (no production source altered, no existing helper
 * touched): boots the in-memory API composition (`buildTestApp` + seed
 * fixtures — synthetic TOKEN_A/TOKEN_B, households A/B, June-2026 ledger),
 * listens on 127.0.0.1, and drives it through the runtime's REAL
 * `HttpFinanceTransport` + tool executors (`apps/ted-runtime/src/*`).
 * No database, no Docker, no production origin: Fastify in-memory stores
 * only, loopback only.
 *
 * Oracles are the same as `tests/routes/month-summary.test.ts`:
 *   A 2026-06 → {incomeCents:1200000, expenseCents:288050,
 *                 balanceCents:911950, transactionCount:4}
 *   B 2026-06 → {incomeCents:0, expenseCents:20000, transactionCount:1}
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { HttpFinanceTransport } from '../../../ted-runtime/src/transport.mjs';
import { createToolExecutors } from '../../../ted-runtime/src/tool-defs.mjs';
import { buildTestApp, TOKEN_A, TOKEN_B, type TestApp } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_FOOD_B,
  CATEGORY_RENT_A,
  CATEGORY_SALARY_A,
  HOUSEHOLD_A,
  HOUSEHOLD_B,
  TRANSACTIONS,
} from '../fixtures/seed.js';

const hostA = Object.freeze({
  label: 'test-a',
  token: TOKEN_A,
  household: HOUSEHOLD_A,
  actorId: 'test-actor-a',
  deviceId: 'dev-device-1',
});

const hostB = Object.freeze({
  label: 'test-b',
  token: TOKEN_B,
  household: HOUSEHOLD_B,
  actorId: 'test-actor-b',
  deviceId: 'dev-device-2',
});

let app: TestApp | null = null;
let baseUrl = '';
let transport: HttpFinanceTransport;
let executors: ReturnType<typeof createToolExecutors>;

// Test-only authoritative deps: mount the production preHandler guard
// (routes/index.ts mounts it only when BOTH auth + workspaceAccess are
// supplied). Synthetic memory BetterAuth (no users/sessions) so getSession
// resolves empty and device-token resolution runs the production
// `resolveAuthorizedDevice` path. Token userIds are non-null per
// device-access.ts:21-31; membership is active only for the matching pair.
const SYNTH_USER_A = 'synth-user-a';
const SYNTH_USER_B = 'synth-user-b';

const auth = createBetterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  disableSignUp: false,
  transaction: false,
  secret: 'test-secret-that-is-at-least-32-characters',
  baseURL: 'http://localhost:3001',
  trustedOrigins: ['http://localhost:3000'],
});

const workspaceAccess = {
  resolve: async (authUserId: string, householdId: string) => {
    if (authUserId === SYNTH_USER_A && householdId === HOUSEHOLD_A) {
      return { userId: authUserId, householdId, role: 'owner' as const, kind: 'shared' as const, status: 'active' as const };
    }
    if (authUserId === SYNTH_USER_B && householdId === HOUSEHOLD_B) {
      return { userId: authUserId, householdId, role: 'owner' as const, kind: 'shared' as const, status: 'active' as const };
    }
    return undefined;
  },
};

const syntheticTokenStore = {
  resolve: async (token: string | undefined) => {
    if (token === TOKEN_A) {
      return { deviceId: 'dev-device-1', householdId: HOUSEHOLD_A, userId: SYNTH_USER_A };
    }
    if (token === TOKEN_B) {
      return { deviceId: 'dev-device-2', householdId: HOUSEHOLD_B, userId: SYNTH_USER_B };
    }
    if (!token || token.trim() === '') {
      throw Object.assign(new Error('missing'), { statusCode: 401, code: 'auth.missing_token' });
    }
    throw Object.assign(new Error('invalid'), { statusCode: 401, code: 'auth.invalid_token' });
  },
  register: async () => {
    throw Object.assign(new Error('unsupported'), { statusCode: 500, code: 'test.unsupported' });
  },
  revoke: async () => {},
  revokeAllForUserWorkspace: async () => 0,
  rotate: async () => {
    throw Object.assign(new Error('unsupported'), { statusCode: 500, code: 'test.unsupported' });
  },
};

// Narrow helper: listen the in-memory Fastify app on loopback only.
async function appListen(): Promise<TestApp> {
  const built = buildTestApp(
    {
      accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
      categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
      transactions: TRANSACTIONS,
    },
    auth,
    workspaceAccess,
    syntheticTokenStore,
  );
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  return built;
}

beforeAll(async () => {
  const built = await appListen();
  app = built;
  const addr = built.app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  transport = new HttpFinanceTransport({ baseUrl });
  executors = createToolExecutors(transport.call);
});

afterAll(async () => {
  await app?.app.close().catch(() => {});
  app = null;
  await auth.close().catch(() => {});
});

describe('ted-runtime read slice vs actual API handlers (loopback, synthetic)', () => {
  it('list_accounts reads household A through the real route (no fabrication)', async () => {
    const body = await executors.list_accounts({}, hostA, { intentionId: 'int-list-a' });
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    for (const item of body.items as Array<{ id: string }>) {
      expect([ACCOUNT_A1.id, ACCOUNT_A2.id]).toContain(item.id);
    }
  });

  it('get_month_summary matches the June-2026 oracle for A and B (isolation)', async () => {
    const juneA = await executors.get_month_summary({ yearMonth: '2026-06' }, hostA, { intentionId: 'int-june-a' });
    expect(juneA).toMatchObject({
      yearMonth: '2026-06',
      incomeCents: 1_200_000,
      expenseCents: 288_050,
      balanceCents: 911_950,
      transactionCount: 4,
    });
    const juneB = await executors.get_month_summary({ yearMonth: '2026-06' }, hostB, { intentionId: 'int-june-b' });
    expect(juneB).toMatchObject({ incomeCents: 0, expenseCents: 20_000, transactionCount: 1 });
  });

  it('cross-workspace read fails closed (TOKEN_A + household B → forbidden, never empty data)', async () => {
    const crossHost = { ...hostA, household: HOUSEHOLD_B };
    const err = await executors
      .get_month_summary({ yearMonth: '2026-06' }, crossHost, { intentionId: 'int-cross' })
      .catch((e) => e);
    expect(err.code).toBe('tool.forbidden');
  });

  it('invalid device token fails closed as unauthorized (never empty data)', async () => {
    const badHost = { ...hostA, token: 'dev-token-bogus' };
    const err = await executors
      .list_accounts({}, badHost, { intentionId: 'int-bad' })
      .catch((e) => e);
    expect(err.code).toBe('tool.unauthorized');
  });

  it('list_categories reads household A/B through the real route (P3 read-only, isolation)', async () => {
    const allA = await executors.list_categories({}, hostA, { intentionId: 'int-cat-a' });
    expect(allA.total).toBe(3);
    expect(allA.items).toHaveLength(3);
    const expenseA = await executors.list_categories({ kind: 'expense' }, hostA, { intentionId: 'int-cat-a-exp' });
    expect(expenseA.total).toBe(2);
    for (const item of expenseA.items as Array<{ kind: string }>) {
      expect(item.kind).toBe('expense');
    }
    const incomeA = await executors.list_categories({ kind: 'income' }, hostA, { intentionId: 'int-cat-a-inc' });
    expect(incomeA.total).toBe(1);
    expect(incomeA.items).toHaveLength(1);
    const allB = await executors.list_categories({}, hostB, { intentionId: 'int-cat-b' });
    expect(allB.total).toBe(1);
    expect(allB.items).toHaveLength(1);
    for (const item of allB.items as Array<{ id: string }>) {
      expect(item.id).toBe(CATEGORY_FOOD_B.id);
    }
  });

  it('cross-workspace list_categories fails closed (TOKEN_A + household B → forbidden, never empty data)', async () => {
    const crossHost = { ...hostA, household: HOUSEHOLD_B };
    const err = await executors
      .list_categories({}, crossHost, { intentionId: 'int-cat-cross' })
      .catch((e) => e);
    expect(err.code).toBe('tool.forbidden');
  });

  it('write method is refused client-side before any I/O', async () => {
    let calls = 0;
    const counting = new HttpFinanceTransport({
      baseUrl,
      fetchImpl: (async () => {
        calls++;
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    });
    const err = await counting
      .call({ route: '/accounts', method: 'POST', host: hostA })
      .catch((e) => e);
    expect(err.code).toBe('tool.invalid_args');
    expect(calls).toBe(0);
  });

  it('non-loopback baseUrl is refused (no secret leaves loopback)', () => {
    expect(() => new HttpFinanceTransport({ baseUrl: 'https://api.example.com' })).toThrow(/loopback/);
  });
});
