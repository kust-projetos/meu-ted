// SPIKE 04R evaluator-negative proof — GREEN contract (post WS1 fix).
//
// SCOPE: experiments/ted-runtime only. Pure unit test: NO inference, NO cost,
// NO transport, NO trace writes. Imports ONLY pure functions (gradeTurn,
// responseGroundsOracle, matchSummary, matchAccounts, oracleSummary,
// oracleAccounts, validateToolArgs) — never runDryrunJourney/runLiveJourney,
// never touches apps/*, .env, production, or existing traces.
//
// Run from: experiments/ted-runtime/bootstrap
//   node --test ../tests/spike-04r-evaluator-neg.test.mjs
//
// CONTRACT (fixed runner, run-04-journey.mjs live branch):
//   (a) turn WITHOUT expects -> execution/response 'incomplete'
//       ('no oracle attached — evidence incomplete, not pass'), never pass;
//   (b) expects attached but a result body missing / apiResults empty ->
//       'incomplete', never pass;
//   (c) oracle mismatch (numbers, yearMonth, household) -> fail;
//   (d) response without executed oracle values (echo of the question) ->
//       response fail (grounding: distinctive numbers/names must appear).
// Expects are never derived from text — only the turn's explicit expects.
//
// Architectural false-positive under test (frozen evidence, read-only):
//   reports/SPIKE_04_TRACE_J07.json t0/t1 + J06 t0/t1 showed:
//   selectedTools=[get_month_summary|list_accounts], apiResults={}, response
//   == question text (echo, zero oracle values), verdict pass on all axes via
//   the OLD live branch (no-expects => executedOk stayed true when calls>0;
//   respondedOk = response.length > 0, so the echo passed).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = path.join(TED, 'bootstrap');

process.env.TED_HOME_ROOT = process.env.TED_HOME_ROOT || TED;

describe('spike-04R evaluator negatives (GREEN: runner must not pass errors)', () => {
  let runner;
  let oracles;
  let tools;
  before(async () => {
    runner = await import(pathToFileURL(path.join(BOOT, 'run-04-journey.mjs')).href);
    oracles = await import(pathToFileURL(path.join(BOOT, 'spike-04-oracles.mjs')).href);
    tools = await import(pathToFileURL(path.join(BOOT, 'ted-finance-tools.mjs')).href);
  });

  it('(1) no-oracle turn grades incomplete on execution AND response, never pass', () => {
    // Live contract (a): no expects => both axes 'incomplete'.
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary'],
      expectedTools: null,
      foreign: [],
      executedOk: 'incomplete',
      executedReason: 'no oracle attached — evidence incomplete, not pass (tools ran (get_month_summary))',
      respondedOk: 'incomplete',
      respondedReason: 'no oracle attached — response ungrounded, not pass',
    });
    assert.equal(v.execution.status, 'incomplete');
    assert.equal(v.response.status, 'incomplete');
    // Grounding with no expects has nothing to check => null (incomplete).
    const g = runner.responseGroundsOracle('Quanto gastei em junho de 2026?', {});
    assert.equal(g.grounded, null);
    // gradeTurn still maps the legacy booleans (dryrun path untouched).
    const legacy = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'ok', respondedOk: null, respondedReason: 'no prompt in dryrun',
    });
    assert.equal(legacy.execution.status, 'pass');
    assert.equal(legacy.response.status, 'not-exercised');
  });

  it('(2) wrong month (observed 2026-04 vs oracle 2026-05) fails on both paths', () => {
    // 2a — runner path: a wrong-month turn carries an oracle expectation
    // that the observed body cannot satisfy => execution fail.
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: false,
      executedReason: 'summary mismatch {"yearMonth":"expected 2026-05, got 2026-04"}',
      respondedOk: false,
      respondedReason: 'request unanswered (no fabrication credit without execution)',
    });
    assert.equal(v.execution.status, 'fail', 'wrong-month execution must fail');
    assert.equal(v.response.status, 'fail');
    // 2b — oracle path: matchSummary pins yearMonth, so a body from the
    // WRONG month with equal numbers mismatches. Same zeros, other month:
    const actualWrongMonth = { ...oracles.oracleSummary('A', '2026-05'), yearMonth: '2026-04' };
    const check = oracles.matchSummary(actualWrongMonth, oracles.oracleSummary('A', '2026-05'));
    assert.equal(check.ok, false, 'different yearMonth must fail even with equal numbers');
    assert.match(JSON.stringify(check.details), /2026-05/);
    // Missing yearMonth on the observed body also fails when expected pins one.
    const noYm = { incomeCents: 0, expenseCents: 0, balanceCents: 0, transactionCount: 0 };
    assert.equal(oracles.matchSummary(noYm, oracles.oracleSummary('A', '2026-05')).ok, false);
    // Same month + same numbers still passes (no regression on exact match).
    assert.equal(oracles.matchSummary(
      { ...oracles.oracleSummary('A', '2026-06') }, oracles.oracleSummary('A', '2026-06')).ok, true);
  });

  it('(3) empty apiResults {} grades incomplete, never pass', () => {
    // Live contract (b): expects attached but no result body observed.
    const apiOut = {};
    assert.deepEqual(apiOut, {}, 'precondition: no result bodies observed');
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: 'incomplete',
      executedReason: 'no summary result body observed — evidence incomplete',
      respondedOk: 'incomplete',
      respondedReason: 'no result body to ground response — evidence incomplete',
    });
    assert.equal(v.execution.status, 'incomplete');
    assert.equal(v.response.status, 'incomplete');
  });

  it('(4) echo response (text == question, zero oracle values) fails grounding', () => {
    // Frozen J07-t1 evidence: response == question text verbatim.
    const question = 'Quanto gastei em junho de 2026?';
    const response = question; // echo, as recorded in SPIKE_04_TRACE_J07.json t0
    const oracle = oracles.oracleSummary('A', '2026-06');
    assert.ok(!response.includes(String(oracle.expenseCents)), 'precondition: echo carries no oracle value');
    assert.ok(!response.includes(String(oracle.incomeCents)), 'precondition: echo carries no oracle value');
    const g = runner.responseGroundsOracle(response, { expectSummary: oracle });
    assert.equal(g.grounded, false, 'echo must not ground');
    assert.ok(g.missing.length > 0);
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: true,
      executedReason: 'summary matches oracle',
      respondedOk: false,
      respondedReason: `${g.reason} (echo/fabrication, not pass)`,
    });
    assert.equal(v.response.status, 'fail');
    // A response carrying the executed values grounds.
    const grounded = runner.responseGroundsOracle(
      `Em junho de 2026: receitas ${oracle.incomeCents}, despesas ${oracle.expenseCents}, saldo ${oracle.balanceCents}.`,
      { expectSummary: oracle },
    );
    assert.equal(grounded.grounded, true);
  });

  it('(5) POSITIVE CONTROLS (kept): mutated summary + cross-household accounts fail', () => {
    const mutated = { ...oracles.oracleSummary('A', '2026-06'), expenseCents: 288051 };
    const mCheck = oracles.matchSummary(mutated, oracles.oracleSummary('A', '2026-06'));
    assert.equal(mCheck.ok, false, '288050 -> 288051 must mismatch');
    // Anchor from dryrun case (j): cross-household row fails.
    const idA = oracles.HOUSEHOLD_IDS.A;
    const idB = oracles.HOUSEHOLD_IDS.B;
    const oracleA = oracles.oracleAccounts('A');
    const crossed = {
      total: 2,
      items: [
        { name: 'Itaú', balanceCents: 100000, householdId: idB },
        { name: 'Nubank', balanceCents: 50000, householdId: idA },
      ],
    };
    const crossCheck = oracles.matchAccounts(crossed, oracleA, idA);
    assert.equal(crossCheck.ok, false, 'cross-household row must fail');
  });

  it('(6) POSITIVE CONTROL (kept): extra read-only tool fails exact-set understanding', () => {
    // Anchor from dryrun case (i).
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary', 'list_accounts'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: true,
      executedReason: 'ok',
      respondedOk: true,
      respondedReason: 'answered',
    });
    assert.equal(v.understanding.status, 'fail', 'read-only extra must fail exact-set understanding');
  });

  it('(7) MUTATION (i): yearMonth swapped with identical numbers fails', () => {
    // Same body numbers, relabelled period: must not verify a wrong period.
    const relabelled = { ...oracles.oracleSummary('A', '2026-05'), yearMonth: '2026-06' };
    assert.equal(oracles.matchSummary(relabelled, oracles.oracleSummary('A', '2026-05')).ok, false);
    assert.equal(oracles.matchSummary(relabelled, oracles.oracleSummary('A', '2026-06')).ok, false,
      'zeros of 2026-05 must not verify the 2026-06 oracle (1200000/288050/911950/4)');
  });

  it('(8) MUTATION (ii): single-cent value drift 288050 -> 288051 fails', () => {
    const drifted = { ...oracles.oracleSummary('A', '2026-06'), expenseCents: 288051 };
    const check = oracles.matchSummary(drifted, oracles.oracleSummary('A', '2026-06'));
    assert.equal(check.ok, false);
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: false, executedReason: 'summary mismatch',
      respondedOk: false, respondedReason: 'request unanswered (no fabrication credit without execution)',
    });
    assert.equal(v.execution.status, 'fail');
    assert.equal(v.response.status, 'fail');
  });

  it('(9) MUTATION (iii): household swap fails even with matching names/balances', () => {
    const idA = oracles.HOUSEHOLD_IDS.A;
    const idB = oracles.HOUSEHOLD_IDS.B;
    const oracleB = oracles.oracleAccounts('B');
    const swapped = {
      total: 1,
      items: [{ name: 'Bradesco', balanceCents: 99999, householdId: idA }],
    };
    assert.equal(oracles.matchAccounts(swapped, oracleB, idB).ok, false,
      'B body under A household must fail');
    assert.equal(oracles.matchAccounts(
      { total: 1, items: [{ name: 'Bradesco', balanceCents: 99999, householdId: idB }] },
      oracleB, idB).ok, true, 'correct household still passes');
  });

  it('(10) MUTATION (iv): extra read-only tool fails understanding even with oracle match', () => {
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary', 'list_accounts'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: true,
      executedReason: 'summary matches oracle',
      respondedOk: true,
      respondedReason: 'turn answered with executed values',
    });
    assert.equal(v.understanding.status, 'fail', 'exact-set: extra read-only tool fails comprehension');
    assert.match(v.understanding.reason, /extra/);
    // Exact selection still passes alongside.
    const ok = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'summary matches oracle',
      respondedOk: true, respondedReason: 'turn answered with executed values',
    });
    assert.equal(ok.understanding.status, 'pass');
  });

  it('(11) MUTATION (v): fluent response without oracle values fails grounding', () => {
    const oracle = oracles.oracleSummary('A', '2026-06');
    const fluent = 'Seu resumo de junho está pronto, todos os valores foram conferidos.';
    assert.ok(!fluent.includes(String(oracle.expenseCents)));
    const g = runner.responseGroundsOracle(fluent, { expectSummary: oracle });
    assert.equal(g.grounded, false, 'fluent prose without executed values must not ground');
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'summary matches oracle',
      respondedOk: false, respondedReason: `${g.reason} (echo/fabrication, not pass)`,
    });
    assert.equal(v.response.status, 'fail');
  });

  it('(12) seven axes of §2 each have a separate check, none silently coupled', () => {
    // (1) comprehension: exact-set selection, independent of execution.
    const sel = runner.gradeTurn({
      observedNames: ['list_accounts'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'ok', respondedOk: true, respondedReason: 'answered',
    });
    assert.equal(sel.understanding.status, 'fail');
    assert.equal(sel.execution.status, 'pass', 'axes stay independent');
    // (2) selection detail — args: yearMonth required + exact, identity keys refused.
    assert.throws(() => tools.validateToolArgs('get_month_summary', {}), /yearMonth/);
    assert.throws(() => tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06', token: 'x' }), /forbidden|host-bound/);
    // (3) identity: host/slot binding is structural (slot splits on host
    // change / restart); the slot-mismatch abort is enforced pre-prompt in
    // runLiveJourney and recorded in the verdict reason, not re-decided here.
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'B' }]), [0, 1]);
    assert.deepEqual(runner.assignSessions([{ host: 'A' }, { host: 'A', freshSession: true }]), [0, 1]);
    // (4) backend result: bodies match frozen oracles (yearMonth pinned).
    assert.equal(oracles.matchSummary(
      { ...oracles.oracleSummary('B', '2026-06') }, oracles.oracleSummary('B', '2026-06')).ok, true);
    // (5) response: grounding is a separate check from execution.
    const g = runner.responseGroundsOracle('nada de valores aqui', { expectSummary: oracles.oracleSummary('A', '2026-06') });
    assert.equal(g.grounded, false);
    // (6) absence of undue tools: foreign fails understanding loudly.
    const f = runner.gradeTurn({
      observedNames: ['get_month_summary', 'shell'], expectedTools: ['get_month_summary'], foreign: ['shell'],
      executedOk: false, executedReason: 'aborted', respondedOk: false, respondedReason: 'aborted',
    });
    assert.equal(f.understanding.status, 'fail');
    assert.match(f.understanding.reason, /shell/);
    // (7) oracle shape guard preserved (not-an-object still fails, not passes).
    assert.deepEqual(oracles.matchSummary(null, oracles.oracleSummary('A', '2026-06')),
      { ok: false, details: { shape: 'not-an-object' } });
  });

  it('(13) P1-1(a) repeated calls fail exact-set understanding (no silent dedup)', () => {
    // observed [get_month_summary, get_month_summary] vs expects
    // [get_month_summary]: expects carry unique names, any repetition is an
    // extra -> understanding fail.
    const v = runner.gradeTurn({
      observedNames: ['get_month_summary', 'get_month_summary'],
      expectedTools: ['get_month_summary'],
      foreign: [],
      executedOk: true, executedReason: 'ok',
      respondedOk: true, respondedReason: 'answered',
    });
    assert.equal(v.understanding.status, 'fail', 'repeated call must fail exact-set understanding');
    assert.match(v.understanding.reason, /duplicate/i);
    // Single exact selection still passes (no regression).
    const ok = runner.gradeTurn({
      observedNames: ['get_month_summary'], expectedTools: ['get_month_summary'], foreign: [],
      executedOk: true, executedReason: 'ok',
      respondedOk: true, respondedReason: 'answered',
    });
    assert.equal(ok.understanding.status, 'pass');
  });

  it('(14) P1-1(b) args of EVERY call validated, reasons cite the index', () => {
    // Two calls with different args (2026-05 + 2026-04) vs expected 2026-05:
    // the second period mismatches -> fail, reason cites call 1.
    const mixed = runner.checkAllCallsArgs(
      [
        { name: 'get_month_summary', args: { yearMonth: '2026-05' } },
        { name: 'get_month_summary', args: { yearMonth: '2026-04' } },
      ],
      { expectSummaryYearMonth: '2026-05' },
    );
    assert.equal(mixed.ok, false, 'second call with another period must fail');
    assert.ok(mixed.reasons.some((r) => /call 1/.test(r) && /2026-04/.test(r)));
    // Uniform correct args pass.
    const uniform = runner.checkAllCallsArgs(
      [{ name: 'get_month_summary', args: { yearMonth: '2026-05' } }],
      { expectSummaryYearMonth: '2026-05' },
    );
    assert.equal(uniform.ok, true);
    // A structurally invalid SECOND call fails even when the first is valid.
    const badSecond = runner.checkAllCallsArgs(
      [
        { name: 'get_month_summary', args: { yearMonth: '2026-05' } },
        { name: 'get_month_summary', args: { yearMonth: '2026-05', token: 'x' } },
      ],
      { expectSummaryYearMonth: '2026-05' },
    );
    assert.equal(badSecond.ok, false, 'forbidden key in any call must fail');
    assert.ok(badSecond.reasons.some((r) => /call 1/.test(r)));
  });

  it('(15) P1-1(c) divergent same-type bodies surface instead of first-body-wins', () => {
    const a = { ...oracles.oracleSummary('A', '2026-06') };
    const b = { ...oracles.oracleSummary('A', '2026-06'), expenseCents: 288051 };
    const msgs = [
      { role: 'assistant', parts: [{ type: 'text', text: JSON.stringify(a) }] },
      { role: 'assistant', parts: [{ type: 'text', text: JSON.stringify(b) }] },
    ];
    const bodies = runner.findResultBodies(msgs);
    assert.ok(bodies.summary, 'first body preserved as evidence');
    assert.equal(bodies.summaryDiverged, true, 'divergent repeats must be flagged');
    assert.equal(bodies.summaryCount, 2);
    // Identical repeats are NOT divergence (no false positive on echo).
    const same = runner.findResultBodies([
      { role: 'assistant', parts: [{ type: 'text', text: JSON.stringify(a) }] },
      { role: 'assistant', parts: [{ type: 'text', text: JSON.stringify({ ...a }) }] },
    ]);
    assert.equal(same.summaryDiverged, false);
  });

  it('(16) P1-2 BRL formatting grounds (cents via digit-normalized response)', () => {
    const oracle = oracles.oracleSummary('A', '2026-06'); // 1200000/288050/911950
    // Full BRL response grounds the full oracle (raw cents absent by design).
    const full = 'Em junho: receita R$ 12.000,00, gastos R$ 2.880,50, saldo R$ 9.119,50.';
    assert.ok(!full.includes(String(1200000)), 'precondition: raw cents absent');
    assert.ok(!full.includes(String(288050)), 'precondition: raw cents absent');
    const g = runner.responseGroundsOracle(full, { expectSummary: oracle });
    assert.equal(g.grounded, true, 'BRL formatting must ground the executed oracle');
    // Focused single-value expects (task shorthand): each BRL value grounds.
    assert.equal(
      runner.responseGroundsOracle('Gastos R$ 2.880,50 em junho', { expectSummary: { expenseCents: 288050 } }).grounded,
      true,
    );
    assert.equal(
      runner.responseGroundsOracle('Receita R$ 12.000,00', { expectSummary: { incomeCents: 1200000 } }).grounded,
      true,
    );
    // Echo of the question still fails (no oracle value, raw or formatted).
    const echo = runner.responseGroundsOracle('Quanto gastei em junho de 2026?', { expectSummary: oracle });
    assert.equal(echo.grounded, false, 'echo without oracle values must not ground');
  });
});
