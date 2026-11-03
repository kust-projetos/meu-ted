// P1 gateway server tests (loopback HTTP, doubles only).
// Proves PWA-shape compat: chat → {turnId,intentionId,status,output} only
// on success; history → {items:[...]}; session/new → renewal DTO + opaque
// B cookie. A0 sentinel fails closed (no fallback), invalid B cookies are
// cleared scoped, cross-workspace is forbidden, unknown routes are 404,
// oversized bodies are 413, and no response carries secrets or native ids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { projectHistoryItems } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function harness({ identity = { actorId: 'actor-A', workspace: 'H_A', role: 'owner', deviceId: 'dev-A', deviceHousehold: 'H_A' }, chatImpl = null, readHistoryImpl = null, readRawImpl = null, taps = null, requestTimeoutMs = undefined } = {}) {
  const store = createConversationStore({ persistDir: approvedTmpRoot('ted-srv') });
  const promptCalls = [];
  const bindCalls = [];
  const rawCalls = [];
  const promptHost = {
    chat: chatImpl ?? (async ({ sessionID, text, intentionId, signal }) => {
      promptCalls.push({ sessionID, text, intentionId, signal });
      return { turnId: `turn-${intentionId}`, output: `answer:${text}` };
    }),
    readHistory: readHistoryImpl ?? (async ({ sessionID, ownerActor }) => [
      { id: 'h1', actorId: ownerActor, role: 'user', content: 'oi', createdAt: 't1', isOwn: true },
      { id: 'h2', actorId: 'ted', role: 'assistant', content: 'olá', createdAt: 't2', isOwn: false },
    ]),
    readRawMessages: readRawImpl ?? (async ({ sessionID }) => {
      rawCalls.push(sessionID);
      return [];
    }),
  };
  const runtimeCalls = [];
  const gw = createGatewayServer({
    resolveIdentity: async ({ cookie, deviceToken, workspaceId }) => {
      taps?.order?.push('identity');
      if (deviceToken === 'bad-device') {
        const e = new Error('device invalid');
        e.code = 'auth.device_required';
        throw e;
      }
      return { ...identity, workspace: workspaceId === 'H_OTHER' ? 'H_OTHER' : identity.workspace };
    },
    store: (() => {
      if (!taps?.order) return store;
      const order = taps.order;
      const rawGet = store.get.bind(store);
      return { ...store, get: (...a) => { order.push('metadata'); return rawGet(...a); } };
    })(),
    promptHost: (() => {
      if (!taps?.order) return promptHost;
      const order = taps.order;
      const rawChat = promptHost.chat.bind(promptHost);
      return { ...promptHost, chat: async (a) => { order.push('prompt'); return rawChat(a); } };
    })(),
    createRuntimeSession: async (idn, conversationId) => {
      runtimeCalls.push({ workspace: idn.workspace, conversationId });
      return { runtimeSessionId: `rt-${conversationId}` };
    },
    bindAuthenticatedSession: async (sessionID, host) => {
      taps?.order?.push('rebind-legacy');
      bindCalls.push({ sessionID, household: host?.household, actorId: host?.actorId, hasToken: typeof host?.token === 'string' && host.token.length > 0 });
      return true;
    },
    withAuthenticatedSession: async (sessionID, host, fn) => {
      taps?.order?.push('rebind');
      bindCalls.push({ sessionID, household: host?.household, actorId: host?.actorId, hasToken: typeof host?.token === 'string' && host.token.length > 0 });
      return await fn();
    },
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  return { store, gw, promptCalls, runtimeCalls, bindCalls, rawCalls };
}

async function listen(gw) {
  const info = await gw.listen({ port: 0, host: '127.0.0.1' });
  return `http://${info.host}:${info.port}`;
}

const CHAT = (ws) => `/agents/finance-chat-agent/${ws}/rpc/chat`;

describe('gateway server (loopback PWA shapes)', () => {
  it('chat without cookie creates a B session, sets the scoped B cookie, returns the PWA turn DTO', async () => {
    const { gw, promptCalls } = harness();
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'better-auth.session_token=s',
          'x-device-token': 'dev-tok-A',
          'x-workspace-id': 'H_A',
        },
        body: JSON.stringify({ text: 'Quais contas?', intentionId: 'm-1' }),
      });
      assert.equal(res.status, 200);
      const dto = await res.json();
      assert.deepEqual(Object.keys(dto).sort(), ['intentionId', 'output', 'status', 'turnId']);
      assert.equal(dto.status, 'completed');
      assert.equal(dto.intentionId, 'm-1');
      assert.ok(dto.output.includes('Quais contas?'));
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie && setCookie.includes('ted-runtime-conversation=opencode.'), setCookie);
      assert.ok(setCookie.includes('Path=/api/agent/agents/finance-chat-agent/H_A/rpc'));
      assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'));
      assert.ok(!setCookie.includes('rt-'), 'native runtimeSessionId never in the cookie');
      assert.equal(promptCalls.length, 1);
      assert.ok(!JSON.stringify(dto).includes('dev-tok-A'), 'no device secret in the DTO');
    } finally {
      await gw.close();
    }
  });

  it('B pipeline order is identity → metadata → rebind → prompt (never raw oc over HTTP)', async () => {
    const order = [];
    const { gw, promptCalls, bindCalls } = harness({ taps: { order } });
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 's=a', 'x-device-token': 'dev-A', 'x-workspace-id': 'H_A',
        },
        body: JSON.stringify({ text: 'ordem?', intentionId: 'ord-1' }),
      });
      assert.equal(res.status, 200);
      // Exact expected sequence: identity, metadata (store.get inside turn), rebind, prompt.
      assert.deepEqual(order, ['identity', 'metadata', 'rebind', 'prompt']);
      assert.equal(promptCalls.length, 1);
      assert.equal(bindCalls.length, 1);
      assert.equal(bindCalls[0].household, 'H_A');
      assert.equal(bindCalls[0].actorId, 'actor-A');
      assert.equal(bindCalls[0].hasToken, true);
      assert.ok(!JSON.stringify(bindCalls[0]).includes('dev-A'), 'device secret value never recorded');
    } finally {
      await gw.close();
    }
  });

  it('completed intention replays from native history after a restart without a second prompt', async () => {
    const rows = [
      { id: 'u_re', type: 'user', text: 'contas?', time: { created: 100 } },
      { id: 'a_re', type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text: 'answer:contas?' }], time: { created: 101 } },
    ];
    const promptCalls1 = [];
    const { store, gw } = harness({
      chatImpl: async ({ text, intentionId }) => {
        promptCalls1.push(intentionId);
        return { turnId: 'a_re', output: 'answer:contas?', userMessageId: 'u_re' };
      },
      readRawImpl: async () => rows,
    });
    const base1 = await listen(gw);
    let cookie;
    try {
      const first = await fetch(`${base1}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'contas?', intentionId: 're-1' }),
      });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).output, 'answer:contas?');
      assert.equal(promptCalls1.length, 1);
      cookie = first.headers.get('set-cookie').split(';')[0];
    } finally {
      await gw.close();
    }
    // Simulated restart: FRESH prompt host (zero calls) over the SAME store.
    const promptCalls2 = [];
    const { createConversationStore } = await import('../src/conversations.mjs');
    void createConversationStore;
    const gw2 = createGatewayServer({
      resolveIdentity: async () => ({ actorId: 'actor-A', workspace: 'H_A', role: 'owner', deviceId: 'dev-A', deviceHousehold: 'H_A' }),
      store,
      promptHost: {
        chat: async () => { promptCalls2.push(1); throw Object.assign(new Error('must not prompt'), { code: 'prompt.duplicate' }); },
        readHistory: async () => [],
        readRawMessages: async () => rows,
      },
      createRuntimeSession: async (idn, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
      bindAuthenticatedSession: async () => true,
      withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
    });
    const base2 = await listen(gw2);
    try {
      const retry = await fetch(`${base2}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'contas?', intentionId: 're-1' }),
      });
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).output, 'answer:contas?');
      assert.equal(promptCalls2.length, 0, 'native prompt never issued twice — replay came from persisted intention + native history');
    } finally {
      await gw2.close();
    }
  });

  it('pending admitted-but-incomplete returns typed in-progress without resubmitting', async () => {
    const promptCalls = [];
    const { store, gw } = harness({
      chatImpl: async ({ intentionId }) => { promptCalls.push(intentionId); throw Object.assign(new Error('nope'), { code: 'prompt.no_output' }); },
      readRawImpl: async () => [
        { id: 'u_pend', type: 'user', text: 'e aí?', time: { created: 50 } },
      ],
    });
    const base = await listen(gw);
    try {
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'e aí?', intentionId: 'pend-9' }),
      });
      assert.equal(first.status, 502);
      const cookie = first.headers.get('set-cookie').split(';')[0];
      // Mark admitted-but-incomplete (prompt reached native, no answer yet).
      const convId = cookie.replace('ted-runtime-conversation=opencode.', '');
      store.settleIntention(convId, 'pend-9', { userMessageId: 'u_pend' });
      const retry = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'e aí?', intentionId: 'pend-9' }),
      });
      assert.equal(retry.status, 409);
      assert.equal((await retry.json()).code, 'prompt.in_progress');
      assert.equal(promptCalls.length, 1, 'exactly one native prompt for one intention');
    } finally {
      await gw.close();
    }
  });

  it('session/new validates the previous B pin: foreign pins are not echoed or used', async () => {
    const { gw } = harness();
    const base = await listen(gw);
    try {
      const headers = { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' };
      const first = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, { method: 'POST', headers, body: JSON.stringify({}) });
      assert.equal(first.status, 200);
      const conv1 = (await first.json()).sessionId;
      const cookie1 = first.headers.get('set-cookie').split(';')[0];
      const second = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, {
        method: 'POST', headers: { ...headers, cookie: cookie1 }, body: JSON.stringify({}),
      });
      assert.equal(second.status, 200);
      const dto2 = await second.json();
      assert.equal(dto2.previousSessionId, conv1, 'same-identity previous pin is echoed');
      assert.notEqual(dto2.sessionId, conv1, 'a new opaque id is issued');
      // Foreign workspace pin: validated, not echoed, not used — still creates.
      const third = await fetch(`${base}/agents/finance-chat-agent/H_OTHER/rpc/session/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${cookie1}`, 'x-device-token': 'd', 'x-workspace-id': 'H_OTHER' },
        body: JSON.stringify({}),
      });
      assert.equal(third.status, 200);
      const dto3 = await third.json();
      assert.equal(dto3.previousSessionId, null, 'foreign previous pin is not echoed');
      assert.notEqual(dto3.sessionId, conv1, 'foreign previous pin is not reused');
    } finally {
      await gw.close();
    }
  });

  it('fresh chat sets the scoped B cookie even on typed prompt errors (retry reuses the conversation)', async () => {
    const { gw } = harness({
      chatImpl: async () => { throw Object.assign(new Error('admitted but silent'), { code: 'prompt.no_output' }); },
    });
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'oi?', intentionId: 'err-1' }),
      });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, 'prompt.no_output');
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie && setCookie.includes('ted-runtime-conversation=opencode.'), `B cookie set on typed error: ${setCookie}`);
    } finally {
      await gw.close();
    }
  });

  it('history rebinds before the native read; a foreign actor never reaches native', async () => {
    const { store, gw, bindCalls } = harness();
    const base = await listen(gw);
    const headers = { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' };
    try {
      const created = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'oi', intentionId: 'm-h1' }),
      });
      assert.equal(created.status, 200);
      const cookie = created.headers.get('set-cookie').split(';')[0];
      bindCalls.length = 0;
      const hist = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/history`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
      });
      assert.equal(hist.status, 200);
      assert.equal(bindCalls.length, 1, 'history rebinds before the native read');
      assert.ok(String(bindCalls[0].sessionID).startsWith('rt-'));
    } finally {
      await gw.close();
    }
    // Foreign actor B on A's private conversation: 404, no rebind, no native read.
    const { createConversationStore } = await import('../src/conversations.mjs');
    void createConversationStore;
    const gwB = createGatewayServer({
      resolveIdentity: async () => ({ actorId: 'actor-B', workspace: 'H_A', role: 'member', deviceId: 'dev-B', deviceHousehold: 'H_A' }),
      store,
      promptHost: {
        chat: async () => { throw new Error('must not prompt'); },
        readHistory: async () => { throw new Error('must not read'); },
        readRawMessages: async () => { throw new Error('must not read'); },
      },
      createRuntimeSession: async () => { throw new Error('must not create'); },
      bindAuthenticatedSession: async () => { throw new Error('must not rebind'); },
      withAuthenticatedSession: async () => { throw new Error('must not rebind'); },
    });
    const baseB = await listen(gwB);
    try {
      // Make the conversation private first (owner-only).
      const { createConversationStore: _c } = await import('../src/conversations.mjs');
      void _c;
      const priv = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A', visibility: 'private' });
      const { serializeConversationCookie } = await import('../src/conversations.mjs');
      const privCookie = `${serializeConversationCookie('H_A', priv.conversationId).split(';')[0]}`;
      const resB = await fetch(`${baseB}/agents/finance-chat-agent/H_A/rpc/history`, {
        headers: { cookie: privCookie, 'x-device-token': 'dev-B', 'x-workspace-id': 'H_A' },
      });
      assert.equal(resB.status, 404);
    } finally {
      await gwB.close();
    }
  });

  it('client abort cancels the turn (signal aborts) without a stale write; server stays up', async () => {
    let observed = null;
    const { gw } = harness({
      chatImpl: async ({ signal, intentionId, text }) => {
        if (intentionId === 'abort-2') return { turnId: 't2', output: `answer:${text}` };
        observed = signal;
        await new Promise((resolve, reject) => {
          if (signal?.aborted) { reject(Object.assign(new Error('gone'), { code: 'prompt.cancelled' })); return; }
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('gone'), { code: 'prompt.cancelled' })), { once: true });
        });
      },
    });
    const base = await listen(gw);
    try {
      const controller = new AbortController();
      const pending = fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'longa?', intentionId: 'abort-1' }),
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      await assert.rejects(() => pending, /abort|aborted/i);
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(observed, 'prompt host received a signal');
      assert.equal(observed.aborted, true, 'client disconnect aborted the turn signal');
      // Server still serves afterwards.
      const next = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'depois?', intentionId: 'abort-2' }),
      });
      assert.equal(next.status, 200);
    } finally {
      await gw.close();
    }
  });

  it('request timeout maps to 504 while the socket stays usable', async () => {
    const { gw } = harness({
      chatImpl: async () => { await new Promise(() => {}); },
      requestTimeoutMs: 150,
    });
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'lenta?', intentionId: 'tmo-1' }),
      });
      assert.equal(res.status, 504, 'timeout maps to 504 on a usable socket');
      assert.equal((await res.json()).code, 'gateway.timeout');
    } finally {
      await gw.close();
    }
  });

  it('repeat intentionId in the same conversation replays/409 without a second native prompt', async () => {
    let calls = 0;
    const seen = new Set();
    const { gw, store } = harness({
      chatImpl: async ({ intentionId, text, sessionID, signal }) => {
        calls++;
        if (seen.has(intentionId)) {
          const e = new Error('dup');
          e.code = 'prompt.duplicate';
          throw e;
        }
        seen.add(intentionId);
        return { turnId: `t-${intentionId}`, output: `answer:${text}` };
      },
    });
    // Expose the store-backed prompt doubles with replay support for this
    // test: the harness stub above is intention-aware; the gateway's
    // persisted intention registry is authoritative across restarts.
    const base = await listen(gw);
    try {
      const headers = {
        'content-type': 'application/json',
        cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
      };
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'x?', intentionId: 'stable-9' }),
      });
      assert.equal(first.status, 200);
      const cookie = first.headers.get('set-cookie').split(';')[0];
      const second = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...headers, cookie },
        body: JSON.stringify({ text: 'x?', intentionId: 'stable-9' }),
      });
      // Completed intentions never issue a second native prompt: the gateway
      // replays from native history when correlatable, otherwise 409.
      assert.ok(second.status === 200 || second.status === 409, `expected replay or 409, got ${second.status}`);
      if (second.status === 409) {
        assert.equal((await second.json()).code, 'prompt.duplicate');
      }
      assert.equal(calls, 1, 'exactly one native prompt for one intention (no second prompt on retry)');
    } finally {
      await gw.close();
    }
  });

  it('lost first response (no B cookie on retry) resolves the same conversation — one session, one prompt', async () => {
    let prompts = 0;
    const { gw, runtimeCalls } = harness({
      chatImpl: async ({ intentionId, text }) => {
        prompts++;
        return { turnId: `t-${intentionId}`, output: `answer:${text}`, userMessageId: `u-${intentionId}` };
      },
      readRawImpl: async () => [
        { id: 'u-lost-1', type: 'user', text: 'perdida?', time: { created: 100 } },
        { id: 't-lost-1', type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text: 'answer:perdida?' }], time: { created: 101 } },
      ],
    });
    const base = await listen(gw);
    try {
      const headers = {
        'content-type': 'application/json',
        cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
      };
      // First attempt succeeds server-side; the client LOSES the response
      // (and its Set-Cookie) — the cookie is deliberately discarded here.
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'perdida?', intentionId: 'lost-1' }),
      });
      assert.equal(first.status, 200);
      assert.ok(first.headers.get('set-cookie')?.includes('ted-runtime-conversation=opencode.'));
      // Retry with NO B cookie (as if the first Set-Cookie never arrived).
      const retry = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'perdida?', intentionId: 'lost-1' }),
      });
      assert.equal(retry.status, 200, 'lost-cookie retry replays the first turn');
      assert.equal((await retry.json()).output, 'answer:perdida?');
      assert.equal(prompts, 1, 'exactly one native prompt across the lost-cookie retry');
      assert.equal(runtimeCalls.length, 1, 'exactly one native session minted (first-writer-wins index)');
      assert.ok(retry.headers.get('set-cookie')?.includes('ted-runtime-conversation=opencode.'), 'retry re-issues the same B pin');
    } finally {
      await gw.close();
    }
  });

  it('workspace collective history carries PWA intentionIds and per-author actors (private still denies)', async () => {
    const nativeRows = [];
    let now = 1000;
    const chatImpl = async ({ intentionId, text }) => {
      const u = `u-${intentionId}`;
      const a = `a-${intentionId}`;
      nativeRows.push({ id: u, type: 'user', text, time: { created: now++ } });
      nativeRows.push({ id: a, type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text: `answer:${text}` }], time: { created: now++ } });
      return { turnId: a, output: `answer:${text}`, userMessageId: u };
    };
    const readHistoryImpl = async ({ ownerActor, userMeta, viewerActor }) =>
      projectHistoryItems([...nativeRows], { ownerActor, userMeta, viewerActor });
    const { store, gw } = harness({ chatImpl, readHistoryImpl });
    const base = await listen(gw);
    const headersA = { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' };
    try {
      // Member A opens the workspace-visible conversation.
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers: headersA, body: JSON.stringify({ text: 'from A', intentionId: 'm-A' }),
      });
      assert.equal(first.status, 200);
      const cookieA = first.headers.get('set-cookie').split(';')[0];
      const convA = cookieA.replace('ted-runtime-conversation=opencode.', '');
      // Member B (same canonical workspace) chats on the same pin.
      const gwB = createGatewayServer({
        resolveIdentity: async () => ({ actorId: 'actor-B', workspace: 'H_A', role: 'member', deviceId: 'dev-B', deviceHousehold: 'H_A' }),
        store,
        promptHost: {
          chat: chatImpl,
          readHistory: readHistoryImpl,
          readRawMessages: async () => [...nativeRows],
        },
        createRuntimeSession: async (idn, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
        bindAuthenticatedSession: async () => true,
        withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
      });
      const baseB = await listen(gwB);
      try {
        const headersB = { 'content-type': 'application/json', cookie: cookieA, 'x-device-token': 'd', 'x-workspace-id': 'H_A' };
        const second = await fetch(`${baseB}${CHAT('H_A')}`, {
          method: 'POST', headers: headersB, body: JSON.stringify({ text: 'from B', intentionId: 'm-B' }),
        });
        assert.equal(second.status, 200);
        // History as B: each user message keeps its own author + PWA id.
        const hist = await fetch(`${baseB}/agents/finance-chat-agent/H_A/rpc/history`, { headers: headersB });
        assert.equal(hist.status, 200);
        const dto = await hist.json();
        assert.ok(!JSON.stringify(dto).includes('rt-'), 'no native runtimeSessionId leaks into history');
        const users = dto.items.filter((it) => it.role === 'user');
        assert.equal(users.length, 2);
        const byIntention = Object.fromEntries(users.map((it) => [it.intentionId, it]));
        assert.equal(byIntention['m-A'].actorId, 'actor-A');
        assert.equal(byIntention['m-A'].content, 'from A');
        assert.notEqual(byIntention['m-A'].id, 'm-A', 'exact native id differs from the PWA id');
        assert.equal(byIntention['m-B'].actorId, 'actor-B', 'second member is not rewritten to the owner');
        assert.equal(byIntention['m-B'].content, 'from B');
        // isOwn is viewer-relative (PWA "Você"): B sees only their own row as own.
        assert.equal(byIntention['m-B'].isOwn, true);
        assert.equal(byIntention['m-A'].isOwn, false, "B's view must not label A's message as self");
        // Same history as A: converse flags.
        const histA = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/history`, {
          headers: { cookie: cookieA, 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        });
        assert.equal(histA.status, 200);
        const dtoA = await histA.json();
        const byIntentionA = Object.fromEntries(dtoA.items.filter((it) => it.role === 'user').map((it) => [it.intentionId, it]));
        assert.equal(byIntentionA['m-A'].isOwn, true);
        assert.equal(byIntentionA['m-B'].isOwn, false, "A's view must not label B's message as self");
        // Private conversation still denies the second member at HTTP.
        const priv = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, {
          method: 'POST', headers: headersA, body: JSON.stringify({ visibility: 'private' }),
        });
        assert.equal(priv.status, 200);
        const cookieP = priv.headers.get('set-cookie').split(';')[0];
        assert.notEqual(cookieP, cookieA);
        const denied = await fetch(`${baseB}/agents/finance-chat-agent/H_A/rpc/history`, {
          headers: { ...headersB, cookie: cookieP },
        });
        assert.equal(denied.status, 404, 'private conversation stays owner-only (no oracle)');
      } finally {
        await gwB.close();
      }
    } finally {
      await gw.close();
    }
  });

  it('same intention pinned to a second conversation fails closed 409 with zero second prompt', async () => {
    let prompts = 0;
    const { gw } = harness({
      chatImpl: async ({ intentionId, text }) => {
        prompts++;
        return { turnId: `t-${intentionId}`, output: `answer:${text}`, userMessageId: `u-${intentionId}` };
      },
    });
    const base = await listen(gw);
    try {
      const headers = {
        'content-type': 'application/json',
        cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
      };
      // Intention claimed in conversation A (first writer wins the index).
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'a?', intentionId: 'x-2conv' }),
      });
      assert.equal(first.status, 200);
      const cookieA = first.headers.get('set-cookie').split(';')[0];
      const convA = cookieA.replace('ted-runtime-conversation=opencode.', '');
      // A new conversation B (e.g. /session/new after a cookie transition).
      const nu = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      assert.equal(nu.status, 200);
      const cookieB = nu.headers.get('set-cookie').split(';')[0];
      assert.notEqual(cookieB, cookieA, 'B is a different conversation');
      // Retry of the SAME intention pinned to B: 409, no native access/prompt.
      const retry = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...headers, cookie: cookieB },
        body: JSON.stringify({ text: 'b?', intentionId: 'x-2conv' }),
      });
      assert.equal(retry.status, 409);
      const err = await retry.json();
      assert.equal(err.code, 'prompt.duplicate');
      assert.ok(!JSON.stringify(err).includes(convA), 'no metadata leak of the owner conversation');
      assert.equal(prompts, 1, 'exactly one native prompt across both conversations');
    } finally {
      await gw.close();
    }
  });

  it('duplicate-throwing prompt host maps to 409 with no second native call', async () => {
    let calls = 0;
    const seen = new Set();
    const { gw } = harness({
      chatImpl: async ({ intentionId, text }) => {
        if (seen.has(intentionId)) {
          const e = new Error('dup');
          e.code = 'prompt.duplicate';
          throw e;
        }
        seen.add(intentionId);
        calls++;
        return { turnId: 't1', output: `answer:${text}` };
      },
    });
    const base = await listen(gw);
    try {
      const headers = {
        'content-type': 'application/json',
        cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
      };
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'a?', intentionId: 'rep-1' }),
      });
      assert.equal(first.status, 200);
      const cookie = first.headers.get('set-cookie').split(';')[0];
      const second = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ text: 'a?', intentionId: 'rep-1' }),
      });
      assert.equal(second.status, 409);
      const err = await second.json();
      assert.equal(err.code, 'prompt.duplicate');
      assert.equal(calls, 1, 'exactly one native prompt for one intention');
    } finally {
      await gw.close();
    }
  });

  it("A0 sentinel ('agent') fails closed with no fallback; invalid B cookie is cleared scoped", async () => {
    const { gw, promptCalls } = harness();
    const base = await listen(gw);
    try {
      const a0 = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'ted-runtime-conversation=agent',
          'x-device-token': 'd', 'x-workspace-id': 'H_A',
        },
        body: JSON.stringify({ text: 'oi', intentionId: 'm-a0' }),
      });
      assert.equal(a0.status, 400);
      assert.equal((await a0.json()).code, 'gateway.a0_pinned');
      assert.equal(a0.headers.get('set-cookie'), null, 'A0 pin untouched — proxy owns A0 routing');

      const bad = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'ted-runtime-conversation=opencode.not-a-uuid',
          'x-device-token': 'd', 'x-workspace-id': 'H_A',
        },
        body: JSON.stringify({ text: 'oi', intentionId: 'm-bad' }),
      });
      assert.equal(bad.status, 401);
      const cleared = bad.headers.get('set-cookie');
      assert.ok(cleared && cleared.includes('Max-Age=0'), cleared);
      assert.ok(cleared.includes('Path=/api/agent/agents/finance-chat-agent/H_A/rpc'));
      assert.equal(promptCalls.length, 0, 'no prompt on invalid pin');
    } finally {
      await gw.close();
    }
  });

  it('history returns {items:[...]} for the pinned conversation; cross-workspace forbidden', async () => {
    const { gw } = harness();
    const base = await listen(gw);
    try {
      const created = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'oi', intentionId: 'm-h1' }),
      });
      assert.equal(created.status, 200);
      const cookie = created.headers.get('set-cookie').split(';')[0];
      const hist = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/history`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
      });
      assert.equal(hist.status, 200);
      const dto = await hist.json();
      assert.ok(Array.isArray(dto.items) && dto.items.length === 2);
      assert.equal(dto.items[1].actorId, 'ted');

      const foreign = await fetch(`${base}/agents/finance-chat-agent/H_OTHER/rpc/history`, {
        headers: { cookie, 'x-device-token': 'd', 'x-workspace-id': 'H_OTHER' },
      });
      assert.equal(foreign.status, 403, 'H_A pin inside H_OTHER path fails closed');
    } finally {
      await gw.close();
    }
  });

  it('B history with no pin creates one workspace-visible session, sets the B cookie, returns empty items', async () => {
    const { gw, runtimeCalls, promptCalls } = harness();
    const base = await listen(gw);
    const HIST = (ws) => `/agents/finance-chat-agent/${ws}/rpc/history`;
    try {
      // A0 sentinel stays fail-closed on history too (proxy owns A0 routing).
      const a0 = await fetch(`${base}${HIST('H_A')}`, {
        headers: { cookie: 'ted-runtime-conversation=agent', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
      });
      assert.equal(a0.status, 400);
      assert.equal((await a0.json()).code, 'gateway.a0_pinned');
      assert.equal(a0.headers.get('set-cookie'), null, 'A0 pin untouched');
      assert.equal(runtimeCalls.length, 0, 'no native session for A0 pins');

      // First B UI load: no cookie yet → create + bind, empty history, set pin.
      const headers = { cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' };
      const first = await fetch(`${base}${HIST('H_A')}`, { headers });
      assert.equal(first.status, 200, 'no-pin B history bootstraps instead of erroring');
      assert.deepEqual(await first.json(), { items: [] }, 'fresh conversation has no messages yet');
      const setCookie = first.headers.get('set-cookie');
      assert.ok(setCookie && /ted-runtime-conversation=opencode\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(setCookie), `scoped B cookie set: ${setCookie}`);
      assert.ok(!setCookie.includes('rt-'), 'native runtimeSessionId never in the cookie');
      assert.equal(runtimeCalls.length, 1, 'exactly one native session minted');
      assert.equal(promptCalls.length, 0, 'history bootstrap never prompts (no inference)');

      // Retry with the pin reuses the same session/history (no second session).
      const cookie = setCookie.split(';')[0];
      const second = await fetch(`${base}${HIST('H_A')}`, { headers: { ...headers, cookie } });
      assert.equal(second.status, 200);
      assert.equal((await second.json()).items.length, 2, 'pinned history reads the actual (stubbed) history');
      assert.equal(second.headers.get('set-cookie'), null, 'pin already set — no re-cookie');
      assert.equal(runtimeCalls.length, 1, 'retry reuses the bound session');
      assert.equal(promptCalls.length, 0);
    } finally {
      await gw.close();
    }
  });

  it('session/new returns the renewal DTO with the opaque id + B cookie (never the native id)', async () => {
    const { gw } = harness();
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const dto = await res.json();
      assert.equal(dto.ok, true);
      assert.ok(UUID_RE.test(dto.sessionId), 'opaque conversationId in sessionId');
      assert.equal(dto.previousSessionId, null);
      assert.equal(dto.messageCount, 0);
      assert.equal(dto.summarized, false);
      assert.ok(!JSON.stringify(dto).includes('rt-'), 'native runtimeSessionId never exposed');
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie && setCookie.includes(`opencode.${dto.sessionId}`));

      const priv = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ visibility: 'private' }),
      });
      assert.equal(priv.status, 200);
      assert.equal((await priv.json()).visibility, 'private');

      const badVis = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/session/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ visibility: 'secret' }),
      });
      assert.equal(badVis.status, 400);
    } finally {
      await gw.close();
    }
  });

  it('no-write surface: unknown routes 404, wrong methods 405, oversized bodies 413', async () => {
    const { gw } = harness();
    const base = await listen(gw);
    try {
      const headers = { cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' };
      const nf = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/execute`, { headers });
      assert.equal(nf.status, 404);
      const get = await fetch(`${base}${CHAT('H_A')}`, { headers });
      assert.equal(get.status, 405);
      const big = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(70000), intentionId: 'm-big' }),
      });
      assert.equal(big.status, 413);
    } finally {
      await gw.close();
    }
  });

  it('listener refuses non-loopback hosts', async () => {
    const { gw } = harness();
    await assert.rejects(() => gw.listen({ port: 0, host: '0.0.0.0' }), /non-loopback/);
  });

  it('gateway without the safe session wrapper fails closed at request time (never unsafe rebind)', async () => {
    const { createGatewayServer } = await import('../src/server.mjs');
    const { createConversationStore } = await import('../src/conversations.mjs');
    const { approvedTmpRoot } = await import('./helpers/tmp-root.mjs');
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-srv-wrapper-req') });
    // Legacy construction (e.g. src/main.mjs entrypoint) still boots — the
    // unsafe rebind path is retired, so the first B native use fails closed
    // instead of rebinding without idle proof. Zero native calls either way.
    let prompted = 0;
    const gw = createGatewayServer({
      resolveIdentity: async () => ({ actorId: 'a', workspace: 'H_A', deviceId: 'd', deviceHousehold: 'H_A' }),
      store,
      promptHost: {
        chat: async () => { prompted++; return {}; },
        readHistory: async () => { prompted++; return []; },
        readRawMessages: async () => { prompted++; return []; },
      },
      createRuntimeSession: async () => ({ runtimeSessionId: 'rt-1' }),
      bindAuthenticatedSession: async () => { throw new Error('legacy rebind must never run'); },
    });
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'oi?', intentionId: 'wrap-missing-1' }),
      });
      assert.equal(res.status, 502);
      assert.equal(prompted, 0, 'no native prompt without the safe wrapper');
    } finally {
      await gw.close();
    }
  });

  it('private conversation denies the second member before any native use (no wrapper, no read)', async () => {
    const { createConversationStore } = await import('../src/conversations.mjs');
    const { createGatewayServer } = await import('../src/server.mjs');
    const { approvedTmpRoot } = await import('./helpers/tmp-root.mjs');
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-srv-privdeny') });
    const priv = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A', visibility: 'private' });
    const { serializeConversationCookie } = await import('../src/conversations.mjs');
    const cookie = serializeConversationCookie('H_A', priv.conversationId).split(';')[0];
    let wrapped = 0;
    let read = 0;
    const gw = createGatewayServer({
      resolveIdentity: async () => ({ actorId: 'actor-B', workspace: 'H_A', role: 'member', deviceId: 'dev-B', deviceHousehold: 'H_A' }),
      store,
      promptHost: {
        chat: async () => { throw new Error('must not prompt'); },
        readHistory: async () => { read++; return []; },
        readRawMessages: async () => { read++; return []; },
      },
      createRuntimeSession: async () => { throw new Error('must not create'); },
      bindAuthenticatedSession: async () => { throw new Error('legacy rebind must not run'); },
      withAuthenticatedSession: async () => { wrapped++; return {}; },
    });
    const base = await listen(gw);
    try {
      const res = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/history`, {
        headers: { cookie, 'x-device-token': 'dev-B', 'x-workspace-id': 'H_A' },
      });
      assert.equal(res.status, 404);
      assert.equal(wrapped, 0, 'denied before the safe wrapper');
      assert.equal(read, 0, 'denied before any native read');
    } finally {
      await gw.close();
    }
  });
});
