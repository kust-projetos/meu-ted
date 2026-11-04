// P0 recovery (TDD RED): admitted-but-incomplete retry must recover from
// native history without a second session.prompt.
//
// Scenario: the same intention is admitted (native user message `u_p0`
// exists), the gateway request fails/times out AFTER admission, and the
// corresponding assistant response lands in OpenCode native history only
// later. An authenticated retry with EXACTLY the same intentionId must query
// native history for assistant output correlated to the ORIGINAL
// userMessageId: if complete, return it and settle completed; if no assistant
// yet, retain pending and return prompt.in_progress; if history shows the
// terminal provider error, expose provider.transport. No branch in this retry
// path may invoke session.prompt again (chatCalls stays 1).
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

function terminalRow(id, created) {
  return {
    id, type: 'assistant', agent: 'ted',
    model: { id: 'm', providerID: 'p' },
    finish: 'error', error: { type: 'provider.transport' },
    content: [], time: { created },
  };
}

function buildGateway({ store, chatImpl, rawRows }) {
  let chatCalls = 0;
  const promptHost = {
    chat: async (args) => {
      chatCalls++;
      return chatImpl(args, () => chatCalls);
    },
    readHistory: async () => [],
    readRawMessages: async () => rawRows(),
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
  return { gw, getChatCalls: () => chatCalls };
}

async function listen(gw) {
  const info = await gw.listen({ port: 0, host: '127.0.0.1' });
  return `http://${info.host}:${info.port}`;
}

const CHAT = (ws) => `/agents/finance-chat-agent/${ws}/rpc/chat`;
const HEADERS = {
  'content-type': 'application/json',
  cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
};

describe('P0 recovery: admitted-but-incomplete retry replays native history (no second prompt)', () => {
  it('late assistant lands after the first failure: retry completes from history with exactly one prompt', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p0-rec') });
    // Native history is EMPTY of the assistant during the first admitted
    // timeout (only the admitted user row exists); the assistant lands only
    // AFTER the first response fails. The retry must correlate the SAME
    // intentionId to the ORIGINAL userMessageId/turnId.
    let phase = 'admit';
    const rows = () => phase === 'admit'
      ? [userRow('u_p0', 'saldo?', 1)]
      : [
        userRow('u_p0', 'saldo?', 1),
        assistantRow('a_p0', 'P0 recovered answer', 2),
      ];
    const { gw, getChatCalls } = buildGateway({
      store,
      rawRows: rows,
      chatImpl: async () => {
        // First (and only) admission: prove the assistant is NOT yet
        // observable at admission time (native history holds only the
        // admitted user row). The assistant lands only AFTER the first
        // response fails (phase flips below, outside chatImpl).
        assert.deepEqual(rows(), [userRow('u_p0', 'saldo?', 1)], 'native history empty of assistant during admitted timeout');
        // First (and only) admission: gateway request fails AFTER the native
        // user message exists (timeout shape carries the admitted id).
        throw Object.assign(new Error('admitted but silent'), {
          code: 'prompt.no_output',
          details: { userMessageId: 'u_p0' },
        });
      },
    });
    const base = await listen(gw);
    try {
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-late-1' }),
      });
      assert.equal(first.status, 502, 'first attempt fails after admission (no output yet observable)');
      // The assistant lands in native history only AFTER the first response
      // has returned non-200 (never inside chatImpl above).
      phase = 'recovered';
      const cookie = first.headers.get('set-cookie').split(';')[0];
      assert.equal(getChatCalls(), 1, 'exactly one native admission');

      const retry = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-late-1' }),
      });
      assert.equal(retry.status, 200, 'retry with the SAME intentionId recovers completed from native history');
      assert.equal((await retry.json()).output, 'P0 recovered answer');
      assert.equal(getChatCalls(), 1, 'recovery path never invokes session.prompt again');
      // Persistence proof: the SAME intentionId settled completed with the
      // ORIGINAL admitted ids (never a second prompt, never invented ids).
      const convId = store.findConversationForRetry({ workspace: IDENTITY.workspace, ownerActor: IDENTITY.actorId, intentionId: 'p0-late-1' });
      const settled = store.getIntention(convId, 'p0-late-1');
      assert.equal(settled.status, 'completed', 'retry persists completed (never swallowed)');
      assert.equal(settled.userMessageId, 'u_p0', 'original admitted userMessageId preserved');
      assert.equal(settled.turnId, 'a_p0', 'original assistant turnId preserved');
    } finally {
      await gw.close();
    }
  });

  it('terminal provider error in history surfaces provider.transport with exactly one prompt', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p0-term') });
    const rows = () => [
      userRow('u_p0t', 'saldo?', 1),
      terminalRow('m_term', 2),
    ];
    const { gw, getChatCalls } = buildGateway({
      store,
      rawRows: rows,
      chatImpl: async () => {
        throw Object.assign(new Error('admitted but silent'), {
          code: 'prompt.no_output',
          details: { userMessageId: 'u_p0t' },
        });
      },
    });
    const base = await listen(gw);
    try {
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-term-1' }),
      });
      assert.equal(first.status, 502);
      const cookie = first.headers.get('set-cookie').split(';')[0];

      const retry = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-term-1' }),
      });
      assert.equal(retry.status, 502, 'terminal history error keeps the typed terminal failure');
      assert.equal((await retry.json()).code, 'provider.transport');
      assert.equal(getChatCalls(), 1, 'terminal path never invokes session.prompt again');
    } finally {
      await gw.close();
    }
  });

  it('no assistant yet stays prompt.in_progress with exactly one prompt', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p0-pend') });
    const rows = () => [userRow('u_p0p', 'saldo?', 1)];
    const { gw, getChatCalls } = buildGateway({
      store,
      rawRows: rows,
      chatImpl: async () => {
        throw Object.assign(new Error('admitted but silent'), {
          code: 'prompt.no_output',
          details: { userMessageId: 'u_p0p' },
        });
      },
    });
    const base = await listen(gw);
    try {
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-pend-1' }),
      });
      assert.equal(first.status, 502);
      const cookie = first.headers.get('set-cookie').split(';')[0];

      const retry = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-pend-1' }),
      });
      assert.equal(retry.status, 409, 'admitted-but-incomplete stays in_progress, never a second prompt');
      assert.equal((await retry.json()).code, 'prompt.in_progress');
      assert.equal(getChatCalls(), 1);
    } finally {
      await gw.close();
    }
  });

  it('settle failure never returns success: retry stays pending, then the same ID completes', async () => {
    // Recovery must NEVER return 200 unless `status:completed` persistence
    // succeeds. When settle throws, the gateway answers with a safe error
    // (never success), the intention stays pending, and a later retry with
    // the EXACT same intentionId re-reads native history and settles —
    // never a second session.prompt.
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p0-settle') });
    const rows = () => [
      userRow('u_p0s', 'saldo?', 1),
      assistantRow('a_p0s', 'P0 settle-proof answer', 2),
    ];
    const { gw, getChatCalls } = buildGateway({
      store,
      rawRows: rows,
      chatImpl: async () => {
        throw Object.assign(new Error('admitted but silent'), {
          code: 'prompt.no_output',
          details: { userMessageId: 'u_p0s' },
        });
      },
    });
    const base = await listen(gw);
    try {
      const first = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-settle-1' }),
      });
      assert.equal(first.status, 502);
      const cookie = first.headers.get('set-cookie').split(';')[0];
      assert.equal(getChatCalls(), 1, 'exactly one native admission before recovery');

      // Break ONLY the recovery settle (completed persistence).
      const origSettle = store.settleIntention.bind(store);
      let settleCalls = 0;
      store.settleIntention = (convId, intentionId, patch) => {
        if (patch && patch.status === 'completed') {
          settleCalls++;
          if (settleCalls === 1) throw new Error('settle-boom (injected persistence failure)');
        }
        return origSettle(convId, intentionId, patch);
      };

      const retryFail = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-settle-1' }),
      });
      assert.notEqual(retryFail.status, 200, 'settle failure must never return success');
      assert.equal(getChatCalls(), 1, 'failed recovery never issues a second prompt');
      const convId = store.findConversationForRetry({ workspace: IDENTITY.workspace, ownerActor: IDENTITY.actorId, intentionId: 'p0-settle-1' });
      const stillPending = store.getIntention(convId, 'p0-settle-1');
      assert.equal(stillPending.status, 'pending', 'intention stays pending after settle failure');
      assert.equal(stillPending.userMessageId, 'u_p0s', 'admitted id preserved for the next retry');

      // Heal persistence: the SAME intentionId retry re-reads native history
      // and settles completed (still exactly one prompt ever).
      store.settleIntention = origSettle;
      const retryOk = await fetch(`${base}${CHAT('H_A')}`, {
        method: 'POST',
        headers: { ...HEADERS, cookie },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'p0-settle-1' }),
      });
      assert.equal(retryOk.status, 200, 'same-ID retry after settle heal completes from history');
      assert.equal((await retryOk.json()).output, 'P0 settle-proof answer');
      assert.equal(getChatCalls(), 1, 'healed recovery still never re-prompts');
      const settled = store.getIntention(convId, 'p0-settle-1');
      assert.equal(settled.status, 'completed');
      assert.equal(settled.userMessageId, 'u_p0s');
      assert.equal(settled.turnId, 'a_p0s');
    } finally {
      await gw.close();
    }
  });
});
