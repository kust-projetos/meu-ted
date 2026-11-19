import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createPendingClient, PendingClientError } from '../src/pending-client.mjs';
import { createConversationStore } from '../src/conversations.mjs';
import { serializeConversationCookie } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { correctionActionRegistry } from '../src/correction-actions.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';
import { createUndoStore } from '../src/undo-store.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const identity = { workspaceId: 'w', actorId: 'a', deviceId: 'd', token: 'token' };

test('pending client projects real proposal response extras and supersedes with idempotency header', async () => {
  const calls = [];
  const client = createPendingClient({
    apiBaseUrl: 'http://127.0.0.1:3001',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith('/supersede')
        ? { id: 'new-id', existing: false, supersedes: 'old-id' }
        : { id: 'old-id', tool: 'transactions.expense.create', status: 'proposed', normalizedArgs: { amountCents: 100 }, proposalHash: 'a'.repeat(64), version: 2, bindings: {}, workspaceId: 'w', idempotencyKey: 'private-key', executionAttemptCount: 0, supersedesId: null };
      return { ok: true, status: 200, json: async () => body };
    },
  });
  assert.deepEqual(await client.get({ ...identity, id: 'old-id' }), {
    id: 'old-id', tool: 'transactions.expense.create', status: 'proposed',
    normalizedArgs: { amountCents: 100 }, proposalHash: 'a'.repeat(64),
  });
  const key = createHash('sha256').update('w:i:transactions.expense.create').digest('hex');
  assert.deepEqual(await client.supersede({
    ...identity, id: 'old-id', tool: 'transactions.expense.create',
    normalizedArgs: { amountCents: 200 }, expectedProposalHash: 'a'.repeat(64), idempotencyKey: key,
  }), { id: 'new-id', existing: false, supersedes: 'old-id' });
  assert.equal(calls[1].init.headers['Idempotency-Key'], key);
  assert.equal(calls[1].init.body, JSON.stringify({
    tool: 'transactions.expense.create', normalizedArgs: { amountCents: 200 },
    expectedProposalHash: 'a'.repeat(64),
  }));
});

test('pending client rejects malformed operation shapes without exposing response body', async () => {
  const client = createPendingClient({
    apiBaseUrl: 'http://127.0.0.1:3001',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ secret: 'do-not-leak' }) }),
  });
  await assert.rejects(client.get({ ...identity, id: 'old-id' }), (error) =>
    error instanceof PendingClientError && !error.message.includes('do-not-leak'));
});

test('pending client rejects an attestation in a get response', async () => {
  const client = createPendingClient({
    apiBaseUrl: 'http://127.0.0.1:3001',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      id: 'old-id', tool: 'transactions.expense.create', status: 'proposed',
      normalizedArgs: {}, proposalHash: 'a'.repeat(64), attestation: 'sensitive',
    }) }),
  });
  await assert.rejects(client.get({ ...identity, id: 'old-id' }), PendingClientError);
});

test('pending client rejects proposal responses missing required fields or with invalid hash', async () => {
  const valid = { id: 'old-id', tool: 'transactions.expense.create', status: 'proposed', normalizedArgs: {}, proposalHash: 'a'.repeat(64) };
  for (const malformed of [
    { ...valid, id: undefined },
    { ...valid, tool: undefined },
    { ...valid, proposalHash: 'invalid' },
  ]) {
    const client = createPendingClient({
      apiBaseUrl: 'http://127.0.0.1:3001',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => malformed }),
    });
    await assert.rejects(client.get({ ...identity, id: 'old-id' }), PendingClientError);
  }
});

test('conversation active operation metadata persists and can be cleared', () => {
  const store = createConversationStore({ persistDir: approvedTmpRoot('active-operation') });
  const conversation = store.create({ workspace: 'w', ownerActor: 'a', deviceId: 'd' });
  const operationId = '550e8400-e29b-41d4-a716-446655440000';
  store.setActiveOperation(conversation.conversationId, operationId, 'a');
  assert.equal(store.get(conversation.conversationId, { workspace: 'w', actorId: 'a' }).activeOperationId, operationId);
  store.setActiveOperation(conversation.conversationId, null);
  assert.equal(store.get(conversation.conversationId, { workspace: 'w', actorId: 'a' }).activeOperationId, null);
});

test('turn gets safe pending proposal context only for the matching actor and degrades softly', async () => {
  const scenarios = [
    { name: 'matching proposal', activeActor: 'owner', fails: false, context: true },
    { name: 'no active proposal', activeActor: null, fails: false, context: false },
    { name: 'different proposal actor', activeActor: 'other', fails: false, context: false },
    { name: 'pending lookup failure', activeActor: 'owner', fails: true, context: false },
  ];
  for (const scenario of scenarios) {
    const store = createConversationStore({ persistDir: approvedTmpRoot(`turn-context-${scenario.name.replaceAll(' ', '-')}`) });
    const owner = { workspace: 'w', actorId: 'owner', deviceId: 'd' };
    const conversation = store.create({ workspace: 'w', ownerActor: 'owner', deviceId: 'd' });
    store.attachRuntime(conversation.conversationId, 'runtime-context', 'owner');
    if (scenario.activeActor) store.setActiveOperation(conversation.conversationId, '550e8400-e29b-41d4-a716-446655440099', scenario.activeActor);
    let observedText;
    const gateway = createGatewayServer({
      resolveIdentity: async () => owner, store,
      pendingClient: {
        async mintToken() { return 'private-token'; },
        async get() {
          if (scenario.fails) throw new Error('lookup failed');
          return {
            id: '550e8400-e29b-41d4-a716-446655440099', tool: 'transactions.expense.create',
            status: 'proposed', proposalHash: 'private-hash',
            normalizedArgs: { amountCents: 350000, description: 'Almoço', date: '2026-11-17' },
          };
        },
      },
      promptHost: { async chat({ text }) {
        observedText = text;
        return { turnId: 'turn-context', output: 'OK' };
      } },
      createRuntimeSession: async () => ({ runtimeSessionId: 'runtime-context' }),
      withAuthenticatedSession: async (_id, _host, fn) => fn(),
      diagnosticsSink: () => {},
    });
    try {
      const { host, port } = await gateway.listen();
      const response = await fetch(`http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-device-token': 'host-device-token',
          cookie: serializeConversationCookie('w', conversation.conversationId).split(';')[0],
        },
        body: JSON.stringify({ text: 'Na verdade, foram 3500.', intentionId: `context-${scenario.name}` }),
      });
      assert.equal(response.status, 200, scenario.name);
      if (scenario.context) {
        assert.match(observedText, /\[PENDING PROPOSAL CONTEXT/);
        assert.match(observedText, /tool: transactions\.expense\.create/);
        assert.match(observedText, /amountCents=350000/);
        assert.doesNotMatch(observedText, /private-token|private-hash|550e8400-e29b-41d4-a716-446655440099/);
      } else {
        assert.equal(observedText, 'Na verdade, foram 3500.');
      }
    } finally {
      await gateway.close();
    }
  }
});

test('gateway supersedes only a proposed owner operation, merges untouched args and suppresses proposal', async () => {
  const directory = approvedTmpRoot('correction-turn');
  const store = createConversationStore({ persistDir: directory });
  const owner = { workspace: 'w', actorId: 'owner', deviceId: 'd' };
  const conversation = store.create({ workspace: 'w', ownerActor: 'owner', deviceId: 'd' });
  store.attachRuntime(conversation.conversationId, 'runtime-correction', 'owner');
  const oldId = '550e8400-e29b-41d4-a716-446655440000';
  const newId = '550e8400-e29b-41d4-a716-446655440001';
  store.setActiveOperation(conversation.conversationId, oldId, owner.actorId);
  const proposalIntents = createProposalIntentRegistry();
  const calls = [];
  const client = {
    async mintToken() { return 'signed-token'; },
    async get(input) {
      calls.push(['get', input]);
      return {
        id: oldId, tool: 'transactions.expense.create', status: 'proposed',
        proposalHash: 'a'.repeat(64),
        normalizedArgs: {
          amountCents: 5000, description: 'Almoço', date: '2026-11-17',
          accountId: '00000000-0000-0000-0000-000000000001',
          categoryId: '00000000-0000-0000-0000-000000000002',
        },
      };
    },
    async supersede(input) { calls.push(['supersede', input]); return { id: newId, existing: false, supersedes: oldId }; },
  };
  const gateway = createGatewayServer({
    resolveIdentity: async () => owner, store, proposalIntents, pendingClient: client,
    promptHost: { async chat({ sessionID }) {
      correctionActionRegistry.record(sessionID, {
        action: 'correct', changed: { amountCents: 7500 }, intentionId: 'turn-intent',
      });
      proposalIntents.record(sessionID, { tool: 'transactions.expense.create', normalizedArgs: { amountCents: 1 } });
      return { turnId: 'turn', output: 'Atualizei a proposta.' };
    } },
    createRuntimeSession: async () => ({ runtimeSessionId: 'runtime-correction' }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
    diagnosticsSink: () => {},
  });
  try {
    const { host, port } = await gateway.listen();
    const response = await fetch(`http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-device-token': 'host-device-token',
        cookie: serializeConversationCookie('w', conversation.conversationId).split(';')[0],
      },
      body: JSON.stringify({ text: 'alterar valor', intentionId: 'turn-intent' }),
    });
    const payload = await response.json();
    assert.equal(payload.status, 'completed');
    assert.equal('proposal' in payload, false);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'supersede']);
    assert.deepEqual(calls[2][1].normalizedArgs, {
      amountCents: 7500, description: 'Almoço', date: '2026-11-17',
      accountId: '00000000-0000-0000-0000-000000000001',
      categoryId: '00000000-0000-0000-0000-000000000002',
    });
    assert.equal(calls[2][1].expectedProposalHash, 'a'.repeat(64));
    assert.equal(store.get(conversation.conversationId, owner).activeOperationId, newId);
  } finally {
    correctionActionRegistry.clear('runtime-correction');
    await gateway.close();
  }
});

test('cancel tool cancels the conversation proposal and clears its pointer', async () => {
  const directory = approvedTmpRoot('cancel-turn');
  const store = createConversationStore({ persistDir: directory });
  const identity = { workspace: 'w', actorId: 'owner', deviceId: 'd' };
  const conversation = store.create({ workspace: 'w', ownerActor: 'owner', deviceId: 'd' });
  store.attachRuntime(conversation.conversationId, 'runtime-cancel', 'owner');
  const id = '550e8400-e29b-41d4-a716-446655440002';
  store.setActiveOperation(conversation.conversationId, id, identity.actorId);
  const calls = [];
  const gateway = createGatewayServer({
    resolveIdentity: async () => identity, store,
    pendingClient: {
      async mintToken() { return 'signed-token'; },
      async cancel(input) { calls.push(input.id); return { id, status: 'cancelled' }; },
    },
    promptHost: { async chat({ sessionID }) {
      correctionActionRegistry.record(sessionID, { action: 'cancel', changed: {}, intentionId: 'cancel-turn' });
      return { turnId: 'turn', output: 'Cancelei a proposta.' };
    } },
    createRuntimeSession: async () => ({ runtimeSessionId: 'runtime-cancel' }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
    diagnosticsSink: () => {},
  });
  try {
    const { host, port } = await gateway.listen();
    const response = await fetch(`http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-device-token': 'host-device-token',
        cookie: serializeConversationCookie('w', conversation.conversationId).split(';')[0],
      },
      body: JSON.stringify({ text: 'cancele', intentionId: 'cancel-turn' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [id]);
    assert.equal(store.get(conversation.conversationId, identity).activeOperationId, null);
  } finally {
    correctionActionRegistry.clear('runtime-cancel');
    await gateway.close();
  }
});

test('undo intent creates one owner-bound card and a repeated request reuses its requestId', async () => {
  const store=createConversationStore({persistDir:approvedTmpRoot('undo-tool-turn')});
  const undoStore=createUndoStore({persistDir:approvedTmpRoot('undo-tool-turn-store')});
  const identity={workspace:'w',actorId:'owner',deviceId:'d'};
  const conversation=store.create({workspace:'w',ownerActor:'owner',deviceId:'d'});
  store.attachRuntime(conversation.conversationId,'runtime-undo-tool','owner');
  const gateway=createGatewayServer({
    resolveIdentity:async()=>identity,store,undoStore,
    promptHost:{async chat({sessionID,intentionId}) {
      correctionActionRegistry.record(sessionID,{
        action:'undo',intentionId,workspaceId:'w',actorId:'owner',deviceId:'d',conversationId:conversation.conversationId,
      });
      return {turnId:intentionId,userMessageId:`user-${intentionId}`,output:'Posso propor o desfazimento.'};
    }},
    createRuntimeSession:async()=>({runtimeSessionId:'runtime-undo-tool'}),
    withAuthenticatedSession:async(_id,_host,fn)=>fn(),diagnosticsSink:()=>{},
  });
  try {
    const {host,port}=await gateway.listen();
    const url=`http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`;
    const headers={'content-type':'application/json','x-device-token':'device-token',cookie:serializeConversationCookie('w',conversation.conversationId).split(';')[0]};
    for(const intentionId of ['undo-intent-1','undo-intent-2']) {
      const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({text:'desfazer última ação',intentionId})});
      assert.equal(response.status,200);
    }
    const active=undoStore.active({workspaceId:'w',actorId:'owner',deviceId:'d'});
    assert.equal(active.total,1);
    assert.equal(active.items[0].requestId,'undo-intent-1');
    assert.equal(Object.hasOwn(active.items[0],'target'),false);
  } finally {
    correctionActionRegistry.clear('runtime-undo-tool');
    await gateway.close();
  }
});

async function withLoopbackApi(handler, run) {
  const api = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const { port } = api.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => api.close(resolve)); }
}

async function correctionTurn({ actor, action, client, store, conversation, runtimeSessionId }) {
  const identity = { workspace: 'w', actorId: actor, deviceId: 'd' };
  const gateway = createGatewayServer({
    resolveIdentity: async () => identity, store, pendingClient: client,
    promptHost: { async chat({ sessionID }) {
      correctionActionRegistry.record(sessionID, { action, changed: { amountCents: 7500 }, intentionId: 'turn-intent' });
      return { turnId: 'turn', userMessageId:'user-turn', output: 'Proposta revisada.' };
    }, async readHistory() { return [{id:'turn',content:'Proposta revisada.'}]; } },
    createRuntimeSession: async () => ({ runtimeSessionId }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
    diagnosticsSink: () => {},
  });
  try {
    const { host, port } = await gateway.listen();
    const response = await fetch(`http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-device-token': 'host-device-token',
        cookie: serializeConversationCookie('w', conversation.conversationId).split(';')[0],
      },
      body: JSON.stringify({ text: 'alterar proposta', intentionId: `turn-${actor}-${runtimeSessionId}` }),
    });
    return { response, payload: await response.json() };
  } finally {
    correctionActionRegistry.clear(runtimeSessionId);
    await gateway.close();
  }
}

test('actor other than the proposal author cannot correct or cancel; neither reaches the API', async () => {
  for (const [action, apiMethod] of [['correct', 'supersede'], ['cancel', 'cancel']]) {
    const store = createConversationStore({ persistDir: approvedTmpRoot(`foreign-${action}`) });
    const conversation = store.create({ workspace: 'w', ownerActor: 'owner', deviceId: 'd' });
    const id = '550e8400-e29b-41d4-a716-446655440003';
    store.attachRuntime(conversation.conversationId, `runtime-foreign-${action}`, 'owner');
    store.setActiveOperation(conversation.conversationId, id, 'owner');
    const calls = [];
    const client = {
      async mintToken() { calls.push('mint'); return 'signed-token'; },
      async [apiMethod]() { calls.push(apiMethod); },
    };
    const { response, payload } = await correctionTurn({
      actor: 'different-actor', action, client, store, conversation,
      runtimeSessionId: `runtime-foreign-${action}`,
    });
    assert.equal(response.status, 200);
    assert.equal(payload.output, 'Proposta revisada.');
    assert.deepEqual(calls, []);
    assert.equal(store.get(conversation.conversationId, { workspace: 'w', actorId: 'owner' }).activeOperationId, id);
  }
});

test('shared conversation keeps proposal actor bound: A cannot change B operation; B changes op2', async () => {
  const store = createConversationStore({ persistDir: approvedTmpRoot('shared-active-proposal') });
  const conversation = store.create({ workspace: 'w', ownerActor: 'actor-a', deviceId: 'd' });
  store.attachRuntime(conversation.conversationId, 'runtime-shared', 'actor-a');
  const op1 = '550e8400-e29b-41d4-a716-446655440010';
  const op2 = '550e8400-e29b-41d4-a716-446655440011';
  const op3 = '550e8400-e29b-41d4-a716-446655440012';
  store.setActiveOperation(conversation.conversationId, op1, 'actor-a');
  store.setActiveOperation(conversation.conversationId, op2, 'actor-b');
  const calls = [];
  const client = {
    async mintToken() { calls.push('mint'); return 'signed-token'; },
    async get(input) {
      calls.push(['get', input.id]);
      return {
        id: op2, tool: 'transactions.expense.create', status: 'proposed',
        proposalHash: 'c'.repeat(64),
        normalizedArgs: {
          amountCents: 5000, description: 'Almoço', date: '2026-11-17',
          accountId: '00000000-0000-0000-0000-000000000001',
          categoryId: '00000000-0000-0000-0000-000000000002',
        },
      };
    },
    async supersede(input) { calls.push(['supersede', input.id]); return { id: op3, existing: false, supersedes: op2 }; },
  };
  const rejected = await correctionTurn({
    actor: 'actor-a', action: 'correct', client, store, conversation, runtimeSessionId: 'runtime-shared',
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.payload.output, 'Proposta revisada.');
  assert.deepEqual(calls, []);
  const accepted = await correctionTurn({
    actor: 'actor-b', action: 'correct', client, store, conversation, runtimeSessionId: 'runtime-shared',
  });
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(calls, ['mint', ['get', op2], 'mint', ['get', op2], ['supersede', op2]]);
  assert.equal(store.get(conversation.conversationId, { workspace: 'w', actorId: 'actor-a' }).activeOperationId, op3);
  assert.equal(store.get(conversation.conversationId, { workspace: 'w', actorId: 'actor-a' }).activeOperationActorId, 'actor-b');
});

test('loopback supersede 404 is typed, preserves activeOperationId, and never falls back to propose', async () => {
  const store = createConversationStore({ persistDir: approvedTmpRoot('supersede-disabled') });
  const owner = { workspace: 'w', actorId: 'owner', deviceId: 'd' };
  const conversation = store.create({ workspace: 'w', ownerActor: 'owner', deviceId: 'd' });
  const oldId = '550e8400-e29b-41d4-a716-446655440004';
  store.attachRuntime(conversation.conversationId, 'runtime-disabled', 'owner');
  store.setActiveOperation(conversation.conversationId, oldId, owner.actorId);
  const seen = [];
  await withLoopbackApi(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const body = Buffer.concat(chunks).toString();
    seen.push({ path, body });
    res.setHeader('content-type', 'application/json');
    if (path === '/auth/agent/pending-token') {
      res.end(JSON.stringify({ token: 't'.repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    } else if (path === `/pending-operations/v2/${oldId}`) {
      res.end(JSON.stringify({
        id: oldId, tool: 'transactions.expense.create', status: 'proposed',
        normalizedArgs: {
          amountCents: 5000, description: 'Almoço', date: '2026-11-17',
          accountId: '00000000-0000-0000-0000-000000000001',
          categoryId: '00000000-0000-0000-0000-000000000002',
        },
        proposalHash: 'b'.repeat(64),
      }));
    } else if (path.endsWith('/supersede')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'pending.supersede_disabled' }));
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 'unexpected_route' }));
    }
  }, async (apiBaseUrl) => {
    const client = createPendingClient({
      apiBaseUrl, pendingMintToken: 'm'.repeat(40),
    });
    const { response, payload } = await correctionTurn({
      actor: 'owner', action: 'correct', client, store, conversation,
      runtimeSessionId: 'runtime-disabled',
    });
    assert.equal(response.status, 200);
    assert.match(payload.output, /Não consegui aplicar o ajuste agora; a proposta segue como estava\./);
    assert.equal(store.get(conversation.conversationId, owner).activeOperationId, oldId);
    const admittedIntention=store.getIntention(conversation.conversationId,'turn-owner-runtime-disabled');
    assert.equal(admittedIntention.status,'completed');
    assert.equal(admittedIntention.userMessageId,'user-turn');
    const recovered=await correctionTurn({
      actor:'owner',action:'correct',client,store,conversation,runtimeSessionId:'runtime-disabled',
    });
    assert.equal(recovered.response.status,200);
    assert.equal(recovered.payload.output,'Proposta revisada.');
    assert.deepEqual(seen.map(({ path }) => path), [
      '/auth/agent/pending-token',
      `/pending-operations/v2/${oldId}`,
      '/auth/agent/pending-token',
      `/pending-operations/v2/${oldId}`,
      `/pending-operations/v2/${oldId}/supersede`,
    ]);
    assert.equal(seen.some(({ path }) => path.endsWith('/propose')), false);
  });
  function unused() {}
});
