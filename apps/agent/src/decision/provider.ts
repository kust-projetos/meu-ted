/**
 * Issue #86 — the GENERAL decision layer: selection, ceilings, policy, resolver.
 *
 * One place decides everything that must NOT vary per provider:
 *
 * - **Selection.** `TED_DECISION_PROVIDER` picks `jev`, `clef` or `strands`.
 *   Absent, blank or `none` builds NO transport at all — the layer then answers
 *   `unavailable` without a fetch call or a binding read, which is what makes the
 *   default-off turn byte-for-byte the pre-issue turn. An unrecognised name fails
 *   closed too (`provider_not_supported`): a typo can never silently disable a
 *   capability the operator believes is on, and can never enable one that is not.
 * - **Ceilings.** 2 s per attempt (A16's measured budget, not the 30 s of a
 *   generic LLM client), ONE consultation per turn, and a breaker keyed per
 *   provider AND configuration. The deadline covers the whole attempt, body
 *   included, so a provider that sends headers and then stalls is a timeout and
 *   not a hung turn.
 * - **Confidence policy.** An answer below `TED_DECISION_MIN_CONFIDENCE` (0.7) is
 *   DROPPED, not downgraded: the typed answer never leaves the layer, so it
 *   cannot be displayed, logged as advice or escalated anywhere. Below the
 *   threshold there is no escalation path to a generative model either — the
 *   caller simply takes the deterministic route it already takes today.
 * - **Deterministic authority.** `resolveWithDecision` returns the deterministic
 *   value on EVERY path. A decision changes `source` (telemetry) and nothing else.
 *
 * The per-turn budget deliberately keeps no eviction window, inherited from A16:
 * forgetting a spent turn is exactly what would hand that turn a second
 * consultation. The state lives in the instance, which is why there is one
 * instance per Durable Object (`decisionProviderForDo`) instead of a module
 * singleton that would leak a workspace's budget into another.
 */
import {
  DECISION_ALLOWED_OPERATIONS,
  decisionAbstained,
  decisionUnavailable,
  isDecisionConfidence,
  type DecisionOutcome,
  type DecisionRequest,
} from './contract.js';
import { createClefTransport } from './adapters/clef.js';
import { createJevTransport } from './adapters/jev.js';
import { createStrandsTransport } from './adapters/strands.js';
import {
  DECISION_CONTENT_REJECTION_REASONS,
  blank,
  type DecisionAbstainedReason,
  type DecisionTransport,
  type DecisionTransportDeps,
  type DecisionUnavailableReason,
  type DecisionEnv,
} from './transport.js';

// The neutral vocabulary is re-exported from here so a consumer of the LAYER never
// has to know which module owns the contract, and adapters stay internal.
export {
  DECISION_ALLOWED_OPERATIONS,
  answerConfidence,
  answerValue,
  decisionAbstained,
  decisionOutcome,
  decisionUnavailable,
  isAdvisoryOutcome,
  isDecisionConfidence,
  type DecisionAnswer,
  type DecisionOperation,
  type DecisionOutcome,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionStateValue,
} from './contract.js';
export { DECISION_ABSTAINED_REASONS, DECISION_UNAVAILABLE_REASONS, type DecisionEnv } from './transport.js';
export type { DecisionAbstainedReason, DecisionUnavailableReason } from './transport.js';

export const DECISION_PROVIDER_ENV = 'TED_DECISION_PROVIDER';
export const DECISION_MIN_CONFIDENCE_ENV = 'TED_DECISION_MIN_CONFIDENCE';
/** Name reported when no provider is selected, so telemetry says "none" not "". */
export const DECISION_NO_PROVIDER = 'none';

export const DECISION_PROVIDERS = ['jev', 'clef', 'strands'] as const;
export type DecisionProviderName = (typeof DECISION_PROVIDERS)[number];

/** A16's measured budget, kept: this is an advisory tie-break, never a critical path. */
export const DECISION_TIMEOUT_MS = 2_000;
export const DECISION_MAX_CALLS_PER_TURN = 1;
export const DECISION_BREAKER_FAILURE_THRESHOLD = 2;
export const DECISION_BREAKER_COOLDOWN_MS = 300_000;
/** Probability floor. A model that cannot clear it has not decided anything. */
export const DECISION_DEFAULT_MIN_CONFIDENCE = 0.7;

/** The one method. `available` lets the hot path stay synchronous when off. */
export type DecisionProvider = Readonly<{
  provider: string;
  /** false = default-off; the caller may take the deterministic path with no await. */
  available: boolean;
  /**
   * WHY nothing can be consulted, read SYNCHRONOUSLY. `not_configured` is the
   * default-off posture and is the only absence a caller may keep silent; the
   * others are rollout mistakes (`provider_not_supported`, `binding_missing`) and
   * exist so a misconfiguration is visible instead of indistinguishable from a
   * feature that was never turned on. Reading it never creates a promise.
   */
  unavailableReason?: DecisionUnavailableReason;
  minConfidence: number;
  evaluate: (request: DecisionRequest) => Promise<DecisionOutcome>;
  stats: () => DecisionStats;
}>;

/** Same five counters as A16, so existing telemetry keeps its shape. */
export type DecisionStats = Readonly<{
  calls: number;
  decisions: number;
  abstentions: number;
  unavailables: number;
  breakerOpens: number;
}>;

type BreakerState = { failures: number; openedAt: number | null; halfOpenUsed: boolean };
export type DecisionBreakerStore = Map<string, BreakerState>;

export type DecisionProviderDeps = DecisionTransportDeps &
  Readonly<{
    timeoutMs?: number;
    minConfidence?: number;
    /** Two instances of the SAME config share one breaker when a store is passed. */
    breakers?: DecisionBreakerStore;
  }>;

const parseProviderName = (raw: string): DecisionProviderName | null =>
  (DECISION_PROVIDERS as readonly string[]).includes(raw) ? (raw as DecisionProviderName) : null;

const createTransport = (name: DecisionProviderName, deps: DecisionTransportDeps): DecisionTransport => {
  if (name === 'jev') return createJevTransport(deps);
  if (name === 'clef') return createClefTransport(deps);
  return createStrandsTransport(deps);
};

/**
 * Invalid or missing values fall back to the DEFAULT threshold rather than to
 * "no threshold": a typo in an env must never widen what the layer accepts.
 */
const parseMinConfidence = (raw: string | undefined, fallback: number): number => {
  const value = blank(raw);
  // A BLANK value is missing, not zero: `Number('')` is 0, which would silently
  // turn "unset" into "accept every answer" — the exact widening a typo causes.
  if (value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

/**
 * The confidence gate, applied in BOTH `evaluate` and `resolveWithDecision`.
 *
 * Applying it twice is deliberate: the resolver must not trust a `DecisionProvider`
 * it did not build, and a provider that returns `status: 'decision'` with no
 * usable confidence gets the same treatment a real one would. There is no path
 * that reads an answer without passing this gate.
 *
 * Two DISTINCT failures, deliberately not merged:
 * - a confidence outside [0,1] (or not a finite number) is a MALFORMED answer.
 *   It is evidence the provider misreports its own certainty, so it counts as
 *   illness for the breaker instead of clearing it as a success would;
 * - an absent or below-threshold confidence is `low_confidence`: the answer is
 *   discarded, but "the model is unsure" is not illness, so it is neither a
 *   breaker success nor a failure.
 */
export const applyConfidencePolicy = (
  outcome: DecisionOutcome,
  minConfidence: number,
): DecisionOutcome => {
  if (outcome.status !== 'decision') return outcome;
  const confidence = outcome.confidence;
  // Present but not a probability (`noul: 2`, `-1`, `NaN`): malformed, dropped.
  if (confidence !== undefined && !isDecisionConfidence(confidence)) {
    return decisionAbstained(outcome.provider, 'malformed_response');
  }
  if (typeof confidence === 'number' && confidence >= minConfidence) return outcome;
  // The answer is DISCARDED: no answers, no confidence, only the typed abstention.
  return decisionAbstained(outcome.provider, 'low_confidence');
};

/**
 * `createDecisionProvider` — the ONLY entry point (issue #86).
 *
 * `available: false` is the Worker's default state today: with no
 * `TED_DECISION_PROVIDER` there is no transport, no network and no binding read.
 */
export const createDecisionProvider = (deps: DecisionProviderDeps = {}): DecisionProvider => {
  const env: DecisionEnv = deps.env ?? {};
  const requested = blank(env[DECISION_PROVIDER_ENV]).toLowerCase();
  const selected = requested === '' || requested === DECISION_NO_PROVIDER ? null : parseProviderName(requested);
  const unsupported = selected === null && requested !== '' && requested !== DECISION_NO_PROVIDER;
  const transport = selected === null ? null : createTransport(selected, deps);

  const available = transport !== null && transport.available;
  const providerName = transport?.name ?? DECISION_NO_PROVIDER;
  // Distinguish "nothing selected" from "selected but not deployed": both are
  // unavailable, and only one of them is a rollout mistake.
  const offReason: DecisionUnavailableReason = unsupported ? 'provider_not_supported' : (transport?.unavailableReason ?? 'not_configured');

  const minConfidence = deps.minConfidence ?? parseMinConfidence(env[DECISION_MIN_CONFIDENCE_ENV], DECISION_DEFAULT_MIN_CONFIDENCE);
  const timeoutMs = deps.timeoutMs ?? DECISION_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const breakers: DecisionBreakerStore = deps.breakers ?? new Map<string, BreakerState>();
  const breakerKey = transport?.configKey ?? `${DECISION_NO_PROVIDER}|${requested}`;

  // One entry per spent turn, never evicted: eviction IS a budget renewal.
  const usedTurns = new Set<string>();
  const counters = { calls: 0, decisions: 0, abstentions: 0, unavailables: 0, breakerOpens: 0 };

  const breakerState = (): BreakerState => {
    const existing = breakers.get(breakerKey);
    if (existing) return existing;
    const created: BreakerState = { failures: 0, openedAt: null, halfOpenUsed: false };
    breakers.set(breakerKey, created);
    return created;
  };

  const settle = (outcome: DecisionOutcome): DecisionOutcome => {
    if (outcome.status === 'decision') counters.decisions += 1;
    else if (outcome.status === 'abstained') counters.abstentions += 1;
    else counters.unavailables += 1;
    return outcome;
  };

  /**
   * A DECISION clears the breaker; a refused CONTENT does not count against it
   * (and releases the half-open probe, so a rejected payload cannot strand the
   * circuit); anything else is a health failure.
   */
  const recordOutcome = (outcome: DecisionOutcome): void => {
    const state = breakerState();
    if (outcome.status === 'decision') {
      state.failures = 0;
      state.openedAt = null;
      state.halfOpenUsed = false;
      return;
    }
    const reason = outcome.reason ?? '';
    if (DECISION_CONTENT_REJECTION_REASONS.includes(reason)) {
      state.halfOpenUsed = false;
      return;
    }
    state.failures += 1;
    if (state.failures >= DECISION_BREAKER_FAILURE_THRESHOLD) {
      if (state.openedAt === null) counters.breakerOpens += 1;
      state.openedAt = now();
      state.halfOpenUsed = false;
    }
  };

  const gateBreaker = (): DecisionOutcome | null => {
    const state = breakerState();
    if (state.openedAt === null) return null;
    if (now() - state.openedAt < DECISION_BREAKER_COOLDOWN_MS) return decisionUnavailable(providerName, 'circuit_open');
    if (state.halfOpenUsed) return decisionUnavailable(providerName, 'circuit_open');
    state.halfOpenUsed = true; // half-open: exactly ONE probe
    return null;
  };

  const consumeTurn = (turnId: string): boolean => {
    if (usedTurns.has(turnId)) return false;
    usedTurns.add(turnId);
    return true;
  };

  const evaluate = async (request: DecisionRequest): Promise<DecisionOutcome> => {
    if (!available || !transport) return settle(decisionUnavailable(providerName, offReason));
    if (!(DECISION_ALLOWED_OPERATIONS as readonly string[]).includes(request.op)) {
      return settle(decisionUnavailable(providerName, 'operation_not_allowed'));
    }
    if (blank(request.turnId) === '') return settle(decisionUnavailable(providerName, 'turn_id_required'));
    if (!consumeTurn(request.turnId)) return settle(decisionUnavailable(providerName, 'turn_budget_exhausted'));
    const blocked = gateBreaker();
    if (blocked) return settle(blocked);

    counters.calls += 1;
    const controller = new AbortController();
    let timedOut = false;
    let handle: ReturnType<typeof setTimeout> | undefined;
    /**
     * ONE deadline for the WHOLE attempt. It stays armed while the body is read
     * and the same signal lives through `json()`, because a provider that answers
     * with headers and then stalls must be a timeout, not a turn that never ends.
     */
    const deadline = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('decision.deadline_exceeded'));
      }, timeoutMs);
    });
    deadline.catch(() => undefined);
    const clearDeadline = (): void => {
      if (handle !== undefined) clearTimeout(handle);
      handle = undefined;
    };
    const timeoutOutcome = (): DecisionOutcome => decisionAbstained(providerName, 'timeout');

    let raw: DecisionOutcome;
    try {
      const attempt = transport.call(request, controller.signal);
      // The race may lose; without this a late rejection would be unhandled.
      attempt.catch(() => undefined);
      raw = await Promise.race([attempt, deadline]);
    } catch (_error) {
      clearDeadline();
      const outcome = timedOut ? timeoutOutcome() : decisionAbstained(providerName, 'transport_error');
      recordOutcome(outcome);
      return settle(outcome);
    }
    clearDeadline();

    // The LAYER's name is authoritative for the outcome, not the transport's: a
    // transport that mislabels itself cannot put another provider's name in
    // telemetry, whatever it returned. (Simple assignment on purpose — there is
    // no divergence to act on here: rejecting a name mismatch would turn a
    // cosmetic mislabel into a lost answer, and the name is already pinned by
    // `transport.name` when the transport is built.)
    const outcome = applyConfidencePolicy({ ...raw, provider: providerName }, minConfidence);
    recordOutcome(outcome);
    return settle(outcome);
  };

  return {
    provider: providerName,
    available,
    // Only meaningful while unavailable: an available provider has no reason, and
    // the adapters declare one unconditionally (Clef says `binding_missing`).
    ...(available ? {} : { unavailableReason: offReason }),
    minConfidence,
    evaluate,
    stats: () => ({ ...counters }),
  };
};

/**
 * ONE instance per Durable Object.
 *
 * The per-turn budget and the breaker are STATE. A per-call factory would renew
 * the budget on every turn and forget an open circuit, making both ceilings
 * decorative. The registry is a `WeakMap` keyed by the DO instance — never a
 * module singleton — so two workspaces never share a budget and the state dies
 * with the DO (rebuilt from zero on recycle, which is the right fail-closed
 * posture: with no history, the provider is simply consulted again).
 */
const PROVIDERS_BY_DO = new WeakMap<object, DecisionProvider>();

export const decisionProviderForDo = (scope: object, deps: DecisionProviderDeps = {}): DecisionProvider => {
  const existing = PROVIDERS_BY_DO.get(scope);
  if (existing) return existing;
  const created = createDecisionProvider(deps);
  PROVIDERS_BY_DO.set(scope, created);
  return created;
};

export type DecisionResolution<T> = Readonly<{
  /** ALWAYS the deterministic value: no decision can grant permission or success. */
  value: T;
  source: 'deterministic' | 'decision_advisory';
  decision: DecisionOutcome;
}>;

/**
 * The unavailable resolution, built SYNCHRONOUSLY.
 *
 * It is the single construction of that outcome, shared by `resolveWithDecision`
 * and by the hot-path caller that must decide whether an unavailable provider is
 * worth an event — which it can only decide without awaiting. The provider's OWN
 * reason travels: collapsing every unavailability into `not_configured` made a
 * typo'd provider name or an undeployed binding indistinguishable from a feature
 * nobody turned on. Absent reason ⇒ the default-off token, which is what a
 * hand-built provider without one means.
 */
export const unavailableResolution = <T>(deterministic: T, provider: DecisionProvider): DecisionResolution<T> => ({
  value: deterministic,
  source: 'deterministic',
  decision: decisionUnavailable(provider.provider, provider.unavailableReason ?? 'not_configured'),
});

/**
 * `resolveWithDecision` — the consumer entry point. The deterministic value is
 * returned on EVERY path — including when the provider answers the opposite,
 * when it answers without a usable confidence, and when it is not configured at
 * all. A decision only moves `source`, which is telemetry.
 */
export const resolveWithDecision = async <T>(
  deterministic: T,
  input: { provider: DecisionProvider; request: DecisionRequest },
): Promise<DecisionResolution<T>> => {
  if (!input.provider.available) return unavailableResolution(deterministic, input.provider);
  const decision = applyConfidencePolicy(await input.provider.evaluate(input.request), input.provider.minConfidence);
  return {
    value: deterministic,
    source: decision.status === 'decision' ? 'decision_advisory' : 'deterministic',
    decision,
  };
};

/** Re-exported so callers can narrow a reason without importing the transport seam. */
export type DecisionAbstainedReasonToken = DecisionAbstainedReason;
