/**
 * Issue #86 — the TRANSPORT seam: what an adapter owes the general layer.
 *
 * An adapter translates one provider dialect in and out of the neutral contract.
 * It does NOT own the ceilings: the deadline, the one-call-per-turn budget, the
 * breaker and the confidence policy are decided once, in `provider.ts`, so a new
 * adapter cannot quietly ship a 30-second timeout or an unbounded retry.
 *
 * `call` receives an `AbortSignal` that the general layer arms for the WHOLE
 * attempt. An adapter whose transport cannot be cancelled (the Workers AI
 * binding) may ignore it — the turn is still bounded, the in-flight call is not,
 * and that residual is documented rather than hidden.
 */

import type { DecisionOutcome, DecisionRequest } from './contract.js';

/** Why nothing was consulted. Machine tokens only — telemetry must stay bounded. */
export const DECISION_UNAVAILABLE_REASONS = [
  'not_configured',
  'provider_not_supported',
  'binding_missing',
  'operation_not_allowed',
  'turn_id_required',
  'turn_budget_exhausted',
  'circuit_open',
  /** The adapter itself failed (it threw). Sanitized: no message, no stack. */
  'provider_error',
] as const;
export type DecisionUnavailableReason = (typeof DECISION_UNAVAILABLE_REASONS)[number];

/** Why a consulted provider's answer was not usable. */
export const DECISION_ABSTAINED_REASONS = [
  'timeout',
  'unauthorized',
  'rejected_request',
  'transport_error',
  'malformed_response',
  'value_outside_allowlist',
  'low_confidence',
  'unsupported_request',
] as const;
export type DecisionAbstainedReason = (typeof DECISION_ABSTAINED_REASONS)[number];

/**
 * Reasons that describe CONTENT, not provider health. A refused payload or a
 * below-threshold answer must never open the breaker: one tenant's rejected
 * content cannot switch the layer off for everyone else (A16 rule, preserved).
 *
 * `value_outside_allowlist` is deliberately ABSENT. A16's boundary — the one the
 * Jev adapter reuses — counts an answer the question never offered as provider
 * illness, and an unusable answer IS evidence that the provider is not answering
 * the question it was asked. Counting it here keeps the breaker meaning ONE
 * thing in both layers; without that, the Jev path opened a circuit internally
 * while these counters reported a closed breaker.
 */
export const DECISION_CONTENT_REJECTION_REASONS: readonly string[] = [
  'rejected_request',
  'low_confidence',
  'unsupported_request',
];

export type DecisionTransport = Readonly<{
  /** Provider name as it appears in telemetry and in the outcome. */
  name: string;
  /** false ⇒ the layer answers `unavailable` without touching the transport. */
  available: boolean;
  /** Breaker identity: per provider AND per configuration. */
  configKey: string;
  /** Why `available` is false, when the adapter knows (fail-closed precision). */
  unavailableReason?: DecisionUnavailableReason;
  call: (request: DecisionRequest, signal: AbortSignal) => Promise<DecisionOutcome>;
}>;

/**
 * Env surface of the layer. Every field is optional: an absent `env` is the
 * default-off posture, not an error.
 *
 * The Workers AI binding is declared structurally (like the optional R2 bucket)
 * so this program keeps its current `types` with no workers-types dependency.
 * Adding the `AI` binding to `wrangler.jsonc` is a ROLLOUT step and is
 * deliberately not part of this change.
 */
export type DecisionEnv = Readonly<{
  /** `jev` | `clef` | `strands`. Absent, blank or `none` ⇒ default-off. */
  TED_DECISION_PROVIDER?: string;
  /** Probability floor for an answer to be usable. Default 0.7. */
  TED_DECISION_MIN_CONFIDENCE?: string;
  /** Clef model id. Default `@cf/cloudflare/clef`. */
  TED_DECISION_CLEF_MODEL?: string;
  /** Origin of the self-hosted Strands Decider deployment (no path). */
  TED_DECISION_STRANDS_URL?: string;
  /** Workers AI binding. Absent ⇒ Clef is `binding_missing`, fail-closed. */
  AI?: unknown;
  /** Reused by the Jev adapter — A16's own envs, unchanged. */
  TED_JUDGMENT_ENDPOINT?: string;
  TED_JUDGMENT_ALLOWED_MODELS?: string;
}>;

export type DecisionTransportDeps = Readonly<{
  env?: DecisionEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}>;

export const blank = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');
