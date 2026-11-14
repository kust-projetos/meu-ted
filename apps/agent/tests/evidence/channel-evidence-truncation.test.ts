import { describe, expect, it, vi } from 'vitest';
import { serializeEvidenceForPrompt } from '../../src/evidence/evidence-envelope.js';
import { createChannelGrounding, type ChannelReadTools } from '../../src/orchestration/channel-evidence.js';
import type { TurnInput, TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';

const input: TurnInput = {
  intentionId: 'intent', traceId: 'trace', text: 'resumo', actorId: 'actor',
  workspaceId: 'workspace', role: 'member', deviceId: null, attachments: [], channel: 'pwa-rest',
};

const makePlan = (operations: string[]): TurnPlan => ({
  version: '2', mode: 'read', domain: 'general', skillNames: [],
  requestedOperations: operations.map((name) => ({ name, kind: 'read' as const })),
  missingFields: [], ambiguity: null, confidence: 1,
});

const makeTools = (calls: string[]): ChannelReadTools => Object.fromEntries([
  ['listAccounts', 'accounts'], ['listRecentTransactions', 'transactions'],
  ['getMonthSummary', 'month-summary'], ['listCards', 'cards'], ['listStatements', 'statements'],
  ['listAccountsPayable', 'payables'], ['listBudgets', 'budgets'], ['listGoals', 'goals'],
  ['listCategories', 'categories'], ['analyticsKpis', 'analytics-kpis'],
  ['analyticsCategoryBreakdown', 'analytics-breakdown'],
].map(([method, kind]) => [method, vi.fn(async () => {
  calls.push(kind!);
  return method === 'getMonthSummary' ? { incomeCents: 0, expenseCents: 0, balanceCents: 0 } : { items: [] };
})])) as unknown as ChannelReadTools;

describe('channel evidence read-cap signaling', () => {
  it('reports distinct planned reads omitted by the cap without executing them', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({ respond: async () => '', readTools: makeTools(calls) });
    const envelope = await grounding.evidenceProvider(input, makePlan([
      'list_accounts', 'list_recent_transactions', 'list_budgets', 'list_goals',
    ]));

    expect(calls).toHaveLength(2);
    expect(envelope?.omittedReads).toEqual(['budgets', 'goals']);
    const prompt = JSON.parse(serializeEvidenceForPrompt(envelope!)) as Record<string, unknown>;
    expect(prompt.evidence_truncated).toBe(true);
    expect(prompt.evidence_omitted).toEqual(['budgets', 'goals']);
  });

  it('does not add truncation metadata when all planned reads fit', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({ respond: async () => '', readTools: makeTools(calls) });
    const envelope = await grounding.evidenceProvider(input, makePlan(['list_accounts', 'list_budgets']));

    expect(calls).toHaveLength(2);
    expect(envelope?.omittedReads).toBeUndefined();
    const prompt = JSON.parse(serializeEvidenceForPrompt(envelope!)) as Record<string, unknown>;
    expect(prompt).not.toHaveProperty('evidence_truncated');
    expect(prompt).not.toHaveProperty('evidence_omitted');
  });

  it('memoizes repeated reads for the same intention and arguments', async () => {
    const calls: string[] = [];
    const tools = makeTools(calls);
    const grounding = createChannelGrounding({ respond: async () => '', readTools: tools });
    const plan = makePlan(['list_accounts', 'list_recent_transactions']);

    await grounding.evidenceProvider(input, plan);
    await grounding.evidenceProvider(input, plan);

    expect(calls).toEqual(['accounts', 'transactions']);
  });

  it('does not share cached reads across intentions', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({ respond: async () => '', readTools: makeTools(calls) });

    await grounding.evidenceProvider(input, makePlan(['list_accounts', 'list_recent_transactions']));
    await grounding.evidenceProvider({ ...input, intentionId: 'another-intention' }, makePlan(['list_accounts', 'list_recent_transactions']));

    expect(calls).toEqual(['accounts', 'transactions', 'accounts', 'transactions']);
  });

  it('applies the read cap across calls and reports newly omitted reads', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({ respond: async () => '', readTools: makeTools(calls) });
    await grounding.evidenceProvider(input, makePlan(['list_accounts', 'list_recent_transactions']));

    const envelope = await grounding.evidenceProvider(
      { ...input, text: 'outro plano' },
      makePlan(['list_budgets', 'list_goals']),
    );

    expect(calls).toEqual(['accounts', 'transactions']);
    expect(envelope?.omittedReads).toEqual(['budgets', 'goals']);
  });
});
