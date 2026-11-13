// SPIKE 05D LIVE — dryrun harness test (no inference, no cost).
//
// Proves: parseArgs/gates refuse live without TED_05D_LIVE=1 and refuse a
// non-frozen live message; durableRouteTransport routes propose to the
// durable bridge and reads to the seed bridge; validators check ids+amount+
// dynamic date (never balances); extractLiveProposal REQUIRES a UUID
// proposalId; snapshots are immutable (collision => suffix, never overwrite).
// Integration runDryrun (needs SPIKE05D_DATABASE_URL) proves the durable
// wiring end-to-end with its own scope + cleanup. NEVER sets TED_05D_LIVE;
// no prompt, no confirm, no production.
//
// Run (cwd = experiments/ted-runtime/bootstrap):
//   node --test run-05d-live.test.mjs
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.TED_HOME_ROOT = path.join(HERE, '..');

const mod = await import('./run-05d-live.mjs');

describe('spike-05D live harness gates (no inference)', () => {
  before(() => {
    delete process.env.TED_05D_LIVE; // gate locked: dryrun must not infer
  });

  it('LIVE gate refuses without TED_05D_LIVE=1 (exit 2, no inference)', () => {
    delete process.env.TED_05D_LIVE;
    assert.throws(() => mod.assertLiveGate(), (e) => e && e.exitCode === 2);
  });

  it('durable env gate refuses missing/non-spike URL (exit 2, never echoes)', () => {
    assert.throws(() => mod.assertDurableEnv({}), (e) => e && e.exitCode === 2);
    assert.throws(
      () => mod.assertDurableEnv({ SPIKE05D_DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:5432/pi_financeiro' }),
      (e) => e && e.exitCode === 2,
    );
  });

  it('parseArgs: dryrun/live/confirm shapes; live message frozen; confirm needs snapshot', () => {
    assert.equal(mod.parseArgs(['--mode=dryrun']).mode, 'dryrun');
    assert.equal(mod.parseArgs(['--mode=live']).message, mod.DEFAULT_MESSAGE_05D);
    assert.throws(() => mod.parseArgs(['--mode=live', '--message=outra mensagem']), (e) => e && e.exitCode === 2);
    assert.throws(() => mod.parseArgs(['--mode=confirm']), (e) => e && e.exitCode === 2);
    assert.equal(mod.parseArgs(['--mode=confirm', '--snapshot=f.json']).snapshot, 'f.json');
    assert.equal(mod.parseArgs(['--mode=confirm', '--snapshot=f.json', '--message-id=msg_1']).messageId, 'msg_1');
    assert.throws(() => mod.parseArgs(['--mode=dryrun', '--host=A']), (e) => e && e.exitCode === 2);
  });

  it('durableRouteTransport: propose goes durable (needs DB), reads go seed bridge', async () => {
    const src = fs.readFileSync(path.join(HERE, 'run-05d-live.mjs'), 'utf8');
    assert.match(src, /\/pending-operations\/v2\/propose/, 'propose route mapped');
    assert.match(src, /callFinanceDurable\(\{\s*op:\s*'propose'/, 'propose delegates to callFinanceDurable');
    // Reads resolve without a DB (seed bridge, identical fixture ids).
    const host = { ...mod.HOST_A };
    const accounts = await mod.durableRouteTransport({
      route: '/accounts', method: 'GET', host,
      intentionId: 'int-test-reads-01',
    });
    assert.equal(accounts.statusCode, 200);
    const rows = accounts.body.items || accounts.body;
    assert.ok(rows.find((r) => r.name === 'Nubank' && r.id === mod.EXPECTED_ACCOUNT_ID));
    const cats = await mod.durableRouteTransport({
      route: '/categories?kind=expense', method: 'GET', host,
      intentionId: 'int-test-reads-02',
    });
    assert.equal(cats.statusCode, 200);
    const crows = cats.body.items || cats.body;
    assert.ok(crows.find((c) => c.name === 'Mercado' && c.id === mod.EXPECTED_CATEGORY_ID));
  });

  it('validators: ids+amount+dynamic date (never balances)', () => {
    const expectedDateUTC = mod.yesterdayUTCProxy(Date.now());
    const good = {
      id: '11111111-2222-4333-8444-555555555555',
      tool: 'transactions.expense.create',
      normalizedArgs: {
        amountCents: 3500, description: 'mercado', date: expectedDateUTC,
        accountId: mod.EXPECTED_ACCOUNT_ID, categoryId: mod.EXPECTED_CATEGORY_ID,
      },
    };
    const v = mod.validatePropose(good, { accountId: mod.EXPECTED_ACCOUNT_ID, categoryId: mod.EXPECTED_CATEGORY_ID, expectedDateUTC });
    assert.equal(v.ok, true);
    assert.equal(mod.validatePropose({ ...good, normalizedArgs: { ...good.normalizedArgs, amountCents: 3499 } },
      { accountId: mod.EXPECTED_ACCOUNT_ID, categoryId: mod.EXPECTED_CATEGORY_ID, expectedDateUTC }).ok, false);
    assert.equal(mod.validatePropose({ ...good, normalizedArgs: { ...good.normalizedArgs, accountId: '11111111-1111-4111-8111-111111111111' } },
      { accountId: mod.EXPECTED_ACCOUNT_ID, categoryId: mod.EXPECTED_CATEGORY_ID, expectedDateUTC }).ok, false);
    assert.equal(mod.validatePropose({ ...good, normalizedArgs: { ...good.normalizedArgs, date: '2020-01-01' } },
      { accountId: mod.EXPECTED_ACCOUNT_ID, categoryId: mod.EXPECTED_CATEGORY_ID, expectedDateUTC }).ok, false);
    assert.equal(mod.validatePropose({ noId: true }, { accountId: 'x', categoryId: 'y', expectedDateUTC }).ok, false);
    const acc = mod.validateAccounts({ items: [{ name: 'Itaú', id: 'a', balanceCents: -999 }, { name: 'Nubank', id: mod.EXPECTED_ACCOUNT_ID, balanceCents: -1 }] });
    assert.equal(acc.ok, true, 'balances drift — identity is names+ids');
    assert.equal(mod.validateAccounts({ items: [{ name: 'Itaú', id: 'a' }] }).ok, false);
  });

  it('extractLiveProposal REQUIRES a UUID proposalId (never guess linkage)', () => {
    const msg = (text) => [{ role: 'assistant', parts: [{ type: 'text', text }] }];
    const goodText = JSON.stringify({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'proposed',
      tool: 'transactions.expense.create',
      normalizedArgs: { amountCents: 3500, accountId: mod.EXPECTED_ACCOUNT_ID, categoryId: mod.EXPECTED_CATEGORY_ID, date: '2026-10-30' },
    });
    const ext = mod.extractLiveProposal(msg(`result: ${goodText}`));
    assert.equal(ext.ok, true);
    assert.equal(ext.proposalId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const noId = mod.extractLiveProposal(msg('result: {"normalizedArgs":{"amountCents":3500}}'));
    assert.equal(noId.ok, false);
    assert.match(noId.reason, /proposal id/i);
    assert.equal(mod.extractLiveProposal(msg('nothing financial here at all, just prose')).ok, false);
    assert.equal(mod.extractLiveProposal([{ role: 'user', parts: [{ type: 'text', text: `user says: ${goodText} plus padding to exceed twenty chars` }] }]).ok, false,
      'user-echoed JSON must not count as propose evidence');
    // Full live accuracy gate over the extracted proposal.
    const acc = mod.validateLivePropose(msg(`result: ${goodText}`), { expectedDateUTC: '2026-10-30' });
    assert.equal(acc.ok, true);
    assert.equal(acc.proposalId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const badDateText = goodText.replace('2026-10-30', '2026-10-29');
    assert.equal(mod.validateLivePropose(msg(`result: ${badDateText}`), { expectedDateUTC: '2026-10-30' }).ok, false);
  });

  it('snapshots are immutable (collision => suffix, never overwrite)', () => {
    const at = '2026-10-31T00-00-00-000Z-probe-05d';
    const first = mod.writeTraceSnapshot({ mode: 'dryrun', at }, JSON.stringify({ spike: '05D', mode: 'dryrun', at }));
    const second = mod.writeTraceSnapshot({ mode: 'dryrun', at }, JSON.stringify({ spike: '05D', mode: 'dryrun', at }));
    try {
      assert.notEqual(first.snapshot, second.snapshot);
      assert.ok(fs.existsSync(first.snapshot) && fs.existsSync(second.snapshot));
      assert.match(first.snapshot, /SPIKE_05D_LIVE_dryrun_/);
    } finally {
      try { fs.unlinkSync(first.snapshot); } catch { /* probe cleanup */ }
      try { if (second.snapshot !== first.snapshot) fs.unlinkSync(second.snapshot); } catch { /* probe cleanup */ }
    }
  });

  it('runner owns its durable plugin id (frozen ted-finance never loaded for 05D)', () => {
    const src = fs.readFileSync(path.join(HERE, 'run-05d-live.mjs'), 'utf8');
    assert.match(src, /ted-finance-05d/, '05D registers its own durable plugin id');
    assert.match(src, /buildExecute/, 'host/intention semantics reused via buildExecute');
    assert.ok(!/from '\.\/plugins\/ted-finance\/index\.mjs'\s*;\s*\nimport \{ Plugin \}|oc\.plugin\(ted\)/.test(src), 'frozen plugin entry never registered as-is');
  });

  it('SDK 2.2.4 shape corrections (observed live 2026-10-31): type-based roles, user skip, ledger-effect prose gate', () => {
    // findUserMessageId matches type=user (SDK carries `type`, not `role`).
    const umsg = [{ id: 'ses-x', type: 'session' }, { id: 'msg_u1', type: 'user', text: 'TED, gastei 35 reais no mercado ontem, pelo Nubank.' }];
    assert.equal(mod.findUserMessageId(umsg, mod.DEFAULT_MESSAGE_05D), 'msg_u1');
    assert.equal(mod.findUserMessageId([{ role: 'user', id: 'm2', text: mod.DEFAULT_MESSAGE_05D }], mod.DEFAULT_MESSAGE_05D), 'm2');
    assert.equal(mod.findUserMessageId([{ id: 'm3', type: 'assistant', text: mod.DEFAULT_MESSAGE_05D }], mod.DEFAULT_MESSAGE_05D), null);
    // countSteps tallies type=assistant too (roles are null in 2.2.4 list output).
    const typed = [{ type: 'user' }, { type: 'assistant' }, { type: 'assistant' }, { type: 'assistant' }];
    assert.equal(mod.countSteps(typed, []).assistantCount, 3);
    assert.equal(mod.countSteps(typed, []).overBudget, false);
    assert.equal(mod.countSteps([...typed, { type: 'assistant' }, { type: 'assistant' }], []).overBudget, true);
    assert.equal(mod.countSteps([{ type: 'idle' }, { type: 'user' }], []).assistantCount, 0);
    // assertsLedgerEffect: proposal lifecycle prose passes; ledger claims fail.
    assert.equal(mod.assertsLedgerEffect('Registrei a proposta de despesa: R$ 35,00. A proposta fica válida aguardando confirmação para ser efetivada.'), false);
    assert.equal(mod.assertsLedgerEffect('Proposta criada, quer que eu confirme?'), false);
    assert.equal(mod.assertsLedgerEffect('Lançamento criado no valor de R$ 35,00!'), true);
    assert.equal(mod.assertsLedgerEffect('Despesa registrada com sucesso.'), true);
    assert.equal(mod.assertsLedgerEffect('Adicionei a transação ao extrato.'), true);
  });

  it('runConfirm refuses without linkage (missing file, bad snapshot, no message id)', async (t) => {
    if (!process.env.SPIKE05D_DATABASE_URL) return t.skip('SPIKE05D_DATABASE_URL not set');
    const badFile = path.join(HERE, '..', 'spike-05d', 'traces', 'SPIKE_05D_LIVE_probe-missing.json');
    const r1 = await mod.runConfirm(badFile, { messageId: 'msg_x' });
    assert.equal(r1.ok, false);
    assert.match(r1.trace.reason, /cannot read live snapshot/);
    try { fs.unlinkSync(r1.snapshot); } catch { /* probe cleanup */ }
    const notLive = path.join(HERE, '..', 'spike-05d', 'traces', 'SPIKE_05D_LIVE_probe-notlive.json');
    fs.writeFileSync(notLive, JSON.stringify({ spike: '05D', mode: 'dryrun' }));
    try {
      const r2 = await mod.runConfirm(notLive, { messageId: 'msg_x' });
      assert.equal(r2.ok, false);
      assert.match(r2.trace.reason, /not a 05D live trace/);
      try { fs.unlinkSync(r2.snapshot); } catch { /* probe cleanup */ }
    } finally {
      try { fs.unlinkSync(notLive); } catch { /* probe cleanup */ }
    }
  });
});

describe('spike-05D dryrun integration (durable wiring, no inference)', () => {
  it('dryrun completes with durable propose + fresh-process GET, own scope cleaned', async (t) => {
    if (!process.env.SPIKE05D_DATABASE_URL) return t.skip('SPIKE05D_DATABASE_URL not set');
    delete process.env.TED_05D_LIVE;
    const { trace, snapshot, output } = await mod.runDryrun();
    assert.equal(trace.spike, '05D');
    assert.equal(trace.mode, 'dryrun');
    assert.equal(trace.sessionPromptCalled, false);
    assert.equal(output.sessionPromptCalled, false);
    assert.equal(trace.deterministicFinance.accounts.ok, true);
    assert.equal(trace.deterministicFinance.categories.ok, true);
    assert.equal(trace.deterministicFinance.propose.ok, true);
    assert.match(trace.deterministicFinance.propose.details.durableGet, /fresh-process GET/);
    for (const k of ['B01', 'B03', 'B04', 'B05', 'B07']) {
      assert.equal(trace.verdict[k].status, 'pass', `${k} must pass in dryrun`);
    }
    assert.ok(fs.existsSync(snapshot), 'immutable snapshot written to spike-05d/traces');
    assert.match(snapshot, /SPIKE_05D_LIVE_dryrun_/);
    const raw = fs.readFileSync(snapshot, 'utf8');
    assert.ok(!raw.includes('dev-token-'), 'snapshot carries no token substrings');
  });
});
