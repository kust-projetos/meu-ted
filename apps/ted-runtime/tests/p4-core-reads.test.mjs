// P4 CORE parity reads: list_recent_transactions + spending_insights.
//
// Contract under test:
// - Default product catalog stays EXACTLY the two P2 reads
//   (list_accounts + get_month_summary); the P4 reads join the opt-in read set
//   (the same explicit flag that already enables the P3 reads in production).
// - Exact existing API routes: GET /transactions (transactionFiltersSchema) and
//   GET /insights/spending (spendingInsightQuerySchema). Host-derived
//   x-device-token + x-workspace-id, loopback-only origin, never Authorization.
// - Response shapes are validated against the real API contract; a 2xx with a
//   divergent shape fails closed (never fabricated, never zero-filled).
// - No POST, no propose/confirm/execute routes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  validateToolArgs,
  createToolExecutors,
  ToolError,
} from '../src/tool-defs.mjs';
import { HttpFinanceTransport, isRouteAllowlisted } from '../src/transport.mjs';
import {
  PRODUCT_TOOL_NAMES,
  productToolDefs,
  defineTedFinancePlugin,
  isP3ReadsEnabled,
} from '../src/plugin.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});

const READ_ENV = Object.freeze({ TED_OPENCODE_P3_READS_ENABLED: '1' });
const OFF_ENV = Object.freeze({});

const OPT_IN_READS = [
  'get_month_summary',
  'list_accounts',
  'list_card_statements',
  'list_categories',
  'list_credit_cards',
  'list_recent_transactions',
  'spending_insights',
];

function stubTransport(cases) {
  return async ({ route, method, host: h }) => {
    assert.ok(h && h.token === host.token, 'host-bound token must travel per call');
    assert.equal(method, 'GET', 'P4 reads are GET-only');
    const hit = cases[`${method} ${route}`];
    assert.ok(hit, `unexpected route: ${method} ${route}`);
    return hit;
  };
}

describe('p4 core reads: catalog gating', () => {
  it('default product catalog is exactly the two P2 reads', () => {
    assert.equal(isP3ReadsEnabled(OFF_ENV), false);
    assert.deepEqual([...PRODUCT_TOOL_NAMES].sort(), ['get_month_summary', 'list_accounts']);
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('explicit opt-in exposes the P4 reads with complete input AND output schemas', () => {
    assert.equal(isP3ReadsEnabled(READ_ENV), true);
    const defs = productToolDefs(READ_ENV);
    assert.deepEqual(defs.map((d) => d.name).sort(), OPT_IN_READS);
    for (const name of ['list_recent_transactions', 'spending_insights']) {
      const def = defs.find((d) => d.name === name);
      assert.ok(def.input && def.input.type === 'object', `${name} needs input schema (native 2.2.4)`);
      assert.ok(def.output && def.output.type === 'object', `${name} needs output schema (native 2.2.4)`);
      assert.ok(TOOL_DEFS.some((d) => d.name === name), `TOOL_DEFS knows ${name}`);
      assert.ok(TOOL_NAMES.includes(name), `TOOL_NAMES includes ${name}`);
    }
  });

  it('plugin setup registers exactly 2 tools by default and the opt-in reads with the flag', async () => {
    const allowSetup = {
      permission: { assert: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
    };
    const addedDefault = [];
    const defaultDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OFF_ENV });
    await defaultDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedDefault.push(t) }); } } });
    assert.deepEqual(addedDefault.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);

    const addedOptIn = [];
    const optInDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: READ_ENV });
    await optInDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedOptIn.push(t) }); } } });
    assert.deepEqual(addedOptIn.map((t) => t.name).sort(), OPT_IN_READS);
  });
});

describe('p4 core reads: args, route and shape', () => {
  it('list_recent_transactions validates filters structurally; identity keys stay forbidden', () => {
    assert.deepEqual(validateToolArgs('list_recent_transactions', {}), {});
    const valid = {
      accountId: '11111111-1111-4111-8111-111111111111',
      categoryId: '22222222-2222-4222-8222-222222222222',
      kind: 'expense',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      minAmountCents: 0,
      maxAmountCents: 5000,
      query: 'mercado',
      limit: 20,
      offset: 0,
    };
    assert.deepEqual(validateToolArgs('list_recent_transactions', valid), valid);
    assert.throws(() => validateToolArgs('list_recent_transactions', { accountId: 'nope' }), /accountId must be a uuid/);
    assert.throws(() => validateToolArgs('list_recent_transactions', { kind: 'other' }), /kind must be expense\|income\|transfer/);
    assert.throws(() => validateToolArgs('list_recent_transactions', { startDate: '2026-13-01' }), /startDate must be YYYY-MM-DD/);
    assert.throws(() => validateToolArgs('list_recent_transactions', { limit: 0 }), /limit must be an integer between 1 and 200/);
    assert.throws(() => validateToolArgs('list_recent_transactions', { offset: -1 }), /offset must be an integer between 0 and 100000/);
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(() => validateToolArgs('list_recent_transactions', { [key]: 'x' }), /forbidden key/, `${key} must stay host-bound`);
    }
    assert.throws(() => validateToolArgs('list_recent_transactions', { bogus: 'x' }), /unknown arg/);
  });

  it('spending_insights validates the query structurally', () => {
    assert.deepEqual(validateToolArgs('spending_insights', {}), {});
    const valid = { yearMonth: '2026-11', insightType: 'all', lookbackMonths: 3 };
    assert.deepEqual(validateToolArgs('spending_insights', valid), valid);
    assert.throws(() => validateToolArgs('spending_insights', { yearMonth: '2026-11-01' }), /yearMonth must be YYYY-MM/);
    assert.throws(() => validateToolArgs('spending_insights', { insightType: 'bogus' }), /insightType must be all\|comparison\|anomalies\|income-share/);
    assert.throws(() => validateToolArgs('spending_insights', { lookbackMonths: 0 }), /lookbackMonths must be an integer between 1 and 12/);
    assert.throws(() => validateToolArgs('spending_insights', { bogus: 'x' }), /unknown arg/);
  });

  it('executes the exact GET routes and returns the real bodies untouched (no fabrication)', async () => {
    const txBody = {
      items: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          householdId: 'H_A',
          kind: 'expense',
          description: 'Mercado',
          amountCents: 6500,
          date: '2026-11-10',
          accountId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const insightsBody = { success: true, yearMonth: '2026-11', insights: [], transactionCount: 1 };
    const executors = createToolExecutors(stubTransport({
      'GET /transactions?accountId=11111111-1111-4111-8111-111111111111&kind=expense&limit=20': { statusCode: 200, body: txBody },
      'GET /insights/spending?yearMonth=2026-11&insightType=all': { statusCode: 200, body: insightsBody },
    }));
    const txOut = await executors.list_recent_transactions(
      { accountId: '11111111-1111-4111-8111-111111111111', kind: 'expense', limit: 20 },
      host,
      { intentionId: 'int-p4-tx' },
    );
    assert.deepEqual(txOut, txBody);
    const insightsOut = await executors.spending_insights(
      { yearMonth: '2026-11', insightType: 'all' },
      host,
      { intentionId: 'int-p4-insights' },
    );
    assert.deepEqual(insightsOut, insightsBody);
  });

  it('fails closed on a 2xx with a divergent shape (never grounds on invalid data)', async () => {
    const executors = createToolExecutors(stubTransport({
      'GET /transactions': { statusCode: 200, body: { items: [{ id: 'x' }], total: 1, limit: 50, offset: 0 } },
      'GET /insights/spending': { statusCode: 200, body: { success: true, yearMonth: '2026-11', insights: [], transactionCount: -1 } },
    }));
    await assert.rejects(
      () => executors.list_recent_transactions({}, host, { intentionId: 'int-p4-shape-tx' }),
      (err) => err instanceof ToolError && err.code === 'tool.invalid_shape',
    );
    await assert.rejects(
      () => executors.spending_insights({}, host, { intentionId: 'int-p4-shape-insights' }),
      (err) => err instanceof ToolError && err.code === 'tool.invalid_shape',
    );
  });

  it('propagates typed upstream errors without fabricating data', async () => {
    const executors = createToolExecutors(stubTransport({
      'GET /transactions': { statusCode: 403, body: { code: 'auth.workspace_forbidden' } },
    }));
    await assert.rejects(
      () => executors.list_recent_transactions({}, host, { intentionId: 'int-p4-err' }),
      (err) => err instanceof ToolError && err.code === 'tool.forbidden',
    );
  });
});

describe('p4 core reads: transport allowlist', () => {
  it('allowlists the exact GET routes only', () => {
    assert.equal(isRouteAllowlisted('/transactions'), true);
    assert.equal(isRouteAllowlisted('/transactions?kind=expense&limit=20'), true);
    assert.equal(isRouteAllowlisted('/insights/spending'), true);
    assert.equal(isRouteAllowlisted('/insights/spending?yearMonth=2026-11'), true);
    assert.equal(isRouteAllowlisted('/transactions/extra'), false);
    assert.equal(isRouteAllowlisted('/insights/quick'), false);
    assert.equal(isRouteAllowlisted('/pending-operations/v2/propose'), false);
  });

  it('refuses non-GET methods on the new routes', async () => {
    const transport = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
    await assert.rejects(
      () => transport.call({ route: '/transactions', method: 'POST', host }),
      /method not allowlisted/,
    );
    await assert.rejects(
      () => transport.call({ route: '/insights/spending', method: 'POST', host }),
      /method not allowlisted/,
    );
  });
});
