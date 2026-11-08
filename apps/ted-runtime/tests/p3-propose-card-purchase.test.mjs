// P3.4 card-purchase slice RED: propose_card_purchase as a PROPOSAL INTENT only.
//
// Contract under test:
// - The SAME local writes opt-in (`TED_OPENCODE_P3_WRITES_ENABLED=1`,
//   NODE_ENV !== 'production') that exposes propose_expense/propose_income
//   also exposes propose_card_purchase. Production forces all of them off.
// - propose_card_purchase NEVER performs HTTP and NEVER writes: it validates
//   args, derives the stable intention and records ONE proposal intent for the
//   gateway to hand to the authenticated PWA. Identity stays host-bound.
// - The recorded intent carries `cards.purchase.create` — the exact tool the
//   API already accepts — and a "Compra no cartão" summary.
// - The category is OPTIONAL (a card purchase may be unclassified); the card
//   (accountId) is required.
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

const CARD = '11111111-1111-4111-8111-111111111114';
const CATEGORY = '22222222-2222-4222-8222-222222222221';

const OFF_ENV = Object.freeze({ NODE_ENV: 'test' });
const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'test' });
const PROD_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'production' });

const validArgs = (overrides = {}) => ({
  amountCents: 15000,
  description: 'supermercado',
  date: '2026-11-07',
  accountId: CARD,
  categoryId: CATEGORY,
  ...overrides,
});

describe('p3 propose_card_purchase: catalog gating', () => {
  it('default product catalog excludes propose_card_purchase', () => {
    assert.equal(isP3WritesEnabled(OFF_ENV), false);
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('production forces the writes opt-in off', () => {
    assert.equal(isP3WritesEnabled(PROD_ENV), false);
    assert.deepEqual(productToolDefs(PROD_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('local writes opt-in adds the card proposal tool with both schemas', () => {
    assert.equal(isP3WritesEnabled(WRITE_ENV), true);
    const propose = productToolDefs(WRITE_ENV).find((d) => d.name === 'propose_card_purchase');
    assert.ok(propose, 'propose_card_purchase must be registered');
    assert.equal(propose.input.type, 'object');
    assert.ok(propose.output && propose.output.type === 'object');
    assert.deepEqual([...propose.input.required].sort(), ['accountId', 'amountCents', 'description']);
    assert.ok(TOOL_DEFS.some((d) => d.name === 'propose_card_purchase'));
    assert.ok(TOOL_NAMES.includes('propose_card_purchase'));
  });
});

describe('p3 propose_card_purchase: argument validation', () => {
  it('accepts the card contract (category optional) and rejects invalid values', () => {
    assert.deepEqual(validateToolArgs('propose_card_purchase', validArgs()), validArgs());
    assert.deepEqual(validateToolArgs('propose_card_purchase', validArgs({ date: undefined })).date, undefined);
    // Category is optional for a card purchase.
    assert.deepEqual(
      validateToolArgs('propose_card_purchase', validArgs({ categoryId: undefined })),
      validArgs({ categoryId: undefined }),
    );

    assert.throws(() => validateToolArgs('propose_card_purchase', {}), /amountCents/);
    for (const amount of [0, -1, 12.5, '15000', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => validateToolArgs('propose_card_purchase', validArgs({ amountCents: amount })),
        /amountCents must be a positive safe integer/,
        `amount ${amount}`,
      );
    }
    assert.throws(() => validateToolArgs('propose_card_purchase', validArgs({ description: '' })), /description/);
    assert.throws(() => validateToolArgs('propose_card_purchase', validArgs({ description: 'x'.repeat(241) })), /description/);
    assert.throws(() => validateToolArgs('propose_card_purchase', validArgs({ accountId: 'nope' })), /accountId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_card_purchase', validArgs({ categoryId: 'nope' })), /categoryId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_card_purchase', validArgs({ date: '07/11/2026' })), /date must be YYYY-MM-DD/);
  });

  it('keeps identity and idempotency host-bound (never tool args)', () => {
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(
        () => validateToolArgs('propose_card_purchase', { ...validArgs(), [key]: 'x' }),
        /forbidden key/,
        `${key} must stay host-bound`,
      );
    }
    assert.throws(() => validateToolArgs('propose_card_purchase', { ...validArgs(), bogus: 1 }), /unknown arg/);
  });
});

describe('p3 propose_card_purchase: intent only, never HTTP/write', () => {
  it('records one host-bound card intent and returns a proposal status (no transport call)', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(
      async () => { transportCalls += 1; throw new Error('propose must never call the finance transport'); },
      { proposalIntents: registry },
    );
    const out = await executors.propose_card_purchase(validArgs(), host, {
      sessionID: 'session-card-1',
      intentionId: 'int-card-abc',
    });
    assert.equal(transportCalls, 0, 'no HTTP from propose_card_purchase');
    assert.equal(out.status, 'proposed');
    assert.match(out.summary, /Compra no cartão de R\$\s?150,00 em "supermercado"/);

    const intent = registry.take('session-card-1');
    assert.deepEqual(intent, {
      tool: 'cards.purchase.create',
      intentionId: 'int-card-abc',
      summary: out.summary,
      normalizedArgs: {
        amountCents: 15000,
        description: 'supermercado',
        date: '2026-11-07',
        accountId: CARD,
        categoryId: CATEGORY,
      },
    });
    assert.equal(registry.take('session-card-1'), null, 'take is destructive: one handoff per turn');
  });

  it('records a card intent without a category (optional)', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => { throw new Error('no'); }, { proposalIntents: registry });
    await executors.propose_card_purchase(validArgs({ categoryId: undefined }), host, {
      sessionID: 'session-card-no-category',
      intentionId: 'int-card-no-category',
    });
    const intent = registry.take('session-card-no-category');
    assert.equal(intent.tool, 'cards.purchase.create');
    assert.equal(intent.normalizedArgs.categoryId, undefined);
  });

  it('defaults the date to the current UTC day when omitted', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => { throw new Error('no'); }, { proposalIntents: registry });
    await executors.propose_card_purchase(validArgs({ date: undefined }), host, {
      sessionID: 'session-card-date',
      intentionId: 'int-card-date',
    });
    const intent = registry.take('session-card-date');
    assert.match(intent.normalizedArgs.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('requires host context and a stable intention; rejects hostless/identity args', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), { proposalIntents: registry });
    await assert.rejects(
      () => executors.propose_card_purchase(validArgs(), null, { sessionID: 's', intentionId: 'int-x' }),
      /host-bound context is required/,
    );
    await assert.rejects(
      () => executors.propose_card_purchase(validArgs(), host, { sessionID: 's' }),
      /stable intentionId is required/,
    );
    await assert.rejects(
      () => executors.propose_card_purchase({ ...validArgs(), token: 'x' }, host, { sessionID: 's', intentionId: 'int-x' }),
      /forbidden key/,
    );
    assert.equal(registry.take('s'), null, 'refused calls must not record an intent');
  });

  it('exposes no confirm/execute surface to the LLM', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {
      proposalIntents: createProposalIntentRegistry(),
    });
    for (const name of ['confirm_card_purchase', 'execute_card_purchase', 'confirm', 'execute', 'approve_card_purchase']) {
      assert.equal(name in executors, false, `${name} must not exist`);
      assert.throws(() => validateToolArgs(name, {}), /unknown tool/);
    }
  });
});

describe('p3.5 propose_card_purchase: installmentsTotal', () => {
  it('accepts 1..48 and records the declared split in normalizedArgs', async () => {
    assert.equal(validateToolArgs('propose_card_purchase', validArgs({ installmentsTotal: 1 })).installmentsTotal, 1);
    assert.equal(validateToolArgs('propose_card_purchase', validArgs({ installmentsTotal: 48 })).installmentsTotal, 48);

    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => { throw new Error('no'); }, { proposalIntents: registry });
    await executors.propose_card_purchase(validArgs({ installmentsTotal: 6 }), host, {
      sessionID: 'session-card-installments',
      intentionId: 'int-card-installments',
    });
    const intent = registry.take('session-card-installments');
    assert.equal(intent.tool, 'cards.purchase.create');
    assert.equal(intent.normalizedArgs.installmentsTotal, 6);
    assert.equal(intent.normalizedArgs.amountCents, 15000, 'amountCents stays the TOTAL');
  });

  it('omits installmentsTotal from a 1x intent (P3.4 payload stays byte-identical)', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => { throw new Error('no'); }, { proposalIntents: registry });
    await executors.propose_card_purchase(validArgs(), host, {
      sessionID: 'session-card-no-installments',
      intentionId: 'int-card-no-installments',
    });
    const intent = registry.take('session-card-no-installments');
    assert.equal('installmentsTotal' in intent.normalizedArgs, false);
  });

  it('rejects a declared split outside 1..48 or non-integer (never silently 1x)', () => {
    for (const installmentsTotal of [0, -1, 49, 1.5, '6', null]) {
      assert.throws(
        () => validateToolArgs('propose_card_purchase', validArgs({ installmentsTotal })),
        /installmentsTotal must be an integer between 1 and 48/,
        `installmentsTotal ${String(installmentsTotal)}`,
      );
    }
  });

  it('rejects a total that cannot cover at least 1 cent per parcel', () => {
    assert.throws(
      () => validateToolArgs('propose_card_purchase', validArgs({ amountCents: 2, installmentsTotal: 3 })),
      /amountCents must cover at least 1 cent per installment/,
    );
  });
});

describe('p3 propose_card_purchase: plugin registration', () => {
  const allowSetup = {
    permission: { assert: async () => {} },
    session: { hook: async () => ({ dispose: async () => {} }) },
  };

  it('registers propose_card_purchase only with the local writes opt-in', async () => {
    const addedDefault = [];
    const defaultDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OFF_ENV });
    await defaultDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedDefault.push(t) }); } } });
    assert.deepEqual(addedDefault.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);

    const addedWrites = [];
    const writesDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: WRITE_ENV });
    await writesDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedWrites.push(t) }); } } });
    assert.deepEqual(
      addedWrites.map((t) => t.name).sort(),
      ['get_month_summary', 'list_accounts', 'list_card_statements', 'list_categories', 'propose_card_purchase', 'propose_expense', 'propose_income', 'propose_statement_payment', 'propose_transfer'],
    );
  });

  it('propose_card_purchase is permission-gated before any intent is recorded', async () => {
    const registry = createProposalIntentRegistry();
    const added = [];
    const def = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), {
      env: WRITE_ENV,
      proposalIntents: registry,
    });
    await def.setup({
      permission: { assert: async ({ action, resources }) => {
        assert.equal(action, 'ted.finance.read');
        if (resources.includes('propose_card_purchase')) throw new Error('denied');
      } },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    const propose = added.find((t) => t.name === 'propose_card_purchase');
    const err = await propose
      .execute(validArgs(), { sessionID: 's-card-denied', messageID: 'm-1', id: 'call-1', agent: 'ted' })
      .catch((e) => e);
    assert.equal(err.code, 'tool.forbidden');
    assert.equal(registry.take('s-card-denied'), null, 'a denied call records nothing');
  });
});
