/**
 * Issue #86 — the PROVIDER-NEUTRAL decision contract.
 *
 * A16 shipped a working advisory boundary around Jev (TypeSafe). The ecosystem
 * moved: Cloudflare published Clef (2026-10-01) as a drop-in Jev-compatible model
 * on the native Workers AI binding, and AWS published Strands Decider 2B
 * (Apache-2.0, self-hosted) exposing the very same `{ state, questions }` body.
 * Hard-wiring the agent to Jev would buy nothing but vendor coupling, so Jev
 * becomes ONE adapter behind this contract.
 *
 * What the contract deliberately does NOT have:
 * - **No authorization surface.** There is no field here that can express a
 *   permission, an approval, a capability or a write. That is the structural form
 *   of the issue's "no write can be authorized by DecisionProvider": the type
 *   system cannot carry authority, so no consumer can read it even by mistake.
 *   `tests/decision-contract.test.ts` guards the absence against future edits.
 * - **No financial state.** `state` accepts scalars only, and the caller decides
 *   what goes in it. `decision/wiring.ts` feeds structural facts (draft status,
 *   pending-field COUNT, a negation boolean); amounts, dates, descriptions,
 *   category labels and account ids never enter this shape.
 * - **No method surface.** One method, `evaluate`. Provider-specific vocabularies
 *   (`noul`, `choice`, `score`) live in the QUESTION TYPE, which is data, not
 *   behaviour.
 *
 * Every outcome is `advisory: true` as a LITERAL, so a consumer that reads an
 * answer has it type-checked as a suggestion. The deterministic path stays
 * authoritative in `resolveWithDecision` regardless of what `status` says.
 */

/** Jev-compatible question kinds. Data, not behaviour: adapters translate them. */
export const DECISION_QUESTION_TYPES = ['noul', 'choice', 'score'] as const;
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

/**
 * Closed operation allowlist at the NEUTRAL layer.
 *
 * The domain declares which decision points may consult a model; anything else is
 * `operation_not_allowed` before a transport exists. Deliberately vendor-free:
 * `jev_decide` is what the JEV ADAPTER maps `continuation_relation` to, and it
 * never appears in domain vocabulary.
 */
export const DECISION_ALLOWED_OPERATIONS = ['continuation_relation'] as const;
export type DecisionOperation = (typeof DECISION_ALLOWED_OPERATIONS)[number];

/** Scalars only — a nested object here would be an invitation to smuggle content. */
export type DecisionStateValue = string | number | boolean;
export type DecisionCriteriaValue = string | number | boolean | readonly string[];

export type DecisionQuestion = Readonly<{
  type: DecisionQuestionType;
  instructions: string;
  /**
   * Typed hints for the question kind: `choice` carries its `options`, `score`
   * its `levels`. Kept as scalars or a string list so a choice allowlist cannot
   * become a free-form payload.
   */
  criteria?: Readonly<Record<string, DecisionCriteriaValue>>;
}>;

export type DecisionRequest = Readonly<{
  /** Domain decision point (`continuation_relation`), NOT a provider operation. */
  op: DecisionOperation | (string & {});
  state: Readonly<Record<string, DecisionStateValue>>;
  questions: Readonly<Record<string, DecisionQuestion>>;
  /** The turn that consumes the call — this is what the one-call-per-turn cap measures. */
  turnId: string;
}>;

/**
 * One typed answer. `value` is what the question asked for (a choice label, a
 * yes/no, a score level). `confidence` is the provider's own probability for
 * THIS answer and may be absent — absence is never treated as certainty.
 */
export type DecisionAnswer = Readonly<{ value: string; confidence?: number }>;

/**
 * A probability is a FINITE number in [0,1] — nothing else.
 *
 * This is the single definition every reader and every policy path shares, so
 * `noul: 2`, `confidence: 100`, `-1` and `NaN` can never be read as a
 * probability. A number outside the range is not a low confidence (the answer is
 * simply wrong about its own certainty); it is a malformed answer.
 */
export const isDecisionConfidence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export const DECISION_OUTCOME_STATUSES = ['decision', 'abstained', 'unavailable'] as const;
export type DecisionOutcomeStatus = (typeof DECISION_OUTCOME_STATUSES)[number];

/**
 * The single outcome record. Three statuses, one shape:
 * - `unavailable` — nothing was consulted (default-off, budget, open circuit);
 * - `abstained` — a provider answered and the answer was not usable (timeout,
 *   refusal, malformed, below-threshold confidence);
 * - `decision` — a typed answer exists, and it is still only a suggestion.
 *
 * `reason` is a machine token for telemetry; `detail` is human prose for the
 * turn log. Neither is ever a value a consumer branches on — `answerValue` is
 * the only reader, and it returns `null` for everything but `decision`.
 */
export type DecisionOutcome = Readonly<{
  provider: string;
  status: DecisionOutcomeStatus;
  answers?: Readonly<Record<string, DecisionAnswer>>;
  /** Aggregate confidence of the primary answer; absent when the provider reports none. */
  confidence?: number;
  reason?: string;
  /** Literal `true` on every status: a suggestion can never become authority. */
  advisory: true;
  detail?: string;
}>;

export const isAdvisoryOutcome = (outcome: DecisionOutcome): boolean => outcome.advisory === true;

/** `unavailable`: nothing was consulted. Never carries an answer. */
export const decisionUnavailable = (provider: string, reason: string): DecisionOutcome => ({
  provider,
  status: 'unavailable',
  reason,
  advisory: true,
});

/** `abstained`: something was consulted and the answer was not usable. */
export const decisionAbstained = (provider: string, reason: string, detail?: string): DecisionOutcome => ({
  provider,
  status: 'abstained',
  reason,
  advisory: true,
  ...(detail !== undefined ? { detail } : {}),
});

/** `decision`: a typed answer exists. `confidence` stays ABSENT when unknown. */
export const decisionOutcome = (
  provider: string,
  answers: Readonly<Record<string, DecisionAnswer>>,
  confidence?: number,
  detail?: string,
): DecisionOutcome => ({
  provider,
  status: 'decision',
  answers,
  ...(confidence !== undefined ? { confidence } : {}),
  advisory: true,
  ...(detail !== undefined ? { detail } : {}),
});

/**
 * Reads ONE typed answer. The only sanctioned way to consume an outcome: it
 * ignores `reason`, `detail`, extra keys and unknown question names, so a
 * provider cannot smuggle meaning through prose — and, because the contract has
 * no authorization field, it cannot smuggle authority either.
 */
export const answerValue = (outcome: DecisionOutcome, question: string): string | null => {
  if (outcome.status !== 'decision') return null;
  const value = outcome.answers?.[question]?.value;
  return typeof value === 'string' && value !== '' ? value : null;
};

/** Same reader for the provider-reported probability of that answer. */
export const answerConfidence = (outcome: DecisionOutcome, question: string): number | null => {
  if (outcome.status !== 'decision') return null;
  const confidence = outcome.answers?.[question]?.confidence ?? outcome.confidence;
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null;
};
