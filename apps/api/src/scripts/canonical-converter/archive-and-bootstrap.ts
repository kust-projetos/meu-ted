import type { DbPool } from '../../db/pool.js';
import { applyMigrationTimeouts } from '../../db/pool.js';
import { requireTestDatabase } from '../../db/db-guard.js';
import {
  expectedMigrationManifest,
  runMigrations,
  validateMigrations,
} from '../../read-models/sql/migrate.js';
import { isBackupGateSatisfied, withMigrationAdvisoryLock } from '../migration-job-policy.js';
import {
  collectConversionPlan,
  listRelations,
  type ConversionPool,
  type InventoriedRelation,
} from './plan.js';

export type { InventoriedRelation } from './plan.js';

export const ARCHIVE_SCHEMA = 'legacy_archive';
export const CONVERSION_MARKER_TABLE = '_conversion_marker';

export const CONVERSION_STATE_COMPLETED = 'bootstrap_completed';

/**
 * FINDING-3 decision (extensions): the inventory (`plan.ts`
 * `listRelations`) excludes extension-owned objects (`pg_depend`
 * `deptype = 'e'`), so `buildArchiveStatements` never attempts to move
 * them — `ALTER FUNCTION ... SET SCHEMA` refuses extension members and
 * would abort the conversion on any real installation. The extension
 * itself (pgcrypto, installed by V001/V013/V053 via
 * `CREATE EXTENSION IF NOT EXISTS`) STAYS in `public`: the canonical
 * bootstrap re-runs the same idempotent statement, which no-ops when the
 * extension is already present and keeps `gen_random_uuid()`/`digest()`
 * resolvable for column defaults. Moving the extension as a unit
 * (`ALTER EXTENSION ... SET SCHEMA legacy_archive`) was rejected: the
 * no-op `CREATE EXTENSION IF NOT EXISTS` would then leave canonical
 * defaults pointing at a schema outside the search path.
 */

/**
 * M4: full-pipeline completion marker state. The M1 bootstrap writes
 * `bootstrap_completed`; the M4 orchestrator advances the SAME backup_id row
 * to `completed` once import + identity + balances all verify. Both states
 * are terminal-complete for rerun purposes (verify + no-op), which is what
 * lets `runArchiveAndBootstrap` stay idempotent after a full conversion.
 */
export const CONVERSION_STATE_CONVERTED = 'completed';

export const isCompletedState = (state: string): boolean =>
  state === CONVERSION_STATE_COMPLETED || state === CONVERSION_STATE_CONVERTED;

/**
 * FINDING-4: explicit failed state. A failure in any post-bootstrap phase
 * records `failed` (with phase + error columns) instead of leaving an
 * ambiguous partial state. There is NO resume: a rerun over `failed` or
 * any other partial state refuses with a restore orientation
 * (`resolveRerunAction` below) — RESTORE the backup and restart from zero.
 */
export const CONVERSION_STATE_FAILED = 'failed';

export type BootstrapResult = {
  status: 'bootstrap' | 'bootstrapped' | 'noop';
  applied: number[];
  backupId: string;
  archiveSchema: string;
};

export type BootstrapOptions = {
  schema?: string;
  archiveSchema?: string;
  env?: Record<string, string | undefined>;
};

export type ConversionMarker = {
  backupId: string;
  state: string;
  phase?: string | undefined;
  failure?: string | undefined;
};

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export const buildArchiveStatements = (
  relations: InventoriedRelation[],
  fromSchema: string,
  toSchema: string,
): string[] =>
  relations.map((relation) => {
    const from = `${quoteIdent(fromSchema)}.${quoteIdent(relation.name)}`;
    const to = quoteIdent(toSchema);
    switch (relation.kind) {
      case 'table':
        return `ALTER TABLE ${from} SET SCHEMA ${to}`;
      case 'view':
        return `ALTER VIEW ${from} SET SCHEMA ${to}`;
      case 'materialized_view':
        return `ALTER MATERIALIZED VIEW ${from} SET SCHEMA ${to}`;
      case 'sequence':
        return `ALTER SEQUENCE ${from} SET SCHEMA ${to}`;
      case 'function':
        return `ALTER FUNCTION ${from}(${relation.identityArguments ?? ''}) SET SCHEMA ${to}`;
      default:
        throw new Error(
          `unsupported relation kind '${(relation as InventoriedRelation).kind}' for "${relation.name}": refusing to archive`,
        );
    }
  });

/**
 * F2 real-dump rehearsal: production dumps contain SERIAL tables (e.g.
 * `_migration_backup_marker`) whose owned sequence
 * (`_migration_backup_marker_id_seq`) is inventoried as a SEPARATE
 * `sequence` relation (`plan.ts` `listRelations`). `ALTER TABLE ... SET
 * SCHEMA` relocates an OWNED sequence to the target schema automatically,
 * so a subsequent explicit `ALTER SEQUENCE public.<owned> SET SCHEMA ...`
 * fails with `relation "public.<owned>" does not exist` and aborts the
 * whole archive transaction. Owned sequences must therefore never get
 * their own explicit move — they follow their table. Standalone sequences
 * (no table owner in the archived schema) still need the explicit move.
 *
 * Ownership is pre-computed from the catalog (`pg_depend` `deptype = 'a'`,
 * sequence `objid` owned by a table `refobjid`), NEVER by name parsing:
 * a standalone sequence may share a `<table>_<column>_seq` naming pattern
 * without being owned. The owning table is required to live in the same
 * archived schema — a sequence owned by a table outside it still needs an
 * explicit move. Fail-closed is preserved: this only withholds the
 * redundant ALTER for catalog-proven owned sequences; every other move
 * error still aborts.
 */
export const listOwnedSequenceNames = async (
  pool: ConversionPool,
  schema: string,
): Promise<Set<string>> => {
  const res = await pool.query(
    `SELECT seq.relname AS name
       FROM pg_depend d
       JOIN pg_class seq ON seq.oid = d.objid
       JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
       JOIN pg_class tbl ON tbl.oid = d.refobjid
       JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
      WHERE seq_ns.nspname = $1 AND tbl_ns.nspname = $1
        AND d.classid = 'pg_class'::regclass
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype = 'a'
        AND seq.relkind = 'S'`,
    [schema],
  );
  return new Set(res.rows.map((row) => String((row as Record<string, unknown>).name)));
};

export const excludeOwnedSequences = (
  relations: InventoriedRelation[],
  ownedSequenceNames: Set<string> | Iterable<string>,
): InventoriedRelation[] => {
  const owned = ownedSequenceNames instanceof Set ? ownedSequenceNames : new Set(ownedSequenceNames);
  return relations.filter((relation) => !(relation.kind === 'sequence' && owned.has(relation.name)));
};

export const resolveRerunAction = (input: {
  marker: ConversionMarker | null;
  partial: boolean;
  backupId: string;
}): 'bootstrap' | 'noop' => {
  const { marker, partial, backupId } = input;
  if (marker !== null) {
    if (isCompletedState(marker.state)) {
      if (marker.backupId === backupId) return 'noop';
      throw new Error(
        `conversion marker records backup_id '${marker.backupId}' (state ${marker.state}): refusing to overwrite with backup_id '${backupId}'`,
      );
    }
    // FINDING-4: failed/partial states never resume — the caller must
    // RESTORE the backup and restart from zero (per-entity transactions
    // commit independently, so partial canonical writes may be present).
    const context = marker.state === CONVERSION_STATE_FAILED && marker.phase
      ? `failed in phase '${marker.phase}'${marker.failure ? `: ${marker.failure}` : ''}`
      : `state '${marker.state}'`;
    throw new Error(
      `partial conversion state recorded (backup_id '${marker.backupId}', ${context}): ` +
      `RESTAURE o backup '${marker.backupId}' e reinicie do zero com o mesmo BACKUP_ID; refusing to continue over partial writes`,
    );
  }
  if (partial) {
    throw new Error(
      'partial conversion state detected (archive schema present or ledger absent with no completed marker): ' +
      `RESTAURE o backup '${backupId}' e reinicie do zero com o mesmo BACKUP_ID; refusing to continue over partial writes`,
    );
  }
  return 'bootstrap';
};

/**
 * REVIEW-R3-F2: shared archive-emptiness rule. `legacy_archive` existing AND
 * holding relations/functions is evidence of a previous bootstrap (partial
 * unless a completed marker says otherwise). A stray EMPTY archive schema
 * alone is not evidence — the archive move is transactional, so an empty
 * archive next to an intact `public` means no bootstrap happened. The
 * orchestrator probe (`convert.ts` `detectMarkerlessPartialState`) shares
 * this exact predicate so both paths agree on what "partial" means.
 */
export const archiveHoldsObjects = async (
  pool: ConversionPool,
  archiveSchema: string,
): Promise<boolean> => {
  const nsRes = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists`, [
    archiveSchema,
  ]);
  if ((nsRes.rows[0] as Record<string, unknown> | undefined)?.exists !== true) return false;
  const relRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
    [archiveSchema],
  );
  const fnRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
    [archiveSchema],
  );
  return Number(relRes.rows[0]?.n ?? 0) + Number(fnRes.rows[0]?.n ?? 0) > 0;
};

const readMarker = async (pool: ConversionPool, schema: string): Promise<ConversionMarker | null> => {
  try {
    const res = await pool.query(
      `SELECT backup_id, state FROM ${quoteIdent(schema)}.${quoteIdent(CONVERSION_MARKER_TABLE)} ORDER BY id DESC LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return null;
    return { backupId: String(row.backup_id), state: String(row.state) };
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return null;
    throw error;
  }
};

const detectPartial = async (
  pool: ConversionPool,
  schema: string,
  archiveSchema: string,
): Promise<boolean> => {
  // REVIEW-R3-F2: an EMPTY pre-existing archive is not partial state (same
  // rule as the orchestrator markerless probe) — it is reused below by
  // CREATE SCHEMA IF NOT EXISTS. Only an archive WITH objects refuses.
  if (await archiveHoldsObjects(pool, archiveSchema)) return true;
  const ledger = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = '_migrations') AS exists`,
    [schema],
  );
  return ledger.rows[0]?.exists !== true;
};

const columnNames = async (pool: ConversionPool, schema: string, table: string): Promise<Set<string>> => {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return new Set(res.rows.map((row) => String(row.column_name)));
};

const verifyCanonicalShape = async (pool: ConversionPool, schema: string): Promise<void> => {
  const accounts = await columnNames(pool, schema, 'accounts');
  const transactions = await columnNames(pool, schema, 'transactions');
  const missing: string[] = [];
  if (!accounts.has('kind')) missing.push('accounts.kind');
  if (!transactions.has('account_id')) missing.push('transactions.account_id');
  if (accounts.has('is_credit_card')) missing.push('unexpected legacy accounts.is_credit_card');
  if (transactions.has('from_account_id')) missing.push('unexpected legacy transactions.from_account_id');
  if (missing.length > 0) {
    throw new Error(`canonical shape verification failed: ${missing.join(', ')}`);
  }
};

const verifyCanonicalLedger = async (pool: DbPool): Promise<void> => {
  const plan = await validateMigrations(pool, false);
  if (plan.pending.length > 0) {
    throw new Error(
      `canonical ledger incomplete: missing ${plan.pending.map((m) => m.name).join(', ')}`,
    );
  }
  const manifest = expectedMigrationManifest(false);
  const applied = await pool.query(`SELECT version FROM _migrations`);
  const versions = new Set(applied.rows.map((row) => Number(row.version)));
  const absent = manifest.map((m) => m.version).filter((v) => !versions.has(v));
  if (absent.length > 0) {
    throw new Error(`canonical ledger incomplete: versions absent: ${absent.join(', ')}`);
  }
};

export const runArchiveAndBootstrap = async (
  pool: DbPool,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> => {
  const schema = opts.schema ?? 'public';
  const archiveSchema = opts.archiveSchema ?? ARCHIVE_SCHEMA;
  const env = opts.env ?? process.env;
  const backupId = env.BACKUP_ID?.trim() ?? '';
  if (!isBackupGateSatisfied(env)) {
    throw new Error('canonical conversion backup gate not satisfied: BACKUP_CONFIRMED=true and BACKUP_ID are required');
  }
  if (env.NODE_ENV !== 'production') {
    await requireTestDatabase(pool, 'canonical-converter');
  }

  return withMigrationAdvisoryLock(pool, async () => {
    const marker = await readMarker(pool, schema);
    const partial = await detectPartial(pool, schema, archiveSchema);
    const action = resolveRerunAction({ marker, partial, backupId });

    if (action === 'noop') {
      await verifyCanonicalLedger(pool);
      await verifyCanonicalShape(pool, schema);
      return { status: 'noop', applied: [], backupId, archiveSchema };
    }

    // The legacy plan only applies pre-conversion. Past this point there is
    // no completed marker, so `public` must still hold the legacy snapshot.
    const plan = await collectConversionPlan(pool, { schema });
    if (!plan.ready) {
      const details = plan.blockers.map((b) => `${b.code}(${b.count})`).join('; ');
      throw new Error(`conversion plan is NO-GO: ${details}`);
    }

    const fresh = await listRelations(pool, schema);
    const planned = new Set(plan.inventory.relations.map((r) => `${r.kind}:${r.name}`));
    const extra = fresh.filter((r) => !planned.has(`${r.kind}:${r.name}`));
    if (extra.length > 0) {
      throw new Error(
        `uninventoried relations found in "${schema}" after planning (${extra.map((r) => r.name).join(',')}): refusing to archive`,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyMigrationTimeouts(client);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(archiveSchema)}`);
      // Owned sequences follow their table under ALTER TABLE ... SET SCHEMA;
      // issuing their own ALTER SEQUENCE afterwards would fail with
      // `relation "public.<seq>" does not exist`. Withhold exactly those.
      const ownedSequences = await listOwnedSequenceNames(pool, schema);
      const movable = excludeOwnedSequences(fresh, ownedSequences);
      for (const statement of buildArchiveStatements(movable, schema, archiveSchema)) {
        await client.query(statement);
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw error;
    } finally {
      client.release();
    }

    const migrated = await runMigrations(pool, false, { withLock: false });
    await verifyCanonicalLedger(pool);
    await verifyCanonicalShape(pool, schema);

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.${quoteIdent(CONVERSION_MARKER_TABLE)} (
        id SERIAL PRIMARY KEY,
        backup_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        state TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL DEFAULT ''
      )`,
    );
    await pool.query(
      `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(CONVERSION_MARKER_TABLE)} (backup_id, finished_at, state, plan_fingerprint)
       VALUES ($1, NOW(), $2, $3)`,
      [backupId, CONVERSION_STATE_COMPLETED, plan.fingerprint],
    );
    return { status: 'bootstrapped', applied: migrated.applied, backupId, archiveSchema };
  });
};
