/**
 * A16/R15 follow-up — o `JudgmentProvider` LIGADO no hot path (G04 default-off).
 *
 * A fronteira de `judgment/provider.ts` existia sem NENHUM consumidor real: o
 * accessor `FinanceChatAgent.judgmentProvider()` era só a costura. G04 foi
 * resolvido como "default-off com wiring completo"
 * (docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md §1),
 * e este arquivo fecha a última metade: um ponto de decisão DELIMITADO do
 * orquestrador consulta o judge, e o valor determinístico continua autoritativo
 * em todos os caminhos.
 *
 * O ponto escolhido é a relação de continuação do rascunho
 * (`continuationRelation`: "correção" | "negação" | "continuação"), uma
 * classificação puramente COMPORTAMENTAL resolvida hoje por heurística de
 * regex. O pedido ao judge é montado a partir de FATOS ESTRUTURAIS (o rascunho
 * está ativo, quantos campos faltam, se o texto tinha marcador de negação, o que
 * a heurística decidiu) — nunca do texto do usuário, valor, data, descrição,
 * categoria ou id de conta. O que o judge devolve é `advisory: true` por
 * construção e só muda `source`: o valor gravado é sempre o determinístico.
 *
 * O que estes testes provam, por ordem de risco:
 * - default-off (envs ausentes) ⇒ turno BYTE A BYTE idêntico ao de hoje,
 *   zero rede, zero evento novo;
 * - o payload ao judge não carrega estado financeiro;
 * - timeout / 401 / malformado / escolha fora da allowlist / circuito aberto /
 *   teto por turno ⇒ fallback determinístico, sem conceder sucesso ou
 *   permissão (AC25);
 * - uma resposta do judge CONTRÁRIA ao determinístico não muda o resultado;
 * - a escrita financeira guarded (correção de valor) não espera o judge.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import {
  createJudgmentProvider,
  type JudgmentEnv,
  type JudgmentProvider,
} from '../../src/judgment/provider.js';
import {
  CONTINUATION_RELATION_QUESTION,
  continuationRelationJudgmentRequest,
} from '../../src/judgment/wiring.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  type MutationDraftRecord,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';

const NOW_MS = Date.parse('2026-09-14T18:00:00.000Z');

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

const reader: EntityReader = {
  listAccounts: async () => [NUBANK, ITAU],
  listCategories: async () => [MERCADO],
};

const enabledEnv: JudgmentEnv = {
  TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
  TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
};

const okResponse = (choice: unknown) =>
  new Response(JSON.stringify({ choice, rationale: 'parece continuação', confidence: 0.9 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const ctxOf = () => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
});

/**
 * API fake SOMENTE de leitura: nenhuma mutação financeira pode acontecer neste
 * arquivo, então qualquer escrita vira erro explícito (o teste falha no lugar
 * certo em vez de passar com um propose silencioso).
 */
const readOnlyApi = () => {
  const writes: string[] = [];
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET') {
      if (path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(`unexpected read ${path}`);
    }
    writes.push(`${method} ${path}`);
    throw new Error('financial.mutation.must_not_happen');
  });
  return { api: new MutationApiClient({ request }), writes };
};

type Harness = Readonly<{
  store: MutationDraftStore;
  draftId: string;
  draft: () => MutationDraftRecord;
  writes: string[];
  events: Array<{ eventType: string; fields: Record<string, unknown> }>;
  judgmentEvents: () => Array<{ eventType: string; fields: Record<string, unknown> }>;
  first: Awaited<ReturnType<ConversationOrchestrator['runTurn']>>;
  second: Awaited<ReturnType<ConversationOrchestrator['runTurn']>>;
  run: (text: string, intentionId: string, traceId?: string) => Promise<unknown>;
}>;

const NEGATION_TEXT = 'não';

const harness = async (options: { provider?: JudgmentProvider } = {}): Promise<Harness> => {
  const store = new InMemoryMutationDraftStore();
  const fake = readOnlyApi();
  const events: Array<{ eventType: string; fields: Record<string, unknown> }> = [];
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: fake.api,
    entityReader: reader,
    draftStore: store,
    draftNow: () => NOW_MS,
    events: (eventType, fields) => {
      events.push({ eventType, fields });
    },
    // Ausente = nenhum judge é consultado (accessor não instalado).
    ...(options.provider
      ? { judgmentProvider: () => options.provider }
      : {}),
  });
  const run = async (text: string, intentionId: string, traceId?: string) =>
    orchestrator.runTurn(normalizeRestTurn({ text, intentionId, ...(traceId ? { traceId } : {}) }, identity));
  const first = await run('Gastei R$ 50 no mercado', 'jw-open-1');
  const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
  const second = await run(NEGATION_TEXT, 'jw-neg-1');
  return {
    store,
    draftId,
    draft: () => store.get(draftId)!,
    writes: fake.writes,
    events,
    judgmentEvents: () => events.filter((event) => event.eventType === 'judgment.consulted'),
    first,
    second,
    run,
  };
};

/** The negotiation turn is the deterministic value under judgment in every case. */
const expectDeterministicNegation = (state: Harness): void => {
  const record = state.draft();
  expect(record.relations).toContain('negation');
  expect(record.relations).not.toContain('continuation');
  expect(record.relations).not.toContain('correction');
  expect(record.resolvedArgs.amountCents).toBe(5000);
  expect((state.second as { mutation?: unknown }).mutation).toBeUndefined();
  expect(state.second.clarification?.text).toBeTruthy();
  expect(state.writes).toEqual([]);
};

describe('A16/R15 — JudgmentProvider ligado ao hot path do orquestrador', () => {
  it('default-off: envs ausentes ⇒ turno BYTE A BYTE idêntico ao de hoje e zero rede', async () => {
    const fetchImpl = vi.fn();
    const baseline = await harness();
    const wired = await harness({ provider: createJudgmentProvider({ fetchImpl: fetchImpl as unknown as typeof fetch }) });

    expect(JSON.stringify(wired.first)).toBe(JSON.stringify(baseline.first));
    expect(JSON.stringify(wired.second)).toBe(JSON.stringify(baseline.second));
    expect(JSON.stringify(wired.draft())).toBe(JSON.stringify(baseline.draft()));
    // Nenhum evento novo: nem sequer o registro do judge, porque ele não existe.
    expect(wired.events.map((event) => event.eventType)).toEqual(baseline.events.map((event) => event.eventType));
    expect(wired.judgmentEvents()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consulta o judge no desempate da relação do rascunho', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.judgmentEvents()).toHaveLength(1);
    expect(state.judgmentEvents()[0]!.fields).toMatchObject({
      operation: 'jev_decide',
      status: 'decision',
      source: 'judgment_advisory',
      choice: 'continuation',
      deterministicRelation: 'negation',
    });
  });

  it('resposta CONTRÁRIA do judge não muda o valor determinístico (AC25)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expectDeterministicNegation(await harness({ provider }));
  });

  it('o pedido ao judge NÃO carrega estado financeiro', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('negation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });

    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.operation).toBe('jev_decide');
    expect(body.model).toBe('judgment-model-v1');
    expect(body.options).toEqual(['correction', 'negation', 'continuation']);
    // Estado estrutural: chaves fechadas, sem texto, valor, data ou entidade.
    expect(Object.keys(JSON.parse(body.state as string) as Record<string, unknown>).sort()).toEqual([
      'activeDraft',
      'deterministicRelation',
      'draftStatus',
      'negationMarker',
      'pendingFieldCount',
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/nubank|ita[uú]|mercado|carne|5000|r\$/i);
    expect(serialized).not.toMatch(/amountCents|accountId|categoryId|description|date/i);
    // Nem o texto do usuário, nem o identificador do rascunho ou da operação.
    // A pergunta é a CONSTANTE do wiring (não deriva do turno), e o estado
    // estrutural não carrega nenhuma palavra do usuário.
    expect(body.question).toBe(CONTINUATION_RELATION_QUESTION);
    const stateText = body.state as string;
    expect(stateText).not.toContain(NEGATION_TEXT);
    expect(stateText).not.toContain('Gastei');
    expect(stateText).not.toMatch(/mercado|nubank|5000/i);
    expect(state.writes).toEqual([]);
    // A chave do TURNO (que é o que o teto por turno mede) fica no pedido, mas
    // NÃO vai para a rede: ela é a identidade local do turno, não conteúdo.
    expect(continuationRelationJudgmentRequest({
      turnId: 'jw-neg-1',
      draftStatus: 'active',
      pendingFieldCount: 2,
      negationMarker: true,
      deterministicRelation: 'negation',
    })).toMatchObject({ turnId: 'jw-neg-1', operation: 'jev_decide' });
  });

  it('uma escrita financeira guarded (correção de valor) não espera o judge', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });
    // Turno de correção: a relação determinística já é `correction` e a escrita
    // do rascunho é o caminho com trava de revisão — o judge não entra nele.
    await state.run('não, 500', 'jw-neg-2');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.draft().resolvedArgs.amountCents).toBe(50000);
    expect(state.writes).toEqual([]);
  });

  const failureCases: readonly Readonly<{
    name: string;
    fetchImpl: () => Promise<Response>;
    timeoutMs?: number;
    reason: string;
  }>[] = [
    {
      name: '401 (credencial recusada)',
      fetchImpl: async () => new Response('{}', { status: 401 }),
      reason: 'unauthorized',
    },
    {
      name: 'resposta malformada',
      fetchImpl: async () => new Response('<html>não é json</html>', { status: 200, headers: { 'content-type': 'application/json' } }),
      reason: 'malformed_response',
    },
    {
      name: 'escolha fora da allowlist',
      fetchImpl: async () => okResponse('aprovar_lancamento'),
      reason: 'choice_outside_allowlist',
    },
    {
      name: 'erro de transporte',
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
      reason: 'transport_error',
    },
    {
      name: 'timeout',
      fetchImpl: () => new Promise<Response>(() => undefined),
      timeoutMs: 25,
      reason: 'timeout',
    },
  ];

  for (const failure of failureCases) {
    it(`fallback determinístico com ${failure.name}`, async () => {
      const fetchImpl = vi.fn().mockImplementation(failure.fetchImpl);
      const provider = createJudgmentProvider({
        env: enabledEnv,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...(failure.timeoutMs !== undefined ? { timeoutMs: failure.timeoutMs } : {}),
      });
      const state = await harness({ provider });
      expectDeterministicNegation(state);
      expect(state.judgmentEvents()[0]!.fields).toMatchObject({
        status: 'abstained',
        reason: failure.reason,
        source: 'deterministic',
      });
    });
  }

  it('o teto de 1 chamada por turno é ligado pelo wiring (mesmo turnId não gasta duas)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Segundo turno com a MESMA chave de turno: o provider recusa, o wiring não contorna.
    await state.run(NEGATION_TEXT, 'jw-neg-3', 'jw-neg-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const last = state.judgmentEvents().at(-1)!;
    expect(last.fields).toMatchObject({ status: 'unavailable', reason: 'turn_budget_exhausted' });
    expectDeterministicNegation(state);
  });

  it('o breaker interrompe a consulta depois de 2 falhas consecutivas', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('{}', { status: 500 }));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });
    await state.run(NEGATION_TEXT, 'jw-neg-4');
    await state.run(NEGATION_TEXT, 'jw-neg-5');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Terceiro turno do MESMO DO: circuito aberto, nenhuma chamada nova.
    await state.run(NEGATION_TEXT, 'jw-neg-6');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.judgmentEvents().at(-1)!.fields).toMatchObject({
      status: 'unavailable',
      reason: 'circuit_open',
    });
    expectDeterministicNegation(state);
  });

  it('o accessor ausente é fail-closed: nenhum judge, nenhum desvio', async () => {
    const state = await harness();
    expect(state.judgmentEvents()).toEqual([]);
    expectDeterministicNegation(state);
  });

  it('o accessor do DO é chamado uma vez por turno e a instância é reutilizada', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const accessor = vi.fn(() => provider);
    const store = new InMemoryMutationDraftStore();
    const fake = readOnlyApi();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: fake.api,
      entityReader: reader,
      draftStore: store,
      draftNow: () => NOW_MS,
      events: () => undefined,
      judgmentProvider: accessor,
    });
    const run = (text: string, intentionId: string) =>
      orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
    await run('Gastei R$ 50 no mercado', 'jw-do-1');
    await run(NEGATION_TEXT, 'jw-do-2');
    await run(NEGATION_TEXT, 'jw-do-3');
    // Um acesso por consulta e NENHUMA instanciação dentro do wiring: o judge que
    // vale é sempre a instância do DO (teto e breaker por workspace).
    expect(accessor).toHaveBeenCalledTimes(2);
    expect(accessor.mock.results.every((result) => result.value === provider)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});