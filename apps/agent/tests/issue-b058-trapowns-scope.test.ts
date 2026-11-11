/**
 * B058 trapOwns scope — a bare year that IS the parsed value must excuse
 * NOTHING else: any other temporal token in the turn still clarifies instead
 * of proposing with an assumed date.
 *
 * Debugger cases: `Gastei 2020 em 2021 no mercado` and
 * `Gastei 2020 no mercado em 2021` reached mutation-proposal with today (and
 * with ontem when present) because trapOwns exempted the whole phrase.
 * S8 interrogative queries and bare `Gastei 2020 no mercado` stay legitimate.
 */
import { describe, expect, it } from 'vitest';
import { interpretMutationUtterance } from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

const DEBUGGER_CASES = [
  'Gastei 2020 em 2021 no mercado',
  'Gastei 2020 no mercado em 2021',
  'Gastei 2020 ontem em 2021 no mercado',
  'Gastei 2020 em 2021 ontem no mercado',
] as const;

const isMutation = (text: string): boolean =>
  routeIntent(text).requestedOperations.some((operation) => operation.kind === 'mutation');

describe('trapOwns scope — other temporal tokens still clarify', () => {
  it.each([...DEBUGGER_CASES])('interpretation clarifies "%s" (never a candidate)', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    const copy = result.clarification.toLowerCase();
    expect(copy).toContain('ano');
    expect(copy).toContain('data');
  });

  it.each([...DEBUGGER_CASES])('router never proposes mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(isMutation(text)).toBe(false);
  });

  it.each([...DEBUGGER_CASES])('turn clarifies without proposing for "%s"', async (text, index) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-trapowns-${index}` },
        { actorId: 'actor-trapowns', workspaceId: 'ws-trapowns', role: 'member', deviceId: 'device-trapowns' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const copy = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(copy).toContain('ano');
    expect(copy).toContain('data');
    expect(copy).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
  });

  it('R$ variant of the same hole clarifies too ("Gastei R$ 20 no mercado em 2021")', () => {
    const result = interpretMutationUtterance('Gastei R$ 20 no mercado em 2021');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.ambiguities).toContain('ambiguous_year_date');
    expect(routeIntent('Gastei R$ 20 no mercado em 2021').mode).not.toBe('mutation-proposal');
  });
});

describe('trapOwns scope — controls that must keep working', () => {
  it('bare year-as-value stays a legitimate mutation ("Gastei 2020 no mercado")', () => {
    const result = interpretMutationUtterance('Gastei 2020 no mercado');
    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.parsed.amountCents).toBe(2020 * 100);
    expect(routeIntent('Gastei 2020 no mercado').mode).toBe('mutation-proposal');
    expect(isMutation('Gastei 2020 no mercado')).toBe(true);
  });

  it('glued-marker year value stays mutation ("Gastei R$ 2020 no mercado")', () => {
    expect(routeIntent('Gastei R$ 2020 no mercado').mode).toBe('mutation-proposal');
    expect(isMutation('Gastei R$ 2020 no mercado')).toBe(true);
  });

  it('S8 interrogative queries still divert at the router (read/unsupported, never proposal)', () => {
    // Interpretation stays candidate so the router can divert; the router owns S8.
    expect(interpretMutationUtterance('Quanto gastei em janeiro de 2020?').status).toBe('candidate');
    expect(interpretMutationUtterance('Quanto gastei em 2020?').status).toBe('candidate');
    const month = routeIntent('Quanto gastei em janeiro de 2020?');
    expect(month.mode).toBe('read');
    expect(isMutation('Quanto gastei em janeiro de 2020?')).toBe(false);
    const bare = routeIntent('Quanto gastei em 2020?');
    expect(bare.mode).not.toBe('mutation-proposal');
    expect(isMutation('Quanto gastei em 2020?')).toBe(false);
  });

  it('nominal year description stays mutation ("Gastei R$ 20 com edição de 2020")', () => {
    expect(interpretMutationUtterance('Gastei R$ 20 com edição de 2020').status).toBe('candidate');
    expect(routeIntent('Gastei R$ 20 com edição de 2020').mode).toBe('mutation-proposal');
  });

  it('relative date still resolves ("Gastei R$ 50 ontem no mercado")', () => {
    const dated = interpretMutationUtterance('Gastei R$ 50 ontem no mercado');
    expect(dated.status).toBe('candidate');
    expect(routeIntent('Gastei R$ 50 ontem no mercado').mode).toBe('mutation-proposal');
  });
});

describe('trapOwns interrogative — a second distinct year still clarifies', () => {
  const SECOND_YEAR_CASES = [
    'Gastei 2020 em 2021, quanto foi?',
    'Gastei 2020 em 2021, qual foi o valor?',
    'Gastei 2020 no mercado em 2021, quando foi?',
  ] as const;

  it.each([...SECOND_YEAR_CASES])('interpretation clarifies "%s" (never a candidate)', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    const copy = result.clarification.toLowerCase();
    expect(copy).toContain('ano');
    expect(copy).toContain('data');
  });

  it.each([...SECOND_YEAR_CASES])('router never proposes mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });

  it('second year before the value clarifies too ("Em 2021 gastei 2020 no mercado quanto foi")', () => {
    const text = 'Em 2021 gastei 2020 no mercado quanto foi';
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    expect(routeIntent(text).mode).not.toBe('mutation-proposal');
  });

  it.each([...SECOND_YEAR_CASES])('turn clarifies without proposing for "%s"', async (text, index) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-trapowns-2y-${index}` },
        { actorId: 'actor-trapowns', workspaceId: 'ws-trapowns', role: 'member', deviceId: 'device-trapowns' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const copy = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(copy).toContain('ano');
    expect(copy).toContain('data');
    expect(copy).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
  });

  it('same-year interrogative keeps the exemption but never proposes ("Gastei 2020 em 2020, quanto foi?")', () => {
    // The only year present IS the value: genuinely ambiguous, exemption
    // preserved — and the router still diverts away from any proposal.
    const text = 'Gastei 2020 em 2020, quanto foi?';
    expect(interpretMutationUtterance(text).status).toBe('candidate');
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });
});

describe('trapOwns interrogative — freestanding month material still clarifies', () => {
  const MONTH_CASES = [
    'Quanto gastei 2020 em janeiro?',
    'Quanto gastei 2020 em janeiro',
  ] as const;

  it.each([...MONTH_CASES])('interpretation clarifies "%s" (never a candidate)', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    const copy = result.clarification.toLowerCase();
    expect(copy).toContain('data');
    expect(copy).toContain('hoje');
    expect(copy).toContain('ontem');
    expect(copy).toContain('anteontem');
  });

  it.each([...MONTH_CASES])('router never proposes mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });

  it.each([...MONTH_CASES])('turn clarifies without proposing for "%s"', async (text, index) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-trapowns-month-${index}` },
        { actorId: 'actor-trapowns', workspaceId: 'ws-trapowns', role: 'member', deviceId: 'device-trapowns' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const copy = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(copy).toContain('data');
    expect(copy).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
  });

  it('month bound to another year clarifies too ("Quanto gastei em janeiro de 2021 com 2020?")', () => {
    const text = 'Quanto gastei em janeiro de 2021 com 2020?';
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    expect(routeIntent(text).mode).not.toBe('mutation-proposal');
  });

  it('S8 month+year keeps diverting to month summary ("Quanto gastei em janeiro de 2020?")', () => {
    expect(interpretMutationUtterance('Quanto gastei em janeiro de 2020?').status).toBe('candidate');
    const plan = routeIntent('Quanto gastei em janeiro de 2020?');
    expect(plan.mode).toBe('read');
    expect(plan.requestedOperations.some((operation) => operation.name === 'get_month_summary')).toBe(true);
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });
});

describe('abbreviated month context — temporal unless nominal', () => {
  const ABBR_CASES = [
    'Quanto gastei 2020 em jan?',
    'Quanto gastei 2020 em jan',
  ] as const;

  it.each([...ABBR_CASES])('interpretation clarifies "%s" (never a candidate)', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    const copy = result.clarification.toLowerCase();
    expect(copy).toContain('data');
    expect(copy).toContain('hoje');
    expect(copy).toContain('ontem');
    expect(copy).toContain('anteontem');
  });

  it.each([...ABBR_CASES])('router never proposes mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });

  it.each([...ABBR_CASES])('turn clarifies without proposing for "%s"', async (text, index) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-trapowns-abbr-${index}` },
        { actorId: 'actor-trapowns', workspaceId: 'ws-trapowns', role: 'member', deviceId: 'device-trapowns' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const copy = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(copy).toContain('data');
    expect(copy).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
  });

  it('declarative abbreviated month clarifies too ("Gastei R$ 20 no mercado em jan")', () => {
    const text = 'Gastei R$ 20 no mercado em jan';
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    expect(routeIntent(text).mode).not.toBe('mutation-proposal');
  });

  it('nominal "mar" stays a mutation with the today default ("Gastei R$ 20 no mar")', () => {
    const text = 'Gastei R$ 20 no mar';
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('candidate');
    expect(routeIntent(text).mode).toBe('mutation-proposal');
  });

  it('nominal "mar" keeps the interrogative exemption untouched ("Quanto gastei 2020 no mar?")', () => {
    const text = 'Quanto gastei 2020 no mar?';
    expect(interpretMutationUtterance(text).status).toBe('candidate');
    expect(routeIntent(text).mode).toBe('mutation-proposal');
  });
});

describe('ambiguous abbreviated month — em mar/dez clarifies without deciding', () => {
  const AMBIG_CASES = [
    'Quanto gastei 2020 em mar?',
    'Quanto gastei 2020 em mar',
    'Quanto gastei 2020 em dez?',
    'Quanto gastei 2020 em dez',
  ] as const;

  it.each([...AMBIG_CASES])('interpretation clarifies "%s" (never a candidate)', (text) => {
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    const copy = result.clarification.toLowerCase();
    expect(copy).toContain('data');
    expect(copy).toContain('hoje');
    expect(copy).toContain('ontem');
    expect(copy).toContain('anteontem');
    // Conservative: clarifies WITHOUT deciding which month it was.
    expect(copy).not.toContain('março');
    expect(copy).not.toContain('dezembro');
  });

  it.each([...AMBIG_CASES])('router never proposes mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });

  it.each([...AMBIG_CASES])('turn clarifies without proposing for "%s"', async (text, index) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-trapowns-ambig-${index}` },
        { actorId: 'actor-trapowns', workspaceId: 'ws-trapowns', role: 'member', deviceId: 'device-trapowns' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const copy = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(copy).toContain('data');
    expect(copy).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
  });

  it('declarative em-mar clarifies too ("Gastei R$ 20 em mar")', () => {
    const text = 'Gastei R$ 20 em mar';
    const result = interpretMutationUtterance(text);
    expect(result.status).toBe('clarify');
    expect(routeIntent(text).mode).not.toBe('mutation-proposal');
  });

  it('small legitimate value stays mutation ("Gastei R$ 10 no mercado")', () => {
    const text = 'Gastei R$ 10 no mercado';
    expect(interpretMutationUtterance(text).status).toBe('candidate');
    expect(routeIntent(text).mode).toBe('mutation-proposal');
  });
});
