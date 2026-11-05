// TED-P290 offline A/B: provider-transport comparison (real SDK 2.2.4).
//
// SCOPE: provider transport ONLY — hook-rewritten vs native direct baseURL
// to one loopback stub, with the actual TED plugin running `list_accounts`
// + `get_month_summary` through a fake GET-only finance transport. NOT the
// PWA proxy, NOT the gateway end-to-end (no PWA/gateway/production).
// Path A: fake closed baseURL + test-only `http.request` hook (fail-closed,
// rewrite + ordinal header); turn via product `createPromptHost.chat`.
// Path B: native stub baseURL, NO hook, NO `createPromptHost` — one native
// prompt, `experimental.session.wait`, native history read. Same message/
// data, same 3 POSTs/2 reads/output/session in both; A-first always (aux
// GETs only in A, guard-blocked; B zero). Diagnostics are scalars/enums/
// ordinals/tuples only — never URL/body/prompt/token/header/output values.
// Guard intercepts `globalThis.fetch` (observed model transport) and allows
// the stub port only; no wider egress claim.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { setupIsolation, tedConfig, wirePlugin } from '../src/bootstrap.mjs';
import { defineTedFinancePlugin } from '../src/plugin.mjs';
import { bindSession } from '../src/session-bindings.mjs';
import { createPromptHost } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PROVIDER = 'tedab';
const FIXTURE_MODEL = 'test-ab';
const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';
const USER_MESSAGE = 'TED offline A/B: list my accounts and the September 2026 summary';
const EXPECTED_FINAL = 'TED-AB-FINAL-OK-2026-09';

const ACCOUNTS_BODY = Object.freeze({
  items: Object.freeze([{ id: 'acc-syn-1', kind: 'bank', balanceCents: 12345 }]),
  total: 1,
});
const SUMMARY_BODY = Object.freeze({
  yearMonth: '2026-09',
  incomeCents: 200000,
  expenseCents: 150000,
  balanceCents: 50000,
  transactionCount: 7,
});
const EXPECTED_ROUTES = Object.freeze(['/accounts', '/dashboard/month-summary?yearMonth=2026-09']);

function fixtureModel(id) {
  return { name: `Test ${id}`, modelID: id, capabilities: { input: ['text'], output: ['text'] }, limit: { context: 8000, output: 2000 } };
}

function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function chunk(finish, delta) {
  return sse({ id: 'c', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: FIXTURE_MODEL, error: null, choices: [{ index: 0, delta, finish_reason: finish }] });
}
const toolChunk = (callId, name, args) =>
  chunk(null, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  + chunk('tool_calls', {}) + 'data: [DONE]\n\n';
const textChunk = (text) => chunk(null, { role: 'assistant', content: text }) + chunk('stop', {}) + 'data: [DONE]\n\n';
const SCRIPT = [
  toolChunk('call_ab_1', 'list_accounts', {}),
  toolChunk('call_ab_2', 'get_month_summary', { yearMonth: '2026-09' }),
  textChunk(EXPECTED_FINAL),
];

async function closedLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const SDK_CATALOG_HOST = 'models.opencode.ai'; // blocked metadata host
const CORR_HEADER = 'x-tedab-corr'; // Path A ordinal header (number read back)

// Fail-closed fixture-model check over observed SDK ref shapes.
function isFixtureModel(model) {
  if (typeof model === 'string') return model === `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`;
  if (model && typeof model === 'object') {
    return (model.providerID ?? model.provider ?? '') === FIXTURE_PROVIDER
      && (model.modelID ?? model.model ?? model.id ?? '') === FIXTURE_MODEL;
  }
  return false;
}

// Test-only routing hook (Path A): every event must match agent/kind/model/
// URL or `proxyRejected`++ and a fixed throw. Success rewrites fake->stub
// with an ordinal header (`hookCompleted` counts successes only).
const HOOK_REFUSAL_MESSAGE = 'hook: request refused (fixed reason)';
function defineHookRewritePlugin(counters, fakeBase, stubBase) {
  return {
    id: 'ted-ab-hook',
    async setup(ctx) {
      if (!ctx || !ctx.session || typeof ctx.session.hook !== 'function') {
        throw new Error('ted-ab-hook: ctx.session.hook is required');
      }
      await ctx.session.hook('http.request', (ev) => {
        counters.hookReceived++;
        const req = ev && ev.request;
        const current = typeof req === 'string' ? req : (req && req.url);
        let host = '';
        try { host = new URL(typeof current === 'string' ? current.replace(fakeBase, stubBase) : '').hostname; } catch { host = ''; }
        if (!(ev && ev.agent === 'ted' && ev.kind === 'primary' && isFixtureModel(ev.model)
          && typeof current === 'string' && current.startsWith(fakeBase) && host === '127.0.0.1')) {
          counters.proxyRejected++;
          throw new Error(HOOK_REFUSAL_MESSAGE);
        }
        const rewritten = typeof req === 'string' ? new Request(current.replace(fakeBase, stubBase)) : new Request(current.replace(fakeBase, stubBase), req);
        rewritten.headers.set(CORR_HEADER, String(++counters.hookSeq));
        ev.request = rewritten;
        counters.proxyForwarded++;
        counters.hookCompleted++;
      });
    },
  };
}

// Explicit boundary counts plus sanitized per-request `stages`/`fetchStages`.
function zeroCounters() {
  return { hookReceived: 0, hookCompleted: 0, listenerReceived: 0, proxyRejected: 0, proxyForwarded: 0, providerReceived: 0, responseCompleted: 0, hookSeq: 0, postSeq: 0, statusCounts: {}, stages: [], fetchSeq: 0, fetchStages: [] };
}

// Assistant text strictly after the admitted id, stopping at the next user
// message. Missing id yields '' (caller waits; never fabricates output).
function assistantTextAfter(rows, admittedId) {
  if (!Array.isArray(rows) || typeof admittedId !== 'string' || admittedId.length === 0) return '';
  const idx = rows.findIndex((m) => m && typeof m === 'object' && m.id === admittedId);
  if (idx === -1) return '';
  let out = '';
  for (const m of rows.slice(idx + 1)) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'user') break;
    if (m.type !== 'assistant') continue;
    for (const p of (Array.isArray(m.content) ? m.content : [])) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') out += p.text;
    }
  }
  return out;
}

// Bounded idle wait: true when settled, false on slice timeout.
async function waitIdle(oc, sessionID, ms = 15000) {
  try {
    await Promise.race([
      (async () => { await oc.experimental.session.wait({ sessionID }); })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('wait-timeout')), ms)),
    ]);
    return true;
  } catch { return false; }
}

// Fake GET-only finance transport: two reads; everything else fails closed.
function makeFakeTransport(log) {
  const fail = () => { const e = new Error('fake transport refused'); e.code = 'tool.transport'; throw e; };
  return async (args) => {
    const route = String(args && args.route);
    const method = String((args && args.method) || 'GET');
    log.push({ route, method });
    if (method !== 'GET') fail();
    if (route === '/accounts') return { statusCode: 200, body: structuredClone(ACCOUNTS_BODY) };
    if (route === '/dashboard/month-summary?yearMonth=2026-09') return { statusCode: 200, body: structuredClone(SUMMARY_BODY) };
    fail();
  };
}

describe('TED-P290 offline A/B: hook-routed vs native-direct provider transport', () => {
  let iso;
  let stub = null;
  let stubUrl;
  let stubPort = 0;
  let fakeBase;
  let fakeBasePort = 0;
  let realFetch;
  const fetchBlocked = [];
  const fetchRef = { current: null };

  before(async () => {
    iso = setupIsolation(approvedTmpRoot('ted-provider-ab'), 'tedab');
    fakeBasePort = await closedLoopbackPort();
    fakeBase = `http://127.0.0.1:${fakeBasePort}/v1`;

    // Scripted stub (both modes); script follows the tool-result count.
    const countersRef = { current: null };
    const modeRef = { current: null };
    stub = http.createServer((req, res) => {
      const c = countersRef.current;
      const mode = modeRef.current;
      const rec = { corr: 0, provider: false, status: null };
      if (c) {
        c.listenerReceived++;
        if (mode === 'B' && req.method === 'POST') rec.corr = ++c.postSeq;
        c.stages.push(rec);
        res.on('finish', () => { // status lands only after bytes written
          rec.status = res.statusCode;
          c.responseCompleted++;
          c.statusCounts[res.statusCode] = (c.statusCounts[res.statusCode] || 0) + 1;
        });
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        let body = null;
        try { body = JSON.parse(raw); } catch { body = { _parseError: true }; }
        const toolCount = (body && Array.isArray(body.messages) ? body.messages : []).filter((m) => m && m.role === 'tool').length;
          if (c) {
            if (typeof req.url === 'string' && req.url.startsWith('/v1/')) rec.provider = true;
            if (rec.provider) c.providerReceived++;
            if (mode === 'A') {
            const h = req.headers ? req.headers[CORR_HEADER] : '';
            rec.corr = /^[0-9]{1,3}$/.test(String(h || '')) ? parseInt(String(h), 10) : 0;
          }
        }
        const payload = SCRIPT[toolCount];
        if (!payload) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unexpected turn', type: 'stub' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.end(payload);
      });
    });
    Object.assign(stub, { countersRef, modeRef });
    await new Promise((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(0, '127.0.0.1', resolve);
    });
    stubPort = stub.address().port;
    stubUrl = `http://127.0.0.1:${stubPort}/v1`;

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      // Allowlist: stub port ONLY; all else blocked pre-flight (zero
      // sockets). Sanitized records only — never URL/port/path values.
      let s = '';
      try { s = String(url && url.url ? url.url : url); } catch { s = String(url); }
      let host = '';
      let port = '';
      try { const u = new URL(s); host = u.hostname; port = u.port; } catch { /* blocked below */ }
      const method = String((init && init.method) || (url && typeof url === 'object' && url.method) || 'GET').toUpperCase();
      if (host === '127.0.0.1' && port === String(stubPort)) {
        const fc = fetchRef.current;
        if (!fc) return realFetch(url, init);
        fc.fetchSeq++;
        const frec = { seq: fc.fetchSeq, statusCode: null };
        fc.fetchStages.push(frec);
        const res = await realFetch(url, init);
        frec.statusCode = res && typeof res.status === 'number' ? res.status : null;
        return res;
      }
      // Fake base has its own enum (hook-bypass boundary); no socket opens.
      const destination = host === '127.0.0.1'
        ? (port === String(fakeBasePort) ? 'fake_provider_base' : 'other_loopback')
        : (host === SDK_CATALOG_HOST ? 'sdk_catalog' : 'unexpected_non_loopback');
      fetchBlocked.push({ method, destination, reason: 'blocked_preflight', statusCode: null, errorCode: null });
      throw new Error('guard: non-stub fetch blocked pre-flight (zero bytes sent)');
    };
  });

  after(async () => {
    globalThis.fetch = realFetch;
    if (stub) await new Promise((resolve) => stub.close(resolve)).catch(() => {});
  });

  async function runMode(mode) {
    assert.ok(mode === 'A' || mode === 'B', 'mode is A or B');
    const counters = zeroCounters();
    const transportLog = [];
    stub.countersRef.current = fetchRef.current = counters;
    stub.modeRef.current = mode;
    const blockedMark = fetchBlocked.length;

    const base = tedConfig();
    const cfg = {
      ...base,
      model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      policies: [...(base.policies || []), { action: 'provider.use', resource: FIXTURE_PROVIDER, effect: 'allow' }],
      providers: { [FIXTURE_PROVIDER]: {
        name: 'TED A/B fixture (dummy apiKey)', package: FIXTURE_PACKAGE,
        settings: { baseURL: mode === 'A' ? fakeBase : stubUrl, apiKey: 'test-fixture-not-a-real-secret' },
        models: { [FIXTURE_MODEL]: fixtureModel(FIXTURE_MODEL) } } },
    };
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    fs.writeFileSync(path.join(iso.dirs.config, 'opencode.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const sdk = await import('@opencode/sdk');
    const oc = await sdk.OpenCode.create({ config: { directory: iso.dirs.config, project: false }, database: { path: iso.dirs.db } });
    try {
      await wirePlugin(oc, defineTedFinancePlugin(() => makeFakeTransport(transportLog)));
      if (mode === 'A') await wirePlugin(oc, defineHookRewritePlugin(counters, fakeBase, stubUrl));

      const created = await oc.session.create({ title: 'tedab', agent: 'ted' });
      assert.ok(created && typeof created.id === 'string' && created.id.length > 0, 'native session created');
      const sessionID = created.id;
      bindSession(sessionID, { label: 'tedab', token: 'test-token-not-a-real-secret', household: 'H_TEDAB', actorId: 'actor-tedab', deviceId: 'dev-tedab' });

      // One turn, no retry/fallback. A: prompt host + hook. B: native only.
      let output;
      if (mode === 'A') {
        const res = await createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250 })
          .chat({ sessionID, text: USER_MESSAGE, intentionId: 'ted-ab-01-a' });
        output = res.output;
      } else {
        const admitted = await oc.session.prompt({ sessionID, text: USER_MESSAGE });
        const admittedId = admitted && typeof admitted.id === 'string' ? admitted.id : '';
        assert.ok(admittedId.length > 0, 'native prompt admitted');
        const deadline = Date.now() + 90000;
        let text = '';
        for (;;) {
          await waitIdle(oc, sessionID); // settle slice; re-read below
          const page = await oc.message.list({ sessionID, limit: 50, order: 'asc' });
          text = assistantTextAfter(Array.isArray(page) ? page : (page && page.data) || [], admittedId);
          if (text.trim().length > 0) break;
          if (Date.now() >= deadline) break;
        }
        output = text;
      }

      const got = await oc.session.get({ sessionID });
      assert.equal(got && got.id, sessionID, 'session persists');
      const listed = await oc.message.list({ sessionID, limit: 50, order: 'asc' });
      const rows = Array.isArray(listed) ? listed : listed && listed.data;
      assert.ok(Array.isArray(rows) && rows.some((m) => m && m.type === 'user' && m.text === USER_MESSAGE), 'history preserves the user message');
      assert.ok(Array.isArray(rows) && rows.some((m) => m && m.type === 'assistant'), 'history preserves the assistant turn');
      assert.equal(await waitIdle(oc, sessionID), true, 'session settles idle');

      return {
        mode, sessionID, output,
        counters: { ...counters, statusCounts: { ...counters.statusCounts }, stages: counters.stages.map((s) => ({ ...s })), fetchStages: counters.fetchStages.map((f) => ({ ...f })) },
        transportLog: transportLog.map((t) => ({ ...t })), blocked: fetchBlocked.slice(blockedMark).map((e) => ({ ...e })),
      };
    } finally {
      stub.countersRef.current = stub.modeRef.current = fetchRef.current = null;
      await oc.close().catch(() => {});
    }
  }

  it('Path A (hook-routed) and Path B (native direct) deliver the identical turn', { timeout: 300000 }, async () => {
    const a = await runMode('A');
    const b = await runMode('B');

    // Real SDK/plugin loop; stub-port-only guard; catalog present, nothing external.
    assert.ok(fetchBlocked.some((e) => e.destination === 'sdk_catalog'), 'catalog blocked');
    for (const entry of fetchBlocked) {
      assert.deepEqual(Object.keys(entry).sort(), ['destination', 'errorCode', 'method', 'reason', 'statusCode'], 'sanitized tuple only');
      assert.equal(entry.reason, 'blocked_preflight', 'pre-flight block');
      assert.deepEqual([entry.statusCode, entry.errorCode], [null, null], 'no observed codes');
      assert.notEqual(entry.destination, 'unexpected_non_loopback', 'nothing external attempted');
    }

    for (const r of [a, b]) {
      // Exact tool flow: 2 GET reads in order, 3 model POSTs, zero writes.
      assert.deepEqual(r.transportLog.map((t) => t.route), [...EXPECTED_ROUTES], `${r.mode}: finance routes`);
      for (const t of r.transportLog) assert.equal(t.method, 'GET', `${r.mode}: GET-only`);
      assert.deepEqual(r.counters.statusCounts, { 200: 3 }, `${r.mode}: 3 model 200s`);
      assert.deepEqual(
        [r.counters.listenerReceived, r.counters.providerReceived, r.counters.responseCompleted],
        [3, 3, 3],
        `${r.mode}: listener/provider/response counters are independently 3/3/3`,
      );
      // Per-request stages: corr 1,2,3, each a model POST completed 200.
      assert.deepEqual(r.counters.stages.map((s) => s.corr), [1, 2, 3], `${r.mode}: corr 1,2,3`);
      for (const s of r.counters.stages) {
        assert.deepEqual(Object.keys(s).sort(), ['corr', 'provider', 'status'], `${r.mode}: sanitized stage only`);
        assert.equal(s.provider, true, `${r.mode}: request ${s.corr} is a model POST`);
        assert.equal(s.status, 200, `${r.mode}: request ${s.corr} status 200`);
      }
      // Allowed fetches are stub-only: exactly the 3 POSTs completed 200.
      assert.deepEqual(r.counters.fetchStages.map((f) => f.seq), [1, 2, 3], `${r.mode}: gapless fetch ordinals`);
      for (const f of r.counters.fetchStages) {
        assert.deepEqual(Object.keys(f).sort(), ['seq', 'statusCode'], `${r.mode}: sanitized fetch record only`);
        assert.equal(f.statusCode, 200, `${r.mode}: fetch completed 200`);
      }
      // Auxiliary boundary from per-mode blocked slices (A-first always).
      const auxBlocked = r.blocked.filter((e) => e.destination === 'fake_provider_base' || e.destination === 'other_loopback');
      if (r.mode === 'A') {
        const sortRows = (rows) => rows.map((row) => JSON.stringify(row)).sort();
        assert.deepEqual(sortRows(auxBlocked.map((e) => [e.method, e.destination])), sortRows([
          ['GET', 'other_loopback'], ['GET', 'other_loopback'], ['GET', 'other_loopback'],
        ]), 'A: auxiliary boundary (non-stub loopback blocked, zero fake-base bypass)');
      } else {
        assert.deepEqual(auxBlocked, [], 'B: zero auxiliary fetches');
      }
      assert.equal(r.output, EXPECTED_FINAL, `${r.mode}: final text matches`);
    }

    assert.deepEqual([a.counters.hookReceived, a.counters.hookCompleted, a.counters.proxyForwarded, a.counters.proxyRejected], [3, 3, 3, 0], 'A: hook 3/3/3/0');
    assert.deepEqual([b.counters.hookReceived, b.counters.hookCompleted, b.counters.proxyForwarded, b.counters.proxyRejected], [0, 0, 0, 0], 'B: hook counters zero');

    assert.equal(a.output, b.output, 'identical output');
    assert.deepEqual(b.transportLog, a.transportLog, 'identical finance routing');

    const diag = JSON.stringify({ a: a.counters, b: b.counters, blocked: fetchBlocked });
    assert.ok(!diag.includes(USER_MESSAGE), 'no prompt in diagnostics');
    assert.ok(!diag.includes(EXPECTED_FINAL), 'no output in diagnostics');
    assert.ok(!diag.includes('test-token-not-a-real-secret'), 'no token in diagnostics');
    assert.ok(!diag.includes('test-fixture-not-a-real-secret'), 'no apiKey in diagnostics');
    assert.ok(!diag.includes('ted-ab-01'), 'no intention id in diagnostics');
  });
});
