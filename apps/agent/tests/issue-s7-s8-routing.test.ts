/**
 * CODER-E-S7S8 — routing S7 (conceito), S8 (período passado) e S3 (faturas).
 *
 * S7: "O que é cartão de crédito?" é pergunta de conhecimento geral → plano
 * `general`/`conversation`, sem operação de leitura (nunca `list_cards`).
 * S8: "Quanto gastei em janeiro de 2020?" é CONSULTA de período passado → só
 * leitura (nunca `mutation-proposal`; o ano "2020" não é valor).
 * S3: "fatura" nua é fatura de CARTÃO (`list_statements`, contrato da tool
 * gerada + skill `contas-cartoes`) — nunca o pool de cartões; o override
 * "vencida/boleto/a pagar" continua somando `list_payables`.
 */
import { describe, expect, it } from 'vitest';
import {
  createChannelGrounding,
  resolveSummaryYearMonth,
  type ChannelReadTools,
} from '../src/orchestration/channel-evidence.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';
import type { TurnInput, TurnPlan } from '../src/orchestration/conversation-orchestrator.js';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

const isMutation = (text: string): boolean =>
  routeIntent(text).requestedOperations.some((operation) => operation.kind === 'mutation');

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

describe('S7 — pergunta conceitual nunca dispara leitura', () => {
  it('1) "O que é cartão de crédito?" é conversation/general, sem operações', () => {
    const plan = routeIntent('O que é cartão de crédito?');
    expect(plan.mode).toBe('conversation');
    expect(plan.domain).toBe('general');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('2) "Como funciona o cartão de crédito?" é conversation/general, sem operações', () => {
    const plan = routeIntent('Como funciona o cartão de crédito?');
    expect(plan.mode).toBe('conversation');
    expect(plan.domain).toBe('general');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('3) "O que é fatura?" é conceito (general), não leitura de payables', () => {
    const plan = routeIntent('O que é fatura?');
    expect(plan.mode).toBe('conversation');
    expect(plan.domain).toBe('general');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('4) regressão: "o que é meu saldo?" continua consulta de dados (accounts)', () => {
    const plan = routeIntent('O que é meu saldo?');
    expect(plan.mode).toBe('read');
    expect(opNames('O que é meu saldo?')).toContain('get_balance');
  });
});

describe('S8 — consulta de período passado nunca propõe mutação', () => {
  it('5) "Quanto gastei em janeiro de 2020?" é read (month-summary), nunca mutation-proposal', () => {
    const plan = routeIntent('Quanto gastei em janeiro de 2020?');
    expect(plan.mode).toBe('read');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(isMutation('Quanto gastei em janeiro de 2020?')).toBe(false);
    expect(opNames('Quanto gastei em janeiro de 2020?')).toContain('get_month_summary');
  });

  it('6) "Quanto gastei em 2020?" (ano nu) nunca propõe mutação', () => {
    const plan = routeIntent('Quanto gastei em 2020?');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(isMutation('Quanto gastei em 2020?')).toBe(false);
  });

  it('7) janela explícita: resolveSummaryYearMonth("...janeiro de 2020") = 2020-01', () => {
    const now = new Date('2026-10-15T12:00:00.000Z');
    expect(resolveSummaryYearMonth('Quanto gastei em janeiro de 2020?', now)).toBe('2020-01');
    expect(resolveSummaryYearMonth('Quanto gastei em dezembro de 2019?', now)).toBe('2019-12');
    // Relativo continua intacto (regressão #256 P2a).
    expect(resolveSummaryYearMonth('Quanto gastei no mês passado?', now)).toBe('2026-09');
    expect(resolveSummaryYearMonth('Quanto gastei esse mês?', now)).toBe('2026-10');
  });

  it('8) evidência: S8 lê getMonthSummary com yearMonth 2020-01', async () => {
    const seen: unknown[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      now: () => new Date('2026-10-15T12:00:00.000Z'),
      readTools: readTools({
        getMonthSummary: async (params) => {
          seen.push(params);
          return { yearMonth: '2020-01', incomeCents: 0, expenseCents: 0, balanceCents: 0, transactionCount: 0 };
        },
      }),
    });
    const input: TurnInput = {
      intentionId: 'intent-s8',
      traceId: 'intent-s8',
      text: 'Quanto gastei em janeiro de 2020?',
      actorId: 'actor-s8',
      workspaceId: 'ws-s8',
      role: 'member',
      deviceId: null,
      attachments: [],
      channel: 'pwa-rest',
    };
    const plan: TurnPlan = {
      version: '2',
      mode: 'read',
      domain: 'transactions',
      skillNames: ['relatorios'],
      requestedOperations: [{ name: 'get_month_summary', kind: 'read' }],
      missingFields: [],
      ambiguity: null,
      confidence: 1,
    };
    const envelope = await grounding.evidenceProvider(input, plan);
    expect(envelope).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ yearMonth: '2020-01' });
  });

  it('9) HIGH: mês+ano não resolvido clarifica data (nunca carimba hoje)', () => {
    // O parser só resolve hoje/ontem/anteontem; "janeiro de 2020" virava
    // hoje em silêncio. Mutação datada resolvível usa data relativa.
    const plan = routeIntent('Gastei R$ 50 em janeiro de 2020 no mercado');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(isMutation('Gastei R$ 50 em janeiro de 2020 no mercado')).toBe(false);
    const dated = routeIntent('Gastei R$ 50 ontem no mercado');
    expect(dated.mode).toBe('mutation-proposal');
    expect(opNames('Gastei R$ 50 ontem no mercado')).toContain('transactions.expense.create');
  });
});

describe('S3 — "fatura" nua é statement, não pool de cartões', () => {
  it('10) "Mostre minhas faturas" planeja list_statements, nunca list_cards', () => {
    const plan = routeIntent('Mostre minhas faturas');
    expect(plan.mode).toBe('read');
    expect(plan.domain).not.toBe('cards');
    expect(opNames('Mostre minhas faturas')).toContain('list_statements');
    expect(opNames('Mostre minhas faturas')).not.toContain('list_cards');
  });

  it('11) override preservado: "fatura vencida/boleto/a pagar" continua com list_payables', () => {
    expect(opNames('quando vence minha fatura?')).toContain('list_payables');
    expect(opNames('mostre os boletos')).toContain('list_payables');
    expect(opNames('contas a pagar')).toContain('list_payables');
  });

  it('12) evidência: plano de "faturas" lê statements (listStatements é chamado)', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        listStatements: async () => {
          calls.push('listStatements');
          return { items: [], total: 0 };
        },
        listAccountsPayable: async () => {
          calls.push('listAccountsPayable');
          return { items: [], total: 0 };
        },
      }),
    });
    const input: TurnInput = {
      intentionId: 'intent-s3',
      traceId: 'intent-s3',
      text: 'Mostre minhas faturas',
      actorId: 'actor-s3',
      workspaceId: 'ws-s3',
      role: 'member',
      deviceId: null,
      attachments: [],
      channel: 'pwa-rest',
    };
    const plan = routeIntent('Mostre minhas faturas') as TurnPlan;
    const envelope = await grounding.evidenceProvider(input, plan);
    expect(envelope).not.toBeNull();
    expect(calls).toContain('listStatements');
  });
});

describe('REVIEWER-FULL — P1/P2a/P2c (turno completo via routeIntent)', () => {
  it('P1) "Quanto gastei em reais em janeiro de 2020?" é read (ano em data nunca é valor)', () => {
    const plan = routeIntent('Quanto gastei em reais em janeiro de 2020?');
    expect(plan.mode).toBe('read');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(isMutation('Quanto gastei em reais em janeiro de 2020?')).toBe(false);
    expect(opNames('Quanto gastei em reais em janeiro de 2020?')).toContain('get_month_summary');
  });

  it('P1-controle) valor colado ao marcador continua mutação ("Gastei R$ 2020 no mercado")', () => {
    const plan = routeIntent('Gastei R$ 2020 no mercado');
    expect(plan.mode).toBe('mutation-proposal');
    expect(isMutation('Gastei R$ 2020 no mercado')).toBe(true);
  });

  it('P2a) "Me explique quanto gastei este mês" é read com get_month_summary (nunca conversation sem leitura)', () => {
    const plan = routeIntent('Me explique quanto gastei este mês');
    expect(plan.mode).toBe('read');
    expect(opNames('Me explique quanto gastei este mês')).toContain('get_month_summary');
  });

  it('P2a) "Me explique o extrato de janeiro" é read com list_transactions (nunca conversation sem leitura)', () => {
    const plan = routeIntent('Me explique o extrato de janeiro');
    expect(plan.mode).toBe('read');
    expect(opNames('Me explique o extrato de janeiro')).toContain('list_transactions');
  });

  it('P2c) "Quanto gastei em 2020?" (ano isolado) nunca resolve mês — plano sem operação', () => {
    const plan = routeIntent('Quanto gastei em 2020?');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(isMutation('Quanto gastei em 2020?')).toBe(false);
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.mode).not.toBe('read');
  });

  it('P2c-turno) runTurn responde a limitação honesta sem provider e sem leitura', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Quanto gastei em 2020?', intentionId: 'intent-p2c-honest' },
        { actorId: 'actor-p2c', workspaceId: 'ws-p2c', role: 'member', deviceId: 'device-p2c' },
      ),
    );
    expect(result.response?.text).toContain('ano inteiro');
    expect(result.response?.text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(result.clarification?.missingFields).toContain('period');
  });
});

describe('REVIEWER-F2/G — residuais (ano em consulta, listagem explícita)', () => {
  it('G-P1) "Quanto gastei no total de 2020?" nunca propõe mutação (unsupported_year)', () => {
    for (const text of [
      'Quanto gastei no total de 2020?',
      'Quanto gastei no ano de 2020?',
      'Quanto gastei de 2020?',
    ]) {
      const plan = routeIntent(text);
      expect(plan.mode).not.toBe('mutation-proposal');
      expect(isMutation(text)).toBe(false);
      expect(plan.mode).toBe('unsupported');
      expect(plan.ambiguity).toBe('unsupported_year');
    }
  });

  it('G-P1-controle) valor legítimo continua mutação; "mês passado" continua resumo', () => {
    expect(routeIntent('Gastei 90 no mercado').mode).toBe('mutation-proposal');
    expect(routeIntent('Gastei R$ 2020 no mercado').mode).toBe('mutation-proposal');
    expect(routeIntent('Gastei 2020 reais no mercado').mode).toBe('mutation-proposal');
    const past = routeIntent('Gastei no mês passado');
    expect(past.mode).toBe('read');
    expect(opNames('Gastei no mês passado')).toContain('get_month_summary');
  });

  it('G-P2) "Me explique as transações de janeiro" é read com list_transactions', () => {
    const plan = routeIntent('Me explique as transações de janeiro');
    expect(plan.mode).toBe('read');
    expect(opNames('Me explique as transações de janeiro')).toContain('list_transactions');
  });

  it('G-P2-controle) "O que é cartão de crédito?" e "O que é fatura?" continuam conceito', () => {
    for (const text of ['O que é cartão de crédito?', 'O que é fatura?']) {
      const plan = routeIntent(text);
      expect(plan.mode).toBe('conversation');
      expect(plan.requestedOperations).toEqual([]);
    }
  });
});
