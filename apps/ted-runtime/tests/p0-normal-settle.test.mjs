// PR290-SETTLE-NORMAL-05 (TDD RED): normal successful chat must not swallow
// completed-settle persistence failure. If the completed settle throws, the
// gateway must answer non-200 (safe gateway.upstream_error, no store text),
// keep the intention pending with actorId+userMessageId (fallback pending
// settle), issue exactly one prompt, and let the SAME intentionId retry
// recover from native history (200, no second prompt, store completed).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const IDENTITY = {
  actorId: 'actor-A', workspace: 'H_A', role: 'owner',
  deviceId: 'dev-A', deviceHousehold: 'H_A',
};

function userRow(id, text, created) {
  return { id, type: 'user', text, time: { created } };
}

function assistantRow(id, text, created) {
  return {
    id, type: 'assistant', agent: 'ted',
    model: { id: 'm', providerID: 'p' },
    content: [{ type: 'text', text }], time: { created },
  };
}

describe('P0 normal-path settle failure stays retryable (no swallowed 200)', () => {
  it('completed settle throw -> safe non-200, pending preserved, same-ID retry recovers with one prompt', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p0-normsettle') });
    const rows = () => [
      userRow('u_norm', 'saldo?', 1),
      assistantRow('a_norm', 'P0 normal recovered answer', 2),
    ];
    let chatCalls = 0;
    const promptHost = {
      chat: async () => {
        chatCalls++;
        return { turnId: 'a_norm', output: 'P0 normal recovered answer', userMessageId: 'u_norm' };
      },
      readHistory: async () => [],
      readRawMessages: async () => rows(),
    };
    const gw = createGatewayServer({
      resolveIdentity: async () => ({ ...IDENTITY }),
      store,
      promptHost,
      createRuntimeSession: async (identity, conversationId) => ({
        runtimeSessionId: `rt-${conversationId}`,
      }),
      bindAuthenticatedSession: async () => true,
      withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
    });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://${info.host}:${info.port}`;
    const CHAT = `/agents/finance-chat-agent/H_A/rpc/chat`;
    const HEADERS = {
      'content-type': 'application/json',
      cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
    };
    try {
      // Break ONLY the completed persistence (first completed settle throws).
      const origSettle = store.settleIntention.bind(store);
      let completedCalls = 0;
      store.settleIntention = (convId, intentionId, patch) => {
        if (patch && patch.status === 'completed') {
          completedCalls++;
          if (completedCalls === 1) throw new Error('settle-boom-normal (injected)');
        }
        return origSettle(convId, intentionId, patch);
      };

      const first = await fetch(`${base}${CHAT}`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-norm-1' }),
      });
      const firstBody = await first.text();
      assert.notEqual(first.status, 200, 'completed-settle failure must never return success');
      assert.equal(first.status, 502, 'safe gateway upstream error maps to 502');
      assert.ok(!firstBody.includes('settle-boom'), 'store exception text never leaks into HTTP body');
      assert.equal(chatCalls, 1, 'exactly one native prompt on the normal path');
      const setCookie = first.headers.get('set-cookie');
      assert.ok(setCookie && setCookie.includes('ted-runtime-conversation=opencode.'), 'B pin issued even on settle failure');
      const cookie = setCookie.split(';')[0];

      const convId = store.findConversationForRetry({ workspace: IDENTITY.workspace, ownerActor: IDENTITY.actorId, intentionId: 'p0-norm-1' });
      assert.ok(convId, 'first-writer index present after normal-path failure');
      const stillPending = store.getIntention(convId, 'p0-norm-1');
      assert.equal(stillPending.status, 'pending', 'intention stays pending after completed-settle failure');
      assert.equal(stillPending.actorId, 'actor-A', 'actorId preserved for retry');
      assert.equal(stillPending.userMessageId, 'u_norm', 'userMessageId preserved so retry recovers (not duplicate)');

      // Heal persistence: SAME intentionId retry re-reads native history.
      store.settleIntention = origSettle;
      const retry = await fetch(`${base}${CHAT}`, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-norm-1' }),
      });
      assert.equal(retry.status, 200, 'same-ID retry after settle heal recovers from history');
      assert.equal((await retry.json()).output, 'P0 normal recovered answer');
      assert.equal(chatCalls, 1, 'recovery never issues a second prompt');
      const settled = store.getIntention(convId, 'p0-norm-1');
      assert.equal(settled.status, 'completed', 'retry persists completed');
      assert.equal(settled.userMessageId, 'u_norm');
      assert.equal(settled.turnId, 'a_norm');
    } finally {
      await gw.close();
    }
  });

  it('double persistence failure (completed + fallback) still fails safe with no leak', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p0-normsettle2') });
    let chatCalls = 0;
    const promptHost = {
      chat: async () => {
        chatCalls++;
        return { turnId: 'a_n2', output: 'answer', userMessageId: 'u_n2' };
      },
      readHistory: async () => [],
      readRawMessages: async () => [],
    };
    const gw = createGatewayServer({
      resolveIdentity: async () => ({ ...IDENTITY }),
      store,
      promptHost,
      createRuntimeSession: async (identity, conversationId) => ({
        runtimeSessionId: `rt-${conversationId}`,
      }),
      bindAuthenticatedSession: async () => true,
      withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
    });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://${info.host}:${info.port}`;
    const CHAT = `/agents/finance-chat-agent/H_A/rpc/chat`;
    try {
      store.settleIntention = () => { throw new Error('settle-boom-both (injected)'); };
      const res = await fetch(`${base}${CHAT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-norm-2' }),
      });
      const body = await res.text();
      assert.notEqual(res.status, 200, 'double persistence failure must never return success');
      assert.ok(!body.includes('settle-boom'), 'no store text in HTTP body even when fallback also fails');
      assert.equal(chatCalls, 1, 'exactly one prompt even when both persists fail');
    } finally {
      await gw.close();
    }
  });
});
