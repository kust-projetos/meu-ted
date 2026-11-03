// P1 RED: fetch transport — allowlisted GET reads only, timeout/abort, scrub.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HttpFinanceTransport, isRouteAllowlisted, ToolError } from '../src/transport.mjs';
import { ToolError as ToolDefinitionError } from '../src/tool-defs.mjs';

const host = Object.freeze({ label: 'a', token: 'secret-token-a', household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' });

let server;
let baseUrl;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Contrato real: identidade via header x-device-token (device-token.ts:50);
    // nunca Authorization: Bearer, nunca workspace do cliente.
    if (req.headers['x-device-token'] !== 'secret-token-a') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/accounts' && req.method === 'GET') {
      // slow=1 exercita o caminho real de timeout sobre rota PERMITIDA
      // (o teste antigo usava /slow fora da allowlist e nunca expirava).
      if (url.searchParams.get('slow') === '1') {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 'a1' }], total: 1 }));
      return;
    }
    if (url.pathname === '/dashboard/month-summary' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ yearMonth: url.searchParams.get('yearMonth'), incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: 1 }));
      return;
    }
    if (url.pathname === '/slow' && req.method === 'GET') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 500);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('ted-runtime http transport', () => {
  it('shares the tool error contract instead of defining a second ToolError class', () => {
    assert.equal(ToolError, ToolDefinitionError);
  });

  it('allowlists only the exact read paths (exact pathname; P3 /categories covered in p3-category-read.test.mjs)', () => {
    assert.equal(isRouteAllowlisted('/accounts'), true);
    assert.equal(isRouteAllowlisted('/accounts?kind=bank'), true);
    assert.equal(isRouteAllowlisted('/dashboard/month-summary?yearMonth=2026-06'), true);
    assert.equal(isRouteAllowlisted('/accounts/123'), false);
    assert.equal(isRouteAllowlisted('/pending-operations/v2/propose'), false);
    assert.equal(isRouteAllowlisted('/dashboard/month-summary-extra'), false);
  });

  it('performs two real local reads with per-call device token (no token in errors)', async () => {
    const t = new HttpFinanceTransport({ baseUrl });
    const accounts = await t.call({ route: '/accounts', method: 'GET', host });
    assert.equal(accounts.statusCode, 200);
    assert.equal(accounts.body.total, 1);
    const summary = await t.call({ route: '/dashboard/month-summary?yearMonth=2026-06', method: 'GET', host });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.body.transactionCount, 1);
  });

  it('rejects non-allowlisted routes and write methods before any I/O', async () => {
    const t = new HttpFinanceTransport({ baseUrl });
    await assert.rejects(() => t.call({ route: '/pending-operations/v2/propose', method: 'POST', host }), /not allowlisted/);
    await assert.rejects(() => t.call({ route: '/accounts', method: 'POST', host }), /method not allowlisted/);
  });

  it('expira timeout real sobre rota permitida lenta (sem máscara de gate)', async () => {
    const t = new HttpFinanceTransport({ baseUrl, timeoutMs: 120 });
    const err = await t.call({ route: '/accounts?slow=1', method: 'GET', host }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.timeout');
    assert.ok(!String(err.message).includes('secret-token-a'));
  });

  it('aborts mid-flight as tool.cancelled without leaking the token', async () => {
    const t = new HttpFinanceTransport({ baseUrl, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = t.call({ route: '/dashboard/month-summary?yearMonth=2026-06', method: 'GET', host, signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.cancelled');
    assert.ok(!String(err.message).includes('secret-token-a'), 'token must never appear in errors');
  });

  it('forwards x-workspace-id exclusivamente do host autenticado (nunca de args)', async () => {
    // device-access.ts:26-31: sem o header, o fallback resolve o household de
    // origem do token — não o workspace selecionado (violação de isolamento).
    // O header SÓ pode vir do host congelado server-side; chaves de identidade
    // em args já são rejeitadas pelo validateToolArgs (tool-defs).
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, json: async () => ({ items: [], total: 0 }) };
    };
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    await t.call({ route: '/accounts', method: 'GET', host });
    assert.equal(seen[0].init.headers['x-workspace-id'], 'H_A');
    assert.equal(seen[0].init.headers['x-device-token'], 'secret-token-a');
  });

  it('falha fechado sem household no host (sem identidade de workspace, sem I/O)', async () => {
    let io = 0;
    const fetchImpl = async () => { io++; return { status: 200, json: async () => ({}) }; };
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    const err = await t.call({ route: '/accounts', method: 'GET', host: { ...host, household: '' } }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.match(err.code, /tool\.invalid_args/);
    assert.equal(io, 0, 'no network I/O without workspace identity');
  });

  it('exige baseUrl puramente origin (sem path/search/hash) para não desviar a rota', () => {
    // `${baseUrl}${route}` com base `http://127.0.0.1:3001/?x=` transformaria
    // a rota em query — segredo ao serviço/path errado, allowlist violada.
    assert.throws(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001/?x=' }), /origin/);
    assert.throws(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001/api' }), /origin/);
    assert.throws(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001/#frag' }), /origin/);
    assert.throws(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001/?y=1#z' }), /origin/);
    assert.doesNotThrow(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001/' }));
    assert.doesNotThrow(() => new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:3001' }));
  });
});
