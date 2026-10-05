/**
 * Issue #86 — the decision layer WIRED to one point of decision in the hot path.
 *
 * This module used to be `judgment/wiring.ts`. What changed is the vocabulary,
 * not the behaviour: the domain asks a provider-neutral layer for an advisory
 * tie-break, and the vendor that happens to answer is invisible from here. The
 * guarantees are the ones A16 shipped, kept verbatim in substance:
 *
 * - **A request without financial state.** The consumer describes STRUCTURAL
 *   FACTS of the turn (`ContinuationRelationFacts`), never user text, amount,
 *   date, description, category or account id. The provider sees the SHAPE of a
 *   decision, never anybody's money.
 * - **The deterministic result stays authoritative.** `value` is the
 *   deterministic relation on every path — including when the provider answers
 *   the opposite. A decision only moves `source` (telemetry), never the outcome.
 * - **Abstention and absence are not the orchestrator's doubt.** With no
 *   accessor, or with the layer default-off, the path is the deterministic one
 *   with no network; the wiring does not even ask for a provider the caller does
 *   not have.
 *
 * The wired point is the draft-continuation relation ("correction" | "negation" |
 * "continuation") — a purely BEHAVIOURAL classification still resolved by a
 * deterministic heuristic. Value correction does NOT enter here: that is the
 * revision-guarded financial-write path, and no optional consultation may open a
 * window before it.
 */
import { answerValue, type DecisionOutcome, type DecisionRequest } from './contract.js';
import {
  DECISION_NO_PROVIDER,
  decisionUnavailable,
  resolveWithDecision,
  type DecisionProvider,
  type DecisionResolution,
} from './provider.js';

/** Closed allowlist: the layer picks one of these labels or nothing is accepted. */
export const CONTINUATION_RELATION_CHOICES = ['correction', 'negation', 'continuation'] as const;
export type ContinuationRelationChoice = (typeof CONTINUATION_RELATION_CHOICES)[number];

/** The DOMAIN decision point. Vendor operations live inside the adapters. */
export const CONTINUATION_RELATION_OPERATION = 'continuation_relation';
/** The question this decision point asks. Stable key, so telemetry is stable too. */
export const CONTINUATION_RELATION_QUESTION_KEY = 'relation';

/**
 * Structural facts of the turn. Every field is a SHAPE (state-machine label,
 * count, boolean), never content: a draft with three pending fields becomes
 * `pendingFieldCount: 3`, never the list of field names and values.
 */
export type ContinuationRelationFacts = Readonly<{
  /** Turn key — this is what the one-call-per-turn cap measures. */
  turnId: string;
  /** Draft state label (`active`, `proposing`, ...). */
  draftStatus: string;
  /** How many fields are still missing; NEVER their names or values. */
  pendingFieldCount: number;
  /** The deterministic heuristic found a negation marker. */
  negationMarker: boolean;
  /** What the heuristic decided (the answer that stays authoritative). */
  deterministicRelation: ContinuationRelationChoice;
}>;

/**
 * Fixed question, with no user data in it: the layer classifies the SHAPE of a
 * turn. "advisory" is in the wording because the answer is consumed as a
 * suggestion.
 */
export const CONTINUATION_RELATION_QUESTION =
  'Classifique a relação deste turno com o rascunho ativo (correção, negação ou continuação). A resposta é advisory: ela não altera o resultado do turno.';

/** The request derived from the structural facts — the only place the payload is built. */
export const continuationRelationDecisionRequest = (facts: ContinuationRelationFacts): DecisionRequest => ({
  op: CONTINUATION_RELATION_OPERATION,
  turnId: facts.turnId,
  state: {
    activeDraft: true,
    draftStatus: facts.draftStatus,
    pendingFieldCount: facts.pendingFieldCount,
    negationMarker: facts.negationMarker,
    deterministicRelation: facts.deterministicRelation,
  },
  questions: {
    [CONTINUATION_RELATION_QUESTION_KEY]: {
      type: 'choice',
      instructions: CONTINUATION_RELATION_QUESTION,
      criteria: { options: [...CONTINUATION_RELATION_CHOICES] },
    },
  },
});

/**
 * `not_configured` (no accessor, or no selector env) is the ONLY absence that
 * does not become an event: with the layer default-off the turn must be
 * indistinguishable from the pre-wiring turn, telemetry included.
 */
export const isDecisionDefaultOff = (outcome: DecisionOutcome): boolean =>
  outcome.status === 'unavailable' && outcome.reason === 'not_configured';

/**
 * The complement, read from the PROVIDER rather than from an outcome: a provider
 * the operator CONFIGURED but that cannot work is a rollout mistake, and a
 * rollout mistake nobody can see is indistinguishable from a feature that was
 * never turned on. `provider_not_supported` (a typo) and `binding_missing` (an
 * undeployed binding) are therefore visible; a selected provider missing its own
 * config (`jev` with no endpoint) is visible too, under the same `not_configured`
 * token — the SELECTION is the evidence, which is exactly why this reads the
 * provider name and not only the reason.
 *
 * The default-off posture — nothing selected at all — keeps `provider: 'none'`
 * and stays silent, so the default turn is byte-for-byte the pre-wiring turn.
 */
export const isDecisionMisconfigured = (provider: DecisionProvider): boolean =>
  provider.provider !== DECISION_NO_PROVIDER || (provider.unavailableReason ?? 'not_configured') !== 'not_configured';

/**
 * The advisory label, revalidated against the local allowlist. The layer already
 * rejects a value outside the question's options; the check repeats because here
 * the value is used in TELEMETRY, and an event field cannot carry a free label.
 */
export const advisoryRelation = (outcome: DecisionOutcome): ContinuationRelationChoice | null => {
  const value = answerValue(outcome, CONTINUATION_RELATION_QUESTION_KEY);
  return value !== null && (CONTINUATION_RELATION_CHOICES as readonly string[]).includes(value)
    ? (value as ContinuationRelationChoice)
    : null;
};

/** SANITIZED consult-event fields: enums and booleans, never content. */
export type DecisionConsultFields = Readonly<{
  operation: typeof CONTINUATION_RELATION_OPERATION;
  status: DecisionOutcome['status'];
  source: DecisionResolution<ContinuationRelationChoice>['source'];
  reason?: string;
  choice?: ContinuationRelationChoice;
  deterministicRelation: ContinuationRelationChoice;
}>;

export const decisionConsultFields = (
  resolution: DecisionResolution<ContinuationRelationChoice>,
): DecisionConsultFields => {
  const { decision } = resolution;
  const choice = advisoryRelation(decision);
  const reason = decision.reason;
  return {
    operation: CONTINUATION_RELATION_OPERATION,
    status: decision.status,
    source: resolution.source,
    ...(reason !== undefined ? { reason } : {}),
    ...(choice !== null ? { choice } : {}),
    deterministicRelation: resolution.value,
  };
};

/**
 * Consults the layer as an ADVISORY tie-break. Returns the resolution with
 * `value` = deterministic on EVERY path; a missing accessor is never even read
 * (fail-closed, zero network).
 */
export const resolveContinuationRelation = async (
  deterministic: ContinuationRelationChoice,
  input: { provider?: DecisionProvider | undefined; facts: ContinuationRelationFacts },
): Promise<DecisionResolution<ContinuationRelationChoice>> => {
  if (!input.provider) {
    return {
      value: deterministic,
      source: 'deterministic',
      decision: decisionUnavailable(DECISION_NO_PROVIDER, 'not_configured'),
    };
  }
  return resolveWithDecision(deterministic, {
    provider: input.provider,
    request: continuationRelationDecisionRequest(input.facts),
  });
};

/**
 * The deterministic resolution for a provider that BLEW UP — the accessor threw,
 * or `evaluate` rejected. An adapter with a bug must degrade to the heuristic
 * relation, never become a turn error: the consultation is advisory and bounded,
 * so its failure is indistinguishable in the turn from never having run.
 *
 * The reason is the machine token `provider_error` and NOTHING else. No message,
 * no stack, no provider prose: an adapter bug routinely carries the value that
 * broke it, and this outcome becomes event telemetry.
 */
export const decisionProviderErrorResolution = (
  deterministic: ContinuationRelationChoice,
): DecisionResolution<ContinuationRelationChoice> => ({
  value: deterministic,
  source: 'deterministic',
  decision: decisionUnavailable(DECISION_NO_PROVIDER, 'provider_error'),
});
