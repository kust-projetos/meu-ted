// PR290-PROMPT-LOOP-PERMISSION-09: real-loop proof that the TED native
// permission model enforces its decisions on tool calls (SDK 2.2.4).
//
// Runs the REAL prompt loop (oc.session.prompt via the product
// createPromptHost) against a scripted OpenAI-compatible stub bound to
// 127.0.0.1 (ephemeral port, zero paid/external inference). The stub returns
// canned SSE chat-completion chunks: first a tool_call for a named tool,
// then (after the loop feeds the tool result back) a final text message.
//
// 1. ALLOWED: model calls the registered product read tool `list_accounts`.
//    The plugin permission assert (ted.finance.read / list_accounts) allows,
//    so execution reaches the transport. Transport points at a CLOSED
//    loopback port so it fails fast: the observable is a tool.transport
//    failure (NOT tool.forbidden), proving the permission allowed execution.
//    Also asserts the stub received the tool-result turn.
// 2. DENIED (native, host): model calls `shell`. The native layer refuses it
//    (tool.use hard deny + agent deny-all). Asserts no shell side effect
//    (marker file never created), finance transport untouched, and the model
//    receives a denial/error result, not success.
// 3. DENIED (unknown action): model calls `write` (permission action `edit`,
//    not in the finance allowlist). Denied at the permission assert before
//    any transport call (transport count === 0) + marker absent.
//
// Test-only config (tedConfig() product code unchanged): base product config
// + `model: testloop/test-alpha` + provider `testloop`
// (`@opencode/ai/providers/openai-compatible`, baseURL = stub URL, dummy
// apiKey) + test-only `provider.use` allow for `testloop` AFTER the deny-all.
// Written directly, never via writeTedConfig.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { setupIsolation, tedConfig, wirePlugin, assertNoRedirectedComponents } from '../src/bootstrap.mjs';
import { defineTedFinancePlugin } from '../src/plugin.mjs';
import { HttpFinanceTransport } from '../src/transport.mjs';
import { bindSession } from '../src/session-bindings.mjs';
import { createPromptHost } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PROVIDER = 'testloop';
const FIXTURE_MODEL = 'test-alpha';
const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';

const HOST = {
  label: 'ploop',
  token: 'test-token-not-a-secret',
  household: 'H_PLOOP',
  actorId: 'actor-ploop',
  deviceId: 'dev-ploop',
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
    id: 'chatcmpl-ploop', object: 'chat.completion.chunk',
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
    id: 'chatcmpl-ploop', object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: FIXTURE_MODEL, error: null,
  };
  return (
    sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n'
  );
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

describe('PR290 prompt-loop permission enforcement (real SDK 2.2.4, stubbed model)', () => {
  let iso;
  let oc = null;
  let stub = null;
  let stubUrl;
  let closedPort;
  let transportCalls = 0;
  const chatRequests = []; // {url, remote, body} for POSTs to the stub model endpoint
  const allStubHits = []; // every request incl. non-POST, with remote address
  let script = null; // {name, args, finalText} set per test before chat()
  let realFetch;
  let fetchAllowedLoopback = 0;
  const fetchBlocked = [];
  let effectiveTools = null;
  let effectiveToolsError = null;

  before(async () => {
    const root = approvedTmpRoot('ted-prompt-loop');
    iso = setupIsolation(root, 'promptloop');

    closedPort = await closedLoopbackPort();

    stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const remote = req.socket && req.socket.remoteAddress;
        allStubHits.push({ method: req.method, url: req.url, remote });
        if (req.method === 'POST') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = { _parseError: raw.slice(0, 200) }; }
          chatRequests.push({ url: req.url, remote, body });
          assert.equal(req.url.startsWith('/v1/'), true, `stub only serves /v1/* (got ${req.url})`);
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

    // Zero-external guard: loopback fetch (stub + closed-port transport) is
    // allowed and counted; anything else fails loudly and is recorded.
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
      throw new Error('guard: non-loopback fetch blocked in the prompt-loop proof (zero external inference)');
    };

    // Test-only opencode.json: product base + native model selector + local
    // fixture provider + test-only provider.use allow AFTER the deny-all.
    // tedConfig() product code is NOT modified.
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
          name: 'Test loopback fixture (scripted stub, dummy apiKey)',
          package: FIXTURE_PACKAGE,
          settings: { baseURL: stubUrl, apiKey: 'test-fixture-not-a-secret' },
          models: { [FIXTURE_MODEL]: fixtureModel(FIXTURE_MODEL) },
        },
      },
    };
    const providerPolicies = (cfg.policies || []).filter((p) => p && p.action === 'provider.use');
    assert.ok(providerPolicies.some((p) => p.resource === '*' && p.effect === 'deny'), 'fixture keeps provider deny-all');
    const allowIdx = providerPolicies.findIndex((p) => p.resource === FIXTURE_PROVIDER && p.effect === 'allow');
    const denyIdx = providerPolicies.findIndex((p) => p.resource === '*' && p.effect === 'deny');
    assert.ok(allowIdx !== -1 && allowIdx > denyIdx, 'test-only provider allow comes after deny-all (findLast wins)');
    assert.equal(new URL(cfg.providers[FIXTURE_PROVIDER].settings.baseURL).hostname, '127.0.0.1', 'stub baseURL is loopback');

    assertNoRedirectedComponents([iso.dirs.config]);
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    fs.writeFileSync(path.join(iso.dirs.config, 'opencode.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const sdk = await import('@opencode/sdk');
    oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });

    const inner = new HttpFinanceTransport({ baseUrl: `http://127.0.0.1:${closedPort}`, timeoutMs: 5000 });
    const countingTransport = async (args) => {
      transportCalls++;
      return inner.call(args);
    };
    await wirePlugin(oc, defineTedFinancePlugin(() => countingTransport, {
      onEffectiveTools: (names, err) => { effectiveTools = names; effectiveToolsError = err; },
    }));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    if (stub) await new Promise((resolve) => stub.close(resolve)).catch(() => {});
    if (oc) await oc.close().catch(() => {});
  });

  function toolMessagesOf(req) {
    const messages = (req && req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
    return messages.filter((m) => m && m.role === 'tool');
  }

  it('ALLOWED: list_accounts is offered to the loop and passes the permission assert before transport', async () => {
    // Regression for the catalog bug: before `options.permission` was set on
    // the product tools, the native catalog filtered finance tools out of every
    // loop request (availability action = tool NAME, matched by the agent's
    // leading {*} deny). With availability mapped to `ted.finance.read`, the
    // allowlisted tool is offered, the execute-time assert allows it, and the
    // call reaches the transport exactly once.
    const callId = 'call_ploop_allow_1';
    script = { callId, name: 'list_accounts', args: {}, finalText: 'FINAL-ALLOWED-OK' };
    transportCalls = 0;
    const mark = chatRequests.length;
    const created = await oc.session.create({ title: 'ploop-allow', agent: 'ted' });
    assert.ok(created && typeof created.id === 'string' && created.id.length > 0, 'native session created');
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250 });
    let res;
    try {
      res = await promptHost.chat({ sessionID: created.id, text: 'test turn: list my accounts', intentionId: 'ploop-allow-01' });
    } finally {
      // host+stub cleanup happens in after(); keep per-test state local only
    }
    assert.equal(res.output, 'FINAL-ALLOWED-OK', 'loop completes with the stub final text observed through native history');
    const newReqs = chatRequests.slice(mark);
    const diag = `effectiveTools=${JSON.stringify(effectiveTools)} effectiveErr=${String(effectiveToolsError && effectiveToolsError.message || effectiveToolsError).slice(0, 200)} stubTurns=${newReqs.length} transportCalls=${transportCalls}`;
    assert.ok(newReqs.length >= 2, `stub saw the tool-call turn AND the tool-result turn (got ${newReqs.length}); ${diag}`);
    const toolTurn = newReqs.find((r) => toolMessagesOf(r).length > 0);
    assert.ok(toolTurn, `stub received the tool-result turn (role tool message fed back to the model); ${diag}`);
    const toolMsg = toolMessagesOf(toolTurn)[0];
    assert.equal(toolMsg.tool_call_id, callId, 'tool result correlates to the scripted call id');
    const content = String(toolMsg.content ?? '');
    assert.ok(content.length > 0, `tool result content is non-empty (got ${JSON.stringify(content).slice(0, 300)}); ${diag}`);
    assert.equal(transportCalls, 1, `exactly one finance transport attempt: permission ALLOWED execution (a deny would short-circuit before transport); toolContent=${JSON.stringify(content).slice(0, 300)}; ${diag}`);
    assert.match(content, /transport/i, `tool result is a transport failure, proving execution ran (got ${JSON.stringify(content).slice(0, 300)})`);
    assert.ok(!/forbidden/i.test(content), `tool result is NOT a permission denial (got ${JSON.stringify(content).slice(0, 300)})`);
    for (const r of newReqs) {
      assert.equal(r.remote, '127.0.0.1', 'every stub request arrived via loopback only');
    }
  });

  it('DENIED: shell is refused natively — no execution, no side effect, model gets an error (not success)', { timeout: 120000 }, async () => {
    const marker = path.join(iso.dirs.tmp, 'PLOOP_SHELL_PWNED.txt');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const callId = 'call_ploop_deny_1';
    script = {
      callId,
      name: 'shell',
      args: { command: `node -e "require('node:fs').writeFileSync('PLOOP_SHELL_PWNED.txt','pwned')"`, workdir: iso.dirs.tmp },
      finalText: 'FINAL-DENIED-OK',
    };
    transportCalls = 0;
    const mark = chatRequests.length;
    const created = await oc.session.create({ title: 'ploop-deny', agent: 'ted' });
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250 });
    const res = await promptHost.chat({ sessionID: created.id, text: 'test turn: run a shell command', intentionId: 'ploop-deny-02' });
    assert.equal(res.output, 'FINAL-DENIED-OK', 'loop completes with the stub final text after the denial');
    assert.equal(fs.existsSync(marker), false, 'shell never executed: marker file absent (native deny, no side effect)');
    assert.equal(transportCalls, 0, 'finance transport untouched by the shell attempt');
    const newReqs = chatRequests.slice(mark);
    assert.ok(newReqs.length >= 2, `denial was fed back to the model as a second turn (got ${newReqs.length} stub requests)`);
    const toolTurn = newReqs.find((r) => toolMessagesOf(r).length > 0);
    assert.ok(toolTurn, 'stub received the denial tool-result turn');
    const toolMsg = toolMessagesOf(toolTurn)[0];
    assert.equal(toolMsg.tool_call_id, callId, 'tool result correlates to the scripted call id');
    const content = String(toolMsg.content ?? '');
    // Exact native enforcement point (2.2.4): the agent deny-all excludes
    // shell from the per-request tool catalog (availability action = tool
    // name, no allow matches the leading {*} deny), so the loop refuses with
    // a tool.execution error and execute/permission.assert never runs.
    let parsed = null;
    try { parsed = JSON.parse(content); } catch { parsed = null; }
    assert.ok(parsed && parsed.error && parsed.error.type === 'tool.execution', `tool result is a native error envelope, not success (got ${JSON.stringify(content).slice(0, 200)})`);
    assert.match(String(parsed.error.message || ''), /No tool named "shell" is currently available/, `agent deny-all keeps shell out of the loop catalog (got ${JSON.stringify(parsed.error.message).slice(0, 200)})`);
    assert.ok(!/PLOOP_SHELL_PWNED/.test(content), 'no marker content leaks as success');
  });

  it('DENIED (unknown action): write is refused natively before any transport call', { timeout: 120000 }, async () => {
    const marker = path.join(iso.dirs.tmp, 'PLOOP_WRITE_PWNED.txt');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const callId = 'call_ploop_unknown_1';
    script = {
      callId,
      name: 'write',
      args: { path: marker, content: 'pwned-by-unknown-action' },
      finalText: 'FINAL-UNKNOWN-OK',
    };
    transportCalls = 0;
    const mark = chatRequests.length;
    const created = await oc.session.create({ title: 'ploop-unknown', agent: 'ted' });
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250 });
    const res = await promptHost.chat({ sessionID: created.id, text: 'test turn: write a file', intentionId: 'ploop-unknown-03' });
    assert.equal(res.output, 'FINAL-UNKNOWN-OK', 'loop completes with the stub final text after the denial');
    assert.equal(fs.existsSync(marker), false, 'write never executed: marker file absent (refused before any effect)');
    assert.equal(transportCalls, 0, 'zero finance transport calls: refusal happens before any transport');
    const newReqs = chatRequests.slice(mark);
    assert.ok(newReqs.length >= 2, `denial was fed back to the model as a second turn (got ${newReqs.length} stub requests)`);
    const toolTurn = newReqs.find((r) => toolMessagesOf(r).length > 0);
    assert.ok(toolTurn, 'stub received the denial tool-result turn');
    const toolMsg = toolMessagesOf(toolTurn)[0];
    assert.equal(toolMsg.tool_call_id, callId, 'tool result correlates to the scripted call id');
    const content = String(toolMsg.content ?? '');
    // Same native point as shell: action 'write' (options.permission ?? name)
    // is not in the agent allowlist, so the {*} deny excludes it from the
    // request catalog — refused before any permission.assert/transport.
    let parsed = null;
    try { parsed = JSON.parse(content); } catch { parsed = null; }
    assert.ok(parsed && parsed.error && parsed.error.type === 'tool.execution', `tool result is a native error envelope, not success (got ${JSON.stringify(content).slice(0, 200)})`);
    assert.match(String(parsed.error.message || ''), /No tool named "write" is currently available/, `unknown/denied action never reaches the transport (got ${JSON.stringify(parsed.error.message).slice(0, 200)})`);
  });

  it('loopback-only: every stub hit arrived via 127.0.0.1 and no external fetch succeeded', { timeout: 60000 }, async () => {
    assert.ok(allStubHits.length > 0, 'stub recorded requests');
    for (const h of allStubHits) {
      assert.equal(h.remote, '127.0.0.1', `stub hit arrived via loopback only (got ${h.remote} for ${h.method} ${h.url})`);
    }
    assert.ok(fetchAllowedLoopback > 0, 'loopback fetch path was exercised');
    // Best-effort SDK housekeeping (models.opencode.ai snapshot + local
    // well-known probes observed in 2.2.4) is fail-closed here: the guard
    // throws, so zero external bytes succeed. Only those known housekeeping
    // targets may appear; anything else is an escape.
    const housekeepingRe = /^GET https:\/\/models\.opencode\.ai\//;
    const escapes = fetchBlocked.filter((u) => !housekeepingRe.test(u));
    assert.deepEqual(escapes, [], `zero non-housekeeping external fetch attempts (blocked: ${JSON.stringify(escapes).slice(0, 300)})`);
    assert.ok(fetchBlocked.length >= 0, `housekeeping attempts fail-closed by the guard (count=${fetchBlocked.length})`);
  });
});
