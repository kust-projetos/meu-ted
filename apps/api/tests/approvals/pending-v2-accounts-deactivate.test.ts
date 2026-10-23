/**
 * accounts.deactivate no fluxo V2 de aprovação (propose→confirm→execute),
 * manual-only. Contrato fixado:
 * - tool 'accounts.deactivate'; normalizedArgs {accountId: UUID}
 *   (+accountName só p/ apresentação, nunca como chave);
 * - recibo {mutationKind:'accounts.deactivate', operationId:<pendingId>,
 *   entity:{type:'account', id:<accountId>}};
 * - policy SEMPRE require_confirmation, NUNCA auto_execute;
 * - propose exige Idempotency-Key.
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
  buildPendingOperationPresentation,
  derivePresentationTitle,
} from '../../src/approvals/presentation.js';
import {
  getApprovalToolContract,
  requireApprovalToolContract,
  validateApprovalToolArgs,
} from '../../src/approvals/tool-registry.js';
import { resolveUndoReceipt } from '../../src/reconciliation/effects-registry.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { isActionablePendingOperationPresentation } from '@pi-finance/llm-contracts';

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

const deactivateArgs = () => ({
  accountId: ACCOUNT_ID,
  accountName: 'Conta Corrente TED',
  accountKind: 'bank',
  balanceCents: 12500,
});

const harness = (accounts: Array<{ id: string; name: string }> = []) => {
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
      listAccounts: async () => accounts,
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

describe('V2 accounts.deactivate (manual-only)', () => {
  it('(1) propose com Idempotency-Key → 201; replay mesma key → mesmo id', async () => {
    const { app } = harness();
    const key = randomUUID();
    const body = { tool: 'accounts.deactivate', normalizedArgs: deactivateArgs() };
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
    const res = await propose(app, undefined, { tool: 'accounts.deactivate', normalizedArgs: deactivateArgs() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
  });

  it('(1) mesma key com payload divergente → 409 idempotency.conflict', async () => {
    const { app } = harness();
    const key = randomUUID();
    const first = await propose(app, key, { tool: 'accounts.deactivate', normalizedArgs: deactivateArgs() });
    expect(first.statusCode).toBe(201);
    const clash = await propose(app, key, {
      tool: 'accounts.deactivate',
      normalizedArgs: { ...deactivateArgs(), accountId: randomUUID() },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe('idempotency.conflict');
  });

  it('(1) accountId inválido → 422 approval.invalid_args; extras de apresentação não viram chave', async () => {
    const { app } = harness();
    const bad = await propose(app, randomUUID(), {
      tool: 'accounts.deactivate',
      normalizedArgs: { accountId: 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('approval.invalid_args');
    // accountName distinto com mesmo accountId diverge o hash (payload distinto),
    // mas a execução usa SEMPRE o accountId como chave.
    expect(validateApprovalToolArgs('accounts.deactivate', {
      accountId: ACCOUNT_ID, accountName: 'Outro Nome',
    })).toMatchObject({ success: true });
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

  it('(3) execute desativa a conta e emite recibo accounts.deactivate com operationId=pendingId e entity account', async () => {
    const { app, state } = harness([{ id: ACCOUNT_ID, name: 'Conta Corrente TED' }]);
    const created = await state.accounts.push({
      id: ACCOUNT_ID, householdId: 'w', name: 'Conta Corrente TED',
      kind: 'bank', balanceCents: 12500, status: 'active',
    } as never);
    expect(created).toBe(1);
    const proposed = await propose(app, randomUUID(), { tool: 'accounts.deactivate', normalizedArgs: deactivateArgs() });
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
    expect(record.execution.operationId).toBe(ACCOUNT_ID);
    expect(record.execution.receipt.mutationKind).toBe('accounts.deactivate');
    expect(record.execution.receipt.operationId).toBe(pendingId);
    expect(record.execution.receipt.entity).toEqual({ type: 'account', id: ACCOUNT_ID });
    // A conta foi realmente desativada no workspace server-side.
    const account = state.accounts.find((a) => a.id === ACCOUNT_ID);
    expect(account?.status).toBe('inactive');
  });

  it('(3) re-execução convergente: conta já inativa não duplica efeito nem falha', async () => {
    const { writes } = harness();
    await writes.createAccount('w', { name: 'Alvo', kind: 'cash', initialBalanceCents: 0 });
    const target = (await writes.createAccount('w', { name: 'Alvo 2', kind: 'cash', initialBalanceCents: 0 }));
    const run = (args: unknown) =>
      requireApprovalToolContract('accounts.deactivate').executor({
        writes, workspaceId: 'w', args, idempotencyKey: randomUUID(), actorId: 'a',
      });
    const first = await run({ accountId: target.id });
    expect(first.status).toBe('succeeded');
    expect(first.operationId).toBe(target.id);
    // Segunda execução (p.ex. reconcile pós-crash após TX1): converge em
    // sucesso com o mesmo id — nunca linha duplicada, nunca failed.
    const second = await run({ accountId: target.id });
    expect(second.status).toBe('succeeded');
    expect(second.operationId).toBe(target.id);
  });

  it('(3) conta em uso falha determinística (in_use) — sem sucesso falso', async () => {
    const { writes } = harness();
    const acc = await writes.createAccount('w', { name: 'Movimentada', kind: 'bank', initialBalanceCents: 1000 });
    const cat = await writes.createCategory('w', { name: 'Deactivate Alvo Unica', kind: 'expense' });
    await writes.createExpense('w', {
      description: 'Compra', amountCents: 100, date: '2026-10-01',
      accountId: acc.id, categoryId: cat.id,
    }, { idempotencyKey: randomUUID() });
    await expect(
      requireApprovalToolContract('accounts.deactivate').executor({
        writes, workspaceId: 'w', args: { accountId: acc.id },
        idempotencyKey: randomUUID(), actorId: 'a',
      }),
    ).rejects.toMatchObject({ code: 'in_use' });
  });

  it('(4) policy: accounts.deactivate sempre require_confirmation; nunca auto_execute', () => {
    expect(AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.deactivate')).toBe(false);
    const contract = getApprovalToolContract('accounts.deactivate');
    expect(contract?.autoExecutionEligible).toBe(false);
    const policy = createApprovalPolicy();
    const decision = policy.evaluateMutation({
      tool: 'accounts.deactivate',
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

  it('(6) presentation: título "Desativar conta" + nome/tipo/saldo, acionável', () => {
    expect(derivePresentationTitle('accounts.deactivate')).toBe('Desativar conta');
    // 'Confirmar conta' do create permanece intocado.
    expect(derivePresentationTitle('accounts.create')).toBe('Confirmar conta');
    const presentation = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'accounts.deactivate',
      normalizedArgs: deactivateArgs(),
      expiresAt: '2026-10-21T13:00:00.000Z',
      accountLabel: 'Conta Corrente TED',
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.title).toBe('Desativar conta');
    expect(presentation!.account).toEqual({ id: ACCOUNT_ID, label: 'Conta Corrente TED' });
    expect(presentation!.accountKind).toBe('bank');
    expect(presentation!.balanceCents).toBe(12500);
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(true);
  });

  it('(6) presentation degrada honesto sem nome acionável em nenhum canal', () => {
    const presentation = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'accounts.deactivate',
      normalizedArgs: { accountId: ACCOUNT_ID },
      expiresAt: '2026-10-21T13:00:00.000Z',
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.account).toBeUndefined();
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(false);
  });

  it('(3) fail-closed: id inexistente com snapshot de nome nunca confirma (409) — sem recibo falso', async () => {
    // O executor converge `not_found` em sucesso (reconcile pós-crash após o
    // próprio write). Sem gate no confirm, um id que nunca existiu com um
    // snapshot accountName confirmaria e executaria até um recibo falso.
    // O gate exige o rótulo resolvido server-side (read model): snapshot
    // sozinho nunca é acionável.
    const { app } = harness([]);
    const ghostId = randomUUID();
    const proposed = await propose(app, randomUUID(), {
      tool: 'accounts.deactivate',
      normalizedArgs: { accountId: ghostId, accountName: 'Conta Fantasma' },
    });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;
    const confirmed = await app.inject({
      method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {},
    });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().code).toBe('approval.not_actionable');
    // Nível unidade: snapshot sem rótulo resolvido não é acionável.
    expect(isActionablePendingOperationPresentation({
      id: 'op-ghost',
      status: 'proposed',
      tool: 'accounts.deactivate',
      title: 'Desativar conta',
      accountName: 'Conta Fantasma',
      expiresAt: '2026-10-21T13:00:00.000Z',
      warnings: [],
    })).toBe(false);
  });

  it('(gap) undo não reverte accounts.deactivate: sem promessa de reversão', () => {    // Não existe writer de reativação; o undo falha fechado em vez de
    // prometer reversão em qualquer texto/recibo.
    expect(() => resolveUndoReceipt('accounts.deactivate', ACCOUNT_ID)).toThrow();
  });
});
