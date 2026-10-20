/**
 * Issue #256 — month-summary routing (TDD RED→GREEN).
 *
 * "Quanto gastei esse mês?" / "Quanto gastei no mês passado?" são perguntas
 * de TOTAL do período: devem planejar `get_month_summary` (ou equivalente
 * analítico), NUNCA só `list_transactions`. "gastos de supermercado" é
 * consulta transacional com filtro de categoria e continua `list_transactions`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createChannelGrounding, resolveSummaryYearMonth, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnInput,
  type TurnPlan,
} from '../src/orchestration/conversation-orchestrator.js';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

const input: TurnInput = {
  intentionId: 'intent-256',
  traceId: 'intent-256',
  text: 'Quanto gastei esse mês?',
  actorId: 'actor-256',
  workspaceId: 'ws-256',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
};

const planFor = (operation: string): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain: 'transactions',
  skillNames: ['relatorios'],
  requestedOperations: [{ name: operation, kind: 'read' }],
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
    listCards: unused,
    listStatements: unused,
    listAccountsPayable: unused,
    listBudgets: unused,
    listGoals: unused,
    listCategories: unused,
    analyticsKpis: unused,
    analyticsCategoryBreakdown: unused,
    ...overrides,
  } as unknown as ChannelReadTools;
};

describe('issue #256 month-summary routing', () => {
  it('1) "Quanto gastei esse mês?" plans get_month_summary, never only list_transactions', () => {
    const plan = routeIntent('Quanto gastei esse mês?');
    expect(plan.mode).toBe('read');
    const ops = opNames('Quanto gastei esse mês?');
    expect(ops).toContain('get_month_summary');
    expect(ops).not.toContain('list_transactions');
  });

  it('2) "Quanto gastei no mês passado?" plans get_month_summary with period', () => {
    const ops = opNames('Quanto gastei no mês passado?');
    expect(ops).toContain('get_month_summary');
    expect(ops).not.toContain('list_transactions');
  });

  it('3) "gastos de supermercado" stays list_transactions (category filter), never month-summary', () => {
    const ops = opNames('gastos de supermercado');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });

  it('4) evidence: a get_month_summary plan reads month-summary (domain fallback may add a second read)', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        getMonthSummary: async () => {
          calls.push('getMonthSummary');
          return { transactionCount: 0 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return { items: [], total: 0 };
        },
      }),
    });
    const envelope = await grounding.evidenceProvider(input, planFor('get_month_summary'));
    expect(envelope).not.toBeNull();
    // O contrato da #256: a leitura month-summary acontece (nunca SÓ transactions).
    // P1: o fallback de domínio NÃO soma `list_transactions` quando o plano já
    // tem o resumo (a segunda leitura suplantava o TOTAL com o extrato).
    expect(calls).toContain('getMonthSummary');
    expect(envelope!.items.map((item) => item.source)).toContain('api.month-summary');
  });

  it('5) P1: plano get_month_summary NÃO dispara list_transactions via fallback de domínio', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        getMonthSummary: async () => {
          calls.push('getMonthSummary');
          return { yearMonth: '2026-09', incomeCents: 100000, expenseCents: 5000, balanceCents: 95000, transactionCount: 3 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return { items: [], total: 0 };
        },
      }),
    });
    // Plano real do roteador para TOTAL do período: domínio transactions.
    const plan = routeIntent('Quanto gastei esse mês?');
    expect(plan.requestedOperations.map((operation) => operation.name)).toContain('get_month_summary');
    const envelope = await grounding.evidenceProvider(input, plan);
    expect(envelope).not.toBeNull();
    expect(calls).toContain('getMonthSummary');
    expect(calls).not.toContain('listRecentTransactions');
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('6) P2b: "mostre o extrato dos gastos deste mês" é LISTAGEM (list_transactions), não resumo', () => {
    const ops = opNames('mostre o extrato dos gastos deste mês');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });

  it('7) P2b: "gastos de supermercado neste mês" é LISTAGEM com filtro, não resumo', () => {
    const ops = opNames('gastos de supermercado neste mês');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });

  it('8) P1 integrado: resumo + transações não vazias responde o TOTAL (nunca extrato)', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-256',
      workspaceId: 'ws-256',
      role: 'member',
      deviceId: 'device-256',
    };
    const summaryPlan: TurnPlan = {
      version: '2',
      mode: 'read',
      domain: 'transactions',
      skillNames: ['relatorios'],
      requestedOperations: [{ name: 'get_month_summary', kind: 'read' }],
      missingFields: [],
      ambiguity: null,
      confidence: 1,
    };
    const responseProvider = vi.fn(async () => 'nunca usado no caminho determinístico');
    const orchestrator = new ConversationOrchestrator({
      plan: () => summaryPlan,
      evidenceProvider: async () => ({
        version: '1' as const,
        items: [
          {
            ref: 'month-summary',
            source: 'api.month-summary',
            retrievedAt: new Date().toISOString(),
            status: 'ok' as const,
            data: { yearMonth: '2026-09', incomeCents: 100000, expenseCents: 5000, balanceCents: 95000, transactionCount: 3 },
          },
          {
            ref: 'statement',
            source: 'api.transactions',
            retrievedAt: new Date().toISOString(),
            status: 'ok' as const,
            data: [{ description: 'Mercado', date: '2026-09-10', amountCents: -1234 }],
          },
        ],
      }),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Quanto gastei esse mês?', intentionId: 'intent-256-final' }, identity),
    );
    // O total do resumo (R$ 50,00 de gastos) aparece; a listagem NÃO suplanta.
    expect(result.response?.text).toContain('50,00');
    expect(result.response?.text).not.toContain('Mercado');
  });

  it('9) P2a: resolveSummaryYearMonth distingue mês corrente vs. passado (relógio fixo)', () => {
    const now = new Date('2026-10-15T12:00:00.000Z');
    expect(resolveSummaryYearMonth('Quanto gastei esse mês?', now)).toBe('2026-10');
    expect(resolveSummaryYearMonth('Quanto gastei no mês passado?', now)).toBe('2026-09');
    expect(resolveSummaryYearMonth('resumo do último mês', now)).toBe('2026-09');
    // Virada de ano: janeiro passado é dezembro anterior.
    expect(resolveSummaryYearMonth('mês passado', new Date('2026-01-10T12:00:00.000Z'))).toBe('2025-12');
  });

  it('10) P2a: "mês passado" transporta o yearMonth anterior ao reader (relógio fixo)', async () => {
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-15T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          seen.push(params);
          return { yearMonth: '2026-09', incomeCents: 0, expenseCents: 100, balanceCents: -100, transactionCount: 1 };
        },
      }),
    });
    const envelope = await grounding.evidenceProvider(
      { ...input, text: 'Quanto gastei no mês passado?' },
      planFor('get_month_summary'),
    );
    expect(envelope).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ yearMonth: '2026-09' });
  });

  it('11) regressão: "extrato de junho" continua listagem e "gastos de supermercado" continua transacional', () => {
    expect(opNames('extrato de junho')).toContain('list_transactions');
    expect(opNames('extrato de junho')).not.toContain('get_month_summary');
    expect(opNames('gastos de supermercado')).toContain('list_transactions');
    expect(opNames('gastos de supermercado')).not.toContain('get_month_summary');
  });

  it('12) FIX3: "quanto gastei no mercado neste mês?" é LISTAGEM filtrada, não resumo', () => {
    const ops = opNames('quanto gastei no mercado neste mês?');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });

  it('13) FIX3 regressão temporal: "gastei no mês passado" continua resumo', () => {
    const ops = opNames('gastei no mês passado');
    expect(ops).toContain('get_month_summary');
    expect(ops).not.toContain('list_transactions');
  });

  it('14) FIX3 plural: "mostre as transações dos gastos deste mês" é LISTAGEM, não resumo', () => {
    const ops = opNames('mostre as transações dos gastos deste mês');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });

  it('15) FIX3 plural: "mostre os lançamentos deste mês" é LISTAGEM', () => {
    const ops = opNames('mostre os lançamentos deste mês');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });

  it('16) FIX3 plural: "mostre os extratos deste mês" é LISTAGEM', () => {
    const ops = opNames('mostre os extratos deste mês');
    expect(ops).toContain('list_transactions');
    expect(ops).not.toContain('get_month_summary');
  });
});
