import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import type { ReadModelStore } from '../../src/read-models/store.js';

const GATE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const GATE_CATEGORY_ID = '22222222-2222-4222-8222-222222222222';
const gateReadModel = {
  listAccounts: async () => [{ id: GATE_ACCOUNT_ID, name: 'Conta Teste' }],
  listCategories: async () => [{ id: GATE_CATEGORY_ID, name: 'Categoria Teste' }],
} as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;

const expenseArgs = () => ({
  description: 'Mercado semanal',
  amountCents: 8500,
  date: '2026-09-14',
  accountId: GATE_ACCOUNT_ID,
  categoryId: GATE_CATEGORY_ID,
});

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const buildApp = (executor?: (op: never) => Promise<unknown>) => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.propose', 'financial.approval.confirm', 'financial.approval.execute', 'financial.approval.read'], jti: crypto.randomUUID(), request: 'r', deviceId: 'd', iat: 1, exp: 301 };
    request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }),
    v2Store,
    v2Executor: executor ?? (async () => ({ status: 'succeeded', operationId: crypto.randomUUID() })),
    v2Only: true,
    readModel: gateReadModel,
  });
  return { app, v2Store };
};

const proposeExpense = (app: ReturnType<typeof buildApp>['app'], key: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': key }, payload: { tool: 'transactions.expense.create', normalizedArgs: expenseArgs(), ...extra } });

describe('v2 attestation route binding + server TTL (P2)', () => {
  it('refuses A-attestation sent to B-URL with zero effect', async () => {
    let runs = 0;
    const { app } = buildApp(async () => { runs += 1; return { status: 'succeeded', operationId: randomUUID() }; });
    const idA = (await proposeExpense(app, 'bind-a')).json().id as string;
    const idB = (await proposeExpense(app, 'bind-b')).json().id as string;
    const confirmedA = await app.inject({ method: 'POST', url: `/pending-operations/v2/${idA}/confirm` });
    expect(confirmedA.statusCode).toBe(200);
    const tokenA = confirmedA.json().attestation as string;

    const cross = await app.inject({ method: 'POST', url: `/pending-operations/v2/${idB}/execute`, payload: { attestation: tokenA } });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().code).toBe('approval.attestation_replayed');
    expect(runs).toBe(0);

    // Zero effect: A stays confirmed (attestation unconsumed at the store
    // level for the mismatched attempt), B stays proposed.
    const getA = await app.inject({ method: 'GET', url: `/pending-operations/v2/${idA}` });
    expect(getA.json().status).toBe('confirmed');
    const getB = await app.inject({ method: 'GET', url: `/pending-operations/v2/${idB}` });
    expect(getB.json().status).toBe('proposed');
  });

  it('store execute binds the expected operation id atomically', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'w', actorId: 'a', deviceId: 'd' };
    const base = (key: string) => ({
      version: 2 as const, ...identity,
      tool: 'transactions.expense.create',
      normalizedArgs: { description: 'x', amountCents: 100, date: '2026-09-14', accountId: randomUUID(), categoryId: randomUUID() },
      proposalHash: '', idempotencyKey: key,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      bindings: { ...identity },
    });
    const mk = async (key: string) => {
      const b = base(key);
      return store.propose({ ...b, proposalHash: await computePendingOperationV2Hash(b) });
    };
    const savedA = await mk('store-bind-a');
    const savedB = await mk('store-bind-b');
    const confirmedA = await store.confirm(savedA.id, identity);
    let ran = false;
    await expect(store.execute(confirmedA.attestation!, identity, async () => { ran = true; return { status: 'succeeded', operationId: 'op-x' }; }, savedB.id))
      .rejects.toMatchObject({ code: 'approval.attestation_replayed' });
    expect(ran).toBe(false);
    expect((await store.get(savedA.id, identity)).status).toBe('confirmed');
    expect((await store.get(savedB.id, identity)).status).toBe('proposed');
  });

  it('clamps a user-supplied 24h expiresAt to the 30 min server max (route)', async () => {
    const { app } = buildApp();
    const before = Date.now();
    const res = await proposeExpense(app, 'ttl-clamp', { expiresAt: new Date(before + 24 * 3600_000).toISOString() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const windowMs = Date.parse(body.expiresAt) - Date.parse(body.createdAt);
    expect(windowMs).toBeLessThanOrEqual(30 * 60_000);
    expect(windowMs).toBeGreaterThan(0);
  });

  it('clamps a far-future expiresAt at the store and ignores backdated createdAt', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'w', actorId: 'a', deviceId: 'd' };
    const before = Date.now();
    const crafted = {
      version: 2 as const, ...identity,
      tool: 'transactions.expense.create',
      normalizedArgs: { description: 'x', amountCents: 100, date: '2026-09-14', accountId: randomUUID(), categoryId: randomUUID() },
      proposalHash: '', idempotencyKey: 'ttl-store-clamp',
      createdAt: new Date(before - 7 * 24 * 3600_000).toISOString(),
      expiresAt: new Date(before + 24 * 3600_000).toISOString(),
      bindings: { ...identity },
    };
    const saved = await store.propose({ ...crafted, proposalHash: await computePendingOperationV2Hash(crafted) });
    expect(Date.parse(saved.createdAt)).toBeGreaterThanOrEqual(before - 5_000);
    expect(Date.parse(saved.expiresAt) - Date.parse(saved.createdAt)).toBeLessThanOrEqual(30 * 60_000);
  });

  it('boundary: inside-TTL confirms, past-expiry stays expired', async () => {
    const { app } = buildApp();
    const ok = await proposeExpense(app, 'ttl-ok', { expiresAt: new Date(Date.now() + 29 * 60_000).toISOString() });
    expect(ok.statusCode).toBe(201);
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${ok.json().id}/confirm` });
    expect(confirmed.statusCode).toBe(200);

    const past = await proposeExpense(app, 'ttl-past', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    // A birth-expired proposal either fails fast at propose or fails closed
    // at confirm — never becomes confirmable.
    if (past.statusCode === 201) {
      const denied = await app.inject({ method: 'POST', url: `/pending-operations/v2/${past.json().id}/confirm` });
      expect(denied.statusCode).toBe(409);
      expect(denied.json().code).toBe('approval.expired');
    } else {
      expect([400, 409, 422]).toContain(past.statusCode);
    }
  });
});
