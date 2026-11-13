// SPIKE 03B dryrun test — deterministic, NO inference, NO cost.
//
// cwd: experiments/ted-runtime/bootstrap. TED_HOME_ROOT=.. (points at
// experiments/ted-runtime), so isolation homes + reports stay in-spike.
//   node --test ../tests/spike-03b-dryrun.test.mjs
//
// (a) 03B config: single provider allow + admin denies, no finance-tool deny.
// (b) DRYRUN enumerates facade 7 keys + ted-finance active + native catalog
//     {list_accounts,get_month_summary}, zero secrets in output.
// (c) LIVE refuses without TED_03B_LIVE=1 (unit gate + CLI exit 2, no boot).
// (d) Token scan over the dryrun trace file is zero.
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

describe('spike-03b dryrun', () => {
  let runner;
  before(async () => {
    runner = await import(pathToFileURL(path.join(BOOT, 'run-03b-turn.mjs')).href);
  });

  it('(a) 03B config: single provider allow + admin denies, finance tools untouched', () => {
    const cfg = runner.build03BConfig();
    const allows = cfg.policies.filter((p) => p.effect === 'allow');
    assert.equal(allows.length, 1);
    assert.equal(allows[0].action, 'provider.use');
    assert.equal(allows[0].resource, 'opencode-go');
    const denies = cfg.policies.filter((p) => p.effect === 'deny').map((p) => `${p.action}:${p.resource}`);
    for (const d of ['tool.use:shell:*', 'tool.use:edit:*', 'tool.use:write:*', 'tool.use:subagent:*', 'provider.use:*']) {
      assert.ok(denies.includes(d), `missing deny ${d}`);
    }
    const flat = JSON.stringify(cfg);
    assert.ok(!flat.includes('list_accounts') && !flat.includes('get_month_summary'), 'finance tools must not be denied (nor mentioned)');
    const agent = cfg.agents.ted;
    assert.equal(agent.mode, 'primary');
    const perms = agent.permissions.map((p) => `${p.action}:${p.resource}:${p.effect}`);
    for (const d of ['shell:*:deny', 'edit:*:deny', 'subagent:*:deny']) {
      assert.ok(perms.includes(d), `missing agent deny ${d}`);
    }
    assert.equal(scanSecrets(flat).length, 0);
    // Override flags are refused before any boot.
    for (const flag of ['--host=x', '--route=/x', '--method=GET', '--token=t', '--workspace=w', '--actor=a']) {
      assert.throws(() => runner.parseArgs(['--mode=dryrun', flag]), /refused/);
    }
    assert.throws(() => runner.parseArgs(['--mode=live', '--token=dev-token-2']), /refused/);
    assert.equal(runner.parseArgs(['--mode=dryrun']).mode, 'dryrun');
  });

  it('(b) DRYRUN enumerates facade 8 keys + ted-finance active + finance catalog, zero secrets', async () => {
    const { trace, output } = await runner.runDryrun();
    assert.equal(trace.sessionPromptCalled, false);
    assert.deepEqual(trace.effective.facadeKeys, ['createSession', 'getSession', 'get_month_summary', 'listCatalogs', 'listSessions', 'list_accounts', 'list_categories', 'removeSession']);
    assert.equal(trace.effective.facadeKeysMatch, true);
    assert.equal(trace.effective.tedFinanceActive, true);
    assert.deepEqual(trace.effective.financeToolsNative.filter((t) => ['list_accounts', 'get_month_summary'].includes(t)), ['get_month_summary', 'list_accounts']);
    assert.equal(trace.effective.financeToolsPresent, true);
    assert.equal(trace.effective.financeToolsExactOnly, false); // built-in superset: transform() adds, never replaces
    assert.equal(trace.effective.hasToolCatalog, false); // 2.2.4 has no tool endpoint
    assert.equal(trace.verdict.B01.status, 'pass');
    assert.equal(trace.verdict.B07.status, 'pass'); // zero-secret pre-write scan
    assert.equal(trace.verdict.B04.status, 'pass'); // A/2026-06 exact via real handlers
    assert.equal(trace.verdict.B05.status, 'pass'); // Itaú 100000 + Nubank 50000
    assert.equal(trace.verdict.B02.status, 'not-exercised'); // prompt-loop untested by design
    const serialized = JSON.stringify(output);
    assert.equal(scanSecrets(serialized).length, 0, 'dryrun output must carry zero secrets');
    assert.equal(scanSecrets(JSON.stringify(trace)).length, 0);
  });

  it('(c) LIVE locks without TED_03B_LIVE=1 (unit + CLI exit 2, no inference)', () => {
    const env = { ...process.env };
    delete env.TED_03B_LIVE;
    assert.throws(() => runner.assertLiveGate(env), /TED_03B_LIVE=1/);
    assert.throws(() => runner.assertLiveGate({}), /TED_03B_LIVE=1/);
    let err = null;
    try {
      execFileSync(process.execPath, [path.join(BOOT, 'run-03b-turn.mjs'), '--mode=live'], {
        cwd: BOOT, env: { ...process.env, TED_HOME_ROOT: TED }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { err = e; }
    assert.ok(err, 'live without gate must exit non-zero');
    assert.equal(err.status, 2);
    const stderr = String((err.stderr || '')).slice(0, 500);
    assert.match(stderr, /TED_03B_LIVE=1/);
    assert.equal(scanSecrets(String(err.stdout || '') + stderr).length, 0);
  });

  it('(e) extractor dedupes codemode metadata + selection/execution semantics', () => {
    // Synthetic T1-shaped message: finance calls via metadata.toolCalls with
    // nested .tool/.input fields that a naive recursion would double-count.
    const messages = [{
      role: 'assistant',
      parts: [{
        type: 'tool', name: 'execute',
        state: {
          status: 'completed',
          input: { code: 'tools.list_accounts({})' },
          metadata: { toolCalls: [{ tool: 'list_accounts', status: 'error', input: {} }, { tool: 'get_month_summary', status: 'error', input: { yearMonth: '2026-06' } }] },
        },
      }],
    }];
    const { calls } = runner.extractToolCalls(messages);
    assert.equal(calls.length, 2, `dedupe: expected 2, got ${calls.length}`);
    const sel = runner.summarizeSelection(calls);
    assert.deepEqual(sel.names.slice().sort(), ['get_month_summary', 'list_accounts']);
    assert.deepEqual(sel.foreign, []);
    assert.equal(sel.bothObserved, true);
    // Selection (B02 semantics) passes even when execution errored; the
    // statuses stay visible for B04 to judge.
    assert.deepEqual(sel.perTool.list_accounts.statuses, ['error']);
    // Accuracy validator: error-only payloads are NOT data.
    const bad = runner.validateLiveFinance(messages);
    assert.equal(bad.ok, false);
    // Success payload validates against the exact expected values.
    const good = [{
      role: 'assistant',
      parts: [{ type: 'text', text: 'Resumo: ' + JSON.stringify({ incomeCents: 1200000, expenseCents: 288050, balanceCents: 911950, transactionCount: 4 }) },
        { type: 'text', text: 'Contas: ' + JSON.stringify({ items: [{ name: 'Itaú', balanceCents: 100000 }, { name: 'Nubank', balanceCents: 50000 }], total: 2 }) }],
    }];
    const okAcc = runner.validateLiveFinance(good);
    assert.equal(okAcc.ok, true, okAcc.reason);
    // Wrong numbers fail loudly (no silent pass).
    const wrong = [{ role: 'assistant', parts: [{ type: 'text', text: JSON.stringify({ incomeCents: 1, expenseCents: 2, balanceCents: 3, transactionCount: 4 }) }] }];
    assert.equal(runner.validateLiveFinance(wrong).ok, false);
    // T2-shaped escaped envelope (payload travels \"-escaped inside the
    // message JSON) must still validate.
    const escaped = [{ role: 'assistant', parts: [{ type: 'tool', name: 'execute', state: { status: 'completed', content: [{ type: 'text', text: '{"summary":{"yearMonth":"2026-06","incomeCents":1200000,"expenseCents":288050,"balanceCents":911950,"transactionCount":4},"accounts":{"items":[{"name":"Itaú","balanceCents":100000},{"name":"Nubank","balanceCents":50000}],"total":2}}' }] } }] }];
    const viaEnvelope = JSON.parse(JSON.stringify(escaped)); // forces \"-escaping like the wire
    assert.equal(runner.validateLiveFinance(viaEnvelope).ok, true, 'escaped T2-shaped payload must validate');
    // Review MEDIUM: user-role texts are never result evidence, even with
    // exact numbers (prevents a planted user message from passing B04).
    const planted = [{ role: 'user', parts: [{ type: 'text', text: JSON.stringify({ incomeCents: 1200000, expenseCents: 288050, balanceCents: 911950, transactionCount: 4 }) + ' ' + JSON.stringify({ items: [{ name: 'Itaú', balanceCents: 100000 }, { name: 'Nubank', balanceCents: 50000 }], total: 2 }) }] }];
    assert.equal(runner.validateLiveFinance(planted).ok, false, 'user-role JSON must not count as tool data');
    // T3 shape: role-less messages; final prose answer must be found while
    // tool JSON is skipped.
    const t3shape = [
      { parts: [{ type: 'text', text: 'TED, quais contas eu tenho e quanto gastei em junho de 2026?' }] },
      { parts: [{ type: 'reasoning', text: 'let me call the tools' }, { type: 'tool', name: 'execute', state: { status: 'completed', content: [{ type: 'text', text: '{"accounts":{"items":[],"total":0}}' }] } }] },
      { parts: [{ type: 'text', text: 'Você tem 2 contas: Itaú R$ 1.000,00 e Nubank R$ 500,00.' }] },
    ];
    assert.match(runner.lastAssistantText(t3shape), /Itaú/, 'final prose answer must be found in role-less shape');
    assert.equal(runner.lastAssistantText([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }]), '', 'user-only yields empty');
  });

  it('(d) token scan over the dryrun trace file is zero', () => {
    const file = path.join(TED, 'reports', 'SPIKE_03B_TRACE.json');
    assert.ok(fs.existsSync(file), 'dryrun must have written the trace');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(scanSecrets(raw).length, 0, 'trace file must carry zero token substrings');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.mode, 'dryrun');
    assert.equal(parsed.sessionPromptCalled, false);
  });

  it('(f) P2: list_categories is foreign BY DESIGN in the 03B context (frozen read-only turn)', () => {
    // SPIKE05L-FIX-P2 decision pin: the facade wrapper exists for
    // FACADE_KEYS parity only; FINANCE_TOOLS stays the frozen 2-tool 03B
    // verdict allowlist. summarizeSelection MUST flag list_categories as
    // foreign here (a LIVE 03B turn calling it aborts via B02/B06), while
    // the B01 subset gate (bothObserved over the 03B pair) stays
    // independent of foreign extras.
    const only03B = [
      { name: 'list_accounts', args: {}, status: 'success' },
      { name: 'get_month_summary', args: { yearMonth: '2026-06' }, status: 'success' },
    ];
    const selClean = runner.summarizeSelection(only03B);
    assert.deepEqual(selClean.foreign, []);
    assert.equal(selClean.bothObserved, true);
    const withCat = [...only03B, { name: 'list_categories', args: {}, status: 'success' }];
    const selCat = runner.summarizeSelection(withCat);
    assert.deepEqual(selCat.foreign, ['list_categories'], 'list_categories must stay foreign in the 03B context (intentional, not a failure)');
    assert.equal(selCat.bothObserved, true, 'foreign extras must not disturb the B01 subset gate');
    const catOnly = runner.summarizeSelection([{ name: 'list_categories', args: {}, status: 'success' }]);
    assert.deepEqual(catOnly.foreign, ['list_categories']);
    assert.equal(catOnly.bothObserved, false);
  });
});
