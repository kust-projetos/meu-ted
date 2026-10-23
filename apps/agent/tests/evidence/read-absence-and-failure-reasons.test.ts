/**
 * A04(a) / R04 — characterization + typed reasons on the READ channels
 * (`src/orchestration/channel-evidence.ts`).
 *
 * Characterized before changing anything:
 * - `accounts` / `transactions` collapse "no rows" into `empty` with `data: []`
 *   and any transport failure into `error` with `data: null` — both WITHOUT any
 *   reason, so an absence and a failure were indistinguishable downstream;
 * - `month-summary` (the analytics read behind `get_month_summary` /
 *   `spending_insights`) is period-bounded by construction and returned
 *   `{incomeCents, expenseCents, balanceCents, transactionCount}` as plain `ok`
 *   — a month with `transactionCount: 0` was indistinguishable from a month
 *   with `transactionCount: 12` and `incomeCents: 0`.
 */
import { describe, expect, it } from 'vitest';
import { createChannelGrounding, type ChannelReadTools } from '../../src/orchestration/channel-evidence.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';
import type { TurnInput, TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { routeIntent } from '../../src/orchestration/intent-router.js';

const input: TurnInput = {
  intentionId: 'intent-a04',
  traceId: 'intent-a04',
  text: 'como foi o mês?',
  actorId: 'actor-a04',
  workspaceId: 'ws-a04',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
};

const planFor = (operation: string): TurnPlan => ({
  version: '2',
  mode: 'read',
  // `general` has no domain fallback read, so exactly one read is issued.
  domain: 'general',
  skillNames: ['s'],
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
    listStatements: unused,
    listAccountsPayable: unused,
    listBudgets: unused,
    listGoals: unused,
    listCategories: unused,
    ...overrides,
  } as ChannelReadTools;
};

const httpError = (statusCode: number, message = `HTTP ${statusCode}`): Error =>
  Object.assign(new Error(message), { statusCode, code: 'api.request_failed' });

const envelopeFor = async (operation: string, tools: Partial<ChannelReadTools>): Promise<EvidenceEnvelope> => {
  const grounding = createChannelGrounding({ respond: async () => 'unused', readTools: readTools(tools) });
  const envelope = await grounding.evidenceProvider(input, planFor(operation));
  if (!envelope) throw new Error('envelope.expected');
  return envelope;
};

const emptyMonth = { yearMonth: '2026-09', incomeCents: 0, expenseCents: 0, balanceCents: 0, transactionCount: 0 };

describe('A04/R04 analytics read: empty period is an absence, never a failure or a zero', () => {
  it('a month with transactionCount 0 is `empty` + period_empty (distinct from error)', async () => {
    const envelope = await envelopeFor('get_month_summary', { getMonthSummary: async () => emptyMonth });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.status).toBe('empty');
    expect(envelope.items[0]?.reason).toBe('period_empty');
  });

  it('zero totals WITH entries stay `ok`: totalCents=0 never means "no entries"', async () => {
    const envelope = await envelopeFor('get_month_summary', {
      // Real API shape: only transfers this month → income 0, but entries exist.
      getMonthSummary: async () => ({ yearMonth: '2026-09', incomeCents: 0, expenseCents: 5000, balanceCents: -5000, transactionCount: 12 }),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('ok');
    expect('reason' in item!).toBe(false);
    // The row count travels with the evidence, so no renderer/model can read
    // the zero totals as absence.
    expect(JSON.stringify(item?.data)).toContain('"transactionCount":12');
  });

  it('an INVALID analytics shape is a failure, never a proven absence', async () => {
    // `undefined`, string and array do NOT prove zero entries — they are shape
    // failures. Reporting them as `period_empty` would answer "Não há dados no
    // período" for a read whose shape never reached the API contract (R04:
    // an error must never read as "nothing there").
    for (const [label, payload] of [
      ['undefined', undefined],
      ['string', 'HTTP 500 text body'],
      ['array', [{ yearMonth: '2026-09', transactionCount: 0 }]],
    ] as const) {
      const envelope = await envelopeFor('get_month_summary', { getMonthSummary: async () => payload as never });
      const item = envelope.items[0];
      expect(item?.status, label).toBe('error');
      expect(item?.reason, label).toBe('permanent_error');
      expect(item?.data, label).toBeNull();
    }
  });

  it('an object without transactionCount keeps the legacy shape as `ok`', async () => {
    // Compatibility: the old API shape carries only the totals. Absence is not
    // inferable from it, so it stays usable evidence.
    const envelope = await envelopeFor('get_month_summary', {
      getMonthSummary: async () => ({ yearMonth: '2026-09', incomeCents: 0, expenseCents: 5000, balanceCents: -5000 }),
    });
    expect(envelope.items[0]?.status).toBe('ok');
  });

  it('AC10: 403 on the analytics read is `error` + forbidden, never zero/evidence', async () => {
    const envelope = await envelopeFor('get_month_summary', {
      getMonthSummary: async () => { throw httpError(403, 'HTTP 403 Forbidden: capability financial.analytics missing'); },
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('error');
    expect(item?.reason).toBe('forbidden');
    expect(item?.data).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain('financial.analytics');
  });

  it('classifies the failure axis from the transport signal only', async () => {
    const cases: Array<[string, () => Promise<never>, string]> = [
      ['retryable_error', () => Promise.reject(httpError(500)), 'retryable_error'],
      ['retryable_error (429)', () => Promise.reject(httpError(429)), 'retryable_error'],
      ['permanent_error (422)', () => Promise.reject(httpError(422)), 'permanent_error'],
      ['forbidden (401)', () => Promise.reject(httpError(401)), 'forbidden'],
      ['unavailable (transport)', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
    ];
    for (const [label, fail, expected] of cases) {
      const envelope = await envelopeFor('get_month_summary', { getMonthSummary: fail });
      expect(envelope.items[0]?.status, label).toBe('error');
      expect(envelope.items[0]?.reason, label).toBe(expected);
    }
  });

  it('a read timeout is retryable, not a conclusion about the data', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTimeoutMs: 5,
      readTools: readTools({ getMonthSummary: () => new Promise(() => undefined) }),
    });
    const envelope = await grounding.evidenceProvider(input, planFor('get_month_summary'));
    expect(envelope?.items[0]?.status).toBe('error');
    expect(envelope?.items[0]?.reason).toBe('retryable_error');
  });
});

describe('A04/R04 setup state: no global "workspace empty" claim before A09', () => {
  it('no accounts is setup_incomplete, never workspace_empty', async () => {
    const envelope = await envelopeFor('list_accounts', { listAccounts: async () => ({ items: [] }) });
    expect(envelope.items[0]?.status).toBe('empty');
    expect(envelope.items[0]?.reason).toBe('setup_incomplete');
  });

  it('an unfiltered transaction list with no rows stays UNCLASSIFIED', async () => {
    // A04(b)/A09: proving "workspace vazio" needs a consistent multi-read
    // snapshot; a single unfiltered list proves neither period/category/filter.
    const envelope = await envelopeFor('list_recent_transactions', { listRecentTransactions: async () => ({ items: [] }) });
    expect(envelope.items[0]?.status).toBe('empty');
    expect('reason' in envelope.items[0]!).toBe(false);
  });

  it('rows that fail shape validation are a permanent failure, never a zero', async () => {
    const envelope = await envelopeFor('list_accounts', {
      listAccounts: async () => ({ items: [{ id: 'acc-1', name: 'Conta' }, { id: 'acc-2', name: 'Outra' }] }),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('error');
    expect(item?.reason).toBe('permanent_error');
  });
});

describe('payables-idiom absence (debugger payables-absence): conta preenchida + payables vazio', () => {
  const payablesIdentity: AuthenticatedIdentity = {
    actorId: 'actor-payables-absence',
    workspaceId: 'ws-payables-absence',
    role: 'member',
    deviceId: 'device-payables-absence',
  };

  // Stub dirigido pelo plano: cada leitura planejada responde da sua
  // fixture — contas preenchidas (ok), payables vazio ou erro. Reproduz a
  // produção (conta preenchida mascarava o empty do payables via `ok` de
  // outro escopo) e prova o contrato: ausência determinística sem
  // provider; erro segue erro, nunca vazio inventado.
  const evidenceForTurn = (payables: 'empty' | 'error') => async (_input: TurnInput, plan: TurnPlan) => {
    const stamp = new Date().toISOString();
    const items: Array<EvidenceEnvelope['items'][number]> = [];
    for (const operation of plan.requestedOperations) {
      if (operation.name === 'list_payables') {
        items.push(
          payables === 'empty'
            ? { ref: 'payables', source: 'api.payables', retrievedAt: stamp, status: 'empty', data: [], reason: 'setup_incomplete' }
            : { ref: 'payables', source: 'api.payables', retrievedAt: stamp, status: 'error', data: null, reason: 'unavailable' },
        );
      } else if (operation.name === 'list_accounts') {
        items.push({
          ref: 'accounts',
          source: 'api.accounts',
          retrievedAt: stamp,
          status: 'ok',
          data: [{ id: 'a1', name: 'Nubank', householdId: 'ws-payables-absence' }],
        });
      }
    }
    return { version: '1' as const, items };
  };

  const runPayablesTurn = async (payables: 'empty' | 'error') => {
    const providerCalls: string[] = [];
    const orchestrator = new ConversationOrchestrator({
      plan: (input: TurnInput) => routeIntent(input.text) as never,
      evidenceProvider: evidenceForTurn(payables),
      responseProvider: async () => {
        providerCalls.push('called');
        return '**resumo** markup-only';
      },
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'minhas contas a pagar', intentionId: `intent-payables-${payables}` }, payablesIdentity),
    );
    return { result, providerCalls };
  };

  it('conta preenchida + payables vazio responde ausência, sem provider', async () => {
    const { result, providerCalls } = await runPayablesTurn('empty');
    expect(result.response?.text).toMatch(/contas a pagar/i);
    // A frase sanitizada do provider ("Não consegui processar ... agora")
    // nunca aparece: a ausência é determinística.
    expect(result.response?.text).not.toMatch(/processar/i);
    expect(providerCalls).toHaveLength(0);
  });

  it('controle: payables com erro responde erro, nunca vazio inventado', async () => {
    const { result, providerCalls } = await runPayablesTurn('error');
    expect(result.response?.text).toMatch(/acessar seus dados financeiros/i);
    expect(result.response?.text).not.toMatch(/contas a pagar/i);
    expect(providerCalls).toHaveLength(0);
  });
});