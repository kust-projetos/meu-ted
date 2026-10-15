/**
 * Client command ID lifecycle — V4.1 Tasks 3.8-3.9 (SPEC §10.5).
 *
 * The idempotency key is a per-INTENT command id, not a per-HTTP-attempt id:
 *
 * - created ONCE at the intent boundary (the commands layer stamps it onto
 *   the logical command before the first attempt — Task 3.8);
 * - preserved across retry / timeout / reconnect / unknown response
 *   (Task 3.9): a retryable failure reuses the same id, so the server
 *   replays the original receipt instead of executing a second effect;
 * - a NEW id is minted only after a definitive result or for a new user
 *   intent.
 *
 * Retry policy: network drops, timeouts (ApiError 408 / `network.timeout`)
 * and 5xx are retryable with the same id, as is a 409 carrying
 * `idempotency.in_progress` (same key+payload still claimed — unknown
 * outcome, safe to replay the same key). Definitive 4xx rejections are
 * never blind-retried — including every other 409: domain refusals and
 * `idempotency.conflict` (divergent payload) are surfaced to the caller
 * (existing ApiError handling) instead of being retried. A legitimate
 * replay arrives as a 200 with `replayed:true`, never as a 409.
 */

import { ApiError } from "./client";

/** Bounded automatic-retry budget: initial attempt + one retry, same id. */
export const MAX_COMMAND_ATTEMPTS = 2;

/** Mints a fresh command id (UUID v4 when crypto is available). */
export function newCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `pwa-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Attaches a command id to a logical mutation command. A caller-provided id
 * wins (returned by reference, verbatim); otherwise a shallow copy carrying
 * a fresh id is returned and the caller's object is left untouched — the id
 * belongs to the intent, so re-stamping the same intent object is a no-op.
 */
export function ensureCommandId<T extends object>(
  input: T & { idempotencyKey?: string },
): T & { idempotencyKey: string } {
  if (input.idempotencyKey !== undefined) return input as T & { idempotencyKey: string };
  return { ...input, idempotencyKey: newCommandId() };
}

/**
 * Whether a failed mutation attempt may be retried with the SAME command id.
 * Retryable = unknown outcome (network drop, timeout, 5xx, or a 409 carrying
 * `idempotency.in_progress`): replaying the id is safe because the server
 * dedupes by key. Definitive rejections (any other 4xx — including every
 * other 409: domain refusals and `idempotency.conflict`) and
 * caller-initiated aborts must not be retried.
 *
 * Status takes precedence over code: an explicit 4xx status is definitive
 * regardless of its code (a 409/400 carrying `network.timeout` is still a
 * definitive rejection, never a blind retry) — with the single exception of
 * the authoritative `idempotency.in_progress` code on a 409, which signals
 * an unknown outcome worth replaying. A bare 408 status — or a
 * `network.timeout` code on a response without a definitive 4xx status —
 * likewise signals an unknown outcome worth replaying.
 */
export function isRetryableMutationError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.status === 408) return true;
    // FIX-184: a live `processing` claim owned by another worker
    // (`idempotency.in_progress`) is an unknown outcome — replaying the SAME
    // key is safe (the server dedupes by key). Every other 4xx — including
    // every other 409 — is a definitive rejection, never blind-retried.
    if (err.status === 409 && err.code === "idempotency.in_progress") return true;
    if (err.status >= 400 && err.status <= 499) return false;
    if (err.status >= 500 && err.status <= 599) return true;
    if (err.code === "network.timeout") return true;
    return false;
  }
  if (err instanceof DOMException && err.name === "AbortError") return false;
  return true;
}

/**
 * Authoritative idempotency 409 codes (FIX-184, mirrored from
 * `apps/api/src/writes/errors.ts`):
 *
 * - `idempotency.conflict` — same key, DIVERGENT payload: definitive, never
 *   retried, never converted into success (no receipt exists for this intent);
 * - `idempotency.in_progress` — same key+payload still claimed by another
 *   worker: unknown outcome, retriable with the SAME key (the server replays
 *   the original receipt once the claim settles — legitimate replay arrives
 *   as a 200 with `replayed:true`, never as a 409).
 *
 * Every other 409 (`in_use`, `conflict`, `approval.not_pending`,
 * `workspace.invalid`, `agent.*`, `undo.*`, untyped/generic codes) is a
 * definitive domain refusal — never an idempotency replay. Fail-closed: an
 * unknown or missing code is NOT an idempotency conflict.
 */
const IDEMPOTENCY_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "idempotency.conflict",
  "idempotency.in_progress",
]);

/**
 * Whether the error is an authoritative idempotency signal (FIX-184): a 409
 * carrying an `idempotency.*` code. Any other 409 — domain refusals
 * (`in_use`, `conflict`, `approval.*`, `workspace.invalid`, `agent.*`,
 * `undo.*`) or an untyped/generic code — is a definitive rejection, never a
 * replay signal. Uses `err.code`, never status alone.
 */
export function isIdempotencyConflict(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    IDEMPOTENCY_CONFLICT_CODES.has(err.code)
  );
}

/**
 * Finding 2 — the intent's command id travels on the surfaced error after
 * automatic retries are exhausted. A manual retry after an unknown outcome
 * (committed-but-lost response) reuses it via the input's `idempotencyKey`
 * (or the trailing `CommandIdOptions` on id-only commands), so the server
 * replays the original receipt instead of executing a second effect.
 *
 * Both `commandId` (canonical, matches the input field) and `lastCommandId`
 * aliases are set; readers should prefer {@link getFailedCommandId}.
 */
export function attachCommandId<T>(err: T, commandId: string | undefined): T {
  if (commandId === undefined) return err;
  if (err !== null && (typeof err === "object" || typeof err === "function")) {
    (err as Record<string, unknown>).commandId = commandId;
    (err as Record<string, unknown>).lastCommandId = commandId;
  }
  return err;
}

/**
 * Reads the intent's command id off a failed command error (see
 * {@link attachCommandId}). Returns undefined when the error carries none.
 */
export function getFailedCommandId(err: unknown): string | undefined {
  if (err !== null && (typeof err === "object" || typeof err === "function")) {
    const record = err as Record<string, unknown>;
    const id = record.commandId ?? record.lastCommandId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

export interface RetryCommandOptions {
  /** Reuse an existing intent id instead of minting one. */
  commandId?: string;
  /** Total attempts including the first (default MAX_COMMAND_ATTEMPTS). */
  maxAttempts?: number;
  /** Override for the default retry policy (receives error + 1-based attempt). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

export interface RetryCommandResult<T> {
  result: T;
  commandId: string;
  attempts: number;
}

/**
 * Executes a mutation attempt function, creating the command id ONCE and
 * reusing it on every automatic retry. Stops (no retry) on definitive
 * rejections and definitive idempotency conflicts; gives up after
 * `maxAttempts`, rethrowing the last error so existing error handling
 * (write-error banner, manual retry as a NEW intent) applies unchanged.
 * A legitimate replay arrives as a 200 success, never as an error.
 */
export async function retryMutationWithSameCommandId<T>(
  attempt: (commandId: string) => Promise<T>,
  options: RetryCommandOptions = {},
): Promise<RetryCommandResult<T>> {
  const commandId = options.commandId ?? newCommandId();
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_COMMAND_ATTEMPTS);
  const shouldRetry = options.shouldRetry ?? isRetryableMutationError;

  let lastError: unknown;
  for (let n = 1; n <= maxAttempts; n += 1) {
    try {
      const result = await attempt(commandId);
      return { result, commandId, attempts: n };
    } catch (err) {
      lastError = err;
      // Definitive idempotency refusals (divergent payload, domain 409s) stop
      // immediately; a retriable idempotency signal (`in_progress`, an unknown
      // outcome) still flows through the retry policy below with the same id.
      if (isIdempotencyConflict(err) && !isRetryableMutationError(err))
        throw attachCommandId(err, commandId);
      if (n >= maxAttempts || !shouldRetry(err, n)) throw attachCommandId(err, commandId);
    }
  }
  throw attachCommandId(lastError, commandId);
}
