# repair-executor-0930.ps1 — versionable executor for anchor-backfill-20260930.
# Lives in scripts/ops/ next to the procedures it drives (apply/compensate/
# guards/verify/resolve .sql). Modes:
#   (default) Guard mode: READ-ONLY (guards.sql). READY only if implementation
#             files exist AND all guards pass.
#   -Compensate <id> (alone): read-only compensate preflight (anchors=10000,
#             2 committed audits, 0 compensated for the repairId).
#   -ExecuteRepair ... : full mutation protocol (API SHA check, server backup
#             SHA check, owned stop of pi-finance-api ONLY, procedure via stdin,
#             mode-aware post-verify from verify.sql, manifest, conditional
#             owned restart). With -Compensate <id> runs compensation.
# Uncertainty rule: a transport failure after a possible commit NEVER claims
# rollback. Resolve-Uncertain takes the resolve.sql transaction BARRIER (bounded
# lock wait on the same tables => any concurrent repair TX has finished), then
# maps the stable snapshot: original => confirmed rollback; full post-state =>
# confirmed commit (+ post-verify); lock timeout or anything else => BLOCKED,
# API stays stopped, NO RETRY. Restart happens ONLY on confirmed-rollback or
# post-verified complete.
# Roots/SSH are parameters (no new credentials). DEPLOYMENT IDENTITY IS
# MANDATORY AND NEVER HARDCODED: pass -SshKey / -SshRemote explicitly, or
# export PI_VPS_SSH_KEY / PI_VPS_SSH_REMOTE in the caller environment (loaded
# by the caller from its private ../vps-hostinger.env). Values are never
# printed and never committed. Missing/invalid identity fails closed (exit 13)
# before any SSH, in every mode including read-only guard mode.
# Real Planner invocation (values stay in the operator shell):
#   $env:PI_VPS_SSH_KEY = '<from private env>'; $env:PI_VPS_SSH_REMOTE = '<user@host>'
#   .\repair-executor-0930.ps1 -ExecuteRepair -RepairId <uuid> ...
# Field separator for psql -F is a quoted tilde (a bare pipe breaks cmd/sh
# quoting; a bare tilde would be $HOME-expanded by remote bash).
param(
  [switch]$ExecuteRepair,
  [string]$Compensate = '',
  [string]$RepairId = '',
  [string]$ExpectedApiSha = '',
  [string]$ExpectedBackupSha = '',
  [string]$ConfirmPhrase = '',
  [string]$SshExe = 'ssh.exe',
  [string]$SshKey = '',
  [string]$SshRemote = '',
  [string]$DbName = 'pi_financeiro_canonical',
  [string]$BackupId = 'pi-canonical-20260930T194523Z',
  [string]$BackupPath = '',
  [string]$ApiContainer = 'pi-finance-api',
  [string]$DbContainer = 'pi-finance-postgres',
  [string]$ApiHealthUrl = 'https://api.synkroo.com.br/health',
  [string]$ManifestDir = '',
  [string]$ResolveLockTimeout = '30s',
  [string]$ExpectedLedgerHash = 'a153163d334bacc4d4f1dc9c90a8fe3b',
  [string]$ExpectedAccountsFinancialHash = '8d6b43de8b47ef657855c29877d58a56',
  [string]$ExpectedAccountsStrippedHash = '086c71be201609cf1952a28788e7b31e'
)
$ErrorActionPreference = 'Stop'

if ($BackupPath -eq '') { $BackupPath = "/home/deploy/infra/backup/$BackupId.dump" }
$ImplApply = Join-Path $PSScriptRoot 'anchor-backfill-20260930.apply.sql'
$ImplComp = Join-Path $PSScriptRoot 'anchor-backfill-20260930.compensate.sql'
$ImplGuards = Join-Path $PSScriptRoot 'anchor-backfill-20260930.guards.sql'
$ImplVerify = Join-Path $PSScriptRoot 'anchor-backfill-20260930.verify.sql'
$ImplResolve = Join-Path $PSScriptRoot 'anchor-backfill-20260930.resolve.sql'
$ProcVer = 'anchor-backfill-20260930.executor@v5'
$Reason = 'closure-infra-0930-approved-anchor-repair'
$Sep = '~'
if ($ManifestDir -eq '') { $ManifestDir = "$env:TEMP\opencode" }
$isComp = $Compensate -ne ''
if ($isComp) { $RepairId = $Compensate }

# Mandatory deployment identity: explicit params win, else the named caller
# environment. No defaults exist on purpose (fail-closed exit 13, values never
# echoed). Every mode needs it, including read-only guard mode.
if ($SshKey -eq '') { $SshKey = $env:PI_VPS_SSH_KEY }
if ($SshRemote -eq '') { $SshRemote = $env:PI_VPS_SSH_REMOTE }
if ([string]::IsNullOrWhiteSpace($SshKey) -or [string]::IsNullOrWhiteSpace($SshRemote)) {
  Write-Output 'REFUSED: deployment identity required: pass -SshKey/-SshRemote or set PI_VPS_SSH_KEY/PI_VPS_SSH_REMOTE (caller-private, never printed).'
  exit 13
}
if ($SshRemote -notmatch '^[^@\s]+@[A-Za-z0-9.-]+$') {
  Write-Output 'REFUSED: -SshRemote/PI_VPS_SSH_REMOTE must look like user@host.'
  exit 13
}
if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) {
  Write-Output 'REFUSED: -SshKey/PI_VPS_SSH_KEY path does not exist.'
  exit 13
}

function Redact([string]$s) {
  return ($s -replace '(?i)(password|secret|token|passwd|pwd)\s*=\s*\S+', '$1=<redacted>')
}
function VpsSsh([string]$cmd) {
  $o = & $SshExe -i $SshKey -o BatchMode=yes -o ConnectTimeout=30 $SshRemote $cmd 2>&1
  if ($LASTEXITCODE -ne 0) { throw (Redact ('SSH FAILED: ' + ($o -join "`n"))) }
  return $o
}
function Invoke-PsqlStdin([string]$sqlText, [string[]]$extraArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $SshExe
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.Arguments = ((@('-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=120', $SshRemote,
      'docker', 'exec', '-i', $DbContainer, 'psql', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', $DbName) + $extraArgs) -join ' ')
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($sqlText)
  $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return @{ ExitCode = $p.ExitCode; Out = (Redact ($out + "`n" + $err)) }
}
function Split-Rows([string]$text) {
  $m = @{}
  foreach ($line in ($text -split "`n" | Where-Object { $_ -ne '' })) {
    $p = $line -split $Sep, 2
    if ($p.Count -eq 2) { $m[$p[0]] = $p[1] }
  }
  return $m
}
function Get-GuardRows {
  $sql = Get-Content -Raw -LiteralPath $ImplGuards
  $r = Invoke-PsqlStdin $sql @('-tA', '-F', "'~'")
  if ($r.ExitCode -ne 0) { throw ('GUARDS QUERY FAILED: ' + $r.Out) }
  return ($r.Out -split "`n" | Where-Object { $_ -ne '' })
}
function Invoke-PostVerify([string]$mode, [string]$repairId) {
  # Shared verify.sql (same file the contract test runs for real). Explicit
  # per-field expectations: two workspaces, one row each, counts 11/20,
  # perAccount lengths, exact ID sets both directions. No array comparison.
  $sql = Get-Content -Raw -LiteralPath $ImplVerify
  $r = Invoke-PsqlStdin $sql @('-tA', '-F', "'~'", '-v', "mode=$mode", '-v', "repair_id=$repairId")
  if ($r.ExitCode -ne 0) { throw ('POSTVERIFY QUERY FAILED: ' + $r.Out) }
  $m = Split-Rows $r.Out
  if ($m['mode'] -ne $mode) { return @{ Ok = $false; Rows = $m } }
  if ($mode -eq 'apply') {
    $ok = ($m['anchors_10000'] -eq '31') -and ($m['residual'] -eq '0') -and ($m['sum_bal'] -eq '306300') -and ($m['sum_tx'] -eq '3700') -and ($m['audit_rows'] -eq '2') -and ($m['audit_workspaces'] -eq '2') -and ($m['one_per_hh_bad'] -eq '0') -and ($m['hh_counts_bad'] -eq '0') -and ($m['meta_len_bad'] -eq '0') -and ($m['ids_acct_not_audit'] -eq '0') -and ($m['ids_audit_not_acct'] -eq '0')
  } else {
    $ok = ($m['anchors_0'] -eq '31') -and ($m['sum_bal'] -eq '306300') -and ($m['sum_tx'] -eq '3700') -and ($m['comp_rows'] -eq '2') -and ($m['comp_workspaces'] -eq '2') -and ($m['comp_one_per_hh_bad'] -eq '0')
  }
  return @{ Ok = $ok; Rows = $m }
}
function Invoke-CompensatePreflight([string]$repairId) {
  $q = "SELECT 'anchors_10000', count(*) FROM accounts WHERE initial_balance_cents = 10000 "
  $q += "UNION ALL SELECT 'committed', count(*) FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = '$repairId' "
  $q += "UNION ALL SELECT 'compensated', count(*) FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated' AND metadata->>'compensatesRepairId' = '$repairId'"
  $r = Invoke-PsqlStdin $q @('-tA', '-F', "'~'")
  if ($r.ExitCode -ne 0) { throw ('PREFLIGHT QUERY FAILED: ' + $r.Out) }
  $m = Split-Rows $r.Out
  $ok = ($m['anchors_10000'] -eq '31') -and ($m['committed'] -eq '2') -and ($m['compensated'] -eq '0')
  return @{ Ok = $ok; Rows = $m }
}
function Invoke-Resolve([string]$repairId) {
  # resolve.sql: bounded lock barrier on the repair tables, then a stable
  # snapshot. Returns @{ TimedOut; Rows }. A timeout means a concurrent repair
  # TX may still be running => caller must BLOCK (no decision, no restart).
  $sql = Get-Content -Raw -LiteralPath $ImplResolve
  $r = Invoke-PsqlStdin $sql @('-tA', '-F', "'~'", '-v', "repair_id=$repairId", '-v', "lock_timeout=$ResolveLockTimeout")
  if ($r.ExitCode -ne 0) {
    if ($r.Out -match 'lock timeout') { return @{ TimedOut = $true; Rows = @{} } }
    throw ('RESOLVE QUERY FAILED: ' + $r.Out)
  }
  return @{ TimedOut = $false; Rows = (Split-Rows $r.Out) }
}

$implOk = (Test-Path -LiteralPath $ImplApply) -and (Test-Path -LiteralPath $ImplComp) -and (Test-Path -LiteralPath $ImplGuards) -and (Test-Path -LiteralPath $ImplVerify) -and (Test-Path -LiteralPath $ImplResolve)
if (-not $implOk) { Write-Output 'NOT-READY: implementation files missing'; exit 10 }

if ($isComp -and -not $ExecuteRepair) {
  if ($RepairId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Preflight refused: RepairId must be uuid.' }
  $pre = Invoke-CompensatePreflight $RepairId
  $pre.Rows.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Output ("  " + $_.Name + "=" + $_.Value) }
  if ($pre.Ok) { Write-Output 'READY-COMPENSATE (preflight green, no writes).'; exit 0 }
  Write-Output 'NOT-READY-COMPENSATE (preflight failing, no writes).'; exit 12
}

if (-not $ExecuteRepair) {
  $rows = Get-GuardRows
  $bad = @($rows | Where-Object { $_ -notmatch '~t$' })
  Write-Output '--- guards ---'
  $rows | ForEach-Object { Write-Output $_ }
  if ($bad.Count -gt 0) { Write-Output 'NOT-READY: guards failing:'; $bad | ForEach-Object { Write-Output $_ }; exit 11 }
  Write-Output 'READY (guard-only mode). Implementation present, source guards green. No writes performed.'
  exit 0
}

if ($RepairId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Refused: RepairId must be uuid.' }
if ($ExpectedApiSha -eq '' -or $ExpectedBackupSha -eq '' -or $ConfirmPhrase -ne 'ANCHOR-31-10000') {
  throw 'Refused: ExpectedApiSha + ExpectedBackupSha + ConfirmPhrase required.'
}
if ($Reason -match "'") { throw 'Refused: reason quoting.' }
if ($Reason -match '\s') { throw 'Refused: reason must be space-free (flat argv).' }
$opFile = if ($isComp) { $ImplComp } else { $ImplApply }
$mode = if ($isComp) { 'compensate' } else { 'apply' }

if ($isComp) {
  $pre = Invoke-CompensatePreflight $RepairId
  if (-not $pre.Ok) { throw 'Refused: compensate preflight failing (need anchors=10000 + 2 committed + 0 compensated).' }
} else {
  $rows = Get-GuardRows
  $bad = @($rows | Where-Object { $_ -notmatch '~t$' })
  if ($bad.Count -gt 0) { throw 'Refused: pre-repair guards failing.' }
}

$buildSha = (VpsSsh "docker exec $ApiContainer printenv BUILD_SHA") -join ''
$health = (Invoke-RestMethod -Uri $ApiHealthUrl -TimeoutSec 20).gitSha
if ($buildSha -ne $ExpectedApiSha -or $health -ne $ExpectedApiSha) {
  throw "Refused: API SHA mismatch (container=$buildSha health=$health expected=$ExpectedApiSha)."
}
Write-Output "API SHA OK $ExpectedApiSha"

$sumLine = (VpsSsh "sha256sum $BackupPath") -join ''
$serverSha = ($sumLine -split '\s+')[0]
if ($serverSha -ne $ExpectedBackupSha) { throw 'Refused: server backup SHA mismatch.' }
Write-Output "BACKUP SHA OK $BackupPath"

$psOut = VpsSsh "docker ps --filter name=$ApiContainer"
$wasRunning = ($psOut -join "`n") -match [regex]::Escape($ApiContainer)
$ownedStop = $false
if ($wasRunning) {
  VpsSsh "docker stop $ApiContainer" | Out-Null
  $ownedStop = $true
  Write-Output "OWNED-STOP $ApiContainer"
} else {
  Write-Output "NO-BYPASS: $ApiContainer already stopped; will NOT restart it later."
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$manifest = [ordered]@{
  repairId = $RepairId; mode = $mode; backupId = $BackupId; backupSha = $serverSha
  apiSha = $ExpectedApiSha; ownedStop = $ownedStop; stamp = $stamp; procVer = $ProcVer
  outcome = 'unknown'
}
function Write-Manifest {
  $manifest | ConvertTo-Json -Depth 5 | Set-Content "$ManifestDir\repair-manifest-$stamp.json"
  Write-Output "MANIFEST $ManifestDir\repair-manifest-$stamp.json outcome=$($manifest.outcome)"
}
function Restart-IfOwned {
  if ($ownedStop) {
    VpsSsh "docker start $ApiContainer" | Out-Null
    Write-Output "OWNED-RESTART $ApiContainer"
  }
}
function Resolve-Uncertain {
  # Barrier first: locks prove any concurrent repair TX finished. Timeout or
  # anything else => BLOCKED, stopped, no retry.
  $res = Invoke-Resolve $RepairId
  if ($res.TimedOut) {
    $manifest.outcome = 'BLOCKED-timeout'
    Write-Manifest
    Write-Output 'BLOCKED-timeout: lock barrier timed out (repair TX may still run). API left stopped. NO RETRY.'
    exit 31
  }
  $s = $res.Rows
  # Full-fingerprint mapping. Counts/sums alone are NOT sufficient: a
  # same-sum content tamper (ledger description swap, account rename) must
  # BLOCK. Ledger is compared to the repair's RECORDED post hash (correct
  # repairId, not a static pre-repair const) for commit branches, and to the
  # known original constants for rollback branches.
  $finOkRecorded = ($s['accounts_financial'] -eq $s['recorded_post_rowhash']) -and ($s['recorded_post_rowhash'] -ne 'none')
  if ($isComp) {
    $committedFull = ($s['compensated'] -eq '2') -and ($s['anchors_0'] -eq '31') -and ($s['sum_bal'] -eq '306300') -and ($s['sum_tx'] -eq '3700') -and ($s['ledger_n'] -eq '28') -and ($s['ledger_hash'] -eq $s['recorded_post_ledger']) -and ($s['recorded_post_ledger'] -ne 'none') -and $finOkRecorded
    $rolledBack = ($s['compensated'] -eq '0') -and ($s['committed'] -eq '2') -and ($s['anchors_10000'] -eq '31') -and ($s['sum_bal'] -eq '306300') -and ($s['sum_tx'] -eq '3700') -and ($s['ledger_n'] -eq '28') -and ($s['ledger_hash'] -eq $s['recorded_post_ledger']) -and $finOkRecorded
  } else {
    $committedFull = ($s['committed'] -eq '2') -and ($s['anchors_10000'] -eq '31') -and ($s['sum_bal'] -eq '306300') -and ($s['sum_tx'] -eq '3700') -and ($s['ledger_n'] -eq '28') -and ($s['ledger_hash'] -eq $s['recorded_post_ledger']) -and ($s['recorded_post_ledger'] -ne 'none') -and $finOkRecorded
    $rolledBack = ($s['committed'] -eq '0') -and ($s['compensated'] -eq '0') -and ($s['anchors_0'] -eq '31') -and ($s['sum_bal'] -eq '306300') -and ($s['sum_tx'] -eq '3700') -and ($s['ledger_n'] -eq '28') -and ($s['ledger_hash'] -eq $ExpectedLedgerHash) -and ($s['accounts_financial'] -eq $ExpectedAccountsFinancialHash) -and ($s['accounts_stripped'] -eq $ExpectedAccountsStrippedHash)
  }
  if ($committedFull) {
    $post = Invoke-PostVerify $mode $RepairId
    if ($post.Ok) {
      $manifest.outcome = 'resolved-complete'
      Write-Manifest
      Restart-IfOwned
      Write-Output 'RESOLVED-COMPLETE (barrier + snapshot + post-verify green after transport failure).'
      exit 0
    }
    $manifest.outcome = 'BLOCKED-partial'
    Write-Manifest
    Write-Output 'BLOCKED-partial: post-state present but post-verify failing. API left stopped. NO RETRY.'
    exit 30
  }
  if ($rolledBack) {
    $manifest.outcome = 'rolled-back-confirmed'
    Write-Manifest
    Restart-IfOwned
    Write-Output 'RESOLVED-ROLLED-BACK (barrier + full original fingerprint, no audit rows).'
    exit 0
  }
  $manifest.outcome = 'BLOCKED-uncertain'
  Write-Manifest
  Write-Output 'BLOCKED-uncertain: ambiguous post-barrier snapshot. API left stopped. NO RETRY.'
  exit 30
}

try {
  $vars = @('-v', "repair_id=$RepairId", '-v', "procedure_version=$ProcVer", '-v', "reason=$Reason")
  if (-not $isComp) { $vars += @('-v', "backup_id=$BackupId", '-v', "backup_sha=$serverSha") }
  $sqlText = Get-Content -Raw -LiteralPath $opFile
  $r = Invoke-PsqlStdin $sqlText $vars
  if ($r.ExitCode -ne 0) {
    if ($r.Out -match 'ERROR:') {
      $manifest.outcome = 'failed-rolled-back'
      $manifest.error = $r.Out
      Write-Manifest
      Restart-IfOwned
      Write-Output 'FAILED-ROLLED-BACK (server-reported abort).'
      exit 20
    }
    Write-Output 'TRANSPORT FAILURE after possible commit; resolving via barrier (no retry).'
    Resolve-Uncertain
  }
  Write-Output $r.Out
  $post = Invoke-PostVerify $mode $RepairId
  if (-not $post.Ok) {
    $manifest.outcome = 'BLOCKED-partial'
    $manifest.post = ($post.Rows.GetEnumerator() | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ';'
    Write-Manifest
    Write-Output 'BLOCKED-partial: procedure exit 0 but post-verify failing. API left stopped. NO RETRY.'
    exit 30
  }
  $manifest.outcome = 'candidate_pass'
  Write-Manifest
  Restart-IfOwned
  Write-Output 'DONE candidate_pass'
} catch {
  $msg = Redact $_.Exception.Message
  if ($manifest.outcome -eq 'unknown') {
    $manifest.outcome = 'refused-pre-procedure'
    $manifest.error = $msg
    Write-Manifest
    Write-Output 'Pre-procedure failure: API left as-is for manual decision (no blind restart).'
  }
  throw
}
