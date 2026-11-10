// V1 completion — financial reads (analytics, budgets, goals, payables, audit).
//
// Contract under test:
// - The reads join the explicit P3/P4 opt-in read set; the default catalog
//   stays exactly the two P2 reads.
// - Exact existing API routes only (GET): analytics/*, budgets, budgets/check,
//   budgets/:id/trends (UUID path), goals, payables, payables/reminders,
//   audit-logs. No POST and no invented endpoint.
// - Host-bound identity (x-device-token + x-workspace-id), loopback origin.
// - 2xx with a divergent shape fails closed; upstream errors keep their code.
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
  P3_READ_TOOL_NAMES,
  productToolDefs,
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

const NEW_READS = [
  'analytics_kpis',
  'analytics_category_breakdown',
  'analytics_cashflow_series',
  'analytics_budget_consumption',
  'analytics_net_worth_history',
  'list_budgets',
  'check_budgets',
  'budget_trends',
  'list_goals',
  'list_payables',
  'payable_reminders',
  'list_audit_logs',
];

const BUDGET = '11111111-1111-4111-8111-111111111111';

function stubTransport(cases) {
  return async ({ route, method, host: h }) => {
    assert.ok(h && h.token === host.token, 'host-bound token must travel per call');
    assert.equal(method, 'GET', 'financial reads are GET-only');
    const hit = cases[`${method} ${route}`];
    assert.ok(hit, `unexpected route: ${method} ${route}`);
    return hit;
  };
}

const kpisBody = {
  period: { from: '2026-10-12', to: '2026-11-10' },
  previousPeriod: { from: '2026-09-12', to: '2026-10-11' },
  netLiquidBalanceCents: 100000,
  accountsTotalCents: 120000,
  dueSoonCents: 20000,
  openInvoices: { committedCents: 0, limitCents: 0, utilizationPct: null },
  savingsRatePct: 12.5,
  savingsRateTargetPct: 20,
  previousSavingsRatePct: null,
  fixedVsDiscretionary: { scope: 'household', fixedCents: 0, discretionaryCents: 0, fixedPctOfIncome: null, subscriptionsCents: 0 },
  incomeCents: 200000,
  expenseCents: 100000,
  previousIncomeCents: 0,
  previousExpenseCents: 0,
  netWorthCents: 120000,
  transactionCount: 3,
};

const breakdownBody = {
  period: { from: '2026-11-01', to: '2026-11-30' },
  kind: 'expense',
  totalCents: 5000,
  slices: [{ categoryId: '22222222-2222-4222-8222-222222222222', name: 'Mercado', totalCents: 5000, pct: 100, color: null }],
  transactionCount: 1,
};

const cashflowBody = {
  period: { from: '2026-11-01', to: '2026-11-30' },
  current: [{ date: '2026-11-01', valueCents: 1000 }],
  previous: [{ date: '2026-10-01', valueCents: 2000 }],
  transactionCount: 2,
};

const netWorthBody = {
  months: [{ month: '2026-11', netWorthCents: 120000 }],
  transactionCount: 1,
};

const itemsBody = { items: [{ id: 'x' }], total: 1 };

describe('v1 financial reads: catalog and args', () => {
  it('default catalog stays the two P2 reads; opt-in adds every new read', () => {
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), [...PRODUCT_TOOL_NAMES].sort());
    const names = productToolDefs(READ_ENV).map((d) => d.name);
    for (const name of NEW_READS) {
      assert.ok(names.includes(name), `${name} must be exposed by the reads opt-in`);
      const def = TOOL_DEFS.find((d) => d.name === name);
      assert.ok(def, `${name} must exist in TOOL_DEFS`);
      assert.ok(def.input && def.input.type === 'object', `${name} needs an input schema`);
      assert.ok(def.output && def.output.type === 'object', `${name} needs an output schema`);
      assert.ok(TOOL_NAMES.includes(name));
    }
  });

  it('validates analytics filters structurally and rejects identity keys', () => {
    const valid = { period: 'custom', from: '2026-01-01', to: '2026-01-31', accountId: BUDGET, basis: 'competencia' };
    assert.deepEqual(validateToolArgs('analytics_kpis', valid), valid);
    assert.deepEqual(validateToolArgs('analytics_budget_consumption', {}), {});
    assert.throws(() => validateToolArgs('analytics_kpis', { period: 'today' }), /period must be/);
    assert.throws(() => validateToolArgs('analytics_kpis', { from: '2026-13-01' }), /from must be YYYY-MM-DD/);
    assert.throws(() => validateToolArgs('analytics_kpis', { accountId: 'nope' }), /accountId must be a uuid/);
    assert.throws(() => validateToolArgs('analytics_kpis', { basis: 'caixa' }), /basis must be/);
    assert.throws(() => validateToolArgs('analytics_category_breakdown', { kind: 'transfer' }), /kind must be expense\|income/);
    assert.throws(() => validateToolArgs('analytics_kpis', { token: 'x' }), /forbidden key/);
    assert.throws(() => validateToolArgs('analytics_kpis', { bogus: 'x' }), /unknown arg/);
    assert.throws(() => validateToolArgs('analytics_budget_consumption', { period: 'lastMonth' }), /unknown arg/);
  });

  it('validates budget, payable and audit filters', () => {
    const trend = { budgetId: BUDGET, monthsBack: 6 };
    assert.deepEqual(validateToolArgs('budget_trends', trend), trend);
    assert.throws(() => validateToolArgs('budget_trends', {}), /budgetId must be a uuid/);
    assert.throws(() => validateToolArgs('budget_trends', { budgetId: BUDGET, monthsBack: 0 }), /monthsBack/);

    const payable = { status: 'pending', type: 'one_time', dueWithinDays: 7 };
    assert.deepEqual(validateToolArgs('list_payables', payable), payable);
    assert.throws(() => validateToolArgs('list_payables', { status: 'open' }), /status must be/);
    assert.throws(() => validateToolArgs('list_payables', { dueWithinDays: 400 }), /dueWithinDays/);

    const audit = { limit: 10, actorType: 'user', entityId: BUDGET };
    assert.deepEqual(validateToolArgs('list_audit_logs', audit), audit);
    assert.throws(() => validateToolArgs('list_audit_logs', { limit: 0 }), /limit must be/);
    assert.throws(() => validateToolArgs('list_audit_logs', { actorType: 'system' }), /actorType must be/);
    assert.throws(() => validateToolArgs('list_audit_logs', { entityId: 'nope' }), /entityId must be a uuid/);
  });
});

describe('v1 financial reads: routes and shapes', () => {
  it('executes the exact existing GET routes and returns bodies untouched', async () => {
    const executors = createToolExecutors(stubTransport({
      'GET /analytics/kpis?period=last30days&basis=liquidez': { statusCode: 200, body: kpisBody },
      'GET /analytics/category-breakdown?kind=expense': { statusCode: 200, body: breakdownBody },
      'GET /analytics/cashflow-series?period=last30days': { statusCode: 200, body: cashflowBody },
      'GET /analytics/budget-consumption': { statusCode: 200, body: { items: [], total: 0 } },
      'GET /analytics/net-worth-history': { statusCode: 200, body: netWorthBody },
      'GET /budgets': { statusCode: 200, body: itemsBody },
      'GET /budgets/check': { statusCode: 200, body: itemsBody },
      [`GET /budgets/${BUDGET}/trends?monthsBack=6`]: { statusCode: 200, body: itemsBody },
      'GET /goals': { statusCode: 200, body: itemsBody },
      'GET /payables?status=pending&dueWithinDays=7': { statusCode: 200, body: itemsBody },
      'GET /payables/reminders': { statusCode: 200, body: itemsBody },
      'GET /audit-logs?limit=10&actorType=user': { statusCode: 200, body: itemsBody },
    }));
    const opts = { intentionId: 'int-reads' };
    assert.deepEqual(await executors.analytics_kpis({ period: 'last30days', basis: 'liquidez' }, host, opts), kpisBody);
    assert.deepEqual(await executors.analytics_category_breakdown({ kind: 'expense' }, host, opts), breakdownBody);
    assert.deepEqual(await executors.analytics_cashflow_series({ period: 'last30days' }, host, opts), cashflowBody);
    assert.deepEqual(await executors.analytics_budget_consumption({}, host, opts), { items: [], total: 0 });
    assert.deepEqual(await executors.analytics_net_worth_history({}, host, opts), netWorthBody);
    assert.deepEqual(await executors.list_budgets({}, host, opts), itemsBody);
    assert.deepEqual(await executors.check_budgets({}, host, opts), itemsBody);
    assert.deepEqual(await executors.budget_trends({ budgetId: BUDGET, monthsBack: 6 }, host, opts), itemsBody);
    assert.deepEqual(await executors.list_goals({}, host, opts), itemsBody);
    assert.deepEqual(await executors.list_payables({ status: 'pending', dueWithinDays: 7 }, host, opts), itemsBody);
    assert.deepEqual(await executors.payable_reminders({}, host, opts), itemsBody);
    assert.deepEqual(await executors.list_audit_logs({ limit: 10, actorType: 'user' }, host, opts), itemsBody);
  });

  it('fails closed on divergent 2xx shapes instead of grounding on them', async () => {
    const executors = createToolExecutors(stubTransport({
      'GET /analytics/kpis': { statusCode: 200, body: { ...kpisBody, incomeCents: '100' } },
      'GET /budgets': { statusCode: 200, body: { items: 'nope', total: 1 } },
      'GET /analytics/cashflow-series': { statusCode: 200, body: { ...cashflowBody, current: [{ date: '2026-11-01', valueCents: 1.5 }] } },
      'GET /analytics/net-worth-history': { statusCode: 200, body: { months: [{ month: 'November', netWorthCents: 1 }], transactionCount: 0 } },
    }));
    const opts = { intentionId: 'int-shape' };
    for (const [fn, args] of [
      ['analytics_kpis', {}],
      ['list_budgets', {}],
      ['analytics_cashflow_series', {}],
      ['analytics_net_worth_history', {}],
    ]) {
      await assert.rejects(
        () => executors[fn](args, host, opts),
        (err) => err instanceof ToolError && err.code === 'tool.invalid_shape',
        `${fn} must fail closed`,
      );
    }
  });

  it('propagates typed upstream errors and never fabricates totals', async () => {
    const executors = createToolExecutors(stubTransport({
      'GET /payables': { statusCode: 403, body: { code: 'auth.workspace_forbidden' } },
      'GET /audit-logs': { statusCode: 500, body: { code: 'internal' } },
    }));
    await assert.rejects(
      () => executors.list_payables({}, host, { intentionId: 'int-err' }),
      (err) => err instanceof ToolError && err.code === 'tool.forbidden',
    );
    await assert.rejects(
      () => executors.list_audit_logs({}, host, { intentionId: 'int-err-2' }),
      (err) => err instanceof ToolError && err.code === 'tool.upstream_500',
    );
  });
});

describe('v1 financial reads: transport allowlist', () => {
  it('allowlists the exact read routes plus the UUID budget-trends path', () => {
    for (const route of [
      '/analytics/kpis',
      '/analytics/category-breakdown?period=lastMonth',
      '/analytics/cashflow-series',
      '/analytics/budget-consumption',
      '/analytics/net-worth-history',
      '/budgets',
      '/budgets/check',
      `/budgets/${BUDGET}/trends?monthsBack=3`,
      '/goals',
      '/payables?status=pending',
      '/payables/reminders',
      '/audit-logs?limit=5',
    ]) {
      assert.equal(isRouteAllowlisted(route), true, route);
    }
    assert.equal(isRouteAllowlisted('/budgets/not-a-uuid/trends'), false);
    assert.equal(isRouteAllowlisted(`/budgets/${BUDGET}/trends/extra`), false);
    assert.equal(isRouteAllowlisted('/analytics/quick'), false);
    assert.equal(isRouteAllowlisted('/payables/123/pay'), false);
    assert.equal(isRouteAllowlisted('/audit/undo'), false);
  });

  it('refuses non-GET methods on the new routes', async () => {
    const transport = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
    for (const route of ['/budgets', '/payables', '/audit-logs', `/budgets/${BUDGET}/trends`]) {
      await assert.rejects(
        () => transport.call({ route, method: 'POST', host }),
        /method not allowlisted/,
      );
    }
  });
});
