/**
 * Review6 — categorias.update (nome-only): 6 achados do reviewer independente
 * corrigidos com TDD comportamental (draft store SQLite real).
 *
 * F1 (P1) audiência privada: o rascunho nasce com o contexto canônico
 *      (`draftContext`, conversationId da conversa privada) — nunca com um
 *      contexto hand-made; a audiência vem SÓ do carimbo server-side (um
 *      `audience` no body é ignorado).
 * F2 (P2) intenção FRESH completa antes do slot: "renomeie categoria X para
 *      Y" durante um rascunho pendente inicia uma NOVA intenção (nunca
 *      renomeia o alvo antigo); token de decisão nunca vira nome literal.
 * F3 (P2) qualificador de kind: "de receita" NÃO faz fallback para uma
 *      categoria de despesa.
 * F4 (P2) contribuição contextual do ALVO: o follow-up nomeia o alvo e
 *      preserva o nome novo + o qualificador.
 * F5 (P2) recovery silencioso: serializer estrito `{categoryId,name,
 *      expectedName}` com a MESMA chave (nunca a tupla de transação) e o
 *      mapeamento durável preservado (não "discard 422").
 * F6 (P2) escritas pós-await guardadas por revisão + status: uma leitura
 *      obsoleta NUNCA muta terminalmente um rascunho já consumido.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import {
  buildDraftRecord,
  initializeMutationDraftSchema,
  SqlMutationDraftStore,
} from '../src/mutations/mutation-draft.js';

const CAT_VIAGEM = '33333333-3333-4333-8333-333333333333';
const CAT_MERCADO = '55555555-5555-4555-8555-555555555555';
const CAT_FEIRA = '66666666-6666-4666-8666-666666666666';
const CAT_VIAGEM_RECEITA = '77777777-7777-4777-8777-777777777777';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-r6',
  workspaceId: 'workspace-r6',
  role: 'member',
  deviceId: 'device-r6',
};

const T0 = Date.parse('2026-10-22T12:00:00Z');

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
  transactionSync?: <T>(fn: () => T) => T;
};

const createSql = (): { sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
    transactionSync: <T>(fn: () => T) => fn(),
  };
  initializeMutationDraftSchema(sql as never);
  return { sql };
};

type CategoryRow = {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  parentId?: string;
};

const DEFAULT_CATALOG: CategoryRow[] = [
  { id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active' },
  { id: CAT_MERCADO, name: 'QA Viagem Mercado', kind: 'expense', status: 'active' },
];

type Deferred = { promise: Promise<void>; resolve: () => void };

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const harness = (
  nowMs: number,
  options?: {
    catalog?: CategoryRow[];
    gateReads?: Deferred;
  },
) => {
  let now = nowMs;
  const catalog = options?.catalog ?? DEFAULT_CATALOG;
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql as never);
  const proposeCalls: Array<{ tool: string; normalizedArgs: unknown; idempotencyKey?: string }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, optionsArg: never) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (optionsArg as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
      proposeCalls.push({
        tool: body!.tool,
        normalizedArgs: body!.normalizedArgs,
        idempotencyKey: (optionsArg as unknown as { idempotencyKey?: string }).idempotencyKey,
      });
      const operationId = `op-r6-${proposeCalls.length}`;
      return {
        id: operationId,
        existing: false,
        summary: 'renomear a categoria',
        operation: { id: operationId, expiresAt: new Date(now + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: {
      listAccounts: async () => [],
      listCategories: async () => {
        if (options?.gateReads) await options.gateReads.promise;
        return catalog;
      },
    },
    draftStore: store,
    draftNow: () => now,
    responseProvider: vi.fn(async () => 'invented by model'),
    evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
    events: () => undefined,
  });
  return {
    store,
    orchestrator,
    proposeCalls,
    sql,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const ctxOf = (conversationId?: string) => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
  ...(conversationId ? { conversationId } : {}),
});

const privateAudience = (conversationId: string) => ({
  visibility: 'private' as const,
  ownerActorId: identity.actorId,
  conversationId,
});

describe('F1 (P1) rascunho de rename carrega a audiência canônica (conversa privada)', () => {
  it('(F1-1) rascunho privado NÃO é visível para a conversa coletiva nem para outra conversa privada', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Safira', intentionId: 'r6-f1-a' },
        identity,
        { audience: privateAudience('conv-A') },
      ),
    );
    const ctxA = ctxOf('conv-A');
    expect(h.store.listActive(ctxA, T0).length).toBe(1);
    // Coletivo (sem conversationId) não enxerga o rascunho privado.
    expect(h.store.listActive(ctxOf(), T0).length).toBe(0);
    // Outra conversa privada também não.
    expect(h.store.listActive(ctxOf('conv-B'), T0).length).toBe(0);
    expect(h.store.findByIntention(ctxOf('conv-B'), 'r6-f1-a')).toBeUndefined();
  });

  it('(F1-2) a MESMA conversa privada continua o próprio rascunho e propõe', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Safira', intentionId: 'r6-f1-a' },
        identity,
        { audience: privateAudience('conv-A') },
      ),
    );
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'QA Viagem Esmeralda', intentionId: 'r6-f1-b' },
        identity,
        { audience: privateAudience('conv-A') },
      ),
    );
    expect(result.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_VIAGEM,
      name: 'QA Viagem Esmeralda',
      expectedName: 'QA Viagem Safira',
    });
  });

  it('(F1-3) audiência enviada no body é IGNORADA (carimbo só server-side)', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn(
        {
          text: 'renomeie a categoria QA Viagem Safira',
          intentionId: 'r6-f1-c',
          // `audience` no body é NÃO AUTORIZADO (o adapter o ignora).
          audience: privateAudience('conv-FALSO'),
        } as never,
        identity,
      ),
    );
    // Sem carimbo server-side o rascunho é COLETIVO (nenhuma conversa presa).
    expect(h.store.listActive(ctxOf(), T0).length).toBe(1);
    expect(h.store.listActive(ctxOf('conv-FALSO'), T0).length).toBe(0);
  });
});

describe('F2 (P2) intenção FRESH completa tem precedência sobre o slot pendente', () => {
  it('(F2-1) "renomeie categoria B para C" durante rascunho pendente NÃO renomeia o alvo antigo', async () => {
    const h = harness(T0);
    // Rascunho pendente: alvo QA Viagem Safira, nome novo por vir.
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira', intentionId: 'r6-f2-a' }, identity),
    );
    expect(h.proposeCalls).toHaveLength(0);
    // Intenção FRESH completa: novo alvo + novo nome.
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Mercado para QA Viagem Feira', intentionId: 'r6-f2-b' },
        identity,
      ),
    );
    expect(result.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_MERCADO,
      name: 'QA Viagem Feira',
      expectedName: 'QA Viagem Mercado',
    });
  });

  it('(F2-2) token de decisão ("pode renomear") NUNCA vira nome literal', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira', intentionId: 'r6-f2-c' }, identity),
    );
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'pode renomear', intentionId: 'r6-f2-d' }, identity),
    );
    expect(h.proposeCalls).toHaveLength(0);
  });
});

describe('F3 (P2) qualificador explícito de kind não faz fallback', () => {
  it('(F3-1) "categoria de receita" não resolve uma categoria de despesa com o mesmo nome', async () => {
    const h = harness(T0, {
      catalog: [{ id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active' }],
    });
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria de receita QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'r6-f3-a' },
        identity,
      ),
    );
    expect(result.mutation).toBeUndefined();
    expect(h.proposeCalls).toHaveLength(0);
  });

  it('(F3-2) com homônimos, o qualificador escolhe a categoria do kind pedido', async () => {
    const h = harness(T0, {
      catalog: [
        { id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active' },
        { id: CAT_VIAGEM_RECEITA, name: 'QA Viagem Safira', kind: 'income', status: 'active' },
      ],
    });
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria de receita QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'r6-f3-b' },
        identity,
      ),
    );
    expect(result.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_VIAGEM_RECEITA,
      name: 'QA Viagem Esmeralda',
      expectedName: 'QA Viagem Safira',
    });
  });
});

describe('F4 (P2) contribuição contextual do alvo (rascunho sem alvo resolvido)', () => {
  it('(F4-1) o follow-up nomeia o ALVO e preserva o nome novo + o qualificador', async () => {
    const h = harness(T0);
    const first = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Inexistente para QA Viagem Esmeralda', intentionId: 'r6-f4-a' },
        identity,
      ),
    );
    expect(first.mutation).toBeUndefined();
    expect(h.proposeCalls).toHaveLength(0);
    const second = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'QA Viagem Safira', intentionId: 'r6-f4-b' }, identity),
    );
    expect(second.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_VIAGEM,
      name: 'QA Viagem Esmeralda',
      expectedName: 'QA Viagem Safira',
    });
  });

  it('(F4-2) comando estrangeiro como follow-up não propõe nem inventa nome', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Inexistente para QA Viagem Esmeralda', intentionId: 'r6-f4-c' },
        identity,
      ),
    );
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'liste minhas categorias', intentionId: 'r6-f4-d' }, identity),
    );
    expect(result.mutation).toBeUndefined();
    expect(h.proposeCalls).toHaveLength(0);
  });
});

describe('F5 (P2) recovery silencioso com args estritos e mesma chave', () => {
  it('(F5-1) rascunho proposing recovers com {categoryId,name,expectedName} e a MESMA chave (sem discard 422)', async () => {
    const h = harness(T0);
    // API com estado: a 1ª chamada COMMITTED (registra o mapeamento durável) e
    // depois lança (transport lost) — o rascunho fica `proposing` depois das
    // 2 tentativas do próprio turno; o recovery de um turno posterior
    // reproduz a operação commitada.
    const committed = new Map<string, { id: string; payload: string }>();
    let attempt = 0;
    const request = vi.fn().mockImplementation(async (method: string, path: string, optionsArg: never) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = (optionsArg as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
        const key = (optionsArg as unknown as { idempotencyKey?: string }).idempotencyKey ?? '';
        const payload = JSON.stringify(body?.normalizedArgs ?? {});
        attempt += 1;
        if (attempt === 1) committed.set(key, { id: 'op-cat-committed', payload });
        if (attempt <= 2) throw new Error('transport lost after commit');
        const saved = committed.get(key);
        if (!saved || saved.payload !== payload) throw new Error('keyed replay divergiu');
        return {
          id: saved.id,
          existing: true,
          summary: 'renomear a categoria',
          operation: { id: saved.id, expiresAt: new Date(T0 + 600_000).toISOString() },
        };
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
        return { firstSeenAt: new Date(T0).toISOString(), fresh: true, operationId: null };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const api = new MutationApiClient({ request: request as never });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { listAccounts: async () => [], listCategories: async () => DEFAULT_CATALOG },
      draftStore: h.store,
      draftNow: () => T0,
      responseProvider: vi.fn(async () => 'invented by model'),
      evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
      events: () => undefined,
    });
    // 1ª chamada: o propose COMMITTED e o transporte caiu → o rascunho fica
    // `proposing` com a CHAVE durável.
    await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'r6-f5-a' },
        identity,
      ),
    );
    const draft = h.store.findByIntention(ctxOf(), 'r6-f5-a');
    expect(draft?.status).toBe('proposing');
    const key = draft?.proposalIdempotencyKey ?? '';
    expect(key).not.toBe('');

    // 2º turno (outra intenção) dispara o recovery: a mesma chave + os MESMOS
    // args estritos devem reproduzir a operação commitada (não 422, não
    // discard).
    await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'r6-f5-b' },
        identity,
      ),
    );
    const proposeArgs = request.mock.calls
      .filter((call: unknown[]) => call[0] === 'POST' && call[1] === '/pending-operations/v2/propose')
      .map((call: unknown[]) => (call[2] as { body?: { tool: string; normalizedArgs: unknown }; idempotencyKey?: string }));
    expect(proposeArgs.length).toBeGreaterThanOrEqual(2);
    for (const args of proposeArgs) {
      expect(args.body?.tool).toBe('categories.update');
      expect(args.body?.normalizedArgs).toEqual({
        categoryId: CAT_VIAGEM,
        name: 'QA Viagem Esmeralda',
        expectedName: 'QA Viagem Safira',
      });
    }
    // Recovery reuses the durable key (no 422 / no discard).
    expect(proposeArgs.some((a) => a.idempotencyKey === key)).toBe(true);
    const recovered = h.store.findByIntention(ctxOf(), 'r6-f5-a');
    expect(recovered?.status).toBe('consumed');
    expect(recovered?.proposalId).toBe('op-cat-committed');
  });
});

describe('F6 (P2) escritas pós-await guardadas (revisão + status)', () => {
  it('(F6-1) leitura obsoleta NÃO muta terminalmente um rascunho já consumido por B', async () => {
    const gate = deferred();
    // Catálogo com a categoria de mesmo nome do novo nome → o A cai no
    // caminho "same-name" DEPOIS do await.
    const h = harness(T0, {
      catalog: [{ id: CAT_FEIRA, name: 'QA Viagem Feira', kind: 'expense', status: 'active' }],
      gateReads: gate,
    });
    // Rascunho sem alvo resolvido (o follow-up precisa do catálogo).
    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'r6-f6-a',
      tool: 'categories.update',
      resolvedArgs: {
        kind: 'category-rename',
        amountCents: 0,
        description: 'QA Viagem Feira',
        date: '',
        categoryName: 'QA Viagem Feira',
      },
      missingFields: ['categoryId'],
      question: 'Qual categoria devo renomear?',
      ttlMs: 600_000,
      nowMs: T0,
    });
    h.store.getOrCreate(draft);
    const pending = h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Feira', intentionId: 'r6-f6-a2' },
        identity,
      ),
    );
    // B consome o rascunho enquanto A aguarda a leitura do catálogo.
    await new Promise((resolve) => setImmediate(resolve));
    const consumed = h.store.update(draft.draftId, {
      status: 'consumed',
      proposalId: 'op-b',
      updatedAt: new Date(T0 + 1000).toISOString(),
    });
    expect(consumed?.status).toBe('consumed');
    gate.resolve();
    await pending;
    const after = h.store.get(draft.draftId);
    // O rascunho continua terminal com a proposta de B — A não descartou.
    expect(after?.status).toBe('consumed');
    expect(after?.proposalId).toBe('op-b');
    expect(h.proposeCalls).toHaveLength(0);
  });

  it('(F6-2) redelivery terminal de A com B ATIVO devolve a proposta de A e não mexe em B', async () => {
    const h = harness(T0);
    const a = normalizeRestTurn(
      { text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'r6-f6-c' },
      identity,
    );
    const first = await h.orchestrator.runTurn(a);
    expect(first.mutation?.operationId).toBe('op-r6-1');
    // B nasce DEPOIS (rascunho ativo, aguardando o nome novo).
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Mercado', intentionId: 'r6-f6-d' }, identity),
    );
    const activeBefore = h.store.listActive(ctxOf(), T0);
    expect(activeBefore.length).toBe(1);
    // Redelivery terminal de A: converge na proposta de A, sem tocar em B.
    const replay = await h.orchestrator.runTurn(a);
    expect(replay.mutation?.operationId).toBe('op-r6-1');
    expect(h.proposeCalls).toHaveLength(1);
    const activeAfter = h.store.listActive(ctxOf(), T0);
    expect(activeAfter.length).toBe(1);
    expect(activeAfter[0]!.draftId).toBe(activeBefore[0]!.draftId);
    expect(activeAfter[0]!.status).toBe('active');
  });
});
