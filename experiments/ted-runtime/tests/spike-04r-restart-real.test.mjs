// Spike 04R restart proof: TWO REAL OS processes + persisted session + re-bind.
//
// Mirrors spike-03a-restart-real.test.mjs (T2 pattern) for the spike-04
// deterministic read path. NO LLM, NO inference, NO cost, NO runner changes.
//
//   proc1: boot identity '04' (.ted-home-04/, already gitignored), create ONE
//     execute ONE observable finance call (get_month_summary A 2026-06),
//     print the session id, EXIT (process ends => in-memory bindings are REALLY
//     gone — no clearAll stand-in).
//   proc2: boot a FRESH process on the SAME db path, then:
//     1. facadeA.getSession(SID) OK (sqlite row persists across processes),
//     2. native-plugin execute WITHOUT re-bind fails host_context_required
//        (binding is process memory — it did not survive, sqlite did),
//     3. bindSession(SID, HOST_A) OK, re-execute get_month_summary + list_accounts,
//        validate EXACT spike-04 oracles (matchSummary/matchAccounts) in THIS
//        parent process,
//     4. cross-host: bindSession(SID, HOST_B) => host_binding_mismatch (A owns
//        it); B session created via facadeB stays Bradesco-only; A cannot claim
//        B's session either,
//     5. owner removes both sessions (no .ted-home-04 pollution).
//
// Strategy decision (same as 03A-T2): re-bind autenticado após restart — the
// host re-establishes its binding explicitly after reopening; no shared store,
// no new persistence for bindings in this spike.
//
// What does NOT count as proof (documented): calling bindings.clearAll() in
// the SAME process and re-binding only simulates memory loss — the registry is
// process-global, so the simulation is honest but weaker. THIS file uses two
// real OS processes, so no simulation is involved.
//
// Deterministic: no sleeps, no retries, no inference. Finance math stays with
// the REAL handlers through the tsx bridge; oracles are the frozen spike-04
// expectations (never presumed schema).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(HERE, '..', 'bootstrap');
const TED = path.join(HERE, '..');

// Synthetic identities (same store as spike-02/03a/04). Never real credentials.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };

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
  env = await gw.createTedEnvironment({ identity: '04' });
  const facadeA = env.facadeFor(HOST_A);
  const s = await facadeA.createSession('spike04r-restart-real-A');
  const summary = await facadeA.get_month_summary({ yearMonth: '2026-06' });
  if (!summary || summary.incomeCents !== 1200000) throw new Error('proc1 observable call unexpected: ' + JSON.stringify(summary));
  console.log('SPIKE_04R_RESULT=' + JSON.stringify({ sid: s.id }));
} finally {
  if (env) await env.close().catch(() => {});
}
`;

const CHILD_REOPEN = CHILD_PRELUDE + `
const SID = process.env.SPIKE_SID;
if (!SID) throw new Error('proc2 requires SPIKE_SID');
let env = null;
try {
  env = await gw.createTedEnvironment({ identity: '04' });
  const bindings = env.bindings;
  const facadeA = env.facadeFor(HOST_A);
  const facadeB = env.facadeFor(HOST_B);
  const tools = await captureTools();
  const steps = {};
  const reopened = await facadeA.getSession(SID);
  steps.getAfterRestart = Boolean(reopened && reopened.id === SID);
  try {
    await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(SID, 'msg-04r-nobind', 'call-04r-nobind'));
    steps.noBindCode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.noBindCode = (e && e.metadata && e.metadata.code) || (e && e.code) || 'UNKNOWN';
  }
  bindings.bindSession(SID, HOST_A);
  const after = await tools.get_month_summary.execute({ yearMonth: '2026-06' }, synthCtx(SID, 'msg-04r-rebind', 'call-04r-rebind'));
  steps.rebindSummary = after.output;
  const acc = await tools.list_accounts.execute({}, synthCtx(SID, 'msg-04r-acc', 'call-04r-acc'));
  steps.rebindAccounts = acc.output;
  try {
    bindings.bindSession(SID, HOST_B);
    steps.crossBindOnACode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.crossBindOnACode = (e && e.code) || 'UNKNOWN';
  }
  const sB = await facadeB.createSession('spike04r-restart-real-B');
  steps.sbid = sB.id;
  try {
    bindings.bindSession(sB.id, HOST_A);
    steps.crossBindCode = 'UNEXPECTED_OK';
  } catch (e) {
    steps.crossBindCode = (e && e.code) || 'UNKNOWN';
  }
  const bAcc = await tools.list_accounts.execute({}, synthCtx(sB.id, 'msg-04r-b', 'call-04r-b'));
  steps.bAccounts = bAcc.output;
  await facadeA.removeSession(SID);
  await facadeB.removeSession(sB.id);
  steps.cleanup = true;
  console.log('SPIKE_04R_RESULT=' + JSON.stringify(steps));
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
  const line = String(output).split('\n').find((l) => l.startsWith('SPIKE_04R_RESULT='));
  assert.ok(line, 'child must print SPIKE_04R_RESULT marker; stdout tail: ' + String(output).slice(-2000));
  return JSON.parse(line.slice('SPIKE_04R_RESULT='.length));
}

describe('spike-04R restart: two real processes, re-bind restores scope (no LLM)', () => {
  it('(04R) proc1 creates+executes, proc2 reopens, re-binds, oracles match, cleans up', async () => {
    const { pathToFileURL } = await import('node:url');
    const oracles = await import(pathToFileURL(path.join(BOOT, 'spike-04-oracles.mjs')).href);

    const out1 = runChild(CHILD_CREATE, {});
    const created = parseResult(out1);
    assert.ok(typeof created.sid === 'string' && created.sid.length > 0, 'proc1 returns a session id');

    const out2 = runChild(CHILD_REOPEN, { SPIKE_SID: created.sid });
    const steps = parseResult(out2);

    assert.equal(steps.getAfterRestart, true, 'sqlite row survives across real processes');
    assert.equal(steps.noBindCode, 'host_context_required', 'no binding in the fresh process — execute blocked');
    const sumCheck = oracles.matchSummary(steps.rebindSummary, oracles.oracleSummary('A', '2026-06'));
    assert.equal(sumCheck.ok, true, 're-bind restores exact A 2026-06 oracle: ' + JSON.stringify(sumCheck.details));
    const accCheck = oracles.matchAccounts(steps.rebindAccounts, oracles.oracleAccounts('A'), oracles.HOUSEHOLD_IDS.A);
    assert.equal(accCheck.ok, true, 're-bind restores exact A accounts oracle: ' + JSON.stringify(accCheck.details));
    assert.equal(steps.crossBindOnACode, 'host_binding_mismatch', 'B cannot claim the A session after re-bind');
    assert.equal(steps.crossBindCode, 'host_binding_mismatch', 'A cannot claim the B session in the fresh process');
    const bCheck = oracles.matchAccounts(steps.bAccounts, oracles.oracleAccounts('B'), oracles.HOUSEHOLD_IDS.B);
    assert.equal(bCheck.ok, true, 'B still resolves Bradesco-only oracle: ' + JSON.stringify(bCheck.details));
    assert.equal(steps.cleanup, true, 'owner removed both sessions (no db pollution)');
  });
});
