// P3.8 card discovery: list_credit_cards (GET /cards/accounts, CardStore).
//
// Contract:
// - GET /accounts remains the generic account list (deliberately excludes
//   credit cards) and list_accounts keeps that route unchanged.
// - list_credit_cards is exposed under the existing P3 reads opt-in and calls
//   GET /cards/accounts, returning {items,total} with credit-card accounts.
// - POST /cards/accounts stays blocked by the transport allowlist.
// - propose_card_purchase guides the model to resolve accountId via
//   list_credit_cards.
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
  isP3ReadsEnabled,
  TED_FINANCE_PERMISSION_RESOURCES,
} from '../src/plugin.mjs';
import { HttpFinanceTransport, isRouteAllowlisted } from '../src/transport.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});

const OFF_ENV = Object.freeze({ NODE_ENV: 'test' });
const READ_ENV = Object.freeze({ TED_OPENCODE_P3_READS_ENABLED: '1', NODE_ENV: 'test' });
const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'test' });
const PROD_ENV = Object.freeze({ TED_OPENCODE_P3_READS_ENABLED: '1', NODE_ENV: 'production' });

// P2D fixture shape (credit card returned by GET /cards/accounts).
const NUBANK_CARD = Object.freeze({
  id: '11111111-1111-4111-8111-111111111114',
  name: 'Nubank Card',
  kind: 'credit_card',
  householdId: 'H_A',
});

describe('p3.8 card discovery: catalog and guidance', () => {
  it('is absent from the default catalog and present under the explicit P3 reads opt-in (any environment)', () => {
    assert.ok(!productToolDefs(OFF_ENV).some((d) => d.name === 'list_credit_cards'));
    assert.ok(!productToolDefs({ NODE_ENV: 'production' }).some((d) => d.name === 'list_credit_cards'));
    assert.ok(productToolDefs(PROD_ENV).some((d) => d.name === 'list_credit_cards'));
    const readDef = productToolDefs(READ_ENV).find((d) => d.name === 'list_credit_cards');
    assert.ok(readDef, 'list_credit_cards must be registered under P3 reads opt-in');
    assert.deepEqual(readDef.input.properties, {});
    assert.ok(readDef.output && readDef.output.type === 'object');
    assert.ok(TOOL_NAMES.includes('list_credit_cards'));
    assert.ok(TOOL_DEFS.some((d) => d.name === 'list_credit_cards'));
  });

  it('registers via plugin only under P3 opt-in and carries the finance permission resource', async () => {
    assert.ok(TED_FINANCE_PERMISSION_RESOURCES.includes('list_credit_cards'));
    const allowSetup = {
      permission: { assert: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
    };
    const addedDefault = [];
    const defaultDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OFF_ENV });
    await defaultDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedDefault.push(t) }); } } });
    assert.ok(!addedDefault.some((t) => t.name === 'list_credit_cards'));

    const addedReads = [];
    const readsDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: READ_ENV });
    await readsDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedReads.push(t) }); } } });
    assert.ok(addedReads.some((t) => t.name === 'list_credit_cards'));

    const addedWrites = [];
    const writesDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: WRITE_ENV });
    await writesDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedWrites.push(t) }); } } });
    assert.ok(addedWrites.some((t) => t.name === 'list_credit_cards'));
  });

  it('guides propose_card_purchase accountId resolution via list_credit_cards', () => {
    const propose = TOOL_DEFS.find((d) => d.name === 'propose_card_purchase');
    assert.ok(propose.input.properties.accountId.description.includes('list_credit_cards'));
    assert.ok(!propose.input.properties.accountId.description.includes('list_accounts'));
  });
});

describe('p3.8 card discovery: validation and routing', () => {
  it('accepts empty args and rejects unknown/identity args', () => {
    assert.deepEqual(validateToolArgs('list_credit_cards', {}), {});
    assert.throws(() => validateToolArgs('list_credit_cards', { kind: 'credit_card' }), /unknown arg/);
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(() => validateToolArgs('list_credit_cards', { [key]: 'x' }), /forbidden key/, `${key} must stay host-bound`);
    }
  });

  it('routes to GET /cards/accounts and preserves GET /accounts for list_accounts (P2D separation)', async () => {
    const calls = [];
    const executors = createToolExecutors(async (args) => {
      calls.push(args);
      if (args.route === '/cards/accounts') return { statusCode: 200, body: { items: [NUBANK_CARD], total: 1 } };
      if (args.route === '/accounts') return { statusCode: 200, body: { items: [{ id: 'bank-1', name: 'Itaú', kind: 'bank' }], total: 1 } };
      return { statusCode: 404, body: { error: 'not found' } };
    });

    const cards = await executors.list_credit_cards({}, host, { intentionId: 'int-cards' });
    assert.deepEqual(cards, { items: [NUBANK_CARD], total: 1 });
    assert.equal(cards.items[0].id, NUBANK_CARD.id);
    assert.equal(cards.items[0].name, 'Nubank Card');

    const accounts = await executors.list_accounts({}, host, { intentionId: 'int-accounts' });
    assert.equal(accounts.items[0].kind, 'bank');

    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].route, '/cards/accounts');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].route, '/accounts');
  });

  it('fails closed on malformed shape (never fabricates)', async () => {
    const bad = createToolExecutors(async () => ({ statusCode: 200, body: { items: 'nope', total: 0 } }));
    await assert.rejects(
      () => bad.list_credit_cards({}, host, { intentionId: 'int-bad-shape' }),
      /items must be an array/,
    );
  });

  it('requires host context and a stable intention', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: { items: [], total: 0 } }));
    await assert.rejects(() => executors.list_credit_cards({}, null, { intentionId: 'int-x' }), /host-bound context is required/);
    await assert.rejects(() => executors.list_credit_cards({}, host, {}), /stable intentionId is required/);
  });
});

describe('p3.8 card discovery: transport allowlist', () => {
  it('allowlists GET /cards/accounts and blocks POST /cards/accounts and sub-paths', async () => {
    assert.equal(isRouteAllowlisted('/cards/accounts'), true);
    assert.equal(isRouteAllowlisted('/cards/accounts?kind=credit_card'), true);
    assert.equal(isRouteAllowlisted('/cards/accounts/123'), false);
    const t = new HttpFinanceTransport({
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    await assert.rejects(() => t.call({ route: '/cards/accounts', method: 'POST', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/cards/accounts', method: 'PATCH', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/cards/accounts', method: 'DELETE', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/cards/accounts/123', method: 'GET', host }), /not allowlisted/);
  });

  it('sends host-derived headers and never Authorization', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, json: async () => ({ items: [NUBANK_CARD], total: 1 }) };
    };
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    const out = await t.call({ route: '/cards/accounts', method: 'GET', host });
    assert.equal(out.body.items[0].id, NUBANK_CARD.id);
    assert.equal(seen[0].init.headers['x-device-token'], 'secret-token-a');
    assert.equal(seen[0].init.headers['x-workspace-id'], 'H_A');
    assert.ok(!('authorization' in seen[0].init.headers), 'never Authorization');
  });
});
