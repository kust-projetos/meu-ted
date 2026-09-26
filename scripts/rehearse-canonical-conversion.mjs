#!/usr/bin/env node
/**
 * M5 canonical conversion rehearsal — end-to-end dry-run + conversion +
 * post-conversion validation against a disposable Postgres 17.
 *
 * Usage:
 *   node scripts/rehearse-canonical-conversion.mjs
 *   node scripts/rehearse-canonical-conversion.mjs --dump=<path-to-sql-or-sql.gz-dump>
 *
 * Env overrides (all optional):
 *   REHEARSE_CONTAINER - container name (default pi-finance-canonical-rehearsal)
 *   REHEARSE_PORT      - host port mapped to 5432 on loopback only (default 5436)
 *   REHEARSE_DB_PASSWORD - postgres password for host TCP auth (default: fresh 256-bit random per run)
 *   REHEARSE_DUMP_PATH - same as --dump=<path>: plain-SQL (.sql) or gzip (.sql.gz) dump for REAL-DUMP mode (auto-detected)
 *   KEEP_DB            - when set, the container is left running for inspection
 *
 * Modes:
 *   SYNTHETIC (default) — loads scripts/anonymized-dump.sql + fixture shim.
 *   REAL-DUMP (--dump / REHEARSE_DUMP_PATH) — loads the given dump
 *     (plain `.sql` or gzip `.sql.gz`, auto-detected by magic bytes;
 *     e.g. an anonymized PRODUCTION dump at its real migration level), skips
 *     the shim + V003 ledger row, ensures the _test_marker guard row, and
 *     reconciles EVERY converted household instead of the fixture baseline.
 *     REAL-DUMP verdicts come from the LEGACY-vs-CANONICAL signature gate
 *     (see CALIBRATION NOTE below), not from absolute zero-drift: the clone
 *     carries production drift (scrub artifacts, pre-existing gaps) that a
 *     faithful conversion must preserve, not erase.
 *
 * CALIBRATION NOTE (REAL-DUMP signature gate, F2 diagnosis 2026-09-26):
 *   After the restore + `_test_marker` bootstrap and BEFORE the conversion,
  *   the script runs `reconciliation --schema=legacy --household=<id>` per
  *   household on the clone and stores the LEGACY BASELINE signature
  *   (Map `check:kind` → count) PLUS the full finding objects
  *   (check/kind/entity/entityId/expected/actual/detail). After the
  *   conversion it runs the canonical recon per household the same way.
  *   Two gates run per household and EITHER can fail it (no F3 release on
  *   failure): the count-only signature gate below AND the per-entity
  *   identity gate (evaluateIdentityGate: same-grain findings must match
  *   by identity key `check:kind|entity:entityId` with equal
  *   expected/actual/detail — catches identity swaps and silent value
  *   changes the count gate cannot see). The two declared semantic deltas
  *   skip the identity gate (different grain / representation delta) and
  *   stay on the signature DECISION-REQUIRED path. The per-household gate FAILS on ANY of:
 *     (a) canonical `accounts_balance:balance_drift` count > 0 (conversion
 *         math must be exact, regardless of baseline);
 *     (b) a code whose canonical count EXCEEDS the legacy baseline count and
 *         is not listed in KNOWN_SEMANTIC_DELTAS;
 *     (c) a code present in canonical but absent from legacy and not listed
 *         in KNOWN_SEMANTIC_DELTAS.
  *   Counts BELOW baseline are fine (improvements allowed). Declared
  *   deltas have two modes: `{ maxCanonicalExtra, justification }`
  *   (bounded extra) and `{ mode: 'accepted-by-design', justification }`
  *   (BY-DESIGN representation gap: accepts ANY canonical count, including
  *   new appearances, but still prints the DECISION-REQUIRED line with
  *   legacy/canonical counts on every acceptance). Each declared delta
  *   prints a loud DECISION-REQUIRED line (human decision needed
  *   before F3, surfaced — never hidden). The inner CLI keeps its own
 *   `--fail-on-drift` flag, but the SCRIPT verdict comes from this gate: CLI
 *   JSON is parsed even when the CLI exits non-zero; only unparseable JSON
 *   aborts before the verdict.
 *
 * What it does:
 *   1. Starts a disposable Postgres 17 container.
 *   2. Loads the anonymized production snapshot (scripts/anonymized-dump.sql).
 *   3. Applies the fixture-shape shim (see FIXTURE NOTE below) + _migrations
 *      ledger row, so the stale dump matches the production legacy shape.
 *   4. Phase 1 — dry-run: `convert:canonical:dry`, expects exit 0 + plan GO.
 *   5. Phase 2 — real conversion with BACKUP_CONFIRMED=true, expects completed.
 *   6. Phase 3 — post-conversion on the SAME container: `canonical:preflight`
 *      (ready), `reconciliation --schema=canonical --fail-on-drift` (0 drift),
 *      converter rerun with the same BACKUP_ID (noop, finished_at unchanged),
 *      post-conversion pg_dump + sha256 for evidence.
 *   7. Prints a human summary + JSON evidence; removes the container.
 *
 * FIXTURE NOTE (stale dump, do NOT edit scripts/anonymized-dump.sql):
 * the dump is a V001-V014-era snapshot while the converter expects the
 * production legacy shape (M4 fixture / LEGACY_EXPECTED_COLUMNS): it has no
 * `_migrations` ledger, no `users`/`memberships`/`invites`/`card_purchases`
 * tables, `accounts` carries `kind`/`balance_cents` instead of
 * `is_credit_card`/`initial_balance_cents`/`active`, `transactions` carries a
 * single `account_id` (+ `transfer_to_account_id`) instead of
 * `from_account_id`/`to_account_id`, and `categories` carries `status`
 * instead of `active`. The shim below adapts the LOADED COPY (idempotent
 * DDL, production-equivalent derivation: credit_card from kind, active from
 * status, from/to from account_id per kind) without touching the dump file.
 * `initial_balance_cents` defaults to 0 for every account: the M3 balances
 * step recomputes stored balances as anchor + ledger, so the rehearsal stays
 * internally consistent (0 drift) even though production anchors differ.
 * `device_tokens.token_hash` is derived as sha256(legacy token): production
 * legacy already stores hashes, the stale dump predates that. The dump also
 * predates `users` entirely, so the shim seeds one rehearsal owner and binds
 * the archived device to them (`device_tokens.user_id`): without an
 * evidenced owner link the M3 identity step fail-closes by design.
 *
 * Exit code: 0 when every phase is green, 1 on any failure.
 * Local-only: DATABASE_URL always points at the disposable container over
 * loopback TCP (127.0.0.1) with password auth (scram-sha-256); no broad
 * 0.0.0.0 bind, no pg_hba trust rewrite, the secret never reaches logs.
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const API_DIR = resolve(ROOT, 'apps/api');
const DUMP_PATH = resolve(ROOT, 'scripts/anonymized-dump.sql');
const V003_PATH = resolve(API_DIR, 'src', 'read-models', 'sql', 'V003__legacy_safe_tables.sql');

// Real-dump mode (F2 rehearsal against an anonymized PRODUCTION dump):
// `--dump=<path>` (or REHEARSE_DUMP_PATH env) points at a plain-SQL (.sql)
// or gzip (.sql.gz) dump — gzip is auto-detected by magic bytes (0x1f 0x8b),
// the `.gz` extension is only a secondary hint.
// When set, the script loads that dump instead of the synthetic
// scripts/anonymized-dump.sql, skips the fixture shim + V003 ledger row,
// ensures the _test_marker guard row, and reconciles EVERY household.
const DUMP_ARG = (process.argv.find((a) => a.startsWith('--dump='))?.slice('--dump='.length) ?? '').trim();
const DUMP_ENV = (process.env.REHEARSE_DUMP_PATH ?? '').trim();
const REAL_DUMP_MODE = (DUMP_ARG || DUMP_ENV) !== '';
const ACTIVE_DUMP_PATH = REAL_DUMP_MODE ? resolve(ROOT, DUMP_ARG || DUMP_ENV) : DUMP_PATH;

const CONTAINER = process.env.REHEARSE_CONTAINER ?? 'pi-finance-canonical-rehearsal';
const PORT = process.env.REHEARSE_PORT ?? '5436';
const DB = 'pi_canonical_rehearsal';

// F2 ownership + injection guard (reviewer high): the container name and
// port come from the environment, so they are validated before ANY docker
// call. Invalid values fail closed. A preexisting container with the same
// name is NEVER deleted — creation fails closed instead. Cleanup removes
// ONLY the self-created container by its captured ID (execFileSync args,
// no shell); when creation never succeeded there is nothing to clean, and
// KEEP_DB deliberately retains the owned container for inspection.
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,253}$/;
export const validateContainerName = (name) => {
  const v = String(name ?? '').trim();
  if (!CONTAINER_NAME_RE.test(v)) {
    throw new Error(`invalid container name ${JSON.stringify(v)} — must match ${CONTAINER_NAME_RE}`);
  }
  return v;
};
export const validatePort = (port) => {
  const s = String(port ?? '').trim();
  if (!/^\d+$/.test(s)) throw new Error(`invalid port ${JSON.stringify(s)} — must be 1-65535`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid port ${JSON.stringify(s)} — must be 1-65535`);
  }
  return s;
};
export const containerExistsByName = (name) => {
  try {
    execFileSync('docker', ['inspect', '--format', '{{.Id}}', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
};
// Identity redaction (reviewer medium): entityId comes from client-controlled
// idempotency keys and may carry PII. Comparison keeps the raw identity key
// in memory (findingIdentityKey); every diagnostic/evidence/failure payload
// carries ONLY the safe code (check:kind|entity) with the id redacted.
export const redactIdentityKey = (key) => {
  const raw = String(key ?? '');
  const bar = raw.indexOf('|');
  const code = bar < 0 ? raw : raw.slice(0, bar);
  const rest = bar < 0 ? '' : raw.slice(bar + 1);
  const entity = rest.split(':')[0] || '?';
  return `${code}|${entity}:<redacted>`;
};
let ownedContainerId = null;
// Password for host TCP auth (scram-sha-256, default pg_hba). Read from the
// environment so operators can override without editing the script; when
// unset, a fresh 256-bit value is generated per run (reviewer P2: no static
// default). The value is never printed (docker run + host probes use the
// no-log path below), never written to evidence, and never persisted.
const DB_PASSWORD = (() => {
  const override = (process.env.REHEARSE_DB_PASSWORD ?? '').trim();
  if (override) return override;
  return randomBytes(32).toString('hex');
})();
// The dump seeds _test_marker with this value; the converter's test-database
// guard requires the env marker to match it exactly.
const TEST_MARKER = 'pi-finance-migration-rehearsal-2026-07-30';
const BACKUP_ID = `rehearsal-canonical-${Date.now()}`;

const startedAt = Date.now();
const evidence = { container: CONTAINER, port: PORT, database: DB, backupId: BACKUP_ID };

const log = (msg) => console.log(msg);

const sh = (cmd, opts = {}) => {
  log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
};

const cap = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

const docker = (args, opts = {}) => {
  log(`$ docker ${args.join(' ')}`);
  return execFileSync('docker', args, { encoding: 'utf8', ...opts });
};

const psql = (sqlText) =>
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', DB], {
    encoding: 'utf8',
    input: sqlText,
  });

const psqlScalar = (query) =>
  docker(['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-Atc', query], { stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const apiDbEnv = (extra = {}) => ({
  ...process.env,
  // Password auth over loopback TCP (scram-sha-256, default pg_hba — no trust
  // rewrite). Passwordless URL + PGPASSWORD: node-postgres resolves the
  // password from PGPASSWORD when the connection string carries none, so
  // SCRAM auth is preserved without embedding the secret in the URL
  // (public-safety url-embedded-credentials). The secret travels only in
  // the child env, never in logs: runApi logs the argv, never the env block.
  DATABASE_URL: `postgresql://postgres@127.0.0.1:${PORT}/${DB}?sslmode=disable`,
  DATABASE_URL_TEST: `postgresql://postgres@127.0.0.1:${PORT}/${DB}?sslmode=disable`,
  PGPASSWORD: DB_PASSWORD,
  DB_TEST_MARKER: TEST_MARKER,
  ...extra,
});

const runApi = (args, env) => {
  // Shell-string form (args are fully controlled: script names, flags,
  // backup-id timestamps, UUIDs): lets Windows resolve pnpm.cmd via PATH
  // without the execFile+shell deprecation noise.
  const cmd = ['pnpm', ...args].map((a) => `"${a}"`).join(' ');
  log(`$ ${cmd} (cwd apps/api)`);
  // 600s budget (reviewer P2): db:migrate/convert/reconciliation on real-size
  // clones can exceed the old 300s cap; the timeout only bounds the wait, it
  // never touches output handling (failures stay sanitized via childFailureSummary).
  return execSync(cmd, { encoding: 'utf8', cwd: API_DIR, env, timeout: 600_000 });
};

// Canonical reconciliation CLI argv (single helper so every --fail-on-drift
// call carries --format=json): without the JSON flag the CLI prints a
// human-readable report on drift, parseReport finds no JSON block, and the
// signature + identity gates never run. --fail-on-drift still exits non-zero
// on drift by design — the caller parses err.stdout and lets the gates
// decide.
export const canonicalReconArgs = (household) => [
  'reconciliation',
  '--schema=canonical',
  `--household=${household}`,
  '--fail-on-drift',
  '--format=json',
];

// An unexpected subprocess error can echo arbitrary argv, including a password
// containing spaces or quotes. Never print its message; phase-specific failures
// above already provide safe diagnostics.
export const sanitizeErrorForLog = () => 'unexpected rehearsal error (details withheld to protect credentials)';

// Sanitized child-process failure (reviewer P2): in REAL-DUMP mode stdout/
// stderr can carry dump bytes and client-controlled PII (recon reports,
// conversion output), so failure diagnostics carry ONLY the numeric status
// plus stdout/stderr byte counts — never content. Measuring the length keeps
// the bytes in memory; nothing is printed, logged, or stored on evidence.
export const childFailureSummary = (label, err) => {
  const status = err?.status ?? '?';
  const outBytes = Buffer.byteLength(String(err?.stdout ?? ''), 'utf8');
  const errBytes = Buffer.byteLength(String(err?.stderr ?? err?.message ?? ''), 'utf8');
  return `${label} failed (exit ${status}; stdout ${outBytes} bytes / stderr ${errBytes} bytes withheld to avoid PII)`;
};

// Fixed-string docker-run failure (status only, no err.message): the
// container ID was never captured, so a container with the target name MAY
// exist (created before the failure). NEVER auto-remove by name here — that
// could delete a preexisting container. Return manual recovery guidance:
// inspect the name, verify ownership, then remove by hand only if owned.
export const dockerRunFailureMessage = (status, containerName) => {
  const s = status ?? '?';
  const name = String(containerName ?? '').trim() || '<container>';
  return (
    `docker run failed (status ${s}): container ID not captured — ` +
    `a container named '${name}' may exist; inspect with ` +
    `'docker ps -a --filter name=${name}' and 'docker inspect ${name}', ` +
    `verify ownership (created by this rehearsal) before any manual removal; ` +
    `nothing was auto-removed to protect preexisting containers`
  );
};

/** First balanced {...} JSON block on stdout (pnpm prints banners around it). */
export const parseReport = (output) => {
  const start = output.indexOf('{');
  if (start < 0) throw new Error('no JSON report found on stdout');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(output.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON report on stdout');
};

const realChecksumOfV003 = () => createHash('sha256').update(readFileSync(V003_PATH, 'utf8'), 'utf8').digest('hex');

// Streaming dump loader: file -> (optional gunzip) -> docker exec psql stdin.
// Gzip is detected by magic bytes (0x1f 0x8b — authoritative) read from the
// first 2 bytes only; the `.gz` extension is only a secondary hint. The dump
// is never buffered as a string, never logged, and never written to a temp
// file — bytes flow with backpressure via pipeline() and any pipe/child
// failure rejects with error propagation.
export const isGzipMagic = (buf) => {
  if (!buf || buf.length < 2) return false;
  return buf[0] === 0x1f && buf[1] === 0x8b;
};

export const detectDumpEncodingSync = (dumpPath) => {
  const fd = openSync(dumpPath, 'r');
  try {
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    if (n < 2) return 'plain';
    return isGzipMagic(buf) ? 'gzip' : 'plain';
  } finally {
    closeSync(fd);
  }
};

export const createDumpInputStream = (dumpPath, opts = {}) => {
  if (opts.inputStreamForTest) return opts.inputStreamForTest;
  const encoding = detectDumpEncodingSync(dumpPath);
  const fileStream = createReadStream(dumpPath);
  if (encoding === 'gzip') {
    const gunzip = createGunzip();
    fileStream.on('error', (err) => gunzip.destroy(err));
    return fileStream.pipe(gunzip);
  }
  return fileStream;
};

// Generic backpressure pipe with error propagation (dump bytes -> writable,
// e.g. psql stdin). Rejects on source OR sink failure; resolves on finish.
export const pipeDumpToWritable = async (dumpPath, writable, opts = {}) => {
  const input = opts.inputStreamForTest ?? createDumpInputStream(dumpPath);
  await pipeline(input, writable);
};

// Streaming SHA256 + byte count over any readable (e.g. pg_dump stdout).
// Consumes with backpressure; rejects on stream error; the raw bytes never
// reach logs — only { bytes, sha256 } is returned.
export const hashStreamToDigest = async (readable) => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    hash.update(buf);
  }
  return { bytes, sha256: hash.digest('hex') };
};

// Stream a .sql / .sql.gz dump file into the rehearsal container's psql.
// Used for BOTH synthetic and real-dump modes (same code path).
export const streamSqlDumpToPsql = async (dumpPath) => {
  const input = createDumpInputStream(dumpPath);
  const child = spawn(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', DB],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  // stderr is drained (byte-counted only) so a failing child cannot wedge on
  // a full pipe; its CONTENT is never attached to errors/logs because psql
  // may echo the offending statement (dump/PII).
  let stderrBytes = 0;
  if (child.stderr) {
    child.stderr.on('data', (c) => {
      stderrBytes += c.length;
    });
  }
  const pipePromise = pipeline(input, child.stdin).catch((err) => {
    try {
      child.kill();
    } catch { /* ignore */ }
    throw err;
  });
  const exitPromise = new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`psql load exited ${code} (stderr ${stderrBytes} bytes withheld to avoid PII)`));
    });
  });
  await Promise.all([pipePromise, exitPromise]);
};

// Stream post-conversion pg_dump stdout straight into SHA256 (no maxBuffer,
// no temp file). Returns the existing evidence contract { bytes, sha256 }.
export const pgDumpToDigest = async () => {
  const child = spawn('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', DB], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // stderr is drained (byte-counted only); content withheld from errors/logs
  // so no dump bytes can reach diagnostics.
  let stderrBytes = 0;
  if (child.stderr) {
    child.stderr.on('data', (c) => {
      stderrBytes += c.length;
    });
  }
  const exitPromise = new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`pg_dump exited ${code} (stderr ${stderrBytes} bytes withheld)`));
    });
  });
  let digest;
  try {
    digest = await hashStreamToDigest(child.stdout);
  } catch (err) {
    try {
      child.kill();
    } catch { /* ignore */ }
    try {
      await exitPromise;
    } catch { /* keep the original stream error */ }
    throw err;
  }
  await exitPromise;
  return digest;
};

// Real-dump failure diagnostics: compact `code×count` summary of the
// per-household finding strings (`<check>:<kind>`) already collected into
// evidence. Capped at the first 10 distinct codes (+N more) to keep the
// one-line-per-household format readable.
const summarizeFindingCodes = (findings, maxCodes = 10) => {
  const counts = new Map();
  for (const f of findings ?? []) counts.set(f, (counts.get(f) ?? 0) + 1);
  if (counts.size === 0) return '—';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shown = sorted.slice(0, maxCodes).map(([code, n]) => `${code}×${n}`);
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
};

// --- REAL-DUMP signature-gate helpers (pure logic; F2 calibration
// 2026-09-26). Kept dependency-free so they can be smoke-tested in
// isolation (`node -e` fixture maps); the failure modes above (scrub
// artifacts, pre-existing production drift) must not fail the gate, while
// the two KNOWN_SEMANTIC_DELTAS below surface as DECISION-REQUIRED. ---
export const KNOWN_SEMANTIC_DELTAS = {
  // ADR-018 credit-card debt representation (F2 2026-09-26): legacy
  // recognizes 1 negative_credit_balance via the allowlist while canonical
  // shows 0 because the R$560,00 expense is statement-bound and excluded
  // from the canonical balance. DECISION REQUIRED BEFORE F3.
  'accounts_balance:historical_exception_count_mismatch': {
    maxCanonicalExtra: 1,
    justification: 'ADR-018 representation delta: legacy allowlist −R$560,00 credit vs canonical 0 (statement-bound purchase) — DECISION REQUIRED BEFORE F3',
  },
  // BY-DESIGN representation gap (F2 live-run 2026-09-26): canonical
  // materializes no statement_payment_id by design (mapper sets NULL), so
  // canonical structurally reports every paid statement as uncovered; the
  // legacy baseline in the anonymized clone undercounts via 'anon'
  // description false-matches (clone legacy=1 vs production-real 5), so the
  // clone shows legacy=1/canonical=6 (+5) where a production cutover would
  // show +1. Accepted by design (any canonical count, including new
  // appearances); human decision (implement materialization vs. formally
  // accept) required before F3.
  'statement_payment:payment_coverage_gap': {
    mode: 'accepted-by-design',
    justification: 'canonical materializes no statement_payment_id by design (mapper NULL); legacy baseline in the clone undercounts via anon description false-matches; production-real delta is +1; human decision (implement materialization vs. formally accept) required before F3 — DECISION REQUIRED BEFORE F3',
  },
};

export const signatureFromFindings = (findings) => {
  const sig = {};
  for (const f of findings ?? []) sig[f] = (sig[f] ?? 0) + 1;
  return sig;
};

export const formatSignature = (sig) => {
  const entries = Object.entries(sig ?? {}).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  if (entries.length === 0) return '—';
  return entries.map(([code, n]) => `${code}×${n}`).join(', ');
};

// Per-household gate: FAIL on (a) any canonical balance_drift, (b) any
// undeclared code whose canonical count exceeds the legacy baseline, (c)
// any undeclared code new in canonical. Declared `maxCanonicalExtra`
// deltas pass within their cap; declared `accepted-by-design` deltas pass
// for ANY canonical count (including new appearances). Both are returned
// as `accepted` for DECISION-REQUIRED logging (legacy/canonical counts
// emitted on every acceptance). Counts below baseline always pass
// (improvements allowed).
export const evaluateSignatureGate = (legacySig, canonicalSig) => {
  const legacy = legacySig ?? {};
  const canonical = canonicalSig ?? {};
  const failures = [];
  const accepted = [];
  if ((canonical['accounts_balance:balance_drift'] ?? 0) > 0) {
    failures.push({
      code: 'accounts_balance:balance_drift',
      legacy: legacy['accounts_balance:balance_drift'] ?? 0,
      canonical: canonical['accounts_balance:balance_drift'],
      reason: 'conversion math must be exact, regardless of baseline',
    });
  }
  for (const code of new Set([...Object.keys(legacy), ...Object.keys(canonical)])) {
    if (code === 'accounts_balance:balance_drift') continue;
    const l = legacy[code] ?? 0;
    const c = canonical[code] ?? 0;
    if (c <= l) continue;
    const extra = c - l;
    const declared = KNOWN_SEMANTIC_DELTAS[code];
    if (declared === undefined) {
      failures.push({
        code,
        legacy: l,
        canonical: c,
        reason:
          l === 0
            ? 'new code absent from the legacy baseline and not a declared semantic delta'
            : 'canonical count exceeds the legacy baseline and the code is not a declared semantic delta',
      });
    } else if (declared.mode === 'accepted-by-design') {
      accepted.push({ code, legacy: l, canonical: c, extra, justification: declared.justification });
    } else if (extra > declared.maxCanonicalExtra) {
      failures.push({
        code,
        legacy: l,
        canonical: c,
        reason: `declared delta exceeds maxCanonicalExtra (+${declared.maxCanonicalExtra})`,
      });
    } else {
      accepted.push({ code, legacy: l, canonical: c, extra, justification: declared.justification });
    }
  }
  return { pass: failures.length === 0, failures, accepted };
};

// --- REAL-DUMP identity gate (pure logic; F2 finding 2026-09-26). The
//  count-only signature gate above is blind to identity swaps: entity A can
//  disappear and entity B appear under the same `check:kind` with no count
//  change, and to silent value changes on the same entity. This gate
//  compares per-entity identity AND value for genuinely comparable findings
//  (legacy/canonical share the same grain: same check, kind, entity,
//  entityId plus expected/actual/detail). It runs ALONGSIDE the signature
//  gate in the REAL-DUMP per-household path; either gate can fail the
//  household. Two explicit special cases stay OUT of this gate:
//    - `statement_payment:payment_coverage_gap`: legacy reports the cycle
//      aggregate grain (entity `statement_cycle`) while canonical reports
//      the per-statement grain (entity `statements`); identity comparison
//      across grains is meaningless, so this code stays on the signature
//      gate's `accepted-by-design` DECISION-REQUIRED path.
//    - `accounts_balance:historical_exception_count_mismatch` (ADR-018):
//      the documented representation delta (legacy allowlist −R$560,00 vs
//      canonical 0) changes presence/values by design; it stays on the
//      signature gate's bounded (`maxCanonicalExtra: 1`) DECISION-REQUIRED
//      path. Improvement allowance (F2 real-dump 2026-09-26): a per-code
//      `missing` (finding disappeared in canonical) is ALLOWED when that
//      code strictly decreased (canonical count < legacy count) with NO
//      extras and NO value changes for the same code — a pure fix the
//      count-only signature gate already allows (c<l). Any other identity
//      disappearance FAILS here: same-count swaps, fewer-count with a new
//      entity (extra present even when c<l), and any silent value change
//      on a shared entity. Any count growth beyond the declared bounds
//      still FAILS the signature gate.
//  Both special cases keep printing DECISION-REQUIRED (human decision
//  needed before F3) — never silently accepted. ---
export const IDENTITY_GATE_SKIP_CODES = new Set(Object.keys(KNOWN_SEMANTIC_DELTAS));

export const findingIdentityKey = (f) =>
  `${f?.check ?? '?'}:${f?.kind ?? '?'}|${f?.entity ?? '?'}:${f?.entityId ?? '?'}`;

const stableValueOf = (value) => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableValueOf(value[k])}`)
      .join(',')}}`;
  }
  if (Array.isArray(value)) return `[${value.map(stableValueOf).join(',')}]`;
  return JSON.stringify(value ?? null);
};

export const findingValueKey = (f) =>
  stableValueOf({ expected: f?.expected, actual: f?.actual, detail: f?.detail });

// NOTE (F2-stream-and-redact): no digest of expected/actual/detail is emitted
// anywhere — not raw, not hashed. Comparison uses the full values in memory
// (findingValueKey); diagnostics carry only the identity key + which fields
// changed. An unkeyed truncated sha256 is dictionary-reversible for
// low-entropy financial values, so it is removed entirely (fields-changed is
// enough to act on).

const diffValueFields = (l, c) => {
  const fields = [];
  if (stableValueOf(l?.expected) !== stableValueOf(c?.expected)) fields.push('expected');
  if (stableValueOf(l?.actual) !== stableValueOf(c?.actual)) fields.push('actual');
  if (stableValueOf(l?.detail) !== stableValueOf(c?.detail)) fields.push('detail');
  return fields;
};

const codeFromIdentityKey = (key) => String(key ?? '').split('|')[0] || '?';

export const evaluateIdentityGate = (legacyFindings, canonicalFindings) => {
  const skipped = [];
  const indexByIdentity = (findings) => {
    const map = new Map();
    for (const f of findings ?? []) {
      const code = `${f?.check ?? '?'}:${f?.kind ?? '?'}`;
      if (IDENTITY_GATE_SKIP_CODES.has(code)) {
        skipped.push({ key: redactIdentityKey(findingIdentityKey(f)) });
        continue;
      }
      map.set(findingIdentityKey(f), f);
    }
    return map;
  };
  const legacy = indexByIdentity(legacyFindings);
  const canonical = indexByIdentity(canonicalFindings);
  // Sanitized diagnostics: REDACTED identity refs + changed field names
  // only. Raw comparison above uses the full in-memory values
  // (findingIdentityKey + findingValueKey); full finding objects
  // (expected/actual/detail) and raw entityId text (client-controlled
  // idempotency keys may carry PII) stay local to the comparison loop and
  // are never stored on the returned gate — no raw values, no raw
  // identity, no hashes.
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [key, l] of legacy) {
    const c = canonical.get(key);
    if (c === undefined) missing.push({ key: redactIdentityKey(key) });
    else if (findingValueKey(l) !== findingValueKey(c)) {
      changed.push({
        key: redactIdentityKey(key),
        fields: diffValueFields(l, c),
      });
    }
  }
  for (const [key] of canonical) {
    if (!legacy.has(key)) extra.push({ key: redactIdentityKey(key) });
  }
  // Improvement allowance (F2 real-dump 2026-09-26, household 550e...):
  // per-code `missing` is allowed when canonical strictly decreased for
  // that `check:kind` with no extras and no value changes on the same
  // code — mirrors the signature gate's intentional c<l allowance. Swaps
  // (same count, missing+extra), fewer-count with a new entity (extra
  // present even when c<l), and silent value changes still fail.
  const countByCode = (map) => {
    const counts = new Map();
    for (const key of map.keys()) {
      const code = codeFromIdentityKey(key);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  };
  const legacyCountByCode = countByCode(legacy);
  const canonicalCountByCode = countByCode(canonical);
  const groupByCode = (entries) => {
    const grouped = new Map();
    for (const entry of entries) {
      const code = codeFromIdentityKey(entry.key);
      grouped.set(code, (grouped.get(code) ?? 0) + 1);
    }
    return grouped;
  };
  const extraByCode = groupByCode(extra);
  const changedByCode = groupByCode(changed);
  const improved = [];
  const failingMissing = [];
  for (const entry of missing) {
    const code = codeFromIdentityKey(entry.key);
    const l = legacyCountByCode.get(code) ?? 0;
    const c = canonicalCountByCode.get(code) ?? 0;
    const hasExtra = (extraByCode.get(code) ?? 0) > 0;
    const hasChanged = (changedByCode.get(code) ?? 0) > 0;
    if (c < l && !hasExtra && !hasChanged) improved.push(entry);
    else failingMissing.push(entry);
  }
  const failures = [
    ...failingMissing.map(({ key }) => ({
      code: `identity:${codeFromIdentityKey(key)}`,
      legacy: key,
      canonical: '—',
      reason: 'finding disappeared in canonical — identity-swap or dropped entity',
    })),
    ...extra.map(({ key }) => ({
      code: `identity:${codeFromIdentityKey(key)}`,
      legacy: '—',
      canonical: key,
      reason: 'new finding absent from the legacy baseline — identity-swap or invented entity',
    })),
    ...changed.map(({ key, fields }) => ({
      code: `identity:${codeFromIdentityKey(key)}`,
      legacy: key,
      canonical: key,
      reason: `same entity with different values in canonical (fields: ${fields.join(',') || 'value'}) — silent value change`,
    })),
  ];
  return {
    pass: failures.length === 0,
    failures,
    missing,
    extra,
    changed,
    improved,
    skipped,
    matched: [...legacy.keys()].filter((k) => canonical.has(k)).length,
  };
};

// --- F2 technical pass vs F3 readiness (reviewer P2). The signature gate
// can TECHNICALLY pass a household while declared semantic deltas remain
// accepted-but-undecided (DECISION-REQUIRED). That is an F2 technical pass,
// never an F3 release approval: while ANY accepted delta remains, F3 is NOT
// ready. This helper is the single place that maps the accepted-decision
// list to the readiness verdict (no retroactive blanket approval — each
// delta keeps its DECISION-REQUIRED line and its human decision). ---
export const evaluateF3Readiness = (accepted) => {
  const list = accepted ?? [];
  return { f2TechnicalPass: true, f3Ready: list.length === 0, acceptedCount: list.length };
};

// P1-1 clone-side identity proof (REAL-DUMP): the gate count-locks active
// orphan card_purchases (`deleted_at IS NULL AND transaction_id IS NULL`)
// at 47, but a different SET of 47 would also pass. These pure helpers
// diff the two id sets (legacy_archive vs canonical public) so the
// REAL-DUMP path can require SET EQUALITY (same count AND same ids).
// Dependency-free; smoke-testable in isolation via `node -e`.
export const ORPHAN_CARD_PURCHASES_QUERY = (qualifiedTable) =>
  `SELECT id FROM ${qualifiedTable} WHERE deleted_at IS NULL AND transaction_id IS NULL ORDER BY id`;

export const diffOrphanIdSets = (legacyIds, canonicalIds) => {
  const l = [...(legacyIds ?? [])].sort();
  const c = [...(canonicalIds ?? [])].sort();
  const cSet = new Set(c);
  const lSet = new Set(l);
  const onlyInLegacy = l.filter((id) => !cSet.has(id));
  const onlyInCanonical = c.filter((id) => !lSet.has(id));
  return { pass: onlyInLegacy.length === 0 && onlyInCanonical.length === 0, onlyInLegacy, onlyInCanonical };
};

// Idempotent adaptation of the loaded dump copy to the production legacy
// shape (see FIXTURE NOTE in the header). No-ops when the dump already
// carries a column/table.
const FIXTURE_SHIM_SQL = `
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
UPDATE accounts SET is_credit_card = (kind = 'credit_card') WHERE kind IS NOT NULL;
UPDATE accounts SET active = (status = 'active') WHERE status IS NOT NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS from_account_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS to_account_id UUID;
UPDATE transactions SET from_account_id = account_id WHERE kind = 'expense' AND from_account_id IS NULL AND account_id IS NOT NULL;
UPDATE transactions SET to_account_id = account_id WHERE kind = 'income' AND to_account_id IS NULL AND account_id IS NOT NULL;
UPDATE transactions SET from_account_id = account_id, to_account_id = transfer_to_account_id WHERE kind = 'transfer' AND from_account_id IS NULL AND account_id IS NOT NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
UPDATE categories SET active = (status = 'active') WHERE status IS NOT NULL;
CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY, auth_user_id TEXT, email TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS memberships (id UUID PRIMARY KEY, user_id TEXT NOT NULL, household_id UUID, role TEXT);
CREATE TABLE IF NOT EXISTS invites (id UUID PRIMARY KEY, household_id UUID, email TEXT, role TEXT, token_hash TEXT, expires_at TIMESTAMPTZ, invited_by_user_id TEXT, accepted_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS card_purchases (id UUID PRIMARY KEY, household_id UUID NOT NULL, transaction_id UUID, statement_id UUID, description TEXT NOT NULL DEFAULT '', amount_cents BIGINT NOT NULL DEFAULT 0, date DATE NOT NULL DEFAULT CURRENT_DATE, deleted_at TIMESTAMPTZ);
-- Production legacy stores the device secret as token_hash; the stale dump
-- predates that with a plaintext token. Derive the hash the mapper requires
-- (built-in sha256, no extension); the plaintext never leaves the archive
-- (the mapper redacts it in the report).
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;
UPDATE device_tokens SET token_hash = encode(sha256(token::bytea), 'hex') WHERE token_hash IS NULL AND token IS NOT NULL;
CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL DEFAULT '', applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
-- Production legacy binds devices to users (device_tokens.user_id) and the
-- converter derives the household owner from that evidence link; the stale
-- dump has neither users nor the link. Seed the single rehearsal owner
-- (M4-fixture shape: NULL auth_user_id) and bind the archived device to
-- them, so identity derivation follows the evidenced device-link path.
INSERT INTO users (id, auth_user_id, email, name)
VALUES ('22222222-2222-4222-8222-222222222222', NULL, 'owner@example.com', 'Rehearsal Owner')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE device_tokens SET user_id = '22222222-2222-4222-8222-222222222222' WHERE user_id IS NULL;
`;

const cleanup = () => {
  if (process.env.KEEP_DB) {
    log(`\nSkipping cleanup (KEEP_DB set) — owned container ${ownedContainerId ?? CONTAINER} left running (deliberate retain).`);
    return;
  }
  // Owned-ID cleanup only: never delete by configurable name, so a
  // preexisting container can never be removed here. When creation failed
  // (ownedContainerId null) this is a no-op by design.
  if (!ownedContainerId) return;
  try {
    execFileSync('docker', ['rm', '-f', ownedContainerId], { stdio: 'ignore' });
  } catch { /* already gone */ }
};

const fail = (msg) => {
  console.error(`FATAL: ${msg}`);
  cleanup();
  process.exit(1);
};

const main = async () => {
  try {
    validateContainerName(CONTAINER);
    validatePort(PORT);
  } catch (err) {
    fail(`invalid rehearsal target: ${err.message}`);
    return;
  }
  log(`Mode: ${REAL_DUMP_MODE ? 'REAL-DUMP' : 'SYNTHETIC'} — dump: ${ACTIVE_DUMP_PATH}`);
  if (!existsSync(ACTIVE_DUMP_PATH)) fail(`dump not found at ${ACTIVE_DUMP_PATH}`);
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    fail('Docker daemon not running');
  }

  // Fail closed on a preexisting name: never delete or reuse it. The
  // preexistence check uses argv (no shell), so env-controlled names cannot
  // inject. cleanup() only ever removes the captured ownedContainerId, so
  // this path leaves the preexisting container untouched by construction.
  if (containerExistsByName(CONTAINER)) {
    fail(`container name '${CONTAINER}' already exists — refusing to delete or reuse a preexisting container`);
    return;
  }

  log('\n=== [1/6] Starting disposable Postgres 17 ===');
  // Loopback-only publish: the host port never binds 0.0.0.0. The command
  // carries POSTGRES_PASSWORD, so it runs WITHOUT the logging sh() helper —
  // only a redacted line is printed, the secret never reaches stdout.
  log(`$ docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=<redacted> -e POSTGRES_DB=${DB} -p 127.0.0.1:${PORT}:5432 postgres:17-alpine`);
  try {
    ownedContainerId = execFileSync(
      'docker',
      ['run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`, '-e', `POSTGRES_DB=${DB}`, '-p', `127.0.0.1:${PORT}:5432`, 'postgres:17-alpine'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    ).trim();
  } catch (err) {
    ownedContainerId = null;
    // Sanitized: err.message may echo the docker argv carrying
    // POSTGRES_PASSWORD — surface status only + manual recovery guidance.
    // No auto-remove by name: the failure may have created a container
    // without a captured ID, and deleting by name could hit a preexisting one.
    fail(dockerRunFailureMessage(err?.status, CONTAINER));
    return;
  }
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      // Probe the TARGET database: pg_isready alone can succeed while the
      // entrypoint is still creating POSTGRES_DB. Argv form (no shell), so
      // the env-controlled name/DB cannot inject.
      execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-Atc', 'SELECT 1'], { stdio: 'ignore' });
      ready = true;
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  if (!ready) fail('Postgres did not start in time');

  // No pg_hba trust rewrite (default scram-sha-256 stays): host TCP auth uses
  // the password in DATABASE_URL. Verify host access over loopback TCP before
  // loading anything — a TCP socket probe proves the loopback publish, the
  // follow-up phases (dry-run/convert) prove password auth end to end.
  {
    const { default: net } = await import('node:net');
    const reachable = await new Promise((resolveProbe) => {
      const sock = net.connect({ host: '127.0.0.1', port: Number(PORT) }, () => {
        sock.end();
        resolveProbe(true);
      });
      sock.on('error', () => resolveProbe(false));
      setTimeout(() => {
        try {
          sock.destroy();
        } catch { /* ignore */ }
        resolveProbe(false);
      }, 5000).unref?.();
    });
    if (!reachable) fail(`host loopback TCP 127.0.0.1:${PORT} unreachable — check the 127.0.0.1 publish binding`);
  }

  log(`\n=== [2/6] Loading snapshot (${REAL_DUMP_MODE ? 'real production-shaped dump' : 'anonymized snapshot + fixture-shape shim'}) ===`);
  if (REAL_DUMP_MODE) {
    // Real-dump mode: the production dump already carries the
    // production legacy shape at its real migration level — no shim, no
    // backfilled ledger row. Production has no _test_marker guard row, so
    // ensure it here (the converter's test-database guard requires the env
    // marker to match it exactly).
    // Streaming load: file -> (optional gunzip) -> docker exec psql stdin
    // with backpressure; gzip auto-detected by magic bytes. Dump bytes never
    // reach logs or temp files — only the encoding label is printed.
    log(`  dump encoding=${detectDumpEncodingSync(ACTIVE_DUMP_PATH)} (streaming, no temp file)`);
    try {
      await streamSqlDumpToPsql(ACTIVE_DUMP_PATH);
    } catch (err) {
      fail(`dump streaming load failed: ${err.message ?? err}`);
    }
    psql(
      `CREATE TABLE IF NOT EXISTS public._test_marker (marker_value TEXT NOT NULL);\n` +
        `INSERT INTO public._test_marker (marker_value) SELECT '${TEST_MARKER}' WHERE NOT EXISTS (SELECT 1 FROM public._test_marker);`,
    );
  } else {
    // Synthetic mode streams through the same backpressure path (plain .sql).
    try {
      await streamSqlDumpToPsql(DUMP_PATH);
    } catch (err) {
      fail(`synthetic dump streaming load failed: ${err.message ?? err}`);
    }
    psql(FIXTURE_SHIM_SQL);
    const v003 = realChecksumOfV003();
    psql(
      `INSERT INTO _migrations (version, name, checksum) VALUES (3, 'V003__legacy_safe_tables.sql', '${v003}')\n` +
        `ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, checksum = EXCLUDED.checksum;`,
    );
  }
  const counts = psqlScalar(
    `SELECT 'accounts='||(SELECT COUNT(*) FROM accounts)||' categories='||(SELECT COUNT(*) FROM categories)||' transactions='||(SELECT COUNT(*) FROM transactions)`,
  );
  log(`  legacy counts: ${counts}`);
  evidence.fixtureCounts = counts;
  const marker = psqlScalar(`SELECT marker_value FROM _test_marker LIMIT 1`);
  if (marker !== TEST_MARKER) fail(`unexpected _test_marker '${marker}'`);

  // REAL-DUMP calibration — legacy baseline per household (F2 2026-09-26):
  // run `reconciliation --schema=legacy --household=<id> --format=json` on
  // the clone BEFORE the conversion (same env mechanism as the canonical
  // phase). A household whose legacy recon errors fails here with its
  // stderr — no skipping. The per-household Map `check:kind` → count feeds
  // evaluateSignatureGate after the conversion.
  let legacyBaselineByHousehold = new Map();
  // Full finding objects per household (check/kind/entity/entityId +
  // expected/actual/detail) feeding evaluateIdentityGate; the string
  // signature map above stays untouched.
  let legacyFindingObjsByHousehold = new Map();
  if (REAL_DUMP_MODE) {
    log('\n=== [2b/6] Legacy baseline per household (pre-conversion) ===');
    const idsRawPre = psqlScalar(`SELECT id FROM public.households ORDER BY id`);
    const preHouseholdIds = idsRawPre.split('\n').map((s) => s.trim()).filter(Boolean);
    if (preHouseholdIds.length === 0) fail('real-dump mode: no households found in public.households before conversion');
    log(`  legacy baseline households: ${preHouseholdIds.length}`);
    evidence.legacyBaselinePerHousehold = [];
    for (const household of preHouseholdIds) {
      let legacyOut;
      let legacyExitOk = true;
      try {
        legacyOut = runApi(['reconciliation', '--schema=legacy', `--household=${household}`, '--format=json'], apiDbEnv());
      } catch (err) {
        legacyExitOk = false;
        legacyOut = err.stdout ?? '';
        if (!legacyOut.includes('{')) {
          fail(`legacy baseline household=${household} ${childFailureSummary('reconciliation --schema=legacy', err)} — no skipping`);
        }
      }
      let legacyRecon;
      try {
        legacyRecon = parseReport(legacyOut);
      } catch {
        fail(`legacy baseline household=${household} returned unparseable JSON (exit ${legacyExitOk ? 0 : 'non-zero'}); failing with its stderr — no skipping`);
      }
      const legacyFindings = (legacyRecon.checks ?? []).flatMap((c) =>
        (c.findings ?? []).map((f) => `${c.check}:${f.kind}`),
      );
      const legacyFindingObjs = (legacyRecon.checks ?? []).flatMap((c) =>
        (c.findings ?? []).map((f) => ({
          check: c.check,
          kind: f.kind,
          entity: f.entity,
          entityId: f.entityId,
          expected: f.expected,
          actual: f.actual,
          detail: f.detail,
        })),
      );
      const legacySignature = signatureFromFindings(legacyFindings);
      legacyBaselineByHousehold.set(household, legacySignature);
      legacyFindingObjsByHousehold.set(household, legacyFindingObjs);
      evidence.legacyBaselinePerHousehold.push({
        household,
        checked: legacyRecon.totals?.checked ?? null,
        drifted: legacyRecon.totals?.drifted ?? null,
        findings: legacyFindings,
        signature: legacySignature,
      });
      log(`  [BASELINE] household=${household} checked=${legacyRecon.totals?.checked} drifted=${legacyRecon.totals?.drifted} sig: ${formatSignature(legacySignature)}`);
    }
  }

  log('\n=== [3/6] Phase 1 — dry-run plan ===');
  let dryOut;
  try {
    dryOut = runApi(['convert:canonical:dry'], apiDbEnv());
  } catch (err) {
    fail(childFailureSummary('dry-run (convert:canonical:dry)', err));
  }
  const dryReport = parseReport(dryOut);
  evidence.dryRun = { ready: dryReport.plan?.ready, fingerprint: dryReport.plan?.fingerprint, blockers: dryReport.plan?.blockers ?? [] };
  log(`  plan.ready=${dryReport.plan?.ready} blockers=${JSON.stringify(dryReport.plan?.blockers ?? [])}`);
  log(`  informational=${JSON.stringify((dryReport.plan?.informational ?? []).map((f) => `${f.code}(${f.count})`))}`);
  if (dryReport.status !== 'dry-run' || dryReport.plan?.ready !== true) fail('dry-run plan is NO-GO');

  log('\n=== [4/6] Phase 2 — real conversion ===');
  let convertOut;
  try {
    convertOut = runApi(['convert:canonical', `--backup-id=${BACKUP_ID}`], apiDbEnv({ BACKUP_CONFIRMED: 'true' }));
  } catch (err) {
    fail(childFailureSummary('conversion (convert:canonical)', err));
  }
  const convertReport = parseReport(convertOut);
  evidence.conversion = {
    status: convertReport.status,
    fingerprint: convertReport.plan?.fingerprint,
    entities: (convertReport.import?.entities ?? []).map((e) => `${e.name}:${e.legacyCount ?? '?'}=${e.importedCount ?? '?'}`),
    identityDerived: convertReport.identity?.derived,
  };
  log(`  status=${convertReport.status} fingerprint=${convertReport.plan?.fingerprint}`);
  if (convertReport.status !== 'completed') fail(`unexpected conversion status '${convertReport.status}'`);

  log('\n=== [5/6] Phase 3 — post-conversion validation (same container) ===');
  let preflightOut;
  try {
    // The standalone preflight queries the legacy shape unqualified; after
    // the bootstrap the legacy lives in legacy_archive, so pin it via the
    // connection-string options (same technique as the M4 orchestrator's
    // dedicated plan connection). This proves the archived source is still
    // clean after the conversion.
    const archiveUrl = (suffix) =>
      `${apiDbEnv()[suffix]}&options=-c%20search_path%3Dlegacy_archive`;
    preflightOut = runApi(
      ['canonical:preflight'],
      { ...apiDbEnv(), DATABASE_URL: archiveUrl('DATABASE_URL'), DATABASE_URL_TEST: archiveUrl('DATABASE_URL_TEST') },
    );
  } catch (err) {
    fail(childFailureSummary('post-conversion preflight (canonical:preflight)', err));
  }
  const preflight = parseReport(preflightOut);
  evidence.preflight = { ready: preflight.ready, findings: preflight.findings ?? [] };
  log(`  preflight.ready=${preflight.ready}`);
  if (preflight.ready !== true) fail('canonical preflight is not ready after conversion');

  // REAL-DUMP MODE: reconcile EVERY converted household (canonical schema
  // lives in public after the archive-and-bootstrap; --schema=canonical is
  // passed explicitly so the CLI never has to probe). The SCRIPT verdict per
  // household comes from the LEGACY-vs-CANONICAL signature gate
  // (evaluateSignatureGate against the [2b/6] baseline), NOT from absolute
  // zero-drift: the inner CLI keeps its own --fail-on-drift flag, but its
  // JSON is parsed even when it exits non-zero — only unparseable JSON
  // aborts before the verdict.
  if (REAL_DUMP_MODE) {
    // P1-1 clone-side identity proof for the 47 orphan card purchases
    // (post-conversion fidelity, alongside the phase-3 signature gate):
    // count-equality is not enough — a different SET of 47 would also
    // pass. Require SET EQUALITY of the active orphan ids between the
    // archived source (legacy_archive) and the canonical import (public).
    const legacyOrphanRaw = psqlScalar(ORPHAN_CARD_PURCHASES_QUERY('legacy_archive.card_purchases'));
    const canonicalOrphanRaw = psqlScalar(ORPHAN_CARD_PURCHASES_QUERY('public.card_purchases'));
    const legacyOrphanIds = legacyOrphanRaw.split('\n').map((s) => s.trim()).filter(Boolean);
    const canonicalOrphanIds = canonicalOrphanRaw.split('\n').map((s) => s.trim()).filter(Boolean);
    const orphanDiff = diffOrphanIdSets(legacyOrphanIds, canonicalOrphanIds);
    evidence.orphanIdentityProof = {
      legacyCount: legacyOrphanIds.length,
      canonicalCount: canonicalOrphanIds.length,
      pass: orphanDiff.pass,
      onlyInLegacySample: orphanDiff.onlyInLegacy.slice(0, 5),
      onlyInCanonicalSample: orphanDiff.onlyInCanonical.slice(0, 5),
    };
    if (!orphanDiff.pass) {
      fail(
        `orphan card_purchases identity mismatch: ${orphanDiff.onlyInLegacy.length} only in legacy_archive, ` +
          `${orphanDiff.onlyInCanonical.length} only in canonical ` +
          `(legacy-only e.g. [${orphanDiff.onlyInLegacy.slice(0, 5).join(', ')}], ` +
          `canonical-only e.g. [${orphanDiff.onlyInCanonical.slice(0, 5).join(', ')}])`,
      );
    }
    log(`  orphan identity proof: ${legacyOrphanIds.length}/${canonicalOrphanIds.length} ids preserved`);
    const idsRaw = psqlScalar(`SELECT id FROM public.households ORDER BY id`);
    const householdIds = idsRaw.split('\n').map((s) => s.trim()).filter(Boolean);
    if (householdIds.length === 0) fail('real-dump mode: no households found in public.households after conversion');
    log(`  real-dump households: ${householdIds.length}`);
    evidence.householdIds = householdIds;
    evidence.reconciliationPerHousehold = [];
    let householdsFailed = 0;
    const allAccepted = [];
    for (const household of householdIds) {
      let recon;
      let exitOk = true;
      let exitStatus = 0;
      try {
        const reconOut = runApi(canonicalReconArgs(household), apiDbEnv());
        recon = parseReport(reconOut);
      } catch (err) {
        // --fail-on-drift exits non-zero on drift by design: the JSON report
        // is still on stdout, so parse it and let the signature gate decide.
        exitOk = false;
        exitStatus = err.status ?? 1;
        const raw = err.stdout ?? '';
        try {
          recon = parseReport(raw);
        } catch {
          log(`  [FAIL] household=${household} reconciliation exited ${exitStatus} without a parseable report`);
          evidence.reconciliationPerHousehold.push({ household, ok: false, checked: null, drifted: null, findings: [], error: 'unparseable report' });
          householdsFailed += 1;
          continue;
        }
      }
      const checked = recon.totals?.checked ?? null;
      const drifted = recon.totals?.drifted ?? null;
      const findings = (recon.checks ?? []).flatMap((c) =>
        (c.findings ?? []).map((f) => `${c.check}:${f.kind}`),
      );
      const canonicalFindingObjs = (recon.checks ?? []).flatMap((c) =>
        (c.findings ?? []).map((f) => ({
          check: c.check,
          kind: f.kind,
          entity: f.entity,
          entityId: f.entityId,
          expected: f.expected,
          actual: f.actual,
          detail: f.detail,
        })),
      );
      const canonicalSignature = signatureFromFindings(findings);
      const legacySignature = legacyBaselineByHousehold.get(household) ?? {};
      const hasBaseline = legacyBaselineByHousehold.has(household);
      const gate = evaluateSignatureGate(legacySignature, canonicalSignature);
      // Identity/value gate (same-grain findings only; the two declared
      // semantic deltas skip it and stay on the signature DECISION-REQUIRED
      // path). Either gate can fail the household — no silent swaps.
      const identityGate = evaluateIdentityGate(
        legacyFindingObjsByHousehold.get(household) ?? [],
        canonicalFindingObjs,
      );
      gate.failures.push(...identityGate.failures);
      if (!hasBaseline) {
        gate.failures.push({
          code: '(missing legacy baseline)',
          reason: `no pre-conversion legacy baseline for household ${household}`,
        });
      }
      const ok = gate.failures.length === 0;
      if (!ok) householdsFailed += 1;
      for (const hit of gate.accepted) {
        allAccepted.push({ household, code: hit.code, legacy: hit.legacy, canonical: hit.canonical });
      }
      evidence.reconciliationPerHousehold.push({
        household,
        ok,
        checked,
        drifted,
        findings,
        exitOk,
        exitStatus,
        legacySignature,
        canonicalSignature,
        gate: { pass: ok, failures: gate.failures, accepted: gate.accepted },
        identityGate: {
          pass: identityGate.pass,
          matched: identityGate.matched,
          missing: identityGate.missing.map((m) => m.key),
          extra: identityGate.extra.map((e) => e.key),
          changed: identityGate.changed.map((c) => c.key),
          skipped: identityGate.skipped.length,
        },
      });
      log(`  [${ok ? 'PASS' : 'FAIL'}] household=${household} legacy: ${formatSignature(legacySignature)} | canonical: ${formatSignature(canonicalSignature)} | verdict=${ok ? 'PASS' : `FAIL (${gate.failures.map((f) => f.code).join(', ')})`}`);
      for (const hit of gate.accepted) {
        const decl = KNOWN_SEMANTIC_DELTAS[hit.code];
        const suffix =
          decl?.mode === 'accepted-by-design'
            ? '(accepted-by-design)'
            : `(extra +${hit.extra} ≤ max +${decl.maxCanonicalExtra})`;
        log(`  DECISION-REQUIRED: household=${household} ${hit.code} legacy=${hit.legacy} canonical=${hit.canonical} ${suffix} — ${hit.justification}`);
      }
      for (const failure of gate.failures) {
        log(`  [GATE-FAIL] household=${household} ${failure.code}: ${failure.reason} (legacy=${failure.legacy ?? '—'} canonical=${failure.canonical ?? '—'})`);
      }
    }
    evidence.reconciliation = {
      mode: 'per-household-signature-plus-identity-gate',
      households: householdIds.length,
      passed: householdIds.length - householdsFailed,
      failed: householdsFailed,
    };
    if (householdsFailed > 0) {
      // The FATAL below exits before EVIDENCE_JSON is dumped, so repeat the
      // per-household summary (with finding codes) on stderr to keep the
      // failure output self-sufficient.
      for (const r of evidence.reconciliationPerHousehold) {
        console.error(
          `  [${r.ok ? 'PASS' : 'FAIL'}] household=${r.household} checked=${r.checked} drifted=${r.drifted} findings=${(r.findings ?? []).length} codes: ${summarizeFindingCodes(r.findings)}`,
        );
      }
      fail(`real-dump reconciliation signature+identity gate: ${householdsFailed}/${householdIds.length} households failed — NO F3 RELEASE on this evidence`);
    }
    // F2-technical-pass vs F3-readiness (reviewer P2): reaching here means
    // every household passed both gates, but accepted semantic deltas are
    // still undecided human decisions — F2 technical pass, F3 NOT ready.
    const f3 = evaluateF3Readiness(allAccepted);
    evidence.f3Readiness = {
      f2TechnicalPass: f3.f2TechnicalPass,
      f3Ready: f3.f3Ready,
      acceptedCount: f3.acceptedCount,
      accepted: allAccepted,
    };
    if (!f3.f3Ready) {
      log(`  F2 TECHNICAL PASS — F3 NOT READY: ${f3.acceptedCount} accepted semantic delta(s) remain DECISION-REQUIRED before F3 (no retroactive approval; human decision required)`);
    } else {
      log('  F2 technical pass with zero accepted deltas — F3 release still requires explicit human sign-off');
    }
  } else {
  let reconOut;
  let recon;
  try {
    // Household-scope the gate to the converted fixture household (same
    // precedent as the M4 integration suite): a global run gates on the
    // production ADR-017/allowlist-v2 fingerprints by design (47 orphans, 8
    // statements, 1 negative credit), which a synthetic fixture can never
    // match. Scoping keeps every detector active on every converted row.
    const household = psqlScalar(`SELECT household_id FROM public.accounts WHERE household_id IS NOT NULL GROUP BY household_id`);
    if (!/^[0-9a-f-]{36}$/i.test(household)) {
      fail(`expected a single fixture household, got '${household}'`);
    }
    evidence.householdId = household;
    reconOut = runApi(canonicalReconArgs(household), apiDbEnv());
    recon = parseReport(reconOut);
  } catch (err) {
    const raw = err.stdout ?? '';
    try {
      recon = parseReport(raw);
    } catch {
      fail(`reconciliation without a parseable report: ${childFailureSummary('reconciliation --schema=canonical', err)}`);
    }
  }
  evidence.reconciliation = { schema: recon.schema, drifted: recon.totals?.drifted, checked: recon.totals?.checked };
  evidence.reconciliationFindings = (recon.checks ?? []).flatMap((c) =>
    (c.findings ?? []).map((f) => `${c.check}:${f.kind}`),
  );
  // Archive==canonical fidelity for the goal currents behind the
  // contribution_drift findings below (0 = the converter preserved them
  // exactly; any nonzero fails the rehearsal outright).
  evidence.goalFidelity = psqlScalar(
    `SELECT COUNT(*) FROM (SELECT id, current_amount_cents FROM legacy_archive.goals EXCEPT SELECT id, current_amount_cents FROM public.goals) d`,
  );
  log(`  reconciliation schema=${recon.schema} checked=${recon.totals?.checked} drifted=${recon.totals?.drifted}`);
  if (recon.totals?.drifted !== 0) {
    // KNOWN-FIXTURE BASELINE (documented deviation from absolute zero-drift:
    // this fixture can never satisfy the absolute gate, for two reasons
    // outside the converter —
    //  1. the anonymized dump reuses the production household id (its
    //     sha256 equals the approved historical-household hash, verified
    //     against hashHouseholdScope), so the ADR-017/allowlist-v2 count
    //     gates expect the 47+8+1 production exception rows the anonymized
    //     copy dropped;
    //  2. the dump's fabricated goal currents (150000/80000) ship with zero
    //     goal_contributions rows, so contribution_drift fires on source
    //     data the converter must preserve verbatim (goalFidelity proves
    //     archive==canonical).
    // The rehearsal therefore accepts EXACTLY this 5-finding signature plus
    // goalFidelity 0. Anything else — a new finding, a missing one, a
    // changed count, fidelity != 0 — fails the rehearsal: converter
    // regressions cannot hide behind the baseline. Production reconciliation
    // on real data keeps the absolute gate untouched.
    const signature = [...evidence.reconciliationFindings].sort();
    const baseline = [
      'accounts_balance:historical_exception_count_mismatch',
      'duplicates:historical_exception_count_mismatch',
      'goal_contribution:contribution_drift',
      'goal_contribution:contribution_drift',
      'statement_total:historical_exception_count_mismatch',
    ];
    const match =
      JSON.stringify(signature) === JSON.stringify(baseline) && Number(evidence.goalFidelity) === 0;
    evidence.reconciliationBaseline = { matched: match, expected: baseline, actual: signature };
    if (!match) {
      fail(
        `reconciliation drift does not match the known-fixture baseline:\nexpected ${JSON.stringify(baseline)}\nactual   ${JSON.stringify(signature)}\ngoalFidelity=${evidence.goalFidelity}`,
      );
    }
    log('  !! reconciliation matches the KNOWN-FIXTURE BASELINE (5 documented findings, converter fidelity intact) — continuing');
  }
  }

  const finishedBefore = psqlScalar(`SELECT finished_at FROM public._conversion_marker ORDER BY id DESC LIMIT 1`);
  let rerunOut;
  try {
    rerunOut = runApi(['convert:canonical', `--backup-id=${BACKUP_ID}`], apiDbEnv({ BACKUP_CONFIRMED: 'true' }));
  } catch (err) {
    fail(childFailureSummary('idempotency rerun (convert:canonical, same BACKUP_ID)', err));
  }
  const rerun = parseReport(rerunOut);
  const finishedAfter = psqlScalar(`SELECT finished_at FROM public._conversion_marker ORDER BY id DESC LIMIT 1`);
  evidence.rerun = { status: rerun.status, finishedAtUnchanged: finishedBefore === finishedAfter };
  log(`  rerun status=${rerun.status} finished_at unchanged=${finishedBefore === finishedAfter}`);
  if (rerun.status !== 'noop' || finishedBefore !== finishedAfter) fail('rerun did not no-op cleanly');

  log('\n=== [6/6] Post-conversion dump + checksum ===');
  // Streaming pg_dump: docker exec pg_dump stdout -> SHA256 with backpressure.
  // No maxBuffer, no temp file — dump bytes never touch disk or logs; only
  // the existing { bytes, sha256 } evidence contract is emitted.
  let postDigest;
  try {
    postDigest = await pgDumpToDigest();
  } catch (err) {
    fail(`post-conversion pg_dump streaming failed: ${err.message ?? err}`);
  }
  evidence.postConversionDump = {
    bytes: postDigest.bytes,
    sha256: postDigest.sha256,
  };
  log(`  dump bytes=${postDigest.bytes} sha256=${postDigest.sha256}`);

  evidence.durationMs = Date.now() - startedAt;
  cleanup();

  // Final verdict keeps the F2/F3 distinction (reviewer P2): a real-dump run
  // with accepted-but-undecided deltas is an F2 technical pass, never a
  // blanket F3 release signal. Synthetic mode keeps the historical message.
  if (REAL_DUMP_MODE && (evidence.f3Readiness?.acceptedCount ?? 0) > 0) {
    console.log(
      `\n✓ Canonical conversion rehearsal complete. F2 TECHNICAL PASS — F3 NOT READY (${evidence.f3Readiness.acceptedCount} accepted semantic delta(s) remain DECISION-REQUIRED; no F3 release on this evidence without human decision).`,
    );
  } else {
    console.log('\n✓ Canonical conversion rehearsal complete. All gates green.');
  }
  console.log('EVIDENCE_JSON_BEGIN');
  console.log(JSON.stringify(evidence, null, 2));
  console.log('EVIDENCE_JSON_END');
};

// Import-safe: unit tests import the pure gate helpers above without
// starting the disposable-container rehearsal. main() runs only when this
// file is the CLI entrypoint.
const invokedAsCli =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  main().catch((err) => {
    // Sanitized outer catch: err.message could theoretically echo a secret
    // argv (e.g. POSTGRES_PASSWORD) from an uncaught child error — redact
    // before logging. Cleanup still removes only the owned container ID.
    console.error(`Rehearsal failed: ${sanitizeErrorForLog(err?.message ?? err)}`);
    cleanup();
    process.exit(1);
  });
}
