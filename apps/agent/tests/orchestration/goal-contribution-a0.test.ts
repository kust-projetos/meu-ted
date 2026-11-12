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
  it.each([
    ['aportar 300 reais na meta Viagem 2026', 30000],
    ['aportar 300 na meta Viagem 2026', 30000],
    ['aportar R$ 250 na meta Viagem 2026', 25000],
  ])('does not parse digits in the goal name as money: %s', async (text, amountCents) => {
    const numberedGoalId = '00000000-0000-4000-8000-000000000202';
    const { result, request } = await run(text, [{ id: numberedGoalId, name: 'Viagem 2026', status: 'active' }]);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'goals.contribute', normalizedArgs: { goalId: numberedGoalId, amountCents } });
    expect(result.response?.text).not.toContain(numberedGoalId);
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
  it.each(['Guardar na meta Viagem em 10/11/2026', 'Aportar 12,345 na meta Viagem', 'Aportar 2 mil na meta Viagem', 'Aportar 1.500 na meta Viagem'])('asks amount instead of guessing from ambiguous text: %s', async (text) => {
    const { result, request } = await run(text);
    expect(result.response?.text).toMatch(/Qual valor/);
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['aportar 50,00 na meta Viagem', 'aportar 50.00 na meta Viagem'])('accepts unambiguous decimal amount: %s', async (text) => {
    const { request } = await run(text);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { goalId, amountCents: 5000 } });
  });
  it.each(['Aportar R$ 12,345 na meta Viagem', 'Aportar 1.500 reais na meta Viagem', 'Aportar R$ 12.345 na meta Viagem'])('clarifies ambiguous monetary format: %s', async (text) => {
    const { result, request } = await run(text);
    expect(result.response?.text).toMatch(/Qual valor/);
    expect(request).not.toHaveBeenCalled();
  });
  it('accepts grouped thousands with explicit cents', async () => {
    const { request } = await run('Aportar R$ 1.500,00 na meta Viagem');
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { goalId, amountCents: 150000 } });
  });
  it.each([
    ['em 2026-11-10 aportar 100 na meta Viagem', 10000],
    ['dia 10/11 aportar 100 na meta Viagem', 10000],
  ])('ignores date digits when parsing amount: %s', async (text, amountCents) => {
    const { request } = await run(text);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { goalId, amountCents } });
  });
  it('asks which meta when distinct goal names are mentioned', async () => {
    const goals = [{ id: '00000000-0000-4000-8000-000000000311', name: 'Viagem', status: 'active' }, { id: '00000000-0000-4000-8000-000000000312', name: 'Casa Própria', status: 'active' }];
    const { result, request } = await run('Aportar R$ 20 na meta Viagem e Casa Própria', goals);
    expect(result.response?.text).toMatch(/mais de uma meta/i);
    expect(request).not.toHaveBeenCalled();
  });
  it('collapses nested goal-name mentions to the containing goal', async () => {
    const goals = [{ id: '00000000-0000-4000-8000-000000000313', name: 'Reserva', status: 'active' }, { id: '00000000-0000-4000-8000-000000000314', name: 'Reserva de Emergência', status: 'active' }];
    const { request } = await run('Aportar R$ 20 na meta Reserva de Emergência', goals);
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { goalId: goals[1]!.id, amountCents: 2000 } });
  });
  it('does not treat date components as amount when another amount is present', async () => {
    const { request, result } = await run('meta Viagem 10/11 aportar 100');
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { amountCents: 10000 } });
    expect(result.mutation?.operationId).toBeTruthy();
  });
  it.each([
    ['Aportar R$ 20 na meta reserva de emergência', 'Reserva de Emergência'],
    ['Aportar R$ 20 na meta Viagem 2026', 'Viagem 2026'],
  ])('resolves the longest goal name: %s', async (text, name) => {
    const goals = [{ id: '00000000-0000-4000-8000-000000000301', name: 'Reserva', status: 'active' }, { id: '00000000-0000-4000-8000-000000000302', name: 'Reserva de Emergência', status: 'active' }, { id: '00000000-0000-4000-8000-000000000303', name: 'Viagem', status: 'active' }, { id: '00000000-0000-4000-8000-000000000304', name: 'Viagem 2026', status: 'active' }];
    const { request } = await run(text, goals);
    const expected = goals.find((goal) => goal.name === name)!;
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ normalizedArgs: { goalId: expected.id, amountCents: 2000 } });
  });
});
