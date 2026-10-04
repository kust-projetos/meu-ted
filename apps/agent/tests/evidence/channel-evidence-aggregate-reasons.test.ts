/**
 * A09/A04(b) + A19 — o produtor de `workspace_empty` no COLETOR do turno, a
 * dívida de reason do mapper singleton e a preservação da reason tipada no
 * catch externo do envelope agregado.
 *
 * Três dívidas caracterizadas antes de mudar qualquer coisa:
 *
 * 1. `workspace_empty` estava no vocabulário de ausência com PRODUTOR
 *    AUSENTE: o coletor só conseguia dizer "não há nada NESTA leitura" e o
 *    envelope agregado nunca afirmava o estado real do workspace.
 * 2. `mapSingleton` (statements/payables/budgets/goals/categories) emitia
 *    `{status:'empty', data:[]}` SEM reason — a leitura tinha sucesso, mas o
 *    item chegava ao prompt e ao renderizador como um "não-claim" genérico,
 *    indistinguível de uma ausência sem leitura.
 * 3. O catch externo que envolve `createEvidenceEnvelope(settled.flat())`
 *    fixava `reason:'unavailable'`, apagando qualquer reason tipada.
 *
 * Regra que NÃO pode quebrar: uma FALHA nunca agrega para `workspace_empty`
 * (R04 — "a leitura quebrou" jamais pode ser narrado como "não há nada lá"),
 * e uma leitura de escopo estreito que provou `period_empty`/`category_empty`/
 * `filter_empty` PROVA que existe dado fora do escopo consultado — logo ela
 * bloqueia a afirmação global.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createEvidenceEnvelope,
  resolveEnvelopeRejection,
  serializeEvidenceForPrompt,
  type EvidenceEnvelope,
} from '../../src/evidence/evidence-envelope.js';
import { createChannelGrounding, type ChannelReadTools } from '../../src/orchestration/channel-evidence.js';
import type { TurnInput, TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';
import * as apiClient from '../../src/tools/api-client.js';

const input: TurnInput = {
  intentionId: 'intent-a09-aggregate',
  traceId: 'intent-a09-aggregate',
  text: 'como está meu workspace?',
  actorId: 'actor-a09-aggregate',
  workspaceId: 'ws-a09-aggregate',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
};

const planFor = (operations: readonly string[], domain: TurnPlan['domain'] = 'general'): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain,
  skillNames: ['s'],
  requestedOperations: operations.map((name) => ({ name, kind: 'read' as const })),
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const readTools = (overrides: Partial<ChannelReadTools>): ChannelReadTools => {
  const unused = async () => { throw new Error('read.not_planned'); };
  return {
    listAccounts: unused,
    listRecentTransactions: unused,
    getMonthSummary: unused,
    listStatements: unused,
    listAccountsPayable: unused,
    listBudgets: unused,
    listGoals: unused,
    listCategories: unused,
    analyticsKpis: unused,
    analyticsCategoryBreakdown: unused,
    ...overrides,
  } as ChannelReadTools;
};

const httpError = (statusCode: number): Error =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, code: 'api.request_failed' });

const envelopeFor = async (plan: TurnPlan, tools: Partial<ChannelReadTools>): Promise<EvidenceEnvelope> => {
  const grounding = createChannelGrounding({ respond: async () => 'unused', readTools: readTools(tools) });
  const envelope = await grounding.evidenceProvider(input, plan);
  if (!envelope) throw new Error('envelope.expected');
  return envelope;
};

const reasonsOf = (envelope: EvidenceEnvelope): unknown[] =>
  envelope.items.map((item) => (item.status === 'ok' ? undefined : item.reason));

describe('A09/A04(b): `workspace_empty` tem produtor no coletor do turno', () => {
  it('RED: dois escopos independentes vazios agregam workspace_empty', async () => {
    // `get_balance` (accounts) + fallback do domínio `transactions`: duas
    // leituras DISTINTAS, ambas provando ausência. Só um snapshot
    // consistente multi-read sustenta a afirmação global (A04 bloco b).
    const envelope = await envelopeFor(planFor(['get_balance'], 'transactions'), {
      listAccounts: async () => ({ items: [] }),
      listRecentTransactions: async () => ({ items: [] }),
    });
    expect(reasonsOf(envelope)).toContain('workspace_empty');
    // A afirmação agregada é ADITIVA: ela não reescreve o que cada leitura
    // provou no seu próprio escopo.
    const accounts = envelope.items.find((item) => item.ref === 'accounts');
    expect(accounts?.reason).toBe('setup_incomplete');
    const statement = envelope.items.find((item) => item.ref === 'statement');
    expect(statement?.status).toBe('empty');
    // E ela chega à evidência RENDERIZADA (payload do prompt), tipada.
    expect(serializeEvidenceForPrompt(envelope)).toContain('workspace_empty');
  });

  it('RED: uma única leitura vazia NÃO afirma workspace_empty', async () => {
    // O bloqueio de A04(b) permanece: uma leitura isolada não é snapshot.
    const envelope = await envelopeFor(planFor(['list_accounts']), {
      listAccounts: async () => ({ items: [] }),
    });
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
    expect(envelope.items[0]?.reason).toBe('setup_incomplete');
  });

  it('RED: uma FALHA em qualquer leitura nunca agrega workspace_empty', async () => {
    // R04: a leitura quebrou, não provou ausência. Afirmar "workspace vazio"
    // aqui responderia "não há nada" para um turno cujo dado nunca chegou.
    const envelope = await envelopeFor(planFor(['get_balance'], 'transactions'), {
      listAccounts: async () => ({ items: [] }),
      listRecentTransactions: async () => { throw httpError(403); },
    });
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
    expect(reasonsOf(envelope)).toContain('forbidden');
  });

  it('RED: uma leitura com DADOS nunca agrega workspace_empty', async () => {
    const envelope = await envelopeFor(planFor(['get_balance'], 'transactions'), {
      listAccounts: async () => ({ items: [{ id: 'acc-1', name: 'Conta', balanceCents: 100, status: 'active' }] }),
      listRecentTransactions: async () => ({ items: [] }),
    });
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
  });

  it('RED: ausência de ESCOPO ESTREITO bloqueia a afirmação global', async () => {
    // `period_empty` prova que o período consultado está vazio — logo existe
    // dado fora dele. Um `workspace_empty` aqui seria uma afirmação falsa.
    const envelope = await envelopeFor(planFor(['get_month_summary', 'list_recent_transactions']), {
      getMonthSummary: async () => ({ yearMonth: '2026-09', incomeCents: 0, expenseCents: 0, balanceCents: 0, transactionCount: 0 }),
      listRecentTransactions: async () => ({ items: [] }),
    });
    expect(reasonsOf(envelope)).toContain('period_empty');
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
  });
});

describe('A19/F3: dívida de reason do mapper de lista alinhada ao contrato REAL das rotas', () => {
  /**
   * F3: o `mapSingleton` anterior só produzia `setup_incomplete` para
   * `null`/`undefined` — uma forma ARTIFICIAL. As rotas reais respondem
   * `{items, total}`:
   *   `GET /goals`            → `{items, total}`   (goals.ts:64)
   *   `GET /budgets`          → `{items, total}`   (budgets.ts:65)
   *   `GET /payables`         → `{items, total}`   (payables.ts:159)
   *   `GET /categories`       → `{items, total}`   (categories.ts:62)
   *   `GET /cards/statements` → `{items, total}`   (cards.ts:159)
   * Logo a lista vazia REAL nunca produzia reason, a agregação
   * `workspace_empty` não era exercitada no caminho real, e os testes
   * anteriores cobriam só o `null`.
   */
  const singletons: ReadonlyArray<[string, keyof ChannelReadTools]> = [
    ['list_statements', 'listStatements'],
    ['list_accounts_payable', 'listAccountsPayable'],
    ['list_budgets', 'listBudgets'],
    ['list_goals', 'listGoals'],
    ['list_categories', 'listCategories'],
  ];

  it('RED: lista REAL vazia `{items: [], total: 0}` carrega setup_incomplete', async () => {
    for (const [operation, tool] of singletons) {
      const envelope = await envelopeFor(planFor([operation]), {
        [tool]: async () => ({ items: [], total: 0 }),
      } as Partial<ChannelReadTools>);
      const item = envelope.items[0];
      expect(item?.status, operation).toBe('empty');
      // Sem reason o item era um "não-claim" genérico: indistinguível, no
      // prompt e no renderizador, de uma ausência nunca classificada.
      expect(item?.reason, operation).toBe('setup_incomplete');
    }
  });

  it('RED: `null`/`undefined` NÃO são vazio — são permanent_error (F2)', async () => {
    // Forma artificial: o cliente gerado nunca devolve isso, então tratá-la
    // como "nada configurado" seria inventar uma leitura que não aconteceu.
    for (const absent of [null, undefined]) {
      for (const [operation, tool] of singletons) {
        const envelope = await envelopeFor(planFor([operation]), {
          [tool]: async () => absent,
        } as Partial<ChannelReadTools>);
        expect(envelope.items[0]?.status, `${operation}/${String(absent)}`).toBe('error');
        expect(envelope.items[0]?.reason, `${operation}/${String(absent)}`).toBe('permanent_error');
      }
    }
  });

  it('RED: a reason singleton chega à evidência renderizada do prompt', async () => {
    const envelope = await envelopeFor(planFor(['list_budgets']), {
      listBudgets: async () => ({ items: [], total: 0 }),
    });
    expect(serializeEvidenceForPrompt(envelope)).toContain('setup_incomplete');
  });

  it('RED: duas listas REAIS vazias agregam workspace_empty (caminho real do A04-b)', async () => {
    const envelope = await envelopeFor(planFor(['list_goals', 'list_budgets']), {
      listGoals: async () => ({ items: [], total: 0 }),
      listBudgets: async () => ({ items: [], total: 0 }),
    });
    expect(reasonsOf(envelope)).toContain('setup_incomplete');
    expect(reasonsOf(envelope)).toContain('workspace_empty');
    expect(serializeEvidenceForPrompt(envelope)).toContain('workspace_empty');
  });

  it('a leitura singleton COM dados continua `ok` e sem reason', async () => {
    const envelope = await envelopeFor(planFor(['list_goals']), {
      listGoals: async () => ({ items: [{ id: 'goal-1', name: 'Reserva' }], total: 1 }),
    });
    expect(envelope.items[0]?.status).toBe('ok');
    expect('reason' in envelope.items[0]!).toBe(false);
  });
});

describe('A19: o catch externo do envelope agregado preserva a reason tipada', () => {
  it('RED: rejeição tipada do construtor NÃO degrada para unavailable', async () => {
    // Payload maior que `MAX_PAYLOAD_BYTES`: a coleta tem dados, mas nenhum
    // deles pode ser projetado. Isso é uma FALHA permanente do envelope —
    // `unavailable` rebaixava um fato conhecido para um genérico.
    // O payload usa a SHAPE REAL da rota (`{items,total}`) para que a rejeição
    // venha do `createEvidenceEnvelope` (teto de payload), e não do gate de
    // forma do mapper — são duas rejected layers diferentes.
    const envelope = await envelopeFor(planFor(['list_goals']), {
      listGoals: async () => ({ items: [{ id: 'goal-1', name: 'Reserva', blob: 'x'.repeat(12_000) }], total: 1 }),
    });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.status).toBe('error');
    expect(envelope.items[0]?.reason).toBe('permanent_error');
    expect(envelope.items[0]?.data).toBeNull();
    // O payload recusado nunca chega ao prompt.
    expect(serializeEvidenceForPrompt(envelope)).not.toContain('x'.repeat(100));
  });

  it('as rejeições do próprio construtor carregam reason tipada', () => {
    let oversized: unknown;
    try {
      createEvidenceEnvelope([{ ref: 'r', source: 'tool', retrievedAt: new Date().toISOString(), status: 'ok', data: { value: 'x'.repeat(10_001) } }]);
    } catch (error) {
      oversized = error;
    }
    expect((oversized as { reason?: unknown }).reason).toBe('permanent_error');
    expect((oversized as Error).message).toBe('evidence.payload_too_large');
  });

  it('rejeição CRUA cai para unavailable; rejeição tipada é preservada', () => {
    expect(resolveEnvelopeRejection(Object.assign(new Error('evidence.invalid'), { reason: 'forbidden' }))).toBe('forbidden');
    expect(resolveEnvelopeRejection(new Error('boom'))).toBe('unavailable');
    expect(resolveEnvelopeRejection(new TypeError('fetch failed'))).toBe('unavailable');
    expect(resolveEnvelopeRejection(Object.assign(new Error('HTTP 429'), { statusCode: 429 }))).toBe('retryable_error');
    // Uma reason fora do eixo fechado (ou de outro eixo) NUNCA é preservada.
    expect(resolveEnvelopeRejection(Object.assign(new Error('x'), { reason: 'period_empty' }))).toBe('unavailable');
    expect(resolveEnvelopeRejection(null)).toBe('unavailable');
  });
});

describe('teto de leituras por turno com as leituras de analytics (A09-int)', () => {
  it('analytics_kpis + analytics_category_breakdown = exatamente 2 chamadas, nunca mais', async () => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ success: true } as never);
    try {
      const grounding = createChannelGrounding({
        respond: async () => 'unused',
        apiOrigin: 'https://api.test.local',
        readToken: async () => 'token-budget',
      });
      await grounding.evidenceProvider(input, planFor(['analytics_kpis', 'analytics_category_breakdown']));
      // Pior caso planejado: as DUAS leituras de analytics entram no teto.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
      apiClient.clearGlobalApiContext();
    }
  });

  it('analytics_kpis + fallback do domínio não estoura o teto', async () => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [] } as never);
    try {
      const grounding = createChannelGrounding({
        respond: async () => 'unused',
        apiOrigin: 'https://api.test.local',
        readToken: async () => 'token-budget',
      });
      await grounding.evidenceProvider(input, planFor(['analytics_kpis'], 'transactions'));
      // 1 leitura planejada + 1 fallback de domínio = o teto, nunca 3.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      apiClient.clearGlobalApiContext();
    }
  });

  it('três leituras de analytics planejadas são truncadas no teto', async () => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ success: true } as never);
    try {
      const grounding = createChannelGrounding({
        respond: async () => 'unused',
        apiOrigin: 'https://api.test.local',
        readToken: async () => 'token-budget',
      });
      const plan = planFor(['analytics_kpis', 'analytics_category_breakdown', 'get_month_summary']);
      const envelope = await grounding.evidenceProvider(input, plan);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      // A terceira leitura planejada NUNCA vira evidência do turno.
      expect(JSON.stringify(envelope)).not.toContain('api.month-summary');
    } finally {
      spy.mockRestore();
      apiClient.clearGlobalApiContext();
    }
  });
});