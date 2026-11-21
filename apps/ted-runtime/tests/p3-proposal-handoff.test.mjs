// Action handoff: the gateway consumes the native tool's action intent in the
// SAME turn. There is no actionable card: bad/missing assurance or an
// unavailable pipeline must become a text question, and a failed turn never
// leaks its intent into the next one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { createActionIntentRegistry } from '../src/action-intents.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const CHAT = (ws) => `/agents/finance-chat-agent/${ws}/rpc/chat`;

function harness({ chatImpl, actionIntents = createActionIntentRegistry() } = {}) {
  const store = createConversationStore({ persistDir: approvedTmpRoot('ted-p3-handoff') });
  const gw = createGatewayServer({
    resolveIdentity: async ({ workspaceId }) => ({
      actorId: 'actor-A',
      workspace: workspaceId,
      role: 'owner',
      deviceId: 'dev-A',
      deviceHousehold: workspaceId,
    }),
    store,
    promptHost: { chat: chatImpl, readHistory: async () => [], readRawMessages: async () => [] },
    createRuntimeSession: async (_idn, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
    withAuthenticatedSession: async (_sessionID, _host, fn) => fn(),
    actionIntents,
  });
  return { gw, store, actionIntents };
}

async function listen(gw) {
  const info = await gw.listen({ port: 0, host: '127.0.0.1' });
  return `http://${info.host}:${info.port}`;
}

const intent = (intentionId = 'int-abc') => ({
  tool: 'transactions.expense.create',
  intentionId,
  summary: 'Despesa de R$ 50,00 em "mercado"',
  normalizedArgs: {
    amountCents: 5000,
    description: 'mercado',
    date: '2026-11-06',
    accountId: '11111111-1111-4111-8111-111111111111',
    categoryId: '22222222-2222-4222-8222-222222222222',
  },
});

async function chat(base, body, cookie) {
  return fetch(`${base}${CHAT('H_A')}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookie ?? 'better-auth.session_token=s',
      'x-device-token': 'dev-tok-A',
      'x-workspace-id': 'H_A',
    },
    body: JSON.stringify(body),
  });
}

describe('action handoff', () => {
  it('consumes the recorded intent once and never returns an actionable card', async () => {
    const registry = createActionIntentRegistry();
    const { gw } = harness({
      actionIntents: registry,
      chatImpl: async ({ sessionID }) => {
        registry.record(sessionID, intent());
        return { turnId: 'turn-1', output: 'Vou registrar a despesa.' };
      },
    });
    const base = await listen(gw);
    try {
      const first = await chat(base, { text: 'Registre uma despesa de R$ 50 no mercado.', intentionId: 'm-1' });
      assert.equal(first.status, 200);
      const dto = await first.json();
      assert.equal(dto.status, 'completed');
      assert.equal('proposal' in dto, false, 'no approval card surface');
      assert.equal(dto.actionObserved, true);
      assert.match(dto.output, /esclarecer/i, 'no pipeline: ask in text, never claim success');
      assert.equal(registry.size(), 0, 'the intent is consumed by the turn');
    } finally {
      await gw.close();
    }
  });

  it('does not invent an action when the tool did not record one', async () => {
    const { gw } = harness({ chatImpl: async () => ({ turnId: 'turn-1', output: 'ok' }) });
    const base = await listen(gw);
    try {
      const res = await chat(base, { text: 'Quais contas?', intentionId: 'm-1' });
      const dto = await res.json();
      assert.equal('proposal' in dto, false);
      assert.equal(dto.actionObserved, false);
      assert.deepEqual(Object.keys(dto).sort(), ['actionObserved', 'intentionId', 'output', 'status', 'turnId']);
    } finally {
      await gw.close();
    }
  });

  it('a failed turn never leaks its intent into the next turn', async () => {
    const registry = createActionIntentRegistry();
    let call = 0;
    const { gw } = harness({
      actionIntents: registry,
      chatImpl: async ({ sessionID }) => {
        call += 1;
        if (call === 1) {
          registry.record(sessionID, intent('int-failed'));
          throw Object.assign(new Error('provider down'), { code: 'prompt.no_output' });
        }
        return { turnId: 'turn-2', output: 'ok' };
      },
    });
    const base = await listen(gw);
    try {
      const failed = await chat(base, { text: 'primeira', intentionId: 'm-1' });
      assert.notEqual(failed.status, 200);
      const failedBody = await failed.json();
      assert.equal('proposal' in failedBody, false);

      const ok = await chat(base, { text: 'segunda', intentionId: 'm-2' });
      assert.equal(ok.status, 200);
      const dto = await ok.json();
      assert.equal('proposal' in dto, false);
      assert.equal(dto.actionObserved, false, 'stale intent from the failed turn must not cross');
    } finally {
      await gw.close();
    }
  });

  it('keeps intents scoped to their conversation (two workspaces never cross)', async () => {
    const registry = createActionIntentRegistry();
    const seen = [];
    const { gw } = harness({
      actionIntents: registry,
      chatImpl: async ({ sessionID, text }) => {
        seen.push(sessionID);
        if (text.includes('R$ 50')) registry.record(sessionID, intent('int-A'));
        return { turnId: `turn-${seen.length}`, output: 'ok' };
      },
    });
    const base = await listen(gw);
    try {
      const first = await chat(base, { text: 'R$ 50 no mercado', intentionId: 'm-1' });
      const firstDto = await first.json();
      assert.equal(firstDto.actionObserved, true, 'workspace A turn observed its action');

      const second = await fetch(`${base}${CHAT('H_B')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'better-auth.session_token=s',
          'x-device-token': 'dev-tok-B',
          'x-workspace-id': 'H_B',
        },
        body: JSON.stringify({ text: 'Quais contas?', intentionId: 'm-1' }),
      });
      const secondDto = await second.json();
      assert.equal(secondDto.status, 'completed');
      assert.equal(secondDto.actionObserved, false, 'workspace B must not inherit A intent');
    } finally {
      await gw.close();
    }
  });
});
