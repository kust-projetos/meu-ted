import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REHEARSE = readFileSync(resolve(HERE, 'rehearse-canonical-conversion.mjs'), 'utf8');
const ANON = readFileSync(resolve(HERE, 'anonymize-pg-copy.sql'), 'utf8');

// --- F2-R1: random per-run DB password (reviewer P2: static 'rehearse' default) ---
test('F2-R1 no static default DB password: fresh random per run, still overridable, never logged', () => {
  assert.doesNotMatch(
    REHEARSE,
    /REHEARSE_DB_PASSWORD\s*\?\?\s*['"]rehearse['"]/,
    'static default password must be gone',
  );
  assert.match(REHEARSE, /randomBytes/, 'password must be generated per run via randomBytes');
  assert.match(REHEARSE, /REHEARSE_DB_PASSWORD/, 'env override must stay supported');
  assert.match(REHEARSE, /POSTGRES_PASSWORD=<redacted>/, 'docker run log line must stay redacted');
  assert.doesNotMatch(REHEARSE, /log\([^;]*DB_PASSWORD/, 'DB password must never flow through logging');
});

// --- F2-R2: Better-Auth account.accountId pseudonymized (reviewer P2: external PII) ---
test('F2-R2 Better-Auth account.accountId is pseudonymized with the per-scrub keyed salt (uniqueness/joins preserved)', () => {
  // The external provider identity must be remapped, not passed through.
  assert.match(
    ANON,
    /UPDATE\s+public\.account[\s\S]{0,1500}?"accountId"/,
    'must remap public.account."accountId"',
  );
  // Keyed (non-reversible) mapping, like the idempotency-key scrub.
  assert.match(
    ANON,
    /hmac\s*\([\s\S]{0,200}?"accountId"/,
    'accountId mapping must use keyed hmac (not a reversible unkeyed hash)',
  );
  // Same shared per-scrub salt: equality preserved within the export.
  assert.match(ANON, /_anon_idem_salt/, 'must reuse the shared per-scrub salt (equality within export)');
  // Join keys untouched: PK id and FK user_id are not rewritten; providerId stays raw (fixed keys, not PII).
  const acctUpdate = ANON.match(/UPDATE\s+public\.account\s+AS\s+\w+[\s\S]*?;/)?.[0] ?? '';
  assert.ok(acctUpdate.length > 0, 'account UPDATE block must exist');
  assert.doesNotMatch(acctUpdate, /user_id\s*=/i, 'must not rewrite the user_id join key');
  assert.doesNotMatch(acctUpdate, /SET\s+"id"\s*=/, 'must not rewrite the PK (quoted)');
  assert.doesNotMatch(acctUpdate, /SET\s+id\s*=/, 'must not rewrite the PK (unquoted)');
  // Explicitly handled: safety net must not double-scrub, residual gate must cover it pre-COMMIT.
  assert.match(ANON, /account\.accountId/, 'explicitly-handled column must be listed (safety-net exclusion)');
  const preCommit = ANON.slice(0, ANON.indexOf('COMMIT;'));
  assert.match(
    preCommit,
    /accountId[\s\S]{0,300}anon-acct-|anon-acct-[\s\S]{0,300}accountId/i,
    'pre-commit residual gate must verify accountId was scrubbed',
  );
});

// --- F2-R3: real-dump child failures sanitized (reviewer P2: raw err.stdout/stderr) ---
test('F2-R3 real-dump child failures are sanitized: status + byte counts, no raw stdout/stderr', async () => {
  const mod = await import('./rehearse-canonical-conversion.mjs');
  assert.equal(typeof mod.childFailureSummary, 'function', 'childFailureSummary helper must exist');
  const SENTINEL = 'SENTINEL_PII_f2r3_9f8e7d6c_STDOUT';
  const summary = mod.childFailureSummary('conversion', {
    status: 1,
    stdout: `report ${SENTINEL} details`,
    stderr: `err ${SENTINEL}`,
    message: 'x',
  });
  assert.match(summary, /exit 1/, 'must carry the numeric status');
  assert.match(summary, /withheld/i, 'must state output was withheld');
  assert.ok(!summary.includes(SENTINEL), 'must not carry raw child output');
  // No raw child output interpolated at the PII-carrying failure sites.
  assert.doesNotMatch(REHEARSE, /fail\(`conversion exited/, 'conversion failure must not interpolate raw stdout/stderr');
  assert.doesNotMatch(REHEARSE, /fail\(`preflight exited/, 'preflight failure must not interpolate raw stdout/stderr');
  assert.doesNotMatch(REHEARSE, /fail\(`dry-run exited/, 'dry-run failure must not interpolate raw stdout/stderr');
  assert.doesNotMatch(REHEARSE, /fail\(`rerun exited/, 'rerun failure must not interpolate raw stdout/stderr');
  assert.doesNotMatch(
    REHEARSE,
    /legacy baseline household=\$\{household\} errored[^`]*\$\{err\.stderr/,
    'legacy-baseline failure must not interpolate raw stderr',
  );
  assert.doesNotMatch(
    REHEARSE,
    /without a parseable report:[^`]*\$\{raw\}/,
    'recon failure must not interpolate the raw report',
  );
});

// --- F2-R4: API subprocess timeout covers the 600s migration budget (reviewer P2: 300s vs 600s) ---
test('F2-R4 API subprocess timeout covers the 600s migration budget (not 300s)', () => {
  assert.match(REHEARSE, /timeout:\s*600_000/, 'runApi must allow 600s for migrations/conversion');
  assert.doesNotMatch(REHEARSE, /timeout:\s*300_000/, 'old 300s cap must be gone');
});

// --- F2-R5: F2 technical pass distinct from F3 readiness (reviewer P2: no blanket releaseReady) ---
test('F2-R5 F2 technical pass is distinct from F3 readiness: accepted deltas block F3 (no retroactive approval)', async () => {
  const mod = await import('./rehearse-canonical-conversion.mjs');
  assert.equal(typeof mod.evaluateF3Readiness, 'function', 'evaluateF3Readiness helper must exist');
  assert.deepEqual(mod.evaluateF3Readiness([]), { f2TechnicalPass: true, f3Ready: true, acceptedCount: 0 });
  const r = mod.evaluateF3Readiness([{ code: 'statement_payment:payment_coverage_gap', legacy: 1, canonical: 6 }]);
  assert.equal(r.f2TechnicalPass, true, 'F2 stays a technical pass');
  assert.equal(r.f3Ready, false, 'F3 is NOT ready while accepted deltas remain');
  assert.equal(r.acceptedCount, 1);
  assert.match(REHEARSE, /F3 NOT READY/, 'script must log the F3-not-ready verdict');
  assert.match(REHEARSE, /f3Ready/, 'evidence must carry the F3 readiness flag');
  assert.match(REHEARSE, /DECISION-REQUIRED/, 'accepted deltas must stay DECISION-REQUIRED (no silent approval)');
});
