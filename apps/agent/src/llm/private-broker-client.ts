export type BrokerClientOptions = {
  brokerOrigin: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  signingKey: string;
  /**
   * Item 6 (Onda 2): per-call budget override. Absent = BROKER_REQUEST_TIMEOUT_MS
   * (reuses the documented 60 s relay/attempt platform budget — the broker has
   * no narrower configured budget of its own).
   */
  timeoutMs?: number;
};

export type BrokerEnvelope = {
  kid: string;
  aud: 'pi-codex-broker';
  timestamp: number;
  nonce: string;
  requestId: string;
  bodySha256: string;
};

import { validateProviderOutput } from '../orchestration/provider-adapter.js';

/**
 * Item 6 (Onda 2): absolute per-call budget for the private broker transport.
 * The broker client has no narrower configured budget of its own, so it reuses
 * the documented platform per-attempt budget (RELAY_ATTEMPT_TIMEOUT_MS, 60 s
 * in `llm/relay-failover.ts`, mirroring the API `requestTimeoutMs`). One
 * deadline covers fetch headers AND body parsing with no reset between them.
 */
export const BROKER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * FIX-AGENT-BROKER-BOUNDED-SAFE-ERRORS: smallest representable budget.
 * Sub-millisecond positive values floor to 0 and are treated as absent
 * (caller gets the safe default) instead of arming a 0 ms timer.
 */
export const BROKER_MIN_TIMEOUT_MS = 1;

/**
 * FIX-AGENT-BROKER-BOUNDED-SAFE-ERRORS: normalize both the per-call
 * override (`opts.timeoutMs`) and the constructor default
 * (`options.timeoutMs`) into one finite positive budget bounded by
 * BROKER_REQUEST_TIMEOUT_MS. Precedence: first finite positive value in
 * `[callMs, optionsMs]` wins (floored, capped at 60 s); anything else —
 * undefined, NaN, Infinity, zero, negative, sub-millisecond, non-number —
 * falls through to the next candidate and finally to the safe default.
 * The value returned here is the exact value armed on the timer and used
 * in the fixed timeout message.
 */
export const resolveBrokerTimeoutMs = (callMs?: number, optionsMs?: number): number => {
  for (const candidate of [callMs, optionsMs]) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) continue;
    const floored = Math.floor(candidate);
    if (!Number.isFinite(floored) || floored < BROKER_MIN_TIMEOUT_MS) continue;
    return Math.min(floored, BROKER_REQUEST_TIMEOUT_MS);
  }
  return BROKER_REQUEST_TIMEOUT_MS;
};

const brokerTimeoutError = (timeoutMs: number): Error & { code: string; status: number } =>
  Object.assign(new Error(`Codex Broker request timed out after ${timeoutMs}ms`), {
    name: 'TimeoutError',
    code: 'agent.provider_timeout',
    status: 504,
  });

/**
 * FIX-W2-AGENT-LATE-RESPONSE-AND-BROKER-ERROR: monotonic clock + safe error
 * mapping. Production default is `performance.now()` (monotonic, bounded);
 * tests may inject a fake clock via `opts.now`. Late headers/body after the
 * absolute deadline fail closed as timeout even when the timer callback has
 * not fired yet. Upstream bodies and network messages are never echoed.
 */
const defaultBrokerMonotonicNow = (): number => {
  try {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (perf && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through to the wall clock below.
  }
  return Date.now();
};

const isBrokerTimeout = (err: unknown): boolean => {
  const e = err as { name?: unknown; code?: unknown } | null;
  return e?.name === 'TimeoutError' || e?.code === 'agent.provider_timeout';
};

const brokerNetworkError = (): Error & { code: string; status: number } =>
  Object.assign(new Error('Codex Broker request failed'), {
    code: 'agent.provider_error',
    status: 502,
  });

const brokerHttpError = (status: number): Error & { code: string; status: number } => {
  const safeStatus =
    Number.isFinite(status) && status >= 400 && status < 600 ? Math.trunc(status) : 502;
  return Object.assign(new Error('Codex Broker request failed'), {
    code: 'agent.provider_error',
    status: safeStatus,
  });
};

/**
 * FIX-AGENT-BROKER-BOUNDED-SAFE-ERRORS: best-effort discard of a late or
 * rejected Response body. Never awaited, never blocks the timeout path:
 * a locked body (cancel throws synchronously) or a rejected cancel
 * promise is swallowed. Keeps the fast-success path untouched — this is
 * only called on timeout / non-2xx discard branches.
 */
const cancelBrokerResponseBody = (res: Response | undefined): void => {
  try {
    const body = (res as { body?: { cancel?: () => unknown } } | undefined)?.body;
    if (!body || typeof body.cancel !== 'function') return;
    const result = body.cancel() as unknown;
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Best effort: a locked body must not block the timeout.
  }
};

const encoder = new TextEncoder();

export const computeSha256 = async (str: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

export const signBrokerEnvelope = async (envelope: BrokerEnvelope, secret: string): Promise<string> => {
  const payload = `${envelope.kid}.${envelope.aud}.${envelope.timestamp}.${envelope.nonce}.${envelope.requestId}.${envelope.bodySha256}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

export const executeBrokerCompletion = async (
  options: BrokerClientOptions,
  payload: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    requestId: string;
    intentionId: string;
    workspaceId: string;
    actorId: string;
  },
  customFetch = fetch,
  opts?: { timeoutMs?: number; now?: () => number },
): Promise<{
  id: string;
  model: string;
  choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> => {
  const rawBody = JSON.stringify(payload);
  const bodySha256 = await computeSha256(rawBody);

  const envelope: BrokerEnvelope = {
    kid: 'agent-worker',
    aud: 'pi-codex-broker',
    timestamp: Date.now(),
    nonce: `nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    requestId: payload.requestId,
    bodySha256,
  };

  const signature = await signBrokerEnvelope(envelope, options.signingKey);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-codex-envelope': JSON.stringify(envelope),
    'x-codex-signature': signature,
  };

  if (options.cfAccessClientId) {
    headers['cf-access-client-id'] = options.cfAccessClientId;
  }
  if (options.cfAccessClientSecret) {
    headers['cf-access-client-secret'] = options.cfAccessClientSecret;
  }

  const url = `${options.brokerOrigin.replace(/\/$/, '')}/v1/chat/completions`;
  // Item 6 (Onda 2): ONE absolute deadline over fetch headers AND body
  // parsing — no timer reset between them. The abort signal is sent at the
  // deadline, and the outer Promise.race forces finite termination even when
  // the fetch implementation or the body parser ignores abort. Late
  // headers/body after the deadline can never become success: besides the
  // race, the monotonic `now()` recheck after each stage fails closed with
  // the same typed timeout even when the event loop delayed the timer
  // callback. Upstream error bodies are never echoed (fixed generic message
  // + safe status/code); network failures are normalized the same way while
  // preserving timeout classification.
  // FIX-AGENT-BROKER-BOUNDED-SAFE-ERRORS: the armed budget is the normalized
  // effective timeout (finite, positive, <= 60 s) — raw Infinity / >60 s /
  // zero / NaN overrides can never reach setTimeout or the message.
  const timeoutMs = resolveBrokerTimeoutMs(opts?.timeoutMs, options.timeoutMs);
  const now = opts?.now ?? defaultBrokerMonotonicNow;
  const start = now();
  const deadlineAt = start + timeoutMs;
  const isExpired = (): boolean => now() >= deadlineAt;
  const controller = new AbortController();
  // FIX-AGENT-BROKER-LATE-HEADERS-CANCEL: timedOut flag + currently seen
  // response, so the deadline path can best-effort cancel the body without
  // awaiting, and a late fetch fulfillment after the race can observe the
  // timeout/expired monotonic clock and discard its own body.
  let timedOut = false;
  let seenResponse: Response | undefined;
  let bodyDiscardAttempted = false;
  const discardBodyOnce = (res: Response | undefined): void => {
    if (bodyDiscardAttempted) return;
    bodyDiscardAttempted = true;
    cancelBrokerResponseBody(res);
  };
  const abortAndDiscard = (res: Response | undefined): void => {
    try {
      controller.abort();
    } catch {
      // Best effort: the race below still enforces the deadline.
    }
    discardBodyOnce(res);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortAndDiscard(seenResponse);
      reject(brokerTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  let res: Response;
  try {
    const fetchPromise = customFetch(url, {
      method: 'POST',
      headers,
      body: rawBody,
      // FIX-AGENT-RELAY-EDGE-REDIRECT: Workers fetch throws TypeError on
      // redirect: 'error' (see model-factory createSafeFetch). 'manual' keeps
      // the no-follow guarantee; the 3xx/opaqueredirect rejection below fails
      // closed before the body is ever processed.
      redirect: 'manual',
      signal: controller.signal,
    });
    // Late headers arriving after the race already settled with the timeout:
    // observe the timeout/expired clock and cancel the late body
    // synchronously (guarded, non-awaited). Late data is never accepted
    // (the race already rejected).
    void Promise.resolve(fetchPromise).then(
      (late) => {
        const lateRes = late as unknown as Response | undefined;
        if (lateRes && typeof lateRes === 'object') seenResponse ??= lateRes;
        // Mark the discard so the post-race expired branch for the SAME
        // late response does not cancel a second time (spy counts); a late
        // body arriving after the race already timed out is still canceled
        // exactly once here.
        if (timedOut || isExpired()) {
          cancelBrokerResponseBody(lateRes);
          bodyDiscardAttempted = true;
        }
      },
      () => {},
    );
    res = await Promise.race([fetchPromise, deadline]);
    seenResponse = res;
    // FIX-AGENT-RELAY-EDGE-REDIRECT: a redirect response (or the opaque
    // redirect workers produce for 'manual' on cross-origin) is rejected
    // outright — never followed, never processed.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new TypeError('redirected request rejected by safe fetch');
    }
  } catch (err) {
    if (timer !== undefined) clearTimeout(timer);
    // FIX-AGENT-BROKER-BOUNDED-SAFE-ERRORS: never rethrow the raw transport
    // error (it may carry upstream secrets/markers in `.message`). Timeout
    // classification — including an AbortError that surfaces after the
    // monotonic deadline — becomes the new fixed-message broker timeout;
    // everything else becomes the fixed safe provider error.
    if (timedOut || isExpired() || isBrokerTimeout(err)) throw brokerTimeoutError(timeoutMs);
    throw brokerNetworkError();
  }
  if (timedOut || isExpired()) {
    if (timer !== undefined) clearTimeout(timer);
    abortAndDiscard(res);
    throw brokerTimeoutError(timeoutMs);
  }

  if (!res.ok) {
    // Fail closed without reading or echoing the arbitrary upstream body
    // (it may carry prompt/system/secret/CRLF markers or injection).
    if (timer !== undefined) clearTimeout(timer);
    discardBodyOnce(res);
    if (timedOut || isExpired()) throw brokerTimeoutError(timeoutMs);
    throw brokerHttpError(res.status);
  }

  let decoded: unknown;
  try {
    decoded = await Promise.race([res.json(), deadline]);
  } catch (err) {
    if (timer !== undefined) clearTimeout(timer);
    discardBodyOnce(res);
    if (timedOut || isExpired() || isBrokerTimeout(err)) throw brokerTimeoutError(timeoutMs);
    throw Object.assign(new Error('Broker returned invalid output'), { code: 'agent.invalid_provider_output', status: 502 });
  }
  if (timedOut || isExpired()) {
    if (timer !== undefined) clearTimeout(timer);
    abortAndDiscard(res);
    throw brokerTimeoutError(timeoutMs);
  }
  if (timer !== undefined) clearTimeout(timer);
  if (!decoded || typeof decoded !== 'object') {
    throw Object.assign(new Error('Broker returned invalid output'), { code: 'agent.invalid_provider_output', status: 502 });
  }
  const completion = decoded as {
    id: string;
    model: string;
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  const content = completion.choices?.[0]?.message?.content;
  // Structured Broker output is validated at this boundary. Plain text is
  // retained for compatibility with the OpenAI completion transport; it is
  // still advisory and never carries mutation authority.
  if (typeof content !== 'string' || !content) {
    throw Object.assign(new Error('Broker returned empty output'), { code: 'agent.invalid_provider_output', status: 502 });
  }
  if (content.trimStart().startsWith('{')) {
    try { validateProviderOutput({ broker: completion }); }
    catch { throw Object.assign(new Error('Broker returned invalid structured output'), { code: 'agent.invalid_provider_output', status: 502 }); }
  }
  // The broker is only a provider transport. The canonical turn is consumed
  // by ConversationOrchestrator before this adapter is invoked; this boundary
  // never grants mutation authority or carries an attestation.
  return completion;
};
