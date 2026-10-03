import type { EvidenceEnvelope } from '../evidence/evidence-envelope.js';
import { validateGroundedClaims } from '../evidence/grounding-validator.js';
import { isUsageQuotaPassthroughError } from '../llm/relay-failover.js';
import { emitSanitizedEvent } from '../observability/events.js';
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
 */
export const createGroundedResponseWithRetry = async (
  text: string,
  evidence: EvidenceEnvelope,
  options: GroundedRetryOptions = {},
): Promise<GroundedResponse> => {
  const sink = options.sink ?? defaultSink;
  const fallbackSubject = options.fallbackSubject ?? 'esta consulta';
  const sanitized = stripToolCallMarkup(text);
  if (sanitized.removedBlocks > 0) {
    sink('agent.response.tool_call_sanitized', {
      ...(options.intentionId ? { intentionId: options.intentionId } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
      removedBlocks: sanitized.removedBlocks,
    });
  }
  if (sanitized.changed && sanitized.text === '') {
    return { text: renderClarificationFallback(fallbackSubject), grounded: false, rejected: true };
  }
  const first = validateGroundedClaims(sanitized.text, evidence);
  if (first.valid) return { text: sanitized.text, grounded: true, rejected: false };
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
    try {
      const revised = await options.retry(first.unsupportedClaims);
      if (typeof revised === 'string' && revised.trim().length > 0) {
        const revisedSanitized = stripToolCallMarkup(revised);
        if (revisedSanitized.removedBlocks > 0) {
          sink('agent.response.tool_call_sanitized', {
            ...(options.intentionId ? { intentionId: options.intentionId } : {}),
            ...(options.traceId ? { traceId: options.traceId } : {}),
            removedBlocks: revisedSanitized.removedBlocks,
            stage: 'correction_retry',
          });
        }
        if (revisedSanitized.text.trim().length > 0) {
          const second = validateGroundedClaims(revisedSanitized.text, evidence);
          if (second.valid) return { text: revisedSanitized.text, grounded: true, rejected: false };
          sink('agent.grounding.rejected', {
            ...(options.intentionId ? { intentionId: options.intentionId } : {}),
            ...(options.traceId ? { traceId: options.traceId } : {}),
            status: 'rejected_after_retry',
            unsupportedCount: second.unsupportedClaims.length,
          });
          return { text: renderUnavailable(fallbackSubject), grounded: false, rejected: true };
        }
      }
    } catch (error) {
      // Usage-quota gate: a denied/unavailable correction reservation must
      // remain an HTTP quota error — rethrown verbatim, never collapsed
      // into the safe deterministic fallback. Ordinary retry failures are
      // operational: fall through to the safe fallback below.
      if (isUsageQuotaPassthroughError(error)) throw error;
    }
  }
  sink('agent.grounding.rejected', {
    ...(options.intentionId ? { intentionId: options.intentionId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    status: 'rejected',
    unsupportedCount: first.unsupportedClaims.length,
  });
  return { text: renderUnavailable(fallbackSubject), grounded: false, rejected: true };
};
