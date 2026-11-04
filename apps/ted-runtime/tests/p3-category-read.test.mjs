// P3 prerequisite RED: optional read-only list_categories (category lookup for a
// FUTURE expense proposal — no propose/confirm/execute, no POST/Pending V2 here).
//
// Contract under test:
// - Default product catalog stays EXACTLY the two P2 reads
//   (list_accounts + get_month_summary).
// - Local opt-in `TED_OPENCODE_P3_READS_ENABLED=1` exposes list_categories ONLY
//   when `NODE_ENV !== 'production'`; production forces it off (fail closed).
// - Exact existing API route GET /categories?kind=expense|income, host-derived
//   x-device-token + x-workspace-id, loopback-only origin, never Authorization.
// - Response shape {items: array, total: non-negative safe integer}; errors
//   propagate typed; no empty-data fallback.
// - propose_expense / proposal / POST routes stay refused.
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

const OPT_IN_ENV = Object.freeze({ TED_OPENCODE_P3_READS_ENABLED: '1', NODE_ENV: 'test' });
const PROD_ENV = Object.freeze({ TED_OPENCODE_P3_READS_ENABLED: '1', NODE_ENV: 'production' });
const OFF_ENV = Object.freeze({ NODE_ENV: 'test' });

function stubTransport(cases) {
  return async ({ route, method, host: h }) => {
    assert.ok(h && h.token === host.token, 'host-bound token must travel per call');
    assert.equal(method, 'GET', 'category reads are GET-only');
    const hit = cases[`${method} ${route}`];
    assert.ok(hit, `unexpected route: ${method} ${route}`);
    return hit;
  };
}

describe('p3 category read: product catalog gating', () => {
  it('default product catalog is exactly the two P2 reads (opt-in off)', () => {
    assert.equal(isP3ReadsEnabled(OFF_ENV), false);
    assert.equal(isP3ReadsEnabled({}), false);
    assert.deepEqual([...PRODUCT_TOOL_NAMES].sort(), ['get_month_summary', 'list_accounts']);
    const defs = productToolDefs(OFF_ENV);
    assert.deepEqual(defs.map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('production forces the P3 read off even with the opt-in flag set', () => {
    assert.equal(isP3ReadsEnabled(PROD_ENV), false);
    const defs = productToolDefs(PROD_ENV);
    assert.deepEqual(defs.map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('local opt-in exposes list_categories with complete input AND output schemas', () => {
    assert.equal(isP3ReadsEnabled(OPT_IN_ENV), true);
    const defs = productToolDefs(OPT_IN_ENV);
    assert.deepEqual(defs.map((d) => d.name).sort(), ['get_month_summary', 'list_accounts', 'list_categories']);
    const cat = defs.find((d) => d.name === 'list_categories');
    assert.ok(cat.input && cat.input.type === 'object', 'list_categories needs input schema (native 2.2.4)');
    assert.deepEqual(cat.input.properties.kind.enum, ['expense', 'income']);
    assert.ok(cat.output && cat.output.type === 'object', 'list_categories needs output schema (native 2.2.4)');
    assert.ok(TOOL_DEFS.some((d) => d.name === 'list_categories'), 'TOOL_DEFS knows list_categories');
    assert.ok(TOOL_NAMES.includes('list_categories'), 'TOOL_NAMES includes list_categories');
  });

  it('plugin setup registers exactly 2 tools by default, 3 with the local opt-in', async () => {
    const allowSetup = {
      permission: { assert: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
    };
    const addedDefault = [];
    const defaultDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OFF_ENV });
    await defaultDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedDefault.push(t) }); } } });
    assert.deepEqual(addedDefault.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);

    const addedOptIn = [];
    const optInDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: OPT_IN_ENV });
    await optInDef.setup({ ...allowSetup, tool: { transform: async (fn) => { fn({ add: (t) => addedOptIn.push(t) }); } } });
    assert.deepEqual(addedOptIn.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts', 'list_categories']);

    const addedProd = [];
    const prodDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), { env: PROD_ENV });
    await prodDef.setup({ ...allowSetup, session: { hook: async () => ({ dispose: async () => {} }) }, tool: { transform: async (fn) => { fn({ add: (t) => addedProd.push(t) }); } } });
    assert.deepEqual(addedProd.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);
  });
});

describe('p3 category read: tool args, route and shape', () => {
  it('validates kind structurally; identity keys stay forbidden (host-bound)', () => {
    assert.deepEqual(validateToolArgs('list_categories', {}), {});
    assert.deepEqual(validateToolArgs('list_categories', { kind: 'expense' }), { kind: 'expense' });
    assert.throws(() => validateToolArgs('list_categories', { kind: 42 }), /kind must be a string/);
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(() => validateToolArgs('list_categories', { [key]: 'x' }), /forbidden key/, `${key} must stay host-bound`);
    }
    assert.throws(() => validateToolArgs('list_categories', { bogus: 'x' }), /unknown arg/);
  });

  it('executes the exact GET route and returns the real body untouched (no fabrication)', async () => {
    const body = { items: [{ id: 'c1', kind: 'expense' }], total: 1 };
    const seen = [];
    const transport = async (args) => {
      seen.push(args);
      return stubTransport({ 'GET /categories?kind=expense': { statusCode: 200, body } })(args);
    };
    const executors = createToolExecutors(transport);
    const out = await executors.list_categories({ kind: 'expense' }, host, { intentionId: 'int-cat-1' });
    assert.deepEqual(out, body);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].route, '/categories?kind=expense');
    assert.equal(seen[0].method, 'GET');
  });

  it('refuses 2xx with invalid shape and propagates upstream errors (never empty data)', async () => {
    const bad = createToolExecutors(stubTransport({ 'GET /categories': { statusCode: 200, body: { items: [], total: -1 } } }));
    const shapeErr = await bad.list_categories({}, host, { intentionId: 'int-cat-bad' }).catch((e) => e);
    assert.ok(shapeErr instanceof ToolError);
    assert.equal(shapeErr.code, 'tool.invalid_shape');

    const forbidden = createToolExecutors(stubTransport({ 'GET /categories': { statusCode: 403, body: { error: 'nope' } } }));
    const err = await forbidden.list_categories({}, host, { intentionId: 'int-cat-403' }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.forbidden');
  });
});

describe('p3 category read: transport allowlist and proposal refusal', () => {
  it('allowlists exact GET /categories (query passes through), refuses the rest', () => {
    assert.equal(isRouteAllowlisted('/categories'), true);
    assert.equal(isRouteAllowlisted('/categories?kind=expense'), true);
    assert.equal(isRouteAllowlisted('/categories?kind=income'), true);
    assert.equal(isRouteAllowlisted('/categories/123'), false);
    assert.equal(isRouteAllowlisted('/pending-operations/v2/propose'), false);
  });

  it('sends host-derived x-device-token + x-workspace-id, never Authorization, loopback only', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, json: async () => ({ items: [], total: 0 }) };
    };
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    await t.call({ route: '/categories?kind=expense', method: 'GET', host });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.endsWith('/categories?kind=expense'), 'exact route, no diversion');
    assert.equal(seen[0].init.headers['x-device-token'], 'secret-token-a');
    assert.equal(seen[0].init.headers['x-workspace-id'], 'H_A');
    assert.ok(!('authorization' in seen[0].init.headers), 'never Authorization');
  });

  it('refuses POST/proposal routes before any I/O (no write path)', async () => {
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl: async () => { throw new Error('must not be called'); } });
    await assert.rejects(() => t.call({ route: '/categories', method: 'POST', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/pending-operations/v2/propose', method: 'POST', host }), /not allowlisted/);
  });

  it('keeps proposal/confirm/execute unavailable (no P3 write surface)', async () => {
    assert.throws(() => validateToolArgs('propose_expense', {}), /unknown tool/);
    const executors = createToolExecutors(stubTransport({}));
    assert.ok(!('propose_expense' in executors), 'no propose executor');
    assert.ok(!('confirm_expense' in executors || 'execute_expense' in executors), 'no confirm/execute executors');
    await assert.rejects(() => executors.list_categories({}, null, { intentionId: 'int-x' }), /host-bound context is required/);
    await assert.rejects(() => executors.list_categories({}, host, {}), /stable intentionId is required/);
  });
});
