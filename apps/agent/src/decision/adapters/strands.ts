/**
 * Strands Decider adapter — self-hosted, Apache-2.0, same dialect.
 *
 * `strands-decider serve --port 8000` exposes `POST /v1/systemone` with the same
 * `{ state, questions }` body as Jev and Clef, which makes it the local/open
 * option the issue asks for. Three properties are enforced here rather than
 * assumed:
 *
 * - **The URL is operator-controlled and complete.** `TED_DECISION_STRANDS_URL`
 *   is an ORIGIN; the path is this adapter's constant. An empty env is
 *   `not_configured`, so an unset URL can never produce a request to nowhere.
 * - **Redirects are NOT followed.** `redirect: 'manual'` means a 30x is a
 *   response we can reject, not a second request to a host the operator never
 *   named. That mirrors the `web_fetch` host allowlist posture for a service the
 *   operator deploys themselves.
 * - **No credential exists in code.** The headers are exactly `content-type` and
 *   `accept`. If this deployment later needs auth, the decision is a secret in
 *   the env plus a rollout gate — not a header baked into a Worker.
 */
import {
  decisionAbstained,
  decisionUnavailable,
  type DecisionOutcome,
  type DecisionRequest,
} from '../contract.js';
import { readCompatibleAnswers } from './compatible-answers.js';
import { blank, type DecisionTransport, type DecisionTransportDeps } from '../transport.js';

export const DECISION_STRANDS_URL_ENV = 'TED_DECISION_STRANDS_URL';
export const STRANDS_SYSTEMONE_PATH = '/v1/systemone';

/** Trailing slashes are normalized so `<url>/` and `<url>` behave identically. */
export const systemOneUrl = (origin: string): string => `${origin.replace(/\/+$/, '')}${STRANDS_SYSTEMONE_PATH}`;

const fromPayload = (payload: unknown, request: DecisionRequest): DecisionOutcome => {
  const read = readCompatibleAnswers(payload, request.questions);
  if ('reason' in read) return decisionAbstained('strands', read.reason);
  const primary = read.answers[read.primary];
  return {
    provider: 'strands',
    status: 'decision',
    answers: read.answers,
    ...(primary?.confidence !== undefined ? { confidence: primary.confidence } : {}),
    advisory: true,
  };
};

export const createStrandsTransport = (deps: DecisionTransportDeps = {}): DecisionTransport => {
  const env = deps.env ?? {};
  const origin = blank(env[DECISION_STRANDS_URL_ENV]);
  const url = origin === '' ? '' : systemOneUrl(origin);
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    name: 'strands',
    available: url !== '',
    configKey: `strands|${url}`,
    unavailableReason: 'not_configured',
    call: async (request, signal) => {
      if (url === '') return decisionUnavailable('strands', 'not_configured');
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ state: JSON.stringify(request.state), questions: request.questions }),
          // Operator-named origin only: never chase a redirect somewhere else.
          redirect: 'manual',
          signal,
        });
      } catch (_error) {
        return decisionAbstained('strands', 'transport_error');
      }

      if (response.status === 401 || response.status === 403) return decisionAbstained('strands', 'unauthorized');
      // 4xx of CONTENT: the answer was refused, which is not the service's health.
      if (response.status === 400 || response.status === 422) return decisionAbstained('strands', 'rejected_request');
      if (!response.ok) return decisionAbstained('strands', 'transport_error');

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (_error) {
        return decisionAbstained('strands', 'malformed_response');
      }
      return fromPayload(payload, request);
    },
  };
};
