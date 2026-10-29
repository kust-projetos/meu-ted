/**
 * B058 reviewer copy — both new date ambiguities must say the date was not
 * recognized and ask for the WHOLE operation resent with hoje, ontem or
 * anteontem. They must never promise absolute dates nor that a draft persists.
 */
import { describe, expect, it } from 'vitest';
import {
  ambiguityClarificationText,
  interpretMutationUtterance,
} from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

const YEAR_CASE = 'Gastei R$ 20 em 2020';
const EXPLICIT_CASE = 'Gastei R$ 50 semana passada';

const assertHonestCopy = (text: string, needsAno: boolean): void => {
  const lower = text.toLowerCase();
  // Says the date was not recognized and names the only supported dates.
  expect(lower).toContain('não reconheci');
  expect(lower).toContain('data');
  expect(lower).toContain('hoje');
  expect(lower).toContain('ontem');
  expect(lower).toContain('anteontem');
  // Asks for the whole operation resent — never a patch on a kept draft.
  expect(lower).toContain('operação inteira');
  if (needsAno) expect(lower).toContain('ano');
  // Never promises an absolute date or a persisting draft.
  expect(lower).not.toContain('rascunho');
  expect(lower).not.toMatch(/vou guardar|guardei|mantive/);
  expect(lower).not.toContain('dia, o mês e o ano');
  expect(lower).not.toContain('(dia e mês)');
};

describe('B058 copy contract — honest date clarification', () => {
  it('year ambiguity keeps the date contract with honest copy', () => {
    const result = interpretMutationUtterance(YEAR_CASE);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.ambiguities).toContain('ambiguous_year_date');
    expect([...result.missingFields]).toEqual(['date']);
    expect(result.clarification).toBe(ambiguityClarificationText('ambiguous_year_date'));
    assertHonestCopy(result.clarification, true);
  });

  it('explicit-date ambiguity keeps the date contract with honest copy', () => {
    const result = interpretMutationUtterance(EXPLICIT_CASE);
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.ambiguities).toContain('unresolved_explicit_date');
    expect([...result.missingFields]).toEqual(['date']);
    expect(result.clarification).toBe(ambiguityClarificationText('unresolved_explicit_date'));
    assertHonestCopy(result.clarification, false);
  });

  it.each([YEAR_CASE, EXPLICIT_CASE])('router carries no mutation for "%s"', (text) => {
    const plan = routeIntent(text);
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((op) => op.kind === 'mutation')).toBe(false);
  });
});

describe('B058 copy conversation — turn asks for a full resend', () => {
  it.each([YEAR_CASE, EXPLICIT_CASE])('turn renders the honest copy for "%s"', async (text, index) => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId: `intent-copy-${index}` },
        { actorId: 'actor-copy', workspaceId: 'ws-copy', role: 'member', deviceId: 'device-copy' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    assertHonestCopy(result.clarification?.text ?? result.response?.text ?? '', text === YEAR_CASE);
  });

  it('isolated date follow-up proposes nothing by itself', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const ctx = { actorId: 'actor-copy-fu', workspaceId: 'ws-copy-fu', role: 'member', deviceId: 'device-copy-fu' } as const;
    const first = await orchestrator.runTurn(
      normalizeRestTurn({ text: EXPLICIT_CASE, intentionId: 'intent-copy-fu-1' }, ctx),
    );
    expect(first.mutation).toBeUndefined();
    // The user resends only the date instead of the whole operation:
    // with no draft ever created, a bare date must not become a proposal.
    expect(routeIntent('ontem').mode).not.toBe('mutation-proposal');
    const second = await orchestrator.runTurn(normalizeRestTurn({ text: 'ontem', intentionId: 'intent-copy-fu-2' }, ctx));
    expect(second.mutation).toBeUndefined();
  });
});
