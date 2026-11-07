// Runtime entrypoint tests (dependency-free: no SDK, no network).
// Proves importing src/main.mjs starts nothing (no listener, no signal
// traps) and startTedRuntime boots + closes through injected seams.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { approvedTmpRoot } from './helpers/tmp-root.mjs';

describe('runtime entrypoint (import-safe, seamed startup)', () => {
  it('importing main has no side effects (no listener, no signal traps)', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const mod = await import('../src/main.mjs');
    assert.equal(typeof mod.startTedRuntime, 'function', 'startup factory is exported');
    assert.equal(process.listenerCount('SIGINT'), beforeInt, 'no SIGINT trap on import');
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'no SIGTERM trap on import');
  });

  it('startTedRuntime starts and closes with injected seams (no SDK, no network)', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    const { createConversationStore } = await import('../src/conversations.mjs');
    let closedEnv = 0;
    let closedGateway = 0;
    let listened = 0;
    const fakeTedEnv = {
      dirs: { state: approvedTmpRoot('ted-main') },
      serverOps: {
        createPromptHost: () => ({ chat: async () => ({ turnId: 't', output: 'o' }) }),
        createNativeSession: async () => 'ses_unit_1',
        bindAuthenticatedSession: async () => true,
        withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
      },
      close: async () => { closedEnv++; },
    };
    const handle = await startTedRuntime({
      env: {
        TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home'),
        TED_RUNTIME_IDENTITY: 'unittest',
        TED_API_BASE_URL: 'http://127.0.0.1:9',
        TED_GATEWAY_PORT: '0',
        TED_REQUEST_TIMEOUT_MS: '1000',
      },
      deps: {
        createTedEnvironment: async () => fakeTedEnv,
        createConversationStore: (args) => createConversationStore(args),
        createGatewayServer: () => ({
          listen: async ({ host } = {}) => {
            listened++;
            assert.equal(host, '127.0.0.1', 'listener is always loopback, never from env');
            return { host: '127.0.0.1', port: 1 };
          },
          close: async () => { closedGateway++; },
        }),
        resolveGatewayIdentity: async () => { throw Object.assign(new Error('unused'), { code: 'auth.session_required' }); },
      },
    });
    assert.equal(handle.info.host, '127.0.0.1');
    assert.equal(listened, 1, 'exactly one listen through the seamed gateway');
    await handle.close();
    assert.equal(closedGateway, 1, 'gateway closed exactly once');
    assert.equal(closedEnv, 1, 'SDK environment closed exactly once');
    // Second close is a no-op (idempotent shutdown, never double-close).
    await handle.close();
    assert.equal(closedGateway, 1);
    assert.equal(closedEnv, 1);
  });

  it('startTedRuntime rejects non-loopback API origins before touching the SDK', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    let created = 0;
    await assert.rejects(
      () => startTedRuntime({
        env: { TED_API_BASE_URL: 'https://api.example.com' },
        deps: { createTedEnvironment: async () => { created++; throw new Error('must not boot'); } },
      }),
      /loopback/,
    );
    assert.equal(created, 0, 'no environment boot against a non-loopback origin');
  });

  it('startTedRuntime closes an already-booted env when gateway listen fails', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    const { createConversationStore } = await import('../src/conversations.mjs');
    let closedEnv = 0;
    let closedGateway = 0;
    let builtGateway = 0;
    const fakeTedEnv = {
      dirs: { state: approvedTmpRoot('ted-main-fail-listen') },
      serverOps: {
        createPromptHost: () => ({ chat: async () => ({ turnId: 't', output: 'o' }) }),
        createNativeSession: async () => 'ses_unit_1',
        bindAuthenticatedSession: async () => true,
        withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
      },
      close: async () => { closedEnv++; },
    };
    await assert.rejects(
      () => startTedRuntime({
        env: {
          TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home-listen'),
          TED_RUNTIME_IDENTITY: 'unittest',
          TED_API_BASE_URL: 'http://127.0.0.1:9',
          TED_GATEWAY_PORT: '0',
          TED_REQUEST_TIMEOUT_MS: '1000',
        },
        deps: {
          createTedEnvironment: async () => fakeTedEnv,
          createConversationStore: (args) => createConversationStore(args),
          createGatewayServer: () => {
            builtGateway++;
            return {
              listen: async () => { throw Object.assign(new Error('port busy'), { code: 'EADDRINUSE' }); },
              close: async () => { closedGateway++; },
            };
          },
        },
      }),
      /port busy/,
    );
    assert.equal(builtGateway, 1, 'gateway was constructed before listen failed');
    assert.equal(closedGateway, 1, 'partially-started gateway is cleaned up');
    assert.equal(closedEnv, 1, 'booted SDK environment is closed exactly once — never leaked');
  });

  it('startTedRuntime closes an already-booted env when the conversation store fails', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    let closedEnv = 0;
    let builtGateway = 0;
    const fakeTedEnv = {
      dirs: { state: approvedTmpRoot('ted-main-fail-store') },
      serverOps: {
        createPromptHost: () => ({ chat: async () => ({ turnId: 't', output: 'o' }) }),
        createNativeSession: async () => 'ses_unit_1',
        bindAuthenticatedSession: async () => true,
        withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
      },
      close: async () => { closedEnv++; },
    };
    await assert.rejects(
      () => startTedRuntime({
        env: {
          TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home-store'),
          TED_RUNTIME_IDENTITY: 'unittest',
          TED_API_BASE_URL: 'http://127.0.0.1:9',
          TED_GATEWAY_PORT: '0',
          TED_REQUEST_TIMEOUT_MS: '1000',
        },
        deps: {
          createTedEnvironment: async () => fakeTedEnv,
          createConversationStore: () => { throw Object.assign(new Error('store unreadable'), { code: 'conversation.store_unreadable' }); },
          createGatewayServer: () => { builtGateway++; throw new Error('must not build'); },
        },
      }),
      /store unreadable/,
    );
    assert.equal(builtGateway, 0, 'gateway is never constructed when the store fails');
    assert.equal(closedEnv, 1, 'booted SDK environment is closed exactly once — never leaked');
  });

  it('startTedRuntime passes withAuthenticatedSession delegating to tedEnv.serverOps (same sessionID/host/signal/options)', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    const { createConversationStore } = await import('../src/conversations.mjs');
    const delegated = [];
    const fakeTedEnv = {
      dirs: { state: approvedTmpRoot('ted-main-wrapper-delegate') },
      serverOps: {
        createPromptHost: () => ({ chat: async () => ({ turnId: 't', output: 'o' }) }),
        createNativeSession: async () => 'ses_unit_1',
        bindAuthenticatedSession: async () => true,
        withAuthenticatedSession: async (sessionID, host, fn, opts) => {
          delegated.push({ sessionID, host, opts });
          return await fn();
        },
      },
      close: async () => {},
    };
    let captured = null;
    const handle = await startTedRuntime({
      env: {
        TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home-delegate'),
        TED_RUNTIME_IDENTITY: 'unittest',
        TED_API_BASE_URL: 'http://127.0.0.1:9',
        TED_GATEWAY_PORT: '0',
        TED_REQUEST_TIMEOUT_MS: '1000',
      },
      deps: {
        createTedEnvironment: async () => fakeTedEnv,
        createConversationStore: (args) => createConversationStore(args),
        createGatewayServer: (opts) => {
          captured = opts;
          return {
            listen: async () => ({ host: '127.0.0.1', port: 1 }),
            close: async () => {},
          };
        },
        resolveGatewayIdentity: async () => { throw Object.assign(new Error('unused'), { code: 'auth.session_required' }); },
      },
    });
    assert.ok(captured, 'gateway options were captured');
    assert.equal(typeof captured.withAuthenticatedSession, 'function', 'main passes the safe wrapper (not only the legacy bind)');
    assert.ok(!('bindAuthenticatedSession' in captured) || captured.bindAuthenticatedSession === undefined, 'legacy unsafe binding path is removed from main');
    const host = Object.freeze({ label: 't', token: 'tok', household: 'ws', actorId: 'a', deviceId: 'd' });
    const signal = AbortSignal.timeout ? AbortSignal.timeout(1000) : undefined;
    const seen = [];
    const out = await captured.withAuthenticatedSession('ses_probe_1', host, async () => { seen.push('ran'); return 'ok-result'; }, { idleTimeoutMs: 11 });
    assert.equal(out, 'ok-result', 'passed wrapper runs the callback and returns its result');
    assert.deepEqual(seen, ['ran']);
    assert.equal(delegated.length, 1, 'delegation reached tedEnv.serverOps.withAuthenticatedSession exactly once');
    assert.equal(delegated[0].sessionID, 'ses_probe_1');
    assert.equal(delegated[0].host, host, 'same host object is forwarded');
    assert.deepEqual(delegated[0].opts, { idleTimeoutMs: 11 }, 'same options object is forwarded');
    await handle.close();
  });

  it('startTedRuntime with the REAL gateway wires pinned B history/chat through the fake serverOps wrapper (no SDK/provider)', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    const { createConversationStore } = await import('../src/conversations.mjs');
    const { createGatewayServer } = await import('../src/server.mjs');
    let wrapperCalls = 0;
    const wrapperSeen = [];
    const chatCalls = [];
    const fakeTedEnv = {
      dirs: { state: approvedTmpRoot('ted-main-wrapper-loopback') },
      serverOps: {
        createPromptHost: () => ({
          chat: async ({ sessionID, text, intentionId }) => {
            chatCalls.push({ sessionID, text, intentionId });
            return { turnId: 'turn_loop_1', output: 'loopback reply' };
          },
          readHistory: async () => [],
        }),
        createNativeSession: async () => 'ses_loop_1',
        bindAuthenticatedSession: async () => true,
        withAuthenticatedSession: async (sessionID, host, fn, opts) => {
          wrapperCalls++;
          wrapperSeen.push({ sessionID, host });
          return await fn();
        },
      },
      close: async () => {},
    };
    const identity = { workspace: 'ws-loop', actorId: 'actor-loop', deviceId: 'dev-loop' };
    const handle = await startTedRuntime({
      env: {
        TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home-loopback'),
        TED_RUNTIME_IDENTITY: 'unittest',
        TED_API_BASE_URL: 'http://127.0.0.1:9',
        TED_GATEWAY_PORT: '0',
        TED_REQUEST_TIMEOUT_MS: '5000',
      },
      deps: {
        createTedEnvironment: async () => fakeTedEnv,
        createConversationStore: (args) => createConversationStore(args),
        createGatewayServer,
        resolveGatewayIdentity: async () => identity,
      },
    });
    try {
      const base = `http://127.0.0.1:${handle.info.port}`;
      const historyPath = `/agents/finance-chat-agent/${identity.workspace}/rpc/history`;
      // No-pin bootstrap yields a B cookie without invoking the wrapper (no native use yet).
      const boot = await fetch(`${base}${historyPath}`, { method: 'GET', headers: { 'x-device-token': 'dev-token-loop' } });
      assert.equal(boot.status, 200);
      const bootBody = await boot.json();
      assert.deepEqual(bootBody, { items: [] });
      const setCookie = boot.headers.get('set-cookie') ?? '';
      const m = /ted-runtime-conversation=opencode\.([0-9a-f-]{36})/i.exec(setCookie);
      assert.ok(m?.[1], `bootstrap sets a B cookie (got ${setCookie.slice(0, 80)})`);
      assert.equal(wrapperCalls, 0, 'bootstrap issues no prompt and performs no native use');
      const pinCookie = `ted-runtime-conversation=opencode.${m[1]}`;
      // Pinned history runs inside the wrapper.
      const beforePinned = wrapperCalls;
      const pinned = await fetch(`${base}${historyPath}`, { method: 'GET', headers: { cookie: pinCookie, 'x-device-token': 'dev-token-loop' } });
      assert.equal(pinned.status, 200);
      assert.equal(wrapperCalls, beforePinned + 1, 'pinned B history invokes the safe wrapper exactly once');
      assert.equal(wrapperSeen[wrapperSeen.length - 1].sessionID, 'ses_loop_1');
      // Stub chat on the same pin also runs inside the wrapper (no SDK/provider/API call).
      const beforeChat = wrapperCalls;
      const chatRes = await fetch(`${base}/agents/finance-chat-agent/${identity.workspace}/rpc/chat`, {
        method: 'POST',
        headers: { cookie: pinCookie, 'x-device-token': 'dev-token-loop', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello ted', intentionId: 'int-loop-1' }),
      });
      assert.equal(chatRes.status, 200);
      const chatBody = await chatRes.json();
      assert.equal(chatBody.status, 'completed');
      assert.equal(chatBody.output, 'loopback reply');
      assert.equal(wrapperCalls, beforeChat + 1, 'B chat invokes the safe wrapper exactly once');
      assert.equal(chatCalls.length, 1, 'prompt stub ran once (no SDK/provider call)');
    } finally {
      await handle.close();
    }
  });

  it('startTedRuntime defaults requestTimeoutMs to 90000ms (adapter 60s + overhead, below 120s BFF)', async () => {
    const { startTedRuntime } = await import('../src/main.mjs');
    const { createConversationStore } = await import('../src/conversations.mjs');
    const makeSeams = (captured) => ({
      createTedEnvironment: async () => ({
        dirs: { state: approvedTmpRoot('ted-main-default-timeout') },
        serverOps: {
          createPromptHost: () => ({ chat: async () => ({ turnId: 't', output: 'o' }) }),
          createNativeSession: async () => 'ses_unit_1',
          bindAuthenticatedSession: async () => true,
          withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
        },
        close: async () => {},
      }),
      createConversationStore: (args) => createConversationStore(args),
      createGatewayServer: (opts) => {
        captured.value = opts.requestTimeoutMs;
        return {
          listen: async () => ({ host: '127.0.0.1', port: 1 }),
          close: async () => {},
        };
      },
    });
    const capturedDefault = { value: undefined };
    const handleDefault = await startTedRuntime({
      env: {
        TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home-default-timeout'),
        TED_RUNTIME_IDENTITY: 'unittest',
        TED_API_BASE_URL: 'http://127.0.0.1:9',
        TED_GATEWAY_PORT: '0',
      },
      deps: makeSeams(capturedDefault),
    });
    try {
      assert.equal(capturedDefault.value, 90000, 'default gateway timeout covers the 60s adapter budget + bounded overhead, below the 120s BFF');
    } finally {
      await handleDefault.close();
    }
    const capturedOverride = { value: undefined };
    const handleOverride = await startTedRuntime({
      env: {
        TED_RUNTIME_HOME: approvedTmpRoot('ted-main-home-override-timeout'),
        TED_RUNTIME_IDENTITY: 'unittest',
        TED_API_BASE_URL: 'http://127.0.0.1:9',
        TED_GATEWAY_PORT: '0',
        TED_REQUEST_TIMEOUT_MS: '12345',
      },
      deps: makeSeams(capturedOverride),
    });
    try {
      assert.equal(capturedOverride.value, 12345, 'explicit TED_REQUEST_TIMEOUT_MS still wins over the default');
    } finally {
      await handleOverride.close();
    }
  });
});
