import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAutoExecIdempotencyKey, isAutoEligibleCategoryIntent, tryAutoCreateCategory } from '../src/category-autoexec.mjs';

const intent = { tool: 'categories.create', normalizedArgs: { name: 'Food', kind: 'expense' } };
const identity = { workspace: 'w', actorId: 'a', deviceId: 'd' };
const receipt = (id) => ({ id, status: 'succeeded', execution: { status: 'succeeded', operationId: 'cat-id', receipt: { mutationKind: 'categories.create', status: 'succeeded', mutationId: 'mutation', operationId: id, entity: { type: 'category', id: 'cat-id' } } } });

test('A0-compatible key and exact category eligibility', () => {
  // SHA-256("w:i:categories.create"), matching deriveIdempotencyKey's input.
  assert.equal(deriveAutoExecIdempotencyKey('w', 'i'), 'e9cf96a5b2208b84d8ac4523c0efdf0105da45c80880e4448455edb2867e38c7');
  assert.equal(isAutoEligibleCategoryIntent(intent), true);
  for (const bad of [
    { ...intent, normalizedArgs: { ...intent.normalizedArgs, parentId: 'p' } },
    { ...intent, normalizedArgs: { name: 'Food', kind: 'bad' } },
    { ...intent, normalizedArgs: { name: '\u0000', kind: 'expense' } },
    { ...intent, tool: 'propose_expense' },
  ]) assert.equal(isAutoEligibleCategoryIntent(bad), false);
});

test('executes exact V2 flow with real receipt shape; other tools make no calls', async () => {
  const calls = [];
  const client = {
    async mint() { calls.push('mint'); return { token: 'x' }; },
    async propose(x) { calls.push(['propose', x.idempotencyKey]); return { operationId: 'pending' }; },
    async authorize() { calls.push('authorize'); return { status: 'confirmed', attestation: 'a'.repeat(32) }; },
    async execute() { calls.push('execute'); return receipt('pending'); },
  };
  assert.deepEqual(await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent }), { status: 'executed' });
  assert.deepEqual(calls.map((x) => Array.isArray(x) ? x[0] : x), ['mint', 'propose', 'authorize', 'execute']);
  calls.length = 0;
  assert.equal((await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent: { ...intent, tool: 'propose_expense' } })).status, 'left_pending');
  assert.equal(calls.length, 0);
});

test('any authorization failure or malformed receipt stays pending without retry', async () => {
  for (const authorize of [
    async () => { throw Object.assign(new Error('secret'), { code: 'conflict' }); },
    async () => ({ status: 'pending', attestation: 'a'.repeat(32) }),
  ]) {
    let minted = 0;
    const client = { async mint() { minted++; return { token: 'x' }; }, async propose() { return { operationId: 'p' }; }, authorize, async execute() { return receipt('p'); } };
    assert.equal((await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent })).status, 'left_pending');
    assert.equal(minted, 1);
  }
  const fields = [
    (r) => { r.id = 'wrong'; }, (r) => { r.status = 'failed'; },
    (r) => { r.execution.status = 'failed'; }, (r) => { r.execution.operationId = ''; },
    (r) => { r.execution.receipt.mutationKind = 'other'; }, (r) => { r.execution.receipt.status = 'failed'; },
    (r) => { r.execution.receipt.mutationId = ''; }, (r) => { r.execution.receipt.operationId = 'wrong'; },
    (r) => { r.execution.receipt.entity.type = 'other'; }, (r) => { r.execution.receipt.entity.id = 'wrong'; },
    (r) => { delete r.execution; r.receipt = {}; },
  ];
  for (const mutate of fields) {
    let attempts = 0;
    const client = { async mint() { return { token: 'x' }; }, async propose() { return { operationId: 'p' }; }, async authorize() { return { status: 'confirmed', attestation: 'a'.repeat(32) }; }, async execute() { attempts++; const r = receipt('p'); mutate(r); return r; } };
    assert.deepEqual(await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent }), { status: 'left_pending', reason: 'uncertain' });
    assert.equal(attempts, 1);
  }
});

test('existing proposals are left pending without authorization or execution', async () => {
  const calls = [];
  const client = {
    async mint() { calls.push('mint'); return { token: 'x' }; },
    async propose() { calls.push('propose'); return { operationId: 'p', existing: true }; },
    async authorize() { calls.push('authorize'); },
    async execute() { calls.push('execute'); },
  };
  assert.deepEqual(await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent }), {
    status: 'left_pending', reason: 'existing_proposal',
  });
  assert.deepEqual(calls, ['mint', 'propose']);
});

test('execute timeout after authorization is uncertain and is not retried', async () => {
  let executeCalls = 0;
  const client = {
    async mint() { return { token: 'x' }; },
    async propose() { return { operationId: 'p' }; },
    async authorize() { return { status: 'confirmed', attestation: 'a'.repeat(32) }; },
    async execute() { executeCalls++; throw Object.assign(new Error('timeout'), { code: 'uncertain' }); },
  };
  assert.deepEqual(await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent }), {
    status: 'left_pending', reason: 'uncertain',
  });
  assert.equal(executeCalls, 1);
});

test('autoexec budget aborts the in-flight call and returns uncertain', async () => {
  let observedSignal;
  const client = {
    async mint({ signal }) {
      observedSignal = signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ token: 'x' }), { once: true }));
    },
  };
  assert.deepEqual(await tryAutoCreateCategory({ client, identity, intentionId: 'i', intent, budgetMs: 5 }), {
    status: 'left_pending', reason: 'uncertain',
  });
  assert.equal(observedSignal.aborted, true);
});
