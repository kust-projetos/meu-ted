/**
 * B058 follow-up (tester) — five date-material bypasses that stamped today
 * with a mutation proposal: "no ano 2020", abbreviated month
 * ("jan de 2020"), unresolvable relative ("semana passada"), bare day
 * ("dia 12") and out-of-range year ("em 1899"). All must clarify the date
 * with no mutation proposal (fail-closed).
 */
import { describe, expect, it } from 'vitest';
import { interpretMutationUtterance } from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

const CASES = [
  'Gastei R$ 20 no ano 2020',
  'Gastei R$ 50 em jan de 2020',
  'Gastei R$ 50 semana passada',
  'Gastei R$ 50 dia 12',
  'Gastei R$ 20 em 1899',
  // Debugger follow-up: genuine amount with year-date ("R$ 2020 ... ano de 2020").
  'Gastei R$ 2020 no ano de 2020',
] as const;

describe('B058 tester bypasses — date material never stamps today', () => {
  it.each(CASES)('interpretation clarifies date for "%s"', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    expect(result.clarification.toLowerCase()).toContain('data');
  });

  it.each(CASES)('router proposes no mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((op) => op.kind === 'mutation')).toBe(false);
  });

  it.each(CASES)('turn asks for date with no proposal for "%s"', async (text) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-bypass-${CASES.indexOf(text)}` },
        { actorId: 'actor-bypass', workspaceId: 'ws-bypass', role: 'member', deviceId: 'device-bypass' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const reply = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(reply).toContain('data');
  });
});

describe('B058 tester bypasses — legitimate controls stay mutation', () => {
  it.each([
    'Gastei R$ 50 ontem no mercado',
    'Gastei R$ 50 com carne',
    'Gastei R$ 2020 no mercado',
    'Gastei R$ 20 com edição de 2020',
    'Gastei R$ 20 com vinho de 1899',
    'Gastei R$ 50 no mar',
  ])('stays mutation-proposal for "%s"', (text) => {
    expect(interpretMutationUtterance(text).status).toBe('candidate');
    expect(routeIntent(text).mode).toBe('mutation-proposal');
  });

  it('S8 read control stays read', () => {
    expect(routeIntent('Quanto gastei em janeiro de 2020?').mode).toBe('read');
  });

  it.each([
    'Edição de 2020, gastei R$ 20',
    'Bom dia, gastei R$ 50 no mercado',
    'Ontem gastei R$ 50 no mercado',
  ])('anteposed nominal/greeting/supported-relative stays mutation-proposal for "%s"', (text) => {
    expect(interpretMutationUtterance(text).status).toBe('candidate');
    expect(routeIntent(text).mode).toBe('mutation-proposal');
  });
});

const PREFIX_CASES = [
  'No ano 2020 gastei R$ 20',
  'Dia 12 gastei R$ 50',
  'Semana passada gastei R$ 50',
  'Em jan de 2020 gastei R$ 50',
  // Debugger follow-up, anteposed form.
  'No ano de 2020 gastei R$ 20',
] as const;

describe('B058 symmetric prefix — anteposed date never stamps today', () => {
  it.each(PREFIX_CASES)('interpretation clarifies date for "%s"', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    expect(result.clarification.toLowerCase()).toContain('data');
  });

  it.each(PREFIX_CASES)('router proposes no mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((op) => op.kind === 'mutation')).toBe(false);
  });

  it.each(PREFIX_CASES)('turn asks for date with no proposal for "%s"', async (text) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-prefix-${PREFIX_CASES.indexOf(text)}` },
        { actorId: 'actor-prefix', workspaceId: 'ws-prefix', role: 'member', deviceId: 'device-prefix' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const reply = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(reply).toContain('data');
  });
});
