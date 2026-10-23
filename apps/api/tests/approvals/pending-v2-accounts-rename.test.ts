/**
 * accounts.update (rename-only) no fluxo V2 — TDD RED.
 *
 * Contrato (ADR-029): normalizedArgs STRICT {accountId UUID, name trim
 * 1..120, expectedName nonempty}; somente active bank/cash; sem tipo/saldo;
 * manual-only (nunca autoexec). Propose valida schema + alvo/nome atual ==
 * expectedName antes de persistir nova; replay da mesma proposta retorna a
 * existente antes da validação mutável. Presentação "Renomear conta" com
 * account={id:target,label:expectedName} + accountName=new, acionável só com
 * alvo active + nome exato (nada inventado). Execute keyed com payload
 * {tool,args}; expectedName divergente → account.name_conflict.
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
import { isActionablePendingOperationPresentation } from '@pi-finance/llm-contracts';
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

const renameArgs = (accountId: string, name = 'Conta Nova', expectedName = 'Conta Velha') => ({
  accountId,
  name,
  expectedName,
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
      // Espelha o read-model real: só active bank/cash (cartoes e
      // inativas nunca aparecem nesta superfície).
      listAccounts: async (householdId: string) =>
        state.accounts.filter(
          (a) => a.householdId === householdId && a.status === 'active' && a.kind !== 'credit_card',
        ),
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

const seedAccount = async (h: ReturnType<typeof harness>, name = 'Conta Velha', kind = 'bank' as const) =>
  h.writes.createAccount('w', { name, kind, initialBalanceCents: 5000 });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/**
 * Variante do harness com listAccounts interceptável: recebe um hook
 * opcional chamado antes de cada leitura do read-model. Com porteira
 * (deferred) permite interleaving determinístico sem sleep — B estaciona
 * na validação mutável enquanto A propõe/executa com a mesma chave.
 */
const hookableHarness = (onListAccounts?: () => Promise<void>) => {
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
      listAccounts: async (householdId: string) => {
        if (onListAccounts) await onListAccounts();
        return state.accounts.filter(
          (a) => a.householdId === householdId && a.status === 'active' && a.kind !== 'credit_card',
        );
      },
      listCategories: async () => [],
    },
  });
  return { app, v2Store, state, writes };
};

describe('accounts.update registry (rename-only, manual-only)', () => {
  it('contrato registrado com schema estrito', () => {
    const contract = getApprovalToolContract('accounts.update');
    expect(contract).toBeDefined();
    expect(contract?.approvalRequired).toBe(true);
    expect(contract?.autoExecutionEligible).toBe(false);
    expect(AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.update')).toBe(false);
  });

  it('schema estrito rejeita campo extra, uuid ruim, nome vazio/longo e expectedName ausente', () => {
    const id = randomUUID();
    expect(validateApprovalToolArgs('accounts.update', { accountId: id, name: 'N', expectedName: 'V', extra: 1 } as never).success).toBe(false);
    expect(validateApprovalToolArgs('accounts.update', { accountId: 'nope', name: 'N', expectedName: 'V' }).success).toBe(false);
    expect(validateApprovalToolArgs('accounts.update', { accountId: id, name: '  ', expectedName: 'V' }).success).toBe(false);
    expect(validateApprovalToolArgs('accounts.update', { accountId: id, name: 'x'.repeat(121), expectedName: 'V' }).success).toBe(false);
    expect(validateApprovalToolArgs('accounts.update', { accountId: id, name: 'N' }).success).toBe(false);
    expect(validateApprovalToolArgs('accounts.update', { accountId: id, name: 'N', expectedName: 'V' }).success).toBe(true);
  });

  it('policy: sempre require_confirmation, nunca auto_execute', () => {
    const policy = createApprovalPolicy();
    const decision = policy.evaluateMutation({
      tool: 'accounts.update',
      workspaceId: 'w',
      destructive: false,
      complete: true,
      ambiguousEntity: false,
      duplicateSuspected: false,
      explicitIntent: true,
      amountCents: 1,
    });
    expect(decision.action).toBe('require_confirmation');
  });
});

describe('accounts.update propose (validação mutável + replay primeiro)', () => {
  it('propose feliz → 201', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const res = await propose(h.app, randomUUID(), { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    expect(res.statusCode).toBe(201);
  });

  it('replay da mesma proposta retorna a existente (200 mesmo id), não 409', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const key = randomUUID();
    const body = { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) };
    const first = await propose(h.app, key, body);
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;
    // Executa: o nome muda para "Conta Nova".
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${firstId}/confirm`, payload: {} });
    const att = (confirmed.json() as { attestation: string }).attestation;
    const executed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${firstId}/execute`, payload: { attestation: att } });
    expect(executed.statusCode).toBe(200);
    // Replay da MESMA proposta após o rename: retorna a existente.
    const replay = await propose(h.app, key, body);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { id: string }).id).toBe(firstId);
    expect((replay.json() as { existing: boolean }).existing).toBe(true);
  });

  it('mesma chave com args divergentes → 409 idempotency.conflict', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const key = randomUUID();
    const first = await propose(h.app, key, { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    expect(first.statusCode).toBe(201);
    const clash = await propose(h.app, key, {
      tool: 'accounts.update',
      normalizedArgs: renameArgs(acc.id, 'Outro Nome'),
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe('idempotency.conflict');
  });

  it('alvo desconhecido → 404, sem vazar existência', async () => {
    const h = harness();
    const res = await propose(h.app, randomUUID(), {
      tool: 'accounts.update',
      normalizedArgs: renameArgs(randomUUID(), 'Nova', 'Velha'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('alvo inativo → 404', async () => {
    const h = harness();
    const acc = await seedAccount(h, 'Conta Alvo');
    await h.writes.deactivateAccount('w', acc.id);
    const res = await propose(h.app, randomUUID(), {
      tool: 'accounts.update',
      normalizedArgs: renameArgs(acc.id, 'Nova', 'Conta Alvo'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('alvo cartão → 404 na rota (read-model não serve cartões)', async () => {
    const h = harness();
    const card = await h.writes.createAccount('w', { name: 'Visa', kind: 'credit_card' as never, initialBalanceCents: 0 });
    const res = await propose(h.app, randomUUID(), {
      tool: 'accounts.update',
      normalizedArgs: renameArgs(card.id, 'Visa Nova', 'Visa'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('executor em cartão → 400 validation.invalid (contrato bank/cash)', async () => {
    const h = harness();
    const card = await h.writes.createAccount('w', { name: 'Visa', kind: 'credit_card' as never, initialBalanceCents: 0 });
    await expect(
      requireApprovalToolContract('accounts.update').executor({
        writes: h.writes,
        workspaceId: 'w',
        args: renameArgs(card.id, 'Visa Nova', 'Visa'),
        idempotencyKey: randomUUID(),
        actorId: 'a',
      }),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
  });

  it('expectedName divergente → 409 account.name_conflict tipado', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const res = await propose(h.app, randomUUID(), {
      tool: 'accounts.update',
      normalizedArgs: renameArgs(acc.id, 'Conta Nova', 'Nome Errado'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('account.name_conflict');
  });
});

describe('accounts.update presentation + confirm gate', () => {
  it('card Renomear conta com De/Para, acionável quando exato', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    await propose(h.app, randomUUID(), { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    const active = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(active.statusCode).toBe(200);
    const item = (active.json() as { items: Array<{ presentation: Record<string, unknown> }> }).items[0]!;
    expect(item.presentation.title).toBe('Renomear conta');
    expect(item.presentation.account).toEqual({ id: acc.id, label: 'Conta Velha' });
    expect(item.presentation.accountName).toBe('Conta Nova');
    expect(isActionablePendingOperationPresentation(item.presentation as never)).toBe(true);
  });

  it('nome mudou após propose → card não acionável → confirm 409', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const proposed = await propose(h.app, randomUUID(), { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    const pendingId = (proposed.json() as { id: string }).id;
    await h.writes.updateAccount('w', acc.id, { name: 'Conta Interferente' });
    const active = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const item = (active.json() as { items: Array<{ presentation?: Record<string, unknown> }> }).items[0]!;
    expect(item.presentation === undefined || !isActionablePendingOperationPresentation(item.presentation as never)).toBe(true);
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().code).toBe('approval.not_actionable');
  });
});

describe('accounts.update execute + recovery (in-memory)', () => {
  const confirmExecute = async (h: ReturnType<typeof harness>, pendingId: string) => {
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    const att = (confirmed.json() as { attestation: string }).attestation;
    return h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`, payload: { attestation: att } });
  };

  it('execute renomeia, recibo accounts.update com entity do alvo, saldo intacto', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const proposed = await propose(h.app, randomUUID(), { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    const pendingId = (proposed.json() as { id: string }).id;
    const executed = await confirmExecute(h, pendingId);
    expect(executed.statusCode).toBe(200);
    const record = executed.json() as {
      status: string;
      execution: { status: string; operationId: string; receipt: Record<string, unknown> };
    };
    expect(record.status).toBe('succeeded');
    expect(record.execution.operationId).toBe(acc.id);
    expect(record.execution.receipt.mutationKind).toBe('accounts.update');
    expect(record.execution.receipt.operationId).toBe(pendingId);
    expect(record.execution.receipt.entity).toEqual({ type: 'account', id: acc.id });
    const renamed = h.state.accounts.find((a) => a.id === acc.id)!;
    expect(renamed.name).toBe('Conta Nova');
    expect(renamed.balanceCents).toBe(5000);
  });

  it('mesma chave + mesmos args no executor → mesmo id, sem novo efeito', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const run = (args: unknown, key: string) =>
      requireApprovalToolContract('accounts.update').executor({
        writes: h.writes,
        workspaceId: 'w',
        args,
        idempotencyKey: key,
        actorId: 'a',
      });
    const first = await run(renameArgs(acc.id), 'k-rename');
    const second = await run(renameArgs(acc.id), 'k-rename');
    expect(second.operationId).toBe(first.operationId);
    expect(h.state.accounts.filter((a) => a.id === acc.id)).toHaveLength(1);
    expect(h.state.accounts.find((a) => a.id === acc.id)!.name).toBe('Conta Nova');
  });

  it('recovery: crash após write + retry/execute retorna o id original', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const store = h.v2Store;
    const { computePendingOperationV2Hash } = await import('@pi-finance/llm-contracts');
    const base = {
      version: 2 as const, workspaceId: 'w', actorId: 'a', deviceId: 'd',
      tool: 'accounts.update', normalizedArgs: renameArgs(acc.id),
      proposalHash: '', idempotencyKey: 'k-rename-recovery',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bindings: { workspaceId: 'w', actorId: 'a', deviceId: 'd' },
    };
    const saved = await store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
    const confirmed = await store.confirm(saved.id, { workspaceId: 'w', actorId: 'a', deviceId: 'd' });
    const crashAfterWrite = async (operation: { workspaceId: string; normalizedArgs: unknown; idempotencyKey: string }) => {
      await requireApprovalToolContract('accounts.update').executor({
        writes: h.writes, workspaceId: operation.workspaceId, args: operation.normalizedArgs,
        idempotencyKey: operation.idempotencyKey, actorId: 'a',
      });
      throw new Error('crash-after-write');
    };
    await expect(
      store.execute(confirmed.attestation!, { workspaceId: 'w', actorId: 'a', deviceId: 'd' }, crashAfterWrite as never),
    ).rejects.toThrow('crash-after-write');
    expect(h.state.accounts.find((a) => a.id === acc.id)!.name).toBe('Conta Nova');
    const retried = await store.retry(saved.id, { workspaceId: 'w', actorId: 'a', deviceId: 'd' });
    const result = await store.execute(
      retried.attestation!, { workspaceId: 'w', actorId: 'a', deviceId: 'd' },
      (async (op: { tool: string; workspaceId: string; normalizedArgs: unknown; idempotencyKey: string; actorId: string }) =>
        requireApprovalToolContract(op.tool).executor({
          writes: h.writes, workspaceId: op.workspaceId, args: op.normalizedArgs,
          idempotencyKey: op.idempotencyKey, actorId: op.actorId,
        })) as never,
    );
    expect(result.status).toBe('succeeded');
    expect((result.execution as { operationId: string }).operationId).toBe(acc.id);
    expect(h.state.accounts.filter((a) => a.id === acc.id)).toHaveLength(1);
  });

  it('cancel → execute falha e nenhum efeito', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    const proposed = await propose(h.app, randomUUID(), { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    const pendingId = (proposed.json() as { id: string }).id;
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    const att = (confirmed.json() as { attestation: string }).attestation;
    const cancelled = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/cancel`, payload: {} });
    expect(cancelled.statusCode).toBe(200);
    const executed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`, payload: { attestation: att } });
    expect(executed.statusCode).toBe(403);
    expect(h.state.accounts.find((a) => a.id === acc.id)!.name).toBe('Conta Velha');
  });
});

describe('accounts.update propose replay race (barreiras determinísticas, sem sleep)', () => {
  it('B lookup-miss, A propõe+executa, B valida nome mudado → replay da existente (200 mesmo id)', async () => {
    const entered = deferred();
    const release = deferred();
    let gated = true;
    const h = hookableHarness(async () => {
      if (!gated) return;
      gated = false;
      entered.resolve();
      await release.promise;
    });
    const acc = await seedAccount(h);
    const key = randomUUID();
    const body = { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) };
    const bPromise = propose(h.app, key, body);
    await entered.promise;
    // A vence a corrida com a MESMA chave+args e executa o rename.
    const aFirst = await propose(h.app, key, body);
    expect(aFirst.statusCode).toBe(201);
    const aId = (aFirst.json() as { id: string }).id;
    const aConfirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${aId}/confirm`, payload: {} });
    expect(aConfirmed.statusCode).toBe(200);
    const aExecuted = await h.app.inject({
      method: 'POST', url: `/pending-operations/v2/${aId}/execute`,
      payload: { attestation: (aConfirmed.json() as { attestation: string }).attestation },
    });
    expect(aExecuted.statusCode).toBe(200);
    expect(h.state.accounts.find((a) => a.id === acc.id)!.name).toBe('Conta Nova');
    // B valida contra o estado pós-A: sem re-consulta seria 409.
    release.resolve();
    const bRes = await bPromise;
    expect(bRes.statusCode).toBe(200);
    expect((bRes.json() as { id: string }).id).toBe(aId);
    expect((bRes.json() as { existing: boolean }).existing).toBe(true);
  });

  it('B lookup-miss, alvo some (deactivate) após A, B valida ausente → replay da existente', async () => {
    const entered = deferred();
    const release = deferred();
    let gated = true;
    const h = hookableHarness(async () => {
      if (!gated) return;
      gated = false;
      entered.resolve();
      await release.promise;
    });
    const acc = await seedAccount(h);
    const key = randomUUID();
    const body = { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) };
    const bPromise = propose(h.app, key, body);
    await entered.promise;
    const aFirst = await propose(h.app, key, body);
    expect(aFirst.statusCode).toBe(201);
    const aId = (aFirst.json() as { id: string }).id;
    await h.writes.deactivateAccount('w', acc.id);
    release.resolve();
    const bRes = await bPromise;
    expect(bRes.statusCode).toBe(200);
    expect((bRes.json() as { id: string }).id).toBe(aId);
  });

  it('B lookup-miss, mesma chave com args divergentes de A → idempotency.conflict (não o erro mutável)', async () => {
    const entered = deferred();
    const release = deferred();
    let gated = true;
    const h = hookableHarness(async () => {
      if (!gated) return;
      gated = false;
      entered.resolve();
      await release.promise;
    });
    const acc = await seedAccount(h);
    const key = randomUUID();
    const bPromise = propose(h.app, key, { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id, 'Outra Nova') });
    await entered.promise;
    // A propõe com a MESMA chave mas args diferentes e executa.
    const aFirst = await propose(h.app, key, { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    expect(aFirst.statusCode).toBe(201);
    const aConfirmed = await h.app.inject({
      method: 'POST', url: `/pending-operations/v2/${(aFirst.json() as { id: string }).id}/confirm`, payload: {},
    });
    const aExecuted = await h.app.inject({
      method: 'POST', url: `/pending-operations/v2/${(aFirst.json() as { id: string }).id}/execute`,
      payload: { attestation: (aConfirmed.json() as { attestation: string }).attestation },
    });
    expect(aExecuted.statusCode).toBe(200);
    release.resolve();
    const bRes = await bPromise;
    // B validaria "Outra Nova" vs nome atual "Conta Nova"? Não: expectedName
    // de B é "Conta Velha" ≠ atual → sem re-consulta seria name_conflict;
    // com re-consulta é conflict (chave tomada com proposta divergente).
    expect(bRes.statusCode).toBe(409);
    expect(bRes.json().code).toBe('idempotency.conflict');
  });

  it('sem vencedor: outra chave existente não é replayada (erro original preservado)', async () => {
    const h = harness();
    const acc = await seedAccount(h);
    // Decoy com chave distinta.
    const decoy = await propose(h.app, randomUUID(), { tool: 'accounts.update', normalizedArgs: renameArgs(acc.id) });
    expect(decoy.statusCode).toBe(201);
    // B com chave nova e alvo desconhecido: 404, nunca o decoy.
    const res = await propose(h.app, randomUUID(), {
      tool: 'accounts.update',
      normalizedArgs: renameArgs(randomUUID(), 'Nova', 'Velha'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });
});
