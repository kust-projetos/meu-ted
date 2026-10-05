/**
 * F2 (MAJOR) — payload FORA do contrato nunca pode ser narrado como "vazio".
 *
 * O defeito: `pickRows` devolvia `[]` para QUALQUER coisa que não fosse um
 * array com a chave reconhecida (`null`, `{}`, `{rows: []}`, `[]`), e os
 * mappers convertiam esse `[]` em `empty`/`setup_incomplete`. Uma resposta
 * quebrada ficava INDISTINGUÍVEL de uma lista genuinamente vazia — e, quando
 * duas leituras quebravam, a agregação publicava `workspace_empty`. É a
 * inversão de R04: "a leitura quebrou" narrado como "não há nada lá".
 *
 * A armadilha é o cliente GERADO (`generated/http-tools.ts`, `project()`):
 * - `result: null` (goals/budgets/payables/statements) → `{success, ...body}`,
 *   body cru; um `{}` chega como `{}`.
 * - `result.kind: 'items'` (accounts/categories/transactions) → consome
 *   `response.items` e MANUFATURA a chave projetada (`accounts`, `categories`,
 *   `transactions`) como array — mesmo quando o corpo não tinha `items`.
 *
 * Por isso a verificação mora AQUI, no layer do channel-evidence, sobre o
 * payload cru, e aceita SOMENTE a chave que o contrato real das rotas
 * declara. Aceitar também a chave projetada reabriria exatamente o buraco:
 * `{}` → `{success:true, accounts: []}`.
 *
 * Contrato real (todas as 7 rotas de lista em `apps/api`):
 *   `GET /accounts`            → `{items, total}`                    (accounts.ts:75)
 *   `GET /transactions`        → `{items, total, limit, offset}`     (transactions.ts:27)
 *   `GET /goals`               → `{items, total}`                    (goals.ts:64)
 *   `GET /budgets`             → `{items, total}`                    (budgets.ts:65)
 *   `GET /payables`            → `{items, total}`                    (payables.ts:159)
 *   `GET /categories`          → `{items, total}`                    (categories.ts:62)
 *   `GET /cards/statements`    → `{items, total}`                    (cards.ts:159)
 */
import { describe, expect, it, vi } from 'vitest';
import { serializeEvidenceForPrompt, type EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';
import { createChannelGrounding, type ChannelReadTools } from '../../src/orchestration/channel-evidence.js';
import type { TurnInput, TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';
import * as apiClient from '../../src/tools/api-client.js';

const input: TurnInput = {
  intentionId: 'intent-f2-shape',
  traceId: 'intent-f2-shape',
  text: 'como estão minhas metas?',
  actorId: 'actor-f2-shape',
  workspaceId: 'ws-f2-shape',
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

const envelopeFor = async (plan: TurnPlan, tools: Partial<ChannelReadTools>): Promise<EvidenceEnvelope> => {
  const grounding = createChannelGrounding({ respond: async () => 'unused', readTools: readTools(tools) });
  const envelope = await grounding.evidenceProvider(input, plan);
  if (!envelope) throw new Error('envelope.expected');
  return envelope;
};

const reasonsOf = (envelope: EvidenceEnvelope): unknown[] =>
  envelope.items.map((item) => (item.status === 'ok' ? undefined : item.reason));

/** Todas as leituras de LISTA do channel-evidence e o caminho que as alcança. */
const LIST_READS: ReadonlyArray<[string, keyof ChannelReadTools]> = [
  ['list_accounts', 'listAccounts'],
  ['list_recent_transactions', 'listRecentTransactions'],
  ['list_statements', 'listStatements'],
  ['list_accounts_payable', 'listAccountsPayable'],
  ['list_budgets', 'listBudgets'],
  ['list_goals', 'listGoals'],
  ['list_categories', 'listCategories'],
];

describe('F2: payload fora do contrato é FALHA, nunca lista vazia', () => {
  const outOfContract: ReadonlyArray<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['objeto vazio {}', {}],
    ['chave errada (rows)', { rows: [], total: 0 }],
    ['chave errada (data)', { data: [], total: 0 }],
    ['coleção não-array (string)', { items: 'nada', total: 0 }],
    ['coleção não-array (objeto)', { items: { 0: {} }, total: 1 }],
    ['coleção não-array (null)', { items: null, total: 0 }],
    ['array cru no topo', []],
    ['primitivo no topo', 'sem-forma'],
    ['payload só com a chave projetada', { success: true, accounts: [] }],
  ];

  for (const [label, payload] of outOfContract) {
    it(`RED: ${label} nunca vira empty — é permanent_error`, async () => {
      for (const [operation, tool] of LIST_READS) {
        const envelope = await envelopeFor(planFor([operation]), {
          [tool]: async () => payload,
        } as Partial<ChannelReadTools>);
        const item = envelope.items[0];
        expect(item?.status, `${operation} / ${label}`).toBe('error');
        expect(item?.reason, `${operation} / ${label}`).toBe('permanent_error');
        expect(item?.data, `${operation} / ${label}`).toBeNull();
        // A falha nunca se apresenta como ausência no prompt.
        expect(reasonsOf(envelope), `${operation} / ${label}`).not.toContain('setup_incomplete');
        expect(reasonsOf(envelope), `${operation} / ${label}`).not.toContain('period_empty');
        expect(serializeEvidenceForPrompt(envelope), `${operation} / ${label}`).not.toContain('"empty"');
      }
    });
  }

  it('RED: payload malformado BLOQUEIA a agregação workspace_empty', async () => {
    // Duas leituras quebradas: sem shape gate viravam dois `empty` e o
    // agregador publicava "o workspace está vazio" sem nunca ter lido dado.
    const envelope = await envelopeFor(planFor(['get_balance'], 'transactions'), {
      listAccounts: async () => ({}),
      listRecentTransactions: async () => ({}),
    });
    expect(reasonsOf(envelope)).toContain('permanent_error');
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
    expect(serializeEvidenceForPrompt(envelope)).not.toContain('workspace_empty');
  });

  it('RED: lista vazia REAL continua sendo ausência legítima', async () => {
    // O caminho feliz do gate: `{items: [], total: 0}` é o que a rota responde
    // quando o workspace não tem nada daquele tipo.
    const envelope = await envelopeFor(planFor(['list_goals']), {
      listGoals: async () => ({ items: [], total: 0 }),
    });
    expect(envelope.items[0]?.status).toBe('empty');
    expect(envelope.items[0]?.reason).toBe('setup_incomplete');
    expect(envelope.items[0]?.data).toEqual([]);
    expect(reasonsOf(envelope)).not.toContain('workspace_empty');
  });

  it('RED: lista vazia REAL em duas fontes agrega workspace_empty', async () => {
    const envelope = await envelopeFor(planFor(['get_balance'], 'transactions'), {
      listAccounts: async () => ({ items: [], total: 0 }),
      listRecentTransactions: async () => ({ items: [], total: 0 }),
    });
    expect(reasonsOf(envelope)).toContain('workspace_empty');
  });

  it('RED: lista preenchida no contrato real continua `ok` e sem reason', async () => {
    const envelope = await envelopeFor(planFor(['list_budgets']), {
      listBudgets: async () => ({ items: [{ id: 'b-1', name: 'Mercado', monthlyCents: 50000 }], total: 1 }),
    });
    expect(envelope.items[0]?.status).toBe('ok');
    expect('reason' in envelope.items[0]!).toBe(false);
  });
});

describe('F2: elemento inválido dentro de uma lista no contrato', () => {
  /**
   * DECISÃO: o tratamento de elemento depende do que a leitura faz com ele.
   *
   * - `accounts`/`transactions` PROJETAM cada linha no shape do renderizador
   *   determinístico. Ali a linha inválida é contada e declarada
   *   (`omittedCount`/`accounts:incomplete`) ou, se nenhuma linha serve, a
   *   leitura inteira vira `permanent_error`. Já é o comportamento vigente e
   *   ele é honesto: parcialidade explícita, nunca um zero silencioso.
   * - statements/payables/budgets/goals/categories NÃO projetam: o payload
   *   viaja INTEIRO para dentro de `data` e dali para o prompt do modelo.
   *   Descartar uma linha inválida ali exigiria moldar o payload (mudando o
   *   contrato que o modelo lê) e, sem moldar, a linha quebrada chegaria
   *   intacta ao prompt — um dado que ninguém renderiza, tocado como se fosse
   *   válido. Logo: um elemento que não é objeto é fora de contrato e derruba
   *   a leitura com `permanent_error`. É fail-closed e não perde informação.
   */
  it('RED: elemento não-objeto em lista singleton derruba a leitura', async () => {
    const envelope = await envelopeFor(planFor(['list_payables']), {
      listAccountsPayable: async () => ({ items: [null], total: 1 }),
    });
    expect(envelope.items[0]?.status).toBe('error');
    expect(envelope.items[0]?.reason).toBe('permanent_error');
  });

  it('RED: elemento não-objeto entre linhas VÁLIDAS também derruba (não passa adiante)', async () => {
    const envelope = await envelopeFor(planFor(['list_categories']), {
      listCategories: async () => ({ items: [{ id: 'c-1', householdId: 'ws-1', name: 'Mercado', kind: 'expense', status: 'active' }, 'lixo'], total: 2 }),
    });
    expect(envelope.items[0]?.status).toBe('error');
    expect(envelope.items[0]?.reason).toBe('permanent_error');
  });

  it('linha vazia com array de objetos é ausência legítima', async () => {
    const envelope = await envelopeFor(planFor(['list_statements']), {
      listStatements: async () => ({ items: [], total: 0 }),
    });
    expect(envelope.items[0]?.status).toBe('empty');
    expect(envelope.items[0]?.reason).toBe('setup_incomplete');
  });

  it('elemento inválido em `accounts` mantém a partialidade já declarada', async () => {
    // Precedente preservado: linha ruim é CONTADA, não silenciosamente
    // descartada, e a lista segue `ok` com `incomplete`.
    const envelope = await envelopeFor(planFor(['list_accounts']), {
      listAccounts: async () => ({
        items: [{ id: 'a-1', name: 'Itaú', kind: 'bank', balanceCents: 10000 }, { id: 'a-2' }],
        total: 2,
      }),
    });
    const refs = envelope.items.map((item) => item.ref);
    expect(refs).toContain('accounts:incomplete');
    expect(reasonsOf(envelope)).not.toContain('permanent_error');
  });

  it('TODAS as linhas inválidas em `accounts` continuam sendo permanent_error', async () => {
    const envelope = await envelopeFor(planFor(['list_accounts']), {
      listAccounts: async () => ({ items: [null, 'x'], total: 2 }),
    });
    expect(envelope.items[0]?.status).toBe('error');
    expect(envelope.items[0]?.reason).toBe('permanent_error');
  });
});

describe('F2: o gate fecha o buraco do cliente GERADO (sem editar o gerado)', () => {
  /**
   * Prova de ponta a ponta contra o `project()` real de
   * `generated/http-tools.ts`: um corpo `{}` da API vira
   * `{success:true, accounts: []}` — com a chave projetada ARRAY e `items`
   * AUSENTE. É exatamente o payload que fazia o workspace parecer vazio.
   */
  const withGeneratedClient = async (body: unknown): Promise<EvidenceEnvelope> => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue(body as never);
    try {
      const grounding = createChannelGrounding({
        respond: async () => 'unused',
        apiOrigin: 'https://api.test.local',
        readToken: async () => 'token-f2',
      });
      const envelope = await grounding.evidenceProvider(input, planFor(['list_accounts']));
      if (!envelope) throw new Error('envelope.expected');
      return envelope;
    } finally {
      spy.mockRestore();
      apiClient.clearGlobalApiContext();
    }
  };

  it('RED: corpo {} da API NÃO vira "conta vazia"', async () => {
    const envelope = await withGeneratedClient({});
    expect(envelope.items[0]?.status).toBe('error');
    expect(envelope.items[0]?.reason).toBe('permanent_error');
  });

  it('RED: corpo com `items` inválido (string) NÃO vira "conta vazia"', async () => {
    const envelope = await withGeneratedClient({ items: 'nada', total: 0 });
    expect(envelope.items[0]?.status).toBe('error');
    expect(envelope.items[0]?.reason).toBe('permanent_error');
  });

  it('corpo real `{items: [], total: 0}` vira ausência legítima', async () => {
    const envelope = await withGeneratedClient({ items: [], total: 0 });
    expect(envelope.items[0]?.status).toBe('empty');
    expect(envelope.items[0]?.reason).toBe('setup_incomplete');
  });

  it('corpo real `{items: [...], total: n}` vira evidência `ok`', async () => {
    const envelope = await withGeneratedClient({
      items: [{ id: 'a-1', name: 'Itaú', kind: 'bank', balanceCents: 10000, status: 'active' }],
      total: 1,
    });
    expect(envelope.items[0]?.status).toBe('ok');
    const data = envelope.items[0]?.data as { accountName?: string; balanceCents?: number };
    expect(data.accountName).toBe('Itaú');
    expect(data.balanceCents).toBe(10000);
  });
});