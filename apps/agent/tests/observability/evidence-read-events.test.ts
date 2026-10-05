import { describe, expect, it } from 'vitest';
import { createChannelGrounding, type ChannelReadTools } from '../../src/orchestration/channel-evidence.js';
import type { TurnInput, TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';

const planFor = (operations: Array<{ name: string; kind: 'read' }>, domain: TurnPlan['domain']): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain,
  skillNames: ['s'],
  requestedOperations: operations,
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const input: TurnInput = {
  intentionId: 'intent-read-events',
  traceId: 'intent-read-events',
  text: 'qual meu saldo?',
  actorId: 'actor-evt',
  workspaceId: 'ws-evt',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
};

/**
 * Route-faithful payloads (the shapes the API actually answers), so the premise
 * of this file is TRUE: these reads really do succeed.
 *
 * `{ accounts: [...] }` used to stand in for `GET /accounts`, and no route has
 * ever answered that — `readListPayload` gates on `Array.isArray(items)`, so the
 * read silently produced `permanent_error` while this file kept asserting a
 * successful read. Every payload below now mirrors its route:
 * `/accounts` `{items,total}` · `/transactions` `{items,total,limit,offset}` ·
 * `/dashboard/month-summary` `{yearMonth,incomeCents,expenseCents,balanceCents,transactionCount}`
 * · `/cards/statements`, `/payables`, `/categories` `{items,total}` ·
 * `/analytics/*` flat, with `period` + the G03 proof fields.
 */
const okAccounts = async () => ({
  items: [
    {
      id: 'acc-1',
      householdId: 'ws-evt',
      name: 'Conta secreta R$ 1.234,56',
      kind: 'bank',
      balanceCents: 123456,
      status: 'active',
    },
  ],
  total: 1,
});
const failingBudgets = async () => {
  throw Object.assign(new Error('HTTP 500'), { statusCode: 500, code: 'api.request_failed' });
};
const hangingGoals: ChannelReadTools['listGoals'] = () => new Promise(() => undefined as never);

const stubTools = (overrides: Partial<ChannelReadTools> = {}): ChannelReadTools => ({
  listAccounts: okAccounts,
  listRecentTransactions: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
  getMonthSummary: async () => ({
    yearMonth: '2026-01',
    incomeCents: 0,
    expenseCents: 0,
    balanceCents: 0,
    transactionCount: 0,
  }),
  listStatements: async () => ({ items: [], total: 0 }),
  listAccountsPayable: async () => ({ items: [], total: 0 }),
  listBudgets: failingBudgets,
  listGoals: hangingGoals,
  listCategories: async () => ({ items: [], total: 0 }),
  // A09-int: never planned by the lifecycle events under test.
  analyticsKpis: async () => ({
    period: { from: '2026-01-01', to: '2026-01-31' },
    previousPeriod: { from: '2025-12-02', to: '2025-12-31' },
    accountsTotalCents: 123456,
    dueSoonCents: 0,
    openInvoices: { committedCents: 0, limitCents: 0, utilizationPct: null },
    savingsRatePct: null,
    savingsRateTargetPct: 20,
    previousSavingsRatePct: null,
    fixedVsDiscretionary: {
      scope: 'household',
      fixedCents: 0,
      discretionaryCents: 0,
      fixedPctOfIncome: 0,
      subscriptionsCents: 0,
    },
    incomeCents: 0,
    expenseCents: 0,
    previousIncomeCents: 0,
    previousExpenseCents: 0,
    netLiquidBalanceCents: 123456,
    netWorthCents: 123456,
    transactionCount: 0,
    asOf: '2026-01-31T12:00:00.000Z',
    basis: 'liquidez',
    semanticsVersion: '1',
    effectiveFilter: { period: 'custom', from: '2026-01-01', to: '2026-01-31', accountId: null },
    emptyReason: 'no_transactions_in_period',
  }),
  analyticsCategoryBreakdown: async () => ({
    period: { from: '2026-01-01', to: '2026-01-31' },
    kind: 'expense',
    totalCents: 0,
    slices: [],
    transactionCount: 0,
    asOf: '2026-01-31T12:00:00.000Z',
    basis: 'liquidez',
    semanticsVersion: '1',
    effectiveFilter: { period: 'custom', from: '2026-01-01', to: '2026-01-31', accountId: null, kind: 'expense' },
    emptyReason: 'no_categorised_transactions_in_period',
  }),
  ...overrides,
});

describe('FINDING 3 (MEDIUM): evidence reads emit sanitized tool lifecycle events', () => {
  it('emits tool.started/tool.completed per read with name/status/latency and no payloads', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: stubTools(),
      events: (type, fields) => seen.push({ type, fields }),
    });
    // accounts (ok) + budgets (error): deterministic render is skipped on
    // purpose — what matters here is the lifecycle events per read.
    const envelope = await grounding.evidenceProvider(
      input,
      planFor([{ name: 'get_balance', kind: 'read' }, { name: 'list_budgets', kind: 'read' }], 'accounts'),
    );

    // The `accounts` read really SUCCEEDED on a route-faithful payload: `ok`
    // item, no failure reason. `tool.completed` alone could not tell a real
    // read from a `permanent_error` projection, which is exactly how the old
    // `{ accounts: [...] }` fixture stayed green.
    const accountsItem = envelope?.items.find((item) => item.source === 'api.accounts');
    expect(accountsItem?.status).toBe('ok');
    expect('reason' in (accountsItem ?? {})).toBe(false);
    const budgetsItem = envelope?.items.find((item) => item.source === 'api.budgets');
    expect(budgetsItem?.status).toBe('error');
    expect(budgetsItem?.reason).toBe('retryable_error'); // HTTP 500

    const starts = seen.filter((e) => e.type === 'tool.started');
    const completions = seen.filter((e) => e.type === 'tool.completed');
    expect(starts).toHaveLength(2);
    expect(completions).toHaveLength(2);

    const byTool = new Map(completions.map((e) => [String(e.fields.tool), e.fields]));
    expect(byTool.get('list_accounts')).toMatchObject({ status: 'completed' });
    expect(byTool.get('list_budgets')).toMatchObject({ status: 'error' });
    for (const e of [...starts, ...completions]) {
      expect(typeof e.fields.tool).toBe('string');
      expect(typeof e.fields.status).toBe('string');
    }
    for (const e of completions) {
      expect(typeof e.fields.latencyMs).toBe('number');
    }
    // Sanitized: no financial values, account names, ids, tokens or household
    // scoping ever reach the event stream.
    const blob = JSON.stringify(seen);
    expect(blob).not.toMatch(/1\.234,56|123456|Conta secreta/);
    expect(blob).not.toContain('ws-evt');
    expect(blob).not.toContain('householdId');
  });

  it('reports timeout status when a read exceeds its budget', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: stubTools({ listAccounts: hangingGoals as ChannelReadTools['listAccounts'] }),
      readTimeoutMs: 20,
      events: (type, fields) => seen.push({ type, fields }),
    });
    await grounding.evidenceProvider(input, planFor([{ name: 'get_balance', kind: 'read' }], 'accounts'));

    const completions = seen.filter((e) => e.type === 'tool.completed');
    expect(completions).toHaveLength(1);
    expect(completions[0]!.fields.tool).toBe('list_accounts');
    expect(completions[0]!.fields.status).toBe('timeout');
    expect(typeof completions[0]!.fields.latencyMs).toBe('number');
  });
});
