import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { mutationReceiptSchema } from '@pi-finance/llm-contracts';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import type { PendingExecutor } from '../../src/approvals/pending.js';
import type { ReadModelStore } from '../../src/read-models/store.js';

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const expenseArgs = () => ({
  description: 'Mercado semanal',
  amountCents: 8500,
  date: '2026-09-14',
  accountId: GATE_ACCOUNT_ID,
  categoryId: GATE_CATEGORY_ID,
});

const incomeArgs = () => ({
  description: 'Salário mensal',
  amountCents: 200000,
  date: '2026-09-14',
  accountId: GATE_ACCOUNT_ID,
  categoryId: GATE_CATEGORY_ID,
});

// FIX-API-ACTIONABLE-PRESENTATION-GATE: confirm/retry now require a
// server-derived actionable presentation, so route harnesses that confirm
// must resolve labels from a read model. Deterministic ids keep the
// canonical-validation assertions intact while the stub resolves them.
const GATE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const GATE_CATEGORY_ID = '22222222-2222-4222-8222-222222222222';
const gateReadModel = {
  listAccounts: async () => [{ id: GATE_ACCOUNT_ID, name: 'Conta Teste' }],
  listCategories: async () => [{ id: GATE_CATEGORY_ID, name: 'Categoria Teste' }],
} as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;

const delegatedProposeApp = () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.propose', 'financial.approval.confirm'], jti: crypto.randomUUID(), request: 'r', deviceId: 'd', iat: 1, exp: 301 };
    request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store, v2Only: true, readModel: gateReadModel });
  return { app, v2Store };
};

const propose = (app: FastifyInstance, key: string, body: unknown) =>
  app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': key }, payload: body });

describe('pending operation V2 routes', () => {
  it('does not expose V2 when the authoritative store is absent', async () => {
    const app = Fastify();
    registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }) });
    const response = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'x-device-token': 'x', 'idempotency-key': 'k' }, payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it('returns 501 for execution when no controlled V2 executor is configured', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.execute'], jti: 'j', request: 'r', deviceId: 'd', iat: 1, exp: 301 };
      request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
    });
    registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store: createInMemoryPendingOperationV2Store(), v2Only: true });
    const response = await app.inject({ method: 'POST', url: '/pending-operations/v2/00000000-0000-4000-8000-000000000000/execute', payload: { attestation: 'a'.repeat(32) } });
    expect(response.statusCode).toBe(501);
  });

  it('rejects browser/session and generic financial.write callers at the V2 boundary', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
    });
    registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store: createInMemoryPendingOperationV2Store(), v2Only: true });

    const session = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'session-key' }, payload: { tool: 'transactions.expense.create', normalizedArgs: {} } });
    expect(session.statusCode).toBe(403);
    expect(session.json().code).toBe('auth.delegation_scope_forbidden');

    const generic = Fastify();
    generic.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.write'], jti: 'j', request: 'r', deviceId: 'd', iat: 1, exp: 301 };
      request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
    });
    registerPendingOperationRoutes(generic, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store: createInMemoryPendingOperationV2Store(), v2Only: true });
    const denied = await generic.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'generic-key' }, payload: { tool: 'transactions.expense.create', normalizedArgs: {} } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('auth.delegation_scope_forbidden');
  });

  it('allows only delegated approval capabilities and keeps attestation behind that boundary', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.propose', 'financial.approval.confirm', 'financial.approval.execute', 'financial.approval.retry', 'financial.approval.cancel'], jti: crypto.randomUUID(), request: 'r', deviceId: 'd', iat: 1, exp: 301 };
      request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
    });
    const v2Store = createInMemoryPendingOperationV2Store();
    registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store, v2Executor: async () => ({ status: 'succeeded', operationId: crypto.randomUUID() }), v2Only: true, readModel: gateReadModel });
    const proposed = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'approval-key' }, payload: { tool: 'transactions.expense.create', normalizedArgs: expenseArgs() } });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    expect(confirmed.statusCode).toBe(200);
    expect(typeof confirmed.json().attestation).toBe('string');

    const browser = Fastify();
    browser.addHook('preHandler', async (request) => {
      request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
    });
    registerPendingOperationRoutes(browser, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store, v2Only: true });
    const browserConfirm = await browser.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    expect(browserConfirm.statusCode).toBe(403);
    expect(browserConfirm.json().code).toBe('auth.delegation_scope_forbidden');
  });

  it('exposes retry only with the delegated approval retry capability', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.propose', 'financial.approval.confirm', 'financial.approval.execute', 'financial.approval.retry'], jti: crypto.randomUUID(), request: 'r', deviceId: 'd', iat: 1, exp: 301 };
      request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
    });
    const v2Store = createInMemoryPendingOperationV2Store();
    registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store, v2Executor: async () => { throw new Error('controlled-failure'); }, v2Only: true, readModel: gateReadModel });
    const proposed = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'retry-key' }, payload: { tool: 'transactions.expense.create', normalizedArgs: expenseArgs() } });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/execute`, payload: { attestation: confirmed.json().attestation } });
    const retried = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/retry` });
    expect(retried.statusCode).toBe(200);
    expect(typeof retried.json().attestation).toBe('string');
  });

  describe('execution receipt exposure (T3.3 — receipt travels API → Agent → PWA)', () => {
    const delegatedApprovalApp = (v2Executor: PendingExecutor, storeOptions?: { leaseMs?: number }) => {
      const app = Fastify();
      app.addHook('preHandler', async (request) => {
        request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.propose', 'financial.approval.confirm', 'financial.approval.execute', 'financial.approval.reconcile'], jti: crypto.randomUUID(), request: 'r', deviceId: 'd', iat: 1, exp: 301 };
        request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
      });
      registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store: createInMemoryPendingOperationV2Store(storeOptions), v2Executor, v2Only: true, readModel: gateReadModel });
      return app;
    };
    const proposeExpense = (app: FastifyInstance, key: string) =>
      app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': key }, payload: { tool: 'transactions.expense.create', normalizedArgs: expenseArgs() } });
    const confirmOp = (app: FastifyInstance, id: string) =>
      app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const executeOp = (app: FastifyInstance, id: string, attestation: string) =>
      app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/execute`, payload: { attestation } });

    it('successful execution returns the API receipt in the response body with no attestation material', async () => {
      // Synthesis path: a receipt-less executor success still yields a full
      // receipt (withTedReceipt), and the TX2 response the Agent consumes
      // carries it WITHOUT any attestation/hash/token (INV-05).
      const app = delegatedApprovalApp(async () => ({ status: 'succeeded', operationId: 'tx-1' }));
      const proposed = await proposeExpense(app, 'receipt-key-1');
      expect(proposed.statusCode).toBe(201);
      const id = proposed.json().id;
      const confirmed = await confirmOp(app, id);
      expect(confirmed.statusCode).toBe(200);

      const executed = await executeOp(app, id, confirmed.json().attestation);
      expect(executed.statusCode).toBe(200);
      const body = executed.json();
      expect(body.status).toBe('succeeded');
      expect(typeof body.mutationId).toBe('string');
      const receipt = body.execution?.receipt;
      expect(receipt).toBeTruthy();
      expect(receipt.mutationId).toBe(body.mutationId);
      expect(receipt.mutationKind).toBe('transactions.expense.create');
      expect(receipt.status).toBe('succeeded');
      expect(Array.isArray(receipt.affectedTargets)).toBe(true);
      expect(receipt.affectedTargets.length).toBeGreaterThan(0);
      expect(receipt.operationId).toBe(id);
      expect(receipt.entity).toEqual({ type: 'transaction', id: 'tx-1' });
      expect(mutationReceiptSchema.safeParse(receipt).success).toBe(true);
      // INV-05: authority material never rides along on the execution result.
      expect(Object.keys(body)).not.toContain('attestation');
      expect(Object.keys(receipt)).not.toContain('attestation');
      expect(Object.keys(body.execution)).not.toContain('attestation');
    });

    it('honors an executor-emitted receipt and echoes its mutationId at the top level', async () => {
      // Production tool-registry executors attach the REAL receipt; the store
      // must honor its mutationId (never re-generate a second identity).
      const executorReceipt = {
        mutationId: 'mut-fixed-0001',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded' as const,
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'tx-2',
        entity: { type: 'transaction', id: 'tx-2' },
      };
      const app = delegatedApprovalApp(async () => ({ status: 'succeeded', operationId: 'tx-2', receipt: executorReceipt }));
      const proposed = await proposeExpense(app, 'receipt-key-2');
      const id = proposed.json().id;
      const confirmed = await confirmOp(app, id);
      const executed = await executeOp(app, id, confirmed.json().attestation);
      expect(executed.statusCode).toBe(200);
      const body = executed.json();
      expect(body.mutationId).toBe('mut-fixed-0001');
      expect(body.execution.receipt).toEqual({ ...executorReceipt, operationId: id });
    });

    it('reconcile (crash recovery) also returns the receipt in the response body', async () => {
      // Crash window simulation: attempt 1 claims (executing) and never
      // finalizes; the reconciler re-runs the SAME executor and the recovery
      // response carries the receipt exactly like a direct execution.
      let calls = 0;
      const app = delegatedApprovalApp(async () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return { status: 'succeeded', operationId: 'tx-3' };
      }, { leaseMs: 1 });
      const proposed = await proposeExpense(app, 'receipt-key-3');
      const id = proposed.json().id;
      const confirmed = await confirmOp(app, id);
      const inflight = executeOp(app, id, confirmed.json().attestation);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const reconciled = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/reconcile` });
      expect(reconciled.statusCode).toBe(200);
      const body = reconciled.json();
      expect(body.status).toBe('succeeded');
      expect(typeof body.mutationId).toBe('string');
      expect(body.execution?.receipt?.mutationId).toBe(body.mutationId);
      expect(Object.keys(body)).not.toContain('attestation');
      void inflight;
    });
  });

  describe('propose canonical validation and idempotency (SPEC §7.4, §7.7)', () => {
    it('accepts canonical expense args with 201', async () => {
      const { app } = delegatedProposeApp();
      const response = await propose(app, 'expense-key', { tool: 'transactions.expense.create', normalizedArgs: expenseArgs() });
      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBeTruthy();
      expect(response.json().status).toBe('proposed');
    });

    it('accepts canonical income args with 201', async () => {
      const { app } = delegatedProposeApp();
      const response = await propose(app, 'income-key', { tool: 'transactions.income.create', normalizedArgs: incomeArgs() });
      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBeTruthy();
    });

    it('rejects empty normalizedArgs without persisting', async () => {
      const { app, v2Store } = delegatedProposeApp();
      const before = v2Store.audit.length;
      const response = await propose(app, 'empty-key', { tool: 'transactions.expense.create', normalizedArgs: {} });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('approval.invalid_args');
      expect(response.json().details).toBeTruthy();
      expect(v2Store.audit.length).toBe(before);
    });

    it('rejects the legacy categoryQuery shape (missing canonical categoryId)', async () => {
      const { app } = delegatedProposeApp();
      const args = { description: 'Mercado', amountCents: 5000, date: '2026-09-14', accountId: crypto.randomUUID(), categoryQuery: 'alimentação' };
      const response = await propose(app, 'legacy-shape-key', { tool: 'transactions.expense.create', normalizedArgs: args });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('approval.invalid_args');
    });

    it('rejects a wrong-tool payload (transfer shape sent as income)', async () => {
      // NOTE: expense/income canonical schemas are structurally identical, so a
      // literal expense↔income cross-send cannot be distinguished at schema level.
      // Per-tool routing is proven by the unknown-tool case below plus both-tools
      // enforcement here: a transfer-shaped payload fits neither registry schema.
      const { app } = delegatedProposeApp();
      const args = { description: 'Transfer', amountCents: 1000, date: '2026-09-14', fromAccountId: crypto.randomUUID(), toAccountId: crypto.randomUUID() };
      const response = await propose(app, 'wrong-tool-key', { tool: 'transactions.income.create', normalizedArgs: args });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('approval.invalid_args');
    });

    it('rejects an unregistered tool with tool.not_allowed', async () => {
      const { app, v2Store } = delegatedProposeApp();
      const before = v2Store.audit.length;
      const response = await propose(app, 'unknown-tool-key', { tool: 'transactions.transfer.create', normalizedArgs: expenseArgs() });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('tool.not_allowed');
      expect(v2Store.audit.length).toBe(before);
    });

    it('same key + same payload returns the existing operation (200, no second row)', async () => {
      const { app, v2Store } = delegatedProposeApp();
      const body = { tool: 'transactions.expense.create', normalizedArgs: expenseArgs() };
      const first = await propose(app, 'dedup-key', body);
      expect(first.statusCode).toBe(201);
      const second = await propose(app, 'dedup-key', body);
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);
      expect(second.json().existing).toBe(true);
      const created = v2Store.audit.filter((e) => e.event === 'propose');
      expect(new Set(created.map((e) => e.operationId)).size).toBe(1);
      const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${first.json().id}/confirm` });
      expect(confirmed.statusCode).toBe(200);
    });

    it('same key + divergent payload conflicts with 409 idempotency.conflict', async () => {
      const { app } = delegatedProposeApp();
      const first = await propose(app, 'conflict-key', { tool: 'transactions.expense.create', normalizedArgs: expenseArgs() });
      expect(first.statusCode).toBe(201);
      const divergent = await propose(app, 'conflict-key', { tool: 'transactions.expense.create', normalizedArgs: { ...expenseArgs(), amountCents: 1 } });
      expect(divergent.statusCode).toBe(409);
      expect(divergent.json().code).toBe('idempotency.conflict');
    });
  });
});
