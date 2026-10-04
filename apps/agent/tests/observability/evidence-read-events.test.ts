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

const okAccounts = async () => ({ accounts: [{ accountName: 'Conta secreta R$ 1.234,56', balanceCents: 123456 }] });
const failingBudgets = async () => {
  throw Object.assign(new Error('HTTP 500'), { statusCode: 500, code: 'api.request_failed' });
};
const hangingGoals: ChannelReadTools['listGoals'] = () => new Promise(() => undefined as never);

const stubTools = (overrides: Partial<ChannelReadTools> = {}): ChannelReadTools => ({
  listAccounts: okAccounts,
  listRecentTransactions: async () => ({ transactions: [] }),
  getMonthSummary: async () => ({}),
  listStatements: async () => ({}),
  listAccountsPayable: async () => ({}),
  listBudgets: failingBudgets,
  listGoals: hangingGoals,
  listCategories: async () => ({}),
  // A09-int: never planned by the lifecycle events under test.
  analyticsKpis: async () => ({}),
  analyticsCategoryBreakdown: async () => ({}),
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
    await grounding.evidenceProvider(
      input,
      planFor([{ name: 'get_balance', kind: 'read' }, { name: 'list_budgets', kind: 'read' }], 'accounts'),
    );

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
