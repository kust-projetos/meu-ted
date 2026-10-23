/**
 * accounts.create no fluxo V2 de aprovação (propose→confirm→execute),
 * manual-only. Contrato fixado:
 * - tool 'accounts.create'; draft {name, kind: bank|cash, initialBalanceCents signed};
 * - recibo {mutationKind:'accounts.create', operationId:<pendingId>, entity:{type:'account', id}};
 * - policy SEMPRE require_confirmation, NUNCA auto_execute.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AUTOEXECUTION_ELIGIBLE_TOOLS,
  createApprovalPolicy,
} from '../../src/approvals/policy.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import {
  getApprovalToolContract,
  requireApprovalToolContract,
  validateApprovalToolArgs,
} from '../../src/approvals/tool-registry.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

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

const accountArgs = () => ({
  name: 'Conta Corrente TED',
  kind: 'bank',
  initialBalanceCents: 0,
});

const harness = () => {
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
  // Espelha createPendingOperationV2Executor (routes/index.ts): ponte única
  // ferramenta canônica → WriteStore, sem identidade vinda de normalizedArgs.
  const v2Executor = async (operation: {
    tool: string; workspaceId: string; normalizedArgs: unknown; idempotencyKey: string; actorId: string;
  }) =>
    requireApprovalToolContract(operation.tool).executor({
      writes,
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
      listAccounts: async () => [],
      listCategories: async () => [],
    },
  });
  return { app, v2Store, state, writes };
};

const propose = (app: FastifyInstance, key: string | undefined, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/pending-operations/v2/propose',
    ...(key !== undefined ? { headers: { 'idempotency-key': key } } : {}),
    payload: body,
  });

describe('V2 accounts.create (manual-only)', () => {
  it('(1) propose com Idempotency-Key → 201; replay mesma key → mesmo id', async () => {
    const { app } = harness();
    const key = randomUUID();
    const body = { tool: 'accounts.create', normalizedArgs: accountArgs() };
    const first = await propose(app, key, body);
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;
    expect(firstId).toBeTruthy();

    const replay = await propose(app, key, body);
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as { id: string; existing: boolean };
    expect(replayed.existing).toBe(true);
    expect(replayed.id).toBe(firstId);
  });

  it('(1) propose sem Idempotency-Key → 400', async () => {
    const { app } = harness();
    const res = await propose(app, undefined, { tool: 'accounts.create', normalizedArgs: accountArgs() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
  });

  it('(1) mesma key com payload divergente → 409 idempotency.conflict', async () => {
    const { app } = harness();
    const key = randomUUID();
    const first = await propose(app, key, { tool: 'accounts.create', normalizedArgs: accountArgs() });
    expect(first.statusCode).toBe(201);
    const clash = await propose(app, key, {
      tool: 'accounts.create',
      normalizedArgs: { ...accountArgs(), name: 'Outra Conta' },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe('idempotency.conflict');
  });

  it('(2) tool fora do registro segue 403 tool.not_allowed', async () => {
    const { app } = harness();
    const res = await propose(app, randomUUID(), { tool: 'accounts.delete', normalizedArgs: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('tool.not_allowed');
    expect(validateApprovalToolArgs('accounts.delete', {} as never)).toMatchObject({
      success: false,
      code: 'tool.not_allowed',
    });
  });

  it('(3) execute emite recibo accounts.create com operationId=pendingId e entity account', async () => {
    const { app, state } = harness();
    const proposed = await propose(app, randomUUID(), { tool: 'accounts.create', normalizedArgs: accountArgs() });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;

    const confirmed = await app.inject({
      method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    const attestation = (confirmed.json() as { attestation: string }).attestation;
    expect(attestation).toBeTruthy();

    const executed = await app.inject({
      method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`,
      payload: { attestation },
    });
    expect(executed.statusCode).toBe(200);
    const record = executed.json() as {
      status: string;
      execution: { status: string; operationId: string; receipt: Record<string, unknown> };
    };
    expect(record.status).toBe('succeeded');
    expect(record.execution.status).toBe('succeeded');
    expect(record.execution.receipt.mutationKind).toBe('accounts.create');
    expect(record.execution.receipt.operationId).toBe(pendingId);
    expect(record.execution.receipt.entity).toEqual({ type: 'account', id: record.execution.operationId });
    // A conta foi realmente criada no workspace server-side.
    const created = state.accounts.find((a) => a.id === record.execution.operationId);
    expect(created?.name).toBe('Conta Corrente TED');
  });

  it('(4) policy: accounts.create sempre require_confirmation; nunca auto_execute', () => {
    expect(AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.create')).toBe(false);
    const contract = getApprovalToolContract('accounts.create');
    expect(contract?.autoExecutionEligible).toBe(false);
    const policy = createApprovalPolicy();
    // Mesmo completa, explícita e de baixo valor: manual-only.
    const decision = policy.evaluateMutation({
      tool: 'accounts.create',
      workspaceId: 'w',
      destructive: false,
      complete: true,
      ambiguousEntity: false,
      duplicateSuspected: false,
      explicitIntent: true,
      amountCents: 1,
    });
    expect(decision.action).toBe('require_confirmation');
    expect(decision).not.toMatchObject({ action: 'auto_execute' });
  });

  it('(6) ADR-018 via schemas/writes existentes: bank/cash negativo e zero OK; credit_card rejeitado', async () => {
    const { writes } = harness();
    const run = (args: unknown) =>
      requireApprovalToolContract('accounts.create').executor({
        writes,
        workspaceId: 'w',
        args,
        idempotencyKey: randomUUID(),
        actorId: 'a',
      });
    const negative = await run({ name: 'Negativa', kind: 'bank', initialBalanceCents: -5000 });
    expect(negative.status).toBe('succeeded');
    const zero = await run({ name: 'Zerada', kind: 'cash', initialBalanceCents: 0 });
    expect(zero.status).toBe('succeeded');
    await expect(run({ name: 'Cartão', kind: 'credit_card', initialBalanceCents: -1 })).rejects.toThrow();
    await expect(run({ name: 'Cartão Zero', kind: 'credit_card', initialBalanceCents: 0 })).rejects.toThrow();
  });
});
