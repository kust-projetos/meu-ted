// P3.2 income slice RED: propose_income as a PROPOSAL INTENT only.
//
// Contract under test:
// - The SAME local writes opt-in (`TED_OPENCODE_P3_WRITES_ENABLED=1`,
//   NODE_ENV !== 'production') that exposes propose_expense also exposes
//   propose_income + list_categories. Production forces all of them off.
// - propose_income NEVER performs HTTP and NEVER writes: it validates args,
//   derives the stable intention and records ONE proposal intent for the
//   gateway to hand to the authenticated PWA. Identity stays host-bound.
// - The recorded intent carries `transactions.income.create` — the exact tool
//   the API already accepts — and a Receita summary. The expense path is
//   unchanged (regression covered by p3-propose-expense.test.mjs).
// - There is no confirm/execute surface for the LLM.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  validateToolArgs,
  createToolExecutors,
} from '../src/tool-defs.mjs';
import {
  productToolDefs,
  defineTedFinancePlugin,
  isP3WritesEnabled,
} from '../src/plugin.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';

const OFF_ENV = Object.freeze({ NODE_ENV: 'test' });
const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'test' });
const PROD_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'production' });

const validArgs = (overrides = {}) => ({
  amountCents: 250000,
  description: 'salário',
  date: '2026-11-07',
  accountId: ACCOUNT,
  categoryId: CATEGORY,
  ...overrides,
});

describe('p3 propose_income: catalog gating', () => {
  it('default product catalog excludes propose_income', () => {
    assert.equal(isP3WritesEnabled(OFF_ENV), false);
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('production forces the writes opt-in off', () => {
    assert.equal(isP3WritesEnabled(PROD_ENV), false);
    assert.deepEqual(productToolDefs(PROD_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('local writes opt-in adds ALL proposal tools and list_categories with both schemas', () => {
    assert.equal(isP3WritesEnabled(WRITE_ENV), true);
    const names = productToolDefs(WRITE_ENV).map((d) => d.name).sort();
    assert.deepEqual(names, [
      'get_month_summary',
      'list_accounts',
      'list_card_statements',
      'list_categories',
      'list_credit_cards',
      'propose_card_purchase',
      'propose_expense',
      'propose_income',
      'propose_statement_payment',
      'propose_transfer',
    ]);
    const propose = productToolDefs(WRITE_ENV).find((d) => d.name === 'propose_income');
    assert.equal(propose.input.type, 'object');
    assert.ok(propose.output && propose.output.type === 'object');
    assert.deepEqual([...propose.input.required].sort(), ['accountId', 'amountCents', 'categoryId', 'description']);
    assert.ok(TOOL_DEFS.some((d) => d.name === 'propose_income'));
    assert.ok(TOOL_NAMES.includes('propose_income'));
  });
});

describe('p3 propose_income: argument validation', () => {
  it('accepts the exact income contract (same shape accepted by the API) and rejects invalid values', () => {
    assert.deepEqual(validateToolArgs('propose_income', validArgs()), validArgs());
    assert.deepEqual(validateToolArgs('propose_income', validArgs({ date: undefined })).date, undefined);

    assert.throws(() => validateToolArgs('propose_income', {}), /amountCents/);
    for (const amount of [0, -1, 12.5, '250000', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => validateToolArgs('propose_income', validArgs({ amountCents: amount })),
        /amountCents must be a positive safe integer/,
        `amount ${amount}`,
      );
    }
    assert.throws(() => validateToolArgs('propose_income', validArgs({ description: '' })), /description/);
    assert.throws(() => validateToolArgs('propose_income', validArgs({ description: 'x'.repeat(241) })), /description/);
    assert.throws(() => validateToolArgs('propose_income', validArgs({ accountId: 'nope' })), /accountId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_income', validArgs({ categoryId: 'nope' })), /categoryId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_income', validArgs({ date: '07/11/2026' })), /date must be YYYY-MM-DD/);
  });

  it('keeps identity and idempotency host-bound (never tool args)', () => {
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(
        () => validateToolArgs('propose_income', { ...validArgs(), [key]: 'x' }),
        /forbidden key/,
        `${key} must stay host-bound`,
      );
    }
    assert.throws(() => validateToolArgs('propose_income', { ...validArgs(), bogus: 1 }), /unknown arg/);
  });
});

describe('p3 propose_income: intent only, never HTTP/write', () => {
  it('records one host-bound income intent and returns a proposal status (no transport call)', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(
      async () => { transportCalls += 1; throw new Error('propose must never call the finance transport'); },
      { proposalIntents: registry },
    );
    const out = await executors.propose_income(validArgs(), host, {
      sessionID: 'session-income-1',
      intentionId: 'int-income-abc',
    });
    assert.equal(transportCalls, 0, 'no HTTP from propose_income');
    assert.equal(out.status, 'proposed');
    assert.match(out.summary, /Receita de R\$\s?2\.500,00 em "salário"/);

    const intent = registry.take('session-income-1');
    assert.deepEqual(intent, {
      tool: 'transactions.income.create',
      intentionId: 'int-income-abc',
      summary: out.summary,
      normalizedArgs: {
        amountCents: 250000,
        description: 'salário',
        date: '2026-11-07',
        accountId: ACCOUNT,
        categoryId: CATEGORY,
      },
    });
    assert.equal(registry.take('session-income-1'), null, 'take is destructive: one handoff per turn');
  });

  it('defaults the date to the current UTC day when omitted', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => { throw new Error('no'); }, { proposalIntents: registry });
    await executors.propose_income(validArgs({ date: undefined }), host, {
      sessionID: 'session-income-date',
      intentionId: 'int-income-date',
    });
    const intent = registry.take('session-income-date');
    assert.match(intent.normalizedArgs.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('requires host context and a stable intention; rejects hostless/identity args', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), { proposalIntents: registry });
    await assert.rejects(
      () => executors.propose_income(validArgs(), null, { sessionID: 's', intentionId: 'int-x' }),
      /host-bound context is required/,
    );
    await assert.rejects(
      () => executors.propose_income(validArgs(), host, { sessionID: 's' }),
      /stable intentionId is required/,
    );
    await assert.rejects(
      () => executors.propose_income({ ...validArgs(), token: 'x' }, host, { sessionID: 's', intentionId: 'int-x' }),
      /forbidden key/,
    );
    assert.equal(registry.take('s'), null, 'refused calls must not record an intent');
  });

  it('exposes no confirm/execute surface to the LLM', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {
      proposalIntents: createProposalIntentRegistry(),
    });
    for (const name of ['confirm_income', 'execute_income', 'confirm', 'execute', 'approve_income']) {
      assert.equal(name in executors, false, `${name} must not exist`);
      assert.throws(() => validateToolArgs(name, {}), /unknown tool/);
    }
    assert.ok(TOOL_DEFS.every((d) => d.name !== 'confirm_income' && d.name !== 'execute_income'));
  });
});

describe('p3 propose_income: plugin registration', () => {
  const allowSetup = {
    permission: { assert: async () => {} },
    session: { hook: async () => ({ dispose: async () => {} }) },
  };

  it('registers propose_income only with the local writes opt-in', async () => {
    const addedDefault = [];
    const defaultDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OFF_ENV });
    await defaultDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedDefault.push(t) }); } } });
    assert.deepEqual(addedDefault.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);

    const addedWrites = [];
    const writesDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: WRITE_ENV });
    await writesDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedWrites.push(t) }); } } });
    assert.deepEqual(
      addedWrites.map((t) => t.name).sort(),
      ['get_month_summary', 'list_accounts', 'list_card_statements', 'list_categories', 'list_credit_cards', 'propose_card_purchase', 'propose_expense', 'propose_income', 'propose_statement_payment', 'propose_transfer'],
    );
  });

  it('propose_income is permission-gated before any intent is recorded', async () => {
    const registry = createProposalIntentRegistry();
    const added = [];
    const def = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), {
      env: WRITE_ENV,
      proposalIntents: registry,
    });
    await def.setup({
      permission: { assert: async ({ action, resources }) => {
        assert.equal(action, 'ted.finance.read');
        if (resources.includes('propose_income')) throw new Error('denied');
      } },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    const propose = added.find((t) => t.name === 'propose_income');
    const err = await propose
      .execute(validArgs(), { sessionID: 's-income-denied', messageID: 'm-1', id: 'call-1', agent: 'ted' })
      .catch((e) => e);
    assert.equal(err.code, 'tool.forbidden');
    assert.equal(registry.take('s-income-denied'), null, 'a denied call records nothing');
  });
});
