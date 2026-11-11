// RED: wiring plugin→HTTP + garantias de transporte contra o contrato real.
// Contrato real (não inventado): apps/api/src/routes/accounts.ts:42-46 e
// dashboard.ts:17-21 resolvem identidade via header `x-device-token`
// (apps/api/src/auth/device-token.ts:50); workspace é server-side, nunca
// header/query do cliente. Sem dependências externas (doubles + stub HTTP).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpFinanceTransport } from '../src/transport.mjs';
import { defineTedFinancePlugin, PRODUCT_TOOL_NAMES } from '../src/plugin.mjs';
import { wirePlugin } from '../src/bootstrap.mjs';
import { bindSession, clearAll } from '../src/session-bindings.mjs';

const host = Object.freeze({ label: 'a', token: 'tok-real-1', household: 'H_A', deviceId: 'dev-a', actorId: 'actor-a' });

function stubFetch(handler) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return handler(url, init);
  };
  return { seen, fetchImpl };
}

const okJson = (body, status = 200) => ({
  status,
  json: async () => body,
});

describe('wiring plugin -> transport -> HTTP (contrato real)', () => {
  it('transport usa x-device-token + x-workspace-id do host (nunca Authorization Bearer)', async () => {
    const { seen, fetchImpl } = stubFetch(() => okJson({ items: [], total: 0 }));
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    await t.call({ route: '/accounts', method: 'GET', host });
    assert.equal(seen.length, 1);
    const headers = seen[0].init.headers;
    assert.equal(headers['x-device-token'], 'tok-real-1');
    // device-access.ts:26-31: sem o header, o fallback resolve o household de
    // origem do token — não o workspace selecionado. O header vem
    // EXCLUSIVAMENTE do host congelado server-side (nunca de args do LLM).
    assert.equal(headers['x-workspace-id'], 'H_A');
    assert.ok(!('authorization' in headers), 'sem Authorization: Bearer inventado');
    assert.ok(!seen[0].url.includes('workspace'), 'sem workspace na query');
  });

  it('cross-scope: workspace contrabandeado em args do LLM é rejeitado fim-a-fim', async () => {
    const registered = [];
    const oc = { plugin: async (def) => { registered.push(def); return { id: def.id }; } };
    const pluginDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }));
    await wirePlugin(oc, pluginDef);
    clearAll();
    bindSession('ses_X1', { ...host });
    const added = [];
    // PR290-07: permission.assert is captured at plugin setup (Plugin 2.2.4
    // setup Context); the execute ctx below carries no permission.
    await registered[0].setup({
      permission: { assert: async (input) => {
        assert.equal(input.action, 'ted.finance.read');
        assert.deepEqual(input.resources, ['list_accounts']);
      } },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    const listAccounts = added.find((t) => t.name === 'list_accounts');
    // PR290: native permission gate allows (exact product action/resource),
    // so the smuggle reaches the arg/host guards it must violate.
    const allowCtx = (extra) => ({
      ...extra,
    });
    // Tentativa de trocar o escopo via args (workspaceId/household/token).
    for (const smuggled of [{ workspaceId: 'H_EVIL' }, { household: 'H_EVIL' }, { token: 'tok-evil' }]) {
      const err = await listAccounts.execute(smuggled, allowCtx({ sessionID: 'ses_X1', messageID: 'm9', id: 'call-9' })).catch((e) => e);
      assert.match(String(err.message || err), /forbidden key|host-bound/, `smuggle ${JSON.stringify(smuggled)} recusado`);
    }
  });

  it('transport nunca segue redirect com o token (redirect manual, 3xx vira erro tipado)', async () => {
    const { seen, fetchImpl } = stubFetch(() => okJson({ location: '/x' }, 302));
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    assert.equal(seen.length, 0);
    const err = await t.call({ route: '/accounts', method: 'GET', host }).catch((e) => e);
    assert.equal(seen[0].init.redirect, 'manual');
    assert.equal(err.code, 'tool.upstream_error');
    assert.ok(!String(err.message).includes('tok-real-1'));
  });

  it('call funciona desligado da instância (sem exigir função ligada pelo chamador)', async () => {
    const { fetchImpl } = stubFetch(() => okJson({ items: [], total: 0 }));
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    const { call } = t; // eslint-disable-line prefer-destructuring
    const out = await call({ route: '/accounts', method: 'GET', host });
    assert.equal(out.statusCode, 200);
  });

  it('bootstrap registra o plugin no host (wirePlugin) com o catálogo exato', async () => {
    const registered = [];
    const oc = { plugin: async (def) => { registered.push(def); return { id: def.id }; } };
    const seen = [];
    const pluginDef = defineTedFinancePlugin(() => async (args) => {
      seen.push(args);
      return { statusCode: 200, body: { items: [], total: 0 } };
    });
    await wirePlugin(oc, pluginDef);
    assert.deepEqual(registered.map((d) => d.id), ['ted-finance']);

    // Caminho plugin->HTTP: setup captura execute; ctx resolve host via binding.
    clearAll();
    bindSession('ses_W1', { ...host });
    const added = [];
    await registered[0].setup({
      permission: { assert: async (input) => {
        assert.equal(input.action, 'ted.finance.read');
        assert.deepEqual(input.resources, ['list_accounts']);
      } },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    assert.deepEqual(added.map((t) => t.name).sort(), [...PRODUCT_TOOL_NAMES].sort());
    const listAccounts = added.find((t) => t.name === 'list_accounts');
    // PR290-07: execute asserts the setup-captured native permission first —
    // the allow double was bound at setup with the exact product
    // action/resource; the execute ctx carries no permission. Transport
    // runs after allow.
    const out = await listAccounts.execute({}, {
      sessionID: 'ses_W1', messageID: 'm1', id: 'call-1',
    });
    assert.deepEqual(out.output, { items: [], total: 0 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].route, '/accounts');
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].host.token, 'tok-real-1');
    assert.ok(typeof seen[0].intentionId === 'string' && seen[0].intentionId.length > 0);
  });

  it('setup captura o catálogo efetivo via ctx.tool.list() (seam onEffectiveTools)', async () => {
    const reported = [];
    const pluginDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), {
      onEffectiveTools: (names, error) => reported.push({ names, error }),
    });
    const added = [];
    await pluginDef.setup({
      permission: { assert: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: {
        list: async () => [{ name: 'list_accounts' }, { name: 'get_month_summary' }],
        transform: async (fn) => { fn({ add: (t) => added.push(t) }); },
      },
    });
    assert.equal(reported.length, 1);
    assert.deepEqual(reported[0].names, ['get_month_summary', 'list_accounts']);
    assert.equal(reported[0].error, null);
    assert.deepEqual(added.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);
    // Sem contexto de plugin (sem ctx.tool.list), o seam reporta o erro em
    // vez de inventar um catálogo.
    const reported2 = [];
    const pluginDef2 = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }), {
      onEffectiveTools: (names, error) => reported2.push({ names, error }),
    });
    await pluginDef2.setup({
      permission: { assert: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: () => {} }); } },
    });
    assert.equal(reported2.length, 1);
    assert.equal(reported2[0].names, null);
    assert.ok(reported2[0].error instanceof Error);
  });

  it('wirePlugin falha fechado sem oc.plugin (sem registro silencioso)', async () => {
    await assert.rejects(() => wirePlugin({}, { id: 'ted-finance' }), /oc\.plugin/);
    await assert.rejects(() => wirePlugin(null, { id: 'ted-finance' }), /oc\.plugin/);
  });
});
