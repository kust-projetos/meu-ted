import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';

const budgetId = '00000000-0000-4000-8000-000000000301';
const categoryId = '00000000-0000-4000-8000-000000000302';
const budget = { id: budgetId, name: 'Mercado mensal', categoryId, status: 'active', scopeId: 'workspace' };
const category = { id: categoryId, name: 'Mercado', kind: 'expense', status: 'active', scopeId: 'workspace' };
const run = async (text: string, budgets: any[] = [budget], categories: any[] = [category], intentionId = 'budget-delete') => {
  const request = vi.fn().mockResolvedValue({ id: 'pending-budget-delete', operation: { expiresAt: new Date().toISOString() }, summary: 'Apagar orçamento de Mercado mensal' });
  const orchestrator = new ConversationOrchestrator({ mutationApiClient: new MutationApiClient({ request }), entityReader: { scope: { workspaceId: 'workspace' }, listAccounts: async () => [], listCategories: async () => categories, listBudgets: async () => budgets } });
  const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' }));
  return { result, request };
};

describe('A0 budget deletion proposals', () => {
  it.each(['Apague o orçamento Mercado mensal', 'Remova o orçamento de Mercado'])('resolves by budget or category name and proposes manually: %s', async (text) => {
    const { result, request } = await run(text);
    expect(request.mock.calls[0]?.[2]?.body.normalizedArgs).toEqual({ budgetId });
    expect(result.response?.text).toContain('Apagar orçamento de Mercado mensal');
    expect(result.policy?.authorizationMode).toBe('manual');
    expect(result.response?.text).not.toContain(budgetId);
  });
  it('clarifies zero and multiple matches', async () => {
    for (const budgets of [[], [budget, { ...budget, id: '00000000-0000-4000-8000-000000000303', name: 'Outro orçamento' }]]) {
      const { result, request } = await run('Apague o orçamento', budgets);
      expect(result.clarification?.missingFields).toContain('budgetId');
      expect(result.response?.text).not.toContain(budgetId);
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('clarifies when separate names identify separate budgets', async () => {
    const otherCategory = { id: '00000000-0000-4000-8000-000000000304', name: 'Alimentação', kind: 'expense', status: 'active', scopeId: 'workspace' };
    const otherBudget = { id: '00000000-0000-4000-8000-000000000303', name: 'Alimentação', categoryId: otherCategory.id, status: 'active', scopeId: 'workspace' };
    const { result, request } = await run('Apague orçamento Mercado e Alimentação', [budget, otherBudget], [category, otherCategory]);
    expect(result.clarification?.missingFields).toContain('budgetId');
    expect(request).not.toHaveBeenCalled();
  });
  it('redelivery uses the same key and rejected question/negation never propose', async () => {
    const a = await run('Apague o orçamento Mercado mensal', [budget], [category], 'same-turn');
    const b = await run('Apague o orçamento Mercado mensal', [budget], [category], 'same-turn');
    expect(a.request.mock.calls[0]?.[2]?.idempotencyKey).toBe(b.request.mock.calls[0]?.[2]?.idempotencyKey);
    for (const text of ['Não apague o orçamento Mercado mensal', 'Posso apagar o orçamento Mercado mensal?']) {
      const attempt = await run(text);
      expect(attempt.request).not.toHaveBeenCalled();
    }
  });
});
