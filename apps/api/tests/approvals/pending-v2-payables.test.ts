/**
 * V1 completion — accounts-payable V2 approval flow (propose→confirm→execute).
 *
 * Contract:
 * - `payables.create` executes payableStore.createPayable and returns a
 *   receipt (`mutationKind:'payables.create'`, entity payable).
 * - `payables.pay` executes payableStore.markPayablePaid using ONLY the
 *   payableId; the display snapshot never reaches the store. The payment
 *   books the expense transaction and debits the payer (store contract).
 * - Both are manual-only (never auto_execute).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AUTOEXECUTION_ELIGIBLE_TOOLS, createApprovalPolicy } from '../../src/approvals/policy.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { getApprovalToolContract, requireApprovalToolContract } from '../../src/approvals/tool-registry.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryPayableStore } from '../../src/payables/in-memory.js';

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const ALL = [
  'financial.approval.propose',
  'financial.approval.read',
  'financial.approval.confirm',
  'financial.approval.execute',
  'financial.approval.retry',
  'financial.approval.cancel',
  'financial.approval.reconcile',
];

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000a1';

const harness = async () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w',
      role: 'owner', capabilities: ALL, jti: randomUUID(), request: 'r',
      deviceId: 'd', iat: 1, exp: 9999999999,
    };
    request.authenticatedContext = {
      householdId: 'w', actorId: 'a', authUserId: 'a',
      actorType: 'user', deviceId: 'd', role: 'owner',
    };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  const { state, writes } = createInMemoryStores();
  const payableStore = createInMemoryPayableStore(state);
  await state.accounts.push({
    id: ACCOUNT_ID, householdId: 'w', name: 'Conta Corrente',
    kind: 'bank', balanceCents: 500000, status: 'active',
  } as never);
  const v2Executor = async (operation: {
    tool: string; workspaceId: string; normalizedArgs: unknown; idempotencyKey: string; actorId: string;
  }) =>
    requireApprovalToolContract(operation.tool).executor({
      writes,
      payableStore,
      workspaceId: operation.workspaceId,
      args: operation.normalizedArgs,
      idempotencyKey: operation.idempotencyKey,
      actorId: operation.actorId,
    });
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }),
    v2Store,
    v2Executor,
    v2Only: true,
    readModel: {
      listAccounts: async () => state.accounts.map((account) => ({ id: account.id, name: account.name })),
      listCategories: async () => [],
    },
  });
  return { app, state, payableStore, writes };
};

const propose = (app: FastifyInstance, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/pending-operations/v2/propose',
    headers: { 'idempotency-key': randomUUID() },
    payload: body,
  });

const confirmAndExecute = async (app: FastifyInstance, pendingId: string) => {
  const confirmed = await app.inject({
    method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {},
  });
  expect(confirmed.statusCode).toBe(200);
  const attestation = (confirmed.json() as { attestation: string }).attestation;
  const executed = await app.inject({
    method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`, payload: { attestation },
  });
  return executed;
};

describe('V2 payables (manual-only)', () => {
  it('payables.create: propose → confirm → execute persists the payable and returns a receipt', async () => {
    const { app, payableStore } = await harness();
    const proposed = await propose(app, {
      tool: 'payables.create',
      normalizedArgs: {
        accountId: ACCOUNT_ID,
        description: 'Aluguel de dezembro',
        amountCents: 150000,
        dueDate: '2026-12-05',
      },
    });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;

    const executed = await confirmAndExecute(app, pendingId);
    expect(executed.statusCode).toBe(200);
    const record = executed.json() as {
      status: string;
      execution: { status: string; operationId: string; receipt: Record<string, unknown> };
    };
    expect(record.status).toBe('succeeded');
    expect(record.execution.status).toBe('succeeded');
    expect(record.execution.receipt.mutationKind).toBe('payables.create');
    expect(record.execution.receipt.operationId).toBe(pendingId);
    expect(record.execution.receipt.entity).toEqual({ type: 'payable', id: record.execution.operationId });
    const created = await payableStore.listPayables('w');
    expect(created.some((p) => p.id === record.execution.operationId && p.description === 'Aluguel de dezembro')).toBe(true);
  });

  it('payables.pay: pays the payable, books the expense and returns a receipt', async () => {
    const { app, state, payableStore } = await harness();
    // Create the payable directly through the same authoritative store.
    const target = await payableStore.createPayable('w', {
      accountId: ACCOUNT_ID,
      description: 'Internet',
      amountCents: 12000,
      dueDate: '2026-12-10',
    });
    const proposed = await propose(app, {
      tool: 'payables.pay',
      normalizedArgs: {
        payableId: target.id,
        description: 'Internet',
        amountCents: 12000,
        dueDate: '2026-12-10',
        accountId: ACCOUNT_ID,
        paidDate: '2026-12-09',
      },
    });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;
    const executed = await confirmAndExecute(app, pendingId);
    expect(executed.statusCode).toBe(200);
    const record = executed.json() as {
      status: string;
      execution: { status: string; operationId: string; receipt: Record<string, unknown> };
    };
    expect(record.status).toBe('succeeded');
    expect(record.execution.receipt.mutationKind).toBe('payables.pay');
    expect(record.execution.receipt.entity).toEqual({ type: 'payable', id: target.id });
    const paid = (await payableStore.listPayables('w')).find((p) => p.id === target.id);
    expect(paid?.status).toBe('paid');
    expect(paid?.paidDate).toBe('2026-12-09');
    expect(state.transactions.some((t) => t.id === paid?.paidTransactionId)).toBe(true);
  });

  it('payables.pay fails closed when the display snapshot diverges from the payable', async () => {
    const { app, payableStore } = await harness();
    const target = await payableStore.createPayable('w', {
      accountId: ACCOUNT_ID,
      description: 'Energia',
      amountCents: 9000,
      dueDate: '2026-12-15',
    });
    const proposed = await propose(app, {
      tool: 'payables.pay',
      normalizedArgs: {
        payableId: target.id,
        // Forged amount: the executor must reject before moving money.
        description: 'Energia',
        amountCents: 1,
        dueDate: '2026-12-15',
        accountId: ACCOUNT_ID,
      },
    });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;
    const executed = await confirmAndExecute(app, pendingId);
    expect(executed.statusCode).toBeGreaterThanOrEqual(400);
    const paid = (await payableStore.listPayables('w')).find((p) => p.id === target.id);
    expect(paid?.status).not.toBe('paid');
  });

  it('refuses invalid payables args before any effect', async () => {
    const { app } = await harness();
    const badCreate = await propose(app, {
      tool: 'payables.create',
      normalizedArgs: { accountId: 'not-a-uuid', description: 'X', amountCents: 100, dueDate: '2026-12-05' },
    });
    expect(badCreate.statusCode).toBe(422);
    expect(badCreate.json().code).toBe('approval.invalid_args');

    const badPay = await propose(app, {
      tool: 'payables.pay',
      normalizedArgs: {
        payableId: randomUUID(),
        description: 'X',
        amountCents: 0,
        dueDate: '2026-12-05',
        accountId: ACCOUNT_ID,
      },
    });
    expect(badPay.statusCode).toBe(422);
    expect(badPay.json().code).toBe('approval.invalid_args');
  });

  it('payables.pay converges on re-execution without duplicating the expense', async () => {
    const { payableStore, writes, state } = await harness();
    const target = await payableStore.createPayable('w', {
      accountId: ACCOUNT_ID,
      description: 'Água',
      amountCents: 4500,
      dueDate: '2026-12-12',
    });
    const args = {
      payableId: target.id,
      description: 'Água',
      amountCents: 4500,
      dueDate: '2026-12-12',
      accountId: ACCOUNT_ID,
    };
    const run = () =>
      requireApprovalToolContract('payables.pay').executor({
        writes,
        payableStore,
        workspaceId: 'w',
        args,
        idempotencyKey: 'pay-key-1',
        actorId: 'a',
      });
    const first = await run();
    expect(first.status).toBe('succeeded');
    expect(first.operationId).toBe(target.id);
    const afterFirst = state.transactions.length;
    const second = await run();
    expect(second.status).toBe('succeeded');
    expect(second.operationId).toBe(target.id);
    expect(state.transactions.length).toBe(afterFirst);
    const paid = (await payableStore.listPayables('w')).find((p) => p.id === target.id);
    expect(paid?.status).toBe('paid');
    expect((await payableStore.listPayables('w')).length).toBe(1);
  });

  it('payables.create replay with the same idempotency key returns the same pending id', async () => {
    const { app, payableStore } = await harness();
    const key = randomUUID();
    const body = {
      tool: 'payables.create',
      normalizedArgs: { accountId: ACCOUNT_ID, description: 'Gás', amountCents: 8000, dueDate: '2026-12-20' },
    };
    const first = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': key }, payload: body,
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;
    const replay = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': key }, payload: body,
    });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as { id: string; existing: boolean };
    expect(replayed.id).toBe(firstId);
    expect(replayed.existing).toBe(true);
    expect((await payableStore.listPayables('w')).length).toBe(0);
  });

  it('exposes the payable target id in the active listing (money movement binding)', async () => {
    const { app, payableStore } = await harness();
    const target = await payableStore.createPayable('w', {
      accountId: ACCOUNT_ID,
      description: 'Luz',
      amountCents: 12000,
      dueDate: '2026-12-05',
    });
    const response = await propose(app, {
      tool: 'payables.pay',
      normalizedArgs: {
        payableId: target.id,
        description: 'Luz',
        amountCents: 12000,
        dueDate: '2026-12-05',
        accountId: ACCOUNT_ID,
      },
    });
    expect(response.statusCode).toBe(201);
    const listing = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(listing.statusCode).toBe(200);
    const body = listing.json() as { items: Array<Record<string, unknown>> };
    const item = body.items.find((row) => row.id === (response.json() as { id: string }).id);
    expect(item?.tool).toBe('payables.pay');
    expect(item?.payableId).toBe(target.id);
  });

  it('keeps both payables tools manual-only', () => {
    for (const tool of ['payables.create', 'payables.pay'] as const) {
      expect(AUTOEXECUTION_ELIGIBLE_TOOLS.has(tool)).toBe(false);
      expect(getApprovalToolContract(tool)?.autoExecutionEligible).toBe(false);
      const decision = createApprovalPolicy().evaluateMutation({
        tool,
        workspaceId: 'w',
        destructive: false,
        complete: true,
        ambiguousEntity: false,
        duplicateSuspected: false,
        explicitIntent: true,
        amountCents: 12000,
      });
      expect(decision.action).toBe('require_confirmation');
    }
  });
});
