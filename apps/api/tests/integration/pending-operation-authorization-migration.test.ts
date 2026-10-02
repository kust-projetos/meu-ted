/**
 * Real-Postgres migration test for V059 (ADR-026 authorization columns).
 *
 * Requires a PRE-PROVISIONED disposable database (never self-provision the
 * marker here: the db guard must fail closed against an unintended database):
 *   DATABASE_URL_TEST=postgres://user:pass@host:port/db
 *   DB_TEST_MARKER=<uuid>
 * with the marker row already present, e.g.:
 *   CREATE TABLE IF NOT EXISTS _test_marker (marker_value TEXT NOT NULL);
 *   INSERT INTO _test_marker(marker_value) VALUES ('<uuid>');
 * The CI postgres job provisions the marker before the suite
 * (.github/workflows/ci.yml). Skips cleanly when the env vars are absent.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const MARKER = process.env.DB_TEST_MARKER;
const ENABLED = Boolean(DB_URL && MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

let pool: Pool | undefined;
const rowIds: string[] = [];

async function insertPendingOperation(
  db: Pool,
  options: { mode?: string; reason?: string; tier?: string; authorizedAt?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  rowIds.push(id);
  await db.query(
    `INSERT INTO pending_operations
      (id, workspace_id, requester_id, operation, payload, reason, idempotency_key, status, expires_at,
       protocol_version, actor_id, device_id, tool, normalized_args, proposal_hash, execution_status,
       authorization_mode, authorization_reason, risk_tier, authorized_at)
     VALUES ($1, $2, 'migration-test-actor', 'transactions.expense.create', '{}', 'high_value', $3, 'pending',
       NOW() + INTERVAL '1 hour', 2, 'migration-test-actor', 'migration-test-device',
       'transactions.expense.create', '{}', repeat('a', 64), 'proposed', $4, $5, $6,
       CASE WHEN $7::boolean THEN NOW() ELSE NULL END)`,
    [
      id,
      randomUUID(),
      `authorization-migration-${id}`,
      options.mode ?? null,
      options.reason ?? null,
      options.tier ?? null,
      options.authorizedAt ?? false,
    ],
  );
  return id;
}

describeIfDb('PendingOperation authorization migration V059 (Postgres)', () => {
  beforeAll(async () => {
    if (!DB_URL || !MARKER) return;
    pool = createPool({ connectionString: DB_URL, max: 2 });
    // Marker must already exist (CI provisions it). The guard below fails
    // closed when it is missing or divergent — never create it here.
    await requireTestDatabase(pool, 'pending-operation-authorization-migration');
    await runMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool && rowIds.length > 0) {
      await pool.query('DELETE FROM pending_operations WHERE id = ANY($1::uuid[])', [rowIds]);
    }
    await pool?.end();
  });

  it('applies V059, preserves nullable legacy rows and audit values, enforces checks, and reruns safely', async () => {
    const db = pool!;
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pending_operations'
         AND column_name = ANY($1::text[])`,
      [['authorization_mode', 'authorization_reason', 'risk_tier', 'authorized_at']],
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      ['authorization_mode', 'authorization_reason', 'risk_tier', 'authorized_at'].sort(),
    );

    const constraints = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.pending_operations'::regclass
         AND conname = ANY($1::text[])`,
      [['pending_operations_v2_auth_mode_check', 'pending_operations_v2_risk_tier_check']],
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual(
      ['pending_operations_v2_auth_mode_check', 'pending_operations_v2_risk_tier_check'].sort(),
    );

    const legacyId = await insertPendingOperation(db);
    const legacy = await db.query(
      'SELECT authorization_mode, authorization_reason, risk_tier, authorized_at FROM pending_operations WHERE id = $1',
      [legacyId],
    );
    expect(legacy.rows[0]).toEqual({ authorization_mode: null, authorization_reason: null, risk_tier: null, authorized_at: null });

    const manualId = await insertPendingOperation(db, {
      mode: 'manual', reason: 'high_value', tier: 'high', authorizedAt: true,
    });
    const manual = await db.query(
      'SELECT authorization_mode, authorization_reason, risk_tier, authorized_at FROM pending_operations WHERE id = $1',
      [manualId],
    );
    expect(manual.rows[0]).toMatchObject({ authorization_mode: 'manual', authorization_reason: 'high_value', risk_tier: 'high' });
    expect(manual.rows[0]?.['authorized_at']).toBeInstanceOf(Date);

    const autoId = await insertPendingOperation(db, { mode: 'auto', reason: 'explicit_low_risk', tier: 'low' });
    const auto = await db.query(
      'SELECT authorization_mode, authorization_reason, risk_tier FROM pending_operations WHERE id = $1',
      [autoId],
    );
    expect(auto.rows[0]).toEqual({ authorization_mode: 'auto', authorization_reason: 'explicit_low_risk', risk_tier: 'low' });

    await expect(insertPendingOperation(db, { mode: 'llm' })).rejects.toThrow();
    await expect(insertPendingOperation(db, { tier: 'impossible' })).rejects.toThrow();

    await expect(runMigrations(db)).resolves.toMatchObject({ applied: [] });
  }, 120_000);
});
