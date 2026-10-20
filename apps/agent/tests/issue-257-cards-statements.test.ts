/**
 * Issue #257 — cards vs statements evidence (TDD RED→GREEN).
 *
 * "Liste meus cartões" lê o POOL de cartões (`GET /cards/accounts`,
 * evidência `cards`) e NUNCA statements/payables. "Mostre minhas faturas"
 * lê faturas (statements/payables) e NUNCA `cards`. Ausência de faturas
 * ≠ ausência de cartões: as duas leituras têm fonte própria.
 */
import { describe, expect, it } from 'vitest';
import { createChannelGrounding, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import type { TurnInput, TurnPlan } from '../src/orchestration/conversation-orchestrator.js';

const input: TurnInput = {
  intentionId: 'intent-257',
  traceId: 'intent-257',
  text: 'Liste meus cartões',
  actorId: 'actor-257',
  workspaceId: 'ws-257',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
};

const planFor = (operation: string, domain: TurnPlan['domain']): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain,
  skillNames: ['contas-cartoes'],
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

const sourcesOf = (envelope: { items: readonly { source: string }[] }): string[] =>
  envelope.items.map((item) => item.source);

describe('issue #257 cards vs statements', () => {
  it('1) "Liste meus cartões" plans list_cards in the cards domain', () => {
    const plan = routeIntent('Liste meus cartões');
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('cards');
    expect(plan.requestedOperations.map((operation) => operation.name)).toContain('list_cards');
  });

  it('2) "Mostre minhas faturas" never plans list_cards (statements/payables, not cards)', () => {
    const plan = routeIntent('Mostre minhas faturas');
    expect(plan.mode).toBe('read');
    expect(plan.domain).not.toBe('cards');
    expect(plan.requestedOperations.map((operation) => operation.name)).not.toContain('list_cards');
  });

  it('3) evidence: a list_cards plan reads the card pool (api.cards), never statements', async () => {
    const calls: string[] = [];
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        listCards: async () => {
          calls.push('listCards');
          return { items: [], total: 0 };
        },
        listStatements: async () => {
          calls.push('listStatements');
          return { items: [], total: 0 };
        },
      }),
    });
    const envelope = await grounding.evidenceProvider(input, planFor('list_cards', 'cards'));
    expect(envelope).not.toBeNull();
    expect(calls).toContain('listCards');
    expect(calls).not.toContain('listStatements');
    expect(sourcesOf(envelope!)).toContain('api.cards');
    expect(sourcesOf(envelope!)).not.toContain('api.statements');
  });

  it('4) absence of statements proves nothing about the card pool (distinct sources)', async () => {
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: readTools({
        listCards: async () => ({ items: [], total: 0 }),
        listStatements: async () => ({ items: [], total: 0 }),
      }),
    });
    const cards = await grounding.evidenceProvider(input, planFor('list_cards', 'cards'));
    const statements = await grounding.evidenceProvider(
      { ...input, text: 'Mostre minhas faturas' },
      planFor('list_statements', 'general'),
    );
    expect(cards).not.toBeNull();
    expect(statements).not.toBeNull();
    // Fontes próprias: a ausência de uma nunca é a ausência da outra.
    expect(sourcesOf(cards!)).not.toEqual(sourcesOf(statements!));
  });
});
