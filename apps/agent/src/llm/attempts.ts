import { failoverReasonOf, isRetryableLlmError } from './failover.js';

/**
 * H-02: unified LLM attempts executor.
 *
 * Direct (`onChatMessage` → AI SDK), buffered (`/rpc/chat` → relay HTTP)
 * and broker (Codex) legs all funnel through `executeLlmAttempts`, which:
 * - resolves the CONCRETE upstream pair (provider id + bare model name,
 *   never a configuration row id) for primary and fallback;
 * - runs at most ONE primary + ONE distinct fallback attempt per turn;
 * - retries the fallback ONLY on retryable failures (timeout, 429/5xx via
 *   `isRetryableLlmError` — 401/403 NUNCA fazem fallback, unificado com o
 *   relay em FIX-189);
 * - throws a sanitized composite error (reason codes only, never prompts,
 *   transcripts or secrets) when both legs fail.
 *
 * The retired legacy turn queue performs no upstream model invocation
 * (default processor echoes), so there are no legacy attempts to unify —
 * every real inference flows through this executor.
 */

export type LlmAttemptTarget = {
  providerId: string;
  modelName: string;
};

export type AttemptSnapshot = {
  provider_id: string;
  model_id: string;
  model_name?: string | null;
  fallback_provider_id?: string | null;
  fallback_model_id?: string | null;
  fallback_model_name?: string | null;
};

/**
 * Resolves the executable upstream name or null. A stored name wins;
 * otherwise only the conventional `provider_id:` prefix is derivable.
 * Anything else is an opaque row id — returning it as the bare model would
 * send a configuration key to the provider, so callers must fail closed
 * (refetch, never execute with the row id).
 */
export const resolveBareModelName = (
  providerId: string,
  modelId: string,
  storedName?: string | null,
): string | null => {
  if (typeof storedName === 'string' && storedName.length > 0) return storedName;
  const prefix = `${providerId}:`;
  if (modelId.startsWith(prefix) && modelId.length > prefix.length) {
    return modelId.slice(prefix.length);
  }
  return null;
};

/**
 * Codex (plano Coding) executes through the private broker (browser-session
 * auth), never through a direct endpoint. The snapshot only carries the
 * provider id, so routing is by id convention — any provider id containing
 * `codex` resolves to the broker leg.
 */
export const isCodexProviderId = (providerId: string): boolean =>
  providerId.toLowerCase().includes('codex');

export type ResolvedAttemptTargets = {
  primary: LlmAttemptTarget | null;
  fallback: LlmAttemptTarget | null;
};

export const resolveAttemptTargets = (snapshot: AttemptSnapshot): ResolvedAttemptTargets => {
  const primaryName = resolveBareModelName(snapshot.provider_id, snapshot.model_id, snapshot.model_name);
  const primary: LlmAttemptTarget | null = primaryName
    ? { providerId: snapshot.provider_id, modelName: primaryName }
    : null;
  let fallback: LlmAttemptTarget | null = null;
  if (snapshot.fallback_provider_id && snapshot.fallback_model_id) {
    const fallbackName = resolveBareModelName(
      snapshot.fallback_provider_id,
      snapshot.fallback_model_id,
      snapshot.fallback_model_name,
    );
    if (fallbackName) {
      const candidate: LlmAttemptTarget = {
        providerId: snapshot.fallback_provider_id,
        modelName: fallbackName,
      };
      // A fallback identical to the primary is not a second attempt —
      // executing it would double-spend without new signal (see M-01).
      if (!primary || candidate.providerId !== primary.providerId || candidate.modelName !== primary.modelName) {
        fallback = candidate;
      }
    }
  }
  return { primary, fallback };
};

export type LlmAttemptsError = Error & {
  code: 'agent.provider_not_configured' | 'agent.inference_error';
  status: number;
  primaryReason: string;
  fallbackReason: string | null;
};

const attemptsError = (
  code: LlmAttemptsError['code'],
  status: number,
  message: string,
  primaryReason: string,
  fallbackReason: string | null,
): LlmAttemptsError =>
  Object.assign(new Error(message), { code, status, primaryReason, fallbackReason });

export type LlmAttemptsOutcome<T> = {
  result: T;
  usedFallback: boolean;
  failoverReason: string | null;
  primary: LlmAttemptTarget;
  fallback: LlmAttemptTarget | null;
};

export const executeLlmAttempts = async <T>(opts: {
  snapshot: AttemptSnapshot;
  intentionId: string;
  runLeg: (target: LlmAttemptTarget, attempt: 'primary' | 'fallback') => Promise<T>;
}): Promise<LlmAttemptsOutcome<T>> => {
  const { primary, fallback } = resolveAttemptTargets(opts.snapshot);
  if (!primary) {
    throw attemptsError(
      'agent.provider_not_configured',
      503,
      'TED ready: provider not configured',
      'unresolvable_model',
      null,
    );
  }
  try {
    const result = await opts.runLeg(primary, 'primary');
    return { result, usedFallback: false, failoverReason: null, primary, fallback };
  } catch (primaryErr) {
    const primaryReason = failoverReasonOf(primaryErr);
    if (!fallback || !isRetryableLlmError(primaryErr)) throw primaryErr;
    try {
      const result = await opts.runLeg(fallback, 'fallback');
      return { result, usedFallback: true, failoverReason: primaryReason, primary, fallback };
    } catch (fallbackErr) {
      const fallbackReason = failoverReasonOf(fallbackErr);
      throw attemptsError(
        'agent.inference_error',
        502,
        `Falha na inferência (primário: ${primaryReason}; fallback: ${fallbackReason}).`,
        primaryReason,
        fallbackReason,
      );
    }
  }
};
