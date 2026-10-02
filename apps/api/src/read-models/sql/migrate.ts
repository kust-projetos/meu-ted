/**
 * Minimal forward-only migration runner.
 *
 * Applies every `V###__*.sql` file under `src/read-models/sql/` in
 * lexical order, idempotently. Tracks applied versions and checksums in
 * a `_migrations` table.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbPool } from "../../db/pool.js";
import { applyMigrationTimeouts } from "../../db/pool.js";
import { withMigrationAdvisoryLock } from "../../db/migration-lock.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = here;
const MIGRATION_RE = /^V(\d+)__([\w-]+)\.sql$/;

type MigrationManifestEntry = {
  version: number;
  name: string;
  checksum: string;
};

// Migrations safe to apply on the legacy pi_financeiro schema (DB_SCHEMA=legacy).
// V003 = device_tokens/idempotency; V008 = additive feature tables; V009 = parent_id
// and subscriptions; V010/V011 = profiles; V012 = accounts_payable paid_transaction_id;
// V032 = legacy card_purchases household_id/updated_at and accounts updated_at.
// V033 = card_purchases transaction_id/deleted_at and FK to transactions.
// V043 = Better Auth admin/impersonation columns on the modern user/session/account
// tables (additive ADD COLUMN IF NOT EXISTS only; never touches legacy financial
// tables). Required in legacy mode because the production VPS boots with
// DB_SCHEMA=legacy and V031 (admin columns) was never legacy-safe, so login
// 500s with SCHEMA_MISMATCH until V043 applies at boot.
// V044 = LLM kimi catalog; V045 = category tree defaults columns;
// V046 = transaction notes; V047 = statement uniqueness + card purchase
// metadata; V049 = legacy category uniqueness (dual-schema DO block: no-op
// on canonical where V048 already ran, legacy dedupe + unique index
// otherwise). V050 = canonical users.phone compat column (ADD COLUMN IF
// NOT EXISTS: adds the legacy-only column canonically so the invite accept
// INSERT works on both schemas; strict no-op on legacy where phone already
// exists). V048 is deliberately NOT here (canonical-only: needs
// categories.status); see LEGACY_EXCLUDED_JUSTIFICATIONS and
// docs/ops/v048-legacy-boot-decision.md.
// V055 is deliberately NOT here (canonical-only: the production VPS boots
// with DB_SCHEMA=legacy and MIGRATIONS_MODE=disabled with the ledger topped
// at V054, so a V055 entry in the legacy manifest makes verifySchema fail
// closed and refuses API boot; V055 applies automatically if the database
// ever moves to the canonical schema).
// The canonical V001/V002/V004-V007 and modern workspace/auth migrations V013-V031
// are skipped in legacy mode because they assume canonical schema or rely on modern
// tables (Better Auth, workspaces, ownership transfers).
export const LEGACY_SAFE_PREFIXES = [
  "V003",
  "V008",
  "V009",
  "V010",
  "V011",
  "V012",
  "V032",
  "V033",
"V034",
  "V035",
  "V040",
  "V041",
  "V042",
  "V043",
  "V044",
  "V045",
  "V046",
  "V047",
  "V049",
  "V050",
  "V051",
  "V052",
  "V053",
  "V054",
];

/**
 * Deploy decision log for migration files that exist on disk but are
 * deliberately NOT legacy-safe. Adding a file here (or to
 * LEGACY_SAFE_PREFIXES) is a production-boot decision: the VPS boots with
 * DB_SCHEMA=legacy, so anything outside LEGACY_SAFE_PREFIXES never runs
 * there, and anything inside MUST run against the legacy pi_financeiro
 * schema without error.
 *
 * - V048: requires canonical categories.status (legacy tracks activity
 *   with an `active` boolean). Applying it in legacy mode would abort API
 *   boot with "column status does not exist". The VPS keeps the legacy
 *   check-then-insert path (no regression); V048 applies automatically if
 *   the database ever moves to the canonical schema. See
 *   docs/ops/v048-legacy-boot-decision.md.
 */
export const LEGACY_EXCLUDED_JUSTIFICATIONS: Record<string, string> = {
  V048: 'requires canonical categories.status; legacy categories use an active boolean',
  V055: 'canonical-only negative bank/cash balance check swap; VPS legacy ledger tops at V054 and verifySchema fails closed on a V055 manifest entry',
  V056: 'canonical-only structured statement-payment link (transactions.statement_payment_id); legacy keeps description-matched coverage untouched',
  V057: 'canonical-only composite household upgrade of the V056 statement-payment link; legacy keeps description-matched coverage untouched',
  V058: 'canonical-only materialized-balance anchor (accounts.initial_balance_cents); legacy already carries the column but its production ledger tops at V054 and verifySchema fails closed on a V058 manifest entry',
  V059: 'canonical-only pending-operation authorization audit columns (ADR-026); the legacy archive ledger tops at V054 and verifySchema fails closed on a V059 manifest entry, and only the canonical V2 confirm/authorize paths write authorization metadata',
};

export const migrationChecksum = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

const migrationFiles = (legacyOnly = false): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => MIGRATION_RE.test(file))
    .filter(
      (file) =>
        !legacyOnly ||
        LEGACY_SAFE_PREFIXES.some((prefix) => file.startsWith(prefix)),
    )
    .sort((a, b) => a.localeCompare(b));

/** The file-backed migration contract used by startup schema verification. */
export const expectedMigrationManifest = (
  legacyOnly = false,
): MigrationManifestEntry[] =>
  migrationFiles(legacyOnly).map((file) => {
    const match = MIGRATION_RE.exec(file);
    if (!match) throw new Error(`invalid migration filename: ${file}`);
    return {
      version: Number(match[1]),
      name: file,
      checksum: migrationChecksum(
        readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      ),
    };
  });

const ensureMigrationsTable = async (pool: DbPool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT NOT NULL DEFAULT ''",
  );
};

const appliedVersions = async (pool: DbPool): Promise<AppliedMigrationRow[]> => {
  const res = await pool.query<AppliedMigrationRow>(
    "SELECT version, name, checksum FROM _migrations",
  );
  return res.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: storedChecksumText(row.checksum),
  }));
};

export type AppliedMigrationRow = {
  version: number;
  name: string;
  checksum: string;
};

export type MigrationDrift = {
  version: number;
  kind: 'checksum' | 'name';
  expected: string;
  applied: string;
};

export type MigrationPlan = {
  drift: MigrationDrift[];
  /** Pre-guard real drift: structured WARN, boot continues (see below). */
  baselineDrift: MigrationDrift[];
  backfill: Array<{ version: number; checksum: string }>;
  pending: MigrationManifestEntry[];
};

/**
 * Deploy baseline for the M-06 drift guard. Migration versions below this
 * number were applied to production BEFORE the guard existed, and several
 * of those files were legitimately edited in past releases after being
 * applied (pre-guard history — see
 * docs/ops/migration-drift-baseline.md). Real checksum drift in those
 * versions becomes a structured WARN and does NOT refuse boot. Drift in
 * V044+ (guarded era) stays fail-closed and aborts startup.
 */
export const MIGRATION_DRIFT_BASELINE_VERSION = 44;

/**
 * Production `_migrations.checksum` predates the TEXT column in some
 * databases (legacy BYTEA storage): node-postgres then returns values as
 * `\x...` hex strings while the manifest holds plain hex. Strip a valid
 * `\x` bytea prefix so equal content compares equal; anything else is
 * returned untouched (a real mismatch must stay visible).
 */
export const normalizeStoredChecksum = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  if (value.length > 2 && value.startsWith('\\x')) {
    const hex = value.slice(2);
    if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
      return hex.toLowerCase();
    }
  }
  return value;
};

/**
 * Render a raw stored checksum as comparable text. Buffers (node-postgres
 * bytea output) become the `\x...` hex form seen in production logs, so
 * the incident artifact keeps its display shape through diagnosis while
 * `normalizeStoredChecksum` handles the comparison.
 */
export const storedChecksumText = (value: unknown): string => {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `\\x${(value as Buffer).toString('hex')}`;
  }
  return (value ?? '') as string;
};

/**
 * M-06: pure drift planner. Every applied version that also exists in the
 * manifest must match on file name AND checksum — an edited migration
 * aborts startup instead of running history silently diverged. Empty stored
 * checksums (pre-checksum rows) are adopted as baseline via backfill, never
 * treated as drift. Applied versions absent from the manifest (downgraded
 * code, legacy-only subset runs) are ignored, not drift.
 */
export const planMigrations = (
  manifest: MigrationManifestEntry[],
  applied: AppliedMigrationRow[],
): MigrationPlan => {
  const expected = new Map(manifest.map((m) => [m.version, m]));
  const appliedVersions = new Set(applied.map((r) => r.version));
  const drift: MigrationDrift[] = [];
  const baselineDrift: MigrationDrift[] = [];
  const backfill: Array<{ version: number; checksum: string }> = [];
  for (const row of applied) {
    const entry = expected.get(row.version);
    if (!entry) continue;
    if (!row.checksum) {
      backfill.push({ version: row.version, checksum: entry.checksum });
      continue;
    }
    if (row.name !== entry.name) {
      drift.push({ version: row.version, kind: 'name', expected: entry.name, applied: row.name });
    } else if (normalizeStoredChecksum(row.checksum) !== entry.checksum) {
      const record: MigrationDrift = {
        version: row.version,
        kind: 'checksum',
        expected: entry.checksum,
        applied: row.checksum,
      };
      // Pre-guard production history warns; guarded era refuses to boot.
      if (row.version < MIGRATION_DRIFT_BASELINE_VERSION) baselineDrift.push(record);
      else drift.push(record);
    }
  }
  const pending = manifest.filter((m) => !appliedVersions.has(m.version));
  return { drift, baselineDrift, backfill, pending };
};

/**
 * V4.1 Phase 9 (Task 9.5) — read-only migration validation.
 * Plans drift/backfill/pending WITHOUT applying anything and WITHOUT
 * backfilling checksums: safe for CI gates and pre-deploy checks.
 * Throws on non-baseline drift (same fail-closed rule as boot).
 */
export const validateMigrations = async (
  pool: DbPool,
  legacyOnly = false,
): Promise<MigrationPlan> => {
  await ensureMigrationsTable(pool);
  const manifest = expectedMigrationManifest(legacyOnly);
  const appliedRows = await appliedVersions(pool);
  const plan = planMigrations(manifest, appliedRows);
  if (plan.drift.length > 0) {
    const details = plan.drift
      .map((d) => `V${String(d.version).padStart(3, '0')} (${d.kind} drift: applied=${JSON.stringify(d.applied)} manifest=${JSON.stringify(d.expected)})`)
      .join('; ');
    throw new Error(
      `migration drift detected: applied migration files differ from the manifest — refusing. ${details}`,
    );
  }
  return plan;
};

export type RunMigrationsOptions = {
  /**
   * Acquire the global advisory lock for the whole run (default true).
   * Pass `false` only when the caller already holds it (migrate-job wraps
   * the backup marker + migrations in one locked section — a nested lock
   * on a second session would fail closed).
   */
  withLock?: boolean;
};

export const runMigrations = async (
  pool: DbPool,
  legacyOnly = false,
  opts: RunMigrationsOptions = {},
): Promise<{ applied: number[] }> => {
  if (opts.withLock === false) return runMigrationsInner(pool, legacyOnly);
  return withMigrationAdvisoryLock(pool, () => runMigrationsInner(pool, legacyOnly));
};

const runMigrationsInner = async (
  pool: DbPool,
  legacyOnly = false,
): Promise<{ applied: number[] }> => {
  await ensureMigrationsTable(pool);
  const manifest = expectedMigrationManifest(legacyOnly);
  const appliedRows = await appliedVersions(pool);
  const plan = planMigrations(manifest, appliedRows);
  if (plan.drift.length > 0) {
    const details = plan.drift
      .map((d) => `V${String(d.version).padStart(3, '0')} (${d.kind} drift: applied=${JSON.stringify(d.applied)} manifest=${JSON.stringify(d.expected)})`)
      .join('; ');
    throw new Error(
      `migration drift detected: applied migration files differ from the manifest — refusing to boot. ${details}`,
    );
  }
  // Pre-guard baseline drift: loud structured WARN, boot continues. Never
  // silently ignored, never a refusal — see
  // docs/ops/migration-drift-baseline.md for the reconciliation path.
  for (const d of plan.baselineDrift) {
    console.warn(
      JSON.stringify({
        event: 'migration.baseline_drift',
        version: d.version,
        kind: d.kind,
        applied: d.applied,
        expected: d.expected,
        guidance:
          'pre-guard production history; boot continues. Reconcile via checksum re-backfill after semantic audit (docs/ops/migration-drift-baseline.md).',
      }),
    );
  }
  for (const entry of plan.backfill) {
    await pool.query('UPDATE _migrations SET checksum = $1 WHERE version = $2', [entry.checksum, entry.version]);
  }
  const newlyApplied: number[] = [];

  for (const entry of plan.pending) {
    const file = entry.name;
    const version = entry.version;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // DEBT-CODER-INFRA: generous migration budget (SET LOCAL — resets
      // on COMMIT/ROLLBACK). Covers pools created with the 30s API
      // default (e.g. server boot callers) as well as migration pools.
      await applyMigrationTimeouts(client);
      await client.query(sql);
      await client.query(
        "INSERT INTO _migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [version, file, migrationChecksum(sql)],
      );
      await client.query("COMMIT");
      newlyApplied.push(version);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied: newlyApplied };
};
