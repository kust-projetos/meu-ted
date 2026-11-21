import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { createActionIntentRegistry } from '../src/action-intents.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

it('reports only whether the gateway observed a proposal during the turn', async () => {
  const registry = createActionIntentRegistry();
  const store = createConversationStore({ persistDir: approvedTmpRoot('proposal-observed') });
  const gateway = createGatewayServer({
    resolveIdentity: async ({ workspaceId }) => ({
      actorId: 'actor-A', workspace: workspaceId, role: 'owner',
      deviceId: 'dev-A', deviceHousehold: workspaceId,
    }),
    store,
    promptHost: {
      chat: async ({ sessionID }) => {
        registry.record(sessionID, { tool: 'categories.create', intentionId: 'intent-test',
          summary: 'test', normalizedArgs: { name: 'test', kind: 'expense' } });
        return { turnId: 'turn-test', output: 'ok' };
      },
      readHistory: async () => [],
      readRawMessages: async () => [],
    },
    createRuntimeSession: async (_identity, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
    withAuthenticatedSession: async (_sessionID, _host, fn) => fn(),
    actionIntents: registry,
  });
  const info = await gateway.listen({ port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`http://${info.host}:${info.port}/agents/finance-chat-agent/H_A/rpc/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'better-auth.session_token=test',
        'x-device-token': 'test-token',
        'x-workspace-id': 'H_A',
      },
      body: JSON.stringify({ text: 'test', intentionId: 'message-test' }),
    });
    const dto = await response.json();
    assert.equal(response.status, 200);
    assert.equal(dto.actionObserved, true);
    assert.deepEqual(Object.keys(dto).sort(), ['actionObserved', 'intentionId', 'output', 'status', 'turnId']);
    assert.equal('proposal' in dto, false, 'no actionable card surface');
    assert.equal(registry.size(), 0);
  } finally {
    await gateway.close();
  }
});
