// The runtime has no approval/card surface. Pending RPC routes that used to
// hand a proposal to the PWA are gone; the user-facing undo routes remain.
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer, parseRoute } from '../src/server.mjs';
import { createUndoStore } from '../src/undo-store.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const identity = { workspace: 'H_A', actorId: 'actor-A', deviceId: 'dev-A', role: 'owner' };

it('pending propose/active/decision RPCs do not exist; undo routes are preserved', async (t) => {
  for (const path of [
    '/agents/finance-chat-agent/H_A/rpc/pending-operations/propose',
    '/agents/finance-chat-agent/H_A/rpc/pending-operations/active',
    '/agents/finance-chat-agent/H_A/rpc/pending-operations/123e4567-e89b-42d3-a456-426614174000/decision',
  ]) {
    assert.equal(parseRoute(path), null, `removed route still parsed: ${path}`);
  }
  assert.deepEqual(parseRoute('/agents/finance-chat-agent/H_A/rpc/undo/active'), { workspaceId: 'H_A', route: 'undo/active' });
  assert.deepEqual(parseRoute('/agents/finance-chat-agent/H_A/rpc/undo/decision'), { workspaceId: 'H_A', route: 'undo/decision' });

  const store = createConversationStore({ persistDir: approvedTmpRoot('removed-surfaces-conv') });
  const undo = createUndoStore({ persistDir: approvedTmpRoot('removed-surfaces-undo') });
  const gw = createGatewayServer({
    resolveIdentity: async () => identity,
    store,
    undoStore: undo,
    promptHost: { chat: async () => ({}), readHistory: async () => [], readRawMessages: async () => [] },
    createRuntimeSession: async () => ({ runtimeSessionId: 'unused' }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
  });
  t.after(() => gw.close());
  const info = await gw.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://${info.host}:${info.port}/agents/finance-chat-agent/H_A/rpc`;
  const headers = { 'x-device-token': 'dev-tok', 'x-workspace-id': 'H_A' };

  const removedPropose = await fetch(`${base}/pending-operations/propose`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(removedPropose.status, 404);
  assert.deepEqual(await removedPropose.json(), { code: 'gateway.not_found', message: 'unknown route' });
  const removedActive = await fetch(`${base}/pending-operations/active`, { headers });
  assert.equal(removedActive.status, 404);
  const removedDecision = await fetch(`${base}/pending-operations/${identity.actorId}/decision`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(removedDecision.status, 404);

  const undoActive = await fetch(`${base}/undo/active`, { headers });
  assert.equal(undoActive.status, 200);
  assert.deepEqual(await undoActive.json(), { items: [], total: 0 });
});
