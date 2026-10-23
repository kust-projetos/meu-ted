/**
 * accounts-draft-agent (TASK_ID: accounts-draft-agent) — fluxo conversacional
 * de cadastro de conta no AGENT (rascunho + slot-fill multi-turno + executor
 * + undo-verify), reutilizando a maquinaria do MutationDraft.
 *
 * Contrato fixado (programado com mocks — a API ainda não aceita
 * `accounts.create`): tool `accounts.create`; recibo
 * `{ mutationKind: 'accounts.create', operationId, entity: { type: 'account',
 * id } }`; NUNCA auto_execute; draft fields name/kind(bank|cash)/
 * initialBalanceCents (signed, zero/negativo OK); kind nunca inferido pelo
 * nome, EXCETO nomes de banco conhecido (KNOWN_BANK_NAMES: só "itau" —
 * exceção deliberada itau-kind-bank, autorizada pelo operador); idempotência derivada da intenção (mesmo mecanismo das transações).
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
  UndoProposalService,
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  type UndoProposalRecord,
} from '../src/mutations/undo-proposal.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-acct',
  workspaceId: 'workspace-acct',
  role: 'member',
  deviceId: 'device-acct',
};

const ctx = {
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
};

const reader = () => ({
  listAccounts: async () => [],
  listCategories: async () => [],
});

const mockClient = () => {
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as { body?: Record<string, unknown> }).body ?? {};
      return {
        id: 'op-acct-1',
        existing: false,
        summary: body.summary ?? 'Conta',
        operation: { id: 'op-acct-1', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api: new MutationApiClient({ request }), request, calls };
};

const harness = (nowMs: number) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  const { api, request, calls } = mockClient();
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
    entityReader: reader(),
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
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const T0 = Date.parse('2026-10-20T12:00:00Z');

describe('accounts.create draft flow', () => {
  it('(1) "criar conta nubank com saldo 145" vira candidato de mutação de CONTA (não read)', async () => {
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta nubank com saldo 145', intentionId: 'acct-t1' }, identity),
    );
    // Rascunho de conta criado, NUNCA auto-executado nem proposto ainda.
    expect(h.request).not.toHaveBeenCalled();
    expect(h.responseProvider).not.toHaveBeenCalled();
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    // Nome + saldo preenchidos; o kind NÃO foi assumido (perguntar, nunca inferir).
    expect(actives[0]!.resolvedArgs.accountName).toMatch(/nubank/i);
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBe(14500);
    expect(actives[0]!.missingFields).toEqual(['kind']);
    expect(r.response?.text).toMatch(/banco|espécie|especie/i);
    expect(r.clarification?.draft?.tool).toBe('accounts.create');
  });

  it('(2a) "quero" após oferta cria rascunho parcial de conta (orientação + rascunho)', async () => {
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero', intentionId: 'acct-want-1' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    expect([...actives[0]!.missingFields]).toEqual(
      expect.arrayContaining(['name', 'kind', 'initialBalanceCents']),
    );
    expect(r.response?.text).toMatch(/nome|saldo/i);
  });

  it('(2b) follow-up "nubank o saldo atual é 145" preenche name+balance, pergunta SÓ o kind, sem voltar à oferta', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero', intentionId: 'acct-want-2' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'nubank o saldo atual é 145', intentionId: 'acct-fill-2' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.accountName).toMatch(/nubank/i);
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBe(14500);
    expect(actives[0]!.missingFields).toEqual(['kind']);
    // Pergunta só o kind — sem copy de ausência/oferta ("não encontrei", "criar?").
    expect(r.response?.text).toMatch(/banco|espécie|especie/i);
    expect(r.response?.text).not.toMatch(/n[aã]o encontrei|quer criar|oferta/i);
  });

  it('(3) "qual meu saldo?" com rascunho ativo continua LEITURA (não consome o rascunho)', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta nubank com saldo 145', intentionId: 'acct-r3-t1' }, identity),
    );
    const before = h.store.listActive(ctx, T0 + 1000);
    expect(before).toHaveLength(1);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'qual meu saldo?', intentionId: 'acct-r3-t2' }, identity),
    );
    // Fluxo de leitura preservado: evidência lida, rascunho intacto, nada proposto.
    expect(h.evidenceProvider).toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    const after = h.store.listActive(ctx, T0 + 2000);
    expect(after).toHaveLength(1);
    expect(after[0]!.missingFields).toEqual(['kind']);
    expect(r.clarification?.draft).toBeUndefined();
  });

  it('(4) fluxo completo com kind propõe accounts.create com a chave derivada da intenção', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta nubank com saldo 145', intentionId: 'acct-full-t1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'conta no banco', intentionId: 'acct-full-t2' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    expect(h.request).toHaveBeenCalledTimes(1);
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.create');
    expect(body.normalizedArgs).toMatchObject({
      name: expect.stringMatching(/nubank/i),
      kind: 'bank',
      initialBalanceCents: 14500,
    });
    // Chave de idempotência derivada da intenção (mesmo mecanismo das
    // transações): viaja no envelope do propose, estável por rascunho.
    const envelope = propose!.options as { idempotencyKey?: unknown };
    expect(typeof envelope.idempotencyKey).toBe('string');
    const actives = h.store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      Date.parse('2026-10-20T12:00:05Z'),
    );
    expect(actives).toHaveLength(0);
    // Redelivery do turno de continuação converge sem segunda proposta.
    const redelivery = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'conta no banco', intentionId: 'acct-full-t2' }, identity),
    );
    expect(redelivery.mutation?.status).toBe('proposed');
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(1);
  });

  it('(4b) resposta curta "banco" com nome conhecido preenche kind=bank e propõe', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta teste copy com saldo 10', intentionId: 'acct-bare-t1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'banco', intentionId: 'acct-bare-t2' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.create');
    expect(body.normalizedArgs).toMatchObject({ kind: 'bank', initialBalanceCents: 1000 });
  });

  it('(4c) "Banco do Brasil" no turno fresh NÃO infere kind (pergunta preservada)', async () => {
    // NOTA (itau-kind-bank): exceção deliberada só para "Itaú"/"itau"
    // (KNOWN_BANK_NAMES); demais nomes seguem sem inferência.
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta Banco do Brasil com saldo 100', intentionId: 'acct-bb-t1' }, identity),
    );
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.accountName).toBe('Banco do Brasil');
    expect(actives[0]!.missingFields).toEqual(['kind']);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('(4d) repetir "Nubank" com nome conhecido NÃO preenche kind (sem inferência pelo nome)', async () => {
    // NOTA (itau-kind-bank, mudança deliberada autorizada pelo operador):
    // "Itaú"/"itau" é a ÚNICA exceção — nome de banco conhecido preenche
    // kind=bank via KNOWN_BANK_NAMES. "Nubank"/"Banco do Brasil" seguem sem
    // inferência (lista mínima: só Itaú neste diff).
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta Nubank com saldo 145', intentionId: 'acct-nr-t1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Nubank', intentionId: 'acct-nr-t2' }, identity),
    );
    // "Nubank" contém "bank" como substring, mas é nome — kind segue pendente.
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.missingFields).toEqual(['kind']);
    expect(h.request).not.toHaveBeenCalled();
    expect(r.response?.text).toMatch(/banco|espécie|especie/i);
  });

  it('(4e) "criar conta Itaú com saldo 145" preenche kind=bank pelo nome do banco (exceção deliberada)', async () => {
    // Exceção deliberada ao "nunca inferir pelo nome" (itau-kind-bank,
    // autorizada pelo operador): nome de banco conhecido (KNOWN_BANK_NAMES,
    // só "itau" neste diff) preenche kind=bank; o nome preserva a grafia
    // original ("Itaú").
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta Itaú com saldo 145', intentionId: 'acct-itau-t1' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.create');
    expect(body.normalizedArgs).toMatchObject({
      name: 'Itaú',
      kind: 'bank',
      initialBalanceCents: 14500,
    });
  });

  it('(4f) responder "Itaú" com kind faltante preenche kind=bank sem alterar nome/saldo', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta reserva com saldo 145', intentionId: 'acct-itau-c-t1' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 1000)[0]!.missingFields).toEqual(['kind']);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Itaú', intentionId: 'acct-itau-c-t2' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    // Nome e saldo originais preservados; só o kind foi preenchido.
    expect(body.normalizedArgs).toMatchObject({
      name: 'reserva',
      kind: 'bank',
      initialBalanceCents: 14500,
    });
  });

  it('(4g) "itau" minúsculo/sem acento também preenche kind=bank (pós-fold)', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta reserva com saldo 145', intentionId: 'acct-itau-f-t1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'itau', intentionId: 'acct-itau-f-t2' }, identity),
    );
    expect(r.mutation?.status).toBe('proposed');
    const propose = h.calls.find((c) => c.path === '/pending-operations/v2/propose');
    expect(propose).toBeDefined();
    const body = (propose!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.normalizedArgs).toMatchObject({
      name: 'reserva',
      kind: 'bank',
      initialBalanceCents: 14500,
    });
  });

  it('(7a) "cancela" com rascunho de conta descarta o rascunho (semântica existente)', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta nubank com saldo 145', intentionId: 'acct-c-t1' }, identity),
    );
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'cancela', intentionId: 'acct-c-t2' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 2000)).toHaveLength(0);
  });

  it('saldo zero e negativo são valores explícitos legítimos (nunca ausência)', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta reserva com saldo zero', intentionId: 'acct-z-t1' }, identity),
    );
    const zero = h.store.listActive(ctx, T0 + 1000);
    expect(zero).toHaveLength(1);
    expect(zero[0]!.resolvedArgs.initialBalanceCents).toBe(0);
    expect(zero[0]!.missingFields).toEqual(['kind']);

    const h2 = harness(T0);
    await h2.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta devedora com saldo negativo de 50', intentionId: 'acct-n-t1' }, identity),
    );
    const neg = h2.store.listActive(ctx, T0 + 1000);
    expect(neg).toHaveLength(1);
    expect(neg[0]!.resolvedArgs.initialBalanceCents).toBe(-5000);
    expect(neg[0]!.missingFields).toEqual(['kind']);
  });

  it('(7b) isolamento por identidade + expiração seguem a semântica do draft', async () => {    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta nubank com saldo 145', intentionId: 'acct-i-t1' }, identity),
    );
    const otherCtx = { ...ctx, actorId: 'other-actor' };
    expect(h.store.listActive(otherCtx, T0 + 1000)).toHaveLength(0);
    h.advance(16 * 60_000);
    expect(h.store.listActive(ctx, T0 + 16 * 60_000 + 1000)).toHaveLength(0);
  });
});

describe('accounts.create executor receipt', () => {
  const accountExecution = (overrides: Record<string, unknown> = {}) => ({
    status: 'succeeded',
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    receipt: {
      mutationId: 'm-acct-1',
      mutationKind: 'accounts.create',
      status: 'succeeded',
      affectedTargets: ['accounts'],
      operationId: 'op-acct-1',
      entity: { type: 'account', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      ...overrides,
    },
  });

  const executorWith = (execution: unknown) => {
    const request = vi.fn().mockImplementation(async () => ({
      id: 'op-acct-1',
      status: 'succeeded',
      execution,
    }));
    return new MutationExecutor({ request: request as never, events: () => undefined });
  };

  const createExpected = { tool: 'accounts.create' };

  it('(4a) aceita recibo de conta válido', async () => {
    const executor = executorWith(accountExecution());
    const out = await executor.execute(
      {
        operationId: 'op-acct-1',
        attestation: 'a'.repeat(32),
        identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
        expected: createExpected,
      },
      'token',
    );
    expect(out.status).toBe('succeeded');
    expect(out.receipt).toMatchObject({ mutationKind: 'accounts.create' });
  });

  it('(4b) rejeita recibo trocado (entidade transaction / operationId divergente)', async () => {
    const swappedEntity = executorWith(
      accountExecution({ entity: { type: 'transaction', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
    );
    await expect(
      swappedEntity.execute(
        {
          operationId: 'op-acct-1',
          attestation: 'b'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: createExpected,
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');

    const divergentOp = executorWith(accountExecution());
    await expect(
      divergentOp.execute(
        {
          operationId: 'op-other',
          attestation: 'c'.repeat(32),
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: createExpected,
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');
  });
});

describe('accounts.create undo verify', () => {
  type Sql = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };
  const ENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const NOW = Date.parse('2026-10-20T12:00:00.000Z');
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
      if (q.startsWith('INSERT INTO UNDO_PROPOSALS')) {
        const rows = tables.get('undo_proposals') ?? [];
        const [request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json] = bindings as Array<string | null>;
        if (rows.some((r) => r.request_id === request_id)) return [][Symbol.iterator]() as IterableIterator<T>;
        rows.push({ request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json });
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
        requestId: 'req-acct-1',
        workspaceId: baseIdentity.workspaceId,
        actorId: baseIdentity.actorId,
        deviceId: baseIdentity.deviceId,
        targetLastOperationId: 'op-acct-fixed-1',
        idempotencyKey: 'undo:ws-1:req-acct-1',
        status: 'proposed',
        createdAt: new Date(NOW - 60_000).toISOString(),
        expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
      }) as UndoProposalRecord,
    );
    const audit = vi.fn(async () => [
      {
        id: 'op-acct-fixed-1',
        workspaceId: 'ws-1',
        operation: 'accounts.create',
        effectRef: ENT_A,
        metadata: { entityId: ENT_A },
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

  it('(5) verify aceita expectedEntity { type: "account" } para operation accounts.create', async () => {
    const { service, preview, api } = setup();
    const out = await service.verify({
      requestId: 'req-acct-1',
      expectedEntity: { type: 'account', id: ENT_A },
      identity: baseIdentity,
    });
    expect(out).toMatchObject({ requestId: 'req-acct-1', matches: true });
    expect(preview).not.toHaveBeenCalled();
    expect(api.undo).not.toHaveBeenCalled();
  });
});
