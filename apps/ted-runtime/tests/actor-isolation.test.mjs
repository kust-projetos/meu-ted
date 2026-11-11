// PR290 ACTOR-ISOLATION-04 (TDD RED): workspace-visible conversation must NOT
// let actor B replay actor A's intention via the same cookie + intentionId.
//
// Scenario: actor A admits (first gateway call fails AFTER the native
// userMessageId is persisted → pending with actorId A). Actor B (same
// workspace, same B cookie, exact same intentionId) must get generic
// prompt.duplicate/409 BEFORE any native history read/bind/prompt — no
// output from A, no raw/turn metadata. Actor A retry then recovers normally
// from native history (exactly one prompt ever). After A settles completed,
// B retry of the same ID must again fail closed 409 (check runs BEFORE the
// completed/pending status branch). Counters prove zero native access on
// both B attempts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const WS = 'H_A';
const CHAT = `/agents/finance-chat-agent/${WS}/rpc/chat`;
const INTENTION = 'actor-iso-1';
const ADMITTED_USER = 'u_iso1';
const RECOVERED_TEXT = 'P0 recovered answer';
const ASSISTANT_TURN = 'a_iso1';

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

describe('PR290 actor isolation: B cannot replay A intention on shared workspace pin', () => {
  it('pending + completed collisions from B fail closed 409 before any native access; A recovers', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-actor-iso') });
    let phase = 'pending'; // 'pending' → rows hold only the admitted user; 'recovered' → assistant landed
    const rows = () => phase === 'pending'
      ? [userRow(ADMITTED_USER, 'saldo A', 1)]
      : [userRow(ADMITTED_USER, 'saldo A', 1), assistantRow(ASSISTANT_TURN, RECOVERED_TEXT, 2)];

    let chatCalls = 0;
    let rawCalls = 0;
    let historyCalls = 0;
    let wrapperCalls = 0;

    const gw = createGatewayServer({
      resolveIdentity: async ({ deviceToken, workspaceId }) => {
        if (deviceToken === 'd-B') {
          return { actorId: 'actor-B', workspace: workspaceId, role: 'member', deviceId: 'dev-B', deviceHousehold: WS };
        }
        return { actorId: 'actor-A', workspace: workspaceId, role: 'owner', deviceId: 'dev-A', deviceHousehold: WS };
      },
      store,
      promptHost: {
        chat: async () => {
          chatCalls++;
          if (chatCalls === 1) {
            throw Object.assign(new Error('admitted but silent'), {
              code: 'prompt.no_output',
              details: { userMessageId: ADMITTED_USER },
            });
          }
          throw Object.assign(new Error('must not prompt twice'), { code: 'prompt.duplicate' });
        },
        readHistory: async () => { historyCalls++; return []; },
        readRawMessages: async () => { rawCalls++; return rows(); },
      },
      createRuntimeSession: async (identity, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
      bindAuthenticatedSession: async () => true,
      withAuthenticatedSession: async (sessionID, host, fn) => { wrapperCalls++; return await fn(); },
    });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://${info.host}:${info.port}`;
    try {
      // 1. Actor A admits: fails AFTER the native userMessageId exists.
      const first = await fetch(`${base}${CHAT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd-A', 'x-workspace-id': WS },
        body: JSON.stringify({ text: 'saldo A', intentionId: INTENTION }),
      });
      assert.equal(first.status, 502, 'first A attempt fails after admission');
      const cookie = first.headers.get('set-cookie').split(';')[0];
      assert.ok(cookie.includes('ted-runtime-conversation=opencode.'));
      assert.equal(chatCalls, 1, 'exactly one native admission');
      const convId = cookie.replace('ted-runtime-conversation=opencode.', '');
      const pending = store.getIntention(convId, INTENTION);
      assert.equal(pending.status, 'pending');
      assert.equal(pending.userMessageId, ADMITTED_USER);

      // 2. Actor B reuses the SAME cookie + SAME intentionId (pending state).
      const snapB1 = { chatCalls, rawCalls, historyCalls, wrapperCalls };
      const bPending = await fetch(`${base}${CHAT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-device-token': 'd-B', 'x-workspace-id': WS },
        body: JSON.stringify({ text: 'saldo A', intentionId: INTENTION }),
      });
      assert.equal(bPending.status, 409, 'B collision on pending intention fails closed 409');
      const bPendingBody = await bPending.json();
      assert.equal(bPendingBody.code, 'prompt.duplicate', 'generic duplicate code (no in_progress leak)');
      const bPendingJson = JSON.stringify(bPendingBody);
      assert.ok(!bPendingJson.includes(RECOVERED_TEXT), 'no output from A in the duplicate response');
      assert.ok(!bPendingJson.includes(ADMITTED_USER), 'no admitted native id in the duplicate response');
      assert.ok(!bPendingJson.includes(ASSISTANT_TURN), 'no turn id in the duplicate response');
      assert.ok(!bPendingJson.includes('actor-A') && !bPendingJson.includes('actor-B'), 'no author ids in the duplicate response');
      assert.deepEqual(
        { chatCalls, rawCalls, historyCalls, wrapperCalls },
        snapB1,
        'B pending collision performs zero native history read/bind/prompt before failing closed',
      );

      // 3. Actor A retries the SAME id and recovers normally (assistant landed).
      phase = 'recovered';
      const retryA = await fetch(`${base}${CHAT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-device-token': 'd-A', 'x-workspace-id': WS },
        body: JSON.stringify({ text: 'saldo A', intentionId: INTENTION }),
      });
      assert.equal(retryA.status, 200, 'A retry recovers completed from native history');
      assert.equal((await retryA.json()).output, RECOVERED_TEXT);
      assert.equal(chatCalls, 1, 'recovery never issues a second native prompt');
      const settled = store.getIntention(convId, INTENTION);
      assert.equal(settled.status, 'completed');

      // 4. Actor B reuses the SAME cookie + SAME intentionId (completed state).
      const snapB2 = { chatCalls, rawCalls, historyCalls, wrapperCalls };
      const bDone = await fetch(`${base}${CHAT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-device-token': 'd-B', 'x-workspace-id': WS },
        body: JSON.stringify({ text: 'saldo A', intentionId: INTENTION }),
      });
      assert.equal(bDone.status, 409, 'B collision on completed intention fails closed 409');
      const bDoneBody = await bDone.json();
      assert.equal(bDoneBody.code, 'prompt.duplicate');
      const bDoneJson = JSON.stringify(bDoneBody);
      assert.ok(!bDoneJson.includes(RECOVERED_TEXT), 'no replayed output from A in the duplicate response');
      assert.ok(!bDoneJson.includes(ADMITTED_USER) && !bDoneJson.includes(ASSISTANT_TURN), 'no turn metadata in the duplicate response');
      assert.ok(!bDoneJson.includes('actor-A') && !bDoneJson.includes('actor-B'), 'no author ids in the duplicate response');
      assert.deepEqual(
        { chatCalls, rawCalls, historyCalls, wrapperCalls },
        snapB2,
        'B completed collision performs zero native history read/bind/prompt before failing closed',
      );
      assert.equal(chatCalls, 1, 'no second native prompt across the whole scenario');
    } finally {
      await gw.close();
    }
  });
});
