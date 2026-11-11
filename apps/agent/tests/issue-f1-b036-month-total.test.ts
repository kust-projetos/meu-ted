/**
 * F1-B036 — "Me diga o total das despesas do mês atual" lê get_month_summary.
 *
 * Oráculo congelado em `tests/poc-structured/frozen/scenarios.json` (id
 * `F1-B036`): leitura `get_month_summary` com `yearMonth 2026-10`, sem
 * proposta. Este teste é INDEPENDENTE do harness F1: exercita o `routeIntent`
 * real, a janela `resolveSummaryYearMonth` e o turno completo com evidência
 * mockada, sem rede, sem modelo e sem tocar nos geradores/relatórios F1.
 *
 * Diferencia o extrato explícito ("mostre o extrato dos gastos deste mês" é
 * LISTAGEM `list_transactions`, nunca resumo) e o valor (o TOTAL do
 * `month-summary` suplanta a listagem no render determinístico).
 *
 * Total com escopo não suportado (subintervalo dd/mm ou "dia 10 ao dia 15",
 * categoria explícita) é limitação honesta determinística: sem leitura
 * financeira, sem provider, sem valor — nunca extrato não filtrado sugerindo
 * cobertura da janela, nunca catálogo como se fosse total, nunca soma do mês
 * cheio por período não pedido.
 */
import { describe, expect, it, vi } from 'vitest';
import { createChannelGrounding, resolveSummaryYearMonth, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import { routeIntent, UNSUPPORTED_CUSTOM_RANGE_TEXT, UNSUPPORTED_CATEGORY_TOTAL_TEXT, UNSUPPORTED_VALUE_RANGE_TEXT, UNSUPPORTED_MONTH_YEAR_TEXT, UNSUPPORTED_PAYABLES_TOTAL_TEXT, UNSUPPORTED_STATEMENT_TOTAL_TEXT, AMBIGUOUS_TOTAL_RANGE_TEXT } from '../src/orchestration/intent-router.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnInput,
  type TurnPlan,
} from '../src/orchestration/conversation-orchestrator.js';

const B036_TEXT = 'Me diga o total das despesas do mês atual';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

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

describe('F1-B036 — total mensal lê get_month_summary, nunca só extrato', () => {
  it('1) rota: B036 é read/get_month_summary, sem list_transactions', () => {
    const plan = routeIntent(B036_TEXT);
    expect(plan.mode).toBe('read');
    expect(opNames(B036_TEXT)).toContain('get_month_summary');
    expect(opNames(B036_TEXT)).not.toContain('list_transactions');
  });

  it('2) extrato explícito continua LISTAGEM, nunca resumo', () => {
    expect(opNames('mostre o extrato dos gastos deste mês')).toContain('list_transactions');
    expect(opNames('mostre o extrato dos gastos deste mês')).not.toContain('get_month_summary');
  });

  it('2b) total com filtro implícito de categoria é limitação honesta, sem leitura', () => {
    // Sem "total" a listagem com filtro segue (#256-7/12 preservados); com
    // "total" é soma por categoria — capacidade inexistente no contrato.
    for (const text of [
      'total das despesas de supermercado neste mês',
      'total dos gastos no mercado neste mês',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_category_total');
    }
  });

  it('2c) reviewer: pedido de listagem com "despesas" nunca vira total geral', () => {
    for (const text of ['liste as despesas do mês atual', 'mostre as despesas deste mês']) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('read');
      expect(opNames(text)).toContain('list_transactions');
      expect(opNames(text)).not.toContain('get_month_summary');
    }
  });

  it('2d) reviewer: total com categoria explícita é limitação honesta, sem leitura', () => {
    for (const text of [
      'total das despesas da categoria supermercado do mês',
      'total dos gastos na categoria Alimentação neste mês',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_category_total');
    }
  });

  it('2e) reviewer: total com idiom payables ("a pagar") é limitação honesta, sem leitura', () => {
    // Sem "total" a leitura payables segue (B005/B020 preservados); com "total"
    // o contrato só tem a LISTA (sem soma) — o resumo geral mascarava o total.
    // Vale sem âncora mensal: "vencidas"/"boletos" + total também é total
    // payables, não listagem.
    for (const text of [
      'total das despesas do mês a pagar',
      'total mensal a pagar',
      'total das contas vencidas do mês',
      'total de boletos',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_payables_total');
    }
  });

  it('2f) o exemplo da copy é honesto: "liste suas contas a pagar" lê payables, sem resumo', () => {
    expect(opNames('liste suas contas a pagar')).toContain('list_payables');
    expect(opNames('liste suas contas a pagar')).not.toContain('get_month_summary');
  });

  it('2g) reviewer: total de fatura ("com vencimento em outubro" ou nua) é limitação própria, nunca payables', () => {
    // "vencimento" sozinho não faz a pergunta virar payables: o objeto é a
    // fatura, e soma de fatura também não tem contrato.
    for (const text of [
      'Total da fatura com vencimento em outubro',
      'total da fatura',
      'total da fatura vencida',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_statement_total');
    }
  });

  it('2g2) mixed statement and payables totals require clarification without reads', () => {
    const plan = routeIntent('total das faturas e contas a pagar');
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('ambiguous_compound_request');
  });

  it('2h) sem "total", fatura com vencimento segue listagem (B010/S3 preservados)', () => {
    expect(opNames('Mostre minha fatura com vencimento em outubro')).toContain('list_statements');
    expect(opNames('Mostre minha fatura com vencimento em outubro')).not.toContain('get_month_summary');
  });

  it('3) janela: B036 com relógio 2026-10-24 resolve yearMonth 2026-10', () => {
    expect(resolveSummaryYearMonth(B036_TEXT, new Date('2026-10-24T12:00:00.000Z'))).toBe('2026-10');
  });

  it('4) evidência mockada: plano B036 chama getMonthSummary com 2026-10 e NÃO soma list_transactions', async () => {
    const seen: unknown[] = [];
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          calls.push('getMonthSummary');
          seen.push(params);
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 4250, balanceCents: 95750, transactionCount: 2 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return { items: [], total: 0 };
        },
      }),
    });
    const plan = routeIntent(B036_TEXT);
    const input: TurnInput = {
      intentionId: 'intent-b036',
      traceId: 'intent-b036',
      text: B036_TEXT,
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: null,
      attachments: [],
      channel: 'pwa-rest',
    };
    const envelope = await grounding.evidenceProvider(input, plan);
    expect(envelope).not.toBeNull();
    expect(calls).toContain('getMonthSummary');
    expect(calls).not.toContain('listRecentTransactions');
    expect(seen[0]).toMatchObject({ yearMonth: '2026-10' });
    expect(envelope!.items.map((item) => item.source)).toContain('api.month-summary');
  });

  it('5) turno: resumo ok + extrato não vazio responde o TOTAL (R$ 42,50), nunca a listagem', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
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
            data: { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 4250, balanceCents: 95750, transactionCount: 2 },
          },
          {
            ref: 'statement',
            source: 'api.transactions',
            retrievedAt: new Date().toISOString(),
            status: 'ok' as const,
            data: [{ description: 'Mercado', date: '2026-10-10', amountCents: -1234 }],
          },
        ],
      }),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: B036_TEXT, intentionId: 'intent-b036-final' }, identity),
    );
    expect(result.response?.text).toContain('42,50');
    expect(result.response?.text).not.toContain('Mercado');
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('6) reviewer turno: pedido de listagem lê extrato e rende listagem, nunca total geral', async () => {
    const text = 'mostre as despesas deste mês';
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async () => {
          calls.push('getMonthSummary');
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 4250, balanceCents: 95750, transactionCount: 2 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return {
            items: [
              { description: 'Mercado', date: '2026-10-10', amountCents: -1234 },
              { description: 'Farmácia', date: '2026-10-11', amountCents: -2000 },
            ],
            total: 2,
          };
        },
      }),
    });
    const plan = routeIntent(text) as TurnPlan;
    const evidenceProvider = (input: TurnInput) => grounding.evidenceProvider(input, plan);
    const responseProvider = vi.fn(async () => 'nunca usado no caminho determinístico');
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-listing' }, identity),
    );
    expect(calls).toContain('listRecentTransactions');
    expect(calls).not.toContain('getMonthSummary');
    expect(result.response?.text).toContain('Mercado');
    expect(result.response?.text).not.toContain('Resumo');
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('7) reviewer rota: total do mês com intervalo customizado é limitação honesta, sem leitura', () => {
    for (const text of [
      'total das despesas do mês entre os dias 10/10 e 15/10',
      'total das despesas do mês de 10/10 a 15/10',
      'total das despesas do mês do dia 10 ao dia 15',
      'total dos gastos do mês entre os dias 10 e 15',
      'total das despesas do mês há 3 dias',
      'total dos gastos do mês nos últimos 10 dias',
      'total mensal de 10 a 15 de outubro',
      'total mensal de 10 até 15 de outubro',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_custom_range');
    }
  });

  it('7e) faixa de valor sem mês não é janela: vai para limitação de filtro, nunca data nem resumo', () => {
    // "entre/de N a M reais" é restrição de VALOR, não período: não pode virar
    // `unsupported_custom_range` (rotularia valor como data) nem resumo.
    for (const text of [
      'total mensal entre 10 e 15 reais',
      'total mensal de 10 até 15 reais',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_value_range');
    }
  });

  it('7f) "entre/de N a M" sem moeda e sem mês é ambíguo: esclarecimento, nunca data, preço ou resumo', () => {
    // Sem marcador não dá para saber se é dia ou valor — classificar como um
    // dos dois seria invenção. Os marcados seguem nos limites específicos.
    for (const text of [
      'total mensal entre 10 e 15',
      'total mensal de 10 a 15',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('ambiguous_total_range');
    }
  });

  it('7b) o exemplo da copy é honesto: "quanto gastei em outubro de 2026?" resume o mês', () => {
    expect(opNames('quanto gastei em outubro de 2026?')).toContain('get_month_summary');
  });

  it('7c) debugger: "total mensal de outubro" (mês sem ano) pede o ano, sem leitura', () => {
    // Com now em novembro o resumo consultava novembro pelo mês corrente —
    // mês nomeado sem ano nunca resolve o corrente em silêncio (não invente ano).
    for (const text of ['total mensal de outubro', 'total mensal de dezembro']) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('unsupported');
      expect(plan.requestedOperations).toEqual([]);
      expect(plan.ambiguity).toBe('unsupported_month_year');
    }
  });

  it('7h) "total mensal de outubro de 2026" (mês com ano) resume 2026-10 mesmo com now em novembro', () => {
    const plan = routeIntent('total mensal de outubro de 2026');
    expect(plan.mode).toBe('read');
    expect(opNames('total mensal de outubro de 2026')).toContain('get_month_summary');
    expect(resolveSummaryYearMonth('total mensal de outubro de 2026', new Date('2026-11-05T12:00:00.000Z'))).toBe('2026-10');
  });

  it('7d) reviewer rota: "total mensal entre 10 e 15 de outubro" é limitação, nunca o mês cheio', () => {
    const plan = routeIntent('total mensal entre 10 e 15 de outubro');
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('unsupported_custom_range');
  });

  it('8) reviewer turno: intervalo customizado (dd/mm) responde a limitação sem leitura, sem provider, sem valor', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the custom-range path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'total das despesas do mês entre os dias 10/10 e 15/10', intentionId: 'intent-b036-custom' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8b) reviewer turno: intervalo "dia 10 ao dia 15" responde a mesma limitação, sem leitura', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the custom-range path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'total das despesas do mês do dia 10 ao dia 15', intentionId: 'intent-b036-custom-dia' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8c) reviewer turno: "há 3 dias" com mês responde a limitação, sem leitura nem valor', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the custom-range path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'total das despesas do mês há 3 dias', intentionId: 'intent-b036-custom-ha' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8d) reviewer turno: "total mensal entre 10 e 15 de outubro" com contraste não alega o mês cheio', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          calls.push('getMonthSummary');
          seen.push(params);
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return {
            items: [{ description: 'Mercado Super', date: '2026-10-12', amountCents: -1111 }],
            total: 1,
          };
        },
      }),
    });
    // Rota real (sem plano injetado): o terminal fail-closed responde antes de
    // qualquer leitura — os mocks contrastantes provam o não-uso.
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total mensal entre 10 e 15 de outubro';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-entre' }, identity),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    // Contraste: o mês cheio (R$ 999,99 / 9 lançamentos) nunca vaza; a janela
    // 10–15 nunca é alegada como aplicada.
    expect(calls).not.toContain('getMonthSummary');
    expect(seen).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8e) reviewer turno: "total mensal de 10 a 15 de outubro" com contraste não alega o mês cheio', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          calls.push('getMonthSummary');
          seen.push(params);
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return {
            items: [{ description: 'Mercado Super', date: '2026-10-12', amountCents: -1111 }],
            total: 1,
          };
        },
      }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total mensal de 10 a 15 de outubro';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-de-a' }, identity),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(calls).not.toContain('getMonthSummary');
    expect(seen).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8f) reviewer turno: faixa de valor ("entre 10 e 15 reais") responde limitação de filtro, sem leitura', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          calls.push('getMonthSummary');
          seen.push(params);
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return {
            items: [{ description: 'Mercado Super', date: '2026-10-12', amountCents: -1111 }],
            total: 1,
          };
        },
      }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total mensal entre 10 e 15 reais';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-val' }, identity),
    );
    // Valor, nunca data: nem a copy de intervalo, nem o total sem filtro.
    expect(result.response?.text).toBe(UNSUPPORTED_VALUE_RANGE_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_VALUE_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(calls).not.toContain('getMonthSummary');
    expect(calls).not.toContain('listRecentTransactions');
    expect(seen).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toMatch(/1\.111|11,11/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8g) reviewer turno: "de 10 até 15 de outubro" com contraste responde limitação de período', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          calls.push('getMonthSummary');
          seen.push(params);
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return {
            items: [{ description: 'Mercado Super', date: '2026-10-12', amountCents: -1111 }],
            total: 1,
          };
        },
      }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total mensal de 10 até 15 de outubro';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-de-ate' }, identity),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CUSTOM_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(calls).not.toContain('getMonthSummary');
    expect(seen).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('8i) debugger turno: "total mensal de outubro" com now em novembro pede o ano, zero leitura', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      // Clock fixo em novembro: sem o fix, a janela resolvia novembro e o
      // turno alegava o mês corrente pelo mês nomeado.
      now: () => new Date('2026-11-05T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          calls.push('getMonthSummary');
          seen.push(params);
          return { yearMonth: '2026-11', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listRecentTransactions: async () => {
          calls.push('listRecentTransactions');
          return {
            items: [{ description: 'Mercado Super', date: '2026-11-02', amountCents: -1111 }],
            total: 1,
          };
        },
      }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total mensal de outubro';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-monthyear' }, identity),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_MONTH_YEAR_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_MONTH_YEAR_TEXT);
    expect(result.mutation).toBeUndefined();
    // Novembro (R$ 999,99) nunca vaza; outubro nunca é alegado sem ano.
    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('10) reviewer turno: total com categoria implícita responde a limitação, sem leitura nem valor', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the category-total path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'total das despesas de supermercado neste mês', intentionId: 'intent-b036-cat-implicit' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CATEGORY_TOTAL_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CATEGORY_TOTAL_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('9) reviewer turno: total com categoria explícita responde a limitação, sem leitura nem catálogo', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the category-total path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'total das despesas da categoria supermercado neste mês', intentionId: 'intent-b036-cat' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_CATEGORY_TOTAL_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_CATEGORY_TOTAL_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('11) controle mutação: rascunho com valor continua mutation-proposal, fora das limitações', () => {
    for (const text of ['Gastei R$ 50 no mercado', 'Gastei R$ 12,50 na farmácia']) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('mutation-proposal');
      expect(plan.ambiguity).toBeNull();
    }
  });

  it('12) reviewer turno: "entre 10 e 15" sem marcador pede esclarecimento, sem leitura nem valor', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the ambiguous-range path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'total mensal entre 10 e 15', intentionId: 'intent-b036-bare' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(AMBIGUOUS_TOTAL_RANGE_TEXT);
    expect(result.clarification?.text).toBe(AMBIGUOUS_TOTAL_RANGE_TEXT);
    expect(result.mutation).toBeUndefined();
    // Nem soma, nem janela: sem valor e sem alegar período.
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('13) reviewer turno: "total das despesas do mês a pagar" com contraste não rende resumo geral', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async () => {
          calls.push('getMonthSummary');
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listAccountsPayable: async () => {
          calls.push('listAccountsPayable');
          return {
            items: [{ id: 'p1', description: 'Luz', amountCents: 1111 }],
            total: 1,
          };
        },
      }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total das despesas do mês a pagar';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-payables' }, identity),
    );
    // O contrato só prova a LISTA de payables (sem soma): nada pode ser lido
    // e o total do mês cheio (R$ 999,99) nunca vaza.
    expect(result.response?.text).toBe(UNSUPPORTED_PAYABLES_TOTAL_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_PAYABLES_TOTAL_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(calls).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('13b) reviewer turno: "total de boletos" com contraste também é limitação, zero leitura', async () => {
    const identity: AuthenticatedIdentity = {
      actorId: 'actor-b036',
      workspaceId: 'ws-b036',
      role: 'member',
      deviceId: 'device-b036',
    };
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async () => {
          calls.push('getMonthSummary');
          return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 99999, balanceCents: 1, transactionCount: 9 };
        },
        listAccountsPayable: async () => {
          calls.push('listAccountsPayable');
          return {
            items: [{ id: 'b1', description: 'Boleto net', amountCents: 2222 }],
            total: 1,
          };
        },
      }),
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const text = 'total de boletos';
    const plan = routeIntent(text) as TurnPlan;
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan,
      evidenceProvider: (input: TurnInput) => grounding.evidenceProvider(input, plan),
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'intent-b036-boletos' }, identity),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_PAYABLES_TOTAL_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_PAYABLES_TOTAL_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(calls).toEqual([]);
    expect(result.response?.text).not.toContain('999,99');
    expect(result.response?.text).not.toContain('22,22');
    expect(result.response?.text).not.toMatch(/Resumo/);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('14) reviewer turno: "Total da fatura com vencimento em outubro" não vira payables nem soma', async () => {
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the statement-total path');
    });
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: evidenceProvider as never,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Total da fatura com vencimento em outubro', intentionId: 'intent-b036-stat' },
        { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
      ),
    );
    expect(result.response?.text).toBe(UNSUPPORTED_STATEMENT_TOTAL_TEXT);
    expect(result.clarification?.text).toBe(UNSUPPORTED_STATEMENT_TOTAL_TEXT);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });
  it('15) mixed statement and payables totals do not invoke evidence or provider', async () => {
    const evidenceProvider = vi.fn(async () => { throw new Error('unexpected read'); });
    const responseProvider = vi.fn(async () => 'unexpected response');
    const orchestrator = new ConversationOrchestrator({ evidenceProvider: evidenceProvider as never, responseProvider, events: () => undefined });
    const result = await orchestrator.runTurn(normalizeRestTurn(
      { text: 'total das faturas e contas a pagar', intentionId: 'intent-b036-mixed' },
      { actorId: 'actor-b036', workspaceId: 'ws-b036', role: 'member', deviceId: 'device-b036' },
    ));
    expect(result.clarification).toBeDefined();
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });
});
