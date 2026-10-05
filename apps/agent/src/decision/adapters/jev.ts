/**
 * Jev adapter (TypeSafe) — REUSE, not reimplementation.
 *
 * A16 already ships a hardened HTTP boundary in `judgment/provider.ts`: one
 * deadline covering headers AND body, a per-turn budget, a breaker, an operation
 * allowlist and an answer allowlist. Rewriting any of it here would trade proven
 * failure handling for a second implementation of the same idea, so this adapter
 * is a TRANSLATION and nothing more:
 *
 *   neutral `op`  ──▶ Jev `operation`        (`continuation_relation` → `jev_decide`)
 *   question map  ──▶ single `question`      (Jev asks one question at a time)
 *   `state` map   ──▶ serialized `state`     (A16's contract, byte for byte)
 *   Jev `choice`  ──▶ `answers.<name>.value` (+ `confidence` when reported)
 *
 * The vendor vocabulary lives HERE and only here. The domain never sees
 * `jev_decide`, which is what keeps the issue's "Jev adapter does not leak into
 * domain rules" true by construction rather than by convention.
 *
 * `TED_JUDGMENT_ENDPOINT` / `TED_JUDGMENT_ALLOWED_MODELS` are reused unchanged:
 * existing deployments keep working, and this adapter adds no new credential and
 * no new failure mode.
 */
import {
  createJudgmentProvider,
  type JudgmentOperation,
  type JudgmentOutcome,
  type JudgmentRequest,
} from '../../judgment/provider.js';
import {
  decisionAbstained,
  decisionOutcome,
  decisionUnavailable,
  isDecisionConfidence,
  type DecisionOutcome,
  type DecisionQuestion,
  type DecisionRequest,
} from '../contract.js';
import { blank, type DecisionTransport, type DecisionTransportDeps } from '../transport.js';

/** Domain decision point → vendor operation. Closed: nothing else is translated. */
const OPERATION_BY_DECISION_OP: Readonly<Record<string, JudgmentOperation>> = {
  continuation_relation: 'jev_decide',
};

const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  not_configured: 'not_configured',
  operation_not_allowed: 'operation_not_allowed',
  turn_id_required: 'turn_id_required',
  turn_budget_exhausted: 'turn_budget_exhausted',
  circuit_open: 'circuit_open',
};

const ABSTAINED_REASONS: Readonly<Record<string, string>> = {
  timeout: 'timeout',
  unauthorized: 'unauthorized',
  rejected_request: 'rejected_request',
  transport_error: 'transport_error',
  malformed_response: 'malformed_response',
  choice_outside_allowlist: 'value_outside_allowlist',
};

const optionsOf = (question: DecisionQuestion | undefined): string[] | undefined => {
  const options = question?.criteria?.options;
  return Array.isArray(options) ? options.filter((entry): entry is string => typeof entry === 'string') : undefined;
};

/**
 * Jev takes ONE question. A request with none, or with more than one, is not
 * something this dialect can express: it abstains before any egress rather than
 * silently asking about a subset of what the domain asked.
 */
const toJudgmentRequest = (
  request: DecisionRequest,
): { judgment: JudgmentRequest; questionName: string } | { reason: 'unsupported_request' } => {
  const entries = Object.entries(request.questions);
  const first = entries[0];
  if (!first) return { reason: 'unsupported_request' };
  if (entries.length > 1) return { reason: 'unsupported_request' };
  const [questionName, question] = first;
  const operation = OPERATION_BY_DECISION_OP[request.op];
  if (!operation) return { reason: 'unsupported_request' };
  const options = optionsOf(question);
  return {
    judgment: {
      turnId: request.turnId,
      operation,
      state: JSON.stringify(request.state),
      question: question.instructions,
      ...(options !== undefined ? { options } : {}),
    },
    questionName,
  };
};

const fromJudgmentOutcome = (outcome: JudgmentOutcome, questionName: string): DecisionOutcome => {
  if (outcome.status === 'decision') {
    // The REUSED boundary only admits a finite number, but finite is not the same
    // as a probability: `confidence: 100` must be refused HERE, at the reader,
    // so a misreported certainty cannot travel attached to a valid choice. The
    // central policy re-checks it; this is the adapter refusing to launder it.
    if (outcome.confidence !== undefined && !isDecisionConfidence(outcome.confidence)) {
      return decisionAbstained('jev', 'malformed_response');
    }
    const confidence = outcome.confidence;
    return decisionOutcome(
      'jev',
      { [questionName]: { value: outcome.choice, ...(confidence !== undefined ? { confidence } : {}) } },
      confidence,
      // Provider prose stays in `detail`: it is never read as a value and never
      // reaches an event field (the wiring maps reason/status/choice only).
      outcome.rationale,
    );
  }
  const mapped = outcome.status === 'unavailable' ? UNAVAILABLE_REASONS[outcome.reason] : ABSTAINED_REASONS[outcome.reason];
  return outcome.status === 'unavailable'
    ? decisionUnavailable('jev', mapped ?? 'transport_error')
    : decisionAbstained('jev', mapped ?? 'transport_error');
};

export const createJevTransport = (deps: DecisionTransportDeps = {}): DecisionTransport => {
  const env = deps.env ?? {};
  const boundary = createJudgmentProvider({
    // A16's own env surface, unchanged. The decision layer adds no credential.
    env: { TED_JUDGMENT_ENDPOINT: env.TED_JUDGMENT_ENDPOINT, TED_JUDGMENT_ALLOWED_MODELS: env.TED_JUDGMENT_ALLOWED_MODELS },
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return {
    name: 'jev',
    available: boundary.available,
    // Breaker identity follows A16's endpoint|model key: two deployments of the
    // same provider must not share (or reset) each other's circuit.
    configKey: `jev|${blank(env.TED_JUDGMENT_ENDPOINT)}|${blank(env.TED_JUDGMENT_ALLOWED_MODELS)}`,
    unavailableReason: 'not_configured',
    call: async (request) => {
      const translated = toJudgmentRequest(request);
      if ('reason' in translated) return decisionAbstained('jev', translated.reason);
      const outcome = await boundary.evaluate(translated.judgment);
      return fromJudgmentOutcome(outcome, translated.questionName);
    },
  };
};
