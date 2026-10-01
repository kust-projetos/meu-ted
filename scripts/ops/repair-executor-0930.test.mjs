// repair-executor-0930.test.mjs
// Wrapper-branch tests for scripts/ops/repair-executor-0930.ps1 (portable path,
// resolved next to this file) using a fake ssh shim (batch) + local health HTTP
// server. No production contact: every ssh invocation is answered by canned
// scenario files, and the health URL points at 127.0.0.1. Covers guard
// READY/NOT-READY, repair happy path, SHA refusal (no stop), transport
// uncertainty resolve (committed / rolled-back / blocked-partial / timeout),
// and compensate preflight. The executor itself is NEVER run against production
// here. The SQL it replays (verify.sql) is separately proven REAL by
// anchor-backfill-20260930.test.mjs on restored PG; canned rows below mirror
// that exact shape only to drive wrapper branching.
// PLATFORM: requires Windows (PowerShell 5.1 + .cmd shim). Non-Windows runners
// explicitly SKIP with a message (a skip is not proof; CI must show it).
// Run: node --test scripts/ops/repair-executor-0930.test.mjs
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTOR = resolve(HERE, 'repair-executor-0930.ps1');
const API_SHA = 'testapisha000000000000000000000000000001';
const BACKUP_SHA = '0123456789abcdef'.repeat(4);
const GUARDS_OK = [
  'accounts_total~31~31~t', 'anchors_zero~31~31~t', 'balances_sum~306300~306300~t',
  'opening_invariant~31~31~t', 'source_create_31~31~31~t',
  'source_hash~c30e17441d7899283182684a59099d7d~c30e17441d7899283182684a59099d7d~t',
  'source_id_hh_match~31~31~t', 'source_temporal_31~31~31~t',
  'tx_count~28~28~t', 'tx_non_expense~0~0~t', 'tx_orphan~0~0~t',
  'tx_sum~3700~3700~t', 'tx_transfer_ref~0~0~t',
].join('\n') + '\n';
const POSTVERIFY_OK = [
  'mode~apply', 'anchors_10000~31', 'residual~0', 'sum_bal~306300', 'sum_tx~3700',
  'audit_rows~2', 'audit_workspaces~2', 'one_per_hh_bad~0', 'hh_counts_bad~0',
  'meta_len_bad~0', 'ids_acct_not_audit~0', 'ids_audit_not_acct~0',
].join('\n') + '\n';
const POSTVERIFY_BAD = [
  'mode~apply', 'anchors_10000~31', 'residual~5', 'sum_bal~306300', 'sum_tx~3700',
  'audit_rows~2', 'audit_workspaces~2', 'one_per_hh_bad~0', 'hh_counts_bad~0',
  'meta_len_bad~0', 'ids_acct_not_audit~0', 'ids_audit_not_acct~0',
].join('\n') + '\n';
const RESOLVE_COMMITTED = [
  'anchors_0~0', 'anchors_10000~31', 'committed~2', 'compensated~0',
  'ledger_hash~a153163d334bacc4d4f1dc9c90a8fe3b', 'ledger_n~28',
  'accounts_financial~8d6b43de8b47ef657855c29877d58a56',
  'accounts_stripped~11111111111111111111111111111111',
  'recorded_post_ledger~a153163d334bacc4d4f1dc9c90a8fe3b',
  'recorded_post_rowhash~8d6b43de8b47ef657855c29877d58a56',
  'sum_bal~306300', 'sum_tx~3700',
].join('\n') + '\n';
const RESOLVE_ORIGINAL = [
  'anchors_0~31', 'anchors_10000~0', 'committed~0', 'compensated~0',
  'ledger_hash~a153163d334bacc4d4f1dc9c90a8fe3b', 'ledger_n~28',
  'accounts_financial~8d6b43de8b47ef657855c29877d58a56',
  'accounts_stripped~086c71be201609cf1952a28788e7b31e',
  'recorded_post_ledger~none', 'recorded_post_rowhash~none',
  'sum_bal~306300', 'sum_tx~3700',
].join('\n') + '\n';
const RESOLVE_TIMEOUT_ERR = 'ERROR:  canceling statement due to lock timeout\n';
const COMP_PRE_OK = ['anchors_10000~31', 'committed~2', 'compensated~0'].join('\n') + '\n';
const COMP_PRE_BAD = ['anchors_10000~0', 'committed~0', 'compensated~0'].join('\n') + '\n';

const SHIM = `@echo off
set ARGS=%*
echo %ARGS% | findstr /C:"docker stop" >nul && echo 1>"%FAKE_FLAGS%\\stop.called"
echo %ARGS% | findstr /C:"docker start" >nul && echo 1>"%FAKE_FLAGS%\\start.called"
set /p N=<"%FAKE_CTR%" 2>nul
if "%N%"=="" set N=0
set /a N+=1
>"%FAKE_CTR%" echo %N%
set R=%FAKE_RESP%\\%FAKE_SCENARIO%-%N%.txt
if exist "%R%" type "%R%"
set E=%FAKE_RESP%\\%FAKE_SCENARIO%-%N%.exit
if exist "%E%" (for /f "usebackq delims=" %%v in ("%E%") do exit /b %%v)
exit /b 0
`;

const ctx = {};
test.before(() => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'repair-exec-'));
  ctx.resp = join(ctx.dir, 'resp'); mkdirSync(ctx.resp);
  ctx.flags = join(ctx.dir, 'flags'); mkdirSync(ctx.flags);
  ctx.manifests = join(ctx.dir, 'manifests'); mkdirSync(ctx.manifests);
  ctx.shim = join(ctx.dir, 'fake-ssh.cmd');
  writeFileSync(ctx.shim, SHIM);
  ctx.server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', gitSha: API_SHA }));
  });
  return new Promise((resolveP) => ctx.server.listen(0, '127.0.0.1', resolveP));
});
test.after(() => {
  ctx.server.close();
  rmSync(ctx.dir, { recursive: true, force: true });
});

function winOnly(t) {
  if (process.platform !== 'win32') {
    t.skip('requires Windows PowerShell 5.1 + fake ssh.cmd; non-Windows must NOT claim wrapper proof');
    return false;
  }
  return true;
}
function setScenario(name, responses) {
  for (const f of readdirSync(ctx.resp)) rmSync(join(ctx.resp, f), { force: true });
  responses.forEach((r, i) => {
    writeFileSync(join(ctx.resp, `${name}-${i + 1}.txt`), r.text ?? '');
    if (r.exit !== undefined) writeFileSync(join(ctx.resp, `${name}-${i + 1}.exit`), String(r.exit));
  });
  for (const f of readdirSync(ctx.flags)) rmSync(join(ctx.flags, f), { force: true });
  writeFileSync(join(ctx.dir, 'ctr.txt'), '0');
}
function runExec(args, scenario) {
  // Async: the child calls back into this process's health server.
  const env = {
    ...process.env, FAKE_CTR: join(ctx.dir, 'ctr.txt'),
    FAKE_RESP: ctx.resp, FAKE_FLAGS: ctx.flags, FAKE_SCENARIO: scenario,
  };
  return new Promise((resolveP) => {
    execFile('powershell',
      ['-NoProfile', '-File', EXECUTOR, '-SshExe', ctx.shim,
        '-ApiHealthUrl', `http://127.0.0.1:${ctx.server.address().port}/health`,
        '-ManifestDir', ctx.manifests, ...args],
      { encoding: 'utf8', env, timeout: 90000 },
      (err, stdout, stderr) => {
        // NOTE: on this Node/Windows combo the child exit code arrives as
        // numeric err.code (err.status undefined); spawn failures use strings.
        const code = (err && typeof err.status === 'number') ? err.status
          : (err && typeof err.code === 'number') ? err.code : 1;
        if (err) resolveP({ exit: code, out: (stdout ?? '') + (stderr ?? '') });
        else resolveP({ exit: 0, out: stdout });
      });
  });
}
function manifests() {
  return readdirSync(ctx.manifests)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ctx.manifests, f), 'utf8')));
}
function clearManifests() {
  for (const f of readdirSync(ctx.manifests)) rmSync(join(ctx.manifests, f), { force: true });
}
const flag = (n) => existsSync(join(ctx.flags, n));
const PS_RUNNING = 'CONTAINER ID  NAMES\nabc  pi-finance-api\n';
const PS_STOPPED = 'CONTAINER ID  NAMES\n';

test('guard mode READY when implementation present and guards green', async (t) => {
  if (!winOnly(t)) return;
  setScenario('ready', [{ text: GUARDS_OK }]);
  const r = await runExec([], 'ready');
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /READY \(guard-only mode\)/);
});

test('guard mode NOT-READY when a guard fails', async (t) => {
  if (!winOnly(t)) return;
  setScenario('notready', [{ text: GUARDS_OK.replace('anchors_zero~31~31~t', 'anchors_zero~0~31~f') }]);
  const r = await runExec([], 'notready');
  assert.equal(r.exit, 11, r.out);
  assert.match(r.out, /NOT-READY/);
});

test('repair happy path: manifest candidate_pass + owned restart', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  const rid = randomUUID();
  setScenario('repok', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: `NOTICE: anchor-backfill OK repair=${rid} src=c30e17441d7899283182684a59099d7d\n` },
    { text: POSTVERIFY_OK },
    { text: 'pi-finance-api\n' },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', rid,
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'repok');
  assert.equal(r.exit, 0, r.out);
  assert.ok(flag('stop.called'), 'owned stop must run');
  assert.ok(flag('start.called'), 'owned restart must run on pass');
  const ms = manifests();
  assert.equal(ms.length, 1);
  assert.equal(ms[0].outcome, 'candidate_pass');
  assert.equal(ms[0].repairId, rid);
});

test('repair refused on backup SHA mismatch: no stop', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  setScenario('refsha', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${'ff'.repeat(32)}  /home/deploy/infra/backup/x.dump\n` },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', randomUUID(),
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'refsha');
  assert.notEqual(r.exit, 0);
  assert.ok(!flag('stop.called'), 'must not stop on refusal');
});

test('uncertain transport + barrier committed => resolved-complete + restart', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  const rid = randomUUID();
  setScenario('uncok', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: '', exit: 1 },
    { text: RESOLVE_COMMITTED },
    { text: POSTVERIFY_OK },
    { text: 'pi-finance-api\n' },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', rid,
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'uncok');
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /RESOLVED-COMPLETE/);
  assert.ok(flag('start.called'));
  assert.equal(manifests()[0].outcome, 'resolved-complete');
});

test('uncertain transport + barrier original => rolled-back-confirmed + restart', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  setScenario('uncrb', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: '', exit: 1 },
    { text: RESOLVE_ORIGINAL },
    { text: 'pi-finance-api\n' },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', randomUUID(),
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'uncrb');
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /RESOLVED-ROLLED-BACK/);
  assert.ok(flag('start.called'));
  assert.equal(manifests()[0].outcome, 'rolled-back-confirmed');
});

test('uncertain transport + committed but post-verify bad => BLOCKED, stopped, no retry', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  setScenario('uncbl', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: '', exit: 1 },
    { text: RESOLVE_COMMITTED },
    { text: POSTVERIFY_BAD },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', randomUUID(),
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'uncbl');
  assert.equal(r.exit, 30, r.out);
  assert.match(r.out, /BLOCKED-partial/);
  assert.ok(!flag('start.called'), 'must NOT restart when blocked');
  assert.equal(manifests()[0].outcome, 'BLOCKED-partial');
});

test('uncertain transport + barrier lock timeout => BLOCKED-timeout, stopped, no retry', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  setScenario('uncto', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: '', exit: 1 },
    { text: RESOLVE_TIMEOUT_ERR, exit: 3 },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', randomUUID(),
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'uncto');
  assert.equal(r.exit, 31, r.out);
  assert.match(r.out, /BLOCKED-timeout/);
  assert.ok(!flag('start.called'), 'must NOT restart on timeout');
  assert.equal(manifests()[0].outcome, 'BLOCKED-timeout');
});

test('uncertain transport + same-sum ledger tamper => BLOCKED-uncertain, no restart', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  // committed=0, sums/counts intact, but ledger hash differs (description swap).
  const tampered = RESOLVE_ORIGINAL.replace(
    'ledger_hash~a153163d334bacc4d4f1dc9c90a8fe3b',
    'ledger_hash~ffffffffffffffffffffffffffffffff');
  setScenario('unctamper', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: '', exit: 1 },
    { text: tampered },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', randomUUID(),
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'unctamper');
  assert.equal(r.exit, 30, r.out);
  assert.match(r.out, /BLOCKED-uncertain/);
  assert.ok(!flag('start.called'), 'must NOT restart on tamper-block');
  assert.equal(manifests()[0].outcome, 'BLOCKED-uncertain');
});

test('uncertain transport + same-sum account tamper (rename) => BLOCKED-uncertain, no restart', async (t) => {
  if (!winOnly(t)) return;
  clearManifests();
  // Ledger intact, sums intact, but accounts financial hash differs.
  const tampered = RESOLVE_ORIGINAL.replace(
    'accounts_financial~8d6b43de8b47ef657855c29877d58a56',
    'accounts_financial~eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  setScenario('unctamperacct', [
    { text: GUARDS_OK },
    { text: API_SHA + '\n' },
    { text: `${BACKUP_SHA}  /home/deploy/infra/backup/x.dump\n` },
    { text: PS_RUNNING },
    { text: 'pi-finance-api\n' },
    { text: '', exit: 1 },
    { text: tampered },
  ]);
  const r = await runExec(['-ExecuteRepair', '-RepairId', randomUUID(),
    '-ExpectedApiSha', API_SHA, '-ExpectedBackupSha', BACKUP_SHA,
    '-ConfirmPhrase', 'ANCHOR-31-10000'], 'unctamperacct');
  assert.equal(r.exit, 30, r.out);
  assert.match(r.out, /BLOCKED-uncertain/);
  assert.ok(!flag('start.called'), 'must NOT restart on tamper-block');
  assert.equal(manifests()[0].outcome, 'BLOCKED-uncertain');
});

test('compensate preflight READY and NOT-READY (read-only)', async (t) => {
  if (!winOnly(t)) return;
  const rid = randomUUID();
  setScenario('comppre', [{ text: COMP_PRE_OK }]);
  const ok = await runExec(['-Compensate', rid], 'comppre');
  assert.equal(ok.exit, 0, ok.out);
  assert.match(ok.out, /READY-COMPENSATE/);
  setScenario('comppre', [{ text: COMP_PRE_BAD }]);
  const bad = await runExec(['-Compensate', rid], 'comppre');
  assert.equal(bad.exit, 12, bad.out);
  assert.match(bad.out, /NOT-READY-COMPENSATE/);
});
