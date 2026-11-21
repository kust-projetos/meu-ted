// TED action executor (runtime only, unconditional).
// Acceptance: success, bad assurance, 409 not_actionable, execution_uncertain,
// intention-idempotency. No real secrets, no real HTTP, no production surface:
// every collaborator is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayServer } from '../src/server.mjs';
import { createConversationStore } from '../src/conversations.mjs';
import { createActionIntentRegistry } from '../src/action-intents.mjs';
import { PendingClientError, proposeIdempotencyKey } from '../src/pending-client.mjs';
import { createToolExecutors } from '../src/tool-defs.mjs';
import {
  normalizeAssurance,
  isActionableAssurance,
  createActionExecutor,
} from '../src/action-executor.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const DEVICE_TOKEN = 'synthetic-device-token-not-real-0001';
const ATTESTATION = 'a'.repeat(64);
const OPERATION_ID = 'pending-op-1';
const ASSURANCE = Object.freeze({ complete: true, ambiguousEntity: false, explicitIntent: true });
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const TOOL = 'transactions.expense.create';
const INTENTION = 'i';

function baseIntent(overrides = {}) {
  return {
    tool: TOOL,
    intentionId: INTENTION,
    summary: 'Despesa de R$ 50,00 em "mercado"',
    normalizedArgs: {
      amountCents: 5000,
      description: 'mercado',
      date: '2026-11-06',
      accountId: ACCOUNT,
      categoryId: CATEGORY,
    },
    assurance: { ...ASSURANCE },
    ...overrides,
  };
}

function successfulReceipt(operationId = OPERATION_ID) {
  return {
    mutationId: 'mutation-1',
    mutationKind: TOOL,
    status: 'succeeded',
    affectedTargets: ['transactions'],
    operationId,
    entity: { type: 'transaction', id: 'tx-1' },
  };
}

function fakeClient({
  outcomeStatus = 'succeeded',
  outcomeThrows = false,
  executeThrows = false,
  proposeThrows = null,
  confirmThrows = null,
} = {}) {
  const calls = { mint: [], propose: [], confirm: [], execute: [], outcome: [] };
  return {
    calls,
    async mintToken(input) { calls.mint.push(input); return 'minted-pending-token'; },
    async propose(input) {
      calls.propose.push(input);
      if (proposeThrows) throw proposeThrows;
      return { id: OPERATION_ID, existing: false };
    },
    async confirm(input) {
      calls.confirm.push(input);
      if (confirmThrows) throw confirmThrows;
      return { id: OPERATION_ID, status: 'confirmed', attestation: ATTESTATION };
    },
    async execute(input) {
      calls.execute.push(input);
      if (executeThrows) throw new Error('execute transport failed');
      return { id: OPERATION_ID, status: 'succeeded' };
    },
    async outcome(input) {
      calls.outcome.push(input);
      if (outcomeThrows) throw new PendingClientError('pending.upstream_timeout_outcome');
      return {
        operationId: OPERATION_ID,
        tool: TOOL,
        status: outcomeStatus,
        expectedContext: { tool: TOOL },
        ...(outcomeStatus === 'succeeded' ? { receipt: successfulReceipt() } : {}),
        ...(outcomeStatus === 'failed' ? { failureCode: 'in_use' } : {}),
      };
    },
  };
}

function headers() {
  return { 'content-type': 'application/json', 'x-device-token': DEVICE_TOKEN, 'x-workspace-id': 'w' };
}

async function turn({
  client = fakeClient(),
  intent = baseIntent(),
  intentionId = INTENTION,
  repeat = false,
  promptOutput = 'Vou registrar a despesa.',
} = {}) {
  const actionIntents = createActionIntentRegistry();
  const store = createConversationStore({ persistDir: approvedTmpRoot('self-confirm-gateway') });
  const gateway = createGatewayServer({
    resolveIdentity: async () => ({ workspace: 'w', actorId: 'actor', deviceId: 'device', role: 'owner' }),
    store,
    actionIntents,
    pendingClient: client,
    promptHost: {
      async chat({ sessionID, intentionId: current }) {
        // The bootstrap turn carries no action; only the target turn does.
        if (current === intentionId) actionIntents.record(sessionID, intent);
        return { turnId: 'turn-1', userMessageId: 'user-1', output: promptOutput };
      },
      async readRawMessages() {
        return [
          { type: 'user', id: 'user-1', text: 'gastei 50', time: { created: 1 } },
          { type: 'assistant', id: 'assistant-1', content: [{ type: 'text', text: promptOutput }], time: { created: 2 } },
        ];
      },
      async readHistory() {
        return [{ id: 'turn-1', content: promptOutput }];
      },
    },
    createRuntimeSession: async () => ({ runtimeSessionId: 'rt' }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
  });
  try {
    const { host, port } = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://${host}:${port}/agents/finance-chat-agent/w/rpc/chat`;
    const boot = await fetch(url, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ text: 'boot', intentionId: 'boot-intention' }),
    });
    const cookie = boot.headers.get('set-cookie')?.split(';')[0];
    const send = () => fetch(url, {
      method: 'POST', headers: { ...headers(), cookie },
      body: JSON.stringify({ text: 'gastei 50', intentionId }),
    });
    let response = await send();
    if (repeat) response = await send();
    const payload = await response.json();
    return { status: response.status, payload, client, actionIntents };
  } finally {
    await gateway.close();
  }
}

test('assurance validation is strict and only the favorable triple is actionable', () => {
  assert.deepEqual(normalizeAssurance(ASSURANCE), { ...ASSURANCE });
  assert.equal(isActionableAssurance(ASSURANCE), true);
  for (const bad of [
    undefined, null, 'x', [], {},
    { complete: true, ambiguousEntity: false },
    { complete: true, ambiguousEntity: false, explicitIntent: 'true' },
    { complete: true, ambiguousEntity: false, explicitIntent: true, extra: 1 },
    { complete: false, ambiguousEntity: false, explicitIntent: true },
    { complete: true, ambiguousEntity: true, explicitIntent: true },
    { complete: true, ambiguousEntity: false, explicitIntent: false },
  ]) {
    assert.equal(isActionableAssurance(bad), false, `bad assurance ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeAssurance({ complete: true, ambiguousEntity: false, explicitIntent: 'true' }), null);
});

test('action tools carry assurance as metadata and never in normalizedArgs', async () => {
  const registry = createActionIntentRegistry();
  const executors = createToolExecutors(async () => { throw new Error('propose must not call transport'); }, { actionIntents: registry });
  const host = { token: 'test-token', household: 'w', actorId: 'actor', deviceId: 'device' };
  const args = {
    amountCents: 5000, description: 'mercado', date: '2026-11-06',
    accountId: ACCOUNT, categoryId: CATEGORY, assurance: { ...ASSURANCE },
  };
  const out = await executors.record_expense(args, host, {
    sessionID: 's-assurance', intentionId: INTENTION,
  });
  assert.equal(out.status, 'recorded');
  const intent = registry.take('s-assurance');
  assert.deepEqual(intent.assurance, { ...ASSURANCE });
  assert.equal('assurance' in intent.normalizedArgs, false);
  assert.deepEqual(Object.keys(intent.normalizedArgs).sort(), ['accountId', 'amountCents', 'categoryId', 'date', 'description']);

  const bad = await executors.record_expense(
    { ...args, assurance: { complete: 'yes', ambiguousEntity: false, explicitIntent: true } },
    host,
    { sessionID: 's-bad', intentionId: INTENTION },
  );
  assert.equal(bad.status, 'recorded', 'malformed assurance must not break the tool flow');
  assert.equal(registry.take('s-bad').assurance, null);

  await executors.record_expense(
    { amountCents: 5000, description: 'mercado', date: '2026-11-06', accountId: ACCOUNT, categoryId: CATEGORY },
    host,
    { sessionID: 's-none', intentionId: INTENTION },
  );
  assert.equal('assurance' in registry.take('s-none'), false, 'absent assurance stays absent');
});

test('favorable assurance executes the whole pipeline and returns a receipt-only execution DTO', async () => {
  const client = fakeClient();
  const result = await turn({ client });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.payload).sort(), ['actionObserved', 'execution', 'intentionId', 'output', 'status', 'turnId']);
  assert.equal(result.payload.intentionId, INTENTION);
  assert.equal('proposal' in result.payload, false);
  assert.deepEqual(result.payload.execution, {
    operationId: OPERATION_ID,
    tool: TOOL,
    status: 'succeeded',
    outcome: { status: 'succeeded' },
    receipt: successfulReceipt(),
  });
  // Full pipeline, once, with the derived Idempotency-Key and never an attestation in the reply.
  assert.equal(client.calls.mint.length, 1);
  assert.equal(client.calls.propose.length, 1);
  assert.equal(client.calls.confirm.length, 1);
  assert.equal(client.calls.execute.length, 1);
  assert.equal(client.calls.outcome.length, 1);
  assert.equal(client.calls.mint[0].requestId, INTENTION);
  assert.equal(
    client.calls.propose[0].idempotencyKey,
    proposeIdempotencyKey({ workspaceId: 'w', intentionId: INTENTION, tool: TOOL }),
  );
  assert.equal(client.calls.execute[0].attestation, ATTESTATION);
  const serialized = JSON.stringify(result.payload);
  assert.doesNotMatch(serialized, new RegExp(ATTESTATION));
  assert.doesNotMatch(serialized, /minted-pending-token|attestation/i);
});

test('unfavorable or malformed assurance never executes and asks in text', async () => {
  for (const assurance of [
    undefined,
    null,
    { complete: false, ambiguousEntity: false, explicitIntent: true },
    { complete: true, ambiguousEntity: true, explicitIntent: true },
    { complete: true, ambiguousEntity: false, explicitIntent: false },
    { complete: 'yes', ambiguousEntity: false, explicitIntent: true },
  ]) {
    const client = fakeClient();
    const intent = baseIntent();
    if (assurance === undefined) delete intent.assurance;
    else intent.assurance = assurance;
    const result = await turn({ client, intent });
    assert.equal(result.status, 200);
    assert.equal('execution' in result.payload, false, `no execution for ${JSON.stringify(assurance)}`);
    assert.equal('proposal' in result.payload, false);
    assert.match(result.payload.output, /esclarecer|concluir com segurança/i);
    assert.equal(client.calls.mint.length, 0);
    assert.equal(client.calls.propose.length, 0);
    assert.equal(client.calls.confirm.length, 0);
    assert.equal(client.calls.execute.length, 0);
  }
});

test('409 approval.not_actionable falls back to text without creating or executing', async () => {
  const client = fakeClient({ proposeThrows: new PendingClientError('pending.upstream_409_propose') });
  const result = await turn({ client });
  assert.equal(result.status, 200);
  assert.equal('execution' in result.payload, false);
  assert.equal('proposal' in result.payload, false);
  assert.match(result.payload.output, /apresentada com segurança|esclarecer/i);
  assert.equal(client.calls.mint.length, 1);
  assert.equal(client.calls.propose.length, 1);
  assert.equal(client.calls.confirm.length, 0, 'no confirm after not_actionable');
  assert.equal(client.calls.execute.length, 0, 'no execute after not_actionable');
  assert.doesNotMatch(JSON.stringify(result.payload), new RegExp(ATTESTATION));
});

test('uncertain / unverified outcomes are never promoted to succeeded', async () => {
  for (const scenario of [
    { name: 'outcome read failed', opts: { outcomeThrows: true } },
    { name: 'explicit unverified', opts: { outcomeStatus: 'unverified' } },
    { name: 'still proposed', opts: { outcomeStatus: 'proposed' } },
  ]) {
    const client = fakeClient(scenario.opts);
    const result = await turn({ client });
    assert.equal(result.status, 200, scenario.name);
    assert.equal(result.payload.execution.status, 'unverified', scenario.name);
    assert.equal('receipt' in result.payload.execution, false, `no receipt when unverified: ${scenario.name}`);
    assert.ok(['unverified', 'proposed'].includes(result.payload.execution.outcome.status), scenario.name);
    assert.equal(client.calls.outcome.length, 1, `outcome still read: ${scenario.name}`);
    assert.doesNotMatch(JSON.stringify(result.payload), new RegExp(ATTESTATION));
  }

  const failed = fakeClient({ outcomeStatus: 'failed' });
  const failedResult = await turn({ client: failed });
  assert.equal(failedResult.payload.execution.status, 'failed');
  assert.equal(failedResult.payload.execution.outcome.failureCode, 'in_use');
  assert.equal('receipt' in failedResult.payload.execution, false);
});

test('execute transport error defers to the authoritative outcome (never a fabricated state)', async () => {
  // Same reconciliation rule as the existing decision route: execute may fail
  // on the wire after money moved, so the canonical outcome read decides.
  const succeeded = await turn({ client: fakeClient({ executeThrows: true }) });
  assert.equal(succeeded.payload.execution.status, 'succeeded');
  assert.ok(succeeded.payload.execution.receipt);
  const noProof = await turn({ client: fakeClient({ executeThrows: true, outcomeThrows: true }) });
  assert.equal(noProof.payload.execution.status, 'unverified');
  assert.equal('receipt' in noProof.payload.execution, false);
});

test('failed outcome never fabricates a receipt even when execute reported success', async () => {
  const client = fakeClient({ outcomeStatus: 'succeeded' });
  const original = client.outcome;
  client.outcome = async (input) => ({ ...(await original(input)), receipt: { status: 'succeeded' } });
  const result = await turn({ client });
  assert.equal(result.payload.execution.status, 'unverified');
  assert.equal('receipt' in result.payload.execution, false);
});

test('same intentionId is executed at most once (turn replay + executor memo)', async () => {
  const client = fakeClient();
  const result = await turn({ client, repeat: true });
  assert.equal(result.status, 200);
  assert.equal(client.calls.execute.length, 1);
  assert.equal(client.calls.confirm.length, 1);
  assert.equal(client.calls.propose.length, 1);

  // Direct defense-in-depth: the executor memoizes by intentionId too.
  const directClient = fakeClient();
  const executor = createActionExecutor({ client: directClient });
  const identityFields = { workspaceId: 'w', actorId: 'actor', deviceId: 'device' };
  const first = await executor.run({ identity: identityFields, intentionId: 'same', intent: baseIntent() });
  const second = await executor.run({ identity: identityFields, intentionId: 'same', intent: baseIntent() });
  assert.deepEqual(first, second);
  assert.equal(directClient.calls.execute.length, 1);
  assert.equal(executor.size(), 1);
});

test('execution is unconditional: the retired TED_AGENT_SELF_CONFIRM env has no effect', async () => {
  const previous = process.env.TED_AGENT_SELF_CONFIRM;
  try {
    for (const value of ['0', '1', undefined]) {
      if (value === undefined) delete process.env.TED_AGENT_SELF_CONFIRM;
      else process.env.TED_AGENT_SELF_CONFIRM = value;
      const client = fakeClient();
      const result = await turn({ client });
      assert.equal(result.status, 200);
      assert.equal(result.payload.execution.status, 'succeeded', `env=${value}`);
      assert.equal(client.calls.execute.length, 1, `env=${value}`);
      assert.equal('proposal' in result.payload, false);
    }
  } finally {
    if (previous === undefined) delete process.env.TED_AGENT_SELF_CONFIRM;
    else process.env.TED_AGENT_SELF_CONFIRM = previous;
  }
});
