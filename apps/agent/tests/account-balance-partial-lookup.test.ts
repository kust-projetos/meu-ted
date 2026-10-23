/**
 * ted-local-account-partial-balance — RED: partial/anaphoric balance lookup.
 *
 * Bug (browser QA): one active bank `QA Aurora banco`; `saldo QA Aurora` and
 * `e o saldo daquela conta` answer notfound while the full exact name works.
 * Root causes: `matchAccountsByName` demands every long name token
 * (guard 186..194) and the single-selection guard demands the complete name
 * (1123..1127). Fix: a single significant normalized partial match may read;
 * `aquela/essa conta` anaphora resolves only with an unequivocal
 * authoritative context (single account scope, no other specific query).
 * Never arbitrary prefixes, fuzzy matching, invented names, or figures on
 * ambiguity — the financial guard stands.
 */
import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator, type TurnInput, type TurnPlan } from '../src/orchestration/conversation-orchestrator.js';
import { createChannelGrounding, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import { routeIntent } from '../src/orchestration/intent-router.js';

const inputFor = (text: string, intentionId: string): TurnInput =>
  ({
    intentionId,
    traceId: intentionId,
    text,
    actorId: 'actor-test',
    workspaceId: 'ws-test',
    role: 'member',
    deviceId: 'device-test',
    attachments: [],
    channel: 'pwa-rest',
  }) as TurnInput;

const planFor = (input: TurnInput): TurnPlan => routeIntent(input.text) as unknown as TurnPlan;

const WORKSPACE_ID = 'ws-test';

const routeAccountsPayload = (payload: unknown): unknown => {
  const injected = (typeof payload === 'object' && payload !== null ? payload : {}) as { items?: unknown };
  const rows = Array.isArray(injected.items) ? injected.items : [];
  return {
    ...injected,
    items: rows.map((row) => ({ householdId: WORKSPACE_ID, ...(row as Record<string, unknown>) })),
    total: rows.length,
  };
};

const stubReads = (accountsPayload: unknown): ChannelReadTools => {
  const fail = async () => {
    throw new Error('agent.evidence_tool_missing:unused-in-test');
  };
  return {
    listAccounts: async () => routeAccountsPayload(accountsPayload),
    listRecentTransactions: fail,
    getMonthSummary: fail,
    listStatements: async () => ({ items: [] }),
    listCards: fail,
    listAccountsPayable: fail,
    listBudgets: fail,
    listGoals: fail,
    listCategories: fail,
    analyticsKpis: fail,
    analyticsCategoryBreakdown: fail,
  };
};

const runBalanceTurn = async (text: string, accountsPayload: unknown, intentionId: string) => {
  const grounding = createChannelGrounding({
    respond: async () => {
      throw new Error('LLM must not be called on the deterministic balance path');
    },
    readTools: stubReads(accountsPayload),
    readToken: async () => 'test-token',
    apiOrigin: 'https://api.test.local',
    events: () => {},
  });
  const orchestrator = new ConversationOrchestrator({
    plan: planFor,
    evidenceProvider: grounding.evidenceProvider,
    correctionProvider: grounding.correctionProvider,
  });
  return orchestrator.runTurn(inputFor(text, intentionId));
};

const qaAuroraBank = { id: 'qa1', name: 'QA Aurora banco', kind: 'bank', balanceCents: 100000, status: 'active' };
const bankIta = { id: 'a1', name: 'Itaú', kind: 'bank', balanceCents: 10000, status: 'active' };
const bankNubank = { id: 'a2', name: 'Nubank', kind: 'bank', balanceCents: 20000, status: 'active' };

describe('ted-local-account-partial-balance: significant partial reads', () => {
  it('(1) RED: "saldo QA Aurora" reads the single "QA Aurora banco" account', async () => {
    const result = await runBalanceTurn('saldo QA Aurora', { items: [qaAuroraBank] }, 'partial-1');
    const text = result.response?.text ?? '';
    expect(text).toContain('QA Aurora banco');
    expect(text).toContain('1.000,00');
    expect(text).not.toMatch(/Não encontrei|Não consegui/);
  });

  it('(2) RED: "e o saldo daquela conta" resolves with a single account scope', async () => {
    const result = await runBalanceTurn('e o saldo daquela conta', { items: [qaAuroraBank] }, 'partial-2');
    const text = result.response?.text ?? '';
    expect(text).toContain('QA Aurora banco');
    expect(text).toContain('1.000,00');
    expect(text).not.toMatch(/Não encontrei|Não consegui/);
  });

  it('(3) control: full exact name keeps working', async () => {
    const result = await runBalanceTurn('saldo QA Aurora banco', { items: [qaAuroraBank] }, 'partial-3');
    const text = result.response?.text ?? '';
    expect(text).toContain('QA Aurora banco');
    expect(text).toContain('1.000,00');
  });
});

describe('ted-local-account-partial-balance: negatives keep the guard', () => {
  it('(4) absent name clarifies with no figures at all', async () => {
    const result = await runBalanceTurn('saldo Bradesco', { items: [bankNubank] }, 'partial-4');
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('200,00');
  });

  it('(5) single char is insufficient: "saldo Q" shows NO figures at all', async () => {
    const result = await runBalanceTurn('saldo Q', { items: [bankIta, bankNubank] }, 'partial-5');
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('200,00');
  });

  it('(5b) short fillers stay filler: "qual o saldo?" still lists', async () => {
    const result = await runBalanceTurn('qual o saldo?', { items: [bankIta, bankNubank] }, 'partial-5b');
    const text = result.response?.text ?? '';
    expect(text).toContain('Itaú');
    expect(text).toContain('Nubank');
  });

  it('(6) shared partial across two accounts stays ambiguous: "saldo Aurora"', async () => {
    const auroraBank = { id: 'b1', name: 'Aurora bank', kind: 'bank', balanceCents: 10000, status: 'active' };
    const auroraCash = { id: 'c1', name: 'Aurora cash', kind: 'cash', balanceCents: 5000, status: 'active' };
    const result = await runBalanceTurn('saldo Aurora', { items: [auroraBank, auroraCash] }, 'partial-6');
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Qual delas|Não consegui|Não encontrei/);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('50,00');
  });

  it('(7) leftover specific qualifier vetoes: "saldo QA Aurora PJ" shows no figures', async () => {
    const result = await runBalanceTurn('saldo QA Aurora PJ', { items: [qaAuroraBank] }, 'partial-7');
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('1.000,00');
  });

  it('(8) anaphora with 2+ accounts asks instead of guessing', async () => {
    const result = await runBalanceTurn(
      'e o saldo daquela conta',
      { items: [bankIta, bankNubank] },
      'partial-8',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Qual delas|Não encontrei|Não consegui/);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('200,00');
  });

  it('(9) consolidated total query stays consolidated', async () => {
    const result = await runBalanceTurn('qual o saldo total?', { items: [bankIta, bankNubank] }, 'partial-9');
    const text = result.response?.text ?? '';
    expect(text).toContain('300,00');
  });

  it('(10) absent card name never borrows bank figures', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão XP',
      { items: [bankIta, bankNubank] },
      'partial-10',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|fatura|cartão/i);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('200,00');
  });
});

describe('ted-local-account-partial-lookup round2: incomplete evidence vetoes new resolutions', () => {
  const omittedRow = { id: 'x1', kind: 'bank', balanceCents: 99999, status: 'active' };

  it('(11) RED: anaphora with 1 visible + 1 omitted clarifies with NO figures', async () => {
    const result = await runBalanceTurn(
      'e o saldo daquela conta',
      { items: [qaAuroraBank, omittedRow] },
      'partial-11',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('1.000,00');
    expect(text).not.toContain('999,99');
  });

  it('(12) RED: partial unique visible but another candidate hidden clarifies with NO figures', async () => {
    const hiddenCash = { id: 'x2', name: 'QA Aurora cash', kind: 'cash', status: 'active' };
    const result = await runBalanceTurn(
      'saldo QA Aurora',
      { items: [qaAuroraBank, hiddenCash] },
      'partial-12',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('1.000,00');
  });

  it('(13) exact named proof is preserved on partial evidence', async () => {
    const hiddenCash = { id: 'x2', name: 'QA Aurora cash', kind: 'cash', status: 'active' };
    const result = await runBalanceTurn(
      'saldo QA Aurora banco',
      { items: [qaAuroraBank, hiddenCash] },
      'partial-13',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('QA Aurora banco');
    expect(text).toContain('1.000,00');
  });

  it('(14) RED: anaphora with a dropped qualifier asks: "e o saldo daquela conta Q"', async () => {
    const result = await runBalanceTurn(
      'e o saldo daquela conta Q',
      { items: [qaAuroraBank] },
      'partial-14',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('1.000,00');
  });

  it('(15) RED: anaphora with a dropped digit asks: "e o saldo daquela conta 2"', async () => {
    const result = await runBalanceTurn(
      'e o saldo daquela conta 2',
      { items: [qaAuroraBank] },
      'partial-15',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('1.000,00');
  });

  it('(16) same-name twin in scope stays ambiguous: active + inactive "QA Aurora banco"', async () => {
    const inactiveTwin = { ...qaAuroraBank, id: 'qa9', status: 'inactive' };
    const result = await runBalanceTurn(
      'saldo QA Aurora',
      { items: [qaAuroraBank, inactiveTwin] },
      'partial-16',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('1.000,00');
  });
});

describe('ted-local-account-partial-lookup round3: short tokens owned by the name', () => {
  const reserva2 = { id: 'r2', name: 'Reserva 2', kind: 'bank', balanceCents: 20000, status: 'active' };
  const reserva = { id: 'r0', name: 'Reserva', kind: 'bank', balanceCents: 20000, status: 'active' };
  const reserva1 = { id: 'r1', name: 'Reserva 1', kind: 'bank', balanceCents: 10000, status: 'active' };

  it('(17) RED: short token owned by the name does not veto: "saldo Reserva 2"', async () => {
    const result = await runBalanceTurn('saldo Reserva 2', { items: [reserva2] }, 'partial-17');
    const text = result.response?.text ?? '';
    expect(text).toContain('Reserva 2');
    expect(text).toContain('200,00');
    expect(text).not.toMatch(/Não encontrei|Não consegui/);
  });

  it('(18) control: short token absent from the only name still vetoes', async () => {
    const result = await runBalanceTurn('saldo Reserva 2', { items: [reserva] }, 'partial-18');
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('200,00');
  });

  it('(19) RED: short token owned by the name reads: "saldo QA Aurora Q"', async () => {
    const qaAuroraQ = { id: 'qaq', name: 'QA Aurora Q', kind: 'bank', balanceCents: 50000, status: 'active' };
    const result = await runBalanceTurn('saldo QA Aurora Q', { items: [qaAuroraQ] }, 'partial-19');
    const text = result.response?.text ?? '';
    expect(text).toContain('QA Aurora Q');
    expect(text).toContain('500,00');
    expect(text).not.toMatch(/Não encontrei|Não consegui/);
  });

  it('(20) RED: numbered twins disambiguate on the short label: "saldo Reserva 2"', async () => {
    const result = await runBalanceTurn(
      'saldo Reserva 2',
      { items: [reserva1, reserva2] },
      'partial-20',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('Reserva 2');
    expect(text).toContain('200,00');
    expect(text).not.toContain('100,00');
  });

  it('(21) disambiguated single still vetoes leftovers: "saldo Reserva 2 PJ"', async () => {
    const result = await runBalanceTurn(
      'saldo Reserva 2 PJ',
      { items: [reserva1, reserva2] },
      'partial-21',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/Não encontrei|Não consegui|Qual delas/);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('200,00');
  });

  it('(22) RED: two "Reserva 2" homonyms never render the discarded "Reserva 1"', async () => {
    const reserva2b = { id: 'r2b', name: 'Reserva 2', kind: 'bank', balanceCents: 30000, status: 'active' };
    const result = await runBalanceTurn(
      'saldo Reserva 2',
      { items: [reserva1, reserva2, reserva2b] },
      'partial-22',
    );
    const text = result.response?.text ?? '';
    expect(text).toMatch(/mais de uma conta|Qual delas|Não encontrei|Não consegui/);
    expect(text).not.toContain('Reserva 1');
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('200,00');
    expect(text).not.toContain('300,00');
  });
});
