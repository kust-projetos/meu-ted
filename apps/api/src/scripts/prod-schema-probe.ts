/**
 * Read-only production schema probe.
 *
 * Validates the real database shapes of a target schema (default `legacy`)
 * against the canonical-converter's expectations from
 * `./canonical-converter/plan.js` (`LEGACY_CORE_TABLES`,
 * `LEGACY_EXPECTED_COLUMNS`). Read-only by construction:
 * - the session sets `default_transaction_read_only=on` (same as
 *   `reconciliation/run.ts`);
 * - every statement passes the shared `isSelectOnly` guard before execution.
 *
 * Never prints the connection string or credentials.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import {
  LEGACY_CORE_TABLES,
  LEGACY_EXPECTED_COLUMNS,
} from './canonical-converter/plan.js';
import { isSelectOnly } from './reconciliation/sql.js';

export type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

export type TypeMismatch = {
  column: string;
  expected: string;
  actual: string;
};

export type TableColumnDiff = {
  table: string;
  missingColumns: string[];
  extraColumns: string[];
  typeMismatches: TypeMismatch[];
};

export type ProbeComparison = {
  expectedTables: string[];
  presentTables: string[];
  missingTables: string[];
  columnDiffs: TableColumnDiff[];
  uninventoriedTables: string[];
};

export type MigrationLedgerRow = {
  version: number;
  name: string;
  checksum: string;
};

export type ProbeReport = {
  generatedAt: string;
  serverVersion: string;
  schema: string;
  migrationsTop: MigrationLedgerRow[];
  migrationsLedgerMissing: boolean;
  comparison: ProbeComparison;
  rowCounts: Record<string, number>;
  absentTables: string[];
};

export type ProbeCliOptions = {
  schema: string;
  out?: string;
};

/**
 * Tables the converter inventories, derived from its own constants.
 * `plan.ts` stores expected columns as `{ table, column }` pairs (no
 * per-table arrays and no type metadata), so this groups them by table
 * here instead of duplicating the data.
 */
export const inventoriedTables = (): string[] => {
  const tables = new Set<string>(LEGACY_CORE_TABLES);
  for (const entry of LEGACY_EXPECTED_COLUMNS) tables.add(entry.table);
  return [...tables].sort();
};

export const expectedColumnsByTable = (): Map<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const entry of LEGACY_EXPECTED_COLUMNS) {
    const list = grouped.get(entry.table) ?? [];
    list.push(entry.column);
    grouped.set(entry.table, list);
  }
  return grouped;
};

/**
 * Pure comparison of actual schema shapes against the converter inventory.
 *
 * `plan.ts` carries no expected data types, so type mismatches are checked
 * only for `table.column` keys present in `expectedColumnTypes`
 * (case-insensitive); without that map no mismatch is reported.
 */
export const compareSchemaExpectations = (
  actualTables: string[],
  actualColumns: Record<string, ColumnInfo[]>,
  expectedColumnTypes: Record<string, string> = {},
): ProbeComparison => {
  const expectedTables = inventoriedTables();
  const actualSet = new Set(actualTables);
  const presentTables = expectedTables.filter((table) => actualSet.has(table));
  const missingTables = expectedTables.filter((table) => !actualSet.has(table));
  const inventoried = new Set(expectedTables);
  const uninventoriedTables = actualTables.filter((table) => !inventoried.has(table)).sort();

  const expectedByTable = expectedColumnsByTable();
  const columnDiffs: TableColumnDiff[] = [];
  for (const table of presentTables) {
    const expected = expectedByTable.get(table) ?? [];
    const expectedSet = new Set(expected);
    const actual = actualColumns[table] ?? [];
    const actualNames = actual.map((info) => info.column_name);
    const actualSetForTable = new Set(actualNames);
    const missingColumns = expected.filter((column) => !actualSetForTable.has(column)).sort();
    const extraColumns = actualNames.filter((column) => !expectedSet.has(column)).sort();
    const typeMismatches: TypeMismatch[] = [];
    for (const info of actual) {
      if (!expectedSet.has(info.column_name)) continue;
      const expectedType = expectedColumnTypes[`${table}.${info.column_name}`];
      if (expectedType === undefined) continue;
      if (expectedType.toLowerCase() !== info.data_type.toLowerCase()) {
        typeMismatches.push({
          column: info.column_name,
          expected: expectedType,
          actual: info.data_type,
        });
      }
    }
    typeMismatches.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
    columnDiffs.push({ table, missingColumns, extraColumns, typeMismatches });
  }
  return { expectedTables, presentTables, missingTables, columnDiffs, uninventoriedTables };
};

export const parseArgs = (argv: string[]): ProbeCliOptions | { help: true } => {
  const opts: ProbeCliOptions = { schema: 'legacy' };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg.startsWith('--schema=')) {
      const value = arg.slice('--schema='.length);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error(`invalid --schema: ${value} (expected a SQL identifier)`);
      }
      opts.schema = value;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length).trim();
      if (!value) throw new Error('--out requires a file path');
      opts.out = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
};

export const printHelp = (): string =>
  [
    'prod-schema-probe — read-only production schema probe for the canonical converter',
    '',
    'Usage: pnpm probe:prod-schema [--schema=<name>] [--out=<path>]',
    '',
    'Only SELECT statements are executed. The connection sets default_transaction_read_only.',
    'Exit 0 on success, 2 on usage errors, 1 on runtime failures.',
  ].join('\n');

type ProbePool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export const createProbePool = (connectionString: string): pg.Pool =>
  new pg.Pool({
    connectionString,
    max: 2,
    options: '-c default_transaction_read_only=on',
  });

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const selectRows = async (
  pool: ProbePool,
  text: string,
  values?: unknown[],
): Promise<Record<string, unknown>[]> => {
  if (!isSelectOnly(text)) throw new Error('refusing to run a non-SELECT prod-schema-probe query');
  const result = await pool.query(text, values);
  return result.rows;
};

const str = (value: unknown, fallback = ''): string =>
  value === null || value === undefined ? fallback : String(value);

const num = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('prod-schema-probe returned an invalid count');
  }
  return parsed;
};

const isMissingRelation = (error: unknown): boolean =>
  (error as { code?: string }).code === '42P01' ||
  (error as { code?: string }).code === '42703';

const readTables = async (pool: ProbePool, schema: string): Promise<string[]> => {
  const rows = await selectRows(
    pool,
    'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
    [schema],
  );
  return rows.map((row) => str(row['table_name']));
};

const readColumns = async (
  pool: ProbePool,
  schema: string,
): Promise<Record<string, ColumnInfo[]>> => {
  const rows = await selectRows(
    pool,
    'SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position',
    [schema],
  );
  const grouped: Record<string, ColumnInfo[]> = {};
  for (const row of rows) {
    const table = str(row['table_name']);
    const info: ColumnInfo = {
      column_name: str(row['column_name']),
      data_type: str(row['data_type']),
      is_nullable: str(row['is_nullable'], 'YES'),
      column_default:
        row['column_default'] === null || row['column_default'] === undefined
          ? null
          : String(row['column_default']),
    };
    grouped[table] = [...(grouped[table] ?? []), info];
  }
  return grouped;
};

const readMigrationsTop = async (
  pool: ProbePool,
  schema: string,
): Promise<{ rows: MigrationLedgerRow[]; missing: boolean }> => {
  try {
    const rows = await selectRows(
      pool,
      `SELECT version, name, checksum FROM ${quoteIdent(schema)}._migrations ORDER BY version DESC LIMIT 20`,
    );
    return {
      rows: rows.map((row) => ({
        version: Number(row['version']),
        name: str(row['name']),
        checksum: str(row['checksum']),
      })),
      missing: false,
    };
  } catch (error) {
    if (isMissingRelation(error)) return { rows: [], missing: true };
    throw error;
  }
};

const readRowCounts = async (
  pool: ProbePool,
  schema: string,
  tables: string[],
  existing: Set<string>,
): Promise<{ counts: Record<string, number>; absent: string[] }> => {
  const counts: Record<string, number> = {};
  const absent: string[] = [];
  for (const table of tables) {
    if (!existing.has(table)) {
      absent.push(table);
      continue;
    }
    const rows = await selectRows(
      pool,
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
    );
    counts[table] = num(rows[0]?.['count']);
  }
  return { counts, absent: absent.sort() };
};

export const runProdSchemaProbe = async (pool: ProbePool, schema: string): Promise<ProbeReport> => {
  // Count tables come from the converter's own IMPORT_ORDER (imported
  // dynamically so unit tests loading this module never touch the
  // converter I/O layer or open connections at import time).
  const { IMPORT_ORDER } = await import('./canonical-converter/import.js');
  const countTables: string[] = IMPORT_ORDER.map((spec) => spec.name);

  const versionRows = await selectRows(pool, 'SELECT version()');
  const serverVersion = str(versionRows[0]?.['version'] ?? versionRows[0]?.['VERSION'], 'unknown');
  const actualTables = await readTables(pool, schema);
  const actualColumns = await readColumns(pool, schema);
  const comparison = compareSchemaExpectations(actualTables, actualColumns);
  const migrations = await readMigrationsTop(pool, schema);
  const { counts, absent } = await readRowCounts(pool, schema, countTables, new Set(actualTables));
  return {
    generatedAt: new Date().toISOString(),
    serverVersion,
    schema,
    migrationsTop: migrations.rows,
    migrationsLedgerMissing: migrations.missing,
    comparison,
    rowCounts: counts,
    absentTables: absent,
  };
};

export const main = async (
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> => {
  let opts: ProbeCliOptions;
  try {
    const parsed = parseArgs(argv);
    if ('help' in parsed) {
      process.stdout.write(`${printHelp()}\n`);
      return 0;
    }
    opts = parsed;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n${printHelp()}\n`);
    return 2;
  }
  const connectionString = env['DATABASE_URL']?.trim() || env['DATABASE_URL_TEST']?.trim();
  if (!connectionString) {
    process.stderr.write('error: DATABASE_URL (or DATABASE_URL_TEST) is not set; nothing to do.\n');
    return 2;
  }
  const pool = createProbePool(connectionString);
  try {
    const report = await runProdSchemaProbe(pool, opts.schema);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(json);
    if (opts.out !== undefined) writeFileSync(opts.out, json, 'utf8');
    return 0;
  } catch (err) {
    process.stderr.write(`prod-schema-probe failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await pool.end();
  }
};

const invokedAsCli =
  process.argv[1] !== undefined && /prod-schema-probe\.(ts|js)$/.test(process.argv[1]);

if (invokedAsCli) {
  void main(process.argv.slice(2), process.env as Record<string, string | undefined>).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`prod-schema-probe failed: ${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
