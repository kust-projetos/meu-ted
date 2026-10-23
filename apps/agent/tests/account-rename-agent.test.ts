/**
 * ted-local-account-rename-client (TASK_ID ted-local-account-rename-client) —
 * fluxo conversacional de RENOMEAÇÃO de conta no AGENT (sinal + rascunho
 * discriminado + proposta + executor + undo-verify), reutilizando a
 * maquinaria do MutationDraft.
 *
 * Contrato fechado (architect, programado contra mocks — a API ainda não
 * aceita `accounts.update`): tool `accounts.update`; normalizedArgs
 * `{ accountId: UUID, name: trim 1..120 (novo), expectedName: nome canônico
 * exato atual }`; somente contas ativas bank/cash; recibo
 * `{ mutationKind: 'accounts.update', operationId, entity: { type:
 * 'account', id } }`; NUNCA auto_execute; chave de idempotência derivada
 * da intenção (mesmo mecanismo das transações).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';
import { MutationExecutor } from '../src/mutations/mutation-executor.js';
import {
  extractNewAccountName,
  hasAccountRenameSignal,
  resolveRenameTarget,
} from '../src/mutations/account-rename.js';
import {
  UndoProposalService,
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  type UndoProposalRecord,
} from '../src/mutations/undo-proposal.js';

const ENT_NUBANK = '11111111-1111-4111-8111-111111111111';
const ENT_MERCADO = '22222222-2222-4222-8222-222222222222';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-rename',
  workspaceId: 'workspace-rename',
  role: 'member',
  deviceId: 'device-rename',
};

const ctx = {
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
};

const T0 = Date.parse('2026-10-21T12:00:00Z');

type AccountRow = { id: string; name: string; isActive?: boolean; status?: string; kind?: string };

const harness = (nowMs: number, accounts: AccountRow[], opts?: { executeError?: unknown }) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  let activeOp: Record<string, unknown> | null = null;
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      return {
        id: 'op-rename-1',
        existing: false,
        operation: { id: 'op-rename-1', expiresAt: new Date(now + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      return activeOp ? { items: [activeOp], total: 1 } : { items: [], total: 0 };
    }
    if (method === 'POST' && path === '/pending-operations/v2/op-rename-1/confirm') {
      return { id: 'op-rename-1', attestation: 'a'.repeat(32) };
    }
    if (method === 'POST' && path === '/pending-operations/v2/op-rename-1/execute') {
      if (opts?.executeError !== undefined) throw opts.executeError;
      return {
        id: 'op-rename-1',
        status: 'succeeded',
        execution: {
          status: 'succeeded',
          operationId: ENT_NUBANK,
          receipt: {
            mutationId: 'm-rename-1',
            mutationKind: 'accounts.update',
            status: 'succeeded',
            affectedTargets: ['accounts'],
            operationId: 'op-rename-1',
            entity: { type: 'account', id: ENT_NUBANK },
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
  const responseProvider = vi.fn(async () => 'invented by model');
  const evidenceProvider = vi.fn(async () => ({
    version: '1' as const,
    items: [
      {
        ref: 'test',
        source: 'api.test',
        retrievedAt: new Date().toISOString(),
        status: 'empty' as const,
        data: [],
        reason: 'setup_incomplete' as const,
      },
    ],
  }) as never);
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { listAccounts: async () => accounts, listCategories: async () => [] },
    draftStore: store,
    draftNow: () => now,
    responseProvider,
    evidenceProvider,
    events: () => undefined,
  });
  return {
    store,
    request,
    calls,
    responseProvider,
    evidenceProvider,
    orchestrator,
    publishActiveOp: (tool = 'accounts.update', accountId?: string) => {
      activeOp = {
        id: 'op-rename-1',
        status: 'proposed',
        tool,
        ...(accountId !== undefined ? { accountId } : {}),
        createdAt: new Date(T0).toISOString(),
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
      };
    },
    setActiveOp: (op: Record<string, unknown> | null) => {
      activeOp = op;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const ACCOUNTS: AccountRow[] = [{ id: ENT_NUBANK, name: 'Nubank', kind: 'bank' }];

describe('accounts.update intent signal', () => {
  it('(1) "renomeie a conta nubank para itau" é candidato de renomeação (não read/unsupported)', () => {
    expect(hasAccountRenameSignal('renomeie a conta nubank para itau')).toBe(true);
  });

  it('não rouba leituras, criações, desativações nem mutações de transação', () => {
    expect(hasAccountRenameSignal('qual meu saldo?')).toBe(false);
    expect(hasAccountRenameSignal('criar conta nubank com saldo 145')).toBe(false);
    expect(hasAccountRenameSignal('desative a conta nubank')).toBe(false);
    expect(hasAccountRenameSignal('gastei 50 no mercado')).toBe(false);
    expect(hasAccountRenameSignal('atualize o saldo da conta nubank para 200')).toBe(false);
    expect(hasAccountRenameSignal('atualize o cartão nubank')).toBe(false);
    expect(hasAccountRenameSignal('cancela')).toBe(false);
  });
});

describe('accounts.update draft flow', () => {
  it('(1) "renomeie a conta nubank para nubank roxo" resolve o ID autoritativo e propõe (manual-only)', async () => {
    const h = harness(T0, ACCOUNTS);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank roxo', intentionId: 'rename-t1' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    expect(r.mutation?.operationId).toBe('op-rename-1');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.update');
    expect(body.normalizedArgs).toMatchObject({ accountId: ENT_NUBANK, name: 'nubank roxo', expectedName: 'Nubank' });
    const envelope = propose!.options as { idempotencyKey?: unknown };
    expect(typeof envelope.idempotencyKey).toBe('string');
    // A proposta exibe o NOME novo e nunca promete "desfazer".
    expect(r.response?.text).toMatch(/nubank roxo/i);
    expect(r.response?.text).not.toMatch(/desfaz/i);
    // Rascunho consumido; NUNCA auto-executado (sem authorize/execute no turno).
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
    expect(h.calls.some((c) => c.path.endsWith('/execute'))).toBe(false);
  });

  it('(2b) ambiguidade (2+ candidatos) esclarece com a lista, NUNCA adivinha', async () => {
    const h = harness(T0, [
      { id: ENT_NUBANK, name: 'Nubank', kind: 'bank' },
      { id: ENT_MERCADO, name: 'Mercado', kind: 'bank' },
    ]);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie ela para roxo', intentionId: 'rename-amb-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.response?.text).toMatch(/nubank/i);
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.update');
    // Sem proposta, nenhuma pergunta de confirmação ("Responda sim").
    expect(r.response?.text).not.toMatch(/responda sim/i);
  });

  it('(2c) nome novo ausente coleta multi-turn (não infere): "renomeie a conta nubank" pergunta o novo nome', async () => {
    const h = harness(T0, ACCOUNTS);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank', intentionId: 'rename-noname-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(r.response?.text).toMatch(/novo nome/i);
  });

  it('(2c2) follow-up com o novo nome propõe (multi-turn)', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank', intentionId: 'rename-fup-1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'nubank roxo', intentionId: 'rename-fup-2' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.update');
    expect(body.normalizedArgs).toMatchObject({ accountId: ENT_NUBANK, name: 'nubank roxo', expectedName: 'Nubank' });
  });

  it('(2d) mesmo nome responde "já está assim" sem proposta', async () => {
    const h = harness(T0, ACCOUNTS);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank', intentionId: 'rename-same-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
    expect(r.response?.text).toMatch(/já está/i);
  });

  it('(2e) conta inativa não resolve: esclarece sem propor', async () => {
    const h = harness(T0, [{ id: ENT_NUBANK, name: 'Nubank', kind: 'bank', isActive: false }]);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para roxo', intentionId: 'rename-inactive-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.response?.text).toMatch(/nenhuma conta/i);
  });

  it('(3) "sim" após proposta executa exatamente 1 renomeação; "sim" sem proposta rejeita', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank roxo', intentionId: 'rename-sim-1' }, identity),
    );
    h.publishActiveOp('accounts.update', ENT_NUBANK);
    h.advance(60_000);
    const confirmed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-sim-2' }, identity),
    );
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-rename-1/execute')).toHaveLength(1);

    const h2 = harness(T0, ACCOUNTS);
    const lonely = await h2.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-sim-lonely' }, identity),
    );
    expect(lonely.response?.text).toMatch(/nenhuma opera..o pendente para confirmar/i);
    expect(h2.calls.some((c) => c.path.endsWith('/execute'))).toBe(false);
  });

  it('(HIGH3) listing sem target (tool sem accountId) é inconclusivo com zero execute', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank roxo', intentionId: 'rename-nt-1' }, identity),
    );
    // Listing autoritativo sem o alvo: nenhum contexto para vincular.
    h.publishActiveOp('accounts.update');
    h.advance(60_000);
    const confirmed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-nt-2' }, identity),
    );
    expect(confirmed.mutation?.status).not.toBe('succeeded');
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-rename-1/execute')).toHaveLength(0);
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-rename-1/confirm')).toHaveLength(0);
  });

  it('(name_conflict) execute 409 responde falha determinística, sem retry cego nem nova proposta', async () => {
    const conflict = Object.assign(new Error('account.name_conflict'), {
      statusCode: 409,
      code: 'account.name_conflict',
    });
    const h = harness(T0, ACCOUNTS, { executeError: conflict });
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank roxo', intentionId: 'rename-nc-1' }, identity),
    );
    h.publishActiveOp('accounts.update', ENT_NUBANK);
    h.advance(60_000);
    const confirmed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-nc-2' }, identity),
    );
    expect(confirmed.mutation?.status).not.toBe('succeeded');
    // Falha determinística de stale: o nome mudou, diga de novo.
    expect(confirmed.response?.text).toMatch(/mudou|de novo|diverg/i);
    // NUNCA retry cego (1 execute só) nem chave nova automática (1 propose só).
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-rename-1/execute')).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(1);
  });

  it('(MED redelivery) mesma intenção após sucesso replays com expected, sem novo execute — mesmo com next pending', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank roxo', intentionId: 'rename-red-1' }, identity),
    );
    h.publishActiveOp('accounts.update', ENT_NUBANK);
    h.advance(60_000);
    const confirmed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-red-1b' }, identity),
    );
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(confirmed.mutation?.expected).toEqual({ tool: 'accounts.update', entityId: ENT_NUBANK });
    // Um next pending aparece; a redelivery da MESMA intenção replaya A —
    // nunca confirma B, nunca re-executa.
    h.setActiveOp({
      id: 'op-other-1',
      status: 'proposed',
      tool: 'transactions.expense.create',
      createdAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 11 * 60_000).toISOString(),
    });
    h.advance(60_000);
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-red-1b' }, identity),
    );
    expect(replayed.mutation?.status).toBe('succeeded');
    expect(replayed.mutation?.operationId).toBe('op-rename-1');
    expect(replayed.mutation?.expected).toEqual({ tool: 'accounts.update', entityId: ENT_NUBANK });
    expect(replayed.mutation?.receipt).toMatchObject({
      mutationKind: 'accounts.update',
      operationId: 'op-rename-1',
      entity: { type: 'account', id: ENT_NUBANK },
    });
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-rename-1/execute')).toHaveLength(1);
    expect(h.calls.some((c) => c.path.includes('op-other-1'))).toBe(false);
  });

  it('(MED redelivery) binding sensível sem recibo replays inconclusivo, sem falso sucesso', async () => {
    const h = harness(T0, ACCOUNTS);
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'rename-legacy-2',
      operationId: 'op-legacy-2',
      receiptJson: null,
      tool: 'accounts.update',
      entityId: ENT_NUBANK,
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-legacy-2' }, identity),
    );
    expect(replayed.mutation).toBeUndefined();
    expect(replayed.response?.text).toMatch(/não pôde ser confirmado/i);
    expect(h.calls.some((c) => String(c.path).endsWith('/execute'))).toBe(false);
  });

  it('(MED redelivery) legado sem tool e sem recibo = inconclusivo (sem prova, nunca sucesso)', async () => {
    const h = harness(T0, ACCOUNTS);
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'rename-legacy-1',
      operationId: 'op-legacy-1',
      receiptJson: null,
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-legacy-1' }, identity),
    );
    expect(replayed.mutation).toBeUndefined();
    expect(replayed.response?.text).toMatch(/não pôde ser confirmado/i);
    expect(h.calls.some((c) => String(c.path).endsWith('/execute'))).toBe(false);
  });

  it('(HIGH3) confirm com tool do listing divergente do recibo não conclui sucesso', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para nubank roxo', intentionId: 'rename-mismatch-1' }, identity),
    );
    // O listing autoriza outra tool: o recibo accounts.update do execute
    // não casa com o contexto esperado e falha fechado.
    h.publishActiveOp('transactions.expense.create');
    h.advance(60_000);
    const confirmed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'rename-mismatch-2' }, identity),
    );
    expect(confirmed.mutation?.status).not.toBe('succeeded');
  });

  it('(7) "cancela" com rascunho de renomeação descarta o rascunho (semântica existente)', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank', intentionId: 'rename-cancel-1' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(1);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'cancela', intentionId: 'rename-cancel-2' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 2000)).toHaveLength(0);
  });
});

describe('accounts.update executor receipt', () => {
  const renameExecution = (overrides: Record<string, unknown> = {}) => ({
    status: 'succeeded',
    operationId: ENT_NUBANK,
    receipt: {
      mutationId: 'm-rename-1',
      mutationKind: 'accounts.update',
      status: 'succeeded',
      affectedTargets: ['accounts'],
      operationId: 'op-rename-1',
      entity: { type: 'account', id: ENT_NUBANK },
      ...overrides,
    },
  });

  const executorWith = (execution: unknown, expected?: { tool: string; entityId?: string }) => {
    const request = vi.fn().mockImplementation(async () => ({
      id: 'op-rename-1',
      status: 'succeeded',
      execution,
    }));
    return new MutationExecutor({ request: request as never, events: () => undefined });
  };

  const renameExpected = { tool: 'accounts.update', entityId: ENT_NUBANK };

  it('(4) aceita recibo de renomeação válido', async () => {
    const executor = executorWith(renameExecution());
    const out = await executor.execute(
      {
        operationId: 'op-rename-1',
        attestation: 'a'.repeat(32),
        identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
        expected: renameExpected,
      },
      'token',
    );
    expect(out.status).toBe('succeeded');
    expect(out.receipt).toMatchObject({ mutationKind: 'accounts.update' });
  });

  it('(4b) rejeita recibo trocado (entidade transaction / operationId divergente)', async () => {
    const swappedEntity = executorWith(
      renameExecution({ entity: { type: 'transaction', id: ENT_NUBANK } }),
    );
    await expect(
      swappedEntity.execute(
        {
          operationId: 'op-rename-1',
          attestation: 'b'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: renameExpected,
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');

    const divergentOp = executorWith(renameExecution());
    await expect(
      divergentOp.execute(
        {
          operationId: 'op-other',
          attestation: 'c'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: renameExpected,
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');
  });

  it('(HIGH3) com expected: recibo de OUTRA conta (self-consistente) falha fechado', async () => {
    const otherAccount = '33333333-3333-4333-8333-333333333333';
    const executor = executorWith(
      {
        status: 'succeeded',
        operationId: otherAccount,
        receipt: {
          mutationId: 'm-rename-1',
          mutationKind: 'accounts.update',
          status: 'succeeded',
          affectedTargets: ['accounts'],
          operationId: 'op-rename-1',
          entity: { type: 'account', id: otherAccount },
        },
      },
      renameExpected,
    );
    // A resposta é internamente consistente (execution.operationId =
    // entity.id), mas o contexto autoritativo (expected) prova outra conta.
    await expect(
      executor.execute(
        {
          operationId: 'op-rename-1',
          attestation: 'd'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: renameExpected,
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');
  });

  it('(HIGH3) com expected: recibo transaction válido com o mesmo pendingId falha fechado', async () => {
    const txId = '44444444-4444-4444-8444-444444444444';
    const executor = executorWith(
      {
        status: 'succeeded',
        operationId: txId,
        receipt: {
          mutationId: 'm-tx-1',
          mutationKind: 'transactions.expense.create',
          status: 'succeeded',
          affectedTargets: ['transactions'],
          operationId: 'op-rename-1',
          entity: { type: 'transaction', id: txId },
        },
      },
      renameExpected,
    );
    await expect(
      executor.execute(
        {
          operationId: 'op-rename-1',
          attestation: 'e'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: renameExpected,
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');
  });

  it('(HIGH3) com expected: recibo fiel passa (happy)', async () => {
    const executor = executorWith(renameExecution(), renameExpected);
    const out = await executor.execute(
      {
        operationId: 'op-rename-1',
        attestation: 'f'.repeat(32),
        identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
        expected: renameExpected,
      },
      'token',
    );
    expect(out.status).toBe('succeeded');
    expect(out.receipt).toMatchObject({ mutationKind: 'accounts.update', operationId: 'op-rename-1' });
  });
});

describe('accounts.update undo verify', () => {
  type Sql = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const baseIdentity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };

  const createMemorySql = (): Sql & { tables: Map<string, Array<Record<string, unknown>>> } => {
    const tables = new Map<string, Array<Record<string, unknown>>>();
    const exec = <T,>(query: string, ...bindings: unknown[]): Iterable<T> => {
      const q = query.trim().toUpperCase();
      if (q.startsWith('CREATE TABLE')) {
        const name = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(query)?.[1] ?? 't';
        if (!tables.has(name)) tables.set(name, []);
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      if (q.startsWith('CREATE INDEX')) return [][Symbol.iterator]() as IterableIterator<T>;
      if (q.startsWith('PRAGMA')) return [][Symbol.iterator]() as IterableIterator<T>;
      if (q.startsWith('ALTER TABLE')) return [][Symbol.iterator]() as IterableIterator<T>;
      if (q.startsWith('INSERT INTO UNDO_PROPOSALS')) {
        const rows = tables.get('undo_proposals') ?? [];
        const cols12 = q.includes('TARGET_JSON');
        const [request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json] = bindings as Array<string | null>;
        if (rows.some((r) => r.request_id === request_id)) return [][Symbol.iterator]() as IterableIterator<T>;
        rows.push({ request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json, ...(cols12 ? { target_json: bindings[11] ?? null } : {}) });
        tables.set('undo_proposals', rows);
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      if (q.startsWith('SELECT * FROM UNDO_PROPOSALS WHERE REQUEST_ID')) {
        const rows = (tables.get('undo_proposals') ?? []).filter((r) => r.request_id === bindings[0]);
        return (rows as unknown as T[])[Symbol.iterator]();
      }
      if (q.startsWith('SELECT * FROM UNDO_PROPOSALS WHERE WORKSPACE_ID')) {
        const [workspaceId, actorId, deviceId] = bindings as [string, string, string];
        const rows = (tables.get('undo_proposals') ?? []).filter(
          (r) => r.workspace_id === workspaceId && r.actor_id === actorId && r.device_id === deviceId,
        );
        return (rows as unknown as T[])[Symbol.iterator]();
      }
      if (q.startsWith('UPDATE UNDO_PROPOSALS')) throw new Error('store mutation must never run during verify');
      throw new Error(`unsupported query in test shim: ${query}`);
    };
    return { exec, tables };
  };

  const setup = () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    store.insert(
      Object.freeze({
        requestId: 'req-rename-1',
        workspaceId: baseIdentity.workspaceId,
        actorId: baseIdentity.actorId,
        deviceId: baseIdentity.deviceId,
        targetLastOperationId: 'op-rename-fixed-1',
        idempotencyKey: 'undo:ws-1:req-rename-1',
        status: 'proposed',
        createdAt: new Date(NOW - 60_000).toISOString(),
        expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
      }) as UndoProposalRecord,
    );
    const audit = vi.fn(async () => [
      {
        id: 'op-rename-fixed-1',
        workspaceId: 'ws-1',
        operation: 'accounts.update',
        effectRef: ENT_NUBANK,
        metadata: { entityId: ENT_NUBANK },
        createdAt: new Date(NOW - 30_000).toISOString(),
      },
    ]);
    const preview = vi.fn(async () => ({ id: 'should-never-be-used' }));
    const api = { undo: vi.fn(async () => ({ undone: true })) };
    const deps = { store, preview, api, audit, now: () => NOW } as unknown as ConstructorParameters<
      typeof UndoProposalService
    >[0];
    return { service: new UndoProposalService(deps), preview, api };
  };

  it('(5) verify falha fechado para alvo accounts.update sem suporte real (sem promessa)', async () => {
    const { service, preview, api } = setup();
    const failure = await service.verify({
      requestId: 'req-rename-1',
      expectedEntity: { type: 'account', id: ENT_NUBANK },
      identity: baseIdentity,
    }).catch((error: unknown) => error);
    expect((failure as { code?: unknown }).code).toBe('undo.unsupported_operation');
    expect(preview).not.toHaveBeenCalled();
    expect(api.undo).not.toHaveBeenCalled();
  });
});

describe('accounts.update resolution unit', () => {
  const rows = (list: AccountRow[]) => list;

  it('nome resolve para o ID autoritativo', () => {
    const out = resolveRenameTarget('renomeie a conta nubank para roxo', rows(ACCOUNTS));
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') expect(out.account.id).toBe(ENT_NUBANK);
  });

  it('anáfora com 1 conta resolve; com 2+ esclarece; com 0 é vazio', () => {
    const single = resolveRenameTarget('renomeie ela para roxo', rows(ACCOUNTS));
    expect(single.kind).toBe('resolved');
    const multi = resolveRenameTarget('renomeie ela para roxo', rows([
      { id: ENT_NUBANK, name: 'Nubank', kind: 'bank' },
      { id: ENT_MERCADO, name: 'Mercado', kind: 'bank' },
    ]));
    expect(multi.kind).toBe('ambiguous');
    const empty = resolveRenameTarget('renomeie ela para roxo', rows([]));
    expect(empty.kind).toBe('none');
  });

  it('HIGH1: cartão de crédito nunca é elegível (kind explícito exigido)', () => {
    const card = resolveRenameTarget('renomeie a conta nubank para roxo', rows([
      { id: ENT_NUBANK, name: 'Nubank', kind: 'credit_card' },
    ]));
    expect(card.kind).toBe('none');
  });

  it('HIGH1: kind ausente nunca é elegível (bank/cash explícitos)', () => {
    const missing = resolveRenameTarget('renomeie a conta nubank para roxo', rows([
      { id: ENT_NUBANK, name: 'Nubank' },
    ]));
    expect(missing.kind).toBe('none');
  });
});

describe('accounts.update new-name separator (LOW5)', () => {
  it('"pra" separa o nome novo como "para"', () => {
    expect(extractNewAccountName('renomeie a conta nubank pra roxo')).toBe('roxo');
  });

  it('"paro" não é separador (nome ausente, nunca inventado)', () => {
    expect(extractNewAccountName('renomeie a conta paro')).toBeUndefined();
  });

  it('"praça" não é separador (prefixo de palavra maior)', () => {
    expect(extractNewAccountName('renomeie a conta praça')).toBeUndefined();
  });
});

describe('HIGH1: kind não-bancário no turno — zero propose, zero draft', () => {
  it('cartão de crédito no read: limitação honesta, sem rascunho e sem proposta', async () => {
    const h = harness(T0, [{ id: ENT_NUBANK, name: 'Nubank', kind: 'credit_card' }]);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para roxo', intentionId: 'rename-card-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
    expect(r.response?.text).toMatch(/nenhuma conta/i);
  });

  it('kind ausente no read: limitação honesta, sem rascunho e sem proposta', async () => {
    const h = harness(T0, [{ id: ENT_NUBANK, name: 'Nubank' }]);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank para roxo', intentionId: 'rename-nokind-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
    expect(r.response?.text).toMatch(/nenhuma conta/i);
  });
});

describe('HIGH2: imperativo de cartão com rascunho de rename — draft preservado, sem propose', () => {
  it('"crie cartao ..." com rename aguardando nome novo responde honesto e preserva o rascunho', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a conta nubank', intentionId: 'rename-h2-1' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(1);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie cartao Visa final1234 vencimento dia10', intentionId: 'rename-h2-2' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.response?.text).toMatch(/cart/i);
    // Rascunho preservado: continua aguardando só o nome novo.
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.update');
    expect([...actives[0]!.missingFields]).toEqual(['name']);
  });
});
