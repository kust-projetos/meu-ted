import type { EvidenceEnvelope } from '../evidence/evidence-envelope.js';
import { validateGroundedClaims } from '../evidence/grounding-validator.js';
import { isUsageQuotaPassthroughError } from '../llm/relay-failover.js';
import { classifyError, emitSanitizedEvent } from '../observability/events.js';
import { renderClarificationFallback, renderUnavailable } from './deterministic-responses.js';
import { stripToolCallMarkup } from './tool-call-sanitizer.js';

export type GroundedResponse = Readonly<{ text: string; grounded: boolean; rejected: boolean }>;
export type GroundingEventSink = (eventType: string, fields: Record<string, unknown>) => void;

const defaultSink: GroundingEventSink = (eventType, fields) => {
  emitSanitizedEvent(eventType, fields);
};

export const createGroundedResponse = (text: string, evidence: EvidenceEnvelope, fallbackSubject = 'esta consulta'): GroundedResponse => {
  // TEDV3-003 defense #2: neutralize tool-call markup BEFORE grounding.
  const sanitized = stripToolCallMarkup(text);
  if (sanitized.changed && sanitized.text === '') {
    return { text: renderClarificationFallback(fallbackSubject), grounded: false, rejected: true };
  }
  const result = validateGroundedClaims(sanitized.text, evidence);
  return result.valid ? { text: sanitized.text, grounded: true, rejected: false } : { text: renderUnavailable(fallbackSubject), grounded: false, rejected: true };
};

export type GroundedRetryOptions = Readonly<{
  fallbackSubject?: string;
  /** ONE structured correction retry: called with the unsupported claims, returns revised text or null. */
  retry?: (unsupportedClaims: readonly string[]) => Promise<string | null>;
  sink?: GroundingEventSink;
  intentionId?: string;
  traceId?: string;
  /**
   * A19-GROUND-EVIDENCE: admitted attachment support for READ narration.
   * Server-side attachment-extracted texts ONLY (never typed text, never
   * client input). Passed through to BOTH validation attempts, so a
   * correction retry citing the block is not rejected for citing it.
   */
  attachmentTexts?: readonly string[];
  /**
   * R10 (AC20): additive hook fired the moment the correction retry is
   * actually invoked, so the caller can charge this attempt against the
   * turn's shared recovery budget. Purely observational — it cannot alter
   * grounding, and the retry itself is still invoked exactly once.
   */
  onRecoveryAttempted?: () => void;
}>;

/**
 * Read-path grounding with ONE structured correction retry. A second
 * failure falls back to a safe deterministic response and emits
 * `agent.grounding.rejected` with allowlisted fields only (counts and
 * sanitized codes — never the raw model text or financial payload).
 *
 * TEDV3-003: model text is sanitized (tool-call markup stripped) BEFORE
 * grounding. A reply that was ONLY markup degrades to the deterministic
 * clarification fallback (`renderClarificationFallback`) — never an empty
 * message, never raw markup — and emits `agent.response.tool_call_sanitized`
 * with counts only.
 *
 * V1-GROUND-OBSERVABILITY: that same pre-existing rejection event now also
 * carries `unsupportedKinds` — the validator's per-axis counts (money /
 * percent / date / name). Numbers only: which axis failed is the operational
 * signal, and a figure or a name must never travel in an event.
 *
 * The REST of the lifecycle is sanitized the same way, through the SAME sink:
 * `agent.grounding.validated` on a published grounded reply (stage
 * `initial` / `correction_retry`), `agent.grounding.correction_attempted`
 * when the ONE retry actually runs (with the counts that drove it),
 * `agent.grounding.correction_completed` with its outcome
 * (`grounded` / `rejected` / `empty`) and latency, and
 * `agent.grounding.correction_failed` with the provider's ERROR CLASS only
 * when an ordinary failure falls the turn back safe. Purely additive
 * telemetry: no extra provider call, exactly one retry, and never a claim
 * text, figure, document text, token or new ID.
 */
export const createGroundedResponseWithRetry = async (
  text: string,
  evidence: EvidenceEnvelope,
  options: GroundedRetryOptions = {},
): Promise<GroundedResponse> => {
  const sink = options.sink ?? defaultSink;
  const fallbackSubject = options.fallbackSubject ?? 'esta consulta';
  // V1-GROUND-OBSERVABILITY: the turn's existing ids (never a new one) ride
  // every grounding event below; absent when the caller supplies none.
  const ids = {
    ...(options.intentionId ? { intentionId: options.intentionId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
  };
  const sanitized = stripToolCallMarkup(text);
  if (sanitized.removedBlocks > 0) {
    sink('agent.response.tool_call_sanitized', {
      ...ids,
      removedBlocks: sanitized.removedBlocks,
    });
  }
  if (sanitized.changed && sanitized.text === '') {
    return { text: renderClarificationFallback(fallbackSubject), grounded: false, rejected: true };
  }
  const first = validateGroundedClaims(sanitized.text, evidence, options.attachmentTexts ?? []);
  if (first.valid) {
    sink('agent.grounding.validated', { ...ids, stage: 'initial' });
    return { text: sanitized.text, grounded: true, rejected: false };
  }
  if (options.retry) {
    // R10: the retry is about to run — charge it to the turn's budget before
    // awaiting, so a quota denial still counts as the attempt. The hook is
    // PURELY OBSERVATIONAL: it lives in its own try/catch so it can neither
    // skip the retry nor be mistaken for a denial the retry itself raised.
    try {
      options.onRecoveryAttempted?.();
    } catch {
      /* Observational only: never affects grounding. */
    }
    // Sanitized lifecycle: the ONE retry is actually running, carrying the
    // per-axis counts that drove it. Purely observational — it adds no call
    // and cannot change grounding.
    sink('agent.grounding.correction_attempted', { ...ids, unsupportedKinds: first.counts });
    const correctionStartedAt = Date.now();
    try {
      const revised = await options.retry(first.unsupportedClaims);
      if (typeof revised === 'string' && revised.trim().length > 0) {
        const revisedSanitized = stripToolCallMarkup(revised);
        if (revisedSanitized.removedBlocks > 0) {
          sink('agent.response.tool_call_sanitized', {
            ...ids,
            removedBlocks: revisedSanitized.removedBlocks,
            stage: 'correction_retry',
          });
        }
        if (revisedSanitized.text.trim().length > 0) {
          const second = validateGroundedClaims(revisedSanitized.text, evidence, options.attachmentTexts ?? []);
          sink('agent.grounding.correction_completed', {
            ...ids,
            outcome: second.valid ? 'grounded' : 'rejected',
            latencyMs: Date.now() - correctionStartedAt,
          });
          if (second.valid) {
            sink('agent.grounding.validated', { ...ids, stage: 'correction_retry' });
            return { text: revisedSanitized.text, grounded: true, rejected: false };
          }
          sink('agent.grounding.rejected', {
            ...ids,
            status: 'rejected_after_retry',
            unsupportedCount: second.unsupportedClaims.length,
            unsupportedKinds: second.counts,
          });
          return { text: renderUnavailable(fallbackSubject), grounded: false, rejected: true };
        }
      }
      // The retry ran but produced NO usable revision (nothing returned, or
      // markup that sanitized away): an outcome the operator must observe
      // before the turn falls back safe below.
      sink('agent.grounding.correction_completed', {
        ...ids,
        outcome: 'empty',
        latencyMs: Date.now() - correctionStartedAt,
      });
    } catch (error) {
      // Usage-quota gate: a denied/unavailable correction reservation must
      // remain an HTTP quota error — rethrown verbatim, never collapsed
      // into the safe deterministic fallback. Ordinary retry failures are
      // operational: fall through to the safe fallback below.
      if (isUsageQuotaPassthroughError(error)) throw error;
      // Sanitized operational signal for the otherwise-silent fallback path:
      // ERROR CLASS only — the raw message can carry model text or a figure —
      // plus the retry latency. A usage-quota denial is NOT duplicated here;
      // it is rethrown above and surfaced verbatim by the HTTP layer.
      sink('agent.grounding.correction_failed', {
        ...ids,
        errorClass: classifyError(error),
        latencyMs: Date.now() - correctionStartedAt,
      });
    }
  }
  sink('agent.grounding.rejected', {
    ...ids,
    status: 'rejected',
    unsupportedCount: first.unsupportedClaims.length,
    unsupportedKinds: first.counts,
  });
  return { text: renderUnavailable(fallbackSubject), grounded: false, rejected: true };
};
