// SPIKE 05L — dryrun harness test (no inference, no cost).
//
// Proves: DRYRUN exits 0 without session.prompt, trace carries no prompt,
// catalog contains the 05L finance tools, and propose via the deterministic
// executor creates a proposal carrying the category resolved via reads.
// NEVER sets TED_05L_LIVE (LIVE gate stays locked); no Postgres, no PWA,
// no Cloudflare, no commit/push.
//
// Run (cwd = experiments/ted-runtime/bootstrap):
//   node --test run-05l-turn.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.TED_HOME_ROOT = path.join(HERE, '..');

const mod = await import('./run-05l-turn.mjs');

describe('spike-05L dryrun harness (no inference)', () => {
  let result = null;

  before(async () => {
    delete process.env.TED_05L_LIVE; // gate locked: dryrun must not infer
  });

  it('dryrun completes with exit-0 semantics (no prompt, all deterministic checks pass)', async () => {
    result = await mod.runDryrun();
    assert.ok(result && result.trace && result.output, 'runDryrun returns {trace, output}');
    const { trace, output } = result;
    assert.equal(trace.spike, '05L');
    assert.equal(trace.mode, 'dryrun');
    assert.equal(trace.sessionPromptCalled, false);
    assert.equal(output.sessionPromptCalled, false);
    assert.equal(trace.deterministicFinance.accounts.ok, true);
    assert.equal(trace.deterministicFinance.categories.ok, true);
    assert.equal(trace.deterministicFinance.propose.ok, true);
    for (const k of ['B01', 'B03', 'B04', 'B05', 'B07']) {
      assert.equal(trace.verdict[k].status, 'pass', `${k} must pass in dryrun`);
    }
  });

  it('trace written to SPIKE_05L_TRACE.json carries zero secrets and no prompt', async () => {
    const file = mod.tracePath();
    assert.ok(fs.existsSync(file), `trace file exists at ${file}`);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('dev-token-'), 'trace carries no token substrings');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.sessionPromptCalled, false);
    assert.equal(parsed.spike, '05L');
  });

  it('catalog contains the 05L finance tools (names only, no values)', async () => {
    const { trace } = result;
    for (const t of mod.FINANCE_TOOLS_05L) {
      assert.ok(trace.effective.financeToolsNative.includes(t), `${t} natively registered`);
    }
    assert.deepEqual([...mod.FINANCE_TOOLS_05L].sort(), ['list_accounts', 'list_categories', 'propose_expense']);
    // Own allowlist: never reuses nor widens the frozen 03B list.
    assert.ok(!mod.FINANCE_TOOLS_05L.includes('get_month_summary'), 'get_month_summary excluded by 05L allowlist decision');
  });

  it('propose carries the category + account resolved via reads (never invented)', async () => {
    const { trace } = result;
    const { resolved, propose } = trace.deterministicFinance;
    assert.ok(resolved.accountId && typeof resolved.accountId === 'string', 'accountId resolved from list_accounts');
    assert.equal(resolved.categoryId, mod.EXPECTED_CATEGORY_MERCADO.id, 'categoryId resolved from list_categories matches Mercado seed row');
    assert.equal(propose.details.normalizedArgs.categoryId, resolved.categoryId);
    assert.equal(propose.details.normalizedArgs.accountId, resolved.accountId);
    assert.equal(propose.details.normalizedArgs.amountCents, mod.EXPECTED_PROPOSE_AMOUNT_CENTS);
  });

  it('dates are dynamic (UTC base) with America/Sao_Paulo divergence documented, never frozen', async () => {
    const { trace } = result;
    assert.match(trace.dates.expectedDateUTC, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const nowY = mod.yesterdayUTC(Date.now());
    const skewY = mod.yesterdayUTC(Date.now() - 180000); // tolerates a UTC-midnight crossing mid-run
    assert.ok(trace.dates.expectedDateUTC === nowY || trace.dates.expectedDateUTC === skewY,
      `expectedDateUTC ${trace.dates.expectedDateUTC} must be dynamic UTC-yesterday (${nowY}/${skewY})`);
    assert.equal(trace.dates.evaluationTz, 'America/Sao_Paulo');
    assert.ok(trace.dates.tzNote.length > 40, 'tz divergence documented');
  });

  it('LIVE gate refuses without TED_05L_LIVE=1 (exit 2, no inference)', async () => {
    delete process.env.TED_05L_LIVE;
    assert.throws(() => mod.assertLiveGate(), (e) => e && e.exitCode === 2);
  });

  it('B01 gate is EXACT-ONLY (no more, no fewer — CSV), not mere presence', async () => {
    const { trace } = result;
    assert.equal(trace.effective.financeToolsExactOnly, true);
    assert.equal(trace.verdict.B01.status, 'pass');
    assert.match(trace.verdict.B01.reason, /EXACT/i);
    // Exact-only is evaluated over the FINANCE SUBSET (TOOL_DEFS names):
    // the full native catalog stays a built-in superset by 2.2.4 design.
    assert.deepEqual([...trace.effective.financeToolsSubset].sort(), ['list_accounts', 'list_categories', 'propose_expense']);
    assert.ok(!trace.effective.financeToolsSubset.includes('get_month_summary'), 'get_month_summary excluded from native finance subset');
  });

  it('dryrun trace documents pre-exec limitation + cost ceiling as residual (no total-prevention claim)', async () => {
    const { trace } = result;
    assert.equal(trace.preExecGate.enforced, false);
    assert.match(trace.preExecGate.reason, /no total pre-execution gate/i);
    assert.match(trace.cost.ceiling, /not a provider/i);
    assert.match(trace.stepsNote, /best-effort post-observation/i);
  });

  after(async () => {
    // Trace file is the harness artifact (reports/, gitignored or spike-local);
    // keep it for Planner inspection — do not delete production data (none touched).
  });
});

describe('spike-05L hardening units (pure, no inference)', () => {
  it('P2: requireBoundHost fail-closes unknown IDs (no SDK fallthrough)', async () => {
    const bindings = await import('./session-bindings.mjs');
    bindings.clearAll();
    assert.throws(() => mod.requireBoundHost('ses-unknown-xyz', mod.HOST_A),
      (e) => e && e.code === 'host_context_required');
  });

  it('P2: requireBoundHost blocks divergent host, allows same host', async () => {
    const bindings = await import('./session-bindings.mjs');
    bindings.clearAll();
    const other = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };
    bindings.bindSession('ses-a1', mod.HOST_A);
    bindings.bindSession('ses-b1', other);
    assert.throws(() => mod.requireBoundHost('ses-b1', mod.HOST_A),
      (e) => e && e.code === 'host_binding_mismatch');
    assert.doesNotThrow(() => mod.requireBoundHost('ses-a1', mod.HOST_A));
    bindings.clearAll();
  });

  it('P1-timeout: promptWithDeadline interrupts on overrun (mock, no inference)', async () => {
    let interrupts = 0;
    const res = await mod.promptWithDeadline({
      promptFn: () => new Promise(() => {}), // never resolves — deadline must fire
      interruptFn: async () => { interrupts += 1; },
      timeoutMs: 20,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.interruptAttempted, true);
    assert.equal(res.interruptOk, true);
    assert.equal(interrupts, 1);
    assert.match(res.error, /prompt-timeout/);
  });

  it('P1-timeout: missing interrupt records unenforceable (never assumed stopped)', async () => {
    const res = await mod.promptWithDeadline({
      promptFn: () => new Promise(() => {}), // never resolves — deadline must fire
      interruptFn: undefined, // no interrupt capability => not confirmable
      timeoutMs: 30,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.interruptAttempted, false);
    assert.equal(res.interruptOk, false);
  });

  it('P1-timeout: fast prompt never interrupts', async () => {
    let interrupts = 0;
    const res = await mod.promptWithDeadline({
      promptFn: async () => 'ok',
      interruptFn: async () => { interrupts += 1; },
      timeoutMs: 500,
    });
    assert.equal(res.timedOut, false);
    assert.equal(interrupts, 0);
    assert.equal(res.error, null);
  });

  it('P1-timeout: hung interrupt never wedges the runner (own 5s deadline, recorded failure)', async () => {
    const t0 = Date.now();
    const res = await mod.promptWithDeadline({
      promptFn: () => new Promise(() => {}), // never resolves — deadline must fire
      interruptFn: () => new Promise(() => {}), // hung interrupt — own deadline must fire
      timeoutMs: 20,
      interruptTimeoutMs: 30, // short only for test speed (default 5s in harness)
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.timedOut, true);
    assert.equal(res.interruptAttempted, true);
    assert.equal(res.interruptOk, false); // never claim a confirmed stop
    assert.match(res.interruptError, /interrupt-timeout/);
    assert.ok(elapsed < 2000, `must not hang (elapsed ${elapsed}ms)`);
  });

  it('polling-deadline: interruptWithDeadline defaults to own 5s deadline and never wedges finalization', async () => {
    assert.equal(mod.INTERRUPT_TIMEOUT_MS, 5000);
    const t0 = Date.now();
    const hung = await mod.interruptWithDeadline(() => new Promise(() => {}), 30);
    const elapsed = Date.now() - t0;
    assert.equal(hung.attempted, true);
    assert.equal(hung.ok, false);
    assert.match(hung.error, /interrupt-timeout-30ms/);
    assert.ok(elapsed < 2000, `must not hang finalization (elapsed ${elapsed}ms)`);
    // Failure recording shape mirrors the polling-deadline loop: a failed
    // interrupt lands in enforcementFailures instead of silently detaching.
    const enforcementFailures = [];
    if (!hung.ok) enforcementFailures.push(`polling-deadline interrupt failed: ${hung.error}`);
    assert.equal(enforcementFailures.length, 1);
    assert.match(enforcementFailures[0], /polling-deadline interrupt failed/);
  });

  it('polling-deadline: interruptWithDeadline success + unavailable shapes (no hang)', async () => {
    const ok = await mod.interruptWithDeadline(async () => {}, 50);
    assert.deepEqual(ok, { attempted: true, ok: true, error: null });
    const missing = await mod.interruptWithDeadline(undefined, 50);
    assert.deepEqual(missing, { attempted: false, ok: false, error: 'interrupt-unavailable' });
    const throwing = await mod.interruptWithDeadline(async () => { throw new Error('boom-x'); }, 50);
    assert.equal(throwing.attempted, true);
    assert.equal(throwing.ok, false);
    assert.match(throwing.error, /boom-x/);
  });

  it('withDeadline races fn against its own timeout (shared helper)', async () => {
    await mod.withDeadline(async () => 'fast', 50, 'fast-timeout');
    let timedOut = false;
    try {
      await mod.withDeadline(() => new Promise(() => {}), 20, 'helper-timeout-20ms');
    } catch (e) {
      timedOut = /helper-timeout-20ms/.test(String((e && e.message) || e));
    }
    assert.equal(timedOut, true);
  });

  it('P1-steps: countSteps is honest (assistant/agent counted, user ignored, budget=4)', () => {
    const under = mod.countSteps(
      [{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }], []);
    assert.equal(under.assistantCount, 2);
    assert.equal(under.totalSteps, 2);
    assert.equal(under.overBudget, false);
    const over = mod.countSteps(
      [{ role: 'assistant' }, { role: 'assistant' }, { role: 'assistant' }, { role: 'agent' }, { role: 'assistant' }], []);
    assert.equal(over.assistantCount, 5);
    assert.equal(over.overBudget, true);
  });

  it('abort paths: hung interrupt never wedges finalization (failure recorded, event pushed)', async () => {
    const t0 = Date.now();
    const enforcementFailures = [];
    const events = [];
    const res = await mod.abortWithInterrupt({
      interruptFn: () => new Promise(() => {}), // hung — own deadline must fire
      reason: 'foreign-tool',
      enforcementFailures,
      events,
      timeoutMs: 30, // short only for test speed (harness default is 5000)
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.attempted, true);
    assert.equal(res.ok, false); // never claim a confirmed stop
    assert.match(res.error, /interrupt-timeout/);
    assert.equal(enforcementFailures.length, 1);
    assert.match(enforcementFailures[0], /foreign-tool abort interrupt failed/);
    assert.equal(events.length, 1);
    assert.equal(events[0].abortInterrupt, 'foreign-tool');
    assert.ok(elapsed < 2000, `must not hang finalization (elapsed ${elapsed}ms)`);
  });

  it('abort paths: unavailable interrupt records not-confirmable (step-budget reason)', async () => {
    const enforcementFailures = [];
    const events = [];
    const res = await mod.abortWithInterrupt({
      interruptFn: undefined, // no session.interrupt capability
      reason: 'step-budget',
      enforcementFailures,
      events,
      timeoutMs: 30,
    });
    assert.deepEqual(res, { attempted: false, ok: false, error: 'interrupt-unavailable' });
    assert.equal(enforcementFailures.length, 1);
    assert.match(enforcementFailures[0], /step-budget abort interrupt not confirmable/);
    assert.equal(events.length, 1);
    assert.equal(events[0].abortInterrupt, 'step-budget');
  });

  it('abort paths: successful interrupt records no failure (finishLive still reached)', async () => {
    const enforcementFailures = [];
    const events = [];
    const res = await mod.abortWithInterrupt({
      interruptFn: async () => {},
      reason: 'foreign-tool',
      enforcementFailures,
      events,
      timeoutMs: 50,
    });
    assert.deepEqual(res, { attempted: true, ok: true, error: null });
    assert.equal(enforcementFailures.length, 0);
    assert.equal(events.length, 1);
  });

  it('abort paths: both LIVE aborts route through abortWithInterrupt (5s default via INTERRUPT_TIMEOUT_MS)', async () => {
    assert.equal(mod.INTERRUPT_TIMEOUT_MS, 5000);
    const helperSrc = mod.abortWithInterrupt.toString();
    assert.match(helperSrc, /interruptWithDeadline/, 'helper delegates to interruptWithDeadline');
    assert.match(helperSrc, /INTERRUPT_TIMEOUT_MS/, 'helper defaults to the 5s deadline');
    const selfSrc = fs.readFileSync(path.join(HERE, 'run-05l-turn.mjs'), 'utf8');
    assert.match(selfSrc, /reason: 'foreign-tool'/, 'foreign-tool abort passes its reason');
    assert.match(selfSrc, /reason: 'step-budget'/, 'step-budget abort passes its reason');
    const abortCalls = selfSrc.match(/abortWithInterrupt\(/g) || [];
    assert.ok(abortCalls.length >= 3, `def + 2 abort call sites (found ${abortCalls.length})`);
  });
});

describe('spike-05L MEDIUM-polling + LOW-trace (no inference)', () => {
  it('POLL_TIMEOUT_MS defaults to 15s per poll (capped by the 90s global budget)', async () => {
    assert.equal(mod.POLL_TIMEOUT_MS, 15000);
    assert.equal(mod.LIVE_TIMEOUT_MS, 90000);
    assert.ok(mod.POLL_TIMEOUT_MS < mod.LIVE_TIMEOUT_MS, 'per-poll deadline fits inside the global budget');
  });

  it('polling hung list never wedges the runner (timeout recorded + interrupt attempted)', async () => {
    const t0 = Date.now();
    const enforcementFailures = [];
    const events = [];
    let interrupts = 0;
    const res = await mod.pollMessagesWithDeadline({
      listFn: () => new Promise(() => {}), // hung message.list — deadline must fire
      pollTimeoutMs: 30, // short only for test speed (harness default is 15000)
      interruptFn: async () => { interrupts += 1; },
      enforcementFailures,
      events,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.rows, null, 'no fresh rows on poll timeout');
    assert.ok(res.pollTimeout, 'poll timeout reported');
    assert.equal(res.pollTimeout.timeoutMs, 30);
    assert.equal(interrupts, 1, 'interrupt attempted exactly once on poll timeout');
    assert.equal(res.pollTimeout.interrupt.ok, true);
    assert.equal(enforcementFailures.length, 1, 'one failure (the timeout itself; interrupt succeeded)');
    assert.match(enforcementFailures[0], /polling message\.list timeout after 30ms/);
    assert.equal(events.length, 1);
    assert.equal(events[0].pollTimeout, true);
    assert.ok(elapsed < 2000, `must not hang (elapsed ${elapsed}ms)`);
  });

  it('polling hung list + hung interrupt still finalizes (both failures recorded)', async () => {
    const t0 = Date.now();
    const enforcementFailures = [];
    const events = [];
    const res = await mod.pollMessagesWithDeadline({
      listFn: () => new Promise(() => {}), // hung message.list
      pollTimeoutMs: 20,
      interruptFn: () => new Promise(() => {}), // hung interrupt — own deadline must fire
      interruptTimeoutMs: 30, // short only for test speed (harness default is 5000)
      enforcementFailures,
      events,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.rows, null);
    assert.ok(res.pollTimeout, 'poll timeout reported');
    assert.equal(res.pollTimeout.interrupt.ok, false, 'hung interrupt never claimed as stopped');
    assert.equal(enforcementFailures.length, 2, 'timeout + interrupt failure both recorded');
    assert.match(enforcementFailures[1], /poll-timeout interrupt failed/);
    assert.ok(elapsed < 2000, `must not hang finalization (elapsed ${elapsed}ms)`);
  });

  it('polling fast list returns rows with no failure (no interrupt)', async () => {
    const enforcementFailures = [];
    const events = [];
    let interrupts = 0;
    const rows = [{ role: 'assistant' }, { role: 'user' }];
    const res = await mod.pollMessagesWithDeadline({
      listFn: async () => ({ data: rows }),
      pollTimeoutMs: 500,
      interruptFn: async () => { interrupts += 1; },
      enforcementFailures,
      events,
    });
    assert.deepEqual(res.rows, rows, 'envelope {data} unwrapped');
    assert.equal(res.pollTimeout, null, 'no timeout on fast poll');
    assert.equal(interrupts, 0, 'no interrupt on healthy poll');
    assert.equal(enforcementFailures.length, 0);
    assert.equal(events.length, 0);
  });

  it('polling non-timeout list error records pollError without timeout/interrupt', async () => {
    const enforcementFailures = [];
    const events = [];
    let interrupts = 0;
    const res = await mod.pollMessagesWithDeadline({
      listFn: async () => { throw new Error('boom-list'); },
      pollTimeoutMs: 500,
      interruptFn: async () => { interrupts += 1; },
      enforcementFailures,
      events,
    });
    assert.equal(res.rows, null);
    assert.equal(res.pollTimeout, null, 'plain error is not a deadline timeout');
    assert.equal(interrupts, 0, 'no interrupt on plain poll error');
    assert.equal(enforcementFailures.length, 0);
    assert.equal(events.length, 1);
    assert.match(events[0].pollError, /boom-list/);
  });

  it('pre-prompt failure trace records sessionPromptCalled=false/count=0 (post-prompt=true/1)', async () => {
    const file = mod.tracePath();
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const reportsDir = path.dirname(file);
    const before = new Set(fs.readdirSync(reportsDir));
    try {
      const base = {
        eff: {}, verdict: { B01: { status: 'fail', reason: 'pre-inference surface mismatch' } },
        events: [], sessionID: null, message: 'probe', t0: Date.now(),
        dateBaseUTC: '2026-10-31', expectedDateUTC: '2026-10-30',
        aborted: 'pre-inference-surface',
      };
      // Pre-prompt default: prompt never invoked.
      await mod.finishLive({}, base);
      let parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.sessionPromptCalled, false, 'pre-prompt failure must not claim a prompt');
      assert.equal(parsed.sessionPromptCount, 0);
      // Post-prompt: caller passes true/1 explicitly.
      await mod.finishLive({}, { ...base, aborted: null, sessionPromptCalled: true, sessionPromptCount: 1 });
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.sessionPromptCalled, true);
      assert.equal(parsed.sessionPromptCount, 1);
    } finally {
      if (prev !== null) fs.writeFileSync(file, prev, 'utf8');
      for (const f of fs.readdirSync(reportsDir)) {
        if (!before.has(f) && /^SPIKE_05L_TRACE_.*\.json$/.test(f)) fs.unlinkSync(path.join(reportsDir, f));
      }
    }
  });

  it('LIVE poll loop wraps message.list in pollMessagesWithDeadline and breaks to finalization on timeout', async () => {
    const selfSrc = fs.readFileSync(path.join(HERE, 'run-05l-turn.mjs'), 'utf8');
    assert.match(selfSrc, /pollMessagesWithDeadline\(\{/, 'poll loop delegates to the deadline helper');
    assert.ok(!/const res = await boot\.oc\.message\.list\(\{ sessionID \}\);/.test(selfSrc),
      'no unbounded message.list call remains in the LIVE path');
    assert.match(selfSrc, /if \(pollTimeout\) \{/, 'poll timeout breaks toward finalization');
  });

  it('poll-timeout interrupt capped to remaining budget (never a full 5s past the 90s deadline)', async () => {
    const t0 = Date.now();
    const enforcementFailures = [];
    const events = [];
    const res = await mod.pollMessagesWithDeadline({
      listFn: () => new Promise(() => {}), // hung message.list
      pollTimeoutMs: 20,
      interruptFn: () => new Promise(() => {}), // hung interrupt — budget must fire
      interruptTimeoutMs: 5000, // harness default: must be capped by deadlineTs
      deadlineTs: Date.now() + 60, // only ~40ms of global budget left after the poll
      enforcementFailures,
      events,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.rows, null);
    assert.ok(res.pollTimeout, 'poll timeout reported');
    assert.ok(res.pollTimeout.interruptBudgetMs <= 60, `interrupt capped to remaining budget (got ${res.pollTimeout.interruptBudgetMs}ms)`);
    assert.equal(res.pollTimeout.interrupt.ok, false, 'hung interrupt never claimed as stopped');
    assert.ok(elapsed < 2000, `must not await the full 5s interrupt (elapsed ${elapsed}ms)`);
  });

  it('poll-timeout with no budget left skips interrupt and records explicit overrun', async () => {
    const enforcementFailures = [];
    const events = [];
    let interrupts = 0;
    const res = await mod.pollMessagesWithDeadline({
      listFn: () => new Promise(() => {}), // hung message.list
      pollTimeoutMs: 20,
      interruptFn: async () => { interrupts += 1; },
      deadlineTs: Date.now() - 1000, // global deadline already exceeded
      enforcementFailures,
      events,
    });
    assert.equal(res.rows, null);
    assert.ok(res.pollTimeout, 'poll timeout reported');
    assert.equal(interrupts, 0, 'no interrupt attempted with no budget left');
    assert.deepEqual(
      { attempted: res.pollTimeout.interrupt.attempted, ok: res.pollTimeout.interrupt.ok, error: res.pollTimeout.interrupt.error },
      { attempted: false, ok: false, error: 'deadline-exceeded-no-budget' },
    );
    assert.ok(typeof res.pollTimeout.overrunMs === 'number' && res.pollTimeout.overrunMs > 0, 'explicit overrun recorded');
    assert.match(enforcementFailures.join('\n'), /no global budget left/);
    assert.equal(events[0].deadlineExceeded, true, 'deadlineExceeded recorded on the poll-timeout path');
  });

  it('poll-timeout path propagates deadlineInterrupt to finalization (source contract)', async () => {
    const selfSrc = fs.readFileSync(path.join(HERE, 'run-05l-turn.mjs'), 'utf8');
    assert.match(selfSrc, /deadlineInterrupt = pollTimeout\.interrupt/, 'poll-timeout assigns deadlineInterrupt (not only the event)');
    assert.match(selfSrc, /deadlineTs: deadline/, 'poll loop passes the global deadline so the interrupt is budget-capped');
    assert.match(selfSrc, /POLLING_DEADLINE_NOTE/, 'worst-case 90s+5s margin documented in the trace');
  });
});

describe('spike-05L immutable trace snapshots (HIGH: live evidence never overwritten)', () => {
  it('dryrun + live both write latest AND a timestamped immutable snapshot', async () => {
    const reportsDir = path.join(HERE, '..', 'reports');
    const latestFile = mod.tracePath();
    const prevLatest = fs.existsSync(latestFile) ? fs.readFileSync(latestFile, 'utf8') : null;
    const before = new Set(fs.readdirSync(reportsDir));
    try {
      const base = {
        eff: {}, verdict: { B01: { status: 'fail', reason: 'probe' } },
        events: [], sessionID: null, message: 'probe', t0: Date.now(),
        dateBaseUTC: '2026-10-31', expectedDateUTC: '2026-10-30',
        aborted: 'pre-inference-surface',
      };
      await mod.finishLive({}, base);
      const after = fs.readdirSync(reportsDir).filter((f) => !before.has(f));
      const snaps = after.filter((f) => /^SPIKE_05L_TRACE_live_.*\.json$/.test(f));
      assert.ok(snaps.length >= 1, `live snapshot written alongside latest (new files: ${after.join(',')})`);
      const parsed = JSON.parse(fs.readFileSync(path.join(reportsDir, snaps[0]), 'utf8'));
      assert.equal(parsed.mode, 'live');
      assert.equal(parsed.sessionPromptCalled, false);
      for (const f of after) fs.unlinkSync(path.join(reportsDir, f));
    } finally {
      if (prevLatest !== null) fs.writeFileSync(latestFile, prevLatest, 'utf8');
    }
  });

  it('timestamp collision never overwrites the first snapshot (suffix instead)', async () => {
    const latestFile = mod.tracePath();
    const prevLatest = fs.existsSync(latestFile) ? fs.readFileSync(latestFile, 'utf8') : null;
    const at = '2026-10-31T15-26-49-841Z';
    const first = mod.writeTraceFiles({ mode: 'live', at }, JSON.stringify({ spike: '05L', mode: 'live', at }));
    const second = mod.writeTraceFiles({ mode: 'live', at }, JSON.stringify({ spike: '05L', mode: 'live', at }));
    try {
      assert.notEqual(first.snapshot, second.snapshot, 'collision yields a distinct snapshot path');
      assert.ok(fs.existsSync(first.snapshot) && fs.existsSync(second.snapshot));
    } finally {
      try { fs.unlinkSync(first.snapshot); } catch { /* probe cleanup */ }
      try { if (second.snapshot !== first.snapshot) fs.unlinkSync(second.snapshot); } catch { /* probe cleanup */ }
      if (prevLatest !== null) fs.writeFileSync(latestFile, prevLatest, 'utf8');
    }
  });
});
