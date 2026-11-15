import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_EXCLUDED_JUSTIFICATIONS,
  LEGACY_SAFE_PREFIXES,
  expectedMigrationManifest,
} from '../../src/read-models/sql/migrate.js';

const v047 = readFileSync(new URL('../../src/read-models/sql/V047__statement_uniqueness.sql', import.meta.url), 'utf8');
const v048 = readFileSync(new URL('../../src/read-models/sql/V048__category_uniqueness.sql', import.meta.url), 'utf8');

describe('V047 statement uniqueness (H-04) + card metadata (M-04)', () => {
  it('is registered in canonical and legacy manifests', () => {
    expect(expectedMigrationManifest(false).map(({ version }) => version)).toContain(47);
    expect(expectedMigrationManifest(true).map(({ version }) => version)).toContain(47);
  });

  it('dedupes statements deterministically before constraining', () => {
    expect(v047).toMatch(/SELECT DISTINCT ON \(household_id, account_id, cycle_year_month\)/);
    // Both link tables are re-pointed to the keeper before losers are deleted.
    expect(v047).toMatch(/UPDATE transactions[\s\S]*SET statement_id = k\.id/);
    expect(v047).toMatch(/UPDATE card_purchases[\s\S]*SET statement_id = k\.id/);
    expect(v047).toMatch(/DELETE FROM statements/);
  });

  it('adds the unique index backing INSERT ... ON CONFLICT DO NOTHING', () => {
    expect(v047).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS statements_household_account_cycle_uidx/);
    expect(v047).toMatch(/ON statements \(household_id, account_id, cycle_year_month\)/);
  });

  it('adds subcategory + notes columns to card_purchases', () => {
    expect(v047).toMatch(/ALTER TABLE card_purchases ADD COLUMN IF NOT EXISTS subcategory_id UUID/);
    expect(v047).toMatch(/ALTER TABLE card_purchases ADD COLUMN IF NOT EXISTS notes TEXT/);
  });
});

describe('V048 category uniqueness (M-02)', () => {
  it('is registered in the canonical manifest only (status-based predicate)', () => {
    expect(expectedMigrationManifest(false).map(({ version }) => version)).toContain(48);
    expect(expectedMigrationManifest(true).map(({ version }) => version)).not.toContain(48);
  });

  it('re-points referencing transactions before deactivating losers', () => {
    expect(v048).toMatch(/SET category_id = k\.id/);
    expect(v048).toMatch(/SET subcategory_id = k\.id/);
    expect(v048).toMatch(/SET status = 'inactive'/);
  });

  it('adds a partial functional unique index on the matching key', () => {
    expect(v048).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS categories_household_kind_parent_name_uidx/);
    expect(v048).toMatch(/COALESCE\(parent_id/);
    expect(v048).toMatch(/lower\(name\)/);
    expect(v048).toMatch(/WHERE status = 'active' AND deleted_at IS NULL/);
  });
});

describe('legacy-safe inventory pin (deploy)', () => {
  const SQL_DIR = new URL('../../src/read-models/sql/', import.meta.url);
  const migrationFiles = (): string[] =>
    readdirSync(SQL_DIR)
      .filter((file) => /^V\d+__.*\.sql$/.test(file))
      .sort();

  it('every V044+ migration file is either legacy-safe or explicitly justified', () => {
    const files = migrationFiles();
    const recent = files.filter((file) => file.slice(0, 4) >= 'V044');
    expect(recent.length).toBeGreaterThan(0);
    for (const file of recent) {
      const safe = LEGACY_SAFE_PREFIXES.some((prefix) => file.startsWith(prefix));
      const tag = file.slice(0, 4);
      const justified = Boolean(LEGACY_EXCLUDED_JUSTIFICATIONS[tag]?.trim());
      expect(
        safe || justified,
        `${file} must be legacy-safe or justified in LEGACY_EXCLUDED_JUSTIFICATIONS`,
      ).toBe(true);
    }
    // No stale justifications: every entry must point at a file on disk.
    for (const tag of Object.keys(LEGACY_EXCLUDED_JUSTIFICATIONS)) {
      expect(
        files.some((file) => file.startsWith(tag)),
        `stale legacy exclusion justification ${tag}`,
      ).toBe(true);
    }
  });

  it('V048 stays excluded: it predicates on categories.status, absent from the legacy projection', () => {
    expect(LEGACY_EXCLUDED_JUSTIFICATIONS['V048']).toMatch(/status/);
    expect(v048).toMatch(/status = 'active'/);
    // The legacy adapter derives status from the `active` boolean in JS —
    // the legacy categories projection selects no `status` column.
    const legacyAdapter = readFileSync(new URL('../../src/writes/legacy-postgres.ts', import.meta.url), 'utf8');
    const lines = legacyAdapter.split('\n');
    const anchor = lines.findIndex((line) => line.includes('LEGACY_CATEGORY_COLUMNS ='));
    expect(anchor).toBeGreaterThanOrEqual(0);
    // The column list may continue on the following line.
    const columns = lines
      .slice(anchor, anchor + 2)
      .join(' ')
      .split('=')
      .slice(1)
      .join('=')
      .split(',')
      .map((column) => column.trim().replace(/['";]/g, ''))
      .filter(Boolean);
    expect(columns).toContain('active');
    expect(columns).not.toContain('status');
  });
});

describe('V064 account presentation migration', () => {
  it('is discovered in migration order for canonical and legacy manifests', () => {
    expect(expectedMigrationManifest(false).map(({ version }) => version).at(-1)).toBe(64);
    expect(expectedMigrationManifest(true).map(({ version }) => version)).toContain(64);
  });
});
