// P2D live-real fetch guard — offline allowlist contract for the V1
// completion reads. Pure classification only; no network, no provider.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLiveRealRequest,
  createLiveRealFetchGuard,
  parseLiveRealApiOrigin,
} from './p2d-fetch-guard.mjs';

const API = 'http://127.0.0.1:4110';
const options = { apiOrigin: API };
const headers = { 'x-device-token': 'device', 'x-workspace-id': 'workspace', accept: 'application/json' };
const BUDGET = '11111111-1111-4111-8111-111111111111';

const classify = (path, { method = 'GET', init = {} } = {}) =>
  classifyLiveRealRequest(`${API}${path}`, { method, headers, ...init }, options);

describe('p2d live-real fetch guard: V1 completion reads', () => {
  it('permits only traced catalog headers and denies authorization', () => {
    const url = 'https://models.opencode.ai/experimental/v2.0/api.json';
    assert.deepEqual(classifyLiveRealRequest(url, { headers: { b3: 'x', traceparent: 'x', 'user-agent': 'x' } }), {
      action: 'allow-catalog', reason: 'catalog',
    });
    assert.equal(classifyLiveRealRequest(url, { headers: { authorization: 'Bearer x' } }).action, 'deny');
  });

  it('passes the exact inference config as auxiliary without pinning or inference accounting', async () => {
    let passed;
    const guard = createLiveRealFetchGuard({
      fetchImpl: async (_input, init) => { passed = init; return { status: 204 }; },
      apiOrigin: API,
      expectedModelID: 'test-model',
    });
    const url = 'https://opencode.ai/console/api/v2/config';
    assert.deepEqual(classifyLiveRealRequest(url, { headers: {
      accept: 'application/json', authorization: 'Bearer x', b3: 'x', traceparent: 'x', 'user-agent': 'x',
    } }), { action: 'allow-auxiliary', reason: 'inference_config' });
    await guard.fetch(url, { headers: { accept: 'application/json' } });
    assert.equal(passed.redirect, 'manual');
    assert.equal(guard.stats.inferenceAttempts, 0);
    assert.equal(guard.stats.inferenceAllowed, 0);
    assert.equal(guard.stats.catalogAllowed, 0);
    assert.equal(guard.stats.apiAllowed, 0);
    assert.equal(guard.stats.auxiliaryAllowed, 1);
    assert.deepEqual(guard.stats.auxiliaryStatuses, [204]);
    assert.deepEqual(
      [guard.stats.inferenceAllowed, guard.stats.apiAllowed, guard.stats.catalogAllowed],
      [0, 0, 0],
    );
    for (const [target, init] of [
      [url, { method: 'POST' }],
      ['https://opencode.ai/console/api/v2/other', { method: 'GET' }],
    ]) assert.equal(classifyLiveRealRequest(target, init).action, 'deny');
  });

  it('follows only safe same-host redirects for catalog and auxiliary requests', async () => {
    const redirect = (location) => ({ status: 302, headers: { location } });
    const makeGuard = (actionUrl, locations) => {
      let calls = 0;
      const guard = createLiveRealFetchGuard({
        fetchImpl: async (_url, init) => {
          assert.equal(init.redirect, 'manual');
          const location = locations[calls++];
          return location ? redirect(location) : { status: 200 };
        },
        apiOrigin: API,
        expectedModelID: 'test-model',
      });
      return { guard, get calls() { return calls; }, actionUrl };
    };
    const catalog = makeGuard(
      'https://models.opencode.ai/experimental/v2.0/api.json',
      ['/experimental/v2.0/api.json?type=chat'],
    );
    assert.equal((await catalog.guard.fetch(catalog.actionUrl)).status, 200);
    assert.equal(catalog.calls, 2);
    assert.equal(catalog.guard.stats.redirectsBlocked, 0);
    assert.deepEqual(catalog.guard.stats.catalogStatuses, [200]);
    assert.equal(catalog.guard.stats.catalogAllowed, 1);

    const auxiliary = makeGuard('https://opencode.ai/console/api/v2/config', ['/console/api/v2/config']);
    assert.equal((await auxiliary.guard.fetch(auxiliary.actionUrl)).status, 200);
    assert.equal(auxiliary.guard.stats.redirectsBlocked, 0);
    assert.deepEqual(auxiliary.guard.stats.auxiliaryStatuses, [200]);
  });

  it('blocks unsafe destinations and chains beyond two safe redirect hops', async () => {
    const redirect = (location) => ({ status: 302, headers: { location } });
    const catalogUrl = 'https://models.opencode.ai/experimental/v2.0/api.json';
    for (const location of [
      'https://attacker.example/experimental/v2.0/api.json',
      'http://models.opencode.ai/experimental/v2.0/api.json',
      'https://models.opencode.ai:8443/experimental/v2.0/api.json',
      'https://user@models.opencode.ai/experimental/v2.0/api.json',
    ]) {
      const guard = createLiveRealFetchGuard({
        fetchImpl: async () => redirect(location), apiOrigin: API, expectedModelID: 'test-model',
      });
      await assert.rejects(() => guard.fetch(catalogUrl), /redirect blocked/);
      assert.equal(guard.stats.redirectsBlocked, 1);
    }

    const chain = createLiveRealFetchGuard({
      fetchImpl: async () => redirect('/experimental/v2.0/api.json'),
      apiOrigin: API, expectedModelID: 'test-model',
    });
    await assert.rejects(() => chain.fetch(catalogUrl), /redirect blocked/);
    assert.equal(chain.stats.redirectsBlocked, 1);
  });

  it('continues to block redirects for pinned inference and finance API requests', async () => {
    for (const [url, init] of [
      ['https://opencode.ai/inference/go/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer token' }, body: '{"model":"test-model"}',
      }],
      [`${API}/accounts`, { headers }],
    ]) {
      const guard = createLiveRealFetchGuard({
        fetchImpl: async () => ({ status: 302, headers: { location: url } }),
        apiOrigin: API, expectedModelID: 'test-model',
      });
      await assert.rejects(() => guard.fetch(url, init), /redirect blocked/);
      assert.equal(guard.stats.redirectsBlocked, 1);
    }
  });

  it('denies other loopback hosts without counting them as blocked API traffic', async () => {
    assert.deepEqual(classifyLiveRealRequest('http://localhost:4110/api/tags', {}, options), {
      action: 'deny', reason: 'auxiliary_loopback',
    });
    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => { throw new Error('denied request reached fetch'); },
      apiOrigin: API,
      expectedModelID: 'test-model',
    });
    await assert.rejects(() => guard.fetch('http://localhost:4110/api/tags'), /auxiliary_loopback/);
    assert.equal(guard.stats.apiBlocked, 0);
    assert.equal(guard.stats.blockedReasons.auxiliary_loopback, 1);
  });
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

  it('allows only structurally valid pending-token mint requests without exposing values', async () => {
    const url = `${API}/auth/agent/pending-token`;
    const body = JSON.stringify({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      actorId: '00000000-0000-4000-8000-000000000002',
      deviceId: '00000000-0000-4000-8000-000000000003',
      requestId: '00000000-0000-4000-8000-000000000004',
    });
    const requestHeaders = {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-agent-pending-service-token': 'test-token',
    };
    assert.deepEqual(classifyLiveRealRequest(url, {
      method: 'POST', headers: requestHeaders, body,
    }, options), { action: 'allow-api', reason: 'api' });

    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => ({ status: 200 }),
      apiOrigin: API,
      expectedModelID: 'test-model',
    });
    await guard.fetch(url, { method: 'POST', headers: requestHeaders, body });
    assert.equal(JSON.stringify(guard.stats).includes('test-token'), false);
    assert.equal(JSON.stringify(guard.stats).includes(body), false);

    for (const request of [
      { headers: { ...requestHeaders, 'x-agent-pending-service-token': undefined }, body },
      { headers: requestHeaders, body: JSON.stringify({ ...JSON.parse(body), extra: 'test-token' }) },
    ]) {
      const headers = { ...request.headers };
      if (headers['x-agent-pending-service-token'] === undefined) delete headers['x-agent-pending-service-token'];
      const init = { method: 'POST', headers, body: request.body };
      assert.deepEqual(classifyLiveRealRequest(url, init, options), { action: 'deny', reason: 'api_body' });
      await assert.rejects(() => guard.fetch(url, init), (error) => {
        assert.equal(error.message.includes('test-token'), false);
        assert.equal(error.message.includes(request.body), false);
        return true;
      });
    }
    assert.equal(JSON.stringify(guard.stats).includes('test-token'), false);
    assert.equal(JSON.stringify(guard.stats).includes(body), false);
  });

  it('allows pending-operation active and propose with bounded auth headers and opaque observations', async () => {
    const auth = {
      authorization: 'Bearer test-token',
      'x-workspace-id': '00000000-0000-4000-8000-000000000001',
      'x-actor-id': '00000000-0000-4000-8000-000000000002',
      'x-device-id': '00000000-0000-4000-8000-000000000003',
      'idempotency-key': '00000000-0000-4000-8000-000000000004',
      accept: 'application/json',
    };
    const active = `${API}/pending-operations/v2/active`;
    assert.deepEqual(classifyLiveRealRequest(active, { method: 'GET', headers: auth }, options), {
      action: 'allow-api', reason: 'api',
    });

    const propose = `${API}/pending-operations/v2/propose`;
    const body = JSON.stringify({ amount: 12345, memo: 'synthetic financial value' });
    const headers = { ...auth, 'content-type': 'application/json' };
    assert.deepEqual(classifyLiveRealRequest(propose, { method: 'POST', headers, body }, options), {
      action: 'allow-api', reason: 'api',
    });
    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => ({ status: 200 }),
      apiOrigin: API,
      expectedModelID: 'test-model',
    });
    await guard.fetch(propose, { method: 'POST', headers, body });
    const missingAuthorization = { ...headers };
    delete missingAuthorization.authorization;
    assert.deepEqual(classifyLiveRealRequest(propose, {
      method: 'POST', headers: missingAuthorization, body,
    }, options), { action: 'deny', reason: 'api_header' });
    for (const invalidBody of ['not-json', '[]', '{}']) {
      assert.deepEqual(classifyLiveRealRequest(propose, {
        method: 'POST', headers, body: invalidBody,
      }, options), { action: 'deny', reason: 'api_body' });
    }
    for (const value of ['test-token', body, '12345', '00000000-0000-4000-8000-000000000001']) {
      assert.equal(JSON.stringify(guard.stats).includes(value), false);
    }
    await assert.rejects(() => guard.fetch(propose, {
      method: 'POST', headers: missingAuthorization, body,
    }), (error) => {
      for (const value of ['test-token', body, '12345']) assert.equal(error.message.includes(value), false);
      return true;
    });
    for (const value of ['test-token', body, '12345']) {
      assert.equal(JSON.stringify(guard.stats).includes(value), false);
    }
  });
});
