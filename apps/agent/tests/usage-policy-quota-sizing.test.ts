/**
 * FIX-AGENT-QUOTA-SIZING — the daily budgets must fit the REAL relay
 * reservation size.
 *
 * Each relay leg reserves `estimateTokens(system + prompt) + maxOutputTokens`
 * BEFORE dispatch (`finance-chat-agent` runRelayLeg) with the transmitted
 * payload bounded at 7 900 system chars + 15 000 prompt chars and a 2 000
 * max-output reservation — up to 7 725 tokens per leg. A user turn can hold
 * more than one leg (primary, fallback, grounding correction), and dispatched
 * failures retain the FULL reservation by policy. With the previous 10 000 /
 * 20 000 budgets a single user session exhausted the actor quota in 1–2 turns
 * and every later turn answered 429 `agent.quota_exceeded`.
 *
 * These tests pin the sizing: a worst-case leg must fit, the day must still be
 * bounded (anti-DoS), and the previous constants must be visibly insufficient.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  estimateTokens,
  finalizeUsageAttempt,
  reserveUsageAttempt,
  type UsagePolicy,
} from '../src/safety/usage-policy.js';
import { createRelayUsageStorage, type RelayUsageTestStorage } from './helpers/relay-usage-storage.js';

/** Transmitted-payload bounds enforced by the relay leg before reserving. */
const WORST_CASE_SYSTEM_CHARS = 7_900;
const WORST_CASE_PROMPT_CHARS = 15_000;

/** Worst-case estimated input of one relay leg (chars / 4, rounded up). */
const WORST_CASE_INPUT_TOKENS = estimateTokens('x'.repeat(WORST_CASE_SYSTEM_CHARS + WORST_CASE_PROMPT_CHARS));

/** Worst-case reservation of one relay leg: estimated input + max output. */
const WORST_CASE_RESERVATION_TOKENS = WORST_CASE_INPUT_TOKENS + DEFAULT_POLICY.maxOutputTokens;

/**
 * Two gates are orthogonal to the daily-budget sizing under test and are
 * relaxed here so they cannot mask it: the per-request input ceiling (2 000)
 * rejects the worst-case leg before any budget read, and the in-memory
 * storage mock ignores the sliding window (its rate count is every attempt).
 * `maxInputTokens`/`maxOutputTokens`/rate values stay at their defaults in
 * production — only the daily budgets are what these tests measure.
 */
const sizingPolicy = (overrides: Partial<UsagePolicy> = {}): UsagePolicy => ({
  ...DEFAULT_POLICY,
  maxInputTokens: WORST_CASE_INPUT_TOKENS,
  maxRequestsPerWindow: 1_000,
  ...overrides,
});

const reserveWorstCaseLeg = (
  storage: RelayUsageTestStorage,
  policy: UsagePolicy,
  actorId = 'user-1',
  leg = 0,
) =>
  reserveUsageAttempt(
    storage,
    {
      actorId,
      intentionId: `intent-sizing-${actorId}-${leg}`,
      estimatedInputTokens: WORST_CASE_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_POLICY.maxOutputTokens,
    },
    policy,
  );

describe('FIX-AGENT-QUOTA-SIZING — daily budgets fit worst-case relay legs', () => {
  it('accepts a single worst-case relay reservation on an empty ledger', () => {
    const storage = createRelayUsageStorage();

    const result = reserveWorstCaseLeg(storage, sizingPolicy());

    expect(result.allowed).toBe(true);
    expect(result.attemptId).toBeTruthy();
    expect([...storage.__state.attempts.values()]).toHaveLength(1);
  });

  it('admits every worst-case leg that fits the actor day and denies the next one (anti-DoS bound kept)', () => {
    const storage = createRelayUsageStorage();
    const policy = sizingPolicy();
    const legsThatFit = Math.floor(DEFAULT_POLICY.actorDailyBudget / WORST_CASE_RESERVATION_TOKENS);

    const admitted: boolean[] = [];
    for (let leg = 0; leg < legsThatFit; leg += 1) {
      admitted.push(reserveWorstCaseLeg(storage, policy, 'user-1', leg).allowed);
    }
    expect(admitted).toHaveLength(legsThatFit);
    expect(admitted.every(Boolean)).toBe(true);

    const denied = reserveWorstCaseLeg(storage, policy, 'user-1', legsThatFit);
    expect(denied.allowed).toBe(false);
    // The ACTOR budget binds first (the workspace budget is twice as large)
    // and the reason names the live constant.
    expect(denied.reason).toContain(`Actor daily token budget of ${DEFAULT_POLICY.actorDailyBudget}`);
    expect(denied.reason).not.toContain('Rate limit');
    // Bounded, not unbounded: dozens of worst-case legs per actor per day.
    expect(legsThatFit).toBeGreaterThanOrEqual(20);
    expect(legsThatFit).toBeLessThanOrEqual(30);
  });

  it('successful legs reconcile downward to real usage, so the bound stays usage-based', () => {
    const storage = createRelayUsageStorage();
    const policy = sizingPolicy();
    const first = reserveWorstCaseLeg(storage, policy, 'user-1', 0);
    expect(first.allowed).toBe(true);

    // Reliable usage far below the reservation (the common real turn).
    const settled = finalizeUsageAttempt(storage, first.attemptId!, { inputTokens: 900, outputTokens: 300 }, { reliable: true });
    expect(settled.transitioned).toBe(true);

    const counted = [...storage.__state.attempts.values()][0]!;
    expect(counted.counted_input_tokens + counted.counted_output_tokens).toBeLessThan(WORST_CASE_RESERVATION_TOKENS);
    // The actor budget still admits the whole day of worst-case legs on top.
    const legsThatFit = Math.floor(DEFAULT_POLICY.actorDailyBudget / WORST_CASE_RESERVATION_TOKENS);
    for (let leg = 1; leg <= legsThatFit; leg += 1) {
      expect(reserveWorstCaseLeg(storage, policy, 'user-1', leg).allowed).toBe(true);
    }
  });

  it('regression guard: the pre-recalibration budgets (10 000 / 20 000) deny the SECOND worst-case leg', () => {
    const legacyPolicy = sizingPolicy({ dailyBudget: 20_000, actorDailyBudget: 10_000 });
    const storage = createRelayUsageStorage();

    expect(reserveWorstCaseLeg(storage, legacyPolicy, 'user-1', 0).allowed).toBe(true);
    const denied = reserveWorstCaseLeg(storage, legacyPolicy, 'user-1', 1);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("Actor daily token budget of 10000");

    // Live constants stay recalibrated (10x / 20x of the legacy values).
    expect(DEFAULT_POLICY.actorDailyBudget).toBe(200_000);
    expect(DEFAULT_POLICY.dailyBudget).toBe(400_000);
  });
});
