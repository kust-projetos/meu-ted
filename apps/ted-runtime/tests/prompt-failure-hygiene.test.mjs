// P2 prompt-failure hygiene (TDD RED): untyped SDK exceptions must NEVER
// leak raw text (secrets, keys, request bodies) to the HTTP client.
// Only the FIXED safe message for `prompt.failed` may surface; typed
// provider codes (`provider.denied`, `provider.unavailable`,
// `provider.transport`) keep their own fixed messages unchanged.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPromptFailure } from '../src/prompt.mjs';
import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const SECRET = 'fixture-secret-72636e2d-not-a-real-key OPENCODE_GO_API_KEY=topsecret-body-payload';

describe('prompt failure hygiene: untyped SDK text never reaches HTTP', () => {
  it('classifyPromptFailure maps untyped secret-like errors to a fixed safe message', () => {
    const err = classifyPromptFailure(new Error(`socket hangup: ${SECRET}`));
    assert.equal(err.code, 'prompt.failed');
    assert.ok(!String(err.message).includes('sk-ant-secret'), 'fixed message must not echo secret prefix');
    assert.ok(!String(err.message).includes('topsecret'), 'fixed message must not echo secret body');
    assert.ok(!String(err.message).includes('OPENCODE_GO'), 'fixed message must not echo credential names');
  });

  it('typed provider codes keep their fixed messages (no regression)', () => {
    assert.equal(classifyPromptFailure(new Error('provider denied: quota exhausted')).code, 'provider.denied');
    assert.equal(classifyPromptFailure(new Error('no-route for model')).code, 'provider.unavailable');
  });

  it('gateway HTTP chat failure carries no secret text', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-prompt-hygiene') });
    const { classifyPromptFailure: classify } = await import('../src/prompt.mjs');
    const promptHost = {
      chat: async () => {
        // Real adapter path: untyped SDK text goes through
        // classifyPromptFailure before crossing HTTP.
        throw classify(new Error(`upstream exploded: ${SECRET} requestBody={token:"abc"}`));
      },
      readHistory: async () => [],
      readRawMessages: async () => [],
    };
    const gw = createGatewayServer({
      resolveIdentity: async () => ({ actorId: 'actor-A', workspace: 'H_A', role: 'owner', deviceId: 'dev-A', deviceHousehold: 'H_A' }),
      store,
      promptHost,
      createRuntimeSession: async (identity, conversationId) => ({ runtimeSessionId: `rt-${conversationId}` }),
      bindAuthenticatedSession: async () => true,
      withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
    });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://${info.host}:${info.port}`;
    try {
      const res = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A' },
        body: JSON.stringify({ text: 'saldo?', intentionId: 'hygiene-1' }),
      });
      const body = await res.json();
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes('sk-ant-secret'), 'HTTP body must not contain secret prefix');
      assert.ok(!raw.includes('topsecret'), 'HTTP body must not contain secret body');
      assert.ok(!raw.includes('OPENCODE_GO_API_KEY'), 'HTTP body must not contain credential names');
      assert.equal(body.code, 'prompt.failed');
    } finally {
      await gw.close();
    }
  });
});
