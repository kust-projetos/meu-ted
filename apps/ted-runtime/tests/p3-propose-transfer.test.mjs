// P3.3 transfer slice RED: propose_transfer as a PROPOSAL INTENT only.
//
// Contract under test:
// - The SAME local writes opt-in (`TED_OPENCODE_P3_WRITES_ENABLED=1`,
//   NODE_ENV !== 'production') that exposes the expense/income proposals also
//   exposes propose_transfer. Production forces all of them off.
// - propose_transfer NEVER performs HTTP and NEVER writes: it validates args,
//   derives the stable intention and records ONE proposal intent for the
//   gateway to hand to the authenticated PWA. Identity stays host-bound.
// - The recorded intent carries `transactions.transfer.create` and from/to
//   account ids — NO category (an internal transfer is neither income nor
//   expense).
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

const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '11111111-1111-4111-8111-111111111112';

const OFF_ENV = Object.freeze({ NODE_ENV: 'test' });
const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'test' });
const PROD_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'production' });

const validArgs = (overrides = {}) => ({
  amountCents: 30000,
  description: 'Transferência Itaú → Nubank',
  date: '2026-11-07',
  fromAccountId: FROM,
  toAccountId: TO,
  ...overrides,
});

describe('p3 propose_transfer: catalog gating', () => {
  it('default product catalog excludes propose_transfer', () => {
    assert.equal(isP3WritesEnabled(OFF_ENV), false);
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('production forces the writes opt-in off', () => {
    assert.equal(isP3WritesEnabled(PROD_ENV), false);
    assert.deepEqual(productToolDefs(PROD_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('local writes opt-in adds propose_transfer with complete schemas', () => {
    const names = productToolDefs(WRITE_ENV).map((d) => d.name).sort();
    assert.ok(names.includes('propose_transfer'));
    const propose = productToolDefs(WRITE_ENV).find((d) => d.name === 'propose_transfer');
    assert.equal(propose.input.type, 'object');
    assert.ok(propose.output && propose.output.type === 'object');
    assert.deepEqual(
      [...propose.input.required].sort(),
      ['amountCents', 'description', 'fromAccountId', 'toAccountId'],
    );
    assert.equal('categoryId' in propose.input.properties, false);
    assert.ok(TOOL_DEFS.some((d) => d.name === 'propose_transfer'));
    assert.ok(TOOL_NAMES.includes('propose_transfer'));
  });
});

describe('p3 propose_transfer: argument validation', () => {
  it('accepts the exact transfer contract (same shape accepted by the API) and rejects invalid values', () => {
    assert.deepEqual(validateToolArgs('propose_transfer', validArgs()), validArgs());
    assert.equal(validateToolArgs('propose_transfer', validArgs({ date: undefined })).date, undefined);

    assert.throws(() => validateToolArgs('propose_transfer', {}), /amountCents/);
    for (const amount of [0, -1, 12.5, '30000', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => validateToolArgs('propose_transfer', validArgs({ amountCents: amount })),
        /amountCents must be a positive safe integer/,
        `amount ${amount}`,
      );
    }
    assert.throws(() => validateToolArgs('propose_transfer', validArgs({ description: '' })), /description/);
    assert.throws(() => validateToolArgs('propose_transfer', validArgs({ description: 'x'.repeat(241) })), /description/);
    assert.throws(() => validateToolArgs('propose_transfer', validArgs({ fromAccountId: 'nope' })), /fromAccountId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_transfer', validArgs({ toAccountId: 'nope' })), /toAccountId must be a uuid/);
    assert.throws(
      () => validateToolArgs('propose_transfer', validArgs({ toAccountId: FROM })),
      /must differ/,
    );
    assert.throws(() => validateToolArgs('propose_transfer', validArgs({ date: '07/11/2026' })), /date must be YYYY-MM-DD/);
  });

  it('rejects a category argument (transfers are not income/expense)', () => {
    assert.throws(
      () => validateToolArgs('propose_transfer', { ...validArgs(), categoryId: TO }),
      /unknown arg/,
    );
  });

  it('keeps identity and idempotency host-bound (never tool args)', () => {
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(
        () => validateToolArgs('propose_transfer', { ...validArgs(), [key]: 'x' }),
        /forbidden key/,
        `${key} must stay host-bound`,
      );
    }
    assert.throws(() => validateToolArgs('propose_transfer', { ...validArgs(), bogus: 1 }), /unknown arg/);
  });
});

describe('p3 propose_transfer: intent only, never HTTP/write', () => {
  it('records one host-bound transfer intent and returns a proposal status (no transport call)', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(
      async () => { transportCalls += 1; throw new Error('propose must never call the finance transport'); },
      { proposalIntents: registry },
    );
    const out = await executors.propose_transfer(validArgs(), host, {
      sessionID: 'session-transfer-1',
      intentionId: 'int-transfer-abc',
    });
    assert.equal(transportCalls, 0, 'no HTTP from propose_transfer');
    assert.equal(out.status, 'proposed');
    assert.match(out.summary, /Transferência de R\$\s?300,00 em "Transferência Itaú → Nubank"/);

    const intent = registry.take('session-transfer-1');
    assert.deepEqual(intent, {
      tool: 'transactions.transfer.create',
      intentionId: 'int-transfer-abc',
      summary: out.summary,
      normalizedArgs: {
        amountCents: 30000,
        description: 'Transferência Itaú → Nubank',
        date: '2026-11-07',
        fromAccountId: FROM,
        toAccountId: TO,
      },
    });
    assert.equal('categoryId' in intent.normalizedArgs, false);
    assert.equal(registry.take('session-transfer-1'), null, 'take is destructive: one handoff per turn');
  });

  it('defaults the date to the current UTC day when omitted', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => { throw new Error('no'); }, { proposalIntents: registry });
    await executors.propose_transfer(validArgs({ date: undefined }), host, {
      sessionID: 'session-transfer-date',
      intentionId: 'int-transfer-date',
    });
    const intent = registry.take('session-transfer-date');
    assert.match(intent.normalizedArgs.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('requires host context and a stable intention; rejects hostless/identity args', async () => {
    const registry = createProposalIntentRegistry();
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), { proposalIntents: registry });
    await assert.rejects(
      () => executors.propose_transfer(validArgs(), null, { sessionID: 's', intentionId: 'int-x' }),
      /host-bound context is required/,
    );
    await assert.rejects(
      () => executors.propose_transfer(validArgs(), host, { sessionID: 's' }),
      /stable intentionId is required/,
    );
    await assert.rejects(
      () => executors.propose_transfer({ ...validArgs(), token: 'x' }, host, { sessionID: 's', intentionId: 'int-x' }),
      /forbidden key/,
    );
    assert.equal(registry.take('s'), null, 'refused calls must not record an intent');
  });

  it('exposes no confirm/execute surface to the LLM', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {
      proposalIntents: createProposalIntentRegistry(),
    });
    for (const name of ['confirm_transfer', 'execute_transfer', 'confirm', 'execute', 'approve_transfer']) {
      assert.equal(name in executors, false, `${name} must not exist`);
      assert.throws(() => validateToolArgs(name, {}), /unknown tool/);
    }
    assert.ok(TOOL_DEFS.every((d) => d.name !== 'confirm_transfer' && d.name !== 'execute_transfer'));
  });
});

describe('p3 propose_transfer: plugin registration', () => {
  const allowSetup = {
    permission: { assert: async () => {} },
    session: { hook: async () => ({ dispose: async () => {} }) },
  };

  it('registers propose_transfer only with the local writes opt-in', async () => {
    const addedDefault = [];
    const defaultDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OFF_ENV });
    await defaultDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedDefault.push(t) }); } } });
    assert.equal(addedDefault.some((t) => t.name === 'propose_transfer'), false);

    const addedWrites = [];
    const writesDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: WRITE_ENV });
    await writesDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedWrites.push(t) }); } } });
    assert.ok(addedWrites.some((t) => t.name === 'propose_transfer'));
  });

  it('propose_transfer is permission-gated before any intent is recorded', async () => {
    const registry = createProposalIntentRegistry();
    const added = [];
    const def = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), {
      env: WRITE_ENV,
      proposalIntents: registry,
    });
    await def.setup({
      permission: { assert: async ({ action, resources }) => {
        assert.equal(action, 'ted.finance.read');
        if (resources.includes('propose_transfer')) throw new Error('denied');
      } },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    const propose = added.find((t) => t.name === 'propose_transfer');
    const err = await propose
      .execute(validArgs(), { sessionID: 's-transfer-denied', messageID: 'm-1', id: 'call-1', agent: 'ted' })
      .catch((e) => e);
    assert.equal(err.code, 'tool.forbidden');
    assert.equal(registry.take('s-transfer-denied'), null, 'a denied call records nothing');
  });
});
