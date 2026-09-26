import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SCHEMA,
  buildArchiveStatements,
  CONVERSION_STATE_CONVERTED,
  excludeOwnedSequences,
  isCompletedState,
  listOwnedSequenceNames,
  resolveRerunAction,
  type InventoriedRelation,
} from '../../src/scripts/canonical-converter/archive-and-bootstrap.js';
import type { ConversionPool } from '../../src/scripts/canonical-converter/plan.js';

describe('canonical converter archive statements (M1)', () => {
  it('exposes a configurable archive schema default', () => {
    expect(ARCHIVE_SCHEMA).toBe('legacy_archive');
  });

  it('builds one SET SCHEMA statement per relation kind', () => {
    const relations: InventoriedRelation[] = [
      { name: 'accounts', kind: 'table' },
      { name: 'active_loans', kind: 'view' },
      { name: 'monthly_rollup', kind: 'materialized_view' },
      { name: 'transactions_id_seq', kind: 'sequence' },
      { name: 'set_updated_at', kind: 'function', identityArguments: '' },
      { name: 'notify_ledger', kind: 'function', identityArguments: 'integer, text' },
    ];
    expect(buildArchiveStatements(relations, 'public', 'legacy_archive')).toEqual([
      'ALTER TABLE "public"."accounts" SET SCHEMA "legacy_archive"',
      'ALTER VIEW "public"."active_loans" SET SCHEMA "legacy_archive"',
      'ALTER MATERIALIZED VIEW "public"."monthly_rollup" SET SCHEMA "legacy_archive"',
      'ALTER SEQUENCE "public"."transactions_id_seq" SET SCHEMA "legacy_archive"',
      'ALTER FUNCTION "public"."set_updated_at"() SET SCHEMA "legacy_archive"',
      'ALTER FUNCTION "public"."notify_ledger"(integer, text) SET SCHEMA "legacy_archive"',
    ]);
  });

  it('quotes hostile identifiers instead of interpolating them', () => {
    const statements = buildArchiveStatements(
      [{ name: 'weird"name', kind: 'table' }],
      'public',
      'legacy_archive',
    );
    expect(statements).toEqual([
      'ALTER TABLE "public"."weird""name" SET SCHEMA "legacy_archive"',
    ]);
  });

  it('refuses unknown relation kinds fail-closed', () => {
    expect(() =>
      buildArchiveStatements([{ name: 'x', kind: 'index' as InventoriedRelation['kind'] }], 'public', 'legacy_archive'),
    ).toThrow(/unsupported relation kind/);
  });
});

describe('canonical converter owned sequences (F2 real-dump rehearsal)', () => {
  const stubPool = (rows: Array<Record<string, unknown>>): ConversionPool => ({
    query: async () => ({ rows, rowCount: rows.length }),
  });

  it('never issues a redundant ALTER SEQUENCE for a sequence owned by a moved table', () => {
    const relations: InventoriedRelation[] = [
      { name: '_migration_backup_marker', kind: 'table' },
      { name: '_migration_backup_marker_id_seq', kind: 'sequence' },
      { name: 'standalone_seq', kind: 'sequence' },
    ];
    const movable = excludeOwnedSequences(relations, new Set(['_migration_backup_marker_id_seq']));
    expect(movable).toEqual([
      { name: '_migration_backup_marker', kind: 'table' },
      { name: 'standalone_seq', kind: 'sequence' },
    ]);
    expect(buildArchiveStatements(movable, 'public', 'legacy_archive')).toEqual([
      'ALTER TABLE "public"."_migration_backup_marker" SET SCHEMA "legacy_archive"',
      'ALTER SEQUENCE "public"."standalone_seq" SET SCHEMA "legacy_archive"',
    ]);
  });

  it('keeps standalone sequences when nothing is owned', () => {
    const relations: InventoriedRelation[] = [
      { name: 'accounts', kind: 'table' },
      { name: 'standalone_seq', kind: 'sequence' },
    ];
    expect(excludeOwnedSequences(relations, new Set())).toEqual(relations);
  });

  it('reads owned sequences from pg_depend ownership (deptype a)', async () => {
    const pool = stubPool([{ name: '_migration_backup_marker_id_seq' }]);
    await expect(listOwnedSequenceNames(pool, 'public')).resolves.toEqual(
      new Set(['_migration_backup_marker_id_seq']),
    );
  });

  it('returns an empty set when no sequence is table-owned', async () => {
    await expect(listOwnedSequenceNames(stubPool([]), 'public')).resolves.toEqual(new Set());
  });
});

describe('canonical converter rerun policy (M1)', () => {
  it('bootstraps when no marker exists and state is clean', () => {
    expect(resolveRerunAction({ marker: null, partial: false, backupId: 'b1' })).toBe('bootstrap');
  });

  it('no-ops on a completed marker with the same backup id', () => {
    expect(
      resolveRerunAction({
        marker: { backupId: 'b1', state: 'bootstrap_completed' },
        partial: false,
        backupId: 'b1',
      }),
    ).toBe('noop');
  });

  it('treats the M4 full-pipeline state as completed for reruns', () => {
    expect(CONVERSION_STATE_CONVERTED).toBe('completed');
    expect(isCompletedState('completed')).toBe(true);
    expect(isCompletedState('bootstrap_completed')).toBe(true);
    expect(isCompletedState('bootstrap_started')).toBe(false);
    expect(
      resolveRerunAction({
        marker: { backupId: 'b1', state: 'completed' },
        partial: false,
        backupId: 'b1',
      }),
    ).toBe('noop');
    expect(() =>
      resolveRerunAction({
        marker: { backupId: 'b1', state: 'completed' },
        partial: false,
        backupId: 'b2',
      }),
    ).toThrow(/backup/i);
  });

  it('fails closed on a completed marker with a different backup id', () => {
    expect(() =>
      resolveRerunAction({
        marker: { backupId: 'b1', state: 'bootstrap_completed' },
        partial: false,
        backupId: 'b2',
      }),
    ).toThrow(/backup/i);
  });

  it('fails closed on partial state with or without a marker', () => {
    expect(() =>
      resolveRerunAction({
        marker: { backupId: 'b1', state: 'bootstrap_started' },
        partial: true,
        backupId: 'b1',
      }),
    ).toThrow(/partial/i);
    expect(() =>
      resolveRerunAction({ marker: null, partial: true, backupId: 'b1' }),
    ).toThrow(/partial/i);
  });
});
