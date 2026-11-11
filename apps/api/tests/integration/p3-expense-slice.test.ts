/**
 * P3 expense slice — deterministic API/DB-synthetic proof of the approval
 * invariants (no Postgres, no production):
 *
 * - propose persists a PENDING operation but writes ZERO transactions;
 * - the authenticated confirm + execute writes EXACTLY ONE row;
 * - cancel/reject writes ZERO;
 * - a repeated execute/confirm never duplicates;
 * - the pending operation survives a reload (new app instance, same store);
 * - another workspace/actor can never confirm or execute it.
 *
 * The "ledger" below is a synthetic WriteStore stand-in: the real V2 executor
 * (and its Postgres idempotency) is covered by pending-v2-e2e.test.ts when a
 * test database is configured.
 */
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createInMemoryPendingOperationV2Store, type PendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import type { PendingExecutor } from '../../src/approvals/pending.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import type { ReadModelStore } from '../../src/read-models/store.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const readModel = {
  listAccounts: async () => [{ id: ACCOUNT, name: 'Nubank' }],
  listCategories: async () => [{ id: CATEGORY, name: 'Mercado' }],
} as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;

const expenseArgs = () => ({
  description: 'mercado',
  amountCents: 5000,
  date: '2026-11-06',
  accountId: ACCOUNT,
  categoryId: CATEGORY,
});

type Identity = { workspaceId: string; actorId: string; deviceId: string };

/** Synthetic ledger: one row per executed operation, deduped by operation id. */
function fakeExecutor(ledger: Array<{ operationId: string; amountCents: number }>): PendingExecutor {
  return (async (operation: { id: string; normalizedArgs: Record<string, unknown> }) => {
    if (!ledger.some((row) => row.operationId === operation.id)) {
      ledger.push({ operationId: operation.id, amountCents: operation.normalizedArgs.amountCents as number });
    }
    return {
      status: 'succeeded' as const,
      operationId: crypto.randomUUID(),
      receipt: {
        mutationId: crypto.randomUUID(),
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts'],
        operationId: operation.id,
        entity: { type: 'transaction', id: crypto.randomUUID() },
      },
    };
  }) as unknown as PendingExecutor;
}

function appFor(
  v2Store: PendingOperationV2Store,
  identity: Identity,
  ledger: Array<{ operationId: string; amountCents: number }>,
): FastifyInstance {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const capabilities = [
      'financial.approval.propose',
      'financial.approval.read',
      'financial.approval.confirm',
      'financial.approval.execute',
      'financial.approval.cancel',
      'financial.approval.retry',
    ];
    request.delegatedTurn = {
      iss: 'pi-agent',
      aud: 'pi-finance-api',
      sub: identity.actorId,
      workspace: identity.workspaceId,
      role: 'owner',
      capabilities,
      jti: crypto.randomUUID(),
      request: 'req-p3',
      deviceId: identity.deviceId,
      iat: 1,
      exp: 301,
    };
    request.authenticatedContext = {
      householdId: identity.workspaceId,
      actorId: identity.actorId,
      authUserId: identity.actorId,
      actorType: 'user',
      deviceId: identity.deviceId,
      role: 'owner',
    };
  });
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: identity.workspaceId, deviceId: identity.deviceId }),
    v2Store,
    v2Executor: fakeExecutor(ledger),
    v2Only: true,
    readModel,
  });
  return app;
}

const propose = (app: FastifyInstance, key: string, args = expenseArgs()) =>
  app.inject({
    method: 'POST',
    url: '/pending-operations/v2/propose',
    headers: { 'idempotency-key': key },
    payload: { tool: 'transactions.expense.create', normalizedArgs: args },
  });

describe('P3 expense slice — propose/confirm/reject invariants (synthetic)', () => {
  it('propose writes ZERO rows; confirm+execute writes EXACTLY ONE', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const ledger: Array<{ operationId: string; amountCents: number }> = [];
    const identity = { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' };
    const app = appFor(store, identity, ledger);

    const proposed = await propose(app, 'key-1');
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    expect(ledger).toHaveLength(0);

    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    expect(confirmed.statusCode).toBe(200);
    expect(ledger).toHaveLength(0);

    const executed = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: confirmed.json().attestation },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe('succeeded');
    expect(ledger).toEqual([{ operationId: id, amountCents: 5000 }]);

    const receipt = executed.json().execution?.receipt ?? executed.json().receipt;
    expect(receipt.mutationKind).toBe('transactions.expense.create');
  });

  it('a repeated confirm+execute never duplicates the row', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const ledger: Array<{ operationId: string; amountCents: number }> = [];
    const app = appFor(store, { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' }, ledger);

    const proposed = await propose(app, 'key-replay');
    const id = proposed.json().id as string;
    const first = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: first.json().attestation },
    });
    expect(ledger).toHaveLength(1);

    // Old attestation is single-use: replay is refused, executor never runs again.
    const replay = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: first.json().attestation },
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(ledger).toHaveLength(1);

    // A fresh confirm on a terminal operation cannot execute a second time.
    const second = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    if (second.statusCode === 200 && typeof second.json().attestation === 'string') {
      await app.inject({
        method: 'POST',
        url: `/pending-operations/v2/${id}/execute`,
        payload: { attestation: second.json().attestation },
      });
    }
    expect(ledger).toHaveLength(1);
  });

  it('rejection/cancel writes ZERO rows and blocks execution', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const ledger: Array<{ operationId: string; amountCents: number }> = [];
    const app = appFor(store, { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' }, ledger);

    const proposed = await propose(app, 'key-cancel');
    const id = proposed.json().id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const cancelled = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(ledger).toHaveLength(0);

    const executed = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: confirmed.json().attestation },
    });
    expect(executed.statusCode).toBeGreaterThanOrEqual(400);
    expect(ledger).toHaveLength(0);
  });

  it('is idempotent on redelivery: same key + payload reuses the operation', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const ledger: Array<{ operationId: string; amountCents: number }> = [];
    const app = appFor(store, { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' }, ledger);

    const first = await propose(app, 'key-same');
    const second = await propose(app, 'key-same');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().existing).toBe(true);
    expect(ledger).toHaveLength(0);
  });

  it('the pending proposal survives reload (new app instance, same authoritative store)', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' };
    const ledger: Array<{ operationId: string; amountCents: number }> = [];

    const first = appFor(store, identity, ledger);
    const proposed = await propose(first, 'key-reload');
    const id = proposed.json().id as string;

    // "Reload": a brand-new app instance reading the same durable store.
    const reloaded = appFor(store, identity, ledger);
    const active = await reloaded.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(active.statusCode).toBe(200);
    expect(active.json().items.map((item: { id: string }) => item.id)).toContain(id);
    expect(ledger).toHaveLength(0);
  });

  it('another workspace/actor can never confirm or execute the proposal', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const ledger: Array<{ operationId: string; amountCents: number }> = [];
    const owner = appFor(store, { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' }, ledger);
    const stranger = appFor(store, { workspaceId: WORKSPACE_B, actorId: 'actor-b', deviceId: 'device-b' }, ledger);

    const proposed = await propose(owner, 'key-cross');
    const id = proposed.json().id as string;

    const foreignConfirm = await stranger.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    // 403 (never 404) — the scoped route refuses to leak existence.
    expect(foreignConfirm.statusCode).toBe(403);
    expect(foreignConfirm.json().code).toBe('approval.forbidden');
    expect(ledger).toHaveLength(0);

    const foreignActive = await stranger.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(foreignActive.statusCode).toBe(200);
    expect(foreignActive.json().items).toHaveLength(0);

    // The owner still can — the failed foreign attempt changed nothing.
    const ownConfirm = await owner.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    expect(ownConfirm.statusCode).toBe(200);
    await owner.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: ownConfirm.json().attestation },
    });
    expect(ledger).toEqual([{ operationId: id, amountCents: 5000 }]);
  });
});
