import { createHash } from 'node:crypto';
import {
  expectedMigrationManifest,
  normalizeStoredChecksum,
  planMigrations,
  type AppliedMigrationRow,
  type MigrationDrift,
  type MigrationPlan,
} from '../../read-models/sql/migrate.js';
import {
  buildCanonicalConversionPreflight,
  PREFLIGHT_QUERIES,
  runCanonicalConversionPreflight,
  type CanonicalConversionPreflight,
} from '../canonical-conversion-preflight.js';

export type RelationKind = 'table' | 'view' | 'materialized_view' | 'sequence' | 'function';

export type InventoriedRelation = {
  name: string;
  kind: RelationKind;
  identityArguments?: string;
};

export type ConversionBlocker = {
  code: string;
  count: number;
  evidence: string;
};

/**
 * M4: non-blocking observations kept in the report for audit purposes.
 * `nonzero_initial_balance` moved here once the V058 anchor + M3 backfill
 * made anchored balances convertible instead of a hard stop.
 */
export type ConversionInformational = {
  code: string;
  count: number;
  evidence: string;
};

export type ConversionQueryRow = { [key: string]: unknown };

export type ConversionQueryResult = {
  rows: ConversionQueryRow[];
  rowCount?: number | null;
};

/** A preflight observation query that failed instead of returning a count. */
export type PreflightQueryError = {
  /** PREFLIGHT_QUERIES key (or 'unknown' when the text is unrecognized). */
  query: string;
  /** Postgres SQLSTATE (e.g. '42883', '42703') or 'unknown'. No row data. */
  code: string;
  /** Sanitized single-line server message (capped; never row contents). */
  message: string;
};

/**
 * Audited V023 baseline divergence (diagnosis 2026-09-26, dry-run gate on
 * the anonymized production dump: `canonical:V023:checksum`).
 *
 * The repo's V023 file gained ONE additive idempotent line AFTER
 * production applied it (`ADD COLUMN IF NOT EXISTS chat_id`, commit
 * `0cae822` — the column `src/approvals/pending.ts` writes was missing on
 * fresh databases); the production schema already carries the column, and
 * the migrate runtime tolerates this pre-guard drift with a warning
 * (`migrate.ts` baselineDrift: V023 < MIGRATION_DRIFT_BASELINE_VERSION 44,
 * boot continues — confirmed, migrate.ts unchanged).
 *
 * 2026-09-26 schema-qualification fix for the archived-schema multi-schema
 * replay (F2 rehearsal): V023's DO blocks probed information_schema /
 * pg_constraint by table NAME only, matching the archived namesake in
 * `legacy_archive` while the unqualified ALTER resolved to the fresh public
 * table (`column "household_id" ... does not exist`). All four column
 * probes are now scoped by `table_schema = 'public'` and both constraint
 * probes by `conrelid = to_regclass('public.pending_operations')`. Fresh-DB
 * semantics are unchanged (m-suite replays stay green) and the file stays
 * idempotent.
 *
 * The converter forgives a CLOSED SET of exactly three forms, all anchored
 * at the CURRENT (re-qualified) file hash on the expected side:
 *   1. ledger checksum == the historical full hash below (original
 *      production application, read from production `_migrations`);
 *   2. ledger checksum == the pre-qualification full hash below (databases
 *      that applied V023 between 0cae822 and the re-qualification);
 *   3. ledger checksum == the current file hash itself.
 * Any other V023 checksum drift, any name drift, and any V044+ drift keep
 * blocking.
 */
export const V023_AUDITED_CURRENT_CHECKSUM =
  'f00db6996ba65ea0d7e33dc902772fea7c501286d8fc66a3be60107820a9b828';
export const V023_AUDITED_PREVIOUS_CHECKSUM =
  'ca412d7481a912ff8fa4a254a8e873d17768a018991d2dd2177e9529aa815901';
// Full hash pinned from production `_migrations` 2026-09-26 (original
// production application of V023; supersedes the earlier 8-hex
// `9c8cb904` prefix diagnosis — prefix matching is no longer accepted).
export const V023_AUDITED_HISTORICAL_CHECKSUM =
  '9c8cb904d96c1b37b45533e0cb16e561ece865b01c4775a3926b519b798a6a76';
/** @deprecated prefix-only matching is no longer accepted; use V023_AUDITED_HISTORICAL_CHECKSUM. */
export const V023_AUDITED_HISTORICAL_PREFIX = '9c8cb904';

export const isAuditedV023BaselineDivergence = (drift: Pick<MigrationDrift, 'version' | 'kind' | 'expected' | 'applied'>): boolean => {
  if (drift.version !== 23 || drift.kind !== 'checksum' || drift.expected !== V023_AUDITED_CURRENT_CHECKSUM) {
    return false;
  }
  const applied = normalizeStoredChecksum(drift.applied).toLowerCase();
  return (
    applied === V023_AUDITED_HISTORICAL_CHECKSUM ||
    applied === V023_AUDITED_PREVIOUS_CHECKSUM ||
    applied === V023_AUDITED_CURRENT_CHECKSUM
  );
};

export type ConversionPool = {
  query: (sql: string, params?: unknown[]) => Promise<ConversionQueryResult>;
};

/** Structural alias used by the M1 unit suite for stubbed pools. */
export type StubPool = ConversionPool;

export type PlanEvidence = {
  relations: InventoriedRelation[];
  counts: Record<string, number>;
  contentDigests: Record<string, string>;
  legacyMigrationPlan: MigrationPlan;
  canonicalMigrationPlan: MigrationPlan;
  ledgerMissing: boolean;
  nonzeroInitialBalance: number;
  missingLegacyColumns: string[];
  missingCoreTables: string[];
  preflight: CanonicalConversionPreflight;
  preflightErrors: PreflightQueryError[];
  knownRelations?: string[] | undefined;
};

export type ConversionInventory = {
  schema: string;
  relations: InventoriedRelation[];
  counts: Record<string, number>;
  contentDigests: Record<string, string>;
  ledger: AppliedMigrationRow[];
  legacyMigrationPlan: MigrationPlan;
  canonicalMigrationPlan: MigrationPlan;
  ledgerMissing: boolean;
  foreignKeyCount: number;
  nonzeroInitialBalance: number;
  missingLegacyColumns: string[];
  missingCoreTables: string[];
  preflight: CanonicalConversionPreflight;
  preflightErrors: PreflightQueryError[];
};

export type ConversionPlan = {
  ready: boolean;
  blockers: ConversionBlocker[];
  informational: ConversionInformational[];
  inventory: ConversionInventory;
  fingerprint: string;
};

export const LEGACY_CORE_TABLES = ['accounts', 'transactions'];

export const LEGACY_EXPECTED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'accounts', column: 'id' },
  { table: 'accounts', column: 'household_id' },
  { table: 'accounts', column: 'is_credit_card' },
  { table: 'accounts', column: 'initial_balance_cents' },
  { table: 'accounts', column: 'deleted_at' },
  { table: 'transactions', column: 'id' },
  { table: 'transactions', column: 'household_id' },
  { table: 'transactions', column: 'kind' },
  { table: 'transactions', column: 'from_account_id' },
  { table: 'transactions', column: 'to_account_id' },
  { table: 'transactions', column: 'deleted_at' },
];

const intCount = (value: unknown): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('canonical converter plan returned an invalid count');
  }
  return count;
};

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const isMissingRelation = (error: unknown): boolean =>
  (error as { code?: string }).code === '42P01' ||
  (error as { code?: string }).code === '42703';

const relkindToKind = (relkind: string): RelationKind | null => {
  switch (relkind) {
    case 'r':
    case 'p':
    case 'f':
      return 'table';
    case 'v':
      return 'view';
    case 'm':
      return 'materialized_view';
    case 'S':
      return 'sequence';
    default:
      return null;
  }
};

export const listRelations = async (pool: ConversionPool, schema: string): Promise<InventoriedRelation[]> => {
  // FINDING-3: objects owned by an extension (pgcrypto, installed by
  // V001/V013/V053) live in public but MUST NOT be inventoried as app
  // objects: `ALTER ... SET SCHEMA` refuses to move them and the
  // conversion would abort on any real installation. They are filtered
  // via the extension-dependency catalog (`pg_depend.deptype = 'e'`).
  // Decision (see archive-and-bootstrap header): the extension itself
  // STAYS in public — the canonical migrations recreate it with
  // `CREATE EXTENSION IF NOT EXISTS`, which is a no-op when already
  // present, keeping `gen_random_uuid()`/`digest()` resolvable.
  // REVIEW-R2-M2: the filter matches by OID identity, NEVER by name. A
  // name match drops an app function that merely shares the extension
  // member's name with a distinct signature (e.g. app `digest(text)`
  // vs pgcrypto `digest(text, text)`), and such a function would then
  // never be archived.
  const extensionOwned = await listExtensionOwnedOids(pool, schema);
  const res = await pool.query(
    `SELECT c.oid::text AS oid, c.relname AS name, c.relkind AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      ORDER BY c.relname`,
    [schema],
  );
  const relations: InventoriedRelation[] = [];
  for (const row of res.rows) {
    if (extensionOwned.relations.has(String(row.oid))) continue;
    const kind = relkindToKind(String(row.name !== undefined ? row.kind : ''));
    if (kind === null) continue;
    relations.push({ name: String(row.name), kind });
  }
  const fns = await pool.query(
    `SELECT p.oid::text AS oid, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
      ORDER BY p.proname`,
    [schema],
  );
  for (const row of fns.rows) {
    if (extensionOwned.functions.has(String(row.oid))) continue;
    relations.push({ name: String(row.name), kind: 'function', identityArguments: String(row.args ?? '') });
  }
  return relations;
};

/**
 * OIDs in `schema` owned by an extension (dependency `deptype = 'e'`),
 * split by object class. Identity-based: two functions sharing a name
 * with distinct signatures have distinct OIDs, so only the true
 * extension member is excluded.
 */
export const listExtensionOwnedOids = async (
  pool: ConversionPool,
  schema: string,
): Promise<{ relations: Set<string>; functions: Set<string> }> => {
  const relations = new Set<string>();
  const classOids = await pool.query(
    `SELECT d.objid::text AS oid
       FROM pg_depend d
       JOIN pg_class c ON c.oid = d.objid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND d.classid = 'pg_class'::regclass AND d.deptype = 'e'`,
    [schema],
  );
  for (const row of classOids.rows) relations.add(String(row.oid));
  const functions = new Set<string>();
  const procOids = await pool.query(
    `SELECT d.objid::text AS oid
       FROM pg_depend d
       JOIN pg_proc p ON p.oid = d.objid
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'`,
    [schema],
  );
  for (const row of procOids.rows) functions.add(String(row.oid));
  return { relations, functions };
};

/**
 * Names in `schema` owned by an extension (dependency `deptype = 'e'`),
 * across relations and functions.
 *
 * @deprecated REVIEW-R2-M2: name-based filtering is UNSOUND for functions —
 * an app homonym sharing the extension member's name (distinct signature)
 * would be wrongly excluded. `listRelations` now filters by OID identity
 * via `listExtensionOwnedOids`. Kept exported for backward compatibility
 * only; do not use for inventory filtering.
 */
export const listExtensionOwnedNames = async (pool: ConversionPool, schema: string): Promise<Set<string>> => {
  const owned = new Set<string>();
  const classNames = await pool.query(
    `SELECT c.relname AS name
       FROM pg_depend d
       JOIN pg_class c ON c.oid = d.objid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND d.classid = 'pg_class'::regclass AND d.deptype = 'e'`,
    [schema],
  );
  for (const row of classNames.rows) owned.add(String(row.name));
  const procNames = await pool.query(
    `SELECT p.proname AS name
       FROM pg_depend d
       JOIN pg_proc p ON p.oid = d.objid
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'`,
    [schema],
  );
  for (const row of procNames.rows) owned.add(String(row.name));
  return owned;
};

const countTable = async (pool: ConversionPool, schema: string, table: string): Promise<number> => {
  const res = await pool.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)}`);
  return intCount(res.rows[0]?.count);
};

/**
 * SOURCE-DIGEST (bounded-memory fix): deterministic per-table content
 * evidence with O(1) application memory.
 *
 * Design:
 * - TABLES only (`relation.kind === 'table'`): views, materialized views
 *   and sequences carry no convertible row content of their own, and
 *   extension-owned / temp objects never reach the inventory
 *   (`listRelations` filters extension members by OID; temp tables live
 *   outside the inventoried schema).
 * - Single-row DB aggregate: the query returns exactly ONE row
 *   (`COUNT(*)` + two `SUM()` accumulators over `md5(t::text)` split into
 *   high/low 64-bit halves). Postgres holds only three accumulators while
 *   scanning — no `string_agg`/`array_agg` server-side accumulation, no
 *   `ORDER BY` of the whole table, no per-row hashes leaving Postgres.
 *   The Node side hashes one short `n:s_hi:s_lo` string, so application
 *   memory is bounded regardless of table size.
 * - `t::text` is the table's own rowtype rendering, schema-name free, so
 *   the digest is comparable across `public` and `legacy_archive`. No
 *   `pgcrypto` dependency. No raw PII appears in the inventory or
 *   fingerprint.
 * - Row-order independent: `COUNT` + `SUM` are commutative, so physical/
 *   insertion order (heap, autovacuum, dump restore) cannot flip the
 *   digest. Exact duplicate handling: every occurrence contributes to both
 *   sums, so multiplicities are part of the digest (unlike XOR, where an
 *   even multiplicity cancels out).
 * - Fail closed: any query error propagates (the plan is never built over
 *   unknown content), a missing aggregate row throws, and malformed
 *   `n`/`s_hi`/`s_lo` values throw instead of being digested silently. An
 *   empty table digests deterministically as SHA-256 of `"0:0:0"`.
 */
export const digestTableContent = async (
  pool: ConversionPool,
  schema: string,
  table: string,
): Promise<string> => {
  const res = await pool.query(
    `SELECT COUNT(*)::text AS n, ` +
      `COALESCE(SUM((('x' || SUBSTR(md5(t::text), 1, 16))::bit(64)::bigint)), 0::numeric)::text AS s_hi, ` +
      `COALESCE(SUM((('x' || SUBSTR(md5(t::text), 17, 16))::bit(64)::bigint)), 0::numeric)::text AS s_lo ` +
      `FROM ${quoteIdent(schema)}.${quoteIdent(table)} AS t`,
  );
  const row = res.rows[0] as { n?: unknown; s_hi?: unknown; s_lo?: unknown } | undefined;
  if (row === undefined) {
    throw new Error(
      `canonical converter plan returned no content aggregate for "${schema}"."${table}": refusing to digest`,
    );
  }
  const nText = typeof row.n === 'string' ? row.n : String(row.n ?? '');
  const sHiText = typeof row.s_hi === 'string' ? row.s_hi : String(row.s_hi ?? '');
  const sLoText = typeof row.s_lo === 'string' ? row.s_lo : String(row.s_lo ?? '');
  if (!/^\d+$/.test(nText)) {
    throw new Error(
      `canonical converter plan returned a malformed content aggregate for "${schema}"."${table}": refusing to digest`,
    );
  }
  const n = Number(nText);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `canonical converter plan returned a malformed content aggregate for "${schema}"."${table}": refusing to digest`,
    );
  }
  if (!/^-?\d+$/.test(sHiText) || !/^-?\d+$/.test(sLoText)) {
    throw new Error(
      `canonical converter plan returned a malformed content aggregate for "${schema}"."${table}": refusing to digest`,
    );
  }
  return createHash('sha256').update(`${nText}:${sHiText}:${sLoText}`, 'utf8').digest('hex');
};

export const digestTableContents = async (
  pool: ConversionPool,
  schema: string,
  relations: InventoriedRelation[],
): Promise<Record<string, string>> => {
  // Sequential on purpose: the orchestrator (`convert.ts`
  // `collectPlanForSchema`) funnels queries through a single serialized pg
  // client, so concurrent fans offer nothing and only obscure failure
  // attribution. Fail-closed is preserved: the first error aborts the plan.
  const digests: Record<string, string> = {};
  for (const relation of relations) {
    if (relation.kind !== 'table') continue;
    digests[relation.name] = await digestTableContent(pool, schema, relation.name);
  }
  return digests;
};

const readLedger = async (
  pool: ConversionPool,
  schema: string,
): Promise<{ ledger: AppliedMigrationRow[]; missing: boolean }> => {
  try {
    const res = await pool.query(
      `SELECT version, name, checksum FROM ${quoteIdent(schema)}._migrations`,
    );
    return {
      ledger: res.rows.map((row) => ({
        version: Number(row.version),
        name: String(row.name),
        checksum: String(row.checksum ?? ''),
      })),
      missing: false,
    };
  } catch (error) {
    if (isMissingRelation(error)) return { ledger: [], missing: true };
    throw error;
  }
};

const countForeignKeys = async (pool: ConversionPool, schema: string): Promise<number> => {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.contype = 'f'`,
    [schema],
  );
  return intCount(res.rows[0]?.count);
};

const countNonzeroInitialBalances = async (pool: ConversionPool, schema: string): Promise<number> => {
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdent(schema)}.accounts WHERE initial_balance_cents <> 0`,
    );
    return intCount(res.rows[0]?.count);
  } catch (error) {
    if (isMissingRelation(error)) return 0;
    throw error;
  }
};

const missingColumns = async (pool: ConversionPool, schema: string): Promise<string[]> => {
  const tables = [...new Set(LEGACY_EXPECTED_COLUMNS.map((c) => c.table))];
  const res = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2)`,
    [schema, tables],
  );
  const found = new Set(res.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`));
  return LEGACY_EXPECTED_COLUMNS.map((c) => `${c.table}.${c.column}`).filter((key) => !found.has(key));
};

export const buildConversionPlan = (evidence: PlanEvidence): Omit<ConversionPlan, 'inventory' | 'fingerprint'> & {
  inventory?: never;
  fingerprint?: never;
} => {
  const blockers: ConversionBlocker[] = [];
  const informational: ConversionInformational[] = [];
  if (evidence.ledgerMissing) {
    blockers.push({ code: 'migration_ledger_missing', count: 1, evidence: '_migrations table not found' });
  }
  for (const [manifest, plan] of [
    ['legacy', evidence.legacyMigrationPlan],
    ['canonical', evidence.canonicalMigrationPlan],
  ] as const) {
    for (const drift of plan.drift) {
      blockers.push({
        code: 'migration_drift',
        count: 1,
        evidence: `${manifest}:V${String(drift.version).padStart(3, '0')}:${drift.kind}`,
      });
    }
    for (const drift of plan.baselineDrift) {
      if (isAuditedV023BaselineDivergence(drift)) {
        informational.push({
          code: 'migration_baseline_v023_audited',
          count: 1,
          evidence: `${manifest}:V${String(drift.version).padStart(3, '0')}:${drift.kind} (audited divergence, commit 0cae822)`,
        });
        continue;
      }
      blockers.push({
        code: 'migration_baseline_drift',
        count: 1,
        evidence: `${manifest}:V${String(drift.version).padStart(3, '0')}:${drift.kind}`,
      });
    }
    for (const entry of plan.backfill) {
      blockers.push({
        code: 'migration_ledger_unverifiable',
        count: 1,
        evidence: `${manifest}:V${String(entry.version).padStart(3, '0')}:empty-checksum`,
      });
    }
  }
  for (const finding of evidence.preflight.findings) {
    if (finding.blocker) {
      blockers.push({ code: finding.code, count: finding.count, evidence: 'preflight' });
    }
  }
  // FIX (dry-run gate 2026-09-26): a failed observation query used to be
  // swallowed into a silent zero-count plus a bare `preflight_unavailable`
  // blocker, hiding the real SQL failure (e.g. `text = uuid` on
  // memberships, missing column on invites). The sanitized SQLSTATE and
  // server message now reach the blocker diagnostics and fail the plan as
  // `preflight_error` — a zero count is only ever reported when the query
  // actually returned zero.
  if (evidence.preflightErrors.length > 0) {
    const detail = [...evidence.preflightErrors]
      .map((entry) => `${entry.query}(${entry.code}): ${entry.message}`)
      .sort()
      .join('; ');
    blockers.push({
      code: 'preflight_error',
      count: evidence.preflightErrors.length,
      evidence: detail,
    });
  }
  if (evidence.nonzeroInitialBalance > 0) {
    informational.push({
      code: 'nonzero_initial_balance',
      count: evidence.nonzeroInitialBalance,
      evidence: 'accounts.initial_balance_cents <> 0 (anchored by V058, backfilled by the M3 balances step)',
    });
  }
  if (evidence.missingLegacyColumns.length > 0) {
    blockers.push({
      code: 'legacy_fingerprint_mismatch',
      count: evidence.missingLegacyColumns.length,
      evidence: [...evidence.missingLegacyColumns].sort().join(','),
    });
  }
  if (evidence.missingCoreTables.length > 0) {
    blockers.push({
      code: 'missing_legacy_core_table',
      count: evidence.missingCoreTables.length,
      evidence: [...evidence.missingCoreTables].sort().join(','),
    });
  }
  if (evidence.knownRelations !== undefined) {
    const known = new Set(evidence.knownRelations);
    const extra = evidence.relations.map((r) => r.name).filter((name) => !known.has(name));
    if (extra.length > 0) {
      blockers.push({
        code: 'uninventoried_public_relation',
        count: extra.length,
        evidence: [...extra].sort().join(','),
      });
    }
  }
  return { ready: blockers.length === 0, blockers, informational };
};

const sanitizePreflightErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/g, ' ').trim().slice(0, 280);
  return singleLine === '' ? 'unknown error' : singleLine;
};

const preflightErrorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.trim() !== '' ? code : 'unknown';
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${entries.join(',')}}`;
};

export const fingerprintPlan = (plan: Omit<ConversionPlan, 'fingerprint'>): string => {
  // The fingerprint identifies the inventoried SOURCE, not the schema name
  // holding it: the M4 orchestrator collects the authorizing plan over
  // `public` pre-bootstrap and re-collects it over `legacy_archive` once
  // the legacy lives there (SET SCHEMA moves relations 1:1). Normalizing
  // the schema name keeps the two proofs comparable so a rerun can tell
  // "same source" from "source changed since the conversion". The
  // per-table `contentDigests` (SOURCE-DIGEST) ride inside `inventory`, so
  // same-cardinality VALUE changes flip the fingerprint exactly like
  // count/ledger/preflight changes do.
  const normalized: Omit<ConversionPlan, 'fingerprint'> = {
    ...plan,
    inventory: { ...plan.inventory, schema: '' },
  };
  return createHash('sha256').update(stableStringify(normalized), 'utf8').digest('hex');
};

export const collectConversionPlan = async (
  pool: ConversionPool,
  opts: { schema?: string; knownRelations?: string[] } = {},
): Promise<ConversionPlan> => {
  const schema = opts.schema ?? 'public';
  const relations = await listRelations(pool, schema);
  const names = new Set(relations.map((r) => r.name));
  const counts: Record<string, number> = {};
  for (const relation of relations) {
    if (relation.kind === 'function') continue;
    counts[relation.name] = await countTable(pool, schema, relation.name);
  }
  // SOURCE-DIGEST: content evidence for every inventoried TABLE. Views,
  // materialized views and sequences are inventoried (and counted) but
  // never content-digested; functions are neither counted nor digested.
  // Partial coverage would be a misleading proof, so this covers ALL
  // inventoried tables or throws (fail closed) — never a silent subset.
  const contentDigests = await digestTableContents(pool, schema, relations);
  const { ledger, missing } = await readLedger(pool, schema);
  const legacyMigrationPlan = planMigrations(expectedMigrationManifest(true), ledger);
  const canonicalMigrationPlan = planMigrations(expectedMigrationManifest(false), ledger);
  const [foreignKeyCount, nonzeroInitialBalance, missingLegacyColumns] = await Promise.all([
    countForeignKeys(pool, schema),
    countNonzeroInitialBalances(pool, schema),
    missingColumns(pool, schema),
  ]);
  const missingCoreTables = LEGACY_CORE_TABLES.filter((table) => !names.has(table));
  const preflightErrors: PreflightQueryError[] = [];
  const preflight = await runCanonicalConversionPreflight(async (text) => {
    try {
      const res = await pool.query(text);
      return res.rows.map((row) => ({ count: row.count }));
    } catch (error) {
      const name = Object.keys(PREFLIGHT_QUERIES).find((key) => PREFLIGHT_QUERIES[key as keyof typeof PREFLIGHT_QUERIES] === text) ?? 'unknown';
      preflightErrors.push({
        query: name,
        code: preflightErrorCode(error),
        message: sanitizePreflightErrorMessage(error),
      });
      return [{ count: 0 }];
    }
  });
  const inventory: ConversionInventory = {
    schema,
    relations,
    counts,
    contentDigests,
    ledger,
    legacyMigrationPlan,
    canonicalMigrationPlan,
    ledgerMissing: missing,
    foreignKeyCount,
    nonzeroInitialBalance,
    missingLegacyColumns,
    missingCoreTables,
    preflight,
    preflightErrors,
  };
  const { ready, blockers, informational } = buildConversionPlan({ ...inventory, knownRelations: opts.knownRelations });
  const withoutFingerprint: Omit<ConversionPlan, 'fingerprint'> = { ready, blockers, informational, inventory };
  return { ...withoutFingerprint, fingerprint: fingerprintPlan(withoutFingerprint) };
};

export { buildCanonicalConversionPreflight };
