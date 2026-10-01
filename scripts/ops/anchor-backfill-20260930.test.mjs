// anchor-backfill-20260930.test.mjs
// Contract test for scripts/ops/anchor-backfill-20260930.{apply,compensate,guards}.sql.
// Disposable PostgreSQL 15 (same major as prod), restored from the real
// canonical backup dump (path via ANCHOR_BACKFILL_DUMP; skips when absent).
// Proves: guards green pre-repair, apply repairs exactly 31 anchors with
// ledger invariance + 2 audit rows, tampered history makes apply FAIL with
// full rollback, tampered post-repair state makes compensate REFUSE, clean
// compensate reverts + appends 2 linked rows. NEVER touches production.
// Run: ANCHOR_BACKFILL_DUMP=<path-to-dump> node --test scripts/ops/anchor-backfill-20260930.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = resolve(HERE, 'anchor-backfill-20260930.apply.sql');
const COMPENSATE = resolve(HERE, 'anchor-backfill-20260930.compensate.sql');
const GUARDS = resolve(HERE, 'anchor-backfill-20260930.guards.sql');
const VERIFY = resolve(HERE, 'anchor-backfill-20260930.verify.sql');
const RESOLVE = resolve(HERE, 'anchor-backfill-20260930.resolve.sql');
const DUMP = process.env.ANCHOR_BACKFILL_DUMP
  || 'C:\\Users\\walis\\AppData\\Local\\Temp\\opencode\\pi-canonical-20260930T194523Z.dump';
const PROCV = 'anchor-backfill-20260930.contract-test@v1';
const REASON = 'contract-test-anchor-backfill';

const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', ...options });
const docker = (args, options = {}) => run('docker', args, options);
const sql = (c, db, q) =>
  docker(['exec', c, 'psql', '-U', 'postgres', '-d', db, '-Atc', q]).trim();
const psqlFile = (c, db, path, vars, extra = []) => {
  const args = ['exec', '-i', c, 'psql', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', db, ...extra];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return run('docker', args, { input: readFileSync(path) });
};
// Non-throwing variant for resolve/timeout probing.
const psqlFileSoft = (c, db, path, vars, extra = []) => {
  try {
    return { code: 0, out: psqlFile(c, db, path, vars, extra) };
  } catch (e) {
    return { code: e.status ?? 1, out: String((e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')) };
  }
};
const rowsOf = (text) => Object.fromEntries(
  text.trim().split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('~');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
const isDockerAvailable = () => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const waitFor = (c, db) => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const out = execFileSync('docker',
        ['exec', c, 'psql', '-U', 'postgres', '-d', db, '-Atqc', 'SELECT 1'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.trim() === '1') return;
    } catch { /* retry silently */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error('postgres not ready');
};
const ROWHASH = `SELECT md5(string_agg(a.id::text || '|' || a.household_id::text || '|' || a.kind || '|' || a.balance_cents::text || '|' || a.status, ',' ORDER BY a.id::text)) FROM accounts a WHERE a.deleted_at IS NULL`;

test('anchor-backfill apply + compensate contract on restored backup (PG15 disposable)',
  { timeout: 420_000 }, async (t) => {
    if (!isDockerAvailable()) { t.skip('docker unavailable'); return; }
    if (!existsSync(DUMP)) { t.skip(`dump absent: ${DUMP}`); return; }
    const c = `anchor-backfill-test-${process.pid}`;
    const dir = dirname(resolve(DUMP));
    const base = basename(DUMP);
    try {
      docker(['run', '-d', '--rm', '--name', c,
        '-e', 'POSTGRES_PASSWORD=anchorbackfilltest',
        '-v', `${dir}:/backups:ro`, 'postgres:15-alpine']);
      waitFor(c, 'postgres');
      for (const db of ['negA', 'negD', 'fullB', 'cleanC', 'resA', 'resB', 'resC']) {
        docker(['exec', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE "${db}";`]);
        docker(['exec', c, 'pg_restore', '-U', 'postgres', '-d', db,
          '--clean', '--if-exists', '--no-owner', `/backups/${base}`]);
        sql(c, db, `CREATE TABLE ops_test_marker(id uuid PRIMARY KEY, note text);
          INSERT INTO ops_test_marker VALUES (gen_random_uuid(), 'disposable-repair-contract');`);
        assert.equal(sql(c, db, 'SELECT count(*) FROM accounts;'), '31');
        assert.equal(sql(c, db, 'SELECT count(*) FROM ops_test_marker;'), '1');
      }

      // Guards green on pristine restore -------------------------------------
      const guards = docker(['exec', '-i', c, 'psql', '-v', 'ON_ERROR_STOP=1',
        '-U', 'postgres', '-d', 'fullB', '-tA', '-F|'],
        { input: readFileSync(GUARDS) });
      const bad = guards.trim().split('\n').filter((l) => !l.endsWith('|t'));
      assert.deepEqual(bad, [], `guards must all pass:\n${guards}`);

      // NEGATIVE apply: tampered balance => FAIL + full rollback --------------
      const victimA = sql(c, 'negA', 'SELECT id FROM accounts LIMIT 1;');
      sql(c, 'negA', `UPDATE accounts SET balance_cents = balance_cents + 1 WHERE id = '${victimA}';`);
      assert.throws(() => psqlFile(c, 'negA', APPLY, {
        repair_id: randomUUID(), backup_id: 'TEST-negA',
        backup_sha: '0123456789abcdef'.repeat(4),
        procedure_version: PROCV, reason: REASON,
      }), /anchor-backfill: balances sum 306301 <> 306300/);
      assert.equal(sql(c, 'negA', 'SELECT count(*) FROM accounts WHERE initial_balance_cents = 0;'), '31');
      assert.equal(sql(c, 'negA', 'SELECT count(*) FROM audit_logs;'), '61');

      // NEGATIVE apply N3: description-only tamper (sums AND balances intact)
      // => ledger fingerprint MUST fail + full rollback -----------------------
      const txD = sql(c, 'negD', 'SELECT id FROM transactions LIMIT 1;');
      sql(c, 'negD', `UPDATE transactions SET description = 'tampered-for-test' WHERE id = '${txD}';`);
      assert.equal(sql(c, 'negD', 'SELECT COALESCE(sum(amount_cents),0) FROM transactions WHERE deleted_at IS NULL;'), '3700');
      assert.throws(() => psqlFile(c, 'negD', APPLY, {
        repair_id: randomUUID(), backup_id: 'TEST-negD',
        backup_sha: '0123456789abcdef'.repeat(4),
        procedure_version: PROCV, reason: REASON,
      }), /ledger fingerprint .* unexpected/);
      assert.equal(sql(c, 'negD', 'SELECT count(*) FROM accounts WHERE initial_balance_cents = 0;'), '31');
      assert.equal(sql(c, 'negD', 'SELECT count(*) FROM audit_logs;'), '61');

      // APPLY clean (fullB) ----------------------------------------------------
      const repairB = randomUUID();
      const preHashB = sql(c, 'fullB', ROWHASH);
      psqlFile(c, 'fullB', APPLY, {
        repair_id: repairB, backup_id: 'TEST-fullB',
        backup_sha: '0123456789abcdef'.repeat(4),
        procedure_version: PROCV, reason: REASON,
      });
      assert.equal(sql(c, 'fullB', 'SELECT COALESCE(sum(initial_balance_cents),0) FROM accounts;'), '310000');
      assert.equal(sql(c, 'fullB', `SELECT count(*) FROM accounts a WHERE a.deleted_at IS NULL AND a.balance_cents <> a.initial_balance_cents + COALESCE((SELECT sum(CASE WHEN t.kind = 'income' THEN t.amount_cents WHEN t.kind = 'expense' THEN -t.amount_cents WHEN t.kind = 'transfer' AND t.transfer_to_account_id = a.id THEN t.amount_cents WHEN t.kind = 'transfer' THEN -t.amount_cents ELSE 0 END) FROM transactions t WHERE (t.account_id = a.id OR t.transfer_to_account_id = a.id) AND t.deleted_at IS NULL),0);`), '0');
      assert.equal(sql(c, 'fullB', 'SELECT COALESCE(sum(balance_cents),0) FROM accounts;'), '306300');
      assert.equal(sql(c, 'fullB', ROWHASH), preHashB);
      assert.equal(sql(c, 'fullB', 'SELECT count(*) FROM audit_logs;'), '63');
      // REAL shared verify.sql after apply (not mock) --------------------------
      const vB = rowsOf(docker(['exec', '-i', c, 'psql', '-v', 'ON_ERROR_STOP=1',
        '-U', 'postgres', '-d', 'fullB', '-tA', '-F~',
        '-v', 'mode=apply', '-v', `repair_id=${repairB}`],
        { input: readFileSync(VERIFY) }).trim());
      assert.deepEqual(vB, {
        mode: 'apply',
        anchors_10000: '31', residual: '0', sum_bal: '306300', sum_tx: '3700',
        audit_rows: '2', audit_workspaces: '2', one_per_hh_bad: '0',
        hh_counts_bad: '0', meta_len_bad: '0',
        ids_acct_not_audit: '0', ids_audit_not_acct: '0',
      });
      const meta = JSON.parse(sql(c, 'fullB', `SELECT metadata::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' LIMIT 1;`));
      assert.equal(meta.repairId, repairB);
      assert.equal(meta.backupId, 'TEST-fullB');
      assert.equal(meta.procedureVersion, PROCV);
      assert.equal(meta.anchorValueCents, 10000);
      assert.equal(meta.perAccount.length, meta.accountCount);
      assert.equal(meta.preLedgerHash, 'a153163d334bacc4d4f1dc9c90a8fe3b');
      assert.equal(meta.postLedgerHash, 'a153163d334bacc4d4f1dc9c90a8fe3b');
      assert.equal(meta.ledgerRowCount, 28);
      assert.equal(sql(c, 'fullB', `SELECT DISTINCT actor_type FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill';`), 'user');

      // NEGATIVE compensate: tampered post-repair row => REFUSE ----------------
      const victimB = sql(c, 'fullB', 'SELECT id FROM accounts LIMIT 1;');
      sql(c, 'fullB', `UPDATE accounts SET balance_cents = balance_cents + 1 WHERE id = '${victimB}';`);
      assert.throws(() => psqlFile(c, 'fullB', COMPENSATE, {
        repair_id: repairB, procedure_version: PROCV, reason: REASON,
      }), /rowhash mismatch/);
      assert.equal(sql(c, 'fullB', 'SELECT count(*) FROM accounts WHERE initial_balance_cents = 10000;'), '31');
      assert.equal(sql(c, 'fullB', 'SELECT count(*) FROM audit_logs;'), '63');

      // CLEAN compensate (cleanC): apply then compensate -----------------------
      const repairC = randomUUID();
      psqlFile(c, 'cleanC', APPLY, {
        repair_id: repairC, backup_id: 'TEST-cleanC',
        backup_sha: 'fedcba9876543210'.repeat(4),
        procedure_version: PROCV, reason: REASON,
      });
      psqlFile(c, 'cleanC', COMPENSATE, {
        repair_id: repairC, procedure_version: PROCV, reason: REASON,
      });
      assert.equal(sql(c, 'cleanC', 'SELECT count(*) FROM accounts WHERE initial_balance_cents = 0;'), '31');
      assert.equal(sql(c, 'cleanC', 'SELECT count(*) FROM audit_logs;'), '65');
      // Post-compensate resolve: committed+compensated present, anchors back
      // to 0, ledger + financial + stripped fingerprints stable (original).
      const rcc = rowsOf(psqlFile(c, 'cleanC', RESOLVE,
        { repair_id: repairC, lock_timeout: '10s' }, ['-tA', '-F~']).trim());
      assert.equal(rcc.committed, '2');
      assert.equal(rcc.compensated, '2');
      assert.equal(rcc.anchors_0, '31');
      assert.equal(rcc.ledger_hash, 'a153163d334bacc4d4f1dc9c90a8fe3b');
      assert.equal(rcc.accounts_financial, '8d6b43de8b47ef657855c29877d58a56');
      assert.equal(rcc.accounts_stripped, '086c71be201609cf1952a28788e7b31e');
      assert.equal(sql(c, 'cleanC', `SELECT count(*) FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated' AND metadata->>'compensatesRepairId' = '${repairC}';`), '2');
      assert.equal(sql(c, 'cleanC', 'SELECT COALESCE(sum(balance_cents),0) FROM accounts;'), '306300');
      // REAL shared verify.sql after compensate --------------------------------
      const vC = rowsOf(docker(['exec', '-i', c, 'psql', '-v', 'ON_ERROR_STOP=1',
        '-U', 'postgres', '-d', 'cleanC', '-tA', '-F~',
        '-v', 'mode=compensate', '-v', `repair_id=${repairC}`],
        { input: readFileSync(VERIFY) }).trim());
      assert.deepEqual(vC, {
        mode: 'compensate',
        anchors_0: '31', sum_bal: '306300', sum_tx: '3700',
        comp_rows: '2', comp_workspaces: '2', comp_one_per_hh_bad: '0',
      });
      assert.throws(() => psqlFile(c, 'cleanC', COMPENSATE, {
        repair_id: repairC, procedure_version: PROCV, reason: REASON,
      }), /already compensated/);

      // SAMEID CAS: re-apply with an already-recorded repairId => refuse ------
      assert.throws(() => psqlFile(c, 'cleanC', APPLY, {
        repair_id: repairC, backup_id: 'TEST-cleanC-retry',
        backup_sha: 'fedcba9876543210'.repeat(4),
        procedure_version: PROCV, reason: REASON,
      }), /already recorded/);
      assert.equal(sql(c, 'cleanC', 'SELECT count(*) FROM audit_logs;'), '65');

      // TWO-CONNECTION resolve barrier ---------------------------------------
      // resA: holder TX keeps the repair tables locked; resolve with a short
      // bound must TIME OUT (proves the barrier waits instead of deciding).
      docker(['exec', '-d', c, 'psql', '-U', 'postgres', '-d', 'resA', '-Atc',
        'BEGIN; LOCK TABLE accounts, transactions, operation_records, audit_logs IN SHARE ROW EXCLUSIVE MODE; SELECT pg_sleep(25); ROLLBACK;']);
      await new Promise((r) => setTimeout(r, 4000)); // let the holder take locks
      const tmo = psqlFileSoft(c, 'resA', RESOLVE,
        { repair_id: randomUUID(), lock_timeout: '5s' }, ['-tA', '-F~']);
      assert.notEqual(tmo.code, 0, 'resolve must fail while locks are held');
      assert.match(tmo.out, /lock timeout/i, 'failure must be the bounded lock timeout');
      // resB: real apply, then resolve must detect COMMITTED with ledger match.
      const repairR = randomUUID();
      psqlFile(c, 'resB', APPLY, {
        repair_id: repairR, backup_id: 'TEST-resB',
        backup_sha: '0123456789abcdef'.repeat(4),
        procedure_version: PROCV, reason: REASON,
      });
      const rb = rowsOf(psqlFile(c, 'resB', RESOLVE,
        { repair_id: repairR, lock_timeout: '10s' }, ['-tA', '-F~']).trim());
      assert.equal(rb.committed, '2');
      assert.equal(rb.anchors_10000, '31');
      assert.equal(rb.ledger_hash, rb.recorded_post_ledger);
      assert.equal(rb.ledger_n, '28');
      // Post-apply: financial hash stable; stripped hash ALSO stable (only
      // anchor + trigger-bumped updated_at differ, both excluded) — proving
      // the update touched nothing else. Rename-sensitivity of stripped is
      // covered by pristine/compensate equality + wrapper tamper blocks.
      assert.equal(rb.accounts_financial, '8d6b43de8b47ef657855c29877d58a56');
      assert.equal(rb.accounts_stripped, '086c71be201609cf1952a28788e7b31e');
      // resC: pristine DB, resolve must detect ROLLED-BACK/original state.
      const rc = rowsOf(psqlFile(c, 'resC', RESOLVE,
        { repair_id: randomUUID(), lock_timeout: '10s' }, ['-tA', '-F~']).trim());
      assert.equal(rc.committed, '0');
      assert.equal(rc.compensated, '0');
      assert.equal(rc.anchors_0, '31');
      assert.equal(rc.sum_bal, '306300');
      // Original fingerprint exact: ledger + financial + stripped.
      assert.equal(rc.ledger_hash, 'a153163d334bacc4d4f1dc9c90a8fe3b');
      assert.equal(rc.ledger_n, '28');
      assert.equal(rc.accounts_financial, '8d6b43de8b47ef657855c29877d58a56');
      assert.equal(rc.accounts_stripped, '086c71be201609cf1952a28788e7b31e');
    } finally {
      try { docker(['rm', '-f', c]); } catch { /* best effort */ }
    }
  });
