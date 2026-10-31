// Spike 03A: host-bound session bindings over the native 2.2.4 tool path.
//
// Deterministic, no LLM, no network beyond the localhost toolchain. The SAME
// natively-registered execute functions from plugins/ted-finance/index.mjs
// (captured via the native ctx.tool.transform/editor.add path) are driven
// with synthetic Tool.Context objects {sessionID, agent, messageID, id,
// signal}; identity resolves ONLY via bootstrap/session-bindings.mjs — never
// from tool args, never from model-chosen IDs. Finance math stays with the
// REAL handlers through the tsx bridge (no reimplementation).
//
// RED-first: this file was run BEFORE session-bindings.mjs existed (module
// not found) and against the spike-02 plugin (which ignores ctx and
// fail-closes hostless for every call) — both RED. GREEN after the fix.
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

// Synthetic identities (same store as spike-02: dev-token-1 -> HOUSEHOLD_A,
// dev-token-2 -> HOUSEHOLD_B). Never real credentials.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };
const SECRET_SUBSTRINGS = ['dev-token-1', 'dev-token-2', 'boom-token', 'not-a-real-token'];

const SUMMARY_A_JUNE = {
  yearMonth: '2026-06',
  incomeCents: 1200000,
  expenseCents: 288050,
  balanceCents: 911950,
  transactionCount: 4,
};
const SUMMARY_B_JUNE = {
  yearMonth: '2026-06',
  incomeCents: 0,
  expenseCents: 20000,
  balanceCents: -20000,
  transactionCount: 1,
};

let gw;
let env;
let bindings;
const tools = {};
const errorTexts = [];
const successTexts = [];
let seq = 0;

function synthCtx(sessionID, overrides = {}) {
  seq += 1;
  return {
    sessionID,
    agent: 'ted',
    messageID: overrides.messageID || `msg-03a-${seq}`,
    id: overrides.callID || overrides.id || `call-03a-${seq}`,
    signal: overrides.signal,
  };
}

function codeOf(err) {
  return err && err.metadata && err.metadata.code;
}

async function capture(promise) {
  try {
    const value = await promise;
    try {
      successTexts.push(JSON.stringify(value));
    } catch { /* non-serializable — ignore for the leak scan */ }
    return { ok: true, value };
  } catch (e) {
    errorTexts.push(String((e && e.message) || e) + ' ' + JSON.stringify((e && e.metadata) || null));
    return { ok: false, error: e };
  }
}

function runFinanceCheck() {
  const out = execFileSync(process.execPath, [path.join(BOOT, 'run-finance-check.mjs')], {
    cwd: BOOT,
    env: { ...process.env, TED_HOME_ROOT: TED },
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(String(out));
}

describe('spike-03a host-bound session bindings', () => {
  before(async () => {
    setupIsolation('c');
    gw = await import('../bootstrap/ted-gateway.mjs');
    env = await gw.createTedEnvironment({ identity: 'c' });
    bindings = env.bindings;
    assert.ok(bindings && typeof bindings.bindSession === 'function', 'env exposes session bindings for tests');

    delete process.env.TED_FINANCE_MARKER_FILE; // stub ctx: no marker side effects
    const plugin = (await import('../bootstrap/plugins/ted-finance/index.mjs')).default;
    assert.equal(plugin.id, 'ted-finance');
    await plugin.setup({
      tool: {
        transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); },
        list: async () => [],
      },
    });
    assert.ok(tools.list_accounts && tools.get_month_summary, 'both finance tools captured via native transform');
  });

  after(async () => {
    try { bindings.clearAll(); } catch { /* best effort */ }
    await env.close().catch(() => {});
  });

  it('(r0) native registration still proves catalog presence (oc.plugin path)', () => {
    const check = runFinanceCheck();
    assert.ok(check.pluginListed.includes('ted-finance'));
    assert.equal(check.tedEntry && check.tedEntry.state && check.tedEntry.state.status, 'active');
    assert.ok(check.marker.tools.includes('list_accounts'));
    assert.ok(check.marker.tools.includes('get_month_summary'));
  });

  it('(a) bound session A resolves: Itaú+Nubank exact + June summary exact', async () => {
    bindings.bindSession('s03a-A1', HOST_A);
    const accounts = await tools.list_accounts.execute({}, synthCtx('s03a-A1'));
    assert.equal(accounts.output.total, 2);
    const byName = Object.fromEntries(accounts.output.items.map((i) => [i.name, i]));
    assert.equal(byName['Itaú'].balanceCents, 100000);
    assert.equal(byName['Nubank'].balanceCents, 50000);
    const summary = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx('s03a-A1'));
    assert.deepEqual(summary.output, SUMMARY_A_JUNE);
  });

  it('(b) bound session B resolves: Bradesco only + B June summary exact', async () => {
    bindings.bindSession('s03a-B1', HOST_B);
    const accounts = await tools.list_accounts.execute({}, synthCtx('s03a-B1'));
    assert.equal(accounts.output.total, 1);
    assert.equal(accounts.output.items[0].name, 'Bradesco');
    const summary = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx('s03a-B1'));
    assert.deepEqual(summary.output, SUMMARY_B_JUNE);
  });

  it('(c) unbound session and missing ctx fail closed with host_context_required', async () => {
    const r1 = await capture(tools.list_accounts.execute({}, synthCtx('s03a-never-bound')));
    assert.equal(r1.ok, false);
    assert.equal(codeOf(r1.error), 'host_context_required');
    const r2 = await capture(tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx('')));
    assert.equal(r2.ok, false);
    assert.equal(codeOf(r2.error), 'host_context_required');
    // Legacy hostless call shape (spike-02 test 16): still fail-closed, never hostless.
    const r3 = await capture(tools.list_accounts.execute({}));
    assert.equal(r3.ok, false);
    assert.equal(codeOf(r3.error), 'host_context_required');
  });

  it('(d) revoked and expired bindings fail with typed binding codes', async () => {
    bindings.bindSession('s03a-rev', HOST_A);
    bindings.revokeSession('s03a-rev');
    const r1 = await capture(tools.list_accounts.execute({}, synthCtx('s03a-rev')));
    assert.equal(r1.ok, false);
    assert.equal(codeOf(r1.error), 'host_binding_revoked');

    bindings.bindWithTTL('s03a-exp', HOST_A, -1); // already expired, deterministic
    const r2 = await capture(tools.list_accounts.execute({}, synthCtx('s03a-exp')));
    assert.equal(r2.ok, false);
    assert.equal(codeOf(r2.error), 'host_binding_expired');
  });

  it('(e) session bound to B rejects re-bind to A; execute still resolves B', async () => {
    bindings.bindSession('s03a-AB', HOST_B);
    let mismatch = null;
    try {
      bindings.bindSession('s03a-AB', HOST_A);
    } catch (err) {
      mismatch = err;
    }
    assert.ok(mismatch, 're-bind to a different host must throw');
    assert.equal(mismatch.code, 'host_binding_mismatch');
    // Binding unchanged: still B's household, B's data.
    assert.equal(bindings.getBinding('s03a-AB').host.household, 'HOUSEHOLD_B');
    const accounts = await tools.list_accounts.execute({}, synthCtx('s03a-AB'));
    assert.equal(accounts.output.total, 1);
    assert.equal(accounts.output.items[0].name, 'Bradesco');
    // Idempotent re-bind to the SAME host is OK.
    bindings.bindSession('s03a-AB', HOST_B);
    const again = await tools.list_accounts.execute({}, synthCtx('s03a-AB'));
    assert.equal(again.output.total, 1);
  });

  it('(f) simultaneous A+B sessions stay scoped (Promise.all, no crossover)', async () => {
    bindings.bindSession('s03a-conc-A', HOST_A);
    bindings.bindSession('s03a-conc-B', HOST_B);
    const [a, b] = await Promise.all([
      tools.list_accounts.execute({}, synthCtx('s03a-conc-A')),
      tools.list_accounts.execute({}, synthCtx('s03a-conc-B')),
    ]);
    assert.equal(a.output.total, 2);
    assert.equal(b.output.total, 1);
    assert.equal(b.output.items[0].name, 'Bradesco');
  });

  it('(g) concurrent turns on one session (distinct messageID/callID) share the household', async () => {
    bindings.bindSession('s03a-turns', HOST_A);
    const [t1, t2] = await Promise.all([
      tools.list_accounts.execute({}, synthCtx('s03a-turns', { messageID: 'msg-03a-g1', callID: 'call-03a-g1' })),
      tools.list_accounts.execute({}, synthCtx('s03a-turns', { messageID: 'msg-03a-g2', callID: 'call-03a-g2' })),
    ]);
    assert.equal(t1.output.total, 2);
    assert.equal(t2.output.total, 2);
    const h1 = new Set(t1.output.items.map((i) => i.householdId));
    const h2 = new Set(t2.output.items.map((i) => i.householdId));
    assert.equal(h1.size, 1);
    assert.deepEqual([...h1], [...h2]);
  });

  it('(h) device change requires explicit revoke; after revoke+rebind the new identity executes', async () => {
    bindings.bindSession('s03a-dev', HOST_A);
    const HOST_A2 = { ...HOST_A, label: 'A2', actorId: 'dev-device-1b', deviceId: 'dev-device-1b' };
    let mismatch = null;
    try {
      bindings.bindSession('s03a-dev', HOST_A2);
    } catch (err) {
      mismatch = err;
    }
    assert.ok(mismatch, 'device change without revoke must throw');
    assert.equal(mismatch.code, 'host_binding_mismatch');
    bindings.revokeSession('s03a-dev');
    bindings.bindSession('s03a-dev', HOST_A2);
    assert.equal(bindings.getBinding('s03a-dev').host.deviceId, 'dev-device-1b');
    const accounts = await tools.list_accounts.execute({}, synthCtx('s03a-dev'));
    assert.equal(accounts.output.total, 2);
  });

  it('(i) restart: sqlite sessions persist but bindings do not; re-bind restores identical totals', async () => {
    const facadeA = env.facadeFor(HOST_A);
    bindings.bindSession('s03a-pre', HOST_A);
    const before = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx('s03a-pre'));
    const s = await facadeA.createSession('spike03a-restart');
    // Auto-bound on create: the real session resolves immediately.
    const viaReal = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(s.id));
    assert.deepEqual(viaReal.output, SUMMARY_A_JUNE);

    await env.close();
    env = await gw.createTedEnvironment({ identity: 'c' });
    bindings = env.bindings;
    // Simulate process restart: in-memory bindings are gone, sqlite rows stay.
    bindings.clearAll();
    const facadeA2 = env.facadeFor(HOST_A);
    const reopened = await facadeA2.getSession(s.id);
    assert.equal(reopened.id, s.id, 'session row survives gateway restart via sqlite');

    const r1 = await capture(tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(s.id)));
    assert.equal(r1.ok, false);
    assert.equal(codeOf(r1.error), 'host_context_required');

    bindings.bindSession(s.id, HOST_A);
    const afterRestart = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(s.id));
    assert.deepEqual(afterRestart.output, before.output);
    await facadeA2.removeSession(s.id);
    assert.equal(bindings.getBinding(s.id).revoked, true, 'removeSession revokes the binding');
  });

  it('(j) timeout fails as tool.timeout with retry OK; callIDs are turns, not identities', async () => {
    bindings.bindSession('s03a-tmo', HOST_A);
    const r1 = await capture(
      tools.list_accounts.execute({}, synthCtx('s03a-tmo', { callID: 'call-03a-slow' }), { delayMs: 2000, timeoutMs: 400 }),
    );
    assert.equal(r1.ok, false);
    assert.equal(codeOf(r1.error), 'tool.timeout');
    // Immediate retry without delay succeeds on the same session.
    const retry = await tools.list_accounts.execute({}, synthCtx('s03a-tmo', { callID: 'call-03a-retry' }));
    assert.equal(retry.output.total, 2);
    // Two distinct callIDs on one session both resolve (turns share the binding).
    const c1 = await tools.list_accounts.execute({}, synthCtx('s03a-tmo', { callID: 'call-03a-x1' }));
    const c2 = await tools.list_accounts.execute({}, synthCtx('s03a-tmo', { callID: 'call-03a-x2' }));
    assert.equal(c1.output.total, 2);
    assert.equal(c2.output.total, 2);
    // A callID string used AS a sessionID resolves nothing (callIDs are not identities).
    const r2 = await capture(tools.list_accounts.execute({}, synthCtx('call-03a-x1')));
    assert.equal(r2.ok, false);
    assert.equal(codeOf(r2.error), 'host_context_required');
    // Aborted signal fail-closes before any transport call.
    const controller = new AbortController();
    controller.abort();
    const r3 = await capture(
      tools.list_accounts.execute({}, { ...synthCtx('s03a-tmo'), signal: controller.signal }),
    );
    assert.equal(r3.ok, false);
    assert.equal(codeOf(r3.error), 'tool.cancelled');
  });

  it('(r1) failed remove does not revoke the binding', async () => {
    const facadeA = env.facadeFor(HOST_A);
    // Bind a sessionID with NO sqlite row behind it: oc.session.remove must
    // fail (NOTFOUND) and the binding must survive unrevoked.
    bindings.bindSession('ses_nonexistent_xxx', HOST_A);
    const r = await capture(facadeA.removeSession('ses_nonexistent_xxx'));
    assert.equal(r.ok, false, 'removing an unknown session must fail');
    const binding = bindings.getBinding('ses_nonexistent_xxx');
    assert.ok(binding, 'binding record survives the failed remove');
    assert.equal(binding.revoked, false, 'failed remove must NOT revoke the binding');
  });

  it('(r2) abort mid-flight cancels with tool.cancelled; immediate retry OK', async () => {
    bindings.bindSession('s03a-r2', HOST_A);
    const controller = new AbortController();
    const pending = tools.get_month_summary.execute(
      { yearMonth: '2026-06' },
      { ...synthCtx('s03a-r2'), signal: controller.signal },
      { delayMs: 2000 },
    );
    setTimeout(() => controller.abort(), 100);
    const r = await capture(pending);
    assert.equal(r.ok, false, 'aborted mid-flight call must reject');
    assert.equal(codeOf(r.error), 'tool.cancelled');
    // Immediate retry without signal/delay returns exact A totals.
    const retry = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx('s03a-r2'));
    assert.deepEqual(retry.output, SUMMARY_A_JUNE);
  });

  it('(r3) cross-identity remove blocked: A cannot remove B\'s session', async () => {
    const facadeA = env.facadeFor(HOST_A);
    const facadeB = env.facadeFor(HOST_B);
    const sB = await facadeB.createSession('spike03a-r3');
    assert.equal(bindings.getBinding(sB.id).host.household, 'HOUSEHOLD_B');
    // A attempts the remove: must fail WITHOUT removing or revoking.
    const r = await capture(facadeA.removeSession(sB.id));
    assert.equal(r.ok, false, 'cross-identity remove must fail');
    assert.equal(r.error && r.error.code, 'host_binding_mismatch');
    // Session row still gettable via B; binding still valid (native execute).
    const reopened = await facadeB.getSession(sB.id);
    assert.equal(reopened.id, sB.id, 'session row survives the blocked remove');
    const accounts = await tools.list_accounts.execute({}, synthCtx(sB.id));
    assert.equal(accounts.output.total, 1);
    assert.equal(accounts.output.items[0].name, 'Bradesco');
    // Owner remove succeeds and revokes the binding.
    await facadeB.removeSession(sB.id);
    assert.equal(bindings.getBinding(sB.id).revoked, true, 'owner remove revokes the binding');
  });

  it('(r4) abort listener does not leak across transport calls', async () => {
    const { callFinance } = await import('../bootstrap/finance-transport.mjs');
    function countingSignal(aborted = false) {
      const listeners = new Set();
      let adds = 0;
      return {
        adds: () => adds,
        count: () => listeners.size,
        signal: {
          get aborted() { return aborted; },
          addEventListener: (_t, fn) => { adds += 1; listeners.add(fn); },
          removeEventListener: (_t, fn) => { listeners.delete(fn); },
        },
      };
    }
    // Pre-aborted: rejects tool.cancelled WITHOUT registering any listener.
    const pre = countingSignal(true);
    const r0 = await capture(callFinance({ route: '/accounts', host: HOST_A, signal: pre.signal }));
    assert.equal(r0.ok, false);
    assert.equal(r0.error && r0.error.code, 'tool.cancelled');
    assert.equal(pre.adds(), 0, 'pre-spawn abort must not register a listener');
    // Success path with a live (never-aborted) signal: resolves + listener removed.
    const live = countingSignal(false);
    const res = await callFinance({ route: '/accounts', host: HOST_A, signal: live.signal });
    assert.ok(res && typeof res.statusCode === 'number');
    assert.equal(res.statusCode, 200);
    assert.equal(live.count(), 0, 'success path must remove the abort listener');
    // Structural (sync spawn-throw is not behaviorally reachable — spawn only
    // throws synchronously on invalid args): the spawn catch MUST remove the
    // listener so no handler leaks on that path either.
    const src = fs.readFileSync(path.join(BOOT, 'finance-transport.mjs'), 'utf8');
    const spawnIdx = src.indexOf('child = spawn(');
    assert.ok(spawnIdx >= 0, 'spawn site found');
    const catchIdx = src.indexOf('} catch', spawnIdx);
    assert.ok(catchIdx >= 0, 'spawn catch found');
    assert.ok(
      src.slice(catchIdx, catchIdx + 800).includes('removeEventListener'),
      'spawn catch must remove the abort listener (no leak on sync spawn throw)',
    );
  });

  it('(k) facade surface unchanged: exact 7 keys, frozen, no admin/identity surface', async () => {
    const facade = env.facadeFor(HOST_A);
    assert.deepEqual(Object.keys(facade).sort(), [
      'createSession',
      'getSession',
      'get_month_summary',
      'listCatalogs',
      'listSessions',
      'list_accounts',
      'removeSession',
    ]);
    for (const key of ['shell', 'prompt', 'edit', 'call', 'mcp', 'subagent', 'tool', 'config', 'host', 'token', 'bindings']) {
      assert.equal(facade[key], undefined, `${key} not exposed on the facade`);
    }
    assert.equal(Object.isFrozen(facade), true);
  });

  it('(l) no tokens leak through bound-execute results or binding errors', async () => {
    await capture(tools.list_accounts.execute({}, synthCtx('s03a-never-bound-l')));
    await capture(tools.list_accounts.execute({}, synthCtx('s03a-rev')));
    await capture(tools.list_accounts.execute({}, synthCtx('s03a-exp')));
    assert.ok(errorTexts.length > 0, 'binding failures were captured');
    for (const text of [...errorTexts, ...successTexts]) {
      for (const secret of SECRET_SUBSTRINGS) {
        assert.ok(!text.includes(secret), `leaked ${secret} in: ${text.slice(0, 200)}`);
      }
    }
  });
});
