// Etapa C-WIRE contract (TDD RED-first): the REAL gateway/SDK request path
// created by createGatewayServer must emit diagnostics by default — not merely
// expose an unused wrapper. One fresh opaque UUID per /rpc/chat request is
// reused across that turn's gateway/SDK events; it is never derived from
// turn identifiers and never returned in the public DTO/headers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set([
  'event', 'correlationId', 'startedAt', 'endedAt', 'durationMs',
  'phase', 'outcome', 'cause', 'httpStatus',
]);

function buildServer({ events, promptChat, readHistory, readRawMessages } = {}) {
  const store = createConversationStore({ persistDir: approvedTmpRoot('ted-gw-diag') });
  const calls = { chat: 0 };
  const promptHost = {
    chat: async (args) => {
      calls.chat += 1;
      if (promptChat) return promptChat(args);
      return { turnId: 'turn-local-1', output: 'ok-local', userMessageId: 'u-local-1' };
    },
    readHistory: async (args) => (readHistory ? readHistory(args) : []),
    readRawMessages: async (args) => (readRawMessages ? readRawMessages(args) : []),
  };
  const gw = createGatewayServer({
    resolveIdentity: async () => ({
      actorId: 'actor-A', workspace: 'H_A', role: 'owner',
      deviceId: 'dev-A', deviceHousehold: 'H_A',
    }),
    store,
    promptHost,
    createRuntimeSession: async () => ({ runtimeSessionId: 'rt-local-1' }),
    withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
    diagnosticsSink: (e) => events.push(e),
  });
  return { gw, calls };
}

async function postChat(base, intentionId) {
  const res = await fetch(`${base}/agents/finance-chat-agent/H_A/rpc/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 's=a', 'x-device-token': 'd', 'x-workspace-id': 'H_A',
    },
    body: JSON.stringify({ text: 'saldo?', intentionId }),
  });
  return { status: res.status, body: await res.json() };
}

describe('etapa C-WIRE: real gateway path emits correlated diagnostics', () => {
  it('a real /rpc/chat turn emits >=2 events sharing one fresh opaque correlation', async () => {
    const events = [];
    const { gw } = buildServer({ events });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://${info.host}:${info.port}`;
    try {
      const { status, body } = await postChat(base, 'wire-contract-1');
      assert.equal(status, 200);
      assert.ok(events.length >= 2, `real path must emit gateway+turn events (got ${events.length})`);
      const ids = new Set(events.map((e) => e.correlationId));
      assert.equal(ids.size, 1, 'one correlation UUID reused across the turn');
      const [cid] = [...ids];
      assert.match(cid, UUID_RE);
      assert.ok(!['wire-contract-1', 'rt-local-1', 'turn-local-1', 'u-local-1', 'actor-A', 'H_A'].includes(cid));
      for (const e of events) {
        for (const k of Object.keys(e)) assert.ok(ALLOWED_KEYS.has(k), `allow-list only (got ${k})`);
      }
      const raw = JSON.stringify(events);
      assert.ok(!raw.includes('saldo?'), 'no prompt text in events');
      assert.ok(!raw.includes('wire-contract-1'), 'no intention id in events');
      assert.ok(!raw.includes('actor-A'), 'no actor id in events');
      // Correlation never leaks into the public DTO.
      assert.ok(!('correlationId' in body), 'DTO carries no correlation');
      assert.ok(!JSON.stringify(body).includes(cid), 'DTO text carries no correlation');
    } finally {
      await gw.close();
    }
  });

  it('failure path preserves the public code, calls once, and still emits', async () => {
    const events = [];
    const err = Object.assign(new Error('typed-transport'), { code: 'provider.transport' });
    const { gw, calls } = buildServer({ events, promptChat: async () => { throw err; } });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { status, body } = await postChat(`http://${info.host}:${info.port}`, 'wire-contract-2');
      assert.equal(status, 502);
      assert.equal(body.code, 'provider.transport');
      assert.equal(calls.chat, 1);
      assert.ok(events.length >= 2, `failure must still emit (got ${events.length})`);
      const finish = events.find((e) => e.outcome === 'failure');
      assert.ok(finish, 'a failure event exists');
      assert.equal(finish.cause, 'provider_transport_opaque');
      assert.equal(new Set(events.map((e) => e.correlationId)).size, 1);
    } finally {
      await gw.close();
    }
  });

  it('deadline-marked no_output keeps public 502 and emits runtime timeout without leaking details', async () => {
    // REVIEW-FIX 1 end-to-end: the internal deadline marker classifies the
    // runtime timeout, but details (userMessageId/deadlineExceeded) never
    // cross HTTP — the public body carries only the fixed code/message.
    const events = [];
    const { PromptError } = await import('../src/prompt.mjs');
    const err = new PromptError(
      'prompt.no_output',
      'prompt admitted but no assistant output observable — failing closed (no fabricated output)',
      { userMessageId: 'u-dl-9', deadlineExceeded: true },
    );
    const { gw } = buildServer({ events, promptChat: async () => { throw err; } });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { status, body } = await postChat(`http://${info.host}:${info.port}`, 'wire-deadline-1');
      assert.equal(status, 502);
      assert.equal(body.code, 'prompt.no_output');
      assert.ok(!('details' in body), 'details never serialized to HTTP');
      assert.ok(!JSON.stringify(body).includes('deadlineExceeded'), 'marker never leaks to the client');
      const finish = events.find((e) => e.outcome === 'failure');
      assert.ok(finish, 'a failure event exists');
      assert.equal(finish.cause, 'timeout');
      assert.equal(finish.httpStatus, undefined);
    } finally {
      await gw.close();
    }
  });

  it('sink failure cannot change the gateway result', async () => {
    const store = (await import('../src/conversations.mjs')).createConversationStore({
      persistDir: approvedTmpRoot('ted-gw-diag-sink'),
    });
    const gw = createGatewayServer({
      resolveIdentity: async () => ({
        actorId: 'actor-A', workspace: 'H_A', role: 'owner',
        deviceId: 'dev-A', deviceHousehold: 'H_A',
      }),
      store,
      promptHost: {
        chat: async () => ({ turnId: 't', output: 'ok', userMessageId: 'u' }),
        readHistory: async () => [],
        readRawMessages: async () => [],
      },
      createRuntimeSession: async () => ({ runtimeSessionId: 'rt-sink-1' }),
      withAuthenticatedSession: async (sessionID, host, fn) => await fn(),
      diagnosticsSink: () => { throw new Error('sink exploded'); },
    });
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { status, body } = await postChat(`http://${info.host}:${info.port}`, 'wire-contract-3');
      assert.equal(status, 200);
      assert.equal(body.status, 'completed');
    } finally {
      await gw.close();
    }
  });
});
