import { describe, expect, it } from 'vitest';
import {
  LEGACY_CORE_TABLES,
  LEGACY_EXPECTED_COLUMNS,
} from '../../src/scripts/canonical-converter/plan.js';
import {
  compareSchemaExpectations,
  type ColumnInfo,
} from '../../src/scripts/prod-schema-probe.js';

const col = (column_name: string, data_type = 'text'): ColumnInfo => ({
  column_name,
  data_type,
  is_nullable: 'YES',
  column_default: null,
});

const expectedByTable = (): Record<string, ColumnInfo[]> => {
  const grouped: Record<string, ColumnInfo[]> = {};
  for (const entry of LEGACY_EXPECTED_COLUMNS) {
    grouped[entry.table] = [...(grouped[entry.table] ?? []), col(entry.column)];
  }
  return grouped;
};

const expectedTables = (): string[] => {
  const fromColumns = LEGACY_EXPECTED_COLUMNS.map((entry) => entry.table);
  return [...new Set([...LEGACY_CORE_TABLES, ...fromColumns])].sort();
};

describe('prod-schema-probe compareSchemaExpectations', () => {
  it('reports no diffs when every expected table and column is present', () => {
    const comparison = compareSchemaExpectations(expectedTables(), expectedByTable());

    expect(comparison.missingTables).toEqual([]);
    expect(comparison.presentTables).toEqual(expect.arrayContaining(expectedTables()));
    for (const diff of comparison.columnDiffs) {
      expect(diff.missingColumns).toEqual([]);
      expect(diff.extraColumns).toEqual([]);
      expect(diff.typeMismatches).toEqual([]);
    }
    expect(comparison.uninventoriedTables).toEqual([]);
  });

  it('reports a missing expected table and skips its column diff', () => {
    const missing = expectedTables()[0] as string;
    const tables = expectedTables().filter((table) => table !== missing);
    const columns = expectedByTable();
    delete columns[missing];

    const comparison = compareSchemaExpectations(tables, columns);

    expect(comparison.missingTables).toEqual([missing]);
    expect(comparison.presentTables).not.toContain(missing);
    expect(comparison.columnDiffs.map((diff) => diff.table)).not.toContain(missing);
  });

  it('reports a missing expected column on a present table', () => {
    const columns = expectedByTable();
    const table = LEGACY_EXPECTED_COLUMNS[0]?.table as string;
    const dropped = LEGACY_EXPECTED_COLUMNS[0]?.column as string;
    columns[table] = (columns[table] ?? []).filter((info) => info.column_name !== dropped);

    const comparison = compareSchemaExpectations(expectedTables(), columns);
    const diff = comparison.columnDiffs.find((entry) => entry.table === table);

    expect(diff?.missingColumns).toEqual([dropped]);
  });

  it('reports an extra actual column on an inventoried table', () => {
    const columns = expectedByTable();
    const table = expectedTables()[0] as string;
    columns[table] = [...(columns[table] ?? []), col('probe_extra_column')];

    const comparison = compareSchemaExpectations(expectedTables(), columns);
    const diff = comparison.columnDiffs.find((entry) => entry.table === table);

    expect(diff?.extraColumns).toEqual(['probe_extra_column']);
    expect(diff?.missingColumns).toEqual([]);
  });

  it('reports a type mismatch only for columns the converter expects', () => {
    const columns = expectedByTable();
    const table = LEGACY_EXPECTED_COLUMNS[0]?.table as string;
    const column = LEGACY_EXPECTED_COLUMNS[0]?.column as string;
    columns[table] = (columns[table] ?? []).map((info) =>
      info.column_name === column ? { ...info, data_type: 'TEXT' } : info,
    );

    const matching = compareSchemaExpectations(expectedTables(), columns, {
      [`${table}.${column}`]: 'text',
    });
    expect(
      matching.columnDiffs.find((entry) => entry.table === table)?.typeMismatches,
    ).toEqual([]);

    const mismatched = compareSchemaExpectations(expectedTables(), columns, {
      [`${table}.${column}`]: 'uuid',
    });
    expect(
      mismatched.columnDiffs.find((entry) => entry.table === table)?.typeMismatches,
    ).toEqual([{ column, expected: 'uuid', actual: 'TEXT' }]);
  });

  it('lists actual tables the converter does not inventory as informational', () => {
    const tables = [...expectedTables(), 'audit_logs'];
    const comparison = compareSchemaExpectations(tables, expectedByTable());

    expect(comparison.uninventoriedTables).toEqual(['audit_logs']);
    expect(comparison.missingTables).toEqual([]);
  });
});
