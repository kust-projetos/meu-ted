/**
 * V023 multi-schema replay proof (F2 real-dump bootstrap defect, 2026-09-26).
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Uses a dedicated throwaway
 * DATABASE per run (never the shared `public` used by other suites). The
 * database is dropped in afterAll.
 *
 * Scenario: after archive-and-bootstrap moves the legacy dump into
 * `legacy_archive`, the archived `pending_operations` (legacy shape from
 * `docs/migrations/002_pending_operations.sql`, WITH `household_id`, plus
 * the V023 constraints the production dump already carries) shares its table
 * NAME with the fresh canonical `public.pending_operations` created by the
 * V001-V022 replay. V023's DO blocks probed `information_schema.columns`
 * and `pg_constraint` filtered by table NAME only (no schema / no conrelid),
 * so the probe matched the ARCHIVED table while the unqualified
 * `ALTER TABLE pending_operations` resolved to the NEW public table:
 * `column "household_id" of relation "pending_operations" does not exist`.
 * The same defect silently SKIPPED both V023 CHECK constraints on the
 * canonical table (the dumped clone reproduces them in `legacy_archive`).
 *
 * This test replays the V023 migration FILE against exactly that fixture and
 * asserts the canonical table gains its columns + BOTH constraints. It FAILS
 * before the schema-qualification fix (RED) and PASSES after (GREEN).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[postgres-canonical-converter-v023-multischema] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const DB_NAME = `pi_converter_v023_${process.pid}`;

let adminPool: Pool | undefined;
let db: Pool | undefined;

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'read-models', 'sql');

/** Archived shape: legacy 002 columns (WITH household_id) + the V023 CHECK
 *  constraints the production dump already carries post-V023. */
const archivedFixtureDDL = `
  CREATE SCHEMA IF NOT EXISTS legacy_archive;
  CREATE TABLE legacy_archive.pending_operations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id   UUID,
    user_id        UUID,
    chat_id        TEXT NOT NULL,
    kind           TEXT,
    amount_cents   BIGINT NOT NULL,
    description    TEXT,
    date           DATE NOT NULL,
    status         TEXT DEFAULT 'awaiting_confirmation',
    reason         TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    expires_at     TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 minutes'),
    CONSTRAINT pending_operations_status_v023_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    CONSTRAINT pending_operations_reason_v023_check
      CHECK (reason IN ('high_value', 'destructive'))
  );
`;

const columnNames = async (pool: Pool, schema: string, table: string): Promise<string[]> => {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return res.rows.map((row) => String(row.column_name));
};

const canonicalConstraintNames = async (pool: Pool): Promise<string[]> => {
  const res = await pool.query(
    `SELECT c.conname AS name
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'pending_operations'
        AND c.conname IN ('pending_operations_status_v023_check', 'pending_operations_reason_v023_check')
      ORDER BY c.conname`,
  );
  return res.rows.map((row) => String(row.name));
};

describeIfDb('Postgres canonical converter V023 (archived-schema multi-schema replay)', () => {
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
    await db.query(`INSERT INTO _test_marker (marker_value) VALUES ($1)`, [
      process.env.DB_TEST_MARKER!,
    ]);
    await requireTestDatabase(db, 'converter-v023-multischema-fixture');
    await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await db.query(archivedFixtureDDL);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await adminPool?.end();
  });

  it('replays the V023 file past the archived namesake and constrains the canonical table', async () => {
    const v023 = readFileSync(join(SQL_DIR, 'V023__pending_operations.sql'), 'utf8');
    // RED pre-fix: rejects with column "household_id" of relation
    // "pending_operations" does not exist (probe matched legacy_archive,
    // ALTER resolved to the fresh public table).
    await db!.query(v023);
    // The migration stays idempotent: a second replay is a no-op success.
    await db!.query(v023);

    const cols = await columnNames(db!, 'public', 'pending_operations');
    for (const expected of [
      'workspace_id',
      'requester_id',
      'operation',
      'payload',
      'reason',
      'idempotency_key',
      'status',
      'chat_id',
      'approved_at',
    ]) {
      expect(cols).toContain(expected);
    }
    // The fresh canonical table never gains the legacy column; the probe
    // must not leak it in from the archived namesake.
    expect(cols).not.toContain('household_id');
    expect(cols).not.toContain('amount_cents');

    // Both V023 CHECK constraints exist on the CANONICAL table even though
    // same-named constraints already live in legacy_archive (pre-fix they
    // would have been silently skipped by the unqualified pg_constraint
    // probe).
    expect(await canonicalConstraintNames(db!)).toEqual([
      'pending_operations_reason_v023_check',
      'pending_operations_status_v023_check',
    ]);
  }, 120_000);
});
