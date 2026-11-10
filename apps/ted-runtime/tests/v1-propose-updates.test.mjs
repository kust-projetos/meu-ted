// V1 CRUD completion — intent-only proposal tools for the five approved
// Pending V2 operations: transactions.update (description only),
// accounts.update, accounts.deactivate, categories.update, categories.deactivate.
//
// Contract under test:
// - Opt-in writes only; intent-only (no transport, no HTTP, no write).
// - Normalized args are EXACTLY the API approval contract (strict): the
//   runtime never adds amount/date/account/category to transactions.update.
// - CAS preconditions (expectedName/expectedDescription) travel literal.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  validateToolArgs,
  createToolExecutors,
  ToolError,
} from '../src/tool-defs.mjs';
import { productToolDefs, P3_WRITE_TOOL_NAMES } from '../src/plugin.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});

const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1' });
const TX = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const CAT = '33333333-3333-4333-8333-333333333333';

const NEW_PROPOSALS = [
  'propose_transaction_update',
  'propose_account_update',
  'propose_account_deactivate',
  'propose_category_update',
  'propose_category_deactivate',
];

describe('v1 proposal tools: catalog and structural validation', () => {
  it('exposes the five proposals only under the writes opt-in', () => {
    const names = productToolDefs(WRITE_ENV).map((d) => d.name);
    for (const name of NEW_PROPOSALS) {
      assert.ok(names.includes(name), `${name} must be registered`);
      assert.ok(P3_WRITE_TOOL_NAMES.includes(name));
      const def = TOOL_DEFS.find((d) => d.name === name);
      assert.ok(def.input && def.output, `${name} needs complete schemas`);
    }
    assert.ok(!productToolDefs({}).some((d) => NEW_PROPOSALS.includes(d.name)));
  });

  it('transaction update accepts only the description tuple (no amount/date/account/category)', () => {
    const valid = { transactionId: TX, description: 'Mercado novo', expectedDescription: 'Mercado' };
    assert.deepEqual(validateToolArgs('propose_transaction_update', valid), valid);
    for (const extra of ['amountCents', 'date', 'accountId', 'categoryId', 'kind']) {
      assert.throws(
        () => validateToolArgs('propose_transaction_update', { ...valid, [extra]: 'x' }),
        /unknown arg/,
        `${extra} must be rejected`,
      );
    }
    assert.throws(() => validateToolArgs('propose_transaction_update', { ...valid, transactionId: 'x' }), /transactionId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_transaction_update', { ...valid, description: '   ' }), /description must be/);
    assert.throws(() => validateToolArgs('propose_transaction_update', { ...valid, expectedDescription: '   ' }), /expectedDescription must be/);
  });

  it('rename tools require the exact CAS name', () => {
    for (const [tool, idKey, id] of [
      ['propose_account_update', 'accountId', ACC],
      ['propose_category_update', 'categoryId', CAT],
    ]) {
      const valid = { [idKey]: id, name: 'Novo', expectedName: 'Atual' };
      assert.deepEqual(validateToolArgs(tool, valid), valid);
      assert.throws(() => validateToolArgs(tool, { [idKey]: id, name: 'Novo' }), /expectedName must be/);
      assert.throws(() => validateToolArgs(tool, { [idKey]: 'x', name: 'Novo', expectedName: 'Atual' }), new RegExp(`${idKey} must be a uuid`));
    }
  });

  it('deactivate tools validate the target (accounts also accept a display snapshot)', () => {
    assert.deepEqual(validateToolArgs('propose_account_deactivate', { accountId: ACC }), { accountId: ACC });
    assert.deepEqual(validateToolArgs('propose_account_deactivate', { accountId: ACC, accountName: 'Antiga' }), { accountId: ACC, accountName: 'Antiga' });
    assert.throws(() => validateToolArgs('propose_account_deactivate', { accountId: ACC, expectedName: 'x' }), /unknown arg/);
    assert.throws(() => validateToolArgs('propose_category_deactivate', { categoryId: CAT }), /expectedName must be/);
    assert.deepEqual(validateToolArgs('propose_category_deactivate', { categoryId: CAT, expectedName: 'Mercado' }), { categoryId: CAT, expectedName: 'Mercado' });
  });
});

describe('v1 proposal tools: intent only', () => {
  it('records exact normalized args and never calls the transport', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(async () => { transportCalls += 1; throw new Error('transport must not run'); }, { proposalIntents: registry });
    const opts = { intentionId: 'int-v1', sessionID: 'ses-v1' };

    const cases = [
      ['propose_transaction_update', { transactionId: TX, description: ' Mercado novo ', expectedDescription: 'Mercado antigo' },
        { transactionId: TX, description: 'Mercado novo', expectedDescription: 'Mercado antigo' }, 'transactions.update'],
      ['propose_account_update', { accountId: ACC, name: ' Reserva ', expectedName: 'Aurora' },
        { accountId: ACC, name: 'Reserva', expectedName: 'Aurora' }, 'accounts.update'],
      ['propose_account_deactivate', { accountId: ACC, accountName: ' Antiga ' },
        { accountId: ACC, accountName: 'Antiga' }, 'accounts.deactivate'],
      ['propose_category_update', { categoryId: CAT, name: ' Supermercado ', expectedName: 'Mercado' },
        { categoryId: CAT, name: 'Supermercado', expectedName: 'Mercado' }, 'categories.update'],
      ['propose_category_deactivate', { categoryId: CAT, expectedName: 'Mercado' },
        { categoryId: CAT, expectedName: 'Mercado' }, 'categories.deactivate'],
    ];

    for (const [tool, args, expectedArgs, expectedTool] of cases) {
      const out = await executors[tool](args, host, opts);
      assert.equal(out.status, 'proposed');
      assert.equal(typeof out.summary, 'string');
      assert.ok(out.summary.length > 0);
      const intent = registry.take('ses-v1');
      assert.equal(intent.tool, expectedTool);
      assert.deepEqual(intent.normalizedArgs, expectedArgs);
      assert.equal(intent.intentionId, 'int-v1');
    }
    assert.equal(transportCalls, 0, 'proposal tools never reach the finance transport');
  });

  it('fails closed without the registry or a host-bound session', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), { proposalIntents: registry });
    await assert.rejects(
      () => executors.propose_category_update({ categoryId: CAT, name: 'Novo', expectedName: 'Atual' }, host, { intentionId: 'int-x' }),
      (err) => err instanceof ToolError && err.code === 'host_context_required',
    );
    const noRegistry = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {});
    await assert.rejects(
      () => noRegistry.propose_category_update({ categoryId: CAT, name: 'Novo', expectedName: 'Atual' }, host, { intentionId: 'int-x', sessionID: 'ses-x' }),
      (err) => err instanceof ToolError && err.code === 'tool.unavailable',
    );
  });
});
