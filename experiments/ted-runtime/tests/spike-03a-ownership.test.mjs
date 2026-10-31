// Spike 03A remediation T1: ownership guards on getSession/listSessions.
//
// RED-first: pre-fix, facadeA.getSession(sB) returns B's row and
// facadeA.listSessions() includes B's rows (metadata leak: ids, titles,
// directories). These tests FAIL pre-fix (a success return / a present row
// proves the leak) and go GREEN after the gateway guards.
//
// Contract (pinned here):
//   - getSession on a session bound to a DIFFERENT host throws
//     host_binding_mismatch (nothing returned).
//   - getSession on an UNBOUND id falls through to the SDK: unknown ids fail
//     with the SDK NOTFOUND; a known-but-unbound row (e.g. owner re-get right
//     after a restart, before re-bind) still returns — pinned by test (i) of
//     spike-03a.test.mjs, so this file asserts the passthrough too.
//   - listSessions returns ONLY rows whose binding resolves to the calling
//     facade's host. UNBOUND rows are EXCLUDED by default (explicit decision:
//     never leak another host's ids/titles/directories); revoked/expired
//     bindings resolve-fail and are likewise hidden until an explicit re-bind.
//     Shape-preserving: {data,cursor} keeps its envelope.
//   - listCatalogs().sessions uses the same visibility rule (count+ids only,
//     but ids of another host are still metadata — same helper, no new code).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(HERE, '..', 'bootstrap');
const TED = path.join(HERE, '..');
const requireBoot = createRequire(path.join(BOOT, 'run-identity.mjs'));

process.env.TED_HOME_ROOT = TED;
const { setupIsolation } = requireBoot('./env.cjs');

// Synthetic identities (same store as spike-02/03a). Never real credentials.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };

let gw;
let env;
let bindings;
let facadeA;
let facadeB;
let sA;
let sB;
const errorTexts = [];
const listedTexts = [];

async function capture(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    errorTexts.push(String((error && error.message) || error) + ' ' + JSON.stringify((error && { code: error.code }) || null));
    return { ok: false, error };
  }
}

describe('spike-03a T1 ownership: getSession/listSessions host guards', () => {
  before(async () => {
    setupIsolation('c');
    gw = await import('../bootstrap/ted-gateway.mjs');
    env = await gw.createTedEnvironment({ identity: 'c' });
    bindings = env.bindings;
    facadeA = env.facadeFor(HOST_A);
    facadeB = env.facadeFor(HOST_B);
    // createSession auto-binds each row to its creator facade's host.
    sA = await facadeA.createSession('spike03a-own-A');
    sB = await facadeB.createSession('spike03a-own-B');
  });

  after(async () => {
    try {
      // Tests may have cleared/revoked bindings: fresh owner binds first so
      // the owner removeSession path (same-host) succeeds deterministically.
      try { bindings.bindSession(sA.id, HOST_A); } catch { /* already owned */ }
      try { bindings.bindSession(sB.id, HOST_B); } catch { /* already owned */ }
      await facadeA.removeSession(sA.id).catch(() => {});
      await facadeB.removeSession(sB.id).catch(() => {});
    } finally {
      try { bindings.clearAll(); } catch { /* best effort */ }
      await env.close().catch(() => {});
    }
  });

  it('(T1-a) cross-host getSession throws host_binding_mismatch (nothing returned)', async () => {
    const r = await capture(facadeA.getSession(sB.id));
    assert.equal(r.ok, false, 'cross-host getSession must fail — a returned row proves the metadata leak');
    assert.equal(r.error && r.error.code, 'host_binding_mismatch');
    const r2 = await capture(facadeB.getSession(sA.id));
    assert.equal(r2.ok, false);
    assert.equal(r2.error && r2.error.code, 'host_binding_mismatch');
  });

  it('(T1-b) owner getSession still works for both identities', async () => {
    const a = await facadeA.getSession(sA.id);
    assert.equal(a.id, sA.id);
    const b = await facadeB.getSession(sB.id);
    assert.equal(b.id, sB.id);
  });

  it('(T1-c) listSessions shows only own rows: no B ids/titles/directories for A', async () => {
    const listA = await facadeA.listSessions();
    assert.ok(listA && Array.isArray(listA.data), 'listSessions keeps the {data,cursor} envelope');
    listedTexts.push(JSON.stringify(listA));
    assert.ok(listA.data.some((row) => row.id === sA.id), 'owner row stays visible');
    assert.ok(!listA.data.some((row) => row.id === sB.id), "B row in A's list proves the leak");
    const textA = JSON.stringify(listA);
    assert.ok(!textA.includes(sB.id), 'B session id must not appear in A output');
    assert.ok(!textA.includes('spike03a-own-B'), 'B title must not appear in A output');
    // Symmetric: B sees sB, never sA.
    const listB = await facadeB.listSessions();
    listedTexts.push(JSON.stringify(listB));
    assert.ok(listB.data.some((row) => row.id === sB.id), 'owner row stays visible');
    assert.ok(!listB.data.some((row) => row.id === sA.id), "A row in B's list proves the leak");
  });

  it('(T1-d) unbound rows are excluded by default; re-bind restores visibility', async () => {
    // DECISION (documented): after a restart-equivalent binding loss, listing
    // shows nothing — unbound rows are excluded, never leaked. Re-binding
    // restores visibility. (getSession on a known-but-unbound row still falls
    // through to the SDK — pinned below and by test (i): the owner re-gets
    // the row after restart BEFORE re-binding.)
    bindings.clearAll();
    const listA = await facadeA.listSessions();
    assert.deepEqual(listA.data, [], 'with no bindings, nothing is listed');
    const listB = await facadeB.listSessions();
    assert.deepEqual(listB.data, [], 'with no bindings, nothing is listed (symmetric)');
    // Known-but-unbound row: SDK passthrough (NOT a mismatch, NOT a leak of a
    // binding decision — the row exists in sqlite and no binding claims it).
    const r = await capture(facadeA.getSession(sA.id));
    assert.equal(r.ok, true, 'unbound-but-existing row still re-gets (restart re-open path)');
    assert.equal(r.value.id, sA.id);
    // Re-bind restores the ownership-filtered view.
    bindings.bindSession(sA.id, HOST_A);
    bindings.bindSession(sB.id, HOST_B);
    const listA2 = await facadeA.listSessions();
    assert.ok(listA2.data.some((row) => row.id === sA.id), 're-bind restores owner visibility');
    assert.ok(!listA2.data.some((row) => row.id === sB.id), 're-bind does not leak the other host');
  });

  it('(T1-e) unknown session id fails without leaking (SDK NOTFOUND passthrough)', async () => {
    const r = await capture(facadeA.getSession('ses_nonexistent_xxx'));
    assert.equal(r.ok, false, 'unknown session must fail');
    assert.notEqual(r.error && r.error.code, 'host_binding_mismatch', 'unknown id is NOTFOUND, not a mismatch');
  });

  it('(T1-f) revoked and expired bindings are hidden from list until re-bind', async () => {
    bindings.revokeSession(sA.id);
    const listRev = await facadeA.listSessions();
    assert.ok(!listRev.data.some((row) => row.id === sA.id), 'revoked binding: row hidden');
    bindings.bindSession(sA.id, HOST_A); // fresh bind over the revoked one
    bindings.revokeSession(sA.id);
    bindings.bindWithTTL(sA.id, HOST_A, -1); // already-expired, deterministic
    const listExp = await facadeA.listSessions();
    assert.ok(!listExp.data.some((row) => row.id === sA.id), 'expired binding: row hidden');
    bindings.revokeSession(sA.id);
    bindings.bindSession(sA.id, HOST_A); // fresh re-bind restores visibility
    const listOk = await facadeA.listSessions();
    assert.ok(listOk.data.some((row) => row.id === sA.id), 'fresh re-bind restores visibility');
  });

  it('(T1-g) listCatalogs sessions summary leaks no other-host ids', async () => {
    const catalogs = await facadeA.listCatalogs();
    listedTexts.push(JSON.stringify(catalogs.sessions));
    assert.ok(!catalogs.sessions.ids.includes(sB.id), 'B id must not appear in A catalog sessions');
  });

  it('(T1-h) no tokens leak through guarded reads or their errors', async () => {
    for (const text of [...errorTexts, ...listedTexts]) {
      for (const secret of ['dev-token-1', 'dev-token-2']) {
        assert.ok(!text.includes(secret), `leaked ${secret} in: ${text.slice(0, 200)}`);
      }
    }
  });

  it('(T1-i) unknown list shape fail-closes to empty (nothing leaks, P2)', async () => {
    // No oc.session.list stub seam exists (the SDK is closed over inside the
    // gateway), so the fail-closed rule is pinned directly on the exported
    // pure helper the facade itself uses — same code path, no duplicate logic.
    assert.equal(typeof gw.filterSessionsForHost, 'function', 'gateway must export the ownership filter helper');
    bindings.bindSession(sA.id, HOST_A);
    bindings.bindSession(sB.id, HOST_B);
    const weird = gw.filterSessionsForHost({ weird: 1 }, HOST_A);
    assert.deepEqual(weird, { data: [], cursor: null }, 'unknown shape must yield an empty envelope, never the integral');
    assert.deepEqual(gw.filterSessionsForHost(null, HOST_A), { data: [], cursor: null });
    assert.deepEqual(gw.filterSessionsForHost({ data: 'not-an-array', cursor: null }, HOST_A), { data: [], cursor: null });
    // Real {data,cursor} shape preserved: own row visible, other-host hidden.
    const real = gw.filterSessionsForHost({ data: [{ id: sA.id }, { id: sB.id }], cursor: 'c0' }, HOST_A);
    assert.equal(real.cursor, 'c0');
    assert.ok(real.data.some((r) => r.id === sA.id), 'own row stays visible');
    assert.ok(!real.data.some((r) => r.id === sB.id), 'other-host row stays hidden');
    assert.ok(!JSON.stringify(real).includes(sB.id), 'other-host id absent from output text');
  });
});
