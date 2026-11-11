/**
 * B058 (reviewer) — ISO date before the amount ("2020-01-02 gastei R$ 50 no mercado").
 * The financial parser only resolves hoje/ontem/anteontem: an explicit ISO
 * date must never silently become "today". It must clarify the date, with no proposal.
 */
import { describe, expect, it } from 'vitest';
import { interpretMutationUtterance } from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

const CASE = '2020-01-02 gastei R$ 50 no mercado';

describe('B058 reviewer — ISO anteposta clarifica data sem proposta', () => {
  it('interpretação clarifica data (missingFields date)', () => {
    const result = interpretMutationUtterance(CASE);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    expect(result.clarification.toLowerCase()).toContain('data');
  });

  it('router nunca propõe mutação para o caso ISO', () => {
    const plan = routeIntent(CASE);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((op) => op.kind === 'mutation')).toBe(false);
  });

  it('turno pede data sem proposta nem leitura', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: CASE, intentionId: 'intent-b058-iso' },
        { actorId: 'actor-b058-iso', workspaceId: 'ws-b058-iso', role: 'member', deviceId: 'device-b058-iso' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const text = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(text).toContain('data');
  });
});

const YEAR_MONTH_BEFORE = '2020-01 gastei R$ 50 no mercado';
const YEAR_MONTH_AFTER = 'Gastei R$ 50 em 2020-01 no mercado';

describe('B058 gap — ISO ano-mês clarifica data sem proposta (antes/depois do valor)', () => {
  it.each([YEAR_MONTH_BEFORE, YEAR_MONTH_AFTER])(
    'interpretação clarifica data para "%s"',
    (text) => {
      const result = interpretMutationUtterance(text);
      expect(result.status).toBe('clarify');
      if (result.status !== 'clarify') return;
      expect(result.missingFields).toContain('date');
      expect(result.clarification.toLowerCase()).toContain('data');
    },
  );

  it.each([YEAR_MONTH_BEFORE, YEAR_MONTH_AFTER])('router nunca propõe mutação para "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((op) => op.kind === 'mutation')).toBe(false);
  });

  it('turno com ano-mês anteposto pede data sem proposta', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: YEAR_MONTH_BEFORE, intentionId: 'intent-b058-ym' },
        { actorId: 'actor-b058-ym', workspaceId: 'ws-b058-ym', role: 'member', deviceId: 'device-b058-ym' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const text = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(text).toContain('data');
  });
});
