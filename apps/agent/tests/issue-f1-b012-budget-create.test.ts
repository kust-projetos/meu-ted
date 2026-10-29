import { describe, expect, it, vi } from 'vitest';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

describe('F1-B012 budget creation', () => {
  it('refuses unsupported creation without reading or proposing', async () => {
    const text = 'Crie um orçamento de alimentação de 500 reais';
    const plan = routeIntent(text);
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.requestedTools).toEqual([]);
    expect(plan.ambiguity).toBe('unsupported_budget_create');
    const evidenceProvider = vi.fn(async () => { throw new Error('unexpected read'); });
    const responseProvider = vi.fn(async () => 'unexpected response');
    const orchestrator = new ConversationOrchestrator({ evidenceProvider: evidenceProvider as never, responseProvider, events: () => undefined });
    const result = await orchestrator.runTurn(normalizeRestTurn(
      { text, intentionId: 'b012-create' },
      { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' },
    ));
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text?.toLowerCase()).toContain('orçamento');
    expect(result.response?.text?.toLowerCase()).toContain('não');
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it.each(['Adicione um orçamento de alimentação', 'Quero definir um orçamento de alimentação', 'Monte um orçamento de alimentação', 'Não sei como criar um orçamento', 'Crie um orçamento e liste meus orçamentos'])('refuses creation phrased as %s', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).toBe('unsupported');
    expect(plan.ambiguity).toBe('unsupported_budget_create');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('does not treat an explicitly negated budget command as affirmative creation', () => {
    const plan = routeIntent('Não crie um orçamento');
    expect(plan.mode).toBe('unsupported');
    expect(plan.ambiguity).toBe('unsupported_budget_create');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.requestedTools).toEqual([]);
  });

  it.each(['Não sei como criar um orçamento; cancele o rascunho', 'Não sei como criar um orçamento e cancele o rascunho'])('asks to separate mixed requests in %s', (text) => {
    const plan = routeIntent(text);
    expect(plan.ambiguity).toBe('ambiguous_compound_request');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('does not treat another clause as budget creation', () => {
    const plan = routeIntent('Crie uma categoria e liste meus orçamentos');
    expect(plan.ambiguity).not.toBe('unsupported_budget_create');
  });

  it('keeps budget listing available', () => {
    const plan = routeIntent('liste meus orçamentos');
    expect(plan.mode).toBe('read');
    expect(plan.requestedOperations.map((operation) => operation.name)).toContain('list_budgets');
  });
});
