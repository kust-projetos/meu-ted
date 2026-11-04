// Etapa C diagnostics (TDD RED): structured technical events for
// gateway → SDK call/prompt/history → provider terminal result.
// Contract: fresh opaque UUID correlation per turn, strict allow-list schema,
// injectable sink, logger failure never changes behavior, public codes/statuses
// unchanged, single attempt (no retry, no second intention, no success rewrite).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIAG_CAUSES,
  DIAG_EVENT,
  DIAG_OUTCOMES,
  DIAG_PHASES,
  classifyTerminalCause,
  createDiagnosticContext,
  wrapPromptHostWithDiagnostics,
} from '../src/diagnostics.mjs';

const SECRET = 'fixture-secret-9f2c1a-not-a-real-key OPENCODE_GO_API_KEY=topsecret-body';
const PROMPT_TEXT = 'qual meu saldo de conta-corrente?';

function throwingSink() {
  return () => { throw new Error('sink exploded'); };
}

describe('etapa C diagnostics: correlation + allow-list schema', () => {
  it('emits one allow-listed event per turn with a fresh opaque UUID', async () => {
    const seen = [];
    const inner = {
      chat: async () => ({ turnId: 't-1', output: 'ok', userMessageId: 'u-1' }),
      readHistory: async () => [],
      readRawMessages: async () => [],
    };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: (e) => seen.push(e) });
    const out = await wrapped.chat({ sessionID: 'ses-local-1', text: PROMPT_TEXT, intentionId: 'int-local-1' });
    assert.equal(out.output, 'ok');
    assert.equal(seen.length, 1);
    const evt = seen[0];
    assert.equal(evt.event, DIAG_EVENT);
    assert.match(evt.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Correlation is fresh + opaque: never reuses turn identifiers.
    assert.ok(!['ses-local-1', 'int-local-1', 'u-1', 't-1'].includes(evt.correlationId));
    assert.ok(DIAG_PHASES.includes(evt.phase));
    assert.ok(DIAG_OUTCOMES.includes(evt.outcome));
    assert.ok(DIAG_CAUSES.includes(evt.cause));
    // Strict allow-list: no text, secret, url, model, or turn identifier keys.
    const keys = Object.keys(evt).sort();
    for (const k of keys) {
      assert.ok(
        ['event', 'correlationId', 'startedAt', 'endedAt', 'durationMs', 'phase', 'outcome', 'cause', 'httpStatus'].includes(k),
        `unexpected key ${k}`,
      );
    }
    const raw = JSON.stringify(seen);
    assert.ok(!raw.includes(SECRET));
    assert.ok(!raw.includes(PROMPT_TEXT));
    assert.ok(!raw.includes('int-local-1'));
    assert.ok(!raw.includes('ses-local-1'));
  });

  it('uses a different correlation id on the next turn', async () => {
    const seen = [];
    const inner = { chat: async () => ({ turnId: 't', output: 'ok', userMessageId: 'u' }) };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: (e) => seen.push(e) });
    await wrapped.chat({ sessionID: 's', text: 'a', intentionId: 'i-1' });
    await wrapped.chat({ sessionID: 's', text: 'b', intentionId: 'i-2' });
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].correlationId, seen[1].correlationId);
  });

  it('logger failure cannot change success behavior', async () => {
    const inner = { chat: async () => ({ turnId: 't-9', output: 'ok-9', userMessageId: 'u-9' }) };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: throwingSink() });
    const out = await wrapped.chat({ sessionID: 's', text: 'hi', intentionId: 'i-9' });
    assert.equal(out.output, 'ok-9');
  });

  it('failure path preserves the public code, calls once, and still emits', async () => {
    const seen = [];
    let calls = 0;
    const err = Object.assign(new Error('typed'), { code: 'provider.transport' });
    const inner = {
      chat: async () => { calls += 1; throw err; },
    };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: (e) => seen.push(e) });
    await assert.rejects(wrapped.chat({ sessionID: 's', text: PROMPT_TEXT, intentionId: 'i-x' }), (e) => e === err);
    assert.equal(calls, 1); // single attempt: no retry, no second intention
    assert.equal(seen.length, 1);
    assert.equal(seen[0].outcome, 'failure');
    assert.equal(seen[0].cause, 'provider_transport_opaque');
    const raw = JSON.stringify(seen);
    assert.ok(!raw.includes(PROMPT_TEXT));
    assert.ok(!raw.includes('typed'));
  });

  it('logger failure cannot change error behavior', async () => {
    const err = Object.assign(new Error('boom'), { code: 'prompt.failed' });
    const inner = { chat: async () => { throw err; } };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: throwingSink() });
    await assert.rejects(wrapped.chat({ sessionID: 's', text: 'hi', intentionId: 'i-e' }), (e) => e === err);
  });
});

describe('etapa C classification from observable evidence only', () => {
  it('maps provider.unavailable/denied to config/provider resolution', () => {
    assert.equal(classifyTerminalCause(Object.assign(new Error('x'), { code: 'provider.unavailable' })).cause, 'config_provider_resolution');
    assert.equal(classifyTerminalCause(Object.assign(new Error('x'), { code: 'provider.denied' })).cause, 'config_provider_resolution');
  });

  it('maps provider.transport to opaque without output evidence', () => {
    const c = classifyTerminalCause(Object.assign(new Error('x'), { code: 'provider.transport' }));
    assert.equal(c.cause, 'provider_transport_opaque');
    assert.equal(c.phase, 'terminal_result');
  });

  it('maps provider.transport with poll-observed output to stream interrupted', () => {
    // Evidence flag lives on `details.outputBegan` — set ONLY by the poll
    // loop that observed assistant text before the terminal marker. The
    // classifier never accepts it from a caller argument (no inference).
    const err = Object.assign(new Error('x'), {
      code: 'provider.transport',
      details: { userMessageId: 'u-1', outputBegan: true },
    });
    const c = classifyTerminalCause(err);
    assert.equal(c.cause, 'stream_interrupted_after_output');
    assert.equal(c.phase, 'terminal_result');
  });

  it('maps timeout codes to timeout; bare cancel stays not_proven', () => {
    assert.equal(classifyTerminalCause(Object.assign(new Error('x'), { code: 'gateway.timeout' })).cause, 'timeout');
    assert.equal(classifyTerminalCause(Object.assign(new Error('x'), { code: 'prompt.timeout' })).cause, 'timeout');
    // EVIDENCE GAP: a bare `prompt.cancelled` (caller abort vs deadline) carries
    // no deadline proof at this boundary, so it must NOT be guessed as timeout.
    assert.equal(classifyTerminalCause(Object.assign(new Error('x'), { code: 'prompt.cancelled' })).cause, 'not_proven');
  });

  it('deadline-marked no_output classifies runtime timeout; unmarked stays not_proven', () => {
    // REVIEW-FIX 1: the poll loop sets details.deadlineExceeded ONLY when the
    // local wait deadline actually fired. The classifier maps ONLY this exact
    // internal marker (strict === true) — the runtime timeout is observed, the
    // physical provider cause stays NOT_PROVEN (no httpStatus ever attached).
    const marked = classifyTerminalCause(Object.assign(new Error('x'), {
      code: 'prompt.no_output',
      details: { userMessageId: 'u-1', deadlineExceeded: true },
    }));
    assert.equal(marked.cause, 'timeout');
    assert.equal(marked.phase, 'sdk_prompt');
    assert.equal(marked.httpStatus, undefined);
    for (const details of [undefined, {}, { userMessageId: 'u-1' }, { deadlineExceeded: false }, { deadlineExceeded: 1 }, { deadlineExceeded: 'yes' }]) {
      const c = classifyTerminalCause(Object.assign(new Error('x'), { code: 'prompt.no_output', ...(details === undefined ? {} : { details }) }));
      assert.equal(c.cause, 'not_proven', `unmarked no_output must stay not_proven (got ${JSON.stringify(details)})`);
    }
  });

  it('maps history-origin failures without misstating the local bound', () => {
    assert.equal(classifyTerminalCause(Object.assign(new Error('x'), { code: 'history.unavailable' })).cause, 'persistence_history_read');
    // EVIDENCE REFINEMENT: `prompt.history_overflow` is a LOCAL read bound
    // (bounded paging refused to truncate) — not a proved persistence/store
    // failure. It carries its own cause so dashboards never read a local
    // guard as a storage outage.
    const overflow = classifyTerminalCause(Object.assign(new Error('x'), { code: 'prompt.history_overflow' }));
    assert.equal(overflow.cause, 'history_bound_local');
    assert.equal(overflow.phase, 'history_poll');
  });

  it('local negative: physical transport text without SDK shape stays NOT_PROVEN (no guessing)', () => {
    // EVIDENCE GAP (pinned SDK 2.2.4): the JS client surfaces untyped failures
    // as `prompt.failed` with sanitized text; DNS/TLS/connection internals,
    // raw HTTP status lines, and SSE/parse frames are NOT observable from
    // session.prompt / message.list history. The classifier must NOT map
    // keyword text to a physical cause — every case below stays not_proven and
    // the raw text never enters the event.
    for (const rawText of [
      `socket hang up ${SECRET} body={token:"abc"}`,
      'TLS certificate verify failed / certificate has expired',
      'upstream HTTP 502 Bad Gateway proxy error',
      'SSE stream parse error: unexpected chunk framing',
      'ENOTFOUND api.opencode.ai getaddrinfo failure',
    ]) {
      const err = Object.assign(new Error(rawText), { code: 'prompt.failed' });
      const c = classifyTerminalCause(err);
      assert.equal(c.cause, 'not_proven', `must not guess physical cause from: ${rawText.slice(0, 24)}`);
      const ctx = createDiagnosticContext({ sink: () => {} });
      const evt = ctx.emit({ phase: 'sdk_prompt', outcome: 'failure', cause: c.cause });
      const raw = JSON.stringify(evt);
      assert.ok(!raw.includes('socket'));
      assert.ok(!raw.includes('topsecret'));
      assert.ok(!raw.includes('OPENCODE_GO_API_KEY'));
    }
  });

  it('httpStatus is emitted only for finance/API evidence, never as provider status', () => {
    // EVIDENCE REFINEMENT: bounded statuses from the finance transport and
    // the gateway authority fetch are labeled `finance_upstream_error` with
    // their origin phase — deliberately NOT `http_status`. Provider HTTP
    // status is hidden by SDK 2.2.4 (no statusCode on provider errors), so
    // `http_status` stays reserved-unreachable and provider failures stay
    // opaque/NOT_PROVEN rather than guessing from text.
    const toolStatus = classifyTerminalCause(
      Object.assign(new Error('x'), { code: 'tool.upstream_error', details: { statusCode: 502 } }),
    );
    assert.equal(toolStatus.cause, 'finance_upstream_error');
    assert.equal(toolStatus.phase, 'finance_tool_call');
    assert.equal(toolStatus.httpStatus, 502);
    const gwStatus = classifyTerminalCause(
      Object.assign(new Error('x'), { code: 'gateway.upstream_error', details: { statusCode: 503 } }),
    );
    assert.equal(gwStatus.cause, 'finance_upstream_error');
    assert.equal(gwStatus.phase, 'gateway_admit');
    assert.equal(gwStatus.httpStatus, 503);
    const toolTimeout = classifyTerminalCause(Object.assign(new Error('x'), { code: 'tool.timeout' }));
    assert.equal(toolTimeout.cause, 'timeout');
    assert.equal(toolTimeout.phase, 'finance_tool_call');
    const noStatus = classifyTerminalCause(Object.assign(new Error('x'), { code: 'prompt.failed' }));
    assert.equal(noStatus.httpStatus, undefined);
    const outOfRange = classifyTerminalCause(
      Object.assign(new Error('x'), { code: 'tool.upstream_error', details: { statusCode: 9999 } }),
    );
    // Out-of-range status is not evidence: cause stays not_proven, no status.
    assert.equal(outOfRange.cause, 'not_proven');
    assert.equal(outOfRange.httpStatus, undefined);
    const noStatusUpstream = classifyTerminalCause(
      Object.assign(new Error('x'), { code: 'gateway.upstream_error' }),
    );
    // A gateway/tool upstream error WITHOUT a bounded status (e.g. the
    // store-settle safe error reusing the gateway code) is not labeled
    // finance — cause stays not_proven with the origin phase.
    assert.equal(noStatusUpstream.cause, 'not_proven');
    assert.equal(noStatusUpstream.phase, 'gateway_admit');
    assert.equal(noStatusUpstream.httpStatus, undefined);
    // The reserved provider-side causes are never produced from observable
    // SDK evidence: DNS/TLS internals, raw HTTP lines and SSE/parse frames
    // are not exposed by session.prompt / message.list.
    for (const raw of ['socket hang up', 'TLS verify failed', 'HTTP 502 proxy', 'SSE parse error', 'ENOTFOUND']) {
      const c = classifyTerminalCause(Object.assign(new Error(raw), { code: 'prompt.failed' }));
      assert.ok(!['http_status', 'connection_dns_tls', 'protocol_sse_parsing'].includes(c.cause));
      assert.equal(c.cause, 'not_proven');
    }
  });

  it('history wrapper path emits persistence cause and preserves public code', async () => {
    const seen = [];
    const err = Object.assign(new Error('history down'), { code: 'history.unavailable' });
    const inner = { readHistory: async () => { throw err; } };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: (e) => seen.push(e) });
    await assert.rejects(wrapped.readHistory({ sessionID: 's-local' }), (e) => e === err);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cause, 'persistence_history_read');
    assert.equal(seen[0].phase, 'history_poll');
  });

  it('history wrapper keeps guard failures NOT_PROVEN (never restated as persistence)', async () => {
    // Binding/quarantine/cancel guards observed on the history boundary prove
    // nothing about the store — the event keeps not_proven with the history
    // phase instead of mislabeling the guard as a persistence failure.
    const seen = [];
    const err = Object.assign(new Error('quarantined'), { code: 'host_binding_quarantined' });
    const inner = { readHistory: async () => { throw err; } };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: (e) => seen.push(e) });
    await assert.rejects(wrapped.readHistory({ sessionID: 's-local' }), (e) => e === err);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cause, 'not_proven');
    assert.equal(seen[0].phase, 'history_poll');
  });

  it('wrapper reuses a threaded opaque correlation instead of minting', async () => {
    const seen = [];
    const inner = { chat: async () => ({ turnId: 't', output: 'ok', userMessageId: 'u' }) };
    const wrapped = wrapPromptHostWithDiagnostics(inner, { sink: (e) => seen.push(e) });
    const cid = '123e4567-e89b-42d3-a456-426614174000';
    await wrapped.chat({ sessionID: 's', text: 'hi', intentionId: 'i-1', diagnosticCorrelationId: cid });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].correlationId, cid);
    // A non-UUID threading value is ignored (fresh UUID minted, never derived).
    await wrapped.chat({ sessionID: 's', text: 'hi', intentionId: 'i-2', diagnosticCorrelationId: 'i-2' });
    assert.equal(seen.length, 2);
    assert.notEqual(seen[1].correlationId, 'i-2');
    assert.match(seen[1].correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('default sink logs exactly one structured JSON event to stderr, never stdout', async () => {
    // REVIEW-FIX 2: src/main.mjs CLI stdout carries only control JSON lines
    // (startup/shutdown protocol). The default diagnostic sink must use
    // stderr (or another side channel) so it can never corrupt that protocol.
    const errLines = [];
    const outLines = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a) => { errLines.push(a.join(' ')); };
    console.log = (...a) => { outLines.push(a.join(' ')); };
    try {
      const inner = { chat: async () => ({ turnId: 't-d', output: 'ok-d', userMessageId: 'u-d' }) };
      const wrapped = wrapPromptHostWithDiagnostics(inner, {});
      await wrapped.chat({ sessionID: 's', text: 'hello', intentionId: 'i-d' });
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    assert.equal(errLines.length, 1);
    assert.equal(outLines.length, 0, 'default sink must never write stdout');
    const parsed = JSON.parse(errLines[0]);
    assert.equal(parsed.event, DIAG_EVENT);
  });
});
