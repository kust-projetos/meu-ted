/**
 * accounts-deactivate-agent (TASK_ID: accounts-deactivate-agent) — fluxo
 * conversacional de DESATIVAÇÃO de conta no AGENT (intenção + rascunho
 * discriminado + proposta + executor + undo-verify), reutilizando a
 * maquinaria do MutationDraft.
 *
 * Contrato fixado (programado com mocks — a API ainda não aceita
 * `accounts.deactivate`): tool `accounts.deactivate`; normalizedArgs
 * `{ accountId: UUID }` (+accountName p/ apresentação); recibo
 * `{ mutationKind: 'accounts.deactivate', operationId, entity: { type:
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
  hasAccountDeactivationSignal,
  resolveDeactivationTarget,
} from '../src/mutations/account-deactivation.js';
import {
  UndoProposalService,
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  type UndoProposalRecord,
} from '../src/mutations/undo-proposal.js';

const ENT_NUBANK = '11111111-1111-4111-8111-111111111111';
const ENT_MERCADO = '22222222-2222-4222-8222-222222222222';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-deact',
  workspaceId: 'workspace-deact',
  role: 'member',
  deviceId: 'device-deact',
};

const ctx = {
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
};

const T0 = Date.parse('2026-10-21T12:00:00Z');

type AccountRow = { id: string; name: string };

const harness = (nowMs: number, accounts: AccountRow[]) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  let activeOp: Record<string, unknown> | null = null;
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      return {
        id: 'op-deact-1',
        existing: false,
        operation: { id: 'op-deact-1', expiresAt: new Date(now + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      return activeOp ? { items: [activeOp], total: 1 } : { items: [], total: 0 };
    }
    if (method === 'POST' && path === '/pending-operations/v2/op-deact-1/confirm') {
      return { id: 'op-deact-1', attestation: 'a'.repeat(32) };
    }
    if (method === 'POST' && path === '/pending-operations/v2/op-deact-1/execute') {
      return {
        id: 'op-deact-1',
        status: 'succeeded',
        execution: {
          status: 'succeeded',
          operationId: ENT_NUBANK,
          receipt: {
            mutationId: 'm-deact-1',
            mutationKind: 'accounts.deactivate',
            status: 'succeeded',
            affectedTargets: ['accounts'],
            operationId: 'op-deact-1',
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
    publishActiveOp: () => {
      activeOp = {
        id: 'op-deact-1',
        status: 'proposed',
        tool: 'accounts.deactivate',
        createdAt: new Date(T0).toISOString(),
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
      };
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const ACCOUNTS: AccountRow[] = [{ id: ENT_NUBANK, name: 'Nubank' }];

describe('accounts.deactivate intent signal', () => {
  it('(1) "desative a conta nubank" é candidato de desativação (não read/unsupported)', () => {
    expect(hasAccountDeactivationSignal('desative a conta nubank')).toBe(true);
  });

  it('"delete ela" é sinal de desativação (anáfora)', () => {
    expect(hasAccountDeactivationSignal('delete ela')).toBe(true);
  });

  it('não rouba leituras, criações nem mutações de transação', () => {
    expect(hasAccountDeactivationSignal('qual meu saldo?')).toBe(false);
    expect(hasAccountDeactivationSignal('criar conta nubank com saldo 145')).toBe(false);
    expect(hasAccountDeactivationSignal('gastei 50 no mercado')).toBe(false);
    expect(hasAccountDeactivationSignal('exclua a transação de ontem')).toBe(false);
    expect(hasAccountDeactivationSignal('cancela')).toBe(false);
  });
});

describe('accounts.deactivate draft flow', () => {
  it('(1) "desative a conta nubank" resolve o ID autoritativo e propõe (manual-only)', async () => {
    const h = harness(T0, ACCOUNTS);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'desative a conta nubank', intentionId: 'deact-t1' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    expect(r.mutation?.operationId).toBe('op-deact-1');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.deactivate');
    expect(body.normalizedArgs).toMatchObject({ accountId: ENT_NUBANK });
    const envelope = propose!.options as { idempotencyKey?: unknown };
    expect(typeof envelope.idempotencyKey).toBe('string');
    // A proposta exibe o NOME resolvido e nunca promete "desfazer".
    expect(r.response?.text).toMatch(/nubank/i);
    expect(r.response?.text).not.toMatch(/desfaz/i);
    // Rascunho consumido; NUNCA auto-executado (sem authorize/execute no turno).
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
    expect(h.calls.some((c) => c.path.endsWith('/execute'))).toBe(false);
  });

  it('(2) "delete ela" com 1 conta no contexto resolve a anáfora e propõe', async () => {
    const h = harness(T0, ACCOUNTS);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'delete ela', intentionId: 'deact-ana-1' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.deactivate');
    expect(body.normalizedArgs).toMatchObject({ accountId: ENT_NUBANK });
    expect(r.response?.text).toMatch(/nubank/i);
  });

  it('(2b) ambiguidade (2+ candidatos) esclarece com a lista, NUNCA adivinha', async () => {
    const h = harness(T0, [
      { id: ENT_NUBANK, name: 'Nubank' },
      { id: ENT_MERCADO, name: 'Mercado' },
    ]);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'delete ela', intentionId: 'deact-amb-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.response?.text).toMatch(/nubank/i);
    expect(r.response?.text).toMatch(/mercado/i);
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.deactivate');
    expect([...actives[0]!.missingFields]).toEqual(['accountId']);
    // Sem proposta, nenhuma pergunta de confirmação ("Responda sim").
    expect(r.response?.text).not.toMatch(/responda sim/i);
  });

  it('(2c) follow-up "nubank" após ambiguidade resolve e propõe', async () => {
    const h = harness(T0, [
      { id: ENT_NUBANK, name: 'Nubank' },
      { id: ENT_MERCADO, name: 'Mercado' },
    ]);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'delete ela', intentionId: 'deact-fup-1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'nubank', intentionId: 'deact-fup-2' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.normalizedArgs).toMatchObject({ accountId: ENT_NUBANK });
  });

  it('(2d) zero contas é limitação honesta, sem rascunho e sem proposta', async () => {
    const h = harness(T0, []);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'desative a conta nubank', intentionId: 'deact-empty-1' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
    expect(r.response?.text).toMatch(/nenhuma conta/i);
    expect(r.response?.text).not.toMatch(/responda sim/i);
  });

  it('(3) "sim" após proposta executa exatamente 1 desativação; "sim" sem proposta rejeita', async () => {
    const h = harness(T0, ACCOUNTS);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'desative a conta nubank', intentionId: 'deact-sim-1' }, identity),
    );
    h.publishActiveOp();
    h.advance(60_000);
    const confirmed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'deact-sim-2' }, identity),
    );
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-deact-1/execute')).toHaveLength(1);

    const h2 = harness(T0, ACCOUNTS);
    const lonely = await h2.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'deact-sim-lonely' }, identity),
    );
    expect(lonely.response?.text).toMatch(/nenhuma opera..o pendente para confirmar/i);
    expect(h2.calls.some((c) => c.path.endsWith('/execute'))).toBe(false);
  });

  it('(7) "cancela" com rascunho de desativação descarta o rascunho (semântica existente)', async () => {
    const h = harness(T0, [
      { id: ENT_NUBANK, name: 'Nubank' },
      { id: ENT_MERCADO, name: 'Mercado' },
    ]);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'delete ela', intentionId: 'deact-cancel-1' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(1);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'cancela', intentionId: 'deact-cancel-2' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 2000)).toHaveLength(0);
  });
});

describe('accounts.deactivate executor receipt', () => {
  const deactivationExecution = (overrides: Record<string, unknown> = {}) => ({
    status: 'succeeded',
    operationId: ENT_NUBANK,
    receipt: {
      mutationId: 'm-deact-1',
      mutationKind: 'accounts.deactivate',
      status: 'succeeded',
      affectedTargets: ['accounts'],
      operationId: 'op-deact-1',
      entity: { type: 'account', id: ENT_NUBANK },
      ...overrides,
    },
  });

  const executorWith = (execution: unknown) => {
    const request = vi.fn().mockImplementation(async () => ({
      id: 'op-deact-1',
      status: 'succeeded',
      execution,
    }));
    return new MutationExecutor({ request: request as never, events: () => undefined });
  };

  it('(4) aceita recibo de desativação de conta válido', async () => {
    const executor = executorWith(deactivationExecution());
    const out = await executor.execute(
      {
        operationId: 'op-deact-1',
        attestation: 'a'.repeat(32),
        identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
      },
      'token',
    );
    expect(out.status).toBe('succeeded');
    expect(out.receipt).toMatchObject({ mutationKind: 'accounts.deactivate' });
  });

  it('(4b) rejeita recibo trocado (entidade transaction / operationId divergente)', async () => {
    const swappedEntity = executorWith(
      deactivationExecution({ entity: { type: 'transaction', id: ENT_NUBANK } }),
    );
    await expect(
      swappedEntity.execute(
        {
          operationId: 'op-deact-1',
          attestation: 'b'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');

    const divergentOp = executorWith(deactivationExecution());
    await expect(
      divergentOp.execute(
        {
          operationId: 'op-other',
          attestation: 'c'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');
  });
});

describe('accounts.deactivate undo verify', () => {
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
        requestId: 'req-deact-1',
        workspaceId: baseIdentity.workspaceId,
        actorId: baseIdentity.actorId,
        deviceId: baseIdentity.deviceId,
        targetLastOperationId: 'op-deact-fixed-1',
        idempotencyKey: 'undo:ws-1:req-deact-1',
        status: 'proposed',
        createdAt: new Date(NOW - 60_000).toISOString(),
        expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
      }) as UndoProposalRecord,
    );
    const audit = vi.fn(async () => [
      {
        id: 'op-deact-fixed-1',
        workspaceId: 'ws-1',
        operation: 'accounts.deactivate',
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

  it('(5) verify falha fechado para alvo accounts.deactivate sem suporte real (sem promessa)', async () => {
    const { service, preview, api } = setup();
    const failure = await service.verify({
      requestId: 'req-deact-1',
      expectedEntity: { type: 'account', id: ENT_NUBANK },
      identity: baseIdentity,
    }).catch((error: unknown) => error);
    expect((failure as { code?: unknown }).code).toBe('undo.unsupported_operation');
    expect(preview).not.toHaveBeenCalled();
    expect(api.undo).not.toHaveBeenCalled();
  });
});

describe('accounts.deactivate resolution unit', () => {
  const rows = (list: AccountRow[]) => list;

  it('nome resolve para o ID autoritativo', () => {
    const out = resolveDeactivationTarget('desative a conta nubank', rows(ACCOUNTS));
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') expect(out.account.id).toBe(ENT_NUBANK);
  });

  it('anáfora com 1 conta resolve; com 2+ esclarece; com 0 é vazio', () => {
    const single = resolveDeactivationTarget('delete ela', rows(ACCOUNTS));
    expect(single.kind).toBe('resolved');
    const multi = resolveDeactivationTarget('delete ela', rows([
      { id: ENT_NUBANK, name: 'Nubank' },
      { id: ENT_MERCADO, name: 'Mercado' },
    ]));
    expect(multi.kind).toBe('ambiguous');
    const empty = resolveDeactivationTarget('delete ela', rows([]));
    expect(empty.kind).toBe('none');
  });
});
