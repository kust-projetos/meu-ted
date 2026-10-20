/**
 * POC Fase 2 — testes do protótipo isolado reads-only.
 *
 * Cobre os 8 cenários do PLAN com readers stubados no MESMO contrato
 * `ChannelReadTools` do hot path. Sem rede, sem segredos, sem writes.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import { PocMinimalAgent } from '../src/poc-minimal/poc-agent.js';
import { describePocModelConfig, resolvePocModelConfig } from '../src/poc-minimal/poc-config.js';
import { POC_SCENARIO_TEXTS, routePocIntent, type PocScenarioId } from '../src/poc-minimal/poc-intent.js';
import { POC_READ_NAMES, assertPocReadName } from '../src/poc-minimal/poc-reads.js';
import { POC_SYSTEM_PROMPT } from '../src/poc-minimal/poc-system.js';

const stubTools = (overrides: Partial<ChannelReadTools>): ChannelReadTools => {
  const fail = async () => {
    throw new Error('poc.read_not_stubbed');
  };
  return {
    listAccounts: fail,
    listRecentTransactions: fail,
    getMonthSummary: fail,
    listCards: fail,
    listStatements: fail,
    listAccountsPayable: fail,
    listBudgets: fail,
    listGoals: fail,
    listCategories: fail,
    analyticsKpis: fail,
    analyticsCategoryBreakdown: fail,
    ...overrides,
  } as unknown as ChannelReadTools;
};

const FIXED_NOW = () => new Date('2026-10-15T12:00:00.000Z');

describe('poc-minimal reads-only', () => {
  it('registry contém só reads (6) e rejeita writes/desconhecidos', () => {
    expect([...POC_READ_NAMES]).toEqual([
      'listAccounts',
      'listCards',
      'listTransactions',
      'listStatements',
      'getMonthSummary',
      'listCategories',
    ]);
    for (const write of [
      'createTransaction',
      'transactions.expense.create',
      'propose',
      'confirm',
      'execute',
      'cancel',
    ]) {
      expect(() => assertPocReadName(write)).toThrow('poc.read_not_allowed');
    }
  });

  it('config de modelo reutiliza o registry e nunca expõe segredo', () => {
    const config = resolvePocModelConfig({});
    expect(config.providerKind).toBe('opencode-zen');
    expect(config.protocol).toBe('chat-completions');
    expect(config.keyPresent).toBe(false);
    const line = describePocModelConfig(config);
    expect(line).toBe(
      'provider=opencode-zen model=poc-cheap-default protocol=chat-completions key=OPENCODE_ZEN_API_KEY:absent',
    );
  });

  it('system prompt mínimo: pt-BR, reads-only, sem injeção de usuário', () => {
    expect(POC_SYSTEM_PROMPT).toContain('somente leitura');
    expect(POC_SYSTEM_PROMPT).toContain('nunca invente');
    expect(POC_SYSTEM_PROMPT).not.toContain('{{');
  });

  it('S1 contas: roteia listAccounts e fundamenta com a evidência', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listAccounts: async () => ({
          items: [
            { accountName: 'Nubank', balanceCents: 34567 },
            { accountName: 'Inter', balanceCents: 10000 },
          ],
          total: 2,
        }),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S1, 'S1');
    expect(result.telemetry.read).toBe('listAccounts');
    expect(result.answer).toContain('Nubank');
    expect(result.answer).toContain('R$ 345,67');
    expect(result.telemetry.grounded).toBe(true);
    expect(result.telemetry.hallucination).toBe(false);
    expect(agent.turnCount).toBe(2);
  });

  it('S2 cartões: roteia listCards (nunca statements)', async () => {
    const calls: string[] = [];
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listCards: async () => {
          calls.push('listCards');
          return { items: [{ name: 'Nubank final 1234' }], total: 1 };
        },
        listStatements: async () => {
          calls.push('listStatements');
          return { items: [], total: 0 };
        },
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S2, 'S2');
    expect(calls).toEqual(['listCards']);
    expect(result.answer).toContain('Nubank');
    expect(result.telemetry.grounded).toBe(true);
  });

  it('S3 faturas: roteia listStatements (nunca o pool de cartões)', async () => {
    const calls: string[] = [];
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listCards: async () => {
          calls.push('listCards');
          return { items: [], total: 0 };
        },
        listStatements: async () => {
          calls.push('listStatements');
          return { items: [{ id: 'f1' }], total: 1 };
        },
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S3, 'S3');
    expect(calls).toEqual(['listStatements']);
    expect(result.telemetry.completed).toBe(true);
  });

  it('S4/S5 resumo mensal: corrente vs. passada com yearMonth correto', async () => {
    const seen: unknown[] = [];
    const tools = stubTools({
      getMonthSummary: async (params) => {
        seen.push(params);
        return { yearMonth: '2026-10', incomeCents: 100000, expenseCents: 5000, balanceCents: 95000, transactionCount: 3 };
      },
    });
    const agent = new PocMinimalAgent({ readTools: tools, now: FIXED_NOW });
    const current = await agent.answerTurn(POC_SCENARIO_TEXTS.S4, 'S4');
    expect(current.answer).toContain('R$ 50,00');
    expect(seen[0]).toMatchObject({ yearMonth: '2026-10' });

    seen.length = 0;
    const past = await agent.answerTurn(POC_SCENARIO_TEXTS.S5, 'S5');
    expect(seen[0]).toMatchObject({ yearMonth: '2026-09' });
    expect(past.telemetry.read).toBe('getMonthSummary');
  });

  it('S6 supermercado: lista transacional com filtro (nunca resumo)', async () => {
    const intent = routePocIntent(POC_SCENARIO_TEXTS.S6, new Date('2026-10-15T12:00:00.000Z'));
    expect(intent.kind).toBe('read');
    expect(intent.kind === 'read' ? intent.read : '').toBe('listTransactions');
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listRecentTransactions: async () => ({
          items: [{ description: 'Mercado do Zé', date: '2026-10-10', amountCents: 12345 }],
          total: 1,
        }),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S6, 'S6');
    expect(result.answer).toContain('Mercado do Zé');
    expect(result.telemetry.grounded).toBe(true);
  });

  it('S7 conceito: sem leitura, resposta geral concluída', async () => {
    const calls: string[] = [];
    const tools = stubTools({
      listCards: async () => {
        calls.push('listCards');
        return { items: [], total: 0 };
      },
    });
    const agent = new PocMinimalAgent({ readTools: tools, now: FIXED_NOW });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S7, 'S7');
    expect(calls).toEqual([]);
    expect(result.telemetry.tool).toBeNull();
    expect(result.telemetry.completed).toBe(true);
    expect(result.answer.length).toBeGreaterThan(20);
  });

  it('S8 período sem dados: ausência do escopo, sem valor fictício', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        getMonthSummary: async () => ({ yearMonth: '2020-01', transactionCount: 0 }),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S8, 'S8');
    expect(result.answer).toContain('2020-01');
    expect(result.answer).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
    expect(result.telemetry.completed).toBe(true);
  });

  it('falha de leitura: fail-closed sem dígitos', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listAccounts: async () => {
          throw new Error('api.down');
        },
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S1, 'S1-fail');
    expect(result.telemetry.completed).toBe(false);
    expect(result.answer).not.toMatch(/\d/);
  });

  it('histórico acumula turnos (conversa multi-turno)', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listAccounts: async () => ({ items: [{ accountName: 'Nubank', balanceCents: 1 }], total: 1 }),
      }),
      now: FIXED_NOW,
    });
    await agent.answerTurn(POC_SCENARIO_TEXTS.S1, 'S1');
    await agent.answerTurn(POC_SCENARIO_TEXTS.S7, 'S7');
    expect(agent.turnCount).toBe(4);
  });

  it('roteador cobre os 8 cenários sem cair em geral (exceto S7)', () => {
    const expectations: Record<PocScenarioId, string> = {
      S1: 'listAccounts',
      S2: 'listCards',
      S3: 'listStatements',
      S4: 'getMonthSummary',
      S5: 'getMonthSummary',
      S6: 'listTransactions',
      S7: 'general',
      S8: 'getMonthSummary',
    };
    for (const [id, expected] of Object.entries(expectations)) {
      const intent = routePocIntent(POC_SCENARIO_TEXTS[id as PocScenarioId], new Date('2026-10-15T12:00:00.000Z'));
      const actual = intent.kind === 'general' ? 'general' : intent.read;
      expect(actual).toBe(expected);
    }
  });

  it('P2d) payload inválido ({}) não conclui: completed=false', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        getMonthSummary: async () => ({}),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S8, 'S8-invalid');
    expect(result.telemetry.completed).toBe(false);
  });

  it('P2d) resumo sem campos (só yearMonth) não conclui: completed=false', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        getMonthSummary: async () => ({ yearMonth: '2020-01' }),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S8, 'S8-no-fields');
    expect(result.telemetry.completed).toBe(false);
  });

  it('REVIEWER-F2/G) resumo só com incomeCents não conclui: completed=false', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        getMonthSummary: async () => ({ yearMonth: '2020-01', incomeCents: 100 }),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S8, 'S8-income-only');
    expect(result.answer).toBe(
      'Não consegui apurar os dados agora (falha de leitura). Nenhum valor foi considerado — tente novamente.',
    );
    expect(result.telemetry.grounded).toBe(true);
    expect(result.telemetry.completed).toBe(false);
  });

  it('REVIEWER-F2/G) lista sem campo exibível ([{}]) não conclui: completed=false', async () => {
    const agent = new PocMinimalAgent({
      readTools: stubTools({
        listAccounts: async () => ({ items: [{}], total: 1 }),
      }),
      now: FIXED_NOW,
    });
    const result = await agent.answerTurn(POC_SCENARIO_TEXTS.S1, 'S1-empty-item');
    expect(result.telemetry.grounded).toBe(true);
    expect(result.telemetry.completed).toBe(false);
  });
});
