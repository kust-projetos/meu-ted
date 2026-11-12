import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';

const budgetId = '00000000-0000-4000-8000-000000000301';
const categoryId = '00000000-0000-4000-8000-000000000302';
const budget = { id: budgetId, name: 'Mercado mensal', categoryId, status: 'active', scopeId: 'workspace' };
const category = { id: categoryId, name: 'Mercado', kind: 'expense', status: 'active', scopeId: 'workspace' };
const run = async (text: string, budgets: any[] = [budget], categories: any[] = [category], reader = true, intentionId = 'budget-update') => {
  const request = vi.fn().mockResolvedValue({ id: 'pending-budget-update', operation: { expiresAt: new Date().toISOString() }, summary: 'Ajuste proposto' });
  const orchestrator = new ConversationOrchestrator({ mutationApiClient: new MutationApiClient({ request }), entityReader: reader ? { scope: { workspaceId: 'workspace' }, listAccounts: async () => [], listCategories: async () => categories, listBudgets: async () => budgets } : undefined });
  const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' }));
  return { result, request };
};

describe('A0 budget update proposals', () => {
  it.each(['Aumente o orçamento Mercado mensal para 600', 'Ajuste o teto de Mercado para R$ 600'])('resolves by budget or category name and proposes manually: %s', async (text) => {
    const { result, request } = await run(text);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'budgets.update', normalizedArgs: { budgetId, amountCents: 60000 } });
    expect(result.policy?.authorizationMode).toBe('manual');
    expect(result.response?.text).not.toContain(budgetId);
  });
  it('chooses the new amount in de/para and asks for the ceiling for threshold-only requests', async () => {
    const proposed = await run('Aumente o orçamento Mercado mensal de 500 para 600');
    expect(proposed.request.mock.calls[0]?.[2]?.body.normalizedArgs.amountCents).toBe(60000);
    const threshold = await run('Ajuste o orçamento Mercado mensal, só alerta em 90%');
    expect(threshold.result.response?.text).toMatch(/novo teto/i);
    expect(threshold.request).not.toHaveBeenCalled();
  });
  it('includes a cited alert threshold only alongside the new ceiling', async () => {
    const { request } = await run('Ajuste o orçamento Mercado mensal para 600, alerta em 90%');
    expect(request.mock.calls[0]?.[2]?.body.normalizedArgs).toEqual({ budgetId, amountCents: 60000, alertThreshold: 90 });
  });
  it('treats limite without percent as ceiling text, and alerta with percent as threshold', async () => {
    const ceiling = await run('Ajuste o limite do orçamento de mercado para 600');
    expect(ceiling.request.mock.calls[0]?.[2]?.body.normalizedArgs).toEqual({ budgetId, amountCents: 60000 });
    const threshold = await run('Aumente o teto de mercado para 600 com alerta em 90%');
    expect(threshold.request.mock.calls[0]?.[2]?.body.normalizedArgs).toEqual({ budgetId, amountCents: 60000, alertThreshold: 90 });
  });
  it('clarifies zero/multiple matches and unavailable reader', async () => {
    const cases: Array<{ budgets: any[]; categories: any[]; reader: boolean }> = [
      { budgets: [], categories: [category], reader: true },
      { budgets: [budget, { ...budget, id: '00000000-0000-4000-8000-000000000303', name: 'Mercado mensal' }], categories: [category], reader: true },
      { budgets: [budget], categories: [category], reader: false },
    ];
    for (const { budgets, categories, reader } of cases) {
      const { result, request } = await run('Aumente orçamento Mercado mensal para 600', budgets, categories, reader);
      expect(result.mutation).toBeUndefined(); expect(request).not.toHaveBeenCalled();
    }
  });
  it.each(['Não aumente o orçamento Mercado mensal para 600', 'Aumente o orçamento Mercado mensal para 600 e compre pão', 'Quanto é o orçamento Mercado mensal?'])('does not propose: %s', async (text) => {
    const { request } = await run(text); expect(request).not.toHaveBeenCalled();
  });
  it('redelivery uses the same idempotency key and never exposes an id', async () => {
    const first = await run('Aumente o orçamento Mercado mensal para 600', [budget], [category], true, 'same-turn');
    const second = await run('Aumente o orçamento Mercado mensal para 600', [budget], [category], true, 'same-turn');
    expect(first.request.mock.calls[0]?.[2]?.idempotencyKey).toBe(second.request.mock.calls[0]?.[2]?.idempotencyKey);
    expect(first.result.response?.text).not.toContain(budgetId);
  });
});
