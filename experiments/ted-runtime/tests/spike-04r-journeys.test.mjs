// SPIKE 04R journeys J06 + J07-A/B — deterministic closure (NO inference, NO cost).
//
// SCOPE: experiments/ted-runtime only. NEVER touches apps/*, .env, production.
// Imports ONLY the runner's pure helpers + deterministic transport path
// (runDryrunJourney, gradeTurn, responseGroundsOracle, assignSessions,
// matchSummary, matchAccounts, oracleSummary, oracleAccounts,
// HOUSEHOLD_IDS, validateToolArgs via ted-finance-tools, callFinance via
// finance-transport). NEVER session.prompt, NEVER TED_04_LIVE.
//
// Run from: experiments/ted-runtime/bootstrap
//   node --test ../tests/spike-04r-journeys.test.mjs
//
// Frozen live evidence (read-only, preserved):
//   reports/SPIKE_04_TRACE_J06.json t0/t1 + J07.json t0/t1 showed
//   selectedTools=[list_accounts|get_month_summary], apiResults={},
//   response == question text (echo). Under the OLD evaluator this passed;
//   under the corrected evaluator (neg test 3: empty apiResults => incomplete)
//   the same evidence grades `incomplete`, NEVER pass.
//
// ---- J07-B ORACLE (single-turn "E em maio?", session really new, no anchor) ----
// With NO prior context there is no established period to inherit. The correct
// behavior is to ask for clarification, OR to apply a product default that is
// EXPLICITLY established in this repo. No such default is established anywhere
// in experiments/ted-runtime (no default-month rule, no router, no phrase
// mapping — by design). Therefore the oracle for J07-B is CLARIFICATION:
// no financial tool call verifies a "maio" answer from a bare follow-up.
// Any get_month_summary({2026-04}) presented as the answer to "maio" FAILS
// matchSummary against the 2026-05 oracle (yearMonth pinned); an echo of the
// question carries no executed oracle values (grounding never true). Live proof
// with a real model stays PENDING — no new inference is authorized in this
// task, and none is executed here.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = path.join(TED, 'bootstrap');

process.env.TED_HOME_ROOT = process.env.TED_HOME_ROOT || TED;

const SECRET_RES = [/dev-token-\d/, /boom-token/, /not-a-real-token/];
function scanSecrets(s) {
  return SECRET_RES.filter((re) => { re.lastIndex = 0; return re.test(s); }).map((re) => re.source);
}

describe('spike-04R journeys J06 + J07-A/B (deterministic, no live)', () => {
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

  it('J06-CONTENT: A/B isolation with content via runDryrunJourney (no live)', async () => {
    const { trace, output } = await runner.runDryrunJourney({
      journeyId: 'J06R',
      turns: [
        { text: 'dryrun: A accounts (oracle)', host: 'A', expectTools: ['list_accounts'], expectAccounts: { host: 'A' } },
        { text: 'dryrun: B accounts (oracle)', host: 'B', expectTools: ['list_accounts'], expectAccounts: { host: 'B' } },
      ],
    });
    assert.equal(trace.sessionPromptCalled, false, 'dryrun never prompts');
    assert.equal(trace.turns.length, 2);
    for (const t of trace.turns) {
      assert.equal(t.verdict.execution.status, 'pass', `turn ${t.index} execution: ${JSON.stringify(t.verdict.execution)}`);
      assert.equal(t.verdict.understanding.status, 'pass', `turn ${t.index} understanding`);
      assert.equal(t.failures.length, 0);
    }
    assert.equal(output.executedPass, 2);
    assert.equal(scanSecrets(JSON.stringify(trace)).length, 0);
    // Structural split: host change opens a new slot (J06-B shape).
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'B' }]), [0, 1]);
    assert.deepEqual(trace.sessionSlots, [0, 1]);

    // Real deterministic bodies (same plumbing the runner uses, no inference).
    const aAcc = await transport.callFinance({ route: '/accounts', method: 'GET', host: oracles.HOST_A, timeoutMs: 120000 });
    const bAcc = await transport.callFinance({ route: '/accounts', method: 'GET', host: oracles.HOST_B, timeoutMs: 120000 });
    assert.equal(aAcc.statusCode, 200);
    assert.equal(bAcc.statusCode, 200);
    const aJson = JSON.stringify(aAcc.body);
    const bJson = JSON.stringify(bAcc.body);
    // Body A carries Itaú 100000 + Nubank 50000, never Bradesco/99999.
    assert.ok(aJson.includes('Itaú') && aJson.includes('100000'), 'A body carries Itaú 100000');
    assert.ok(aJson.includes('Nubank') && aJson.includes('50000'), 'A body carries Nubank 50000');
    assert.ok(!aJson.includes('Bradesco') && !aJson.includes('99999'), 'A body carries no B values');
    // Body B carries Bradesco 99999, never Itaú/Nubank.
    assert.ok(bJson.includes('Bradesco') && bJson.includes('99999'), 'B body carries Bradesco 99999');
    assert.ok(!bJson.includes('Itaú') && !bJson.includes('Nubank'), 'B body carries no A names');
    // Own-oracle match passes; crossed match fails (isolation, not just names).
    const idA = oracles.HOUSEHOLD_IDS.A;
    const idB = oracles.HOUSEHOLD_IDS.B;
    assert.equal(oracles.matchAccounts(aAcc.body, oracles.oracleAccounts('A'), idA).ok, true);
    assert.equal(oracles.matchAccounts(bAcc.body, oracles.oracleAccounts('B'), idB).ok, true);
    assert.equal(oracles.matchAccounts(bAcc.body, oracles.oracleAccounts('A'), idA).ok, false, 'B body vs A oracle must fail');
    assert.equal(oracles.matchAccounts(aAcc.body, oracles.oracleAccounts('B'), idB).ok, false, 'A body vs B oracle must fail');

    // Preserved live evidence had apiResults {} + echo: under the corrected
    // evaluator that grades `incomplete` (neg test 3), never PASS.
    const legacy = runner.gradeTurn({
      observedNames: ['list_accounts'], expectedTools: ['list_accounts'], foreign: [],
      executedOk: 'incomplete', executedReason: 'no accounts result body observed — evidence incomplete',
      respondedOk: 'incomplete', respondedReason: 'no result body to ground response — evidence incomplete',
    });
    assert.equal(legacy.execution.status, 'incomplete', 'live J06 apiResults {} is incomplete, not pass');
    assert.equal(legacy.response.status, 'incomplete');
  });

  it('J07-A: two-turn context resolves 2026-06 then 2026-05 (no 2026-04)', async () => {
    const { trace, output } = await runner.runDryrunJourney({
      journeyId: 'J07AR',
      turns: [
        { text: 'dryrun: A 2026-06 (oracle)', host: 'A', expectTools: ['get_month_summary'], expectSummary: { host: 'A', yearMonth: '2026-06' } },
        { text: 'dryrun: A 2026-05 (oracle)', host: 'A', expectTools: ['get_month_summary'], expectSummary: { host: 'A', yearMonth: '2026-05' } },
      ],
    });
    assert.equal(trace.sessionPromptCalled, false);
    assert.equal(trace.turns.length, 2);
    for (const t of trace.turns) {
      assert.equal(t.verdict.execution.status, 'pass', `turn ${t.index} execution: ${JSON.stringify(t.verdict.execution)}`);
      assert.equal(t.verdict.understanding.status, 'pass');
    }
    assert.equal(output.executedPass, 2);
    // Same session continues (no host change, no restart).
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'A' }]), [0, 0]);
    assert.deepEqual(trace.sessionSlots, [0, 0]);
    // yearMonth exact on both turns; second turn is 2026-05, not 2026-04.
    assert.equal(trace.turns[0].toolArgs.get_month_summary.yearMonth, '2026-06');
    assert.equal(trace.turns[0].apiResults.get_month_summary.yearMonth, '2026-06');
    assert.equal(trace.turns[1].toolArgs.get_month_summary.yearMonth, '2026-05');
    assert.equal(trace.turns[1].apiResults.get_month_summary.yearMonth, '2026-05');
    assert.notEqual(trace.turns[1].toolArgs.get_month_summary.yearMonth, '2026-04');
    assert.equal(scanSecrets(JSON.stringify(trace)).length, 0);

    // Mutation: a 2026-04 body answering for 2026-05 FAILS against the oracle.
    const mutated = { ...oracles.oracleSummary('A', '2026-05'), yearMonth: '2026-04' };
    const check = oracles.matchSummary(mutated, oracles.oracleSummary('A', '2026-05'));
    assert.equal(check.ok, false, '2026-04 body must not verify the 2026-05 oracle');
    assert.match(JSON.stringify(check.details), /2026-05/);
  });

  it('J07-B: fresh session oracle is CLARIFICATION (no default established)', () => {
    // (a) freshSession opens a new slot after prior context.
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'A', freshSession: true }]), [0, 1]);
    assert.deepEqual(runner.assignSessions([{ host: 'A', freshSession: true }]), [0], 'first slot even when flagged fresh');
    // (b) get_month_summary({2026-04}) as the answer to "maio" FAILS vs 2026-05.
    const asApril = { ...oracles.oracleSummary('A', '2026-05'), yearMonth: '2026-04' };
    assert.equal(oracles.matchSummary(asApril, oracles.oracleSummary('A', '2026-05')).ok, false);
    // (c) echo of the bare follow-up never grounds (2026-05 is an all-zero
    // month: no distinctive value exists, so grounding is null = incomplete,
    // never pass; a distinctive month echo is an outright fail).
    const gBare = runner.responseGroundsOracle('E em maio?', { expectSummary: oracles.oracleSummary('A', '2026-05') });
    assert.notEqual(gBare.grounded, true, 'bare echo must never ground');
    assert.equal(gBare.grounded, null, 'all-zero month has nothing distinctive: incomplete, never pass');
    const gEcho = runner.responseGroundsOracle('Quanto gastei em junho de 2026?', { expectSummary: oracles.oracleSummary('A', '2026-06') });
    assert.equal(gEcho.grounded, false, 'echo of the question fails grounding');
    // (d) live proof with a real model stays PENDING: no new inference is
    // authorized here, and none was executed (gate untouched).
    assert.notEqual(process.env.TED_04_LIVE, '1', 'no live inference executed in this deterministic test');
  });

  it('seven axes §2: positive controls pass separately (J06-A + J07-A-t1)', () => {
    // J06-A positive: exact tool + real execution + response with oracle values.
    const oracleA = oracles.oracleAccounts('A');
    const respA = 'Contas: Itaú 100000, Nubank 50000.';
    const gA = runner.responseGroundsOracle(respA, { expectAccounts: oracleA });
    assert.equal(gA.grounded, true, `J06-A grounding: ${gA.reason}`);
    const vA = runner.gradeTurn({
      observedNames: ['list_accounts'], expectedTools: ['list_accounts'], foreign: [],
      executedOk: true, executedReason: 'accounts match oracle',
      respondedOk: true, respondedReason: 'turn answered with executed values',
    });
    assert.equal(vA.understanding.status, 'pass');
    assert.equal(vA.execution.status, 'pass');
    assert.equal(vA.response.status, 'pass');
    // J07-A-t1 positive: exact tool + real execution + response with values.
    const oracleS = oracles.oracleSummary('A', '2026-06');
    const respS = `Em junho de 2026: receitas ${oracleS.incomeCents}, despesas ${oracleS.expenseCents}, saldo ${oracleS.balanceCents}.`;
    const gS = runner.responseGroundsOracle(respS, { expectSummary: oracleS });
    assert.equal(gS.grounded, true, `J07-A-t1 grounding: ${gS.reason}`);
    const vS = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'summary matches oracle',
      respondedOk: true, respondedReason: 'turn answered with executed values',
    });
    assert.equal(vS.understanding.status, 'pass');
    assert.equal(vS.execution.status, 'pass');
    assert.equal(vS.response.status, 'pass');
    // Axis (7) shape guard: non-object never verifies.
    assert.deepEqual(oracles.matchSummary(null, oracleS), { ok: false, details: { shape: 'not-an-object' } });
    // Axis (2) args structural: yearMonth required, identity keys refused.
    assert.throws(() => tools.validateToolArgs('get_month_summary', {}), /yearMonth/);
    assert.throws(() => tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06', token: 'x' }), /forbidden|host-bound/);
    // Axis (3) identity structural: slot binding splits on host change.
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'B' }]), [0, 1]);
  });

  it('seven axes §2: one-axis mutations fail only their axis', () => {
    const oracleS = oracles.oracleSummary('A', '2026-06');
    const oracleA = oracles.oracleAccounts('A');
    const idA = oracles.HOUSEHOLD_IDS.A;
    const idB = oracles.HOUSEHOLD_IDS.B;

    // (1) wrong tool: understanding fails, execution/response untouched.
    const wrongTool = runner.gradeTurn({
      observedNames: ['list_accounts'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'summary matches oracle',
      respondedOk: true, respondedReason: 'turn answered with executed values',
    });
    assert.equal(wrongTool.understanding.status, 'fail', 'wrong tool fails comprehension');
    assert.equal(wrongTool.execution.status, 'pass', 'axes stay independent');
    assert.equal(wrongTool.response.status, 'pass');

    // (2) wrong arg: yearMonth drift fails the backend/args check.
    const argDrift = oracles.matchSummary(
      { ...oracleS, yearMonth: '2026-05' }, oracleS);
    assert.equal(argDrift.ok, false, 'yearMonth arg drift must fail');
    assert.throws(() => tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06', extra: 1 }), /unknown arg/);

    // (3) wrong household: B household under the A oracle fails.
    const swapped = { total: 1, items: [{ name: 'Bradesco', balanceCents: 99999, householdId: idA }] };
    assert.equal(oracles.matchAccounts(swapped, oracles.oracleAccounts('B'), idB).ok, false, 'household swap must fail');
    const crossExec = runner.gradeTurn({
      observedNames: ['list_accounts'], expectedTools: ['list_accounts'], foreign: [],
      executedOk: false, executedReason: 'accounts mismatch (household scope)',
      respondedOk: false, respondedReason: 'request unanswered (no fabrication credit without execution)',
    });
    assert.equal(crossExec.execution.status, 'fail');
    assert.equal(crossExec.understanding.status, 'pass', 'selection was exact; household is the execution axis');

    // (4) mutated body: single-cent drift fails the backend result.
    const drifted = { ...oracleS, expenseCents: 288051 };
    assert.equal(oracles.matchSummary(drifted, oracleS).ok, false, '288050 -> 288051 must mismatch');
    const bodyFail = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: false, executedReason: 'summary mismatch',
      respondedOk: false, respondedReason: 'request unanswered (no fabrication credit without execution)',
    });
    assert.equal(bodyFail.execution.status, 'fail');
    assert.equal(bodyFail.understanding.status, 'pass', 'selection exact; body is the execution axis');

    // (5) valueless response: fluent prose without oracle values fails grounding.
    const fluent = 'Seu resumo de junho está pronto, todos os valores foram conferidos.';
    const gFluent = runner.responseGroundsOracle(fluent, { expectSummary: oracleS });
    assert.equal(gFluent.grounded, false, 'fluent prose without values must not ground');
    const respFail = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'summary matches oracle',
      respondedOk: false, respondedReason: `${gFluent.reason} (echo/fabrication, not pass)`,
    });
    assert.equal(respFail.response.status, 'fail');
    assert.equal(respFail.execution.status, 'pass', 'execution held; response is the failed axis');

    // (6) foreign shell: understanding fails loudly, never silent.
    const foreign = runner.gradeTurn({
      observedNames: ['get_month_summary', 'shell'], expectedTools: ['get_month_summary'], foreign: ['shell'],
      executedOk: true, executedReason: 'summary matches oracle',
      respondedOk: true, respondedReason: 'turn answered with executed values',
    });
    assert.equal(foreign.understanding.status, 'fail');
    assert.match(foreign.understanding.reason, /shell/);
    void oracleA;
  });
});
