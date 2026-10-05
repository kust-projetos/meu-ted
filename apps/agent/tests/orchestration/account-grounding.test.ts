import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConversationOrchestrator, type TurnInput, type TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';
import { createChannelGrounding, type ChannelReadTools } from '../../src/orchestration/channel-evidence.js';
import { routeIntent } from '../../src/orchestration/intent-router.js';
import {
  extractAccountsEvidence,
  renderAccountsAnswer,
} from '../../src/orchestration/account-grounding.js';

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

/**
 * `GET /accounts` answers `{ items, total }` and every row carries the
 * `householdId` the read was scoped to. The call sites below inject the ROWS a
 * turn cares about; the route envelope (and the workspace stamp) is assembled
 * here, at the seam, so no call site can assert a payload shape the route never
 * sends — and so `householdId`/`total` are stated once instead of on ~40 inline
 * row objects. `tests/contract/api-evidence-contract.test.ts` proves the REAL
 * route produces exactly this shape.
 */
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
    listAccountsPayable: fail,
    listBudgets: fail,
    listGoals: fail,
    listCategories: fail,
    // A09-int: the analytics reads are their own evidence reads; none of these
    // balance turns plans them.
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

const bankIta = { id: 'a1', name: 'Itaú', kind: 'bank', balanceCents: 10000, status: 'active' };
const bankNubank = { id: 'a2', name: 'Nubank', kind: 'bank', balanceCents: 20000, status: 'active' };
/**
 * A `credit_card` row is NOT reachable through `GET /accounts` today: the read
 * model excludes cards in BOTH `includeInactive` branches (cards are served by
 * the CardStore — see `read-models/store.ts` and the executable proof in
 * `tests/contract/api-evidence-contract.test.ts`). The row stays here on
 * purpose: these suites pin the RENDERER semantics a card-shaped row would need
 * if it ever reached grounding (`kind` is carried from the row's origin, never
 * inferred from the name) — a debt row must be labelled as debt and must never
 * be summed with available balances. Deleting it would silently drop that guard.
 */
const cardNubank = { id: 'c1', name: 'Nubank', kind: 'credit_card', balanceCents: 56000, status: 'active' };

describe('W1-TED-ACCOUNT-GROUNDING RED: multi-account balance grounding', () => {
  it('generic question with two accounts lists both, not just the first', async () => {
    const result = await runBalanceTurn('qual meu saldo?', { items: [bankIta, bankNubank] }, 'intent-red-1');
    const text = result.response?.text ?? '';
    expect(text).toContain('Itaú');
    expect(text).toContain('Nubank');
    expect(text).toContain('100,00');
    expect(text).toContain('200,00');
  });

  it('unique name selects the requested account only', async () => {
    const result = await runBalanceTurn('saldo da conta Nubank?', { items: [bankIta, bankNubank] }, 'intent-red-2');
    const text = result.response?.text ?? '';
    expect(text).toContain('Nubank');
    expect(text).toContain('200,00');
    expect(text).not.toContain('Itaú');
    expect(text).not.toContain('100,00');
  });

  it('unknown name clarifies without any figure', async () => {
    const result = await runBalanceTurn('saldo da conta XP?', { items: [bankIta, bankNubank] }, 'intent-red-3');
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
  });

  it('duplicated names clarify without any figure', async () => {
    const dup = { id: 'a3', name: 'Nubank', kind: 'cash', balanceCents: 30000, status: 'active' };
    const result = await runBalanceTurn('saldo da conta Nubank?', { items: [bankNubank, dup] }, 'intent-red-4');
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
  });

  it('mixed total never merges bank with credit_card; card is labeled as debt', async () => {
    const result = await runBalanceTurn(
      'qual meu saldo total?',
      { items: [bankIta, cardNubank] },
      'intent-red-5',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('100,00');
    expect(text).toContain('560,00');
    expect(text).not.toContain('660,00');
    expect(text.toLowerCase()).toContain('dívida');
  });

  it('negative bank balance keeps its sign', async () => {
    const negative = { ...bankIta, balanceCents: -5000 };
    const result = await runBalanceTurn('qual meu saldo?', { items: [negative] }, 'intent-red-6');
    const text = result.response?.text ?? '';
    expect(text).toContain('50,00');
    expect(text).toContain('-');
  });

  it('an invalid row never becomes a complete total (partiality is explicit)', async () => {
    const invalid = { id: 'bad', name: 'Quebrada', status: 'active' };
    const result = await runBalanceTurn('qual meu saldo?', { items: [bankIta, invalid] }, 'intent-red-7');
    const text = result.response?.text ?? '';
    expect(text).toContain('Itaú');
    expect(text).toContain('100,00');
    expect(text.toLowerCase()).toMatch(/parcial|incomplet/);
  });

  it('many accounts declare partiality instead of silently omitting', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `acc-${index}`,
      name: `Conta ${index}`,
      kind: 'bank',
      balanceCents: 1000 * (index + 1),
      status: 'active',
    }));
    const rendered = renderAccountsAnswer(
      'qual meu saldo?',
      extractAccountsEvidence({
        version: '1',
        items: many.map((account) => ({
          ref: `account:${account.id}`,
          source: 'api.accounts',
          retrievedAt: new Date().toISOString(),
          status: 'ok' as const,
          data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
        })),
      })!,
    );
    expect(rendered).not.toBeNull();
    expect(rendered!).toMatch(/20 de 25|parcial/i);
  });

  it('card balance with no credit_card semantics clarifies without borrowing another balance', async () => {
    const result = await runBalanceTurn('saldo do cartão Nubank?', { items: [bankIta] }, 'intent-red-9');
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toContain('100,00');
  });

  it('card balance with a credit_card account shows it labeled as debt', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão Nubank?',
      { items: [bankIta, { ...cardNubank, name: 'Nubank Cartão' }] },
      'intent-red-10',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('560,00');
    expect(text.toLowerCase()).toContain('dívida');
  });

  it('mixed bank/card balance query scopes to the named accounts without a merged total', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Itaú e do cartão Nubank?',
      { items: [bankIta, cardNubank] },
      'intent-red-11',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('Itaú');
    expect(text).toContain('Nubank');
    expect(text).not.toContain('660,00');
    expect(text.toLowerCase()).toContain('dívida');
  });

  it('all-invalid rows stay fail-closed', async () => {
    const result = await runBalanceTurn(
      'qual meu saldo?',
      { items: [{ id: 'bad', name: 'Quebrada', status: 'active' }] },
      'intent-red-12',
    );
    expect(result.failClosed).toBe(true);
    expect(result.response?.text ?? '').toMatch(/Não consegui acessar seus dados financeiros agora/);
  });

  it('list_accounts projection carries kind from its origin (no name inference)', () => {
    const contract = JSON.parse(
      readFileSync(new URL('../../../api/openapi/agent-tools.openapi.json', import.meta.url), 'utf8'),
    ) as {
      paths: { '/accounts': { get: { 'x-pi-tool': { result: { fields: Record<string, unknown> } } } } };
    };
    expect(contract.paths['/accounts'].get['x-pi-tool'].result.fields).toMatchObject({ kind: 'kind' });
  });
});

describe('FIX-TED-ACCOUNT-GROUNDING-EDGE-CASES RED', () => {
  const cardXP = { id: 'c2', name: 'XP Investimentos', kind: 'credit_card', balanceCents: 99900, status: 'active' };

  it('card question with homonym bank only never returns the bank figure', async () => {
    const result = await runBalanceTurn('saldo do cartão Nubank?', { items: [bankNubank] }, 'intent-edge-1');
    const text = result.response?.text ?? '';
    expect(text).not.toContain('200,00');
    expect(text).not.toMatch(/R\$/);
  });

  it('card question naming a bank homonym with only another card present never returns the bank figure', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão Nubank?',
      { items: [bankNubank, cardXP] },
      'intent-edge-2',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toContain('200,00');
    expect(text).not.toMatch(/R\$/);
  });

  it('generic card question never lists bank balances', async () => {
    const result = await runBalanceTurn(
      'saldo dos cartões?',
      { items: [bankIta, cardNubank] },
      'intent-edge-3',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toContain('100,00');
  });

  it('truncated homogeneous total omits the contradictory subtotal', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `acc-${index}`,
      name: `Conta ${index}`,
      kind: 'bank',
      balanceCents: 1000 * (index + 1),
      status: 'active',
    }));
    const rendered = renderAccountsAnswer(
      'qual meu saldo total?',
      extractAccountsEvidence({
        version: '1',
        items: many.map((account) => ({
          ref: `account:${account.id}`,
          source: 'api.accounts',
          retrievedAt: new Date().toISOString(),
          status: 'ok' as const,
          data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
        })),
      })!,
    );
    expect(rendered).not.toBeNull();
    expect(rendered!).toMatch(/parcial|20 de 25/i);
    expect(rendered!).not.toMatch(/Total disponível em contas/);
  });

  it('partial input without total states partiality without total language', () => {
    const invalid = { id: 'bad', name: 'Quebrada', status: 'active' };
    const rendered = renderAccountsAnswer(
      'qual meu saldo?',
      extractAccountsEvidence({
        version: '1',
        items: [
          {
            ref: 'account:a1',
            source: 'api.accounts',
            retrievedAt: new Date().toISOString(),
            status: 'ok' as const,
            data: { accountName: bankIta.name, balanceCents: bankIta.balanceCents, kind: bankIta.kind },
          },
          {
            ref: 'account:bad',
            source: 'api.accounts',
            retrievedAt: new Date().toISOString(),
            status: 'ok' as const,
            data: invalid,
          },
        ],
      })!,
    );
    expect(rendered).not.toBeNull();
    expect(rendered!).toMatch(/parcial|incomplet/i);
    expect(rendered!).not.toMatch(/nenhum total apresentado é completo/i);
    expect(rendered!).not.toMatch(/total/i);
  });
});

describe('FIX-TED-NAME-SPECIFICITY-AND-LIST-LIMIT RED', () => {
  const nubankPJBank = { id: 'a4', name: 'Nubank PJ', kind: 'bank', balanceCents: 30000, status: 'active' };
  const nubankEmpresaBank = { id: 'a5', name: 'Nubank Empresa', kind: 'bank', balanceCents: 40000, status: 'active' };
  const cardNubankPJ = { id: 'c3', name: 'Nubank PJ', kind: 'credit_card', balanceCents: 10000, status: 'active' };
  const cardItau = { id: 'c4', name: 'Itaú', kind: 'credit_card', balanceCents: 77700, status: 'active' };

  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:spec-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('contained bank name selects only the most specific account', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Nubank PJ?',
      { items: [bankNubank, nubankPJBank] },
      'intent-spec-1',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('Nubank PJ');
    expect(text).toContain('300,00');
    expect(text).not.toContain('200,00');
  });

  it('shorter fully-named bank wins when the longer name is not fully mentioned', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Nubank?',
      { items: [bankNubank, nubankPJBank] },
      'intent-spec-2',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('200,00');
    expect(text).not.toContain('300,00');
  });

  it('unresolved containment ambiguity clarifies without any figure', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Nubank PJ Empresa?',
      { items: [bankNubank, nubankPJBank, nubankEmpresaBank] },
      'intent-spec-3',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
  });

  it('contained card name selects only the most specific card', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão Nubank PJ?',
      { items: [cardNubank, cardNubankPJ] },
      'intent-spec-4',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('100,00');
    expect(text).not.toContain('560,00');
  });

  it('specific missing card never lists other cards figures', async () => {
    const result = await runBalanceTurn('saldo do cartão XP?', { items: [cardNubank, cardItau] }, 'intent-spec-5');
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text.toLowerCase()).toContain('cartão');
  });

  it('genuinely generic plural card question lists only cards within the limit', () => {
    const cards = Array.from({ length: 25 }, (_, index) => ({
      name: `Cartão ${index}`,
      kind: 'credit_card',
      balanceCents: 1000 * (index + 1),
    }));
    const rendered = renderAccountsAnswer(
      'saldo dos cartões?',
      evidenceOf([{ name: 'Itaú', kind: 'bank', balanceCents: 12345 }, ...cards]),
    );
    expect(rendered).not.toBeNull();
    expect(rendered!).not.toContain('123,45');
    expect(rendered!).toMatch(/mostrando 20 de 25/i);
    expect(rendered!).not.toMatch(/20 de 26/);
  });

  it('missing-name clarification caps names at 20 with an explicit mostrando note', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      name: `Loja ${index}`,
      kind: 'bank',
      balanceCents: 1000 * (index + 1),
    }));
    const rendered = renderAccountsAnswer('saldo da conta XP?', evidenceOf(many));
    expect(rendered).not.toBeNull();
    expect(rendered!).not.toMatch(/R\$/);
    expect(rendered!).not.toMatch(/\d+,\d{2}/);
    expect(rendered!).toMatch(/mostrando 20 de 25/);
  });

  it('duplicated-name clarification caps options at 20 with an explicit mostrando note', async () => {
    const dups = Array.from({ length: 25 }, (_, index) => ({
      id: `dup-${index}`,
      name: 'Nubank',
      kind: 'bank',
      balanceCents: 1000 * (index + 1),
      status: 'active',
    }));
    const result = await runBalanceTurn('saldo da conta Nubank?', { items: dups }, 'intent-spec-8');
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).toMatch(/mostrando 20 de 25/i);
  });
});

describe('FIX-TED-SHORT-NAMES-AND-MISSING-ACCOUNT-QUERY RED', () => {
  const bankXP = { id: 'ax', name: 'XP', kind: 'bank', balanceCents: 50000, status: 'active' };
  const cardXPShort = { id: 'cx', name: 'XP', kind: 'credit_card', balanceCents: 56000, status: 'active' };
  const cardItau = { id: 'c4', name: 'Itaú', kind: 'credit_card', balanceCents: 77700, status: 'active' };

  it('exact short bank name answers only that account', async () => {
    const result = await runBalanceTurn(
      'saldo da conta XP?',
      { items: [bankIta, bankXP] },
      'intent-short-1',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('500,00');
    expect(text).not.toContain('100,00');
  });

  it('exact short card name answers only that card', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão XP?',
      { items: [cardXPShort, cardItau] },
      'intent-short-2',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('560,00');
    expect(text).not.toContain('777,00');
  });

  it('short name does not match as a generic question token', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Nubank?',
      { items: [bankNubank, bankXP] },
      'intent-short-3',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('200,00');
    expect(text).not.toContain('500,00');
  });

  it('duplicated short names clarify without any figure', async () => {
    const dup = { id: 'ax2', name: 'XP', kind: 'cash', balanceCents: 30000, status: 'active' };
    const result = await runBalanceTurn('saldo da conta XP?', { items: [bankXP, dup] }, 'intent-short-4');
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
  });

  it('unmatched qualifier without the word conta never lists other balances', async () => {
    const result = await runBalanceTurn(
      'saldo do banco XP?',
      { items: [bankIta, bankNubank] },
      'intent-short-5',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('200,00');
  });

  it('unknown qualifier without the word conta never lists other balances', async () => {
    const result = await runBalanceTurn(
      'saldo do banco Bradesco?',
      { items: [bankIta, bankNubank] },
      'intent-short-6',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
  });
});

  describe('FIX-TED-GROUNDING-SEMANTIC-SCOPE RED', () => {
    const cardNubankPJ = { id: 'c3', name: 'Nubank PJ', kind: 'credit_card', balanceCents: 10000, status: 'active' };

  it('A: explicit card query never answers with a shorter bank homonym when the card carries a qualifier', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão Nubank?',
      { items: [bankNubank, cardNubankPJ] },
      'intent-sem-a1',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).not.toContain('200,00');
    expect(text).not.toContain('100,00');
  });

  it('A-control: full card qualifier still selects only the card', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão Nubank PJ?',
      { items: [bankNubank, cardNubankPJ] },
      'intent-sem-a2',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('100,00');
    expect(text).not.toContain('200,00');
  });

  it('B: mixed query with card qualifier mismatch clarifies without substitution figures', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Itaú e do cartão Nubank PJ?',
      { items: [bankIta, cardNubank] },
      'intent-sem-b1',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).not.toContain('100,00');
    expect(text).not.toContain('560,00');
  });

  it('B-control: mixed query naming both sides with full qualifiers lists both kind-aware', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Itaú e do cartão Nubank PJ?',
      { items: [bankIta, cardNubankPJ] },
      'intent-sem-b2',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('Itaú');
    expect(text).toContain('Nubank PJ');
    expect(text).toContain('100,00');
    expect(text.toLowerCase()).toContain('dívida');
  });

  it('C: account named Saldo never captures a generic balance question', async () => {
    const saldo = { id: 'a9', name: 'Saldo', kind: 'bank', balanceCents: 11100, status: 'active' };
    const result = await runBalanceTurn('qual meu saldo?', { items: [saldo, bankIta] }, 'intent-sem-c1');
    const text = result.response?.text ?? '';
    expect(text).toContain('Saldo');
    expect(text).toContain('Itaú');
    expect(text).toContain('111,00');
    expect(text).toContain('100,00');
  });

  it('C: card named Cartão never single-selects a generic card question', async () => {
    const cartao = { id: 'c9', name: 'Cartão', kind: 'credit_card', balanceCents: 22200, status: 'active' };
    const result = await runBalanceTurn(
      'saldo do cartão?',
      { items: [cartao, cardNubank] },
      'intent-sem-c2',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('560,00');
    expect(text).toContain('222,00');
  });
});

describe('FIX-TED-GROUNDING-SEGMENT-SCOPING RED', () => {
  const bankXP = { id: 'ax', name: 'XP', kind: 'bank', balanceCents: 50000, status: 'active' };
  const cardXPShort = { id: 'cx', name: 'XP', kind: 'credit_card', balanceCents: 56000, status: 'active' };
  const cardXPPJ = { id: 'cxpj', name: 'XP PJ', kind: 'credit_card', balanceCents: 10000, status: 'active' };

  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:seg-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('SEG-1: singular conta XP with only card XP clarifies; bank XP answers', async () => {
    const cardOnly = await runBalanceTurn('saldo da conta XP?', { items: [cardXPShort] }, 'intent-seg-1a');
    const cardOnlyText = cardOnly.response?.text ?? '';
    expect(cardOnlyText).not.toMatch(/R\$/);
    expect(cardOnlyText).not.toMatch(/\d+,\d{2}/);
    expect(cardOnlyText).not.toContain('560,00');

    const bankOnly = await runBalanceTurn(
      'saldo da conta XP?',
      { items: [bankIta, bankXP] },
      'intent-seg-1b',
    );
    const bankOnlyText = bankOnly.response?.text ?? '';
    expect(bankOnlyText).toContain('500,00');
    expect(bankOnlyText).not.toContain('100,00');
  });

  it('SEG-2: mixed Itaú+Nubank with homonym bank omits the bank figure', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Itaú e do cartão Nubank?',
      { items: [bankIta, bankNubank, cardNubank] },
      'intent-seg-2',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('Itaú');
    expect(text).toContain('100,00');
    expect(text).toContain('560,00');
    expect(text).not.toContain('200,00');
  });

  it('SEG-3: mixed with missing bank PJ qualifier clarifies without figures', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Nubank PJ e do cartão XP PJ?',
      { items: [bankNubank, cardXPPJ] },
      'intent-seg-3',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).not.toContain('200,00');
    expect(text).not.toContain('100,00');
  });

  it('SEG-4: generic cartões count uses the card pool, never accounts.length', () => {
    const cards = Array.from({ length: 25 }, (_, index) => ({
      name: `Card ${String(index).padStart(2, '0')}`,
      kind: 'credit_card',
      balanceCents: 1000 * (index + 1),
    }));
    const rendered = renderAccountsAnswer(
      'saldo dos cartões?',
      evidenceOf([{ name: 'Itaú', kind: 'bank', balanceCents: 12345 }, ...cards]),
    );
    expect(rendered).not.toBeNull();
    expect(rendered!).toMatch(/mostrando 20 de 25/i);
    expect(rendered!).not.toMatch(/20 de 26/);
  });
});
describe('FIX-TED-FUNDS-FULL-NAME-AND-TOTAL-CLAIM RED', () => {
  it('singular bank with qualifier mismatch clarifies; full name still selects', async () => {
    const nubankPJ = { id: 'a4', name: 'Nubank PJ', kind: 'bank', balanceCents: 30000, status: 'active' };
    const short = await runBalanceTurn('saldo da conta Nubank?', { items: [nubankPJ] }, 'intent-claim-1a');
    const shortText = short.response?.text ?? '';
    expect(shortText).not.toMatch(/R\$/);
    expect(shortText).not.toMatch(/\d+,\d{2}/);
    expect(shortText).not.toContain('300,00');

    const full = await runBalanceTurn(
      'saldo da conta Nubank PJ?',
      { items: [nubankPJ] },
      'intent-claim-1b',
    );
    const fullText = full.response?.text ?? '';
    expect(fullText).toContain('Nubank PJ');
    expect(fullText).toContain('300,00');
  });

  it('total with unknown kind or partial read never claims card debt without credit_card evidence', () => {
    const evidenceOf = (items: readonly { data: unknown; ref: string }[]) =>
      extractAccountsEvidence({
        version: '1',
        items: items.map((item) => ({
          ref: item.ref,
          source: 'api.accounts',
          retrievedAt: new Date().toISOString(),
          status: 'ok' as const,
          data: item.data,
        })),
      })!;
    const unknownTotal = renderAccountsAnswer(
      'qual meu saldo total?',
      evidenceOf([
        { ref: 'account:u1', data: { accountName: 'Itaú', balanceCents: 10000, kind: 'bank' } },
        { ref: 'account:u2', data: { accountName: 'Reserva', balanceCents: 20000, kind: 'unknown' } },
      ]),
    );
    expect(unknownTotal).not.toBeNull();
    expect(unknownTotal!).not.toContain('300,00');
    expect(unknownTotal!.toLowerCase()).not.toContain('dívida');
    expect(unknownTotal!.toLowerCase()).not.toContain('cartão');
    expect(unknownTotal!.toLowerCase()).toMatch(/tipo.*não.*confirm|não.*totaliz|não somei/);

    const partialTotal = renderAccountsAnswer(
      'qual meu saldo total?',
      evidenceOf([
        { ref: 'account:p1', data: { accountName: 'Itaú', balanceCents: 10000, kind: 'bank' } },
        { ref: 'account:bad', data: { id: 'bad', name: 'Quebrada', status: 'active' } },
      ]),
    );
    expect(partialTotal).not.toBeNull();
    expect(partialTotal!.toLowerCase()).toMatch(/parcial|incomplet/);
    expect(partialTotal!.toLowerCase()).not.toContain('dívida');
    expect(partialTotal!.toLowerCase()).not.toContain('cartão');
  });
});
describe('FIX-TED-UNMATCHED-QUALIFIER-AND-AMBIGUOUS-CAP RED', () => {
  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:qual-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('unmatched bank qualifier never answers the shorter prefix balance', async () => {
    const result = await runBalanceTurn(
      'saldo da conta Nubank PJ?',
      { items: [bankNubank] },
      'intent-qual-1',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).not.toContain('200,00');
  });

  it('unmatched card qualifier never answers the shorter prefix card', async () => {
    const result = await runBalanceTurn(
      'saldo do cartão Nubank PJ?',
      { items: [cardNubank] },
      'intent-qual-2',
    );
    const text = result.response?.text ?? '';
    expect(text).not.toMatch(/R\$/);
    expect(text).not.toMatch(/\d+,\d{2}/);
    expect(text).not.toContain('560,00');
  });

  it('composite most-specific bank still wins when present', async () => {
    const nubankPJBank = { id: 'a4', name: 'Nubank PJ', kind: 'bank', balanceCents: 30000, status: 'active' };
    const result = await runBalanceTurn(
      'saldo da conta Nubank PJ?',
      { items: [bankNubank, nubankPJBank] },
      'intent-qual-3',
    );
    const text = result.response?.text ?? '';
    expect(text).toContain('300,00');
    expect(text).not.toContain('200,00');
  });

  it('ambiguous same-base cards clarify with names only, capped at 20', () => {
    const cards = Array.from({ length: 25 }, (_, index) => ({
      name: `Nubank ${String(index + 1).padStart(2, '0')}`,
      kind: 'credit_card',
      balanceCents: 1000 * (index + 1),
    }));
    const rendered = renderAccountsAnswer('saldo do cartão Nubank?', evidenceOf(cards));
    expect(rendered).not.toBeNull();
    expect(rendered!).not.toMatch(/R\$/);
    expect(rendered!).not.toMatch(/\d+,\d{2}/);
    expect(rendered!).toMatch(/mostrando 20 de 25/i);
  });

  it('explicit multi-name balance listing caps at 20 with an explicit note', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      name: `Loja ${String(index).padStart(2, '0')}`,
      kind: 'bank',
      balanceCents: 1000 * (index + 1),
    }));
    const qualifiers = many.map((account) => account.name.split(' ')[1]).join(' ');
    const rendered = renderAccountsAnswer(`saldo das contas Loja ${qualifiers}?`, evidenceOf(many));
    expect(rendered).not.toBeNull();
    expect(rendered!).toMatch(/mostrando 20 de 25/i);
    expect(rendered!).not.toContain('250,00');
  });
});

describe('FIX-TED-ALL-ACCOUNTS-UNKNOWN-TOTAL RED', () => {
  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:all-unknown-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('broad all-accounts total with bank+unknown withholds the total without inventing card debt', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total de todas as contas?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('Itaú');
    expect(text).toContain('100,00');
    expect(text).not.toMatch(/Total disponível/);
    expect(text).not.toContain('300,00');
    expect(text.toLowerCase()).toMatch(/tipo.*não.*confirm|não.*confirm/);
    expect(text.toLowerCase()).toMatch(/sem somar|não somei|sem soma|não apresentado|omitido/);
    expect(text.toLowerCase()).not.toContain('dívida');
    expect(text.toLowerCase()).not.toContain('cartão');
  });

  it('broad all-accounts total with unknown+card stays truthful without conta+dívida claim', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total de todas as contas?',
      evidenceOf([
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('200,00');
    expect(text).toContain('560,00');
    expect(text).not.toMatch(/Total disponível/i);
    expect(text.toLowerCase()).toMatch(/tipo.*não.*confirm|não.*confirm/);
    expect(text.toLowerCase()).toMatch(/sem somar|não somei|sem soma/);
    expect(text.toLowerCase()).not.toContain('são tipos diferentes');
    expect(text.toLowerCase()).not.toContain('conta e dívida');
    expect(text.toLowerCase()).not.toContain('total só das contas');
  });

  it('ambiguous funds total with unknown fails closed instead of a silent partial subtotal', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total das contas?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    expect(rendered!).not.toMatch(/Total disponível/);
    expect(rendered!).not.toContain('300,00');
  });
});

describe('FIX-TED-CARD-ONLY-TOTAL-MESSAGE RED', () => {
  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:cardonly-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('single card total never claims conta+dívida types and never sums', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total?',
      evidenceOf([{ name: 'Nubank', kind: 'credit_card', balanceCents: 56000 }]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('560,00');
    expect(text.toLowerCase()).not.toContain('são tipos diferentes');
    expect(text.toLowerCase()).not.toContain('conta e dívida');
    expect(text.toLowerCase()).not.toContain('total só das contas');
    expect(text).not.toMatch(/total disponível/i);
    expect(text.toLowerCase()).toMatch(/sem somar|não somei|sem soma/);
    expect(text.toLowerCase()).toMatch(/não é feita|não feita|fora do escopo/);
  });

  it('card + unknown total reports unconfirmed type without alleging confirmed funds', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total?',
      evidenceOf([
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('560,00');
    expect(text).toContain('200,00');
    expect(text.toLowerCase()).toMatch(/tipo.*não.*confirm|não.*confirm/);
    expect(text.toLowerCase()).toMatch(/sem somar|não somei|sem soma/);
    expect(text.toLowerCase()).not.toContain('são tipos diferentes');
    expect(text.toLowerCase()).not.toContain('conta e dívida');
    expect(text.toLowerCase()).not.toContain('total só das contas');
    expect(text).not.toMatch(/total disponível/i);
  });
});

describe('FIX-TED-ALL-ACCOUNTS-EXCLUDE-CARD RED', () => {
  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:exclude-card-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('todas + sem cartao with total lists only bank/cash with scoped subtotal', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total de todas as contas sem cartão?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('Itaú');
    expect(text).toContain('100,00');
    expect(text).not.toContain('Nubank');
    expect(text).not.toContain('560,00');
    expect(text.toLowerCase()).not.toContain('cartão — dívida');
    expect(text.toLowerCase()).not.toContain('conta e dívida');
    expect(text.toLowerCase()).not.toContain('tipos diferentes');
    expect(text.toLowerCase()).toMatch(/sem cartão/);
  });

  it('todas + sem cartao without total lists only bank/cash', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo de todas as contas sem cartão?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('Itaú');
    expect(text).toContain('100,00');
    expect(text).not.toContain('Nubank');
    expect(text).not.toContain('560,00');
    expect(text.toLowerCase()).not.toContain('cartão — dívida');
    expect(text.toLowerCase()).not.toContain('conta e dívida');
    expect(text.toLowerCase()).not.toContain('tipos diferentes');
  });

  it('sem cartao + unknown never presents known card values and withholds complete total', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total de todas as contas sem cartão?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).not.toContain('560,00');
    expect(text).not.toContain('Nubank');
    expect(text.toLowerCase()).not.toContain('cartão — dívida');
    expect(text.toLowerCase()).toMatch(/tipo.*não.*confirm|não.*confirm|pode ser cartão/);
    expect(text).not.toMatch(/Total disponível/);
    expect(text).not.toContain('660,00');
    expect(text).not.toContain('860,00');
    expect(text).not.toContain('760,00');
  });
});
describe('FIX-TED-GROUNDING-BROAD-SCOPE-EDGECASES RED', () => {
  const evidenceOf = (accounts: readonly { name: string; kind: string; balanceCents: number }[]) =>
    extractAccountsEvidence({
      version: '1',
      items: accounts.map((account, index) => ({
        ref: `account:broad-edge-${index}`,
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok' as const,
        data: { accountName: account.name, balanceCents: account.balanceCents, kind: account.kind },
      })),
    })!;

  it('F1: broad todas total with bank+card lists both kind-aware, never claims Total disponivel, no sum', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total de todas as contas?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('Itaú');
    expect(text).toContain('Nubank');
    expect(text).toContain('100,00');
    expect(text).toContain('560,00');
    expect(text).not.toMatch(/Total disponível em contas/);
    expect(text).not.toContain('660,00');
    expect(text.toLowerCase()).toMatch(/tipos diferentes|sem somar|não somei|dívida/);
  });

  it('F2: unsupported corrente subtype withholds total and never sums bank+cash as corrente', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total das contas correntes?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Carteira', kind: 'cash', balanceCents: 5000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).not.toContain('150,00');
    expect(text).not.toContain('300,00');
    expect(text).not.toContain('350,00');
    expect(text).not.toMatch(/Total disponível/);
    expect(text.toLowerCase()).not.toMatch(/total só das contas/);
    expect(text.toLowerCase()).toMatch(/corrente|poupança|isol|separ|distinção|sem distinção|não.*confirm|refin/);
  });

  it('F2b: unsupported poupanca subtype withholds total', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total da poupança?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Carteira', kind: 'cash', balanceCents: 5000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).not.toContain('150,00');
    expect(text).not.toMatch(/Total disponível/);
    expect(text.toLowerCase()).not.toMatch(/total só das contas/);
    expect(text.toLowerCase()).toMatch(/poupan|corrente|isol|separ|distinção|refin/);
  });

  it('F3a: negated sem cartao with only known bank+cash is explicitly scoped, never card-clarification', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total das contas sem cartão?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Carteira', kind: 'cash', balanceCents: 5000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('100,00');
    expect(text).toContain('50,00');
    expect(text).toContain('150,00');
    expect(text.toLowerCase()).not.toContain('qual conta ou cartão');
    expect(text.toLowerCase()).toMatch(/só das contas|sem cartão|exclu.*cartão|banco\/dinheiro/);
  });

  it('F3b: negated sem cartao with unknown withholds total instead of partial scoped sum', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total das contas sem cartão?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).not.toContain('300,00');
    expect(text).not.toMatch(/Total disponível/);
    expect(text.toLowerCase()).not.toMatch(/total só das contas.*300|total.*300/);
    expect(text.toLowerCase()).toMatch(/tipo.*não.*confirm|não.*confirm|refin/);
  });

  it('F3c: negated sem cartao never lists card figures as included', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo total das contas sem cartão?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Nubank', kind: 'credit_card', balanceCents: 56000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('100,00');
    expect(text).not.toContain('560,00');
    expect(text).not.toMatch(/Total disponível em contas/);
    expect(text.toLowerCase()).not.toContain('qual conta ou cartão');
  });

  it('F4: broad plural listing without total never silently omits unknown', () => {
    const rendered = renderAccountsAnswer(
      'qual meu saldo das contas?',
      evidenceOf([
        { name: 'Itaú', kind: 'bank', balanceCents: 10000 },
        { name: 'Reserva', kind: 'unknown', balanceCents: 20000 },
      ]),
    );
    expect(rendered).not.toBeNull();
    const text = rendered!;
    expect(text).toContain('Itaú');
    expect(text).toContain('Reserva');
    expect(text).toContain('100,00');
    expect(text).toContain('200,00');
    expect(text.toLowerCase()).toMatch(/tipo não confirmado|tipo.*não.*confirm|não.*confirm|não entrou|omit|refin/);
  });
});
