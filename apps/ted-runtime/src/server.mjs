// TED local gateway HTTP listener — P1 product (loopback only).
//
// Documented local-only startup path (source/README for now — package
// manifests are frozen while the lockfile resolves, so no new scripts):
//   node apps/ted-runtime/src/server.mjs  (or import createGatewayServer)
// The listener binds LOOPBACK ONLY (127.0.0.1 / ::1); any non-loopback
// host is refused before listen. The API origin it calls must also be
// loopback (enforced in gateway.mjs). Nothing here dials production.
//
// PWA-facing REST shapes (compat-first, read-only slice):
//   POST /agents/finance-chat-agent/:workspaceId/rpc/chat
//     body { text, intentionId, visibility? } (attachments are PWA→A0
//     refs; B read slice ignores unknown display-only keys? No — unknown
//     body keys fail closed, only {text,intentionId,visibility?} allowed)
//     → { turnId, intentionId, status: 'completed', output } on success only.
//   GET  /agents/finance-chat-agent/:workspaceId/rpc/history
//     → { items: [...] } current PWA history shape (projected from native
//     message history; unknown native shapes skipped, never fabricated).
//   POST /agents/finance-chat-agent/:workspaceId/rpc/session/new
//     body {} | { visibility: 'workspace' | 'private' }
//     → existing renewal DTO { ok:true, sessionId, previousSessionId,
//     messageCount, summarized, visibility? } where sessionId carries the
//     OPAQUE conversationId (never runtimeSessionId) + scoped B cookie.
// No other financial tools or writes exist on this listener.
//
// Per-request pipeline (B only — the proxy owns A0 routing):
//   1. Cookie pin: `agent` (A0) → fail closed (no fallback inside the
//      gateway); invalid/foreign B value → fail closed + clear only the
//      scoped cookie; absent → create/attach a workspace-visible session
//      and set the B cookie.
//   2. resolveGatewayIdentity (cookie + device token + workspace) — every
//      request, before any metadata lookup.
//   3. Store access check (private owner / workspace member), then
//      process-local host rebind, then withTurnLock for chat turns.
//   4. Bounded JSON body (64KB), request timeout, caller abort →
//      session.interrupt via the prompt host. Redirects are never issued
//      or followed here. Errors are typed { code, message } with no
//      secrets, cookies, tokens, or prompt text.

import http from 'node:http';
import {
  CONVERSATION_COOKIE_MAX_AGE,
  ConversationError,
  canAccessConversation,
  clearConversationCookie,
  parseConversationCookie,
  scopedCookiePath,
  serializeConversationCookie,
  validateVisibility,
} from './conversations.mjs';
import { GatewayError } from './gateway.mjs';
import { HISTORY_UNAVAILABLE_MESSAGE, PromptError } from './prompt.mjs';
import {
  classifyTerminalCause,
  createDiagnosticContext,
  defaultDiagnosticSink,
} from './diagnostics.mjs';

export const GATEWAY_BODY_LIMIT_BYTES = 64 * 1024;
export const GATEWAY_REQUEST_TIMEOUT_MS = 30000;

const ROUTE_RE = /^(?:\/api\/agent)?\/agents\/finance-chat-agent\/([^/]+)\/rpc\/(chat|history|session\/new)$/;

export function parseRoute(pathname) {
  const m = ROUTE_RE.exec(String(pathname || ''));
  if (!m) return null;
  let workspaceId = m[1];
  try {
    workspaceId = decodeURIComponent(workspaceId);
  } catch {
    return null;
  }
  if (!workspaceId) return null;
  return { workspaceId, route: m[2] };
}

function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

function readBody(req, limit = GATEWAY_BODY_LIMIT_BYTES, signal = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      // Pause (don't destroy yet): the handler still owes the caller a
      // typed 413 response on this socket; it destroys afterwards.
      try { req.pause(); } catch { /* best effort */ }
      reject(e);
    };
    const onAbort = () => fail(Object.assign(new Error('request cancelled'), { code: 'gateway.cancelled' }));
    if (signal) {
      if (signal.aborted) {
        fail(Object.assign(new Error('request cancelled before body'), { code: 'gateway.cancelled' }));
        return;
      }
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const settle = (fn) => (value) => {
      if (done) return;
      done = true;
      try {
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      } catch { /* settle never fails */ }
      fn(value);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(Object.assign(new Error('body too large'), { code: 'gateway.body_too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (e) => settle(() => reject(e))());
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

// Never write a stale response onto a dead socket: after a client
// disconnect the write would throw (or land nowhere) — skip it and settle.
function sendUnlessClosed(res, status, payload, extraHeaders = {}) {
  try {
    if (res.writableEnded || res.destroyed) return false;
    sendJson(res, status, payload, extraHeaders);
    return true;
  } catch {
    return false;
  }
}

function toStatus(code) {
  if (code === 'auth.session_required' || code === 'auth.device_required') return 401;
  if (code === 'auth.workspace_forbidden' || code === 'conversation.forbidden') return 403;
  if (code === 'conversation.not_found') return 404;
  if (
    code === 'gateway.body_too_large' || code === 'prompt.invalid_args' ||
    code === 'conversation.invalid_args' || code === 'conversation.invalid_visibility' ||
    code === 'gateway.invalid_args' || code === 'gateway.a0_pinned'
  ) return 400;
  if (code === 'prompt.duplicate' || code === 'conversation.runtime_conflict' || code === 'conversation.intention_duplicate' || code === 'prompt.in_progress' || code === 'host_binding_quarantined' || code === 'session.quarantined') return 409;
  if (code === 'prompt.cancelled' || code === 'gateway.cancelled') return 499;
  if (code === 'gateway.timeout' || code === 'prompt.timeout') return 504;
  if (code === 'history.unavailable') return 503;
  return 502;
}

function errorPayload(e) {
  const code = (e && (e.code || e.statusCode)) || 'gateway.upstream_error';
  // History-origin failures always carry the FIXED safe message (P2-R-FIX2):
  // the typed error's message may embed raw native SDK text (defense in
  // depth — the prompt adapter already sanitizes, but the gateway never
  // trusts an error message on this path).
  if (code === 'history.unavailable') {
    return { code, message: HISTORY_UNAVAILABLE_MESSAGE };
  }
  const message = e instanceof GatewayError || e instanceof PromptError || e instanceof ConversationError
    ? String(e.message).slice(0, 300)
    : 'gateway request failed';
  return { code: typeof code === 'string' ? code : 'gateway.upstream_error', message };
}

// History-path normalization (P2-R-FIX2): the history read runs inside the
// serialized safe wrapper, whose failures can be UNTYPED SDK/session errors
// (e.g. a missing native session after the registry lookup) — previously
// surfaced as generic gateway.upstream_error/502, or worse, as a wrong-origin
// prompt.failed/provider.* when a mistyped error crossed the path. Normalize
// everything that is not an explicitly preserved status to a sanitized
// history-origin 503. Preserved: identity/auth (401/403), conversation
// metadata (404/403/409), caller-controlled 400s, duplicate/in-progress +
// quarantine/conflict (409), cancel (499), timeout (504), and the
// history-overflow bound (existing semantics). The chat path is untouched:
// genuine session.prompt failures still surface prompt.failed/502 there.
function normalizeHistoryError(e) {
  const code = e && typeof e.code === 'string' ? e.code : null;
  if (code === 'history.unavailable') return e;
  if (code === 'prompt.history_overflow') return e;
  if (code && (code.startsWith('auth.') || code.startsWith('conversation.'))) return e;
  switch (code) {
    case 'prompt.invalid_args':
    case 'gateway.invalid_args':
    case 'gateway.a0_pinned':
    case 'gateway.body_too_large':
    case 'prompt.duplicate':
    case 'prompt.in_progress':
    case 'prompt.cancelled':
    case 'gateway.cancelled':
    case 'gateway.timeout':
    case 'prompt.timeout':
    case 'host_binding_quarantined':
    case 'session.quarantined':
      return e;
    default:
      return new GatewayError('history.unavailable', HISTORY_UNAVAILABLE_MESSAGE);
  }
}

// Seams (all injectable for dependency-free tests):
//   resolveIdentity({ cookie, deviceToken, workspaceId, signal })
//   store: conversation store (create/get/attachRuntime/noteTurn/withTurnLock +
//     intention registry get/claim/settleIntention for cross-restart replay)
//   promptHost: { chat({ sessionID, text, intentionId, signal }), readHistory, readRawMessages }
//   createRuntimeSession(identity, conversationId) -> { runtimeSessionId }
//   withAuthenticatedSession(sessionID, host, fn) -> Promise (REQUIRED —
//     server-only serialized idle-proving wrapper: native session get +
//     controlled host rotation + execute + idle proof + revoke/quarantine on
//     exit. Every native prompt/read/replay runs ONLY inside it, after
//     identity + metadata checks, before any native session use. Raw oc and
//     binding APIs are never exposed and never called directly here.)
//   bindAuthenticatedSession (optional legacy — never used for native work;
//     kept only so older constructions like src/main.mjs boot instead of
//     throwing at startup; any B native use without the wrapper below fails
//     closed at request time, never silently via the unsafe rebind)
//   isSecureOrigin({ origin, forwardedProto }) -> boolean
//   diagnosticsSink(event) -> void (optional): injectable Etapa C-WIRE
//     observation sink. Defaults to one structured JSON line per event on
//     stdout. Sink failures never alter results or errors.
export function createGatewayServer({
  resolveIdentity,
  store,
  promptHost,
  createRuntimeSession,
  bindAuthenticatedSession = null,
  withAuthenticatedSession = null,
  isSecureOrigin = () => false,
  requestTimeoutMs = GATEWAY_REQUEST_TIMEOUT_MS,
  diagnosticsSink = defaultDiagnosticSink,
} = {}) {
  if (typeof resolveIdentity !== 'function') throw new Error('gateway server: resolveIdentity is required');
  if (!store || typeof store.get !== 'function') throw new Error('gateway server: conversation store is required');
  if (!promptHost || typeof promptHost.chat !== 'function') throw new Error('gateway server: promptHost.chat is required');
  if (typeof createRuntimeSession !== 'function') throw new Error('gateway server: createRuntimeSession is required');
  void bindAuthenticatedSession; // legacy seam: accepted, never invoked (unsafe path retired)
  const hasSafeWrapper = typeof withAuthenticatedSession === 'function';
  function requireSafeWrapper() {
    if (!hasSafeWrapper) {
      throw new GatewayError('gateway.upstream_error', 'safe session wrapper missing — failing closed until the entrypoint passes withAuthenticatedSession');
    }
    return withAuthenticatedSession;
  }

  // Server-side tool host: built ONLY from the verified gateway identity +
  // the presented device credential (transport material, never a client
  // claim). Never crosses HTTP — it goes straight into the private rebind.
  function buildHost({ identity, deviceToken }) {
    if (!identity || typeof identity.actorId !== 'string' || typeof identity.deviceId !== 'string') {
      throw new GatewayError('gateway.invalid_args', 'verified identity is required to build the tool host');
    }
    if (typeof deviceToken !== 'string' || deviceToken.length === 0) {
      throw new GatewayError('auth.device_required', 'device credential is required for the tool host (never anonymous)');
    }
    return Object.freeze({
      label: 'ted-gateway',
      token: deviceToken,
      household: identity.workspace,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    });
  }

  // Rebuilds a completed turn from NATIVE history only — never from a
  // transcript store (none exists). Prefers exact id correlation via
  // readRawMessages + assistantTextAfterAdmitted when both are available;
  // falls back to matching the settled turnId inside projected history.
  // Returns null when nothing correlatable is observable (caller fails
  // closed 409 instead of issuing a second prompt).
  async function replayCompletedIntention(record, existing, diagnosticCorrelationId) {
    const runtimeSessionId = record && record.runtimeSessionId;
    if (!runtimeSessionId) return null;
    if (existing && typeof existing.userMessageId === 'string' && promptHost && typeof promptHost.readRawMessages === 'function') {
      try {
        const { assistantTextAfterAdmitted } = await import('./prompt.mjs');
        const rows = await promptHost.readRawMessages({ sessionID: runtimeSessionId, diagnosticCorrelationId });
        const found = assistantTextAfterAdmitted(rows, existing.userMessageId);
        if (found && typeof found.text === 'string' && found.text.trim().length > 0) {
          return { turnId: found.turnId ?? existing.turnId, output: found.text };
        }
      } catch { /* fall through to turnId match */ }
    }
    if (existing && typeof existing.turnId === 'string' && promptHost && typeof promptHost.readHistory === 'function') {
      const items = await promptHost.readHistory({ sessionID: runtimeSessionId, ownerActor: record.ownerActor, diagnosticCorrelationId });
      const hit = Array.isArray(items) ? items.find((it) => it && it.id === existing.turnId) : null;
      if (hit && typeof hit.content === 'string' && hit.content.length > 0) {
        return { turnId: hit.id, output: hit.content };
      }
    }
    return null;
  }

  // Server-side host builder (ordering proof): runs AFTER identity +
  // metadata and BEFORE any native use, inside the serialized wrapper below.
  // The host is built from the verified gateway identity + the presented
  // device credential (transport material, never browser-supplied fields).
  function verifiedHostFor(identity, deviceToken) {
    return buildHost({ identity, deviceToken });
  }

  async function handleChat({ workspaceId, body, cookieHeader, identity, pin, resHeaders, signal, deviceToken }) {
    if (!body || typeof body.text !== 'string' || body.text.trim().length === 0) {
      const e = new GatewayError('prompt.invalid_args', 'chat text (non-empty) is required');
      return { status: toStatus(e.code), payload: errorPayload(e) };
    }
    if (typeof body.intentionId !== 'string' || body.intentionId.length === 0) {
      const e = new GatewayError('prompt.invalid_args', 'stable intentionId is required');
      return { status: toStatus(e.code), payload: errorPayload(e) };
    }
    const allowed = new Set(['text', 'intentionId', 'visibility']);
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) {
        const e = new GatewayError('prompt.invalid_args', `unknown chat field '${k}' — refused`);
        return { status: toStatus(e.code), payload: errorPayload(e) };
      }
    }

    let record;
    let previousSessionId = null;
    if (pin.pin === 'b') {
      try {
        record = store.get(pin.conversationId, identity);
      } catch (e) {
        const status = e.code === 'conversation.forbidden' ? 403 : 404;
        return {
          status,
          payload: errorPayload(e),
          clearCookie: true,
        };
      }
      previousSessionId = record.conversationId;
      if (body.visibility !== undefined) {
        try {
          validateVisibility(body.visibility);
        } catch (e) {
          return { status: toStatus(e.code), payload: errorPayload(e) };
        }
        // Visibility is immutable per conversation in P1: a mismatched
        // request fails closed rather than silently re-scoping the pin.
        if (body.visibility !== record.visibility) {
          const e = new GatewayError('conversation.invalid_visibility', 'visibility mismatch for this conversation — open a new session to change scope');
          return { status: 409, payload: errorPayload(e) };
        }
      }
    } else {
      // No cookie: lost-cookie retry FIRST (durable first-writer-wins index).
      // When the first B response (incl. Set-Cookie) is lost, the browser
      // retries the same PWA intentionId with no pin. Minting a second
      // conversation here would allow a second native prompt for one
      // intention — so resolve the first conversation and let the lock below
      // replay from native history or fail closed 409; never a second prompt.
      // The index is routing only (IDs); authorization still runs through
      // store.get + canAccessConversation below.
      const retryConversationId = (store && typeof store.findConversationForRetry === 'function')
        ? store.findConversationForRetry({ workspace: identity.workspace, ownerActor: identity.actorId, intentionId: body.intentionId })
        : null;
      if (retryConversationId) {
        try {
          record = store.get(retryConversationId, identity);
        } catch (e) {
          const status = e.code === 'conversation.forbidden' ? 403 : 404;
          return { status, payload: errorPayload(e) };
        }
        if (body.visibility !== undefined && body.visibility !== record.visibility) {
          const e = new GatewayError('conversation.invalid_visibility', 'visibility mismatch for this conversation — open a new session to change scope');
          return { status: 409, payload: errorPayload(e) };
        }
      } else {
        // No cookie + B selected: create a workspace-visible session. An
        // explicit `private` request at chat time creates it private.
        const visibility = body.visibility === undefined ? 'workspace' : validateVisibility(body.visibility);
        record = store.create({
          workspace: identity.workspace,
          ownerActor: identity.actorId,
          deviceId: identity.deviceId,
          visibility,
        });
        // Record the first writer SYNCHRONOUSLY (no awaits between index
        // check and this write): a concurrent lost-cookie retry resolves to
        // this same conversation instead of minting a second session.
        if (store && typeof store.recordIntentionOwner === 'function') {
          store.recordIntentionOwner({
            workspace: identity.workspace,
            ownerActor: identity.actorId,
            intentionId: body.intentionId,
            conversationId: record.conversationId,
          });
        }
        // Authenticated re-read before any native handle exists: proves the
        // fresh pin satisfies the same visibility predicate the B path enforces
        // (identity → metadata → rebind → prompt on every turn).
        record = store.get(record.conversationId, identity);
      }
    }

    if (!canAccessConversation(record, identity)) {
      const e = new GatewayError('conversation.forbidden', 'conversation not visible to this identity');
      return { status: 403, payload: errorPayload(e), clearCookie: pin.pin === 'b' };
    }

    // Rebind the process-local tool host ONLY after the checks above, and
    // serialize the turn so the binding cannot race across identities.
    // Cross-restart replay: the prompt host's seen-set is process-local,
    // so the persisted intention registry (ids/status only) is consulted
    // FIRST inside the lock — a completed intention replays from native
    // history (or fails closed 409) WITHOUT a second native prompt.
    // Etapa C-WIRE turn diagnostics: one fresh opaque correlation per
    // admitted chat request, reused across this turn's gateway/SDK events
    // (admit here, SDK prompt/history inside the lock, finish below). The
    // correlation is runtime-generated — never derived from turn
    // identifiers and never returned in the public DTO. Duplicate/
    // in-progress/completed-replay outcomes classify as not_proven: the
    // guard decision itself carries no physical transport evidence.
    const turnDiag = createDiagnosticContext({ sink: diagnosticsSink });
    const turnCorrelationId = turnDiag.correlationId;
    turnDiag.emit({ phase: 'gateway_admit', outcome: 'success', cause: 'none' });
    const outcome = await store.withTurnLock(record.conversationId, async () => {
      const hasIntentions = store && typeof store.getIntention === 'function'
        && typeof store.claimIntention === 'function'
        && typeof store.settleIntention === 'function';
      if (hasIntentions) {
        // Cross-conversation replay guard: the durable first-writer-wins
        // index may already bind this (workspace, actor, intentionId) to a
        // DIFFERENT authorized conversation (stale B pin, cookie transition
        // after /session/new). That retry must fail closed here — before any
        // per-conversation claim, native session access, rebind, or prompt —
        // with a generic code that leaks no metadata about the owner.
        if (typeof store.findConversationForRetry === 'function') {
          const ownerConversationId = store.findConversationForRetry({
            workspace: identity.workspace,
            ownerActor: identity.actorId,
            intentionId: body.intentionId,
          });
          if (typeof ownerConversationId === 'string' && ownerConversationId !== record.conversationId) {
            const dup = new GatewayError('prompt.duplicate', 'intention already submitted in another conversation — retry with the original pin, never a second prompt');
            dup.code = 'prompt.duplicate';
            throw dup;
          }
        }
        const existing = store.getIntention(record.conversationId, body.intentionId);
        // Actor-scoped intention idempotency: the intention author is fixed
        // at the atomic initial claim. A different actor reusing the same
        // intentionId on this shared conversation — or an entry without an
        // author (pre-author claims) — fails closed HERE, before the
        // completed/pending status branch and before any runtime session
        // attach, history read, rebind, or prompt. Generic code/message:
        // no author ids, no body/output, no turn metadata, no status oracle.
        if (existing && (typeof existing.actorId !== 'string' || existing.actorId.length === 0 || existing.actorId !== identity.actorId)) {
          const dup = new GatewayError('prompt.duplicate', 'intention already claimed — retry reuses native history, never a second prompt');
          dup.code = 'prompt.duplicate';
          throw dup;
        }
        if (existing && existing.status === 'completed') {
          let runtimeForReplay = record.runtimeSessionId;
          if (!runtimeForReplay) {
            const created = await createRuntimeSession(identity, record.conversationId);
            runtimeForReplay = created.runtimeSessionId;
            record = store.attachRuntime(record.conversationId, runtimeForReplay, identity.actorId);
          }
          const host = verifiedHostFor(identity, deviceToken);
          let replayed = null;
          try {
            replayed = await requireSafeWrapper()(runtimeForReplay, host, async () => {
              return await replayCompletedIntention(record, existing, turnCorrelationId).catch(() => null);
            });
          } catch (wrapperErr) {
            // Idle/quarantine failures propagate (fail closed) — never masked
            // as a duplicate; only a null replay becomes the dup below.
            throw wrapperErr;
          }
          if (replayed) return { ...replayed, __replayed: true };
          const dup = new GatewayError('prompt.duplicate', 'intention already completed — retry reuses native history, never a second prompt');
          dup.code = 'prompt.duplicate';
          throw dup;
        }
        if (existing && existing.status === 'pending') {
          // Admitted-but-incomplete (native prompt accepted, no answer yet):
          // the SAME intentionId retry first re-reads NATIVE history for the
          // admitted turn before answering in_progress — a late assistant
          // completes here (settled completed, exactly one prompt ever), a
          // terminal provider marker surfaces provider.transport, and only a
          // still-missing answer stays in_progress. This path NEVER calls
          // promptHost.chat: no second native prompt is issued on any branch.
          if (typeof existing.userMessageId === 'string' && existing.userMessageId.length > 0) {
            const runtimeForRecovery = record.runtimeSessionId;
            if (runtimeForRecovery) {
              const host = verifiedHostFor(identity, deviceToken);
              let recovered = null;
              try {
                recovered = await requireSafeWrapper()(runtimeForRecovery, host, async () => {
                  try {
                    const { assistantTextAfterAdmitted, isProviderTransportTerminal } = await import('./prompt.mjs');
                    if (!promptHost || typeof promptHost.readRawMessages !== 'function') return null;
                    const rows = await promptHost.readRawMessages({ sessionID: runtimeForRecovery, diagnosticCorrelationId: turnCorrelationId });
                    if (!Array.isArray(rows)) return null;
                    const at = rows.findIndex((m) => m && typeof m === 'object' && m.id === existing.userMessageId);
                    if (at !== -1) {
                      for (const m of rows.slice(at + 1)) {
                        if (!m || typeof m !== 'object') continue;
                        if (m.type === 'user') break; // next turn boundary
                        if (m.type === 'assistant' && isProviderTransportTerminal(m)) {
                          return { __terminal: true };
                        }
                      }
                    }
                    const found = assistantTextAfterAdmitted(rows, existing.userMessageId);
                    if (found && typeof found.text === 'string' && found.text.trim().length > 0) {
                      return { turnId: found.turnId ?? existing.turnId ?? existing.userMessageId, output: found.text };
                    }
                    return null;
                  } catch {
                    // History-read failure means "no assistant provable yet" —
                    // retain pending below (never a 503 here, never a prompt).
                    return null;
                  }
                });
              } catch (wrapperErr) {
                // Idle/quarantine failures propagate (fail closed) — never
                // masked as in_progress; only a null recovery stays pending.
                throw wrapperErr;
              }
              if (recovered && recovered.__terminal) {
                const { PromptError } = await import('./prompt.mjs');
                throw new PromptError('provider.transport', 'provider transport failed — failing closed (no fabricated output)');
              }
              if (recovered && typeof recovered.output === 'string' && recovered.output.length > 0) {
                if (hasIntentions) {
                  // Recovery settle is NOT best-effort: never return success
                  // unless `status:completed` persistence succeeds. On failure
                  // throw a safe error (gateway normalizes to 502) while the
                  // intention stays pending — the SAME id retry re-reads
                  // native history and settles, never a second prompt.
                  try {
                    store.settleIntention(record.conversationId, body.intentionId, {
                      status: 'completed',
                      actorId: identity.actorId,
                      ...(typeof recovered.turnId === 'string' ? { turnId: recovered.turnId } : {}),
                      userMessageId: existing.userMessageId,
                    });
                  } catch {
                    const safe = new GatewayError('gateway.upstream_error', 'recovery settle failed — retry with the same id, no second prompt issued');
                    safe.code = 'gateway.upstream_error';
                    throw safe;
                  }
                }
                record = store.noteTurn(record.conversationId);
                return { turnId: recovered.turnId, output: recovered.output };
              }
            }
            const wait = new GatewayError('prompt.in_progress', 'intention admitted but answer not yet observable — retry with the same id, no second prompt issued');
            wait.code = 'prompt.in_progress';
            throw wait;
          }
          const dup = new GatewayError('prompt.duplicate', 'intention already in progress — duplicate fails closed (no second prompt issued)');
          dup.code = 'prompt.duplicate';
          throw dup;
        }
        try {
          store.claimIntention(record.conversationId, body.intentionId, identity.actorId);
          // Pin the first writer for lost-cookie retries (B-pin first chats
          // reach here; pin-none retries recorded synchronously at create).
          // Idempotent first-wins: a concurrent retry resolves to the same
          // conversation instead of minting a second session.
          if (store && typeof store.recordIntentionOwner === 'function') {
            try {
              store.recordIntentionOwner({
                workspace: identity.workspace,
                ownerActor: identity.actorId,
                intentionId: body.intentionId,
                conversationId: record.conversationId,
              });
            } catch { /* claim already guards; index is best-effort here */ }
          }
        } catch (e) {
          if (e && (e.code === 'conversation.intention_duplicate')) {
            const dup = new GatewayError('prompt.duplicate', 'intention already claimed — retry reuses native history, never a second prompt');
            dup.code = 'prompt.duplicate';
            throw dup;
          }
          throw e;
        }
      }
      let runtimeSessionId = record.runtimeSessionId;
      if (!runtimeSessionId) {
        const created = await createRuntimeSession(identity, record.conversationId);
        runtimeSessionId = created.runtimeSessionId;
        record = store.attachRuntime(record.conversationId, runtimeSessionId, identity.actorId);
      }
      const host = verifiedHostFor(identity, deviceToken);
      let started;
      try {
        started = await requireSafeWrapper()(runtimeSessionId, host, async () => {
          return await promptHost.chat({
            sessionID: runtimeSessionId,
            text: body.text,
            intentionId: body.intentionId,
            signal,
            diagnosticCorrelationId: turnCorrelationId,
          });
        });
      } catch (e) {
        // Admitted-but-incomplete: the prompt host attaches the admitted
        // native id in details (see prompt.mjs failAfterAdmit). Persist it so
        // a retry correlates WITHOUT resubmitting (pending + userMessageId →
        // replay-or-in_progress, never a second prompt).
        const uid = e && e.details && e.details.userMessageId;
        if (hasIntentions && typeof uid === 'string' && uid.length > 0) {
          try {
            store.settleIntention(record.conversationId, body.intentionId, { userMessageId: uid, actorId: identity.actorId });
          } catch { /* settle is best-effort metadata; the error still propagates */ }
        }
        throw e;
      }
      if (hasIntentions) {
        try {
          store.settleIntention(record.conversationId, body.intentionId, {
            status: 'completed',
            actorId: identity.actorId,
            ...(started && typeof started.turnId === 'string' ? { turnId: started.turnId } : {}),
            ...(started && typeof started.userMessageId === 'string' ? { userMessageId: started.userMessageId } : {}),
          });
        } catch {
          // Normal-path settle is NOT best-effort: never report success
          // unless `status:completed` persistence succeeds. Preserve the
          // admitted ids as pending metadata so the SAME intentionId retry
          // re-reads native history (pending-with-userMessageId recovery)
          // instead of falling into permanent prompt.duplicate. The store
          // error text never leaves this block (safe typed error only).
          try {
            store.settleIntention(record.conversationId, body.intentionId, {
              status: 'pending',
              actorId: identity.actorId,
              ...(started && typeof started.userMessageId === 'string' ? { userMessageId: started.userMessageId } : {}),
            });
          } catch { /* fallback is best-effort; the safe error below still propagates */ }
          const safe = new GatewayError('gateway.upstream_error', 'completed settle failed — retry with the same id, no second prompt issued');
          safe.code = 'gateway.upstream_error';
          throw safe;
        }
      }
      record = store.noteTurn(record.conversationId);
      return started;
    }).catch((e) => ({ __error: e }));

    // Turn finish observation: success carries `none`; failures classify
    // from observable evidence only (duplicate/in_progress/completed-replay
    // guards → not_proven — the guard carries no transport evidence).
    if (outcome && outcome.__error) {
      const dc = classifyTerminalCause(outcome.__error);
      turnDiag.emit({ phase: dc.phase, outcome: 'failure', cause: dc.cause, httpStatus: dc.httpStatus });
    } else {
      turnDiag.emit({ phase: 'terminal_result', outcome: 'success', cause: 'none' });
    }

    if (outcome && outcome.__error) {
      const e = outcome.__error;
      // B pin persists even when the turn fails AFTER the native session was
      // allocated: a fresh pin without a cookie would otherwise orphan the
      // server-side binding the failure just created.
      const keepPin = pin.pin === 'b' ? null : (record && record.conversationId ? record.conversationId : null);
      return { status: toStatus(e.code), payload: errorPayload(e), ...(keepPin ? { setCookie: keepPin } : {}) };
    }
    return {
      status: 200,
      payload: { turnId: outcome.turnId, intentionId: body.intentionId, status: 'completed', output: outcome.output },
      setCookie: pin.pin === 'b' ? null : record.conversationId,
      previousSessionId,
    };
  }

  async function handleHistory({ pin, workspaceId, identity, deviceToken }) {
    if (pin.pin !== 'b' && pin.pin !== 'none') {
      const e = new GatewayError('gateway.invalid_args', 'conversation cookie is required for history');
      return { status: 400, payload: errorPayload(e) };
    }
    if (pin.pin === 'none') {
      // First B UI load (TedChat fetches history on mount before any chat
      // or session/new): bootstrap one workspace-visible conversation plus
      // its native session and hand back the scoped B cookie. No prompt is
      // ever issued here — a fresh conversation has no messages, so history
      // is empty by construction. No binding is created: there is no native
      // use yet, so no host is bound (the safe wrapper binds per native use
      // and revokes on exit — no stale host survives).
      let record = store.create({
        workspace: identity.workspace,
        ownerActor: identity.actorId,
        deviceId: identity.deviceId,
        visibility: 'workspace',
      });
      record = store.get(record.conversationId, identity);
      const created = await createRuntimeSession(identity, record.conversationId).catch((e) => ({ __error: e }));
      if (created && created.__error) {
        // Keep the pin anyway: the retry resumes this same conversation
        // (a later chat attaches the session) instead of minting orphans.
        return { status: toStatus(created.__error.code), payload: errorPayload(created.__error), setCookie: record.conversationId };
      }
      record = store.attachRuntime(record.conversationId, created.runtimeSessionId, identity.actorId);
      return { status: 200, payload: { items: [] }, setCookie: record.conversationId };
    }
    let record;
    try {
      record = store.get(pin.conversationId, identity);
    } catch (e) {
      return { status: e.code === 'conversation.forbidden' ? 403 : 404, payload: errorPayload(e), clearCookie: true };
    }
    if (!record.runtimeSessionId) return { status: 200, payload: { items: [] } };
    // Serialized history: the same per-conversation turn lock that guards
    // chat, so a history read can never interleave a concurrent turn's
    // rebinding on this conversation. Lock order is always
    // conversation-outer → session-inner (the wrapper below). A foreign
    // actor never reaches native history (metadata check above failed closed).
    // History observation carries its own fresh opaque correlation (one
    // per history request). The pin-none bootstrap path above performs no
    // native use, so it emits nothing.
    const hdiag = createDiagnosticContext({ sink: diagnosticsSink });
    try {
      const host = verifiedHostFor(identity, deviceToken);
      // Identity correlation + per-author attribution from the persisted
      // intention registry (userMessageId -> PWA intentionId, author
      // actorId — ids only, never native ids beyond the message's own).
      // Unmapped rows fall back to the owner inside the projection.
      const userMeta = {};
      const intentions = record.intentions && typeof record.intentions === 'object' ? record.intentions : {};
      for (const [intentionId, entry] of Object.entries(intentions)) {
        if (entry && typeof entry === 'object' && typeof entry.userMessageId === 'string' && entry.userMessageId.length > 0) {
          userMeta[entry.userMessageId] = { intentionId };
          if (typeof entry.actorId === 'string' && entry.actorId.length > 0) {
            userMeta[entry.userMessageId].actorId = entry.actorId;
          }
        }
      }
      const runtimeSessionId = record.runtimeSessionId;
      hdiag.emit({ phase: 'gateway_admit', outcome: 'success', cause: 'none' });
      const items = await store.withTurnLock(record.conversationId, async () => {
        return await requireSafeWrapper()(runtimeSessionId, host, async () => {
          return await promptHost.readHistory({
            sessionID: runtimeSessionId,
            ownerActor: record.ownerActor,
            userMeta,
            viewerActor: identity.actorId,
            diagnosticCorrelationId: hdiag.correlationId,
          });
        });
      });
      hdiag.emit({ phase: 'terminal_result', outcome: 'success', cause: 'none' });
      return { status: 200, payload: { items } };
    } catch (e) {
      const normalized = normalizeHistoryError(e);
      const hdc = classifyTerminalCause(normalized);
      hdiag.emit({ phase: hdc.phase, outcome: 'failure', cause: hdc.cause, httpStatus: hdc.httpStatus });
      return { status: toStatus(normalized.code), payload: errorPayload(normalized) };
    }
  }

  async function handleSessionNew({ body, workspaceId, identity, previousPin }) {
    const visibility = body && body.visibility !== undefined ? body.visibility : 'workspace';
    try {
      validateVisibility(visibility);
    } catch (e) {
      return { status: toStatus(e.code), payload: errorPayload(e) };
    }
    if (body) {
      for (const k of Object.keys(body)) {
        if (k !== 'visibility') {
          const e = new GatewayError('prompt.invalid_args', `unknown session field '${k}' — refused`);
          return { status: toStatus(e.code), payload: errorPayload(e) };
        }
      }
    }
    // previousSessionId is returned ONLY after the prior B pin passes the
    // same authenticated metadata access check as any B request — a foreign
    // or revoked pin yields null instead of leaking an id.
    let previousSessionId = null;
    if (previousPin && previousPin.pin === 'b') {
      try {
        const prior = store.get(previousPin.conversationId, identity);
        previousSessionId = prior.conversationId;
      } catch {
        previousSessionId = null;
      }
    }
    const record = store.create({
      workspace: identity.workspace,
      ownerActor: identity.actorId,
      deviceId: identity.deviceId,
      visibility,
    });
    const created = await createRuntimeSession(identity, record.conversationId).catch((e) => ({ __error: e }));
    if (created && created.__error) {
      return { status: toStatus(created.__error.code), payload: errorPayload(created.__error) };
    }
    store.attachRuntime(record.conversationId, created.runtimeSessionId, identity.actorId);
    return {
      status: 200,
      payload: {
        ok: true,
        sessionId: record.conversationId,
        previousSessionId,
        messageCount: 0,
        summarized: false,
        ...(visibility === 'private' ? { visibility: 'private' } : {}),
      },
      setCookie: record.conversationId,
    };
  }

  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      // Only the three PWA routes exist; everything else is 404 (no tool,
      // admin, MCP, or write surface on this listener).
      const parsed = parseRoute(url.pathname);
      if (!parsed) {
        sendJson(res, 404, { code: 'gateway.not_found', message: 'unknown route' });
        return;
      }
      const { workspaceId, route } = parsed;
      if (req.headers['x-workspace-id'] !== undefined && req.headers['x-workspace-id'] !== workspaceId) {
        sendJson(res, 400, errorPayload(new GatewayError('gateway.invalid_args', 'path workspace and X-Workspace-Id header disagree')));
        return;
      }

      // Per-request cancellation: one AbortController per request. Abort on
      // caller disconnect (req aborted / socket closed before the response
      // finishes) and on the configured timeout. The signal is passed into
      // identity resolution and the prompt host (which maps abort to a
      // single session.interrupt). Timeout maps to 504 when the socket is
      // still open — req.destroy() is never the timeout action.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* best effort */ }
      }, requestTimeoutMs);
      if (timer.unref) timer.unref();
      const cleanup = () => clearTimeout(timer);
      const abortOnDisconnect = () => {
        try {
          if (!res.writableFinished) controller.abort();
        } catch { /* best effort */ }
      };
      req.on('aborted', abortOnDisconnect);
      res.on('close', () => {
        try {
          if (!res.writableFinished) controller.abort();
        } catch { /* best effort */ }
      });
      const signal = controller.signal;

      try {
        const pin = parseConversationCookie(req.headers.cookie);
        const secure = isSecureOrigin({
          origin: req.headers.origin,
          forwardedProto: req.headers['x-forwarded-proto'],
        });

        // Identity FIRST on every request (B paths), before metadata.
        // A0-sentinel requests fail closed without touching identity or
        // the store: the proxy owns A0 routing, never this gateway.
        if (pin.pin === 'a0' && (route === 'chat' || route === 'history')) {
          sendJson(res, 400, errorPayload(new GatewayError('gateway.a0_pinned', 'conversation is pinned to A0 — this gateway serves B only')));
          cleanup();
          return;
        }
        if (pin.pin === 'invalid' && (route === 'chat' || route === 'history')) {
          sendJson(res, 401, errorPayload(new GatewayError('auth.session_required', 'conversation cookie invalid — revalidate and open a new session')),
            { 'set-cookie': clearConversationCookie(workspaceId) });
          cleanup();
          return;
        }

        const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie.join('; ') : (req.headers.cookie ?? '');
        const deviceToken = Array.isArray(req.headers['x-device-token'])
          ? req.headers['x-device-token'][0]
          : req.headers['x-device-token'];

        let identity;
        try {
          identity = await resolveIdentity({ cookie: cookieHeader, deviceToken, workspaceId, signal });
        } catch (e) {
          sendJson(res, toStatus(e.code), errorPayload(e));
          cleanup();
          return;
        }
        // Path/hint workspace must equal the canonical issued workspace —
        // a path from workspace A never resolves inside workspace B.
        if (identity.workspace !== workspaceId) {
          sendJson(res, 403, errorPayload(new GatewayError('auth.workspace_forbidden', 'path workspace disagrees with canonical workspace')));
          cleanup();
          return;
        }

        const extraHeaders = {};
        const maybeCookie = (conversationId) => {
          if (conversationId) {
            extraHeaders['set-cookie'] = serializeConversationCookie(workspaceId, conversationId, { secure });
          }
        };
        const maybeClear = () => {
          extraHeaders['set-cookie'] = clearConversationCookie(workspaceId);
        };

        if (route === 'chat') {
          if (req.method !== 'POST') {
            sendJson(res, 405, errorPayload(new GatewayError('gateway.invalid_args', 'chat requires POST')));
            cleanup();
            return;
          }
          let raw;
          try {
            raw = await readBody(req, GATEWAY_BODY_LIMIT_BYTES, signal);
          } catch (e) {
            if (e && e.code === 'gateway.cancelled') {
              // Client gone mid-body: nothing to answer, never a stale write.
              cleanup();
              return;
            }
            sendJson(res, 413, errorPayload(new GatewayError('gateway.body_too_large', 'request body too large')));
            cleanup();
            return;
          }
          let body;
          try {
            body = raw.length === 0 ? null : JSON.parse(raw);
          } catch {
            sendJson(res, 400, errorPayload(new GatewayError('gateway.invalid_args', 'chat body must be JSON')));
            cleanup();
            return;
          }
          // Timeout race: the prompt stub may ignore the abort signal, so the
          // gateway still answers 504 on a usable socket instead of hanging.
          const timeoutPromise = new Promise((resolve) => {
            const t = setTimeout(() => resolve({ __timeout: true }), requestTimeoutMs);
            if (t.unref) t.unref();
            signal.addEventListener('abort', () => { clearTimeout(t); resolve({ __aborted: true }); }, { once: true });
          });
          const out = await Promise.race([
            handleChat({ workspaceId, body, cookieHeader, identity, pin, resHeaders: extraHeaders, signal, deviceToken }),
            timeoutPromise,
          ]);
          if ((out && out.__timeout) || timedOut) {
            if (!res.writableFinished) {
              sendJson(res, 504, errorPayload(new GatewayError('gateway.timeout', 'gateway request timed out')), extraHeaders);
            }
            cleanup();
            return;
          }
          if (out && out.__aborted) {
            // Aborted without a typed outcome yet (client gone): stop here.
            cleanup();
            return;
          }
          if (out.setCookie) maybeCookie(out.setCookie);
          if (out.clearCookie) maybeClear();
          sendUnlessClosed(res, out.status, out.payload, extraHeaders);
          cleanup();
          return;
        }

        if (route === 'history') {
          if (req.method !== 'GET') {
            sendJson(res, 405, errorPayload(new GatewayError('gateway.invalid_args', 'history requires GET')));
            cleanup();
            return;
          }
          const out = await handleHistory({ pin, workspaceId, identity, deviceToken });
          if (out.setCookie) maybeCookie(out.setCookie);
          if (out.clearCookie) maybeClear();
          sendUnlessClosed(res, out.status, out.payload, extraHeaders);
          cleanup();
          return;
        }

        // session/new
        if (req.method !== 'POST') {
          sendJson(res, 405, errorPayload(new GatewayError('gateway.invalid_args', 'session/new requires POST')));
          cleanup();
          return;
        }
        let rawNew = '';
        try {
          rawNew = await readBody(req, GATEWAY_BODY_LIMIT_BYTES, signal);
        } catch (e) {
          if (e && e.code === 'gateway.cancelled') {
            cleanup();
            return;
          }
          sendJson(res, 413, errorPayload(new GatewayError('gateway.body_too_large', 'request body too large')));
          cleanup();
          return;
        }
        let bodyNew = {};
        try {
          bodyNew = rawNew.length === 0 ? {} : JSON.parse(rawNew);
        } catch {
          sendJson(res, 400, errorPayload(new GatewayError('gateway.invalid_args', 'session/new body must be JSON')));
          cleanup();
          return;
        }
        const out = await handleSessionNew({ body: bodyNew, workspaceId, identity, previousPin: pin });
        if (out.setCookie) maybeCookie(out.setCookie);
        sendUnlessClosed(res, out.status, out.payload, extraHeaders);
        cleanup();
      } catch (e) {
        try {
          sendJson(res, toStatus(e && e.code), errorPayload(e));
        } catch { /* last resort */ }
      }
    })().catch(() => {
      try {
        sendJson(res, 502, { code: 'gateway.upstream_error', message: 'gateway request failed' });
      } catch { /* last resort */ }
    });
  });

  return {
    server,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (!isLoopbackHost(host)) {
        throw new GatewayError('gateway.invalid_origin', `gateway listener refuses non-loopback host '${host}'`);
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      return { host: addr.address, port: addr.port, maxAge: CONVERSATION_COOKIE_MAX_AGE, path: scopedCookiePath };
    },
    async close() {
      // Destroy keep-alive sockets first: plain close() waits for idle
      // connections (node fetch keeps them alive) and would hang the
      // process. Order: stop accepting, destroy sockets, then close.
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch { /* best effort */ }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
