import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';

const id = '00000000-0000-4000-8000-000000000201';
const row = { id, name: 'Alimentação', kind: 'expense', status: 'active', scopeId: 'workspace' };
const run = async (text: string, categories: any[] = [row], reader = true, intentionId = 'budget-intent') => {
  const request = vi.fn().mockResolvedValue({ id: 'pending-budget', operation: { expiresAt: new Date().toISOString() }, summary: 'Orçamento proposto' });
  const orchestrator = new ConversationOrchestrator({ mutationApiClient: new MutationApiClient({ request }), entityReader: reader ? { scope: { workspaceId: 'workspace' }, listAccounts: async () => [], listCategories: async () => categories } : undefined });
  const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' }));
  return { result, request };
};

describe('A0 budget creation proposals', () => {
  it('resolves category by authoritative name and proposes manually', async () => {
    const { result, request } = await run('Crie um orçamento de R$ 500 para alimentação');
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'budgets.create', normalizedArgs: { categoryId: id, name: 'Alimentação', amountCents: 50000, period: 'monthly', startDate: expect.stringMatching(/^\d{4}-\d{2}-01$/) } });
    expect(result.policy?.authorizationMode).toBe('manual');
    expect(result.response?.text).not.toContain(id);
    expect(result.mutation?.presentation).toMatchObject({ tool: 'budgets.create', description: 'Orçamento mensal de Alimentação', category: { label: 'Alimentação' } });
  });
  it.each([['Crie um orçamento trimestral de R$ 500 para alimentação', 'quarterly'], ['Crie um orçamento anual de R$ 500 para alimentação', 'yearly']])('uses explicit period: %s', async (text, period) => {
    const { request } = await run(text);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { period } });
  });
  it.each(['Crie orçamento R$ 12,345 para Alimentação', 'Crie orçamento de 1.500 reais para Alimentação', 'Crie orçamento de 2 mil para Alimentação'])('does not guess ambiguous amount: %s', async (text) => {
    const { result, request } = await run(text);
    expect(result.response?.text).toMatch(/Qual valor/); expect(request).not.toHaveBeenCalled();
  });
  it.each([{ categories: [] }, { categories: [row, { ...row, id: '00000000-0000-4000-8000-000000000202' }] }])('does not propose for missing or homonymous category', async ({ categories }) => {
    const { result, request } = await run('Crie um orçamento de R$ 500 para alimentação', categories);
    expect(result.mutation).toBeUndefined(); expect(request).not.toHaveBeenCalled();
  });
  it('clarifies disjoint category matches, revenue categories, and absent reader', async () => {
    for (const [text, categories, reader] of [
      ['Crie orçamento de R$ 50 para Alimentação e Transporte', [row, { ...row, id: '00000000-0000-4000-8000-000000000203', name: 'Transporte' }], true],
      ['Crie orçamento de R$ 50 para Alimentação', [{ ...row, kind: 'income' }], true],
      ['Crie orçamento de R$ 50 para Alimentação', [], false],
    ] as const) { const { result, request } = await run(text, categories as unknown as any[], reader); expect(result.mutation).toBeUndefined(); expect(request).not.toHaveBeenCalled(); }
  });
  it.each(['Não crie um orçamento de R$ 500 para alimentação', 'Crie orçamento de R$ 50 para alimentação e liste meus gastos'])('fails closed: %s', async (text) => { const { request } = await run(text); expect(request).not.toHaveBeenCalled(); });
  it('reuses idempotency key on redelivery', async () => {
    const first = await run('Crie orçamento de R$ 50 para Alimentação', [row], true, 'redelivered');
    const second = await run('Crie orçamento de R$ 50 para Alimentação', [row], true, 'redelivered');
    expect(first.request.mock.calls[0]?.[2]?.idempotencyKey).toBe(second.request.mock.calls[0]?.[2]?.idempotencyKey);
  });
});
