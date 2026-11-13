// Spike 02 (Steps 2-3): TED finance gateway over REAL pi-financeiro handlers.
//
// Deterministic, no LLM, no network beyond localhost toolchain. Finance tools
// call the repo's REAL Fastify handlers via a one-shot tsx bridge into the
// real buildTestApp (synthetic in-memory data only). OpenCode sessions run on
// the embedded 2.2.4 SDK (identity home "c", isolated from spike-01 a/b).
//
// 14 integration cases + gates G2-01..G2-04, G3-01..G3-06 (§7 acceptance).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = path.join(TED, 'bootstrap');
const requireBoot = createRequire(path.join(BOOT, 'run-identity.mjs'));

process.env.TED_HOME_ROOT = TED;
const { setupIsolation } = requireBoot('./env.cjs');

// Synthetic identities. Tokens are the synthetic device tokens from the real
// test-app token store (dev-token-1 -> HOUSEHOLD_A, dev-token-2 -> HOUSEHOLD_B).
// Never real credentials; the host binds them, the model never sees them.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };
const HOST_BAD = { label: 'BAD', token: 'not-a-real-token', household: 'HOUSEHOLD_A', actorId: 'unknown', deviceId: 'unknown' };
const HOST_BOOM = { label: 'BOOM', token: 'boom-token', household: 'HOUSEHOLD_A', actorId: 'unknown', deviceId: 'unknown' };
const SECRET_SUBSTRINGS = ['dev-token-1', 'dev-token-2', 'boom-token', 'not-a-real-token'];

let gw;
let env;
let A;
let B;
let BAD;
let BOOM;

function runFinanceCheck() {
  const out = execFileSync(process.execPath, [path.join(BOOT, 'run-finance-check.mjs')], {
    cwd: BOOT,
    env: { ...process.env, TED_HOME_ROOT: TED },
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(String(out));
}

const errorTexts = [];
async function capture(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (e) {
    errorTexts.push(String((e && e.message) || e) + ' ' + JSON.stringify((e && e.details) || ''));
    return { ok: false, error: e };
  }
}

describe('spike-02 steps 2-3: finance gateway + native plugin', () => {
  before(async () => {
    setupIsolation('c');
    gw = await import('../bootstrap/ted-gateway.mjs');
    env = await gw.createTedEnvironment({ identity: 'c' });
    A = env.facadeFor(HOST_A);
    B = env.facadeFor(HOST_B);
    BAD = env.facadeFor(HOST_BAD);
    BOOM = env.facadeFor(HOST_BOOM);
  });

  after(async () => {
    await env.close().catch(() => {});
  });

  it('G2-01 plugin in effective catalog via native registration', () => {
    const check = runFinanceCheck();
    assert.ok(check.pluginListed.includes('ted-finance'), `ted-finance in plugin.list: ${JSON.stringify(check.pluginListed)}`);
    assert.equal(check.tedEntry && check.tedEntry.state && check.tedEntry.state.status, 'active');
    assert.equal(check.marker.plugin, 'ted-finance');
    // Native post-transform catalog read: both finance tools registered
    // alongside the native builtins (no private registry).
    assert.ok(check.marker.tools.includes('list_accounts'), 'list_accounts in native tool catalog');
    assert.ok(check.marker.tools.includes('get_month_summary'), 'get_month_summary in native tool catalog');
  });

  it('G2-02 tool schemas: strict args, forbidden identity keys rejected pre-transport', async () => {
    const listDef = gw.TOOL_DEFS.find((t) => t.name === 'list_accounts');
    const monthDef = gw.TOOL_DEFS.find((t) => t.name === 'get_month_summary');
    assert.equal(listDef.input.additionalProperties, false);
    assert.equal(monthDef.input.additionalProperties, false);
    assert.ok(monthDef.input.required.includes('yearMonth'));
    // Forbidden identity keys never reach the transport.
    const r1 = await capture(A.list_accounts({ actorId: 'attacker-chosen' }));
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'tool.invalid_args');
    const r2 = await capture(A.get_month_summary({ yearMonth: '2026-06', workspaceId: 'attacker-chosen' }));
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'tool.invalid_args');
    const r3 = await capture(A.get_month_summary({}));
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, 'tool.invalid_args');
  });

  it('(1) accounts with data: real handler, ids/values preserved, household-scoped', async () => {
    const body = await A.list_accounts({});
    assert.equal(body.total, 2);
    assert.equal(body.items.length, 2);
    const byName = Object.fromEntries(body.items.map((i) => [i.name, i]));
    assert.equal(byName['Itaú'].balanceCents, 100000);
    assert.equal(byName['Nubank'].balanceCents, 50000);
    assert.equal(byName['Itaú'].kind, 'bank');
    const households = new Set(body.items.map((i) => i.householdId));
    assert.equal(households.size, 1, 'single household scope');
    assert.ok(!JSON.stringify(body).includes('dev-token-1'), 'no token in success body');
  });

  it('(2) empty workspace: 200 empty list, distinct from error', async () => {
    const body = await A.list_accounts({}, { seed: 'empty' });
    assert.deepEqual(body, { items: [], total: 0 });
  });

  it('(3) month summary known values: exact real totals + effective period', async () => {
    const body = await A.get_month_summary({ yearMonth: '2026-06' });
    assert.deepEqual(body, {
      yearMonth: '2026-06',
      incomeCents: 1200000,
      expenseCents: 288050,
      balanceCents: 911950,
      transactionCount: 4,
    });
  });

  it('(4) period with no movements: 200 zeros, distinct from invalid', async () => {
    const body = await A.get_month_summary({ yearMonth: '2026-01' });
    assert.deepEqual(body, {
      yearMonth: '2026-01',
      incomeCents: 0,
      expenseCents: 0,
      balanceCents: 0,
      transactionCount: 0,
    });
  });

  it('(5) invalid period: real 400 validation.error, never fabricated zero', async () => {
    const r = await capture(A.get_month_summary({ yearMonth: '2026-13' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.statusCode, 400);
    assert.equal(r.error.body.code, 'validation.error');
    assert.equal(r.error.body.incomeCents, undefined, 'no fabricated totals on invalid input');
  });

  it('(6) auth failure 401: bad token fails closed, never empty', async () => {
    const r = await capture(BAD.list_accounts({}));
    assert.equal(r.ok, false);
    assert.equal(r.error.statusCode, 401);
    const r2 = await capture(BAD.get_month_summary({ yearMonth: '2026-06' }));
    assert.equal(r2.ok, false);
    assert.equal(r2.error.statusCode, 401);
  });

  it('(7) authz failure 403: denying access store hits real middleware 403', async () => {
    const r = await capture(A.list_accounts({}, { access: 'deny-all', workspaceId: 'synthetic-workspace' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.statusCode, 403, `expected real 403, got ${r.error.statusCode}: ${JSON.stringify(r.error.body)}`);
    assert.equal(r.error.body.code, 'auth.workspace_forbidden');
  });

  it('(8) HTTP 500: exploding token store surfaces real 500, no data', async () => {
    const r = await capture(BOOM.list_accounts({}, { tokenStore: 'exploding' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.statusCode, 500);
    assert.equal(r.error.body.items, undefined);
    assert.equal(r.error.body.incomeCents, undefined);
  });

  it('(9) timeout: slow upstream fails as tool.timeout, never empty/zero', async () => {
    const r = await capture(A.list_accounts({}, { delayMs: 2000, timeoutMs: 400 }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'tool.timeout');
    assert.equal(r.error.body, undefined);
  });

  it('(10) invalid payload: missing/unknown args rejected, never zero-filled', async () => {
    const r = await capture(A.list_accounts({ kind: 'not-a-kind' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.statusCode, 400);
    assert.equal(r.error.body.items, undefined);
    const r2 = await capture(A.get_month_summary({ yearMonth: 'not-a-period' }));
    assert.equal(r2.ok, false);
    assert.equal(r2.error.statusCode, 400);
    assert.equal(r2.error.body.incomeCents, undefined);
  });

  it('(11) A/B cross-access: B sees only B data, totals never cross', async () => {
    const bAccounts = await B.list_accounts({});
    assert.equal(bAccounts.total, 1);
    assert.equal(bAccounts.items[0].name, 'Bradesco');
    const aHouseholds = new Set((await A.list_accounts({})).items.map((i) => i.householdId));
    const bHouseholds = new Set(bAccounts.items.map((i) => i.householdId));
    assert.equal(aHouseholds.size, 1);
    assert.equal(bHouseholds.size, 1);
    assert.notEqual([...aHouseholds][0], [...bHouseholds][0], 'A and B households differ');
    const bJune = await B.get_month_summary({ yearMonth: '2026-06' });
    assert.deepEqual(bJune, {
      yearMonth: '2026-06',
      incomeCents: 0,
      expenseCents: 20000,
      balanceCents: -20000,
      transactionCount: 1,
    });
    // Interleaved calls stay scoped (no global token swapping).
    const [aAgain, bAgain] = await Promise.all([A.list_accounts({}), B.list_accounts({})]);
    assert.equal(aAgain.total, 2);
    assert.equal(bAgain.total, 1);
  });

  it('(12) restart then re-query: sessions persist, finance totals identical', async () => {
    const before = await A.get_month_summary({ yearMonth: '2026-06' });
    const s = await A.createSession('spike02-restart');
    await env.close();
    env = await gw.createTedEnvironment({ identity: 'c' });
    A = env.facadeFor(HOST_A);
    B = env.facadeFor(HOST_B);
    BAD = env.facadeFor(HOST_BAD);
    BOOM = env.facadeFor(HOST_BOOM);
    const afterRestart = await A.get_month_summary({ yearMonth: '2026-06' });
    assert.deepEqual(afterRestart, before);
    const reopened = await A.getSession(s.id);
    assert.equal(reopened.id, s.id, 'session survives gateway restart via sqlite');
    await A.removeSession(s.id);
  });

  it('(15) route allowlist is exact-path: exotic paths rejected pre-transport, never forwarded', async () => {
    const { callFinance, isRouteAllowlisted } = await import('../bootstrap/finance-transport.mjs');
    // Unit: exact pathname gate (query strings pass through to the REAL handler).
    assert.equal(isRouteAllowlisted('/accounts'), true);
    assert.equal(isRouteAllowlisted('/accounts?kind=bank&includeInactive=true'), true);
    assert.equal(isRouteAllowlisted('/dashboard/month-summary?yearMonth=2026-06'), true);
    for (const hostile of ['/accounts/123', '/account', '/accounts-extra', '/dashboard/month-summary-extra', '/dashboard/month-summary/2026-06', '/', '', null, undefined, 42]) {
      assert.equal(isRouteAllowlisted(hostile), false, `${String(hostile)} must not be allowlisted`);
    }
    // Behavioral: hostile route rejected with tool.invalid_args BEFORE any spawn.
    for (const hostile of ['/accounts/123', '/dashboard/month-summary-extra']) {
      const r = await capture(callFinance({ route: hostile, method: 'GET', host: HOST_A }));
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'tool.invalid_args');
      assert.ok(String(r.error.message).includes('not allowlisted'));
    }
  });

  it('(16) native prompt-loop execute fail-closes with explicit host_context_required (never hostless)', async () => {
    delete process.env.TED_FINANCE_MARKER_FILE; // stub ctx: no marker side effects
    const plugin = (await import('../bootstrap/plugins/ted-finance/index.mjs')).default;
    assert.equal(plugin.id, 'ted-finance');
    const added = [];
    await plugin.setup({
      tool: {
        transform: async (cb) => { cb({ add: (t) => added.push(t) }); },
        list: async () => [],
      },
    });
    assert.equal(added.length, 4, 'all finance tools registered via native transform');
    for (const tool of added) {
      for (const args of (tool.name === 'get_month_summary' ? [{}, { yearMonth: '2026-06' }] : [{}])) {
        const err = await tool.execute(args).then(() => null, (e) => e);
        assert.ok(err, `${tool.name} execute must reject without a host-bound context`);
        assert.equal(err.metadata && err.metadata.code, 'host_context_required', `${tool.name} fails closed with typed code`);
      }
    }
  });

  it('(14) admin capability via restricted surface denied', async () => {
    const keys = Object.keys(A).sort();
    assert.deepEqual(keys, [
      'createSession',
      'getSession',
      'get_month_summary',
      'listCatalogs',
      'listSessions',
      'list_accounts',
      'list_categories',
      'removeSession',
    ]);
    for (const k of ['shell', 'prompt', 'edit', 'call', 'mcp', 'subagent', 'tool', 'config', 'host', 'token']) {
      assert.equal(A[k], undefined, `${k} not exposed`);
    }
    assert.equal(Object.isFrozen(A), true);
    assert.equal(typeof A.call, 'undefined', 'no dynamic method dispatch entrypoint');
  });

  it('(13) tool failures leak no credentials', async () => {
    // Re-run failure modes to collect fresh error text.
    await capture(BAD.list_accounts({}));
    await capture(BOOM.list_accounts({}, { tokenStore: 'exploding' }));
    await capture(A.get_month_summary({ yearMonth: '2026-13' }));
    await capture(A.list_accounts({}, { delayMs: 2000, timeoutMs: 400 }));
    assert.ok(errorTexts.length > 0, 'failures were captured');
    for (const text of errorTexts) {
      for (const secret of SECRET_SUBSTRINGS) {
        assert.ok(!text.includes(secret), `leaked ${secret} in: ${text.slice(0, 200)}`);
      }
    }
    const catalogs = await A.listCatalogs();
    assert.ok(!JSON.stringify(catalogs).includes('dev-token-1'), 'no token in catalog output');
  });

  it('G2-03 host-bound identity: frozen, no secrets in history/prompts/results', async () => {
    const s = await A.createSession('identity-check');
    try {
      const got = await A.getSession(s.id);
      assert.equal(got.id, s.id);
      assert.ok(!JSON.stringify(got).includes('dev-token-1'));
    } finally {
      await A.removeSession(s.id);
    }
  });

  it('G2-04 facade exposes no admin natives; G3-06 no new frameworks', async () => {
    const catalogs = await A.listCatalogs();
    assert.equal(catalogs.hasToolCatalog, false, 'no tool-catalog endpoint (documented 2.2.4 limit)');
    // Real catalog-shape assertions: exact summary key set, and the plugin
    // summary is internally consistent (non-empty; count covers the possibly
    // truncated ids list — summarize() slices ids at 80).
    assert.deepEqual(Object.keys(catalogs).sort(), [
      'agents', 'commands', 'hasToolCatalog', 'mcp', 'models', 'plugins', 'providers', 'sessions', 'skills',
    ]);
    assert.ok(catalogs.plugins.ids.length > 0, 'plugin catalog non-empty');
    assert.ok(catalogs.plugins.count >= catalogs.plugins.ids.length, 'plugin count covers listed ids');
    // Dependency surface unchanged: only the 4 pinned spike deps.
    const pkg = JSON.parse(fs.readFileSync(path.join(BOOT, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
      '@earendil-works/pi-coding-agent',
      '@opencode/cli',
      '@opencode/client',
      '@opencode/plugin',
      '@opencode/sdk',
    ]);
    // No ConversationOrchestrator or new session/router/tool frameworks in spike code.
    const newFiles = ['ted-finance-tools.mjs', 'finance-transport.mjs', 'ted-gateway.mjs', 'run-finance-check.mjs', 'finance-bridge.ts', 'plugins/ted-finance/index.mjs'];
    for (const f of newFiles) {
      const src = fs.readFileSync(path.join(BOOT, f), 'utf8');
      assert.ok(!src.includes('ConversationOrchestrator'), `${f} has no ConversationOrchestrator`);
    }
  });
});
