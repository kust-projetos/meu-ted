// Etapa C turn diagnostics — bounded, safe, observation-only slice.
//
// Emits structured technical events for gateway → SDK call/prompt/history →
// provider terminal result. Every event carries ONLY the strict allow-list
// schema: fixed event name, timestamps + duration, a fresh runtime-generated
// opaque UUID (correlationId), fixed phase/outcome/cause enums, and an
// optional bounded numeric httpStatus. It NEVER carries raw error/message/
// stack, prompt/assistant/text payload, credentials/tokens/cookies,
// URLs/hosts, model/provider configuration strings, or user/workspace/
// session/conversation/intention IDs.
//
// Properties (contract):
// - Correlation: `randomUUID()` generated fresh per gateway request (per
//   turn) and reused across that turn's gateway/SDK events — via the
//   `diagnosticCorrelationId` threading (prompt/history methods) or the
//   wrapper's per-call context. Never derived from conversation/session/
//   user/workspace/intention/message IDs; never returned in public DTOs.
// - Sink: injectable `(event) => void` for tests; default logs exactly one
//   structured JSON line per event via console.error (stderr — stdout stays
//   reserved for the main.mjs CLI control-JSON protocol). Sink failures are
//   swallowed — logging can never change success/error behavior.
// - Classification: ONLY from observable evidence (typed error codes +
//   explicit poll-observed `details.outputBegan` + bounded numeric
//   statusCode). Evidence rules (pinned SDK 2.2.4):
//     * `prompt.history_overflow` is a LOCAL read bound, NOT a proved
//       persistence failure → `history_bound_local` (never
//       `persistence_history_read`).
//     * Finance/API transport failures (`tool.*`, `gateway.*` upstream with
//       a bounded status) are labeled `finance_upstream_error` with the
//       finance origin phase — NEVER `http_status` (provider HTTP status is
//       hidden by the SDK; `http_status`/`connection_dns_tls`/
//       `protocol_sse_parsing` stay reserved-unreachable and any untyped or
//       physically undescribed failure stays `not_proven`).
//     * Stream interruption after output began is distinguished ONLY when
//       the poll loop itself observed assistant text before the terminal
//       `finish:'error'` marker (surfaced as `details.outputBegan` on the
//       thrown error) — never inferred by the classifier caller.
// - Semantics preserved: exactly one inner call per wrapped method (no
//   retry/fallback), the ORIGINAL error is rethrown unchanged (never
//   converts failure to success), and no second native prompt is issued.

import { randomUUID } from 'node:crypto';

export const DIAG_EVENT = 'ted.turn_diagnostic';

export const DIAG_PHASES = Object.freeze([
  'gateway_admit',
  'sdk_prompt',
  'history_poll',
  'finance_tool_call',
  'terminal_result',
]);

export const DIAG_OUTCOMES = Object.freeze(['success', 'failure']);

export const DIAG_CAUSES = Object.freeze([
  'none',
  'config_provider_resolution',
  'connection_dns_tls',
  'timeout',
  'http_status',
  'protocol_sse_parsing',
  'stream_interrupted_after_output',
  'provider_transport_opaque',
  'persistence_history_read',
  'finance_upstream_error',
  'history_bound_local',
  'not_proven',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueCorrelationId(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

function toIso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function boundedHttpStatus(v) {
  if (typeof v !== 'number' || !Number.isInteger(v)) return undefined;
  if (v < 100 || v > 599) return undefined;
  return v;
}

function extractHttpStatus(err) {
  if (!err || typeof err !== 'object') return undefined;
  const d = err.details;
  if (d && typeof d === 'object' && typeof d.statusCode === 'number') {
    return boundedHttpStatus(d.statusCode);
  }
  if (typeof err.statusCode === 'number') return boundedHttpStatus(err.statusCode);
  return undefined;
}

// Origin phase from the typed-code prefix: finance/API transport (`tool.*`)
// and gateway authority fetch (`gateway.*`) are provably NOT the provider
// transport, so they carry their own phase and never `http_status`.
function originPhase(code) {
  if (typeof code !== 'string') return 'sdk_prompt';
  if (code.startsWith('tool.')) return 'finance_tool_call';
  if (code.startsWith('gateway.')) return 'gateway_admit';
  if (code.startsWith('history.')) return 'history_poll';
  return 'sdk_prompt';
}

// Classify ONLY from observable evidence. `outputBegan` is read from
// `err.details.outputBegan` — set ONLY by the poll loop that actually
// observed assistant text before the terminal marker. Callers never pass it.
export function classifyTerminalCause(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const httpStatus = extractHttpStatus(err);
  const outputBegan = !!(err && err.details && err.details.outputBegan === true);

  if (code === 'provider.transport') {
    if (outputBegan) {
      return { cause: 'stream_interrupted_after_output', phase: 'terminal_result', httpStatus: undefined };
    }
    return { cause: 'provider_transport_opaque', phase: 'terminal_result', httpStatus: undefined };
  }
  if (code === 'provider.unavailable' || code === 'provider.denied') {
    return { cause: 'config_provider_resolution', phase: 'sdk_prompt', httpStatus: undefined };
  }
  if (code === 'gateway.timeout' || code === 'prompt.timeout' || code === 'tool.timeout') {
    return { cause: 'timeout', phase: originPhase(code), httpStatus: undefined };
  }
  // REVIEW-FIX 1: the local prompt wait deadline fired with no output. The
  // poll loop sets `details.deadlineExceeded` ONLY on that exact path, so
  // this maps an observed runtime timeout — the physical provider cause
  // stays NOT_PROVEN (no httpStatus is ever attached here). Strict
  // `=== true`: any other no_output (including forged truthy shapes, which
  // only the poll loop could produce legitimately) stays not_proven.
  if (code === 'prompt.no_output' && !!err && !!err.details && err.details.deadlineExceeded === true) {
    return { cause: 'timeout', phase: 'sdk_prompt', httpStatus: undefined };
  }
  if (code === 'history.unavailable') {
    return { cause: 'persistence_history_read', phase: 'history_poll', httpStatus: undefined };
  }
  if (code === 'prompt.history_overflow') {
    // LOCAL read bound (bounded paging refused to truncate) — not a proved
    // persistence/store failure. Separate cause so dashboards never read a
    // local guard as a storage outage.
    return { cause: 'history_bound_local', phase: 'history_poll', httpStatus: undefined };
  }
  if (code === 'tool.upstream_error' || code === 'gateway.upstream_error') {
    // Finance/API origin (loopback API or finance transport) — but ONLY with
    // a bounded numeric status is it labeled `finance_upstream_error`.
    // Without status evidence (e.g. a store-settle safe error reusing the
    // gateway code) the cause stays not_proven: no status, no guessing.
    if (httpStatus !== undefined) {
      return { cause: 'finance_upstream_error', phase: originPhase(code), httpStatus };
    }
    return { cause: 'not_proven', phase: originPhase(code), httpStatus: undefined };
  }
  // Everything else (prompt.failed, prompt.no_output, prompt.cancelled,
  // prompt.in_progress, prompt.duplicate, tool.transport/tool.cancelled,
  // gateway.transport, untyped, quarantine/binding guards): physical cause is
  // NOT observable from SDK 2.2.4 history — stay NOT_PROVEN, never guess
  // connection_dns_tls / http_status / protocol_sse_parsing from text
  // (message text is never read here).
  if (code !== null && (code.startsWith('tool.') || code.startsWith('gateway.'))) {
    return { cause: 'not_proven', phase: originPhase(code), httpStatus: undefined };
  }
  return { cause: 'not_proven', phase: code !== null && code.startsWith('history.') ? 'history_poll' : 'sdk_prompt', httpStatus: undefined };
}

// REVIEW-FIX 2: stderr, never stdout. The src/main.mjs CLI stdout carries
// only control JSON lines (startup/shutdown protocol); emitting diagnostics
// to stdout would corrupt that protocol. Sink failures are swallowed —
// logging can never change behavior.
export function defaultDiagnosticSink(event) {
  try {
    console.error(JSON.stringify(event));
  } catch { /* logger failure never changes behavior */ }
}

export function createDiagnosticContext({ sink, now, correlationId } = {}) {
  const id = isOpaqueCorrelationId(correlationId) ? correlationId : randomUUID();
  const startMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const startedAt = toIso(startMs);
  const emitSink = typeof sink === 'function' ? sink : defaultDiagnosticSink;

  function emit({ phase, outcome, cause, httpStatus } = {}) {
    const safePhase = DIAG_PHASES.includes(phase) ? phase : 'sdk_prompt';
    const safeOutcome = DIAG_OUTCOMES.includes(outcome) ? outcome : 'failure';
    const safeCause = DIAG_CAUSES.includes(cause) ? cause : 'not_proven';
    const endMs = Date.now();
    const event = {
      event: DIAG_EVENT,
      correlationId: id,
      startedAt,
      endedAt: toIso(endMs),
      durationMs: Math.max(0, endMs - startMs),
      phase: safePhase,
      outcome: safeOutcome,
      // Success carries the fixed `none` cause (no failure taxonomy on success).
      cause: safeOutcome === 'success' ? 'none' : safeCause,
    };
    const bounded = boundedHttpStatus(httpStatus);
    if (safeOutcome === 'failure' && bounded !== undefined) event.httpStatus = bounded;
    try {
      emitSink(event);
    } catch { /* logger failure never changes behavior */ }
    return event;
  }

  return { correlationId: id, startedAt, emit };
}

// Picks up the per-turn correlation threaded through prompt/history params
// (`diagnosticCorrelationId`) when it is a valid opaque UUID; otherwise the
// context mints a fresh one. Never derives from turn identifiers.
function correlationFromArgs(args) {
  const first = args && args[0];
  if (first && typeof first === 'object' && isOpaqueCorrelationId(first.diagnosticCorrelationId)) {
    return first.diagnosticCorrelationId;
  }
  return undefined;
}

// Observation-only wrapper: exactly one inner call per method, original
// result/error propagated unchanged, exactly one diagnostic event emitted.
export function wrapPromptHostWithDiagnostics(promptHost, { sink, now } = {}) {
  if (!promptHost || typeof promptHost !== 'object') {
    throw new Error('diagnostics: promptHost (object) is required');
  }
  const emitSink = typeof sink === 'function' ? sink : undefined; // undefined → per-turn default sink

  function wrapMethod(name, successPhase) {
    const inner = promptHost[name];
    if (typeof inner !== 'function') return undefined;
    return async (...args) => {
      const ctx = createDiagnosticContext({ sink: emitSink, now, correlationId: correlationFromArgs(args) });
      try {
        const out = await inner(...args);
        ctx.emit({ phase: successPhase, outcome: 'success', cause: 'none' });
        return out;
      } catch (e) {
        const code = e && typeof e.code === 'string' ? e.code : null;
        let classified = classifyTerminalCause(e);
        if ((name === 'readHistory' || name === 'readRawMessages') && classified.cause === 'not_proven') {
          // History-path boundary with no finer evidence: the read itself
          // failed. Binding/quarantine/cancel guards keep their not_proven
          // cause (never restated as a persistence failure) but still carry
          // the history phase so the boundary is visible.
          const guard = code !== null && (
            code === 'host_binding_quarantined' || code === 'session.quarantined' ||
            code === 'prompt.cancelled' || code === 'gateway.cancelled' ||
            code === 'prompt.duplicate' || code === 'prompt.in_progress'
          );
          classified = guard
            ? { cause: 'not_proven', phase: 'history_poll', httpStatus: undefined }
            : { cause: 'persistence_history_read', phase: 'history_poll', httpStatus: undefined };
        }
        ctx.emit({
          phase: classified.phase,
          outcome: 'failure',
          cause: classified.cause,
          httpStatus: classified.httpStatus,
        });
        throw e; // original error unchanged: no code/message rewrite, no retry
      }
    };
  }

  const wrapped = { ...promptHost };
  const chat = wrapMethod('chat', 'terminal_result');
  if (chat) wrapped.chat = chat;
  const readHistory = wrapMethod('readHistory', 'history_poll');
  if (readHistory) wrapped.readHistory = readHistory;
  const readRawMessages = wrapMethod('readRawMessages', 'history_poll');
  if (readRawMessages) wrapped.readRawMessages = readRawMessages;
  return wrapped;
}
