// P2 refresh remediation (P2-R-FIX): post-turn history errors are
// history-origin, never prompt failures.
//
// Live evidence (docs/reports/P2-LIVE-CLOSURE-RESULTS.md): one POST
// /rpc/chat 200 with the correct financial answer, followed by GET
// /rpc/history -> 502 prompt.failed and the PWA alert "Não foi possível
// carregar o histórico". The exact raw SDK exception and the live SQLite
// transcript could not be recovered (original OpenCode DB and request/error
// trace absent; opencode.log has no matching entry), so this test injects a
// GENERIC native history-read failure through the message.list seam only —
// it proves the classification boundary (history vs prompt), not the exact
// live SDK fault.
//
// Exercised for real: loopback HTTP gateway (createGatewayServer), the real
// persistent conversation store (createConversationStore over a temp
// persistDir), and the real prompt adapter (createPromptHost). The ONLY seam
// is oc.message.list; session.prompt is a counting double (the one initial
// chat admission) and history must never increment it. No provider, no
// inference, no network beyond loopback.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { HISTORY_UNAVAILABLE_MESSAGE, PromptError, createPromptHost } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/p2-captured-turn.json', import.meta.url), 'utf8'),
);
const T = FIXTURE.capturedTurn;
const ANSWER = FIXTURE.screenshotAnswer.text;

function userRow(id, text, created) {
  return { id, type: 'user', text, time: { created } };
}

function assistantRow(id, text, created) {
  return {
    id, type: 'assistant', agent: 'ted',
    model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
    content: [{ type: 'text', text }], time: { created },
  };
}

// Order-aware message.list double (2.2.4 paging: {order,limit,cursor}).
// `fail.fail === true` simulates the unrecovered live condition: a GENERIC
// native history-read error with no provider keywords (exact raw SDK
// exception unknown — see fixture limitations).
function seamList(allAsc, fail) {
  return async ({ order = 'asc', limit = 50, cursor } = {}) => {
    if (fail.fail) throw new Error('native history read failed: connection reset');
    const lim = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
    let slice;
    let next;
    if (order === 'desc') {
      const rawEnd = cursor === undefined ? allAsc.length : Number(cursor);
      const end = Number.isFinite(rawEnd) ? Math.min(Math.max(rawEnd, 0), allAsc.length) : allAsc.length;
      const start = Math.max(0, end - lim);
      slice = allAsc.slice(start, end).reverse();
      next = start > 0 ? String(start) : null;
    } else {
      const rawStart = cursor === undefined ? 0 : Number(cursor);
      const start = Number.isFinite(rawStart) ? Math.max(rawStart, 0) : 0;
      slice = allAsc.slice(start, start + lim);
      next = start + lim < allAsc.length ? String(start + lim) : null;
    }
    return { data: slice, cursor: { previous: null, next } };
  };
}

// Real prompt adapter over a counting session.prompt double. The double
// admits the fixture turn (synthetic receipt ids from the fixture) and
// materializes the native rows without carrying identifiers from the live run.
function buildOc({ rows, admissions, answer = ANSWER, fail }) {
  return {
    session: {
      prompt: async ({ sessionID, text }) => {
        admissions.count++;
        const now = Date.now();
        rows.push(userRow(T.userMessageId, text, now));
        rows.push(assistantRow(T.turnId, answer, now + 1));
        return {
          id: T.userMessageId, sessionID,
          time: { created: now }, type: 'user',
          payload: { text }, delivery: 'steer',
        };
      },
      interrupt: async () => ({ ok: true }),
    },
    message: { list: seamList(rows, fail) },
  };
}

const IDENTITY = (workspace) => ({
  // Synthetic test-only identity (P2-R-FIX2): never copies actor/device IDs
  // from the live synthetic trace — those stay out of the repo.
  actorId: 'test-actor-p2-refresh',
  workspace,
  role: 'owner',
  deviceId: 'test-device-p2-refresh-01',
  deviceHousehold: workspace,
});

function buildGateway({ store, promptHost, workspace = 'H_P2' }) {
  return createGatewayServer({
    resolveIdentity: async ({ deviceToken }) => {
      if (deviceToken === 'revoked-device') {
        const e = new Error('device revoked');
        e.code = 'auth.device_required';
        throw e;
      }
      return IDENTITY(workspace);
    },
    store,
    promptHost,
    createRuntimeSession: async (identity, conversationId) => ({
      runtimeSessionId: `rt-${conversationId}`,
    }),
    bindAuthenticatedSession: async () => true,
    withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
  });
}

async function listen(gw) {
  const info = await gw.listen({ port: 0, host: '127.0.0.1' });
  return `http://${info.host}:${info.port}`;
}

const CHAT = (ws) => `/agents/finance-chat-agent/${ws}/rpc/chat`;
const HIST = (ws) => `/agents/finance-chat-agent/${ws}/rpc/history`;

describe('P2-R-FIX: post-turn history refresh is history-origin, never a prompt failure', () => {
  it('POST completes; GET history failure is history.unavailable/503 (never prompt.failed/502); recovery returns stable IDs', async () => {
    const persistDir = approvedTmpRoot('ted-p2-refresh');
    const store = createConversationStore({ persistDir });
    const rows = [];
    const admissions = { count: 0 };
    const fail = { fail: false };
    const promptHost = createPromptHost({ oc: buildOc({ rows, admissions, fail }), timeoutMs: 5000 });
    const gw = buildGateway({ store, promptHost });
    const base = await listen(gw);
    const headers = {
      'content-type': 'application/json',
      cookie: 's=a', 'x-device-token': 'dev-P2', 'x-workspace-id': 'H_P2',
    };
    try {
      // 1. The captured turn completes through the real gateway.
      const post = await fetch(`${base}${CHAT('H_P2')}`, {
        method: 'POST', headers,
        body: JSON.stringify({ text: T.approvedText, intentionId: T.intentionId }),
      });
      assert.equal(post.status, 200);
      const dto = await post.json();
      assert.equal(dto.status, 'completed');
      assert.equal(dto.turnId, T.turnId);
      assert.ok(dto.output.includes('R$ 117,50'), 'completed answer carries the captured financial content');
      assert.equal(admissions.count, 1, 'exactly one native prompt admission for the turn');
      const cookie = post.headers.get('set-cookie').split(';')[0];
      const histHeaders = { cookie, 'x-device-token': 'dev-P2', 'x-workspace-id': 'H_P2' };

      // 2. Normal refresh: stable IDs in time order.
      const ok = await fetch(`${base}${HIST('H_P2')}`, { headers: histHeaders });
      assert.equal(ok.status, 200);
      const okDto = await ok.json();
      assert.deepEqual(okDto.items.map((i) => i.id), [T.userMessageId, T.turnId]);
      assert.equal(okDto.items[0].intentionId, T.intentionId);

      // 3. The live failure shape: native history read breaks AFTER the
      // completed turn. Must be typed history-origin (503), NOT a prompt
      // failure (502) — a completed send is never relabeled failed.
      fail.fail = true;
      const broken = await fetch(`${base}${HIST('H_P2')}`, { headers: histHeaders });
      assert.equal(broken.status, 503, 'history-origin failure maps to 503, not 502');
      const brokenDto = await broken.json();
      assert.equal(brokenDto.code, 'history.unavailable');
      assert.equal(brokenDto.message, HISTORY_UNAVAILABLE_MESSAGE, 'generic live failure carries no native text');
      assert.equal(admissions.count, 1, 'GET history never calls session.prompt — the completed turn stands');

      // 4. Source recovers: the SAME stable IDs/order return, no duplication.
      fail.fail = false;
      const recovered = await fetch(`${base}${HIST('H_P2')}`, { headers: histHeaders });
      assert.equal(recovered.status, 200);
      assert.deepEqual((await recovered.json()).items.map((i) => i.id), [T.userMessageId, T.turnId]);
      assert.equal(admissions.count, 1);

      // 5. Gateway reload against the SAME persistDir: the persisted
      // registry reattaches and history returns the same stable pair.
      const store2 = createConversationStore({ persistDir });
      const rows2 = [
        userRow(T.userMessageId, T.approvedText, 1000),
        assistantRow(T.turnId, ANSWER, 1001),
      ];
      const admissions2 = { count: 0 };
      const promptHost2 = createPromptHost({ oc: buildOc({ rows: rows2, admissions: admissions2, fail: { fail: false } }), timeoutMs: 5000 });
      const gw2 = buildGateway({ store: store2, promptHost: promptHost2 });
      const base2 = await listen(gw2);
      try {
        const reloaded = await fetch(`${base2}${HIST('H_P2')}`, { headers: histHeaders });
        assert.equal(reloaded.status, 200);
        assert.deepEqual((await reloaded.json()).items.map((i) => i.id), [T.userMessageId, T.turnId]);
        assert.equal(admissions2.count, 0, 'reload replays from persisted registry + native history — zero new prompts');
      } finally {
        await gw2.close();
      }
    } finally {
      await gw.close();
    }
  });

  it('genuine session.prompt failures keep prompt.failed/502 — the chat path is untouched', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p2-chatfail') });
    let prompts = 0;
    const promptHost = {
      chat: async () => { prompts++; throw Object.assign(new Error('engine exploded'), { code: 'prompt.failed' }); },
      readHistory: async () => [],
      readRawMessages: async () => [],
    };
    const gw = buildGateway({ store, promptHost });
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}${CHAT('H_P2')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
        body: JSON.stringify({ text: 'oi?', intentionId: 'genuine-1' }),
      });
      assert.equal(res.status, 502, 'genuine prompt-path failures stay 502');
      assert.equal((await res.json()).code, 'prompt.failed');
      assert.equal(prompts, 1);
    } finally {
      await gw.close();
    }
  });

  it('absent message surface is history.unavailable/503 with a fixed safe message (never provider.unavailable, never native detail)', async () => {
    // No message.list on the host at all: a history-surface gap, not a
    // provider gap. Must stay history-origin with a fixed client message.
    // (The chat turn itself needs the surface to observe output, so this
    // test exercises the history path via the no-pin bootstrap, which mints
    // a conversation without any native use.)
    const oc = {
      session: {
        prompt: async ({ sessionID, text }) => ({
          id: 'u-nosurf', sessionID, time: { created: 1 }, type: 'user',
          payload: { text }, delivery: 'steer',
        }),
        interrupt: async () => ({ ok: true }),
      },
    };
    const promptHost = createPromptHost({ oc, timeoutMs: 2000 });
    const direct = await promptHost.readHistory({ sessionID: 'rt-x' }).catch((e) => e);
    assert.equal(direct.code, 'history.unavailable', 'unit: absent surface is history-origin');
    assert.equal(direct.message, HISTORY_UNAVAILABLE_MESSAGE, 'unit: fixed safe message');
    const directRaw = await promptHost.readRawMessages({ sessionID: 'rt-x' }).catch((e) => e);
    assert.equal(directRaw.code, 'history.unavailable', 'unit: raw read is history-origin too');

    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p2-nosurf') });
    const gw = buildGateway({ store, promptHost });
    const base = await listen(gw);
    try {
      // No-pin bootstrap: mints the conversation, no native use, empty items.
      const fresh = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(fresh.status, 200);
      assert.deepEqual((await fresh.json()).items, []);
      const cookie = fresh.headers.get('set-cookie').split(';')[0];
      const hist = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(hist.status, 503, 'absent history surface maps to 503, not 502');
      const dto = await hist.json();
      assert.equal(dto.code, 'history.unavailable');
      assert.equal(dto.message, HISTORY_UNAVAILABLE_MESSAGE, 'fixed safe message, no native detail');
    } finally {
      await gw.close();
    }
  });

  it('missing native session after registry lookup normalizes to history-origin 503 on GET (never 502, never native detail)', async () => {
    const persistDir = approvedTmpRoot('ted-p2-missingsess');
    const store = createConversationStore({ persistDir });
    const rows = [userRow(T.userMessageId, T.approvedText, 1000)];
    const admissions = { count: 0 };
    const promptHost = createPromptHost({ oc: buildOc({ rows, admissions, fail: { fail: false } }), timeoutMs: 5000 });
    const gw = createGatewayServer({
      resolveIdentity: async () => IDENTITY('H_P2'),
      store,
      promptHost,
      createRuntimeSession: async (identity, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
      bindAuthenticatedSession: async () => true,
      // Native session gone after the registry lookup (e.g. missing native
      // session): an UNTYPED failure carrying native detail that must never
      // reach the browser and never become prompt.failed/502 on the history
      // path. (The chat path itself is untouched by P2-R-FIX2: an
      // establishment failure before any admission stays a generic 502 there —
      // only the history read normalizes to history-origin 503.)
      withAuthenticatedSession: async () => {
        throw new Error('native session ses_secret-9f3 missing: connection reset at 10.0.0.9');
      },
    });
    const base = await listen(gw);
    try {
      const headers = { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_P2' };
      const post = await fetch(`${base}${CHAT('H_P2')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: T.approvedText, intentionId: T.intentionId }),
      });
      assert.equal(post.status, 502, 'chat-path establishment failure stays out of history scope (untouched)');
      assert.equal((await post.json()).code, 'gateway.upstream_error');
      const cookie = post.headers.get('set-cookie').split(';')[0];
      const hist = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(hist.status, 503, 'missing native session on GET history is history-origin 503');
      const dto = await hist.json();
      assert.equal(dto.code, 'history.unavailable');
      assert.equal(dto.message, HISTORY_UNAVAILABLE_MESSAGE, 'fixed safe message');
      assert.ok(!String(dto.message).includes('ses_secret-9f3'), 'no native session id leaks');
      assert.ok(!String(dto.message).includes('10.0.0.9'), 'no transport detail leaks');
      assert.ok(!String(dto.message).includes('connection reset'), 'no native error text leaks');
    } finally {
      await gw.close();
    }
  });

  it('binding quarantine on the history path stays 409 typed and never reaches the native read', async () => {
    // Binding revocation/quarantine (safe-wrapper level) is distinct from
    // device-token revocation (identity level, 401): identity + visibility
    // checks pass, then the wrapper refuses with the typed quarantine code.
    // The gateway must preserve 409 + code and never touch native history
    // (no read) nor admit a prompt.
    const persistDir = approvedTmpRoot('ted-p2-quarantine');
    const store = createConversationStore({ persistDir });
    let prompts = 0;
    let reads = 0;
    const oc = {
      session: {
        prompt: async ({ sessionID, text }) => {
          prompts++;
          return {
            id: 'u-q', sessionID, time: { created: 1 }, type: 'user',
            payload: { text }, delivery: 'steer',
          };
        },
        interrupt: async () => ({ ok: true }),
      },
      message: {
        list: async () => {
          reads++;
          return { data: [], cursor: { previous: null, next: null } };
        },
      },
    };
    const promptHost = createPromptHost({ oc, timeoutMs: 2000 });
    const gw = createGatewayServer({
      resolveIdentity: async () => IDENTITY('H_P2'),
      store,
      promptHost,
      createRuntimeSession: async (identity, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
      bindAuthenticatedSession: async () => true,
      withAuthenticatedSession: async () => {
        throw Object.assign(
          new Error('session was quarantined after a busy timeout — it may still be running with a stale host; open a new conversation'),
          { code: 'host_binding_quarantined' },
        );
      },
    });
    const base = await listen(gw);
    try {
      // Bootstrap the conversation first (no native use), then hit the
      // quarantined wrapper with the pin.
      const fresh = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(fresh.status, 200);
      const cookie = fresh.headers.get('set-cookie').split(';')[0];
      const hist = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(hist.status, 409, 'quarantined binding stays 409, never 503/502');
      assert.equal((await hist.json()).code, 'host_binding_quarantined');
      assert.equal(reads, 0, 'quarantine never reaches promptHost.readHistory');
      assert.equal(prompts, 0, 'quarantine never admits a session.prompt');
    } finally {
      await gw.close();
    }
  });

  it('wrong-origin typed failure on the history path reclassifies to history.unavailable/503', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p2-wrongorigin') });
    const promptHost = {
      chat: async () => ({ turnId: 'a-wrong', output: 'ok', userMessageId: 'u-wrong' }),
      // A history double that throws a prompt-execution code (the exact
      // P2-R-FIX2 wrong-origin shape): the gateway must reclassify it.
      readHistory: async () => { throw new PromptError('prompt.failed', 'prompt failed: native history read failed: connection reset'); },
      readRawMessages: async () => { throw new PromptError('provider.unavailable', 'no provider route for this prompt'); },
    };
    const gw = buildGateway({ store, promptHost });
    const base = await listen(gw);
    try {
      const headers = { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_P2' };
      const post = await fetch(`${base}${CHAT('H_P2')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'oi?', intentionId: 'wrongorigin-setup' }),
      });
      assert.equal(post.status, 200);
      const cookie = post.headers.get('set-cookie').split(';')[0];
      const hist = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(hist.status, 503, 'prompt.failed on GET reclassifies to history-origin 503');
      const dto = await hist.json();
      assert.equal(dto.code, 'history.unavailable');
      assert.equal(dto.message, HISTORY_UNAVAILABLE_MESSAGE, 'reclassified failure carries the fixed message');
      assert.ok(!String(dto.message).includes('connection reset'), 'no native error text leaks');
    } finally {
      await gw.close();
    }
  });

  it('delayed assistant persistence completes the SAME turn with exactly one session.prompt', async () => {
    // Delayed native history: the admitted user row is visible immediately,
    // the assistant row lands during that SAME chat() polling (deterministic
    // read-count transition — no timers, no second admission). Covers the
    // user-criterion gap "failure between response and persistence" as delayed
    // native history visibility (no persistence fault injection: the native
    // transcript is the only store, so a not-yet-visible assistant IS the
    // failure shape).
    const created = 1000;
    const userOnly = [userRow('u-delayed', 'contas?', created)];
    const full = [...userOnly, assistantRow('a-delayed', 'ATRASADA R$ 10,00', created + 1)];
    let reads = 0;
    const LAND_AFTER_READS = 3; // assistant row becomes visible on this read
    const admissions = { count: 0 };
    const oc = {
      session: {
        prompt: async ({ sessionID, text }) => {
          admissions.count++;
          return {
            id: 'u-delayed', sessionID, time: { created }, type: 'user',
            payload: { text }, delivery: 'steer',
          };
        },
        interrupt: async () => ({ ok: true }),
      },
      message: {
        list: async ({ order = 'asc', limit = 50, cursor } = {}) => {
          reads++;
          const allAsc = reads >= LAND_AFTER_READS ? full : userOnly;
          const lim = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
          let slice;
          let next;
          if (order === 'desc') {
            const rawEnd = cursor === undefined ? allAsc.length : Number(cursor);
            const end = Number.isFinite(rawEnd) ? Math.min(Math.max(rawEnd, 0), allAsc.length) : allAsc.length;
            const start = Math.max(0, end - lim);
            slice = allAsc.slice(start, end).reverse();
            next = start > 0 ? String(start) : null;
          } else {
            const rawStart = cursor === undefined ? 0 : Number(cursor);
            const start = Number.isFinite(rawStart) ? Math.max(rawStart, 0) : 0;
            slice = allAsc.slice(start, start + lim);
            next = start + lim < allAsc.length ? String(start + lim) : null;
          }
          return { data: slice, cursor: { previous: null, next } };
        },
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000, pollIntervalMs: 10 });
    const out = await host.chat({ sessionID: 'ses_delay', text: 'contas?', intentionId: 'delayed-same-turn' });
    assert.equal(out.output, 'ATRASADA R$ 10,00');
    assert.equal(out.turnId, 'a-delayed');
    assert.equal(out.userMessageId, 'u-delayed');
    assert.equal(admissions.count, 1, 'persistence delay completes the same turn — exactly one session.prompt');
    assert.ok(reads >= LAND_AFTER_READS, 'assistant row landed during the same chat() polling');
  });

  it('assistant never persisted yields prompt.no_output, never completed success, with exactly one prompt', async () => {
    // Impatient sibling of the delayed-persistence case: the assistant row
    // never lands within the deadline. Typed failure, never a completed
    // success with fabricated output — and still exactly one admission.
    const created = 1000;
    const admissions = { count: 0 };
    const oc = {
      session: {
        prompt: async ({ sessionID, text }) => {
          admissions.count++;
          return {
            id: 'u-impatient', sessionID, time: { created }, type: 'user',
            payload: { text }, delivery: 'steer',
          };
        },
        interrupt: async () => ({ ok: true }),
      },
      message: {
        list: async () => ({
          data: [userRow('u-impatient', 'contas?', created)],
          cursor: { previous: null, next: null },
        }),
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 300, pollIntervalMs: 50 });
    const err = await host.chat({ sessionID: 'ses_impatient', text: 'contas?', intentionId: 'impatient-1' }).catch((e) => e);
    assert.equal(err.code, 'prompt.no_output', 'no assistant yet persisted is a typed failure, never empty success');
    assert.equal(admissions.count, 1, 'exactly one session.prompt even on the no-output path');
  });

  it('two consecutive turns mint two prompts; missing/cross/foreign history stays 404/403; revoked device stays 401', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p2-neg') });
    const rows = [];
    let n = 0;
    const oc = {
      session: {
        prompt: async ({ sessionID, text }) => {
          n++;
          const u = `u-${n}`;
          const a = `a-${n}`;
          rows.push(userRow(u, text, n * 2), assistantRow(a, `ans-${n}`, n * 2 + 1));
          return { id: u, sessionID, time: { created: n }, type: 'user', payload: { text }, delivery: 'steer' };
        },
        interrupt: async () => ({ ok: true }),
      },
      message: { list: seamList(rows, { fail: false }) },
    };
    const promptHost = createPromptHost({ oc, timeoutMs: 5000 });
    const gw = buildGateway({ store, promptHost });
    const base = await listen(gw);
    try {
      const headers = { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_P2' };
      const first = await fetch(`${base}${CHAT('H_P2')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'um?', intentionId: 'two-1' }),
      });
      assert.equal(first.status, 200);
      const cookie = first.headers.get('set-cookie').split(';')[0];
      const second = await fetch(`${base}${CHAT('H_P2')}`, {
        method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ text: 'dois?', intentionId: 'two-2' }),
      });
      assert.equal(second.status, 200);
      assert.equal(n, 2, 'two distinct intentions mint two native prompts');
      const hist = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(hist.status, 200);
      assert.deepEqual((await hist.json()).items.map((i) => i.id), ['u-1', 'a-1', 'u-2', 'a-2']);

      // Unknown pin: 404, no oracle.
      const missing = await fetch(`${base}${HIST('H_P2')}`, {
        headers: {
          cookie: 'ted-runtime-conversation=opencode.00000000-0000-4000-8000-000000000000',
          'x-device-token': 'd', 'x-workspace-id': 'H_P2',
        },
      });
      assert.equal(missing.status, 404);
      // Cross-workspace path with an H_P2 pin: 403.
      const cross = await fetch(`${base}${HIST('H_OTHER')}`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_OTHER' },
      });
      assert.equal(cross.status, 403);
      // Revoked device credential: 401 before any native use.
      const revoked = await fetch(`${base}${HIST('H_P2')}`, {
        headers: { cookie, 'x-device-token': 'revoked-device', 'x-workspace-id': 'H_P2' },
      });
      assert.equal(revoked.status, 401);
      assert.equal(n, 2, 'denied history never prompts');
    } finally {
      await gw.close();
    }
  });
});
