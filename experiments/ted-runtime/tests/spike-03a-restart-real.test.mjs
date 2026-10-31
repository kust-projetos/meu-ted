// Spike 03A remediation T2: restart proof across TWO REAL OS processes.
//
// Replaces the in-process restart simulation (same-process recreate +
// explicit clearAll, which stands in for process memory loss) with two real
// `node` child processes via execFileSync:
//
//   proc1: boot env identity 'c', create a session (auto-bound), verify a
//     native-plugin execute OK, print the session id, exit (process ends,
//     so its in-memory bindings are REALLY gone — no clearAll stand-in).
//   proc2: boot a FRESH process on the SAME db path, then:
//     1. getSession OK (sqlite row persists across processes),
//     2. execute WITHOUT re-bind fails host_context_required (binding is
//        process memory — it did not survive, sqlite did),
//     3. re-bind with host A OK, execute returns exact A June totals,
//     4. A cannot claim B's session (host_binding_mismatch on bind);
//        execute as B still OK (Bradesco-only),
//     5. expired (bindWithTTL negative) and revoked bindings fail with the
//        typed codes in the fresh process,
//     6. owner removes both sessions (no .ted-home-c pollution).
//
// Strategy decision (documented): re-bind autenticado após restart — the host
// re-establishes its binding explicitly after reopening; no shared store, no
// new persistence for bindings in this spike (test (i) keeps the in-process
// variant; this file proves the same contract across real processes).
//
// Deterministic: no sleeps (TTL-negative expiry, like the existing suite).
// Finance math stays with the REAL handlers through the tsx bridge.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(HERE, '..', 'bootstrap');
const TED = path.join(HERE, '..');

// Synthetic identities (same store as spike-02/03a). Never real credentials.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };

const SUMMARY_A_JUNE = {
  yearMonth: '2026-06',
  incomeCents: 1200000,
  expenseCents: 288050,
  balanceCents: 911950,
  transactionCount: 4,
};

// Child prelude: absolute file-URL imports (node -e has no relative base).
// TED_HOME_ROOT is set inside the child from the passed-through env.
const CHILD_PRELUDE = `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.TED_HOME_ROOT = process.env.SPIKE_TED;
const BOOT = process.env.SPIKE_BOOT;
const HOST_A = ${JSON.stringify(HOST_A)};
const HOST_B = ${JSON.stringify(HOST_B)};
const gw = await import(pathToFileURL(path.join(BOOT, 'ted-gateway.mjs')).href);
const pluginMod = await import(pathToFileURL(path.join(BOOT, 'plugins', 'ted-finance', 'index.mjs')).href);
async function captureTools() {
  const tools = {};
  await pluginMod.default.setup({
    tool: {
      transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); },
      list: async () => [],
    },
  });
  return tools;
}
function synthCtx(sessionID, messageID, callID) {
  return { sessionID, agent: 'ted', messageID, id: callID };
}
`;

const CHILD_CREATE = CHILD_PRELUDE + `
let env = null;
try {
  env = await gw.createTedEnvironment({ identity: 'c' });
  const facadeA = env.facadeFor(HOST_A);
  const s = await facadeA.createSession('spike03a-t2-real');
  const tools = await captureTools();
  const out = await tools.list_accounts.execute({}, synthCtx(s.id, 'msg-t2-create', 'call-t2-create'));
  if (!out || !out.output || out.output.total !== 2) throw new Error('proc1 execute unexpected total: ' + JSON.stringify(out && out.output));
  console.log('SPIKE_T2_RESULT=' + JSON.stringify({ sid: s.id }));
} finally {
  if (env) await env.close().catch(() => {});
}
`;

const CHILD_REOPEN = CHILD_PRELUDE + `
const SID = process.env.SPIKE_SID;
if (!SID) throw new Error('proc2 requires SPIKE_SID');
let env = null;
try {
  env = await gw.createTedEnvironment({ identity: 'c' });
  const bindings = env.bindings;
  const facadeA = env.facadeFor(HOST_A);
  const facadeB = env.facadeFor(HOST_B);
  const tools = await captureTools();
  const steps = {};
  const reopened = await facadeA.getSession(SID);
  steps.getAfterRestart = Boolean(reopened && reopened.id === SID);
  try {
    await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(SID, 'msg-t2-nobind', 'call-t2-nobind'));
    steps.noBindCode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.noBindCode = (e && e.metadata && e.metadata.code) || (e && e.code) || 'UNKNOWN';
  }
  bindings.bindSession(SID, HOST_A);
  const after = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(SID, 'msg-t2-rebind', 'call-t2-rebind'));
  steps.rebindSummary = after.output;
  const sB = await facadeB.createSession('spike03a-t2-real-B');
  steps.sbid = sB.id;
  try {
    bindings.bindSession(sB.id, HOST_A);
    steps.crossBindCode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.crossBindCode = (e && e.code) || 'UNKNOWN';
  }
  const bAcc = await tools.list_accounts.execute({}, synthCtx(sB.id, 'msg-t2-b', 'call-t2-b'));
  steps.bTotal = bAcc.output.total;
  steps.bName = bAcc.output.items[0].name;
  const expID = 'sT2-exp-' + process.pid;
  bindings.bindWithTTL(expID, HOST_A, -1);
  try {
    await tools.list_accounts.execute({}, synthCtx(expID, 'msg-t2-exp', 'call-t2-exp'));
    steps.expCode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.expCode = (e && e.metadata && e.metadata.code) || (e && e.code) || 'UNKNOWN';
  }
  const revID = 'sT2-rev-' + process.pid;
  bindings.bindSession(revID, HOST_A);
  bindings.revokeSession(revID);
  try {
    await tools.list_accounts.execute({}, synthCtx(revID, 'msg-t2-rev', 'call-t2-rev'));
    steps.revCode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.revCode = (e && e.metadata && e.metadata.code) || (e && e.code) || 'UNKNOWN';
  }
  await facadeA.removeSession(SID);
  await facadeB.removeSession(sB.id);
  steps.cleanup = true;
  console.log('SPIKE_T2_RESULT=' + JSON.stringify(steps));
} finally {
  if (env) await env.close().catch(() => {});
}
`;

function runChild(code, extraEnv) {
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: BOOT,
      env: { ...process.env, TED_HOME_ROOT: TED, SPIKE_TED: TED, SPIKE_BOOT: BOOT, ...extraEnv },
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const tail = String((e && e.stderr) || '').slice(-3000);
    throw new Error('child process failed: ' + ((e && e.message) || e) + '\nCHILD_STDERR_TAIL:\n' + tail);
  }
}

function parseResult(output) {
  const line = String(output).split('\n').find((l) => l.startsWith('SPIKE_T2_RESULT='));
  assert.ok(line, 'child must print SPIKE_T2_RESULT marker; stdout tail: ' + String(output).slice(-2000));
  return JSON.parse(line.slice('SPIKE_T2_RESULT='.length));
}

describe('spike-03a T2 restart: two real processes, re-bind restores scope', () => {
  it('(T2) proc1 creates+executes, proc2 reopens, re-binds, and cleans up', () => {
    const out1 = runChild(CHILD_CREATE, {});
    const created = parseResult(out1);
    assert.ok(typeof created.sid === 'string' && created.sid.length > 0, 'proc1 returns a session id');

    const out2 = runChild(CHILD_REOPEN, { SPIKE_SID: created.sid });
    const steps = parseResult(out2);

    assert.equal(steps.getAfterRestart, true, 'sqlite row survives across real processes');
    assert.equal(steps.noBindCode, 'host_context_required', 'no binding in the fresh process — execute blocked');
    assert.deepEqual(steps.rebindSummary, SUMMARY_A_JUNE, 're-bind restores identical A totals');
    assert.equal(steps.crossBindCode, 'host_binding_mismatch', 'A cannot claim the B session in the fresh process');
    assert.equal(steps.bTotal, 1, 'B still resolves Bradesco-only');
    assert.equal(steps.bName, 'Bradesco');
    assert.equal(steps.expCode, 'host_binding_expired', 'expired binding fails typed in the fresh process');
    assert.equal(steps.revCode, 'host_binding_revoked', 'revoked binding fails typed in the fresh process');
    assert.equal(steps.cleanup, true, 'owner removed both sessions (no db pollution)');
  });
});
