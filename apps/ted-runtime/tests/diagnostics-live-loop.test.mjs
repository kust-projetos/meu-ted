// Etapa C-WIRE live loop (real SDK 2.2.4, zero external/paid inference):
// validates the wired diagnostics against a scripted LOCAL OpenAI-compatible
// provider (loopback stub, dummy apiKey) through the REAL prompt host.
//
// 1. SUCCESS + finance tool read: stub returns a `list_accounts` tool_call,
//    then final text. The finance transport points at a CLOSED loopback port
//    so the tool attempt fails fast with a typed finance error (proving the
//    permission allowed execution — finance origin, distinguishable from a
//    provider denial), and the loop completes with the stub final text.
//    Asserts: sdk_prompt admit + terminal_result success events sharing one
//    fresh opaque correlation; loopback-only; no write routes.
// 2. NEGATIVE provider scenario: stub returns HTTP 500 for completions.
//    The SDK hides the physical cause (no statusCode/shape on the surfaced
//    error), so the event MUST stay provider_transport_opaque or not_proven
//    with no httpStatus — proving the NOT_PROVEN limit instead of guessing.
//    The public typed code is preserved and no second prompt is issued.
//
// EVIDENCE GAP (documented, not user-facing): pinned SDK 2.2.4 surfaces
// provider failures as typed history markers (`provider.transport`) or
// sanitized `prompt.failed`; DNS/TLS internals, raw HTTP status lines and
// SSE/parse frames are NOT observable from session.prompt / message.list.
// The classifier therefore never emits connection_dns_tls / http_status /
// protocol_sse_parsing from live evidence.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { setupIsolation, tedConfig, wirePlugin } from '../src/bootstrap.mjs';
import { defineTedFinancePlugin } from '../src/plugin.mjs';
import { HttpFinanceTransport } from '../src/transport.mjs';
import { bindSession } from '../src/session-bindings.mjs';
import { createPromptHost } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PROVIDER = 'diagloop';
const FIXTURE_MODEL = 'test-alpha';
const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';

const HOST = {
  label: 'diagloop',
  token: 'test-token-not-a-real-secret',
  household: 'H_DIAG',
  actorId: 'actor-diag',
  deviceId: 'dev-diag',
};

function fixtureModel(id) {
  return {
    name: `Test ${id}`,
    modelID: id,
    capabilities: { input: ['text'], output: ['text'] },
    limit: { context: 8000, output: 2000 },
  };
}

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function toolCallEvents({ callId, name, args }) {
  const base = {
    id: 'chatcmpl-diag', object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: FIXTURE_MODEL, error: null,
  };
  return (
    sseChunk({
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant', content: null,
          tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    })
    + sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n'
  );
}

function finalTextEvents(text) {
  const base = {
    id: 'chatcmpl-diag', object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: FIXTURE_MODEL, error: null,
  };
  return (
    sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n'
  );
}

// Known SDK catalog fetch (models.opencode.ai): the native loop attempts it
// during a turn (retried); the zero-external guard blocks it pre-flight, so
// no byte leaves the machine and every COMPLETED fetch is loopback. Any
// other blocked destination fails the test loudly.
const BLOCKED_CATALOG_RE = /^GET https:\/\/models\.opencode\.ai\//;

function assertLocalOnly(fetchBlocked) {
  for (const b of fetchBlocked) {
    assert.match(b, BLOCKED_CATALOG_RE, `only the blocked SDK catalog fetch may be non-loopback (got ${b.slice(0, 120)})`);
  }
}

async function closedLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

describe('etapa C-WIRE live loop: real SDK scripted provider emits correlated diagnostics', () => {
  let iso;
  let oc = null;
  let stub = null;
  let stubUrl;
  let closedPort;
  let script = null; // {callId,name,args,finalText} | {failStatus:number}
  let realFetch;
  let fetchAllowedLoopback = 0;
  const fetchBlocked = [];
  const stubPosts = []; // bodies POSTed to the stub model endpoint
  const transportCalls = []; // {route, method} attempted by finance executors

  before(async () => {
    const root = approvedTmpRoot('ted-diagloop');
    iso = setupIsolation(root, 'diagloop');
    closedPort = await closedLoopbackPort();

    stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method === 'POST') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = { _parseError: true }; }
          stubPosts.push({ url: req.url, body });
          if (script && typeof script.failStatus === 'number') {
            res.writeHead(script.failStatus, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'scripted stub failure', type: 'stub' } }));
            return;
          }
          const messages = body && Array.isArray(body.messages) ? body.messages : [];
          const hasToolMsg = messages.some((m) => m && m.role === 'tool');
          assert.ok(script, 'stub script must be set before the prompt loop runs');
          const payload = hasToolMsg ? finalTextEvents(script.finalText) : toolCallEvents(script);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.end(payload);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(0, '127.0.0.1', resolve);
    });
    stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      let s = '';
      try { s = String(url && url.url ? url.url : url); } catch { s = String(url); }
      let hostname = '';
      try { hostname = new URL(s).hostname; } catch { hostname = ''; }
      if (hostname === '127.0.0.1') {
        fetchAllowedLoopback++;
        return realFetch(url, init);
      }
      fetchBlocked.push(`${(init && init.method) || 'GET'} ${s.slice(0, 200)}`);
      throw new Error('guard: non-loopback fetch blocked (zero external inference)');
    };

    const base = tedConfig();
    const cfg = {
      ...base,
      model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      policies: [
        ...(base.policies || []),
        { action: 'provider.use', resource: FIXTURE_PROVIDER, effect: 'allow' },
      ],
      providers: {
        [FIXTURE_PROVIDER]: {
          name: 'Diagloop scripted stub (dummy apiKey)',
          package: FIXTURE_PACKAGE,
          settings: { baseURL: stubUrl, apiKey: 'test-fixture-not-a-real-secret' },
          models: { [FIXTURE_MODEL]: fixtureModel(FIXTURE_MODEL) },
        },
      },
    };
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    fs.writeFileSync(path.join(iso.dirs.config, 'opencode.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const sdk = await import('@opencode/sdk');
    oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });

    const inner = new HttpFinanceTransport({ baseUrl: `http://127.0.0.1:${closedPort}`, timeoutMs: 5000 });
    const countingTransport = async (args) => {
      transportCalls.push({ route: String(args && args.route), method: String((args && args.method) || 'GET') });
      return inner.call(args);
    };
    await wirePlugin(oc, defineTedFinancePlugin(() => countingTransport));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    if (stub) await new Promise((resolve) => stub.close(resolve)).catch(() => {});
    if (oc) await oc.close().catch(() => {});
  });

  it('SUCCESS + tool read emits correlated admit/terminal events; finance origin distinguished', { timeout: 120000 }, async () => {
    const events = [];
    script = { callId: 'call_diag_ok_1', name: 'list_accounts', args: {}, finalText: 'FINAL-DIAG-OK' };
    transportCalls.length = 0;
    const created = await oc.session.create({ title: 'diag-ok', agent: 'ted' });
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250, diagnosticsSink: (e) => events.push(e) });
    const res = await promptHost.chat({ sessionID: created.id, text: 'diag turn: list my accounts', intentionId: 'diag-ok-01' });
    assert.equal(res.output, 'FINAL-DIAG-OK');
    // Finance tool executed (distinguishable from a provider denial): the
    // closed-port transport fails fast with a typed finance error fed back
    // to the loop — exactly one attempt, GET-only, read route.
    assert.equal(transportCalls.length, 1);
    assert.deepEqual(transportCalls[0], { route: '/accounts', method: 'GET' });
    // Diagnostics: admit + terminal share one fresh opaque correlation.
    const admit = events.find((e) => e.phase === 'sdk_prompt' && e.outcome === 'success');
    const terminal = events.find((e) => e.phase === 'terminal_result' && e.outcome === 'success');
    assert.ok(admit && terminal, `expected sdk_prompt admit + terminal_result success (got ${JSON.stringify(events.map((e) => e.phase))})`);
    assert.equal(admit.correlationId, terminal.correlationId);
    assert.match(admit.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    for (const e of events) {
      for (const k of Object.keys(e)) {
        assert.ok(['event', 'correlationId', 'startedAt', 'endedAt', 'durationMs', 'phase', 'outcome', 'cause', 'httpStatus'].includes(k));
      }
    }
    const raw = JSON.stringify(events);
    assert.ok(!raw.includes('FINAL-DIAG-OK'), 'no assistant text in events');
    assert.ok(!raw.includes('diag-ok-01'), 'no intention id in events');
    // Local-only destination proof: every COMPLETED fetch was loopback
    // (stub + closed-port transport). The only non-loopback attempts are the
    // known SDK catalog fetch, blocked pre-flight by the guard (threw before
    // any socket — zero bytes left the machine).
    assertLocalOnly(fetchBlocked);
    assert.ok(fetchAllowedLoopback > 0, 'loopback stub was actually hit');
  });

  it('NEGATIVE provider 500 stays opaque/NOT_PROVEN with no httpStatus (SDK hides it)', { timeout: 60000 }, async () => {
    const events = [];
    script = { failStatus: 500 };
    const created = await oc.session.create({ title: 'diag-neg', agent: 'ted' });
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 8000, pollIntervalMs: 250, diagnosticsSink: (e) => events.push(e) });
    // Single attempt at the adapter level — no retry, no second prompt.
    let thrown = null;
    try {
      await promptHost.chat({ sessionID: created.id, text: 'diag turn: negative 500', intentionId: 'diag-neg-01' });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'negative provider scenario must fail the turn (never fabricated success)');
    const publicCode = thrown && thrown.code;
    assert.ok(typeof publicCode === 'string' && publicCode.length > 0, 'public typed code preserved');
    const failures = events.filter((e) => e.outcome === 'failure');
    assert.ok(failures.length >= 1, `expected >=1 failure event (got ${events.length})`);
    // PROVED LIMIT: whatever the SDK surfaces, the physical HTTP 500 is NOT
    // observable evidence — the classifier must not emit http_status and must
    // not guess. `timeout` here names ONLY the observed local wait deadline
    // (deadlineExceeded marker); the physical provider cause stays NOT_PROVEN.
    for (const e of failures) {
      assert.ok(['provider_transport_opaque', 'not_proven', 'timeout'].includes(e.cause), `cause stays unproven (got ${e.cause})`);
      assert.equal(e.httpStatus, undefined, 'no status smuggled from hidden provider transport');
      assert.notEqual(e.cause, 'http_status');
    }
    const raw = JSON.stringify(events);
    assert.ok(!raw.includes('diag-neg-01'), 'no intention id in events');
    // Same local-only proof on the negative path.
    assertLocalOnly(fetchBlocked);
  });
});
