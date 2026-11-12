import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';

const identity = { actorId: 'actor', workspaceId: 'workspace', role: 'member' as const, deviceId: 'device' };
const goalId = '00000000-0000-4000-8000-000000000101';
const run = async (text: string, goals?: any[], exposeReader = true, intentionId = 'goal-intent') => {
  const request = vi.fn().mockResolvedValue({ id: 'pending-goal', operation: { expiresAt: new Date().toISOString() }, summary: 'Aporte proposto' });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request }),
    plan: () => ({ version: '2', mode: 'mutation-proposal', domain: 'transactions', skillNames: [], requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' }], missingFields: [], ambiguity: null, confidence: 1 }),
    entityReader: { scope: { workspaceId: 'workspace' }, listAccounts: async () => [], listCategories: async () => [], ...(exposeReader ? { listGoals: async () => goals ?? [{ id: goalId, name: 'Viagem', status: 'active' }] } : {}) },
  });
  const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { result, request };
};

describe('A0 goal contribution proposals', () => {
  it('proposes manually with the goal named and amount/date', async () => {
    const { result, request } = await run('Guardar R$ 25 na meta Viagem em 10/11/2026');
    expect(result.response?.text).not.toMatch(/Qual valor|Não encontrei/);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'goals.contribute', normalizedArgs: { goalId, amountCents: 2500, contributionDate: '2026-11-10' } });
    expect(result.response?.text).not.toContain(goalId);
    expect(result.policy?.authorizationMode).toBe('manual');
  });
  it('clarifies ambiguity and never proposes on negative or unavailable reader', async () => {
    for (const [text, rows, reader] of [
      ['Aportar R$ 20 na meta Viagem', [], true],
      ['Aportar R$ 20 na meta Viagem', [{ id: goalId, name: 'Viagem', status: 'active' }, { id: '00000000-0000-4000-8000-000000000102', name: 'Viagem', status: 'active' }], true],
      ['Não aportar R$ 20 na meta Viagem', undefined, true],
      ['Aportar R$ 20 na meta Viagem', undefined, false],
    ] as const) {
      const { result, request } = await run(text, rows as unknown as any[], reader);
      expect(result.mutation).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
    }
  });
  it.each(['cancelled', 'achieved'])('clarifies terminal goal status: %s', async (status) => {
    const { result, request } = await run('Guardar R$ 20 na meta Viagem', [{ id: goalId, name: 'Viagem', status }]);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/Viagem/);
    expect(request).not.toHaveBeenCalled();
  });
  it('reuses the intention idempotency key on redelivery', async () => {
    const first = await run('Guardar R$ 20 na meta Viagem', undefined, true, 'same-intention');
    const retry = await run('Guardar R$ 20 na meta Viagem', undefined, true, 'same-intention');
    expect(first.request.mock.calls[0]?.[2]?.idempotencyKey).toBe(retry.request.mock.calls[0]?.[2]?.idempotencyKey);
  });
});
