import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';

const source = readFileSync(new URL('../../src/server/index.ts', import.meta.url), 'utf8');

describe('pending V2 bootstrap wiring', () => {
  it('executor maps only canonical transaction tools to the authoritative WriteStore', async () => {
    const calls: Array<{ householdId: string; input: unknown }> = [];
    const writes = {
      async createExpense(householdId: string, input: unknown) { calls.push({ householdId, input }); return { id: 'tx-expense' }; },
      async createIncome(householdId: string, input: unknown) { calls.push({ householdId, input }); return { id: 'tx-income' }; },
    } as never;
    const execute = createPendingOperationV2Executor(writes);
    await expect(execute({
      version: 2, id: 'op', workspaceId: 'workspace-authoritative', actorId: 'actor', deviceId: 'device',
      tool: 'transactions.expense.create',
      normalizedArgs: { description: 'Mercado', amountCents: 100, date: '2026-09-13', accountId: '00000000-0000-4000-8000-000000000001', categoryId: '00000000-0000-4000-8000-000000000002' },
      proposalHash: 'hash', idempotencyKey: 'key', createdAt: '2026-09-13T00:00:00.000Z', expiresAt: '2026-09-13T01:00:00.000Z',
      bindings: { workspaceId: 'workspace-authoritative', actorId: 'actor', deviceId: 'device' },
    })).resolves.toMatchObject({
      status: 'succeeded',
      operationId: 'tx-expense',
      receipt: {
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        operationId: 'tx-expense',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        entity: { type: 'transaction', id: 'tx-expense' },
      },
    });
    expect(calls).toEqual([{ householdId: 'workspace-authoritative', input: expect.objectContaining({ description: 'Mercado' }) }]);
    await expect(execute({
      version: 2, id: 'op', workspaceId: 'workspace-authoritative', actorId: 'actor', deviceId: 'device', tool: 'create_expense', normalizedArgs: {}, proposalHash: 'hash', idempotencyKey: 'key-2', createdAt: '2026-09-13T00:00:00.000Z', expiresAt: '2026-09-13T01:00:00.000Z', bindings: { workspaceId: 'workspace-authoritative', actorId: 'actor', deviceId: 'device' },
    })).rejects.toThrow('tool.not_allowed');
  });

  it('uses the Postgres V2 store in both Postgres bootstrap branches', () => {
    expect(source).toContain('createPostgresPendingOperationV2Store(pool)');
    expect(source.match(/createPostgresPendingOperationV2Store\(pool\)/g)).toHaveLength(2);
    // CODER-API-ROUTE-DUPE (incidente 13/10, dedupe na origem): o V2 chega a
    // registerRoutes via threading (pendingV2*) — UMA única chamada a
    // registerPendingOperationRoutes dentro de registerRoutes. Não há mais
    // 2º registro v2Only no mesmo app em server/index.ts (era ele que
    // registrava /undo 2x e derrubava o boot com FST_ERR_DUPLICATED_ROUTE).
    expect(source.match(/pendingV2Store: createPostgresPendingOperationV2Store\(pool\)/g)).toHaveLength(2);
    expect(source.match(/pendingV2Executor: createPendingOperationV2Executor\(writes\)/g)).toHaveLength(2);
    expect(source.match(/pendingV2ReadModel: store/g)).toHaveLength(2);
    expect(source).not.toContain('v2Only: true');
    expect(source).not.toContain('registerPendingOperationRoutes(app,');
  });

  it('does not wire an in-memory V2 authority or a default executor', () => {
    const memoryPath = source.slice(source.indexOf('no DATABASE_URL'));
    expect(memoryPath).not.toContain('createInMemoryPendingOperationV2Store');
    expect(memoryPath).not.toContain('v2Store:');
    expect(source).not.toContain('v2Executor: async');
  });

  it('takes identity from authenticated context and fails closed without V2 store', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'actor-auth', workspace: 'workspace-auth', role: 'owner', capabilities: ['financial.approval.propose'], jti: 'j', request: 'r', deviceId: 'device-auth', iat: 1, exp: 301 };
      request.authenticatedContext = {
        householdId: 'workspace-auth', actorId: 'actor-auth', authUserId: 'actor-auth',
        actorType: 'user', deviceId: 'device-auth', role: 'owner',
      };
    });
    const store = createInMemoryPendingOperationV2Store();
    // Post-V1 (PR-1 retire-pending-v1): the registration is V2-only by
    // construction — no V1 store and no `v2Only` opt needed.
    registerPendingOperationRoutes(app, {
      resolveToken: async () => ({ householdId: 'workspace-token', deviceId: 'device-token' }),
      v2Store: store,
    });
    const response = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'wiring-test-key' },
      payload: { tool: 'transactions.create', normalizedArgs: { amountCents: 1 }, workspaceId: 'spoofed' },
    });
    expect(response.statusCode).toBe(400);
    const accepted = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'wiring-test-key-2' },
      payload: { tool: 'transactions.expense.create', normalizedArgs: { description: 'Mercado', amountCents: 100, date: '2026-09-13', accountId: '00000000-0000-4000-8000-000000000001', categoryId: '00000000-0000-4000-8000-000000000002' } },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().workspaceId).toBe('workspace-auth');
    expect(accepted.json().actorId).toBe('actor-auth');
  });
});
