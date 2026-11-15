/**
 * REVIEW ROUND 3 integration (TDD RED→GREEN, PG-gated like the m1–m4 suites).
 *
 * F1: marker ausente + legacy_archive com relações + --dry-run → a sonda
 *     markerless roda TAMBÉM no caminho dry-run (read-only) e recusa com
 *     orientação RESTAURE, nunca com NO-GO genérico — e sem escrever nada.
 * F2: legacy_archive pré-existente VAZIO + origem íntegra → o bootstrap
 *     alinha-se à regra da sonda (vazio = não-parcial), reutiliza o schema
 *     e completa; archive COM objetos continua recusa fail-closed.
 *
 * Dedicated throwaway DATABASE, dropped in afterAll.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { ConversionError, runCanonicalConversion } from '../../src/scripts/canonical-converter/convert.js';
import {
  CONVERSION_MARKER_TABLE,
  runArchiveAndBootstrap,
} from '../../src/scripts/canonical-converter/archive-and-bootstrap.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[postgres-canonical-converter-review-round3] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const DB_NAME = `pi_converter_r3_${process.pid}`;

let adminPool: Pool | undefined;
let db: Pool | undefined;

const legacyFixtureDDL = `
  CREATE TABLE accounts (
    id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
    is_credit_card BOOLEAN NOT NULL DEFAULT false,
    initial_balance_cents BIGINT NOT NULL DEFAULT 0,
    deleted_at TIMESTAMPTZ
  );
  CREATE TABLE transactions (
    id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
    description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
    from_account_id UUID, to_account_id UUID,
    category_id UUID, subcategory_id UUID,
    deleted_at TIMESTAMPTZ
  );
  CREATE TABLE categories (
    id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
    kind TEXT NOT NULL, parent_id UUID,
    active BOOLEAN NOT NULL DEFAULT true,
    deleted_at TIMESTAMPTZ
  );
  CREATE TABLE statements (
    id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
    cycle_year_month TEXT NOT NULL, total_cents BIGINT NOT NULL DEFAULT 0,
    paid_cents BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE card_purchases (
    id UUID PRIMARY KEY, household_id UUID NOT NULL,
    transaction_id UUID, statement_id UUID,
    description TEXT NOT NULL DEFAULT '', amount_cents BIGINT NOT NULL DEFAULT 0,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    deleted_at TIMESTAMPTZ
  );
  CREATE TABLE users (
    id UUID PRIMARY KEY, auth_user_id TEXT NOT NULL, email TEXT
  );
  CREATE TABLE memberships (id UUID PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE invites (id UUID PRIMARY KEY, invited_by_user_id TEXT);
  CREATE TABLE _migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    checksum TEXT NOT NULL DEFAULT '',
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const realChecksumOf = (file: string): string => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'read-models', 'sql');
  return createHash('sha256').update(readFileSync(join(dir, file), 'utf8'), 'utf8').digest('hex');
};

describeIfDb('Postgres canonical converter review round 3', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    await adminPool.query(`CREATE DATABASE "${DB_NAME}"`);
    const url = new URL(DB_URL!);
    url.pathname = `/${DB_NAME}`;
    db = createPool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 60_000 });
    let connected = false;
    for (let attempt = 0; attempt < 12 && !connected; attempt++) {
      try {
        await db.query('SELECT 1');
        connected = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    if (!connected) throw new Error('dedicated converter database never accepted connections');
    await db.query(`CREATE TABLE _test_marker (marker_value TEXT NOT NULL)`);
    await db.query(`INSERT INTO _test_marker (marker_value) VALUES ($1)`, [process.env.DB_TEST_MARKER!]);
    await requireTestDatabase(db, 'converter-review-round3-fixture');
    process.env.BACKUP_CONFIRMED = 'true';
    process.env.BACKUP_ID = `test-backup-r3-${randomUUID()}`;
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await adminPool?.end();
  }, 120_000);

  it('F1: dry-run over a markerless partial state refuses RESTAURE-oriented and writes nothing', async () => {
    // Simulate a bootstrap that failed BEFORE writing the marker: the
    // archive holds relations, public is emptied, and NO marker row exists.
    await db!.query(`CREATE SCHEMA legacy_archive`);
    await db!.query(`CREATE TABLE legacy_archive.accounts (id TEXT PRIMARY KEY)`);
    const markerProbe = await db!.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS ok`,
      [CONVERSION_MARKER_TABLE],
    );
    if (markerProbe.rows[0]!.ok === true) {
      await db!.query(`DROP TABLE public.${CONVERSION_MARKER_TABLE}`);
    }
    try {
      const failure = await runCanonicalConversion(db!, { dryRun: true }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConversionError);
      const message = (failure as Error).message;
      expect(message).toMatch(/RESTAURE/i);
      expect(message).toMatch(/marker/i);
      expect(message).not.toMatch(/NO-GO/);
      // Read-only: the dry-run wrote no marker and left the archive intact.
      const markerAfter = await db!.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS ok`,
        [CONVERSION_MARKER_TABLE],
      );
      expect(markerAfter.rows[0]!.ok).toBe(false);
      const archiveAfter = await db!.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'legacy_archive' AND table_name = 'accounts') AS ok`,
      );
      expect(archiveAfter.rows[0]!.ok).toBe(true);
    } finally {
      await db!.query(`DROP SCHEMA legacy_archive CASCADE`);
    }
  }, 60_000);

  it('F2: bootstrap still refuses a NON-EMPTY pre-existing archive (fail-closed preserved)', async () => {
    await db!.query(legacyFixtureDDL);
    const household = randomUUID();
    await db!.query(
      `INSERT INTO accounts (id, household_id, name, is_credit_card, initial_balance_cents)
       VALUES ($1, $2, 'Checking', false, 0)`,
      [randomUUID(), household],
    );
    await db!.query(`INSERT INTO users (id, auth_user_id, email) VALUES ($1, 'auth-u1', 'owner@example.com')`, [
      randomUUID(),
    ]);
    await db!.query(`INSERT INTO memberships (id, user_id) VALUES ($1, 'auth-u1')`, [randomUUID()]);
    await db!.query(`INSERT INTO _migrations (version, name, checksum) VALUES (3, 'V003__legacy_safe_tables.sql', 'tampered')`);
    await db!.query(`UPDATE _migrations SET checksum = $1 WHERE version = 3`, [
      realChecksumOf('V003__legacy_safe_tables.sql'),
    ]);
    // A previous run left a NON-EMPTY archive behind: still partial.
    await db!.query(`CREATE SCHEMA legacy_archive`);
    await db!.query(`CREATE TABLE legacy_archive.accounts (id TEXT PRIMARY KEY)`);
    try {
      await expect(runArchiveAndBootstrap(db!)).rejects.toThrow(/partial/i);
    } finally {
      await db!.query(`DROP SCHEMA legacy_archive CASCADE`);
    }
  }, 120_000);

  it('F2: bootstrap proceeds over a pre-existing EMPTY archive and completes', async () => {
    // public still holds the intact legacy fixtures from the previous case.
    await db!.query(`CREATE SCHEMA legacy_archive`);
    try {
      const result = await runArchiveAndBootstrap(db!);
      expect(result.status).toBe('bootstrapped');
      const marker = await db!.query(`SELECT backup_id, state FROM _conversion_marker`);
      expect(marker.rowCount).toBe(1);
      expect(marker.rows[0]!.backup_id).toBe(process.env.BACKUP_ID);
      expect(marker.rows[0]!.state).toBe('bootstrap_completed');
      const archived = await db!.query(`SELECT COUNT(*)::int AS n FROM legacy_archive.accounts`);
      expect(Number(archived.rows[0]!.n)).toBe(1);
      const shape = await db!.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts'`,
      );
      const canonicalColumns = shape.rows.map((row) => String(row.column_name));
      expect(canonicalColumns).toContain('kind');
      expect(canonicalColumns).toContain('institution_id');
      expect(canonicalColumns).toContain('card_product_id');
    } finally {
      // Leave the converted database behind; the suite database is dropped
      // in afterAll. Re-mark the fresh canonical public so any later
      // guarded operation keeps seeing the test database.
      await db!.query(`CREATE TABLE IF NOT EXISTS _test_marker (marker_value TEXT NOT NULL)`);
      await db!.query(`DELETE FROM _test_marker`);
      await db!.query(`INSERT INTO _test_marker (marker_value) VALUES ($1)`, [process.env.DB_TEST_MARKER!]);
    }
  }, 180_000);
});
