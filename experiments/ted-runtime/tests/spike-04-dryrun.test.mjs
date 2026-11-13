// SPIKE 04 dryrun test — deterministic, NO inference, NO cost.
//
// cwd: experiments/ted-runtime/bootstrap. TED_HOME_ROOT=.. (points at
// experiments/ted-runtime), so isolation homes + reports stay in-spike.
//   node --test ../tests/spike-04-dryrun.test.mjs
//
// (a) oracles: frozen values re-validated through the REAL deterministic
//     path (callFinance -> bridge -> buildTestApp + standard seed) for
//     A/B x {accounts, 2026-06, 2026-05, 2025-06} — 8 cases, zero LLM.
// (b) DRYRUN journey executes the oracle coverage via runDryrunJourney
//     (no session.prompt), writes a sanitized per-journey trace, zero secrets.
// (c) LIVE locks without TED_04_LIVE=1 (unit gate + CLI exit 2, no boot).
// (d) sanitization: scrub redacts A/B tokens + injected secret; assert
//     refuses leaking traces; user-role JSON is never result evidence.
// (e) isolation A/B: household-scoped bodies, forbidden arg keys rejected,
//     session slots split on host change / freshSession (J06-B + restart).
// (f) contracts: TOOL_DEFS shapes, validateToolArgs, buildTurnRecord,
//     parseTurnSpec/parseJourneyArgs, read-only allowlist (exact names).
// (g) verdict semantics: understanding / execution / response grade
//     INDEPENDENTLY (no silent coupling, no phrase routing — gradeTurn never
//     sees turn text).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = path.join(TED, 'bootstrap');

process.env.TED_HOME_ROOT = process.env.TED_HOME_ROOT || TED;

const SECRET_RES = [/dev-token-\d/, /boom-token/, /not-a-real-token/];
function scanSecrets(s) {
  return SECRET_RES.filter((re) => { re.lastIndex = 0; return re.test(s); }).map((re) => re.source);
}

describe('spike-04 dryrun (no live, no inference)', () => {
  let runner;
  let oracles;
  let transport;
  let tools;
  before(async () => {
    runner = await import(pathToFileURL(path.join(BOOT, 'run-04-journey.mjs')).href);
    oracles = await import(pathToFileURL(path.join(BOOT, 'spike-04-oracles.mjs')).href);
    transport = await import(pathToFileURL(path.join(BOOT, 'finance-transport.mjs')).href);
    tools = await import(pathToFileURL(path.join(BOOT, 'ted-finance-tools.mjs')).href);
  });

  it('(a) oracles match the REAL deterministic path (8 cases, no LLM)', async () => {
    const A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
    const B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };
    const cases = [
      ['A', A, '2026-06'], ['A', A, '2026-05'], ['A', A, '2025-06'],
      ['B', B, '2026-06'], ['B', B, '2026-05'], ['B', B, '2025-06'],
    ];
    for (const [label, host, ym] of cases) {
      const r = await transport.callFinance({ route: `/dashboard/month-summary?yearMonth=${ym}`, method: 'GET', host, timeoutMs: 120000 });
      assert.equal(r.statusCode, 200, `${label} ${ym} status`);
      const check = oracles.matchSummary(r.body, oracles.oracleSummary(label, ym));
      assert.equal(check.ok, true, `${label} ${ym} oracle match: ${JSON.stringify(check.details)}`);
    }
    const aAcc = await transport.callFinance({ route: '/accounts', method: 'GET', host: A, timeoutMs: 120000 });
    assert.equal(aAcc.statusCode, 200);
    const aCheck = oracles.matchAccounts(aAcc.body, oracles.oracleAccounts('A'));
    assert.equal(aCheck.ok, true, `A accounts oracle match: ${JSON.stringify(aCheck.details)}`);
    assert.ok(!JSON.stringify(aAcc.body).includes('dev-token-1'), 'no token in A body');

    const bAcc = await transport.callFinance({ route: '/accounts', method: 'GET', host: B, timeoutMs: 120000 });
    assert.equal(bAcc.statusCode, 200);
    const bCheck = oracles.matchAccounts(bAcc.body, oracles.oracleAccounts('B'));
    assert.equal(bCheck.ok, true, `B accounts oracle match: ${JSON.stringify(bCheck.details)}`);

    // Pinned exact numbers (provenance: seed.ts standard, apurado 2026-10-31).
    assert.deepEqual(
      { ...oracles.oracleSummary('A', '2026-06') },
      { yearMonth: '2026-06', incomeCents: 1200000, expenseCents: 288050, balanceCents: 911950, transactionCount: 4 },
    );
    assert.deepEqual(
      { ...oracles.oracleSummary('B', '2026-06') },
      { yearMonth: '2026-06', incomeCents: 0, expenseCents: 20000, balanceCents: -20000, transactionCount: 1 },
    );
    assert.deepEqual(oracles.oracleAccounts('A').items.map((x) => [x.name, x.balanceCents]), [['Itaú', 100000], ['Nubank', 50000]]);
    assert.deepEqual(oracles.oracleAccounts('B').items.map((x) => [x.name, x.balanceCents]), [['Bradesco', 99999]]);
  });

  it('(b) DRYRUN journey covers oracles with zero prompt and zero secrets', async () => {
    const { trace, output } = await runner.runDryrunJourney({ journeyId: 'J01' });
    assert.equal(trace.sessionPromptCalled, false);
    assert.equal(trace.spike, '04');
    assert.equal(trace.journeyId, 'J01');
    assert.equal(trace.turns.length, 8);
    for (const t of trace.turns) {
      assert.equal(t.verdict.execution.status, 'pass', `turn ${t.index} execution: ${JSON.stringify(t.verdict.execution)}`);
      assert.equal(t.verdict.understanding.status, 'pass', `turn ${t.index} understanding`);
      assert.equal(t.failures.length, 0);
    }
    assert.equal(trace.summary.executedPass, 8);
    assert.equal(output.executedPass, 8);
    assert.equal(scanSecrets(JSON.stringify(trace)).length, 0);
    assert.equal(scanSecrets(JSON.stringify(output)).length, 0);
    const file = path.join(TED, 'reports', 'SPIKE_04_TRACE_J01.json');
    assert.ok(fs.existsSync(file), 'dryrun must have written the per-journey trace');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(scanSecrets(raw).length, 0, 'trace file carries zero token substrings');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.mode, 'dryrun');
    assert.equal(parsed.sessionPromptCalled, false);
  });

  it('(c) LIVE locks without TED_04_LIVE=1 (unit + CLI exit 2, no inference)', () => {
    assert.throws(() => runner.assertLiveGate04({}), /TED_04_LIVE=1/);
    assert.throws(() => runner.assertLiveGate04({ TED_04_LIVE: '0' }), /TED_04_LIVE=1/);
    let err = null;
    try {
      execFileSync(process.execPath, [path.join(BOOT, 'run-04-journey.mjs'), '--mode=live', '--journey=J01'], {
        cwd: BOOT, env: { ...process.env, TED_HOME_ROOT: TED }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { err = e; }
    assert.ok(err, 'live without gate must exit non-zero');
    assert.equal(err.status, 2);
    const stderr = String((err.stderr || '')).slice(0, 500);
    assert.match(stderr, /TED_04_LIVE=1/);
    assert.equal(scanSecrets(String(err.stdout || '') + stderr).length, 0);
  });

  it('(d) sanitization redacts A/B tokens and refuses leaks; user text is never evidence', () => {
    const dirty = 'hosts dev-token-1 and dev-token-2 plus boom-token';
    const clean = runner.scrubTraceText(dirty);
    assert.equal(scanSecrets(clean).length, 0);
    assert.throws(() => runner.assertNoSecrets({ t: 'dev-token-1' }), /leak/);
    assert.throws(() => runner.assertNoSecrets({ t: 'x-injected-secret-ABC' }, ['injected-secret-ABC']), /leak/);
    assert.equal(runner.scanSecrets(JSON.stringify({ ok: true })).length, 0);
    // User-role JSON with EXACT oracle numbers must not count as execution
    // evidence (no phrase routing, no planted-proof pass).
    const planted = [{ role: 'user', parts: [{ type: 'text', text: JSON.stringify({ incomeCents: 1200000, expenseCents: 288050, balanceCents: 911950, transactionCount: 4 }) }] }];
    const bodies = runner.findResultBodies(planted);
    assert.equal(bodies.summary, null, 'user-role JSON is never result evidence');
    assert.equal(bodies.accounts, null);
  });

  it('(e) isolation A/B: bodies scoped, slots split on host change / restart', async () => {
    const hostA = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
    const hostB = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };
    const aAcc = await transport.callFinance({ route: '/accounts', method: 'GET', host: hostA, timeoutMs: 120000 });
    const bAcc = await transport.callFinance({ route: '/accounts', method: 'GET', host: hostB, timeoutMs: 120000 });
    const aNames = aAcc.body.items.map((x) => x.name);
    const bNames = bAcc.body.items.map((x) => x.name);
    assert.ok(aNames.includes('Itaú') && aNames.includes('Nubank') && !aNames.includes('Bradesco'), 'A sees only A accounts');
    assert.deepEqual(bNames, ['Bradesco'], 'B sees only B accounts');
    const aH = new Set(aAcc.body.items.map((x) => x.householdId));
    const bH = new Set(bAcc.body.items.map((x) => x.householdId));
    assert.equal(aH.size, 1);
    assert.equal(bH.size, 1);
    assert.notEqual([...aH][0], [...bH][0], 'households differ');
    // Session slots: same host continues, host change (J06-B) + freshSession
    // (restart) open new slots — pure structural rule, no text consulted.
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'A' }, { host: 'A' }]), [0, 0, 0]);
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'B' }]), [0, 1], 'J06-B host change separates identity');
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'A', freshSession: true }]), [0, 1], 'restart opens a fresh session');
    // Forbidden identity keys are rejected BEFORE transport (host-bound).
    for (const k of ['actorId', 'workspaceId', 'token', 'deviceId', 'intentionId']) {
      assert.throws(() => tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06', [k]: 'x' }), /forbidden|host-bound/);
    }
  });

  it('(f) contracts: tool defs, args, turn records, CLI parsing, read-only allowlist', () => {
    assert.deepEqual([...runner.READ_TOOLS].sort(), ['get_month_summary', 'list_accounts']);
    assert.equal(runner.isReadOnlyTool('get_month_summary'), true);
    assert.equal(runner.isReadOnlyTool('list_accounts'), true);
    assert.equal(runner.isReadOnlyTool('shell'), false);
    assert.equal(runner.isReadOnlyTool('transfer_money'), false, 'no write tool exists on this path');
    for (const def of tools.TOOL_DEFS) {
      assert.ok(def.output && typeof def.output === 'object', `${def.name} declares output schema (prompt-loop requirement)`);
    }
    assert.throws(() => tools.validateToolArgs('get_month_summary', {}), /yearMonth/);
    assert.throws(() => tools.validateToolArgs('list_accounts', { kind: 1 }), /kind/);
    assert.throws(() => tools.validateToolArgs('nope', {}), /unknown/);
    assert.throws(() => tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06', extra: 1 }), /unknown arg/);
    const rec = runner.buildTurnRecord({ index: 0, text: 'hello', host: 'A', sessionSlot: 0, model: { providerID: 'opencode-go', id: 'x' } });
    assert.equal(rec.host, 'A');
    assert.throws(() => runner.buildTurnRecord({ index: 0, text: '', host: 'A', sessionSlot: 0, model: { providerID: 'p', id: 'm' } }), /non-empty/);
    assert.throws(() => runner.buildTurnRecord({ index: 0, text: 't', host: 'C', sessionSlot: 0, model: { providerID: 'p', id: 'm' } }), /host must be A or B/);
    assert.throws(() => runner.buildTurnRecord({ index: 0, text: 't', host: 'A', sessionSlot: 0, model: { providerID: 'p', id: 'm' }, expectTools: ['shell'] }), /non-readonly/);
    assert.deepEqual(runner.parseTurnSpec('A:oi'), { text: 'oi', host: 'A', freshSession: false });
    assert.deepEqual(runner.parseTurnSpec('B!:recomeçar'), { text: 'recomeçar', host: 'B', freshSession: true });
    const parsed = runner.parseJourneyArgs(['--mode=dryrun', '--journey=J06B', '--turn', 'A:um', '--turn=B:dois']);
    assert.equal(parsed.mode, 'dryrun');
    assert.equal(parsed.journeyId, 'J06B');
    assert.deepEqual(parsed.turns.map((t) => t.host), ['A', 'B']);
    assert.throws(() => runner.parseJourneyArgs(['--mode=dryrun', '--token=x']), /refused/);
    assert.throws(() => runner.parseJourneyArgs(['--mode=nonsense']), /usage/);
    assert.equal(runner.sanitizeJourneyId('../../etc'), 'ETC');
    assert.ok(runner.tracePathFor('J01').endsWith('SPIKE_04_TRACE_J01.json'));
  });

  it('(g) verdict semantics: understanding / execution / response are independent', () => {
    // Selection ok + execution failed + response failed stay separable.
    const v1 = runner.gradeTurn({ observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [], executedOk: false, executedReason: 'summary mismatch', respondedOk: false, respondedReason: 'unanswered' });
    assert.equal(v1.understanding.status, 'pass');
    assert.equal(v1.execution.status, 'fail');
    assert.equal(v1.response.status, 'fail');
    // Wrong selection can coexist with clean execution (axes never collapse).
    const v2 = runner.gradeTurn({ observedNames: ['list_accounts'], expectedTools: ['get_month_summary'], foreign: [], executedOk: true, executedReason: 'ok', respondedOk: true, respondedReason: 'answered' });
    assert.equal(v2.understanding.status, 'fail', 'missing expected tool fails understanding even when execution ran');
    assert.equal(v2.execution.status, 'pass');
    assert.equal(v2.response.status, 'pass');
    // Foreign (write-like) selection fails understanding loudly.
    const v3 = runner.gradeTurn({ observedNames: ['get_month_summary', 'shell'], expectedTools: ['get_month_summary'], foreign: ['shell'], executedOk: true, executedReason: 'ok', respondedOk: true, respondedReason: 'answered' });
    assert.equal(v3.understanding.status, 'fail');
    assert.match(v3.understanding.reason, /shell/);
    // Null evidences stay not-exercised (dryrun response is never faked).
    const v4 = runner.gradeTurn({ observedNames: ['list_accounts'], expectedTools: ['list_accounts'], foreign: [], executedOk: true, executedReason: 'oracle match', respondedOk: null, respondedReason: 'no prompt in dryrun' });
    assert.equal(v4.response.status, 'not-exercised');
  });

  it('(h) LIMIT 03B PASS: config denies + post-observation abort, no pre-execution hook', async () => {
    const plugin = await import(pathToFileURL(path.join(BOOT, 'plugins', 'ted-finance', 'index.mjs')).href);
    // P1 hook removed: no deny-by-default exports remain on the plugin.
    assert.equal(plugin.READ_TOOL_ALLOWLIST, undefined, 'READ_TOOL_ALLOWLIST must be gone');
    assert.equal(typeof plugin.isToolAllowed, 'undefined', 'isToolAllowed must be gone');
    assert.equal(typeof plugin.assertToolAllowed, 'undefined', 'assertToolAllowed must be gone');
    assert.equal(typeof plugin.enforceAllowlistBeforeExecute, 'undefined', 'hook handler must be gone');
    assert.equal(typeof plugin.buildExecute, 'function', 'execute-closure contract preserved');
    // Runner documents the restored 03B limit: no hook, known limitation, no regex.
    assert.match(runner.PRE_EXECUTION_ENFORCEMENT.hook, /none|removed/i, 'hook layer must record removal');
    assert.match(runner.PRE_EXECUTION_ENFORCEMENT.config, /boot03B denies/, 'config-denies layer retained');
    assert.match(runner.PRE_EXECUTION_ENFORCEMENT.runner, /abort on first foreign observation/, 'post-observation abort retained');
    assert.match(runner.PRE_EXECUTION_ENFORCEMENT.limitation, /known limitation/, 'limitation must be documented');
    assert.match(runner.PRE_EXECUTION_ENFORCEMENT.limitation, /post-observation/, 'abort path must be post-observation');
    assert.match(runner.PRE_EXECUTION_ENFORCEMENT.limitation, /not regex/, 'must disclaim regex over code');
    // Config half of the limit: 03B denies intact (single provider allow, admin denies, finance untouched).
    const turn03b = await import(pathToFileURL(path.join(BOOT, 'run-03b-turn.mjs')).href);
    const cfg = turn03b.build03BConfig();
    const denies = cfg.policies.filter((p) => p.effect === 'deny').map((p) => p.action + ':' + p.resource);
    for (const d of ['tool.use:shell:*', 'tool.use:edit:*', 'tool.use:write:*', 'tool.use:subagent:*', 'provider.use:*']) {
      assert.ok(denies.includes(d), 'missing deny ' + d);
    }
    const flat = JSON.stringify(cfg);
    assert.ok(!flat.includes('list_accounts') && !flat.includes('get_month_summary'), 'finance tools must not be denied');
    // Runner half of the limit: pre-prompt fail-closed on non-readonly expects.
    assert.throws(() => runner.buildTurnRecord({ index: 0, text: 't', host: 'A', sessionSlot: 0, model: { providerID: 'p', id: 'm' }, expectTools: ['shell'] }), /non-readonly/);
    // Post-observation half: foreign selection fails understanding loudly (abort path).
    const v = runner.gradeTurn({ observedNames: ['get_month_summary', 'shell'], expectedTools: ['get_month_summary'], foreign: ['shell'], executedOk: false, executedReason: 'aborted', respondedOk: false, respondedReason: 'aborted' });
    assert.equal(v.understanding.status, 'fail');
  });
  it('(i) P2 gradeTurn exact-set: expected + extra read-only fails understanding', () => {
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary', 'list_accounts'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: true, executedReason: 'ok', respondedOk: true, respondedReason: 'answered',
    });
    assert.equal(v.understanding.status, 'fail', 'read-only extra must fail exact-set understanding');
    assert.match(v.understanding.reason, /extra/);
    // Exact match still passes.
    const ok = runner.gradeTurn({
      observedNames: ['get_month_summary'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: true, executedReason: 'ok', respondedOk: true, respondedReason: 'answered',
    });
    assert.equal(ok.understanding.status, 'pass');
  });

  it('(j) P2 matchAccounts requires expected household per account (A/B isolation)', () => {
    const oracleA = oracles.oracleAccounts('A');
    const idA = oracles.HOUSEHOLD_IDS.A;
    const idB = oracles.HOUSEHOLD_IDS.B;
    const bodyA = { total: 2, items: oracleA.items.map((x) => ({ ...x })) };
    assert.equal(oracles.matchAccounts(bodyA, oracleA, idA).ok, true, 'A body with A household passes');
    assert.equal(oracles.matchAccounts(bodyA, oracleA, idB).ok, false, 'A body under B household must fail');
    assert.equal(oracles.matchAccounts(bodyA, oracleA).ok, true, 'oracle-derived scope still passes without explicit param');
    // Cross-household row: name+balance match but wrong householdId fails.
    const crossed = { total: 2, items: [{ name: 'Itaú', balanceCents: 100000, householdId: idB }, { name: 'Nubank', balanceCents: 50000, householdId: idA }] };
    const crossCheck = oracles.matchAccounts(crossed, oracleA, idA);
    assert.equal(crossCheck.ok, false, 'cross-household row must fail');
    assert.ok((crossCheck.details.foreignHousehold || []).length > 0, 'details must name the foreign household row');
  });
});
