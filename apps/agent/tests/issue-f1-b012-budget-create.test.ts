import { describe, expect, it, vi } from 'vitest';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';

const category = { id: '00000000-0000-4000-8000-000000000301', name: 'Alimentação', kind: 'expense', status: 'active', scopeId: 'workspace' };
const setup = (categories = [category]) => {
  const request = vi.fn().mockResolvedValue({ id: 'pending', operation: { expiresAt: new Date().toISOString() }, summary: 'Orçamento proposto' });
  const orchestrator = new ConversationOrchestrator({ mutationApiClient: new MutationApiClient({ request }), entityReader: { scope: { workspaceId: 'workspace' }, listAccounts: async () => [], listCategories: async () => categories } });
  return { request, orchestrator };
};

describe('F1-B012 budget creation', () => {
  it('routes and proposes a complete request via manual Pending V2', async () => {
    const text = 'Crie um orçamento mensal de R$ 500 para alimentação';
    const plan = routeIntent(text);
    expect(plan.mode).toBe('mutation-proposal'); expect(plan.requestedTools).toContain('budgets.create');
    const { request, orchestrator } = setup();
    const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId: 'b012-create' }, { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' }));
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'budgets.create', normalizedArgs: { categoryId: category.id, amountCents: 50000, period: 'monthly' } });
    expect(result.policy?.authorizationMode).toBe('manual'); expect(result.response?.text).not.toContain(category.id);
  });
  it.each(['Não crie um orçamento', 'Não sei como criar um orçamento'])('keeps unsupported for %s', (text) => {
    const plan = routeIntent(text); expect(plan.mode).toBe('unsupported'); expect(plan.ambiguity).toBe('unsupported_budget_create');
  });
  it.each(['Crie um orçamento de R$ 500', 'Crie um orçamento para Alimentação'])('clarifies missing category or amount in %s', async (text) => {
    const { request, orchestrator } = setup();
    const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId: 'b012-incomplete' }, { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' }));
    expect(result.mutation).toBeUndefined(); expect(request).not.toHaveBeenCalled();
  });
  it('keeps budget listing available', () => expect(routeIntent('liste meus orçamentos').requestedOperations.map((op) => op.name)).toContain('list_budgets'));
});
