/**
 * R10 (AC20/AC30) — shared per-turn recovery budget (TDD RED first).
 *
 * One shared cap of TWO recoveries per turn spans the grounding correction
 * retry and read-only entity-resolution recoveries. An identical resolution
 * recovery (same kind/args/scope + same evidence revision) is blocked ALWAYS,
 * even while budget remains: a repetition without new evidence never re-runs.
 */
import { describe, expect, it } from 'vitest';
import {
  TURN_RECOVERY_CAP,
  TurnBudget,
  resolutionRecoveryFingerprint,
  type ResolutionRecoveryRequest,
} from '../../src/orchestration/turn-budget.js';

/**
 * The fingerprint covers the canonical financial `args`, so an override that
 * names one (`description`, `amountCents`, `date`, `categoryQuery`) must land
 * INSIDE `args` — a top-level spread would build the SAME request and the
 * (correct) fingerprint block would fire instead of the case under test.
 * Request-level overrides (`kind`, `workspaceId`, `actorId`,
 * `evidenceRevision`) stay top level.
 */
const request = (
  overrides: Partial<ResolutionRecoveryRequest> & Partial<ResolutionRecoveryRequest['args']> = {},
): ResolutionRecoveryRequest => {
  const {
    kind = 'expense',
    workspaceId = 'ws-1',
    actorId = 'actor-1',
    evidenceRevision,
    resolutionHint,
    ...argOverrides
  } = overrides;
  return {
    kind,
    args: { amountCents: 1234, description: 'Mercado', date: '2026-10-03', ...argOverrides },
    workspaceId,
    actorId,
    ...(evidenceRevision !== undefined ? { evidenceRevision } : {}),
    ...(resolutionHint !== undefined ? { resolutionHint } : {}),
  };
};

describe('R10 TurnBudget — shared recovery ceiling', () => {
  it('caps total recoveries at two across axes', () => {
    expect(TURN_RECOVERY_CAP).toBe(2);
  });

  it('lets the grounding retry consume one slot and still admits one resolution recovery', () => {
    const budget = new TurnBudget();
    budget.noteGroundingRetry();

    const first = budget.tryResolutionRecovery(request());
    expect(first.allowed).toBe(true);
    expect(budget.snapshot().recoveriesUsed).toBe(2);

    const second = budget.tryResolutionRecovery(request({ description: 'Farmácia' }));
    expect(second).toEqual({ allowed: false, stop: 'budget_exhausted' });
    // A refused attempt never consumes a slot.
    expect(budget.snapshot().recoveriesUsed).toBe(2);
  });

  it('exhausts after two resolution recoveries even without a grounding retry', () => {
    const budget = new TurnBudget();
    expect(budget.tryResolutionRecovery(request()).allowed).toBe(true);
    expect(budget.tryResolutionRecovery(request({ description: 'Farmácia' })).allowed).toBe(true);
    expect(budget.tryResolutionRecovery(request({ description: 'Posto' }))).toEqual({
      allowed: false,
      stop: 'budget_exhausted',
    });
  });

  it('blocks an identical resolution recovery even while budget remains', () => {
    const budget = new TurnBudget();
    expect(budget.tryResolutionRecovery(request()).allowed).toBe(true);

    // Same kind + args + scope, same evidence revision: no new evidence.
    const repeat = budget.tryResolutionRecovery(request());
    expect(repeat).toEqual({ allowed: false, stop: 'no_new_strategy' });
    expect(budget.snapshot().recoveriesUsed).toBe(1);
    expect(budget.snapshot().blockedRepeats).toBe(1);
  });

  it('admits the same args again when the evidence source revision changed', () => {
    const budget = new TurnBudget();
    expect(budget.tryResolutionRecovery(request()).allowed).toBe(true);
    expect(
      budget.tryResolutionRecovery(request({ evidenceRevision: '2026-10-03T02:00:00.000Z' })).allowed,
    ).toBe(true);
  });

  it('scopes the fingerprint to workspace and actor', () => {
    const base = resolutionRecoveryFingerprint(request());
    expect(resolutionRecoveryFingerprint(request({ workspaceId: 'ws-2' }))).not.toBe(base);
    expect(resolutionRecoveryFingerprint(request({ actorId: 'actor-2' }))).not.toBe(base);
    expect(resolutionRecoveryFingerprint(request())).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  // The resolver picks the account from the EFFECTIVE hint text (the turn's
  // text, or the draft description + the user's answer), so two different
  // hints are two different strategies even with identical canonical args.
  it('covers the effective resolution hint in the fingerprint', () => {
    const base = resolutionRecoveryFingerprint(request());
    expect(resolutionRecoveryFingerprint(request({ resolutionHint: 'Nubank' }))).not.toBe(base);
    expect(resolutionRecoveryFingerprint(request({ resolutionHint: 'Itau' }))).not.toBe(
      resolutionRecoveryFingerprint(request({ resolutionHint: 'Nubank' })),
    );
    // An omitted hint keeps the current behaviour exactly: the same attempt.
    expect(resolutionRecoveryFingerprint(request({ resolutionHint: undefined }))).toBe(base);
  });

  it('admits the same args with a different resolution hint as a new strategy', () => {
    const budget = new TurnBudget();
    expect(budget.tryResolutionRecovery(request({ resolutionHint: 'Nubank' })).allowed).toBe(true);
    // "Itaú" answers a different account with the same money: a real new
    // strategy, not a repetition.
    expect(budget.tryResolutionRecovery(request({ resolutionHint: 'Itau' })).allowed).toBe(true);
    expect(budget.snapshot().blockedRepeats).toBe(0);
    expect(budget.snapshot().resolutionRecoveries).toBe(2);
  });

  it('records propose attempts on their own axis without granting recovery budget', () => {
    const budget = new TurnBudget();
    budget.noteProposeAttempt();
    budget.noteProposeAttempt();

    const snapshot = budget.snapshot();
    expect(snapshot.proposeAttempts).toBe(2);
    expect(snapshot.recoveriesUsed).toBe(0);
    expect(budget.tryResolutionRecovery(request()).allowed).toBe(true);
    expect(budget.tryResolutionRecovery(request({ description: 'Farmácia' })).allowed).toBe(true);
  });

  it('exposes only the declared safe stop reasons', () => {
    const budget = new TurnBudget();
    expect(budget.snapshot().stop).toBe('completed');
    budget.stopWith('clarification_needed');
    expect(budget.snapshot().stop).toBe('clarification_needed');
  });

  it('emits a numeric-only snapshot with no raw ids, text or args', () => {
    const budget = new TurnBudget();
    budget.noteGroundingRetry();
    budget.tryResolutionRecovery(request());
    budget.noteProposeAttempt();

    const snapshot = budget.snapshot();
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === 'stop') continue;
      expect(typeof value, key).toBe('number');
    }
    const blob = JSON.stringify(snapshot);
    expect(blob).not.toMatch(/ws-1|actor-1|Mercado|1234|2026-10-03/);
    expect(snapshot.recoveriesUsed).toBe(2);
    expect(snapshot.groundingRetries).toBe(1);
    expect(snapshot.resolutionRecoveries).toBe(1);
  });
});