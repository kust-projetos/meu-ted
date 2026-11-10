// P4.2 write parity: propose_account_create + propose_category_create.
//
// Contract under test:
// - The proposal tools join the writes opt-in set (the same explicit flag that
//   already enables the P3 proposals in production); the default catalog is
//   unchanged.
// - Intent-only: the executor records ONE proposal intent and NEVER calls the
//   finance transport (no HTTP, no write, no confirm/execute surface).
// - Args are validated structurally; identity/idempotency keys stay host-bound.
// - The normalizedArgs match the API's Pending V2 registry exactly
//   (createAccountInputSchema / createCategoryArgsSchema).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  validateToolArgs,
  createToolExecutors,
} from '../src/tool-defs.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';
import { productToolDefs, isP3WritesEnabled } from '../src/plugin.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});

const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1' });
const OFF_ENV = Object.freeze({});

const WRITE_TOOLS = [
  'get_month_summary',
  'list_accounts',
  'list_card_statements',
  'list_categories',
  'list_credit_cards',
  'list_recent_transactions',
  'propose_account_create',
  'propose_card_purchase',
  'propose_category_create',
  'propose_expense',
  'propose_income',
  'propose_statement_payment',
  'propose_transfer',
  'spending_insights',
];

function accountArgs(over = {}) {
  return { name: 'Nubank', kind: 'bank', initialBalanceCents: 0, ...over };
}

function categoryArgs(over = {}) {
  return { name: 'Alimentação', kind: 'expense', ...over };
}

describe('p4.2 write parity: catalog gating', () => {
  it('default catalog stays exactly the two P2 reads', () => {
    assert.equal(isP3WritesEnabled(OFF_ENV), false);
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('writes opt-in exposes the new proposal tools with complete schemas', () => {
    assert.equal(isP3WritesEnabled(WRITE_ENV), true);
    const defs = productToolDefs(WRITE_ENV);
    assert.deepEqual(defs.map((d) => d.name).sort(), WRITE_TOOLS);
    for (const name of ['propose_account_create', 'propose_category_create']) {
      const def = defs.find((d) => d.name === name);
      assert.ok(def.input && def.input.type === 'object', `${name} needs input schema (native 2.2.4)`);
      assert.ok(def.output && def.output.type === 'object', `${name} needs output schema (native 2.2.4)`);
      assert.ok(TOOL_DEFS.some((d) => d.name === name), `TOOL_DEFS knows ${name}`);
      assert.ok(TOOL_NAMES.includes(name), `TOOL_NAMES includes ${name}`);
    }
  });
});

describe('p4.2 write parity: argument validation', () => {
  it('propose_account_create accepts the exact account contract and rejects invalid values', () => {
    assert.deepEqual(validateToolArgs('propose_account_create', accountArgs()), accountArgs());
    assert.deepEqual(validateToolArgs('propose_account_create', accountArgs({ initialBalanceCents: -5000 })).initialBalanceCents, -5000);
    assert.throws(() => validateToolArgs('propose_account_create', {}), /name/);
    assert.throws(() => validateToolArgs('propose_account_create', accountArgs({ name: '' })), /name/);
    assert.throws(() => validateToolArgs('propose_account_create', accountArgs({ name: 'x'.repeat(121) })), /name/);
    assert.throws(() => validateToolArgs('propose_account_create', accountArgs({ kind: 'credit_card' })), /kind must be bank\|cash/);
    assert.throws(() => validateToolArgs('propose_account_create', accountArgs({ initialBalanceCents: 1.5 })), /initialBalanceCents/);
    assert.throws(() => validateToolArgs('propose_account_create', accountArgs({ initialBalanceCents: 1_000_000_000_001 })), /initialBalanceCents/);
  });

  it('propose_category_create accepts the exact category contract and rejects invalid values', () => {
    assert.deepEqual(validateToolArgs('propose_category_create', categoryArgs()), categoryArgs());
    const withParent = categoryArgs({ parentId: '44444444-4444-4444-8444-444444444444' });
    assert.deepEqual(validateToolArgs('propose_category_create', withParent), withParent);
    assert.throws(() => validateToolArgs('propose_category_create', {}), /name/);
    assert.throws(() => validateToolArgs('propose_category_create', categoryArgs({ kind: 'transfer' })), /kind must be expense\|income/);
    assert.throws(() => validateToolArgs('propose_category_create', categoryArgs({ parentId: 'nope' })), /parentId must be a uuid/);
  });

  it('keeps identity and idempotency host-bound (never tool args)', () => {
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(() => validateToolArgs('propose_account_create', { ...accountArgs(), [key]: 'x' }), /forbidden key/, `${key} must stay host-bound`);
      assert.throws(() => validateToolArgs('propose_category_create', { ...categoryArgs(), [key]: 'x' }), /forbidden key/, `${key} must stay host-bound`);
    }
    assert.throws(() => validateToolArgs('propose_account_create', { ...accountArgs(), bogus: 1 }), /unknown arg/);
    assert.throws(() => validateToolArgs('propose_category_create', { ...categoryArgs(), bogus: 1 }), /unknown arg/);
  });
});

describe('p4.2 write parity: intent only, never HTTP/write', () => {
  it('propose_account_create records one host-bound intent (no transport call)', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(
      async () => { transportCalls += 1; throw new Error('propose must never call the finance transport'); },
      { proposalIntents: registry },
    );
    const out = await executors.propose_account_create(accountArgs({ initialBalanceCents: 100000 }), host, {
      sessionID: 'session-account',
      intentionId: 'int-account',
    });
    assert.equal(transportCalls, 0, 'no HTTP from propose_account_create');
    assert.equal(out.status, 'proposed');
    assert.match(out.summary, /Nubank/);
    const intent = registry.take('session-account');
    assert.deepEqual(intent, {
      tool: 'accounts.create',
      intentionId: 'int-account',
      summary: out.summary,
      normalizedArgs: { name: 'Nubank', kind: 'bank', initialBalanceCents: 100000 },
    });
    assert.equal(registry.take('session-account'), null, 'take is destructive: one handoff per turn');
  });

  it('propose_category_create records one host-bound intent (no transport call)', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(
      async () => { transportCalls += 1; throw new Error('propose must never call the finance transport'); },
      { proposalIntents: registry },
    );
    const out = await executors.propose_category_create(categoryArgs(), host, {
      sessionID: 'session-category',
      intentionId: 'int-category',
    });
    assert.equal(transportCalls, 0, 'no HTTP from propose_category_create');
    assert.equal(out.status, 'proposed');
    assert.match(out.summary, /Alimentação/);
    const intent = registry.take('session-category');
    assert.deepEqual(intent, {
      tool: 'categories.create',
      intentionId: 'int-category',
      summary: out.summary,
      normalizedArgs: { name: 'Alimentação', kind: 'expense' },
    });
  });

  it('requires host context and a stable intention; refused calls record nothing', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), { proposalIntents: registry });
    await assert.rejects(
      () => executors.propose_account_create(accountArgs(), null, { sessionID: 's', intentionId: 'int-x' }),
      /host-bound context is required/,
    );
    await assert.rejects(
      () => executors.propose_account_create(accountArgs(), host, { sessionID: 's' }),
      /stable intentionId is required/,
    );
    await assert.rejects(
      () => executors.propose_category_create(categoryArgs(), host, { sessionID: 's' }),
      /stable intentionId is required/,
    );
    assert.equal(registry.take('s'), null, 'refused calls must not record an intent');
  });

  it('exposes no confirm/execute surface to the LLM', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {
      proposalIntents: createProposalIntentRegistry(),
    });
    for (const name of ['confirm_account', 'execute_account', 'confirm', 'execute', 'approve_category']) {
      assert.equal(name in executors, false, `${name} must not exist`);
      assert.throws(() => validateToolArgs(name, {}), /unknown tool/);
    }
  });
});
