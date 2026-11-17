import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../src/server.mjs';
import { createConversationStore, serializeConversationCookie } from '../src/conversations.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';
import { deriveAutoExecIdempotencyKey, tryAutoCreateCategory } from '../src/category-autoexec.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const identity = { workspace: 'w', actorId: 'actor', deviceId: 'device', role: 'owner' };
const secret = 'synthetic-test-secret-not-real-0001';
const category = { tool: 'categories.create', intentionId: 'int-0123456789abcdef0123456789abcdef', normalizedArgs: { name: 'Food', kind: 'expense' } };

async function turn({ pin = true, enabled = false, client = null, intent = category, text = 'create category', requestTimeoutMs, abortRequestAfterMs, retryAfterAbort = false, seedRecovery = false } = {}) {
  const proposalIntents = createProposalIntentRegistry();
  const store = createConversationStore({ persistDir: approvedTmpRoot('autoexec-gateway') });
  const settled = [];
  const settleIntention = store.settleIntention.bind(store);
  store.settleIntention = (...args) => { settled.push({ intentionId: args[1], ...args[2] }); return settleIntention(...args); };
  const diagnostics = [];
  const mintCalls = { value: 0 };
  let seededCookie;
  if (seedRecovery) {
    const record = store.create({ workspace: 'w', ownerActor: 'actor', deviceId: 'device' });
    store.attachRuntime(record.conversationId, 'rt', 'actor');
    store.claimIntention(record.conversationId, 'i', 'actor');
    store.settleIntention(record.conversationId, 'i', { status: 'pending', userMessageId: 'user-message', actorId: 'actor' });
    proposalIntents.record('rt', intent);
    seededCookie = serializeConversationCookie('w', record.conversationId).split(';')[0];
  }
  const autoExecClient = client ?? {
    async mint() { mintCalls.value++; return { token: secret }; },
  };
  const gateway = createGatewayServer({
    resolveIdentity: async () => identity, store, proposalIntents,
    autoExecEnabled: enabled, autoExecClient,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    promptHost: {
      async chat({ sessionID }) {
        proposalIntents.record(sessionID, intent);
        return { turnId: 'turn', userMessageId: 'user-message', output: 'done' };
      },
      async readRawMessages() {
        return [
          { type: 'user', id: 'user-message', text: 'create category', time: { created: 1 } },
          { type: 'assistant', id: 'assistant-message', content: [{ type: 'text', text: 'done' }], time: { created: 2 } },
        ];
      },
    },
    createRuntimeSession: async () => ({ runtimeSessionId: 'rt' }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
    diagnosticsSink: (event) => diagnostics.push(event),
  });
  try {
    const { host, port } = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`;
    let cookie = seededCookie;
    if (pin && !seededCookie) {
      const fresh = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ text: 'bootstrap', intentionId: 'boot' }) });
      cookie = fresh.headers.get('set-cookie')?.split(';')[0];
    }
    const send = async (abortAfter) => {
      const requestController = new AbortController();
      const abortTimer = abortAfter ? setTimeout(() => requestController.abort(), abortAfter) : null;
      let result;
      try {
        result = await fetch(url, { method: 'POST', headers: { ...headers(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ text, intentionId: 'i' }), signal: requestController.signal });
      } catch { /* disconnect is the scenario under test */ }
      if (abortTimer) clearTimeout(abortTimer);
      return result;
    };
    let response = await send(abortRequestAfterMs);
    if (!response && retryAfterAbort) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      response = await send(undefined);
    }
    if (!response) await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      payload: response ? await response.json() : {}, httpStatus: response?.status, mintCalls, diagnostics,
      intention: settled.filter((entry) => entry.intentionId === 'i').at(-1) ?? null,
      settleWrites: settled.filter((entry) => entry.intentionId === 'i'),
      proposalIntents,
    };
  } finally {
    await gateway.close();
  }
}
function headers() { return { 'content-type': 'application/json', 'x-device-token': secret, 'x-workspace-id': 'w' }; }
function successfulClient(status = 'executed') {
  const calls = { mint: 0, authorize: 0, execute: 0 };
  return {
    calls,
    async mint() { calls.mint++; return { token: secret }; },
    async propose() { return { operationId: 'pending-id', existing: status === 'existing' }; },
    async authorize() { calls.authorize++; return { status: 'confirmed', attestation: secret }; },
    async execute() {
      calls.execute++;
      if (status === 'left_pending') throw new Error(`native detail ${secret}`);
      if (status === 'invalid_receipt') return { status: 'bad' };
      return { id: 'pending-id', status: 'succeeded', execution: { status: 'succeeded', operationId: 'category-id', receipt: { mutationKind: 'categories.create', status: 'succeeded', mutationId: 'mutation-id', operationId: 'pending-id', entity: { type: 'category', id: 'category-id' } } } };
    },
  };
}

test('gateway autoexec only executes eligible intents on enabled B pin and preserves pending proposals', async () => {
  const disabledClient = successfulClient();
  const disabled = await turn({ enabled: false, client: disabledClient });
  assert.equal(disabledClient.calls.mint, 0);
  assert.ok(disabled.payload.proposal);
  assert.equal('autoexec' in disabled.payload, false);
  assert.deepEqual(disabled.settleWrites.map((entry) => entry.status), ['completed']);

  const noPinClient = successfulClient();
  const noPin = await turn({ pin: false, enabled: true, client: noPinClient });
  assert.equal(noPinClient.calls.mint, 0);
  assert.ok(noPin.payload.proposal);
  assert.equal('autoexec' in noPin.payload, false);

  const executedClient = successfulClient();
  const executed = await turn({ enabled: true, client: executedClient });
  assert.deepEqual(executed.payload.autoexec, { status: 'executed' });
  assert.equal('proposal' in executed.payload, false);
  assert.equal(executed.intention.status, 'completed');
  assert.doesNotMatch(JSON.stringify({ payload: executed.payload, diagnostics: executed.diagnostics }), /pending-id|category-id|mutation-id|operationId|attestation|synthetic-test-secret|apropriation/i);

  const pending = await turn({ enabled: true, client: successfulClient('left_pending') });
  assert.ok(pending.payload.proposal);
  assert.deepEqual(pending.payload.autoexec, { status: 'uncertain' });
  assert.doesNotMatch(JSON.stringify(pending.payload), new RegExp(secret));
  assert.equal(pending.intention.status, 'completed');
  assert.equal(pending.proposalIntents.size(), 0);
});

test('existing proposal is delivered without authorize or execute', async () => {
  const client = successfulClient('existing');
  const result = await turn({ enabled: true, client });
  assert.ok(result.payload.proposal);
  assert.equal(client.calls.authorize, 0);
  assert.equal(client.calls.execute, 0);
});

test('outer timeout aborts autoexec and leaves intention pending and proposal available', async () => {
  const client = {
    calls: { mint: 0 },
    async mint({ signal }) {
      this.calls.mint++;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ token: secret }), { once: true }));
    },
  };
  const result = await turn({ enabled: true, client, abortRequestAfterMs: 30 });
  assert.equal(result.intention.status, 'pending');
  assert.ok(result.intention.userMessageId);
  assert.equal(result.proposalIntents.size(), 1);
  assert.equal(client.calls.mint, 1);
});

test('pending retry re-delivers only the matching proposal when autoexec is enabled', async () => {
  const client = {
    calls: { mint: 0 },
    async mint({ signal }) {
      this.calls.mint++;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ token: secret }), { once: true }));
    },
  };
  const result = await turn({ enabled: true, client, abortRequestAfterMs: 30, retryAfterAbort: true });
  assert.deepEqual(result.payload.proposal, category);
  assert.equal(result.payload.status, 'completed');
  assert.equal(result.proposalIntents.size(), 0);
});

test('pending recovery clears a residual proposal from another intention', async () => {
  const result = await turn({
    enabled: true, seedRecovery: true,
    intent: { ...category, intentionId: 'other-intention' },
  });
  assert.equal(result.payload.status, 'completed');
  assert.equal('proposal' in result.payload, false);
  assert.equal(result.proposalIntents.size(), 0);
});

test('pending recovery with all flags off preserves the old payload without proposal', async () => {
  const result = await turn({ enabled: false, seedRecovery: true });
  assert.equal(result.payload.status, 'completed');
  assert.equal('proposal' in result.payload, false);
  assert.equal('autoexec' in result.payload, false);
});

test('invalid execute receipt returns uncertain with the proposal', async () => {
  const result = await turn({ enabled: true, client: successfulClient('invalid_receipt') });
  assert.ok(result.payload.proposal);
  assert.deepEqual(result.payload.autoexec, { status: 'uncertain' });
});

test('shared A0/B V2 idempotency replays the same proposal and executes once; distinct keys are distinct intents', async () => {
  const store = new Map();
  let executions = 0;
  const sharedClient = {
    async mint() { return { token: secret }; },
    async propose({ idempotencyKey }) {
      if (store.has(idempotencyKey)) return { operationId: store.get(idempotencyKey), existing: true }; // API replay: HTTP 200.
      const id = `pending-${store.size + 1}`;
      store.set(idempotencyKey, id);
      return { operationId: id, existing: false };
    },
    async authorize({ operationId }) { return { operationId, status: 'confirmed', attestation: secret }; },
    async execute({ operationId }) {
      if (![...store.values()].includes(operationId)) throw new Error('unknown operation');
      if (store.executed) return { id: operationId, status: 'succeeded', execution: { status: 'succeeded', operationId: 'category-id', receipt: { mutationKind: 'categories.create', status: 'succeeded', mutationId: 'm', operationId, entity: { type: 'category', id: 'category-id' } } } };
      store.executed = true;
      executions++;
      return { id: operationId, status: 'succeeded', execution: { status: 'succeeded', operationId: 'category-id', receipt: { mutationKind: 'categories.create', status: 'succeeded', mutationId: 'm', operationId, entity: { type: 'category', id: 'category-id' } } } };
    },
  };
  const a0Key = deriveAutoExecIdempotencyKey('w', 'i');
  assert.equal(a0Key, 'e9cf96a5b2208b84d8ac4523c0efdf0105da45c80880e4448455edb2867e38c7');
  // Both runtimes rely on the same derivation; no cross-runtime lock is assumed.
  assert.deepEqual(await tryAutoCreateCategory({ client: sharedClient, identity, intentionId: 'i', intent: category }), { status: 'executed' });
  const replay = await sharedClient.propose({ idempotencyKey: a0Key });
  assert.deepEqual(replay, { operationId: 'pending-1', existing: true });
  assert.equal(executions, 1);
  assert.notEqual(deriveAutoExecIdempotencyKey('w', 'i-other'), a0Key, 'different intentionIds intentionally produce distinct operations');
});
