// P2D live-real fetch guard — offline allowlist contract for the V1
// completion reads. Pure classification only; no network, no provider.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLiveRealRequest, parseLiveRealApiOrigin } from './p2d-fetch-guard.mjs';

const API = 'http://127.0.0.1:4110';
const options = { apiOrigin: API };
const headers = { 'x-device-token': 'device', 'x-workspace-id': 'workspace', accept: 'application/json' };
const BUDGET = '11111111-1111-4111-8111-111111111111';

const classify = (path, { method = 'GET', init = {} } = {}) =>
  classifyLiveRealRequest(`${API}${path}`, { method, headers, ...init }, options);

describe('p2d live-real fetch guard: V1 completion reads', () => {
  it('accepts the loopback API origin only', () => {
    assert.equal(parseLiveRealApiOrigin(API), API);
    assert.equal(parseLiveRealApiOrigin('https://127.0.0.1:4110'), null);
  });

  it('allows every new GET read with the host-bound headers and query', () => {
    const paths = [
      '/transactions?accountId=11111111-1111-4111-8111-111111111111&limit=20',
      '/insights/spending?yearMonth=2026-11',
      '/analytics/kpis?period=last30days&basis=liquidez',
      '/analytics/category-breakdown?kind=expense',
      '/analytics/cashflow-series?period=lastMonth',
      '/analytics/budget-consumption',
      '/analytics/net-worth-history',
      '/budgets',
      '/budgets/check',
      '/goals',
      '/payables?status=pending&dueWithinDays=7',
      '/payables/reminders',
      '/audit-logs?limit=10&actorType=user',
      `/budgets/${BUDGET}/trends?monthsBack=6`,
    ];
    for (const path of paths) {
      assert.deepEqual(classify(path), { action: 'allow-api', reason: 'api' }, path);
    }
  });

  it('refuses writes, unknown paths and credential-smuggling headers', () => {
    assert.equal(classify('/budgets', { method: 'POST' }).action, 'deny');
    assert.equal(classify('/analytics/quick').action, 'deny');
    assert.equal(classify('/budgets/not-a-uuid/trends').action, 'deny');
    assert.equal(classify('/payables/123/pay', { method: 'POST' }).action, 'deny');
    assert.equal(
      classify('/budgets', { init: { headers: { ...headers, authorization: 'Bearer x' } } }).action,
      'deny',
    );
  });
});
