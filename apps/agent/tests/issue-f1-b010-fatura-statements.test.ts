/**
 * F1-B010/C010 — "Mostre minhas faturas" lê SÓ statements, nunca payables.
 *
 * Oráculo congelado em `tests/poc-structured/frozen/scenarios.json` (id
 * `F1-B010`): `reads: ["list_statements"]`, `expectedApiReads:
 * ["GET /cards/statements"]` — "Fatura means card statements, not accounts
 * payable or card list." O baseline congelado registra o FAIL de qualidade
 * C010: o turno lia `["GET /cards/statements", "GET /payables"]` (leitura
 * indevida de contas a pagar).
 *
 * Este teste é INDEPENDENTE do harness F1: exercita o `routeIntent` real e
 * o `createChannelGrounding` real com readTools mockadas (sem rede, sem
 * modelo, sem tocar nos geradores/relatórios F1). Distingue a leitura
 * indevida de `/payables` da conta a pagar EXPLICITAMENTE solicitada
 * (F1-B005 `Quais contas tenho que pagar`, `venc*`/`boleto`/`a pagar`).
 *
 * Preserva: B005 (payables explícito), S7 (conceito), S8 (ano não é valor),
 * S3 (fatura nua → statements, nunca cards) e vencimentos explícitos.
 */
import { describe, expect, it } from 'vitest';
import {
  serializeEvidenceForPrompt,
  type EvidenceEnvelope,
} from '../src/evidence/evidence-envelope.js';
import {
  createChannelGrounding,
  type ChannelReadTools,
} from '../src/orchestration/channel-evidence.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import type { TurnInput, TurnPlan } from '../src/orchestration/conversation-orchestrator.js';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

const hasMutationOp = (text: string): boolean =>
  routeIntent(text).requestedOperations.some((operation) => operation.kind === 'mutation');

const readTools = (overrides: Partial<ChannelReadTools>): ChannelReadTools => {
  const unused = async () => {
    throw new Error('read.not_planned');
  };
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

const inputFor = (text: string): TurnInput => ({
  intentionId: `intent-b010-${text.length}`,
  traceId: `intent-b010-${text.length}`,
  text,
  actorId: 'actor-b010',
  workspaceId: 'ws-b010',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
});

const callsFor = async (text: string) => {
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
      listCards: async () => {
        calls.push('listCards');
        return { items: [], total: 0 };
      },
    }),
  });
  const plan = routeIntent(text) as TurnPlan;
  const envelope = await grounding.evidenceProvider(inputFor(text), plan);
  return { calls, envelope, plan };
};

describe('F1-B010 — "Mostre minhas faturas" é statements, nunca payables', () => {
  it('1) rota: read com list_statements, sem list_payables/list_cards/list_accounts e sem mutação', () => {
    const plan = routeIntent('Mostre minhas faturas');
    expect(plan.mode).toBe('read');
    expect(opNames('Mostre minhas faturas')).toContain('list_statements');
    expect(opNames('Mostre minhas faturas')).not.toContain('list_payables');
    expect(opNames('Mostre minhas faturas')).not.toContain('list_cards');
    expect(opNames('Mostre minhas faturas')).not.toContain('list_accounts');
    expect(hasMutationOp('Mostre minhas faturas')).toBe(false);
  });

  it('2) evidência: fatura nua chama SÓ listStatements (nunca listAccountsPayable/listCards)', async () => {
    const { calls, envelope } = await callsFor('Mostre minhas faturas');
    expect(calls).toEqual(['listStatements']);
    expect(calls).not.toContain('listAccountsPayable');
    expect(calls).not.toContain('listCards');
    const sources = (envelope?.items ?? []).map((item) => item.source);
    expect(sources).toContain('api.statements');
    expect(sources).not.toContain('api.payables');
  });

  it('3) variante "quero pagar a fatura" (pagar sem conta) continua statements, sem payables', async () => {
    expect(opNames('quero pagar a fatura')).toContain('list_statements');
    expect(opNames('quero pagar a fatura')).not.toContain('list_payables');
    const { calls } = await callsFor('quero pagar a fatura');
    expect(calls).toEqual(['listStatements']);
  });
});

describe('F1-B010 — payables EXPLICITAMENTE solicitado continua lendo payables', () => {
  it('4) "quando vence minha fatura?" soma payables ao statements (vencimento explícito)', async () => {
    expect(opNames('quando vence minha fatura?')).toContain('list_statements');
    expect(opNames('quando vence minha fatura?')).toContain('list_payables');
    const { calls, envelope } = await callsFor('quando vence minha fatura?');
    expect(calls).toContain('listStatements');
    expect(calls).toContain('listAccountsPayable');
    const sources = (envelope?.items ?? []).map((item) => item.source);
    expect(sources).toContain('api.statements');
    expect(sources).toContain('api.payables');
  });

  it('5) B005 preservado: "Quais contas tenho que pagar" lê SÓ payables, sem statements', async () => {
    expect(opNames('Quais contas tenho que pagar')).toContain('list_payables');
    expect(opNames('Quais contas tenho que pagar')).not.toContain('list_statements');
    const { calls } = await callsFor('Quais contas tenho que pagar');
    expect(calls).toEqual(['listAccountsPayable']);
  });

  it('6) "mostre os boletos" / "contas a pagar" continuam payables, sem statements', () => {
    for (const text of ['mostre os boletos', 'contas a pagar']) {
      expect(opNames(text)).toContain('list_payables');
      expect(opNames(text)).not.toContain('list_statements');
    }
  });
});

describe('F1-B010 — controles S7/S8 preservados', () => {
  it('7) S7: "O que é fatura?" continua conceito (conversation/general, sem leitura)', () => {
    const plan = routeIntent('O que é fatura?');
    expect(plan.mode).toBe('conversation');
    expect(plan.domain).toBe('general');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('8) S8: "Quanto gastei em janeiro de 2020?" continua read sem mutação (ano nunca é valor)', () => {
    const plan = routeIntent('Quanto gastei em janeiro de 2020?');
    expect(plan.mode).toBe('read');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(hasMutationOp('Quanto gastei em janeiro de 2020?')).toBe(false);
    expect(opNames('Quanto gastei em janeiro de 2020?')).toContain('get_month_summary');
  });
});

/**
 * Oráculo apropriado do COMBINADO com vencimento explícito ("quando vence
 * minha fatura?" — sem oráculo congelado; F1-B010 congela só a fatura nua):
 * leituras esperadas `[statements, payables]`. A falha de qualquer leitura
 * (transporte ou payload fora do contrato) é status `error` no eixo de
 * FALHA (`retryable_error`/`permanent_error`/`forbidden`/`unavailable`),
 * nunca `empty`/ausência, nunca `workspace_empty` parcial — R04.
 */
const FAILURE_REASONS: ReadonlySet<string> = new Set([
  'retryable_error',
  'permanent_error',
  'forbidden',
  'unavailable',
]);

const combinedFor = async (
  statementsImpl: () => Promise<unknown>,
  payablesImpl: () => Promise<unknown>,
): Promise<{ calls: string[]; envelope: EvidenceEnvelope; plan: TurnPlan }> => {
  const calls: string[] = [];
  const grounding = createChannelGrounding({
    respond: async () => 'unused',
    events: () => undefined,
    readTools: readTools({
      listStatements: async () => {
        calls.push('listStatements');
        return statementsImpl();
      },
      listAccountsPayable: async () => {
        calls.push('listAccountsPayable');
        return payablesImpl();
      },
    }),
  });
  const text = 'quando vence minha fatura?';
  const plan = routeIntent(text) as TurnPlan;
  const envelope = await grounding.evidenceProvider(inputFor(text), plan);
  if (!envelope) throw new Error('envelope.expected');
  return { calls, envelope, plan };
};

const itemOf = (envelope: EvidenceEnvelope, source: string) =>
  envelope.items.find((item) => item.source === source);

const reasonsOf = (envelope: EvidenceEnvelope): unknown[] =>
  envelope.items.map((item) => (item.status === 'ok' ? undefined : item.reason));

describe('F1-B010 — combinado statements+payables: falha é error, nunca ausência', () => {
  it('9) statements com falha de transporte + payables vazio: error/unavailable vs empty, sem workspace_empty', async () => {
    const { calls, envelope } = await combinedFor(
      async () => {
        throw new Error('boom');
      },
      async () => ({ items: [], total: 0 }),
    );
    expect(calls).toContain('listStatements');
    expect(calls).toContain('listAccountsPayable');
    const statements = itemOf(envelope, 'api.statements');
    const payables = itemOf(envelope, 'api.payables');
    expect(statements?.status).toBe('error');
    expect(FAILURE_REASONS.has(statements?.reason as string)).toBe(true);
    expect(statements?.data).toBeNull();
    expect(payables?.status).toBe('empty');
    expect(payables?.reason).toBe('setup_incomplete');
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
    expect(serializeEvidenceForPrompt(envelope)).not.toContain('workspace_empty');
  });

  it('10) ambos com payload inválido {}: dois errors permanent_error, nenhum empty, sem workspace_empty', async () => {
    const { envelope } = await combinedFor(async () => ({}), async () => ({}));
    const statements = itemOf(envelope, 'api.statements');
    const payables = itemOf(envelope, 'api.payables');
    for (const [label, item] of [
      ['statements', statements],
      ['payables', payables],
    ] as const) {
      expect(item?.status, label).toBe('error');
      expect(item?.reason, label).toBe('permanent_error');
      expect(item?.data, label).toBeNull();
    }
    expect(envelope.items.some((item) => item.status === 'empty')).toBe(false);
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
    expect(serializeEvidenceForPrompt(envelope)).not.toContain('workspace_empty');
    expect(serializeEvidenceForPrompt(envelope)).not.toContain('"empty"');
  });

  it('11) linha inválida em statements ([null]) + payables vazio: statements error, sem virar ausência', async () => {
    const { envelope } = await combinedFor(
      async () => ({ items: [null], total: 1 }),
      async () => ({ items: [], total: 0 }),
    );
    const statements = itemOf(envelope, 'api.statements');
    const payables = itemOf(envelope, 'api.payables');
    expect(statements?.status).toBe('error');
    expect(statements?.reason).toBe('permanent_error');
    expect(statements?.data).toBeNull();
    expect(payables?.status).toBe('empty');
    expect(payables?.reason).toBe('setup_incomplete');
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
  });

  it('12) statements vazio + payables com falha 500: payables error/retryable, sem workspace_empty', async () => {
    const { envelope } = await combinedFor(
      async () => ({ items: [], total: 0 }),
      async () => {
        throw Object.assign(new Error('upstream'), { statusCode: 500 });
      },
    );
    const statements = itemOf(envelope, 'api.statements');
    const payables = itemOf(envelope, 'api.payables');
    expect(statements?.status).toBe('empty');
    expect(statements?.reason).toBe('setup_incomplete');
    expect(payables?.status).toBe('error');
    expect(payables?.reason).toBe('retryable_error');
    expect(payables?.data).toBeNull();
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
    expect(serializeEvidenceForPrompt(envelope)).not.toContain('workspace_empty');
  });

  it('13) ambos com falha de transporte: dois errors, nenhum empty, sem workspace_empty', async () => {
    const { envelope } = await combinedFor(
      async () => {
        throw new Error('boom-statements');
      },
      async () => {
        throw new Error('boom-payables');
      },
    );
    for (const item of envelope.items) {
      expect(item.status).toBe('error');
      expect(FAILURE_REASONS.has(item.reason as string)).toBe(true);
      expect(item.data).toBeNull();
    }
    expect(envelope.items.some((item) => item.status === 'empty')).toBe(false);
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
  });
});
