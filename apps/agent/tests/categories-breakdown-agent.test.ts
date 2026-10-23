/**
 * TED categories + breakdown-by-category (RED first).
 *
 * - 'liste minhas categorias' deve usar a leitura real `list_categories`;
 * - 'resumo do mês por categoria' deve usar `analytics_category_breakdown` real,
 *   nunca o resumo mensal simples.
 * Sem escrita nova, sem IDs no copy, falha/shape incompleta nunca vira vazio.
 */
import { describe, expect, it, vi } from 'vitest';
import { routeIntent, UNSUPPORTED_CATEGORY_MUTATION_TEXT, AMBIGUOUS_BREAKDOWN_KIND_TEXT, CONCEPT_CATEGORIES_TEXT, AMBIGUOUS_COMPOUND_REQUEST_TEXT } from '../src/orchestration/intent-router.js';
import { createChannelGrounding, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnInput,
  type TurnPlan,
} from '../src/orchestration/conversation-orchestrator.js';
import { renderCategories, renderCategoryBreakdown, FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT } from '../src/responses/deterministic-responses.js';
import * as apiClient from '../src/tools/api-client.js';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeForgetProposalSchema,
  initializeMemorySchema,
  listActiveForgetProposals,
  listForgetCandidates,
  rememberFact,
  type MemorySql,
} from '../src/agent-config/memory/store.js';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

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

const inputFor = (text: string): TurnInput => ({
  intentionId: 'intent-cat-red',
  traceId: 'intent-cat-red',
  text,
  actorId: 'actor-cat',
  workspaceId: 'ws-cat',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
});

const planFor = (operations: string[], domain: TurnPlan['domain'] = 'general'): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain,
  skillNames: ['s'],
  requestedOperations: operations.map((name) => ({ name, kind: 'read' as const })),
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const identity: AuthenticatedIdentity = {
  actorId: 'actor-cat',
  workspaceId: 'ws-cat',
  role: 'member',
  deviceId: 'device-cat',
};

const WS_UUID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_NAMES = ['Mercado', 'Transporte', 'Moradia', 'Lazer', 'Saúde', 'Educação', 'Salário', 'Aluguel'];

const categoryRouteBody = (count: number, total?: number): Record<string, unknown> => ({
  items: Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    householdId: WS_UUID,
    name: `${CATEGORY_NAMES[index % CATEGORY_NAMES.length]} ${String(index).padStart(2, '0')}`,
    kind: index % 3 === 2 ? 'income' : 'expense',
    status: 'active',
    parentId: null,
    icon: 'cart',
    color: '#0E8C5A',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  })),
  total: total ?? count,
});

const inputForUuid = (text: string): TurnInput => ({ ...inputFor(text), workspaceId: WS_UUID });

const evidenceViaGeneratedTool = async (body: unknown) => {
  const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue(body as never);
  try {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      apiOrigin: 'https://api.test.local',
      readToken: async () => 'token-r3',
    });
    const envelope = await grounding.evidenceProvider(
      inputForUuid('liste minhas categorias'),
      planFor(['list_categories'], 'categories'),
    );
    if (!envelope) throw new Error('envelope.expected');
    return envelope;
  } finally {
    spy.mockRestore();
    apiClient.clearGlobalApiContext();
  }
};

describe('router: categorias e resumo por categoria', () => {
  it('"liste minhas categorias" planeja list_categories real', () => {
    const plan = routeIntent('liste minhas categorias');
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('categories');
    expect(opNames('liste minhas categorias')).toContain('list_categories');
  });

  it('"quais são minhas categorias?" planeja list_categories', () => {
    expect(opNames('quais são minhas categorias?')).toContain('list_categories');
  });

  it('"resumo do mês por categoria" usa breakdown real, nunca resumo simples', () => {
    const ops = opNames('resumo do mês por categoria');
    expect(ops).toContain('analytics_category_breakdown');
    expect(ops).not.toContain('get_month_summary');
  });

  it('"gastos por categoria em janeiro de 2026" usa breakdown', () => {
    const ops = opNames('gastos por categoria em janeiro de 2026');
    expect(ops).toContain('analytics_category_breakdown');
    expect(ops).not.toContain('get_month_summary');
  });

  it('não regressão: "quanto gastei esse mês?" continua resumo simples', () => {
    const ops = opNames('quanto gastei esse mês?');
    expect(ops).toContain('get_month_summary');
    expect(ops).not.toContain('analytics_category_breakdown');
  });

  it('não regressão: cartões e payables não ganham categorias/breakdown', () => {
    expect(opNames('liste meus cartões')).toContain('list_cards');
    expect(opNames('liste meus cartões')).not.toContain('list_categories');
    expect(opNames('minhas contas a pagar')).toContain('list_payables');
    expect(opNames('minhas contas a pagar')).not.toContain('analytics_category_breakdown');
  });

  it('"o que são categorias?" é pergunta conceitual, nunca lista', () => {
    const plan = routeIntent('o que são categorias?');
    expect(plan.mode).toBe('conversation');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('não regressão: "o que é categoria?" continua conceito', () => {
    const plan = routeIntent('o que é categoria?');
    expect(plan.mode).toBe('conversation');
    expect(plan.requestedOperations).toEqual([]);
  });
});

describe('evidência: categorias e breakdown honestos', () => {
  it('categorias preenchidas viram ok com payload preservado', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        listCategories: async () => ({
          items: [
            { id: 'c-1', householdId: 'ws-cat', name: 'Mercado', kind: 'expense', status: 'active' },
            { id: 'c-2', householdId: 'ws-cat', name: 'Salário', kind: 'income', status: 'active' },
          ],
          total: 2,
        }),
      }),
    });
    const envelope = await grounding.evidenceProvider(inputFor('liste minhas categorias'), planFor(['list_categories']));
    expect(envelope?.items[0]?.status).toBe('ok');
    expect(envelope?.items[0]?.source).toBe('api.categories');
  });

  it('categorias vazias são ausência setup_incomplete, nunca erro', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({ listCategories: async () => ({ items: [], total: 0 }) }),
    });
    const envelope = await grounding.evidenceProvider(inputFor('liste minhas categorias'), planFor(['list_categories']));
    expect(envelope?.items[0]?.status).toBe('empty');
    expect(envelope?.items[0]?.reason).toBe('setup_incomplete');
  });

  it('categorias fora do contrato são falha permanent_error, nunca vazio', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({ listCategories: async () => ({}) }),
    });
    const envelope = await grounding.evidenceProvider(inputFor('liste minhas categorias'), planFor(['list_categories']));
    expect(envelope?.items[0]?.status).toBe('error');
    expect(envelope?.items[0]?.reason).toBe('permanent_error');
  });

  it('breakdown mensal real vira ok com envelope de prova', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        analyticsCategoryBreakdown: async () => ({
          period: { from: '2026-06-01', to: '2026-06-30' },
          kind: 'expense',
          totalCents: 10000,
          slices: [{ categoryId: 'c-1', name: 'Mercado', totalCents: 10000, pct: 100, color: '#0E8C5A' }],
          transactionCount: 2,
          asOf: '2026-07-01T00:00:00.000Z',
          basis: 'liquidez',
          semanticsVersion: '1',
          effectiveFilter: { period: 'custom', from: '2026-06-01', to: '2026-06-30', accountId: null, kind: 'expense' },
          emptyReason: null,
        }),
      }),
    });
    const envelope = await grounding.evidenceProvider(
      inputFor('resumo do mês por categoria'),
      planFor(['analytics_category_breakdown']),
    );
    expect(envelope?.items[0]?.status).toBe('ok');
    expect(envelope?.items[0]?.source).toBe('api.analytics.category-breakdown');
  });

  it('breakdown vazio é period_empty, nunca ok com zeros', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        analyticsCategoryBreakdown: async () => ({
          period: { from: '2026-06-01', to: '2026-06-30' },
          kind: 'expense',
          totalCents: 0,
          slices: [],
          transactionCount: 0,
          asOf: '2026-07-01T00:00:00.000Z',
          basis: 'liquidez',
          semanticsVersion: '1',
          effectiveFilter: { period: 'custom', from: '2026-06-01', to: '2026-06-30', accountId: null, kind: 'expense' },
          emptyReason: 'no_categorised_transactions_in_period',
        }),
      }),
    });
    const envelope = await grounding.evidenceProvider(
      inputFor('resumo do mês por categoria'),
      planFor(['analytics_category_breakdown']),
    );
    expect(envelope?.items[0]?.status).toBe('empty');
    expect(envelope?.items[0]?.reason).toBe('period_empty');
  });

  it('breakdown sem envelope é falha permanent_error, sem números', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({ analyticsCategoryBreakdown: async () => ({ totalCents: 10000 }) }),
    });
    const envelope = await grounding.evidenceProvider(
      inputFor('resumo do mês por categoria'),
      planFor(['analytics_category_breakdown']),
    );
    expect(envelope?.items[0]?.status).toBe('error');
    expect(envelope?.items[0]?.reason).toBe('permanent_error');
    expect(JSON.stringify(envelope)).not.toContain('10000');
  });
});

describe('round2-1: mutações de categoria nunca viram leitura', () => {
  it('router: "exclua categoria Viagem" é limitação honesta, sem operação', () => {
    const plan = routeIntent('exclua categoria Viagem');
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('unsupported_category_mutation');
  });

  it('router: "renomeie categoria Mercado para Alimentação" propõe categories.update (nunca leitura)', () => {
    const plan = routeIntent('renomeie categoria Mercado para Alimentação');
    expect(plan.mode).toBe('mutation-proposal');
    expect(plan.domain).toBe('categories');
    expect(plan.requestedOperations.some((operation) => operation.name === 'categories.update')).toBe(true);
  });

  it('router: "Crie categoria Viagem" propõe categories.create (manual-only)', () => {
    const plan = routeIntent('Crie categoria Viagem');
    expect(plan.mode).toBe('mutation-proposal');
    expect(plan.domain).toBe('categories');
    expect(plan.requestedOperations.some((operation) => operation.name === 'categories.create')).toBe(true);
  });

  it('turno "exclua categoria Viagem" responde a limitação sem leitura, sem provider, sem escrita', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the category-mutation path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(normalizeRestTurn({ text: 'exclua categoria Viagem', intentionId: 'intent-catmut-d' }, identity));
    expect(result.response?.text).toBe(UNSUPPORTED_CATEGORY_MUTATION_TEXT);
    expect(result.response?.text).not.toMatch(/criad|sucesso|excluída|renomeada|concluíd/i);
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('turno "renomeie categoria ..." sem transporte é limitação honesta: sem leitura, sem provider, sem escrita', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the category-mutation path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(normalizeRestTurn({ text: 'renomeie categoria Mercado para Alimentação', intentionId: 'intent-catmut-u' }, identity));
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).not.toMatch(/criad|sucesso|excluída|renomeada|concluíd/i);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });
});

describe('round2-2: kind do breakdown preserva receitas', () => {
  const breakdownArgsFor = async (text: string, now: Date): Promise<Record<string, unknown>> => {
    const seen: Array<Record<string, unknown>> = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => now,
      readTools: readTools({
        analyticsCategoryBreakdown: async (params) => {
          seen.push(params as Record<string, unknown>);
          return {
            period: { from: '2026-06-01', to: '2026-06-30' },
            kind: (params as Record<string, unknown>)['kind'] ?? 'expense',
            totalCents: 10000,
            slices: [{ categoryId: 'c-1', name: 'Mercado', totalCents: 10000, pct: 100, color: '#0E8C5A' }],
            transactionCount: 2,
            asOf: '2026-07-01T00:00:00.000Z',
            basis: 'liquidez',
            semanticsVersion: '1',
            effectiveFilter: { period: 'custom', from: '2026-06-01', to: '2026-06-30', accountId: null, kind: (params as Record<string, unknown>)['kind'] ?? 'expense' },
            emptyReason: null,
          };
        },
      }),
    });
    const envelope = await grounding.evidenceProvider(
      inputFor(text),
      planFor(['analytics_category_breakdown'], 'categories'),
    );
    expect(envelope?.items[0]?.status).toBe('ok');
    if (seen.length === 0) throw new Error('breakdown.params.expected');
    return seen[0]!;
  };

  it('"receitas por categoria neste mês" pede kind=income com janela UTC do mês corrente', async () => {
    const args = await breakdownArgsFor('receitas por categoria neste mês', new Date('2026-06-15T12:00:00Z'));
    expect(args['kind']).toBe('income');
    expect(args['period']).toBe('custom');
    expect(args['from']).toBe('2026-06-01');
    expect(args['to']).toBe('2026-06-30');
  });

  it('"gastos por categoria neste mês" pede kind=expense com a mesma janela', async () => {
    const args = await breakdownArgsFor('gastos por categoria neste mês', new Date('2026-06-15T12:00:00Z'));
    expect(args['kind']).toBe('expense');
    expect(args['period']).toBe('custom');
    expect(args['from']).toBe('2026-06-01');
    expect(args['to']).toBe('2026-06-30');
  });

  it('"resumo do mês por categoria" mantém o default expense', async () => {
    const args = await breakdownArgsFor('resumo do mês por categoria', new Date('2026-06-15T12:00:00Z'));
    expect(args['kind']).toBe('expense');
  });

  it('render income intitula Receitas, nunca Gastos', () => {
    const text = renderCategoryBreakdown({
      period: { from: '2026-06-01', to: '2026-06-30' },
      kind: 'income',
      totalCents: 20000,
      slices: [{ categoryId: 'c-2', name: 'Salário', totalCents: 20000, pct: 100, color: '#3E6FB0' }],
      transactionCount: 1,
      basis: 'liquidez',
      asOf: '2026-07-01T00:00:00.000Z',
      effectivePeriod: { from: '2026-06-01', to: '2026-06-30', toExclusive: '2026-07-01' },
      boundary: 'inclusive',
    });
    expect(text).not.toBeNull();
    expect(text!).toContain('Receitas por categoria');
    expect(text!).not.toContain('Gastos');
  });

  it('turno receitas vazio responde ausência de receitas sem provider', async () => {
    const evidenceProvider = vi.fn(async () => ({
      version: '1' as const,
      items: [
        {
          ref: 'analytics-breakdown',
          source: 'api.analytics.category-breakdown',
          retrievedAt: new Date().toISOString(),
          status: 'empty' as const,
          reason: 'period_empty' as const,
          data: [],
        },
      ],
    }));
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'receitas por categoria neste mês', intentionId: 'intent-cat-inc-empty' }, identity),
    );
    expect(evidenceProvider).toHaveBeenCalledTimes(1);
    expect(responseProvider).toHaveBeenCalledTimes(0);
    expect(result.response?.text).toContain('receitas por categoria');
    expect(result.response?.text).not.toMatch(/R\$/);
  });
});

describe('round2-3: totais exatos acima de 2^53 (G-B)', () => {
  const period = { from: '2026-06-01', to: '2026-06-30' };
  const effectivePeriod = { from: '2026-06-01', to: '2026-06-30', toExclusive: '2026-07-01' };

  it('total com exact decimal rende o valor exato, sem Number', () => {
    const text = renderCategoryBreakdown({
      period,
      kind: 'expense',
      totalCents: 10000000000040000,
      totalCentsExact: '10000000000040001',
      approximate: true,
      slices: [
        {
          categoryId: 'c-1',
          name: 'Mercado',
          totalCents: 10000000000040000,
          totalCentsExact: '10000000000040001',
          approximate: true,
          pct: 100,
          color: '#0E8C5A',
        },
      ],
      transactionCount: 1,
      basis: 'liquidez',
      asOf: '2026-07-01T00:00:00.000Z',
      effectivePeriod,
      boundary: 'inclusive',
    });
    expect(text).not.toBeNull();
    // O double arredonda ...40001 para ...40000 (",00"); o decimal exato
    // prova ",01" — um render via Number publicaria centavos errados.
    expect(text!).toContain('R$ 100.000.000.000.400,01');
    expect(text!).not.toContain('c-1');
  });

  it('slices com exact rendem exato por linha', () => {
    const text = renderCategoryBreakdown({
      period,
      kind: 'expense',
      totalCents: 17501,
      slices: [
        {
          categoryId: 'c-1',
          name: 'Mercado',
          totalCents: 10000000000040000,
          totalCentsExact: '10000000000040001',
          approximate: true,
          pct: 99.9,
          color: '#0E8C5A',
        },
        { categoryId: 'c-2', name: 'Transporte', totalCents: 2500, pct: 0.1, color: '#3E6FB0' },
      ],
      transactionCount: 2,
      basis: 'liquidez',
      asOf: '2026-07-01T00:00:00.000Z',
      effectivePeriod,
      boundary: 'inclusive',
    });
    expect(text).not.toBeNull();
    expect(text!).toContain('R$ 100.000.000.000.400,01');
    expect(text!).toMatch(/R\$\s*25,00/);
  });

  it('approximate sem exact recusa, nunca número arredondado', () => {
    expect(
      renderCategoryBreakdown({
        period,
        kind: 'expense',
        totalCents: 10000000000040000,
        approximate: true,
        slices: [
          { categoryId: 'c-1', name: 'Mercado', totalCents: 10000000000040000, approximate: true, pct: 100 },
        ],
        transactionCount: 1,
        basis: 'liquidez',
        effectivePeriod,
        boundary: 'inclusive',
      }),
    ).toBeNull();
  });

  it('exact malformado recusa', () => {
    expect(
      renderCategoryBreakdown({
        period,
        kind: 'expense',
        totalCents: 10000,
        totalCentsExact: 'não-um-decimal',
        slices: [{ categoryId: 'c-1', name: 'Mercado', totalCents: 7500, pct: 75 }],
        transactionCount: 1,
        basis: 'liquidez',
        effectivePeriod,
        boundary: 'inclusive',
      }),
    ).toBeNull();
  });
});

describe('round2-4: unsafe sem exact original falha fechado antes do provider', () => {
  const UNSAFE = 10000000000040000;
  const period = { from: '2026-06-01', to: '2026-06-30' };
  const baseBreakdown = {
    period,
    kind: 'expense',
    transactionCount: 2,
    asOf: '2026-07-01T00:00:00.000Z',
    basis: 'liquidez',
    semanticsVersion: '1',
    effectiveFilter: { period: 'custom', from: '2026-06-01', to: '2026-06-30', accountId: null, kind: 'expense' },
    emptyReason: null,
  };

  const runBreakdownTurn = async (raw: unknown, text: string, intentionId: string) => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({ analyticsCategoryBreakdown: async () => raw }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: (input, plan) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
    return { result, responseProvider };
  };

  it('top-level unsafe sem exact: fail-closed sem provider e sem cifra', async () => {
    const { result, responseProvider } = await runBreakdownTurn(
      {
        ...baseBreakdown,
        totalCents: UNSAFE,
        slices: [{ categoryId: 'c-1', name: 'Mercado', totalCents: 100, pct: 100 }],
      },
      'resumo do mês por categoria',
      'intent-cat-raw-top',
    );
    expect(result.response?.text).toBe(FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT);
    expect(responseProvider).toHaveBeenCalledTimes(0);
    expect(result.response?.text).not.toMatch(/R\$|\d/);
  });

  it('slice unsafe sem exact: fail-closed sem provider e sem cifra', async () => {
    const { result, responseProvider } = await runBreakdownTurn(
      {
        ...baseBreakdown,
        totalCents: 175,
        slices: [
          { categoryId: 'c-1', name: 'Mercado', totalCents: UNSAFE, pct: 99 },
          { categoryId: 'c-2', name: 'Transporte', totalCents: 75, pct: 1 },
        ],
      },
      'resumo do mês por categoria',
      'intent-cat-raw-slice',
    );
    expect(result.response?.text).toBe(FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT);
    expect(responseProvider).toHaveBeenCalledTimes(0);
    expect(result.response?.text).not.toMatch(/R\$|\d/);
  });

  it('controle: unsafe COM exact original rende o exato sem provider', async () => {
    const { result, responseProvider } = await runBreakdownTurn(
      {
        ...baseBreakdown,
        totalCents: UNSAFE,
        totalCentsExact: '10000000000040001',
        approximate: true,
        slices: [
          {
            categoryId: 'c-1',
            name: 'Mercado',
            totalCents: UNSAFE,
            totalCentsExact: '10000000000040001',
            approximate: true,
            pct: 100,
          },
        ],
      },
      'resumo do mês por categoria',
      'intent-cat-raw-exact',
    );
    expect(responseProvider).toHaveBeenCalledTimes(0);
    expect(result.response?.text).toContain('R$ 100.000.000.000.400,01');
  });
});

describe('round2-5: kind misto clarifica sem agregar duas vezes', () => {
  it('router: "receitas e gastos por categoria neste mês" pede escolha, sem operação', () => {
    const plan = routeIntent('receitas e gastos por categoria neste mês');
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('ambiguous_breakdown_kind');
  });

  it('turno misto responde a escolha sem leitura, sem provider, sem escrita', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the mixed-kind path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'receitas e gastos por categoria neste mês', intentionId: 'intent-cat-mixed' }, identity),
    );
    expect(result.response?.text).toBe(AMBIGUOUS_BREAKDOWN_KIND_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('controles puros continuam breakdown', () => {
    expect(opNames('receitas por categoria neste mês')).toContain('analytics_category_breakdown');
    expect(opNames('gastos por categoria neste mês')).toContain('analytics_category_breakdown');
    expect(opNames('receitas e gastos por categoria neste mês')).not.toContain('analytics_category_breakdown');
  });
});

describe('r3-1: categorias compactas cabem no teto com 60 itens reais', () => {
  const routeBody = (count: number): Record<string, unknown> => categoryRouteBody(count);

  it('60 itens reais: ok compacto dentro do teto, só nome/kind, total preservado', async () => {
    const envelope = await evidenceViaGeneratedTool(routeBody(60));
    const item = envelope.items[0]!;
    expect(item.status).toBe('ok');
    expect(item.source).toBe('api.categories');
    const data = item.data as Record<string, unknown>;
    const rows = data['items'] as unknown[];
    expect(rows).toHaveLength(60);
    for (const row of rows) {
      expect(Object.keys(row as Record<string, unknown>).sort()).toEqual(['kind', 'name']);
    }
    expect(data['total']).toBe(60);
    const dataJson = JSON.stringify(data);
    expect(dataJson).not.toMatch(/createdAt|updatedAt|householdId|parentId|"categories"|"id"/);
    // A leitura real completa (15693 bytes no corpo + 21657 com a duplicação
    // do gerado) cabia nada no teto de 10000: a evidência compacta tem folga.
    expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThan(10000);
    const text = renderCategories(data);
    expect(text).not.toBeNull();
    expect(text!).toContain('Mercado 00');
    expect(text!).not.toMatch(/00000000-0000|c-1|\(\+/);
  });

  it('65 itens: overflow honesto com truncamento explícito e sem IDs', async () => {
    const envelope = await evidenceViaGeneratedTool(routeBody(65));
    const item = envelope.items[0]!;
    expect(item.status).toBe('ok');
    const data = item.data as Record<string, unknown>;
    expect((data['items'] as unknown[])).toHaveLength(60);
    expect(data['total']).toBe(65);
    expect(data['truncated']).toBe(true);
    expect(data['omittedCount']).toBe(5);
    expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThan(10000);
    const text = renderCategories(data);
    expect(text).not.toBeNull();
    expect(text!).toContain('(+ 5 outras)');
    expect(text!).not.toMatch(/00000000-0000/);
  });
});

describe('r3-2: recusa financeira precede o forget (SQLite real)', () => {
  const WS = 'ws-r3';
  const ACTOR = 'actor-r3';
  const T0 = new Date('2026-10-21T12:00:00.000Z').getTime();

  type RealSql = { db: DatabaseSync; sql: MemorySql };

  const realSql = (): RealSql => {
    const db = new DatabaseSync(':memory:');
    const sql = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) return statement.all(...(bindings as never[])) as T[];
        statement.run(...(bindings as never[]));
        return [] as T[];
      },
    };
    initializeMemorySchema(sql as unknown as MemorySql);
    initializeForgetProposalSchema(sql as unknown as MemorySql);
    return { db, sql: sql as unknown as MemorySql };
  };

  const countRows = (sql: MemorySql, table: string): number => {
    const rows = [...(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`) as Iterable<{ n: number }>)];
    return rows[0]?.n ?? -1;
  };

  const aliveWith = (sql: MemorySql, snippet: string): number =>
    listForgetCandidates(sql, { workspaceId: WS, actor: ACTOR }).filter((memory) =>
      memory.content.includes(snippet),
    ).length;

  const runTurn = (
    sql: MemorySql,
    text: string,
    intentionId: string,
    hooks: { evidenceCalls: string[]; providerCalls: string[] },
  ) => {
    const orchestrator = new ConversationOrchestrator({
      forgetMemory: { sql, now: () => T0 },
      evidenceProvider: (async () => {
        hooks.evidenceCalls.push(text);
        throw new Error('no read must run on the refusal path');
      }) as never,
      responseProvider: (async () => {
        hooks.providerCalls.push(text);
        return 'invented by model';
      }) as never,
      events: () => undefined,
    });
    return orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId }, { workspaceId: WS, actorId: ACTOR, role: 'member', deviceId: null }),
    );
  };

  it('com memória correspondente: zero proposal/delete, memória intacta, recusa exata', async () => {
    const { sql } = realSql();
    rememberFact(sql, { workspaceId: WS, actor: ACTOR, kind: 'preference', content: 'Usa a categoria Transporte para organizar o mercado' });
    expect(aliveWith(sql, 'Transporte')).toBe(1);

    const hooks = { evidenceCalls: [] as string[], providerCalls: [] as string[] };
    const result = await runTurn(sql, 'exclua categoria QA Transporte', 'intent-r3-forget-1', hooks);

    expect(result.response?.text).toBe(UNSUPPORTED_CATEGORY_MUTATION_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(countRows(sql, 'agent_memory_forget_proposals')).toBe(0);
    expect(countRows(sql, 'agent_memory_forget_decisions')).toBe(0);
    expect(aliveWith(sql, 'Transporte')).toBe(1);
    expect(hooks.evidenceCalls).toHaveLength(0);
    expect(hooks.providerCalls).toHaveLength(0);
  });

  it('sem memória correspondente: zero proposal, recusa exata', async () => {
    const { sql } = realSql();

    const hooks = { evidenceCalls: [] as string[], providerCalls: [] as string[] };
    const result = await runTurn(sql, 'exclua categoria QA Transporte', 'intent-r3-forget-2', hooks);

    expect(result.response?.text).toBe(UNSUPPORTED_CATEGORY_MUTATION_TEXT);
    expect(countRows(sql, 'agent_memory_forget_proposals')).toBe(0);
    expect(hooks.evidenceCalls).toHaveLength(0);
    expect(hooks.providerCalls).toHaveLength(0);
  });

  it('pendente legítimo não é sequestrado: recusa preserva, "sim" posterior executa', async () => {
    const { sql } = realSql();
    rememberFact(sql, { workspaceId: WS, actor: ACTOR, kind: 'preference', content: 'Prefere a categoria Transporte' });

    const hooks = { evidenceCalls: [] as string[], providerCalls: [] as string[] };
    const asked = await runTurn(sql, 'esqueça a categoria Transporte', 'intent-r3-forget-3', hooks);
    expect(asked.response?.text).toMatch(/Quer que eu a esqueça/);
    expect(listActiveForgetProposals(sql, { workspaceId: WS, actorId: ACTOR }, T0)).toHaveLength(1);

    const refused = await runTurn(sql, 'exclua categoria QA Transporte', 'intent-r3-forget-4', hooks);
    expect(refused.response?.text).toBe(UNSUPPORTED_CATEGORY_MUTATION_TEXT);
    expect(listActiveForgetProposals(sql, { workspaceId: WS, actorId: ACTOR }, T0)).toHaveLength(1);
    expect(aliveWith(sql, 'Transporte')).toBe(1);

    const done = await runTurn(sql, 'sim', 'intent-r3-forget-5', hooks);
    expect(done.response?.text).toMatch(/Pronto, esqueci/);
    expect(aliveWith(sql, 'Transporte')).toBe(0);
  });
});

describe('r3-3: conceito puro de categorias responde determinístico', () => {
  const conceptCases = ['o que são categorias?', 'O QUE SÃO CATEGORIAS?', 'o que é subcategoria?', 'o que sao categrias?'];

  it.each(conceptCases)('router: "%s" é conceito puro, sem operação', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).toBe('conversation');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('concept_categories');
  });

  it.each(conceptCases.map((text, index) => [text, index] as const))(
    'turno "%s": resposta conceitual exata, zero reads/provider/mutations',
    async (text, index) => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the pure-concept path');
    });
    const responseProvider = vi.fn(async () => '**markup**-only');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: `intent-r3-concept-${index}` }, identity),
    );
    expect(result.response?.text).toBe(CONCEPT_CATEGORIES_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('não rouba intents: consulta, mutação e possessivo continuam donos', () => {
    expect(opNames('liste minhas categorias')).toContain('list_categories');
    expect(opNames('quais são minhas categorias?')).toContain('list_categories');
    expect(routeIntent('crie categoria Viagem de despesa').requestedOperations.map((operation) => operation.name)).toContain('categories.create');
    expect(routeIntent('renomeie categoria Mercado').requestedOperations.map((operation) => operation.name)).toContain('categories.update');
    expect(routeIntent('exclua categoria Mercado').ambiguity).toBe('unsupported_category_mutation');
    expect(opNames('quanto gastei esse mês?')).toContain('get_month_summary');
    expect(routeIntent('o que é meu saldo?').mode).not.toBe('conversation');
  });
});

describe('r3-4: composto conceito+leitura pede para separar, sem fingir atender', () => {
  it('router: "o que são categorias e liste os cartões?" pede separação, sem operação', () => {
    const plan = routeIntent('o que são categorias e liste os cartões?');
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('ambiguous_compound_request');
  });

  it('turno composto: texto pede separar, zero leituras, zero provider, nada atendido', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the compound path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'o que são categorias e liste os cartões?', intentionId: 'intent-r3-compound' }, identity),
    );
    expect(result.response?.text).toBe(AMBIGUOUS_COMPOUND_REQUEST_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
    // Não promete composição ampla nem finge atendimento: sem lista, sem Visa.
    expect(result.response?.text).not.toMatch(/aqui est|seguem os|Visa|Mercado|encontrei|pronto/i);
  });

  it('"o que é categoria e subcategoria?" continua conceito puro', () => {
    const plan = routeIntent('o que é categoria e subcategoria?');
    expect(plan.mode).toBe('conversation');
    expect(plan.ambiguity).toBe('concept_categories');
  });

  it('"O que é mesmo fatura?" continua conversa genérica (sem roubo)', () => {
    const plan = routeIntent('O que é mesmo fatura?');
    expect(plan.mode).toBe('conversation');
    expect(plan.ambiguity).not.toBe('concept_categories');
    expect(plan.ambiguity).not.toBe('ambiguous_compound_request');
  });
});

describe('r3-5: total declarado precisa ser coerente', () => {
  it('65 itens com total 0: inválido → error, nunca lista', async () => {
    const envelope = await evidenceViaGeneratedTool(categoryRouteBody(65, 0));
    const item = envelope.items[0]!;
    expect(item.status).toBe('error');
    expect(item.reason).toBe('permanent_error');
    expect(item.data).toBeNull();
  });

  it('items vazio com total 65: inconsistência parcial → error, nunca setup_incomplete', async () => {
    const envelope = await evidenceViaGeneratedTool({ items: [], total: 65 });
    const item = envelope.items[0]!;
    expect(item.status).toBe('error');
    expect(item.reason).toBe('permanent_error');
    expect(item.data).toBeNull();
  });

  it('items vazio com total 0: vazio legítimo → setup_incomplete', async () => {
    const envelope = await evidenceViaGeneratedTool({ items: [], total: 0 });
    const item = envelope.items[0]!;
    expect(item.status).toBe('empty');
    expect(item.reason).toBe('setup_incomplete');
  });

  it('20 itens de total 65 (página): ok com faltantes explícitos e render sem esconder', async () => {
    const envelope = await evidenceViaGeneratedTool(categoryRouteBody(20, 65));
    const item = envelope.items[0]!;
    expect(item.status).toBe('ok');
    const data = item.data as Record<string, unknown>;
    expect((data['items'] as unknown[])).toHaveLength(20);
    expect(data['total']).toBe(65);
    expect(data['truncated']).toBe(true);
    expect(data['omittedCount']).toBe(45);
    const text = renderCategories(data);
    expect(text).not.toBeNull();
    expect(text!).toContain('(+ 45 outras)');
    expect(text!).not.toMatch(/00000000-0000/);
  });

  it('total presente como string "65": inválido → error antes do vazio', async () => {
    const envelope = await evidenceViaGeneratedTool({ ...categoryRouteBody(65), total: '65' });
    const item = envelope.items[0]!;
    expect(item.status).toBe('error');
    expect(item.reason).toBe('permanent_error');
    expect(item.data).toBeNull();
  });

  it('total presente como null: inválido → error antes do vazio', async () => {
    const envelope = await evidenceViaGeneratedTool({ ...categoryRouteBody(65), total: null });
    const item = envelope.items[0]!;
    expect(item.status).toBe('error');
    expect(item.reason).toBe('permanent_error');
    expect(item.data).toBeNull();
  });

  it('total presente como NaN: inválido → error antes do vazio', async () => {
    const envelope = await evidenceViaGeneratedTool({ ...categoryRouteBody(65), total: NaN });
    const item = envelope.items[0]!;
    expect(item.status).toBe('error');
    expect(item.reason).toBe('permanent_error');
    expect(item.data).toBeNull();
  });

  it('total ausente com itens: ok tolerante com total = linhas (sem hasOwn)', async () => {
    const { total: _dropped, ...withoutTotal } = categoryRouteBody(3);
    void _dropped;
    const envelope = await evidenceViaGeneratedTool(withoutTotal);
    const item = envelope.items[0]!;
    expect(item.status).toBe('ok');
    expect((item.data as Record<string, unknown>)['total']).toBe(3);
  });
});

describe('render determinístico: nomes e totais reais, sem IDs', () => {
  const categoriesData = {
    items: [
      { id: 'c-1', name: 'Mercado', kind: 'expense' },
      { id: 'c-2', name: 'Salário', kind: 'income' },
    ],
    total: 2,
  };

  const breakdownData = {
    period: { from: '2026-06-01', to: '2026-06-30' },
    kind: 'expense',
    totalCents: 10000,
    slices: [
      { categoryId: 'c-1', name: 'Mercado', totalCents: 7500, pct: 75, color: '#0E8C5A' },
      { categoryId: 'c-2', name: 'Transporte', totalCents: 2500, pct: 25, color: '#3E6FB0' },
    ],
    transactionCount: 2,
    basis: 'liquidez',
    asOf: '2026-07-01T00:00:00.000Z',
    effectivePeriod: { from: '2026-06-01', to: '2026-06-30', toExclusive: '2026-07-01' },
    boundary: 'inclusive',
  };

  it('categorias listam nomes, nunca IDs', () => {
    const text = renderCategories(categoriesData);
    expect(text).toContain('Mercado');
    expect(text).toContain('Salário');
    expect(text).not.toContain('c-1');
    expect(text).not.toContain('c-2');
  });

  it('breakdown rende totais em centavos com janela UTC e sem IDs', () => {
    const text = renderCategoryBreakdown(breakdownData);
    expect(text).not.toBeNull();
    expect(text!).toContain('Mercado');
    expect(text!).toContain('2026-06-01');
    expect(text!).toContain('2026-06-30');
    expect(text!).toMatch(/R\$\s*75,00/);
    expect(text!).toMatch(/R\$\s*100,00/);
    expect(text!).not.toContain('c-1');
    expect(text!).not.toContain('c-2');
  });

  it('turno categorias responde a lista exata sem provider', async () => {
    const stamp = new Date().toISOString();
    const evidenceProvider = vi.fn(async () => ({
      version: '1' as const,
      items: [
        {
          ref: 'categories',
          source: 'api.categories',
          retrievedAt: stamp,
          status: 'ok' as const,
          data: categoriesData,
        },
      ],
    }));
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'liste minhas categorias', intentionId: 'intent-cat-list-1' }, identity),
    );
    expect(evidenceProvider).toHaveBeenCalledTimes(1);
    expect(responseProvider).toHaveBeenCalledTimes(0);
    expect(result.response?.text).toContain('Mercado (despesa)');
    expect(result.response?.text).toContain('Salário (receita)');
    expect(result.response?.text).not.toMatch(/c-1|c-2/);
  });

  it('turno breakdown responde totais exatos sem provider', async () => {
    const stamp = new Date().toISOString();
    const evidenceProvider = vi.fn(async () => ({
      version: '1' as const,
      items: [
        {
          ref: 'analytics-breakdown',
          source: 'api.analytics.category-breakdown',
          retrievedAt: stamp,
          status: 'ok' as const,
          data: breakdownData,
        },
      ],
    }));
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'resumo do mês por categoria', intentionId: 'intent-cat-bd-1' }, identity),
    );
    expect(evidenceProvider).toHaveBeenCalledTimes(1);
    expect(responseProvider).toHaveBeenCalledTimes(0);
    expect(result.response?.text).toContain('Gastos por categoria 2026-06-01 a 2026-06-30');
    expect(result.response?.text).toMatch(/R\$\s*100,00/);
    expect(result.response?.text).toMatch(/R\$\s*75,00/);
    expect(result.response?.text).not.toMatch(/c-1|c-2/);
  });
});
