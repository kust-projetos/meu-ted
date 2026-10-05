/**
 * Cloudflare Clef adapter — native Workers AI binding, Jev-compatible dialect.
 *
 * Clef (published 2026-10-01) is drop-in compatible with Jev's
 * `{ state, questions } → answers` shape and runs as `env.AI.run(model, input)`
 * inside the Worker: no egress control-plane, no new secret, no HTTP client. The
 * layer therefore never needs to know that Cloudflare exists — it needs a
 * translation and a binding.
 *
 * Two operational facts drive the shape of this file:
 *
 * - **The binding is a rollout step, not code.** `wrangler.jsonc` is untouched
 *   here, so in every environment today `env.AI` is absent and the layer answers
 *   `binding_missing` without a single byte leaving the Worker. That is the
 *   fail-closed posture the issue asks for, and it is also why `AI` is declared
 *   structurally instead of importing workers-types.
 * - **`AI.run` cannot be cancelled.** The general layer still arms a deadline for
 *   the attempt, so the TURN is bounded; a call already in flight when the
 *   deadline fires keeps running. This is the same "deadline is an event, not a
 *   CPU control" residual the PDF extractor documents, and the only mitigation
 *   that actually works is the work cap: one consultation per turn.
 */
import {
  decisionAbstained,
  decisionUnavailable,
  type DecisionOutcome,
  type DecisionRequest,
} from '../contract.js';
import { readCompatibleAnswers } from './compatible-answers.js';
import { blank, type DecisionTransport, type DecisionTransportDeps } from '../transport.js';

export const DECISION_CLEF_MODEL_ENV = 'TED_DECISION_CLEF_MODEL';
/** Default is the full Clef model; the flash variant is an operator rollout choice. */
export const CLEF_DEFAULT_MODEL = '@cf/cloudflare/clef';

/** The minimum of the Workers AI binding — the whole reason this adapter exists. */
export type AiBinding = Readonly<{ run: (model: string, input: unknown) => Promise<unknown> }>;

const readBinding = (value: unknown): AiBinding | null => {
  if (typeof value !== 'object' || value === null) return null;
  const run = (value as { run?: unknown }).run;
  // Bound to the binding instance: the runtime's `run` is a method, not a closure.
  return typeof run === 'function' ? { run: (model, input) => (run as (m: string, i: unknown) => Promise<unknown>).call(value, model, input) } : null;
};

const fromPayload = (payload: unknown, request: DecisionRequest): DecisionOutcome => {
  const read = readCompatibleAnswers(payload, request.questions);
  if ('reason' in read) return decisionAbstained('clef', read.reason);
  const primary = read.answers[read.primary];
  return {
    provider: 'clef',
    status: 'decision',
    answers: read.answers,
    // The aggregate confidence describes the PRIMARY answer only — the one the
    // domain may read. Absent when Clef reported no probability for it.
    ...(primary?.confidence !== undefined ? { confidence: primary.confidence } : {}),
    advisory: true,
  };
};

export const createClefTransport = (deps: DecisionTransportDeps = {}): DecisionTransport => {
  const env = deps.env ?? {};
  const model = blank(env[DECISION_CLEF_MODEL_ENV]) || CLEF_DEFAULT_MODEL;
  const binding = readBinding(env.AI);

  return {
    name: 'clef',
    available: binding !== null,
    configKey: `clef|${model}`,
    // A selected-but-unbound provider is distinguishable from a missing config:
    // the operator learns the binding was not deployed instead of guessing.
    unavailableReason: 'binding_missing',
    call: async (request) => {
      if (!binding) return decisionUnavailable('clef', 'binding_missing');
      try {
        const payload = await binding.run(model, {
          // Same dialect as Jev: state serialized, questions typed and carried
          // as-is, so both providers see byte-identical input for the same turn.
          state: JSON.stringify(request.state),
          questions: request.questions,
        });
        return fromPayload(payload, request);
      } catch (_error) {
        // A throwing binding is a transport failure, never an answer.
        return decisionAbstained('clef', 'transport_error');
      }
    },
  };
};
