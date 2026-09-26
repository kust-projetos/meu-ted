/**
 * F2 inert-deleted-card PG proof (household-scoped, no PII).
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Reproduces the anonymized
 * dump shape: a statement billing a soft-deleted same-household credit_card
 * with paid_cents=0, no live transactions/card_purchases linked to the
 * statement, and no live movements touching the deleted card.
 * `runBalancesStep` must skip the statement from balance calculation (not
 * import/archive) and persist live balances; a nonzero-paid sibling must
 * still fail closed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { BalanceError, runBalancesStep } from '../../src/scripts/canonical-converter/balances.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[postgres-canonical-converter-m3-inert] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const DB_NAME = `pi_converter_m3_inert_${process.pid}`;

let adminPool: Pool | undefined;
let db: Pool | undefined;

describeIfDb('Postgres canonical converter M3 inert-deleted-card (F2)', () => {
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
    await requireTestDatabase(db, 'converter-m3-inert-fixture');
    await runMigrations(db);
    await db.query(`CREATE SCHEMA IF NOT EXISTS legacy_archive`);
    await db.query(
      `CREATE TABLE legacy_archive.accounts (id UUID PRIMARY KEY, household_id UUID NOT NULL, initial_balance_cents BIGINT NOT NULL DEFAULT 0)`,
    );
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await adminPool?.end();
  });

  it('skips a paid=0 statement on a soft-deleted card and still balances live accounts', async () => {
    const householdId = randomUUID();
    const ownerId = randomUUID();
    await db!.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'M3 Inert', 'active')`, [
      ownerId,
      `m3-inert-${householdId}@example.test`,
    ]);
    await db!.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, 'M3 I', 'shared', $2)`, [
      householdId,
      ownerId,
    ]);
    const bank = randomUUID();
    await db!.query(
      `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status) VALUES ($1, $2, 'Checking', 'bank', 0, 'active')`,
      [bank, householdId],
    );
    await db!.query(`INSERT INTO legacy_archive.accounts (id, household_id, initial_balance_cents) VALUES ($1, $2, 1000)`, [
      bank,
      householdId,
    ]);
    const deadCard = randomUUID();
    await db!.query(
      `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status, deleted_at) VALUES ($1, $2, 'Old Card', 'credit_card', 0, 'inactive', NOW())`,
      [deadCard, householdId],
    );
    const stmt = randomUUID();
    await db!.query(
      `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status) VALUES ($1, $2, $3, '2026-09', '2026-09-10', '2026-09-20', 0, 0, 'cancelled')`,
      [stmt, householdId, deadCard],
    );
    await db!.query(
      `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id) VALUES ($1, $2, 'income', 'Pay', 500, CURRENT_DATE, $3)`,
      [randomUUID(), householdId, bank],
    );

    const result = await runBalancesStep(db!, { householdId });
    expect(result.skippedInertStatementIds).toContain(stmt);
    expect(result.applied.find((r) => r.accountId === bank)).toMatchObject({ computed: 1500n });
  }, 60_000);

  it('fail-closed when the deleted-card statement still carries paid_cents', async () => {
    const householdId = randomUUID();
    const ownerId = randomUUID();
    await db!.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'M3 Inert Paid', 'active')`, [
      ownerId,
      `m3-inert-paid-${householdId}@example.test`,
    ]);
    await db!.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, 'M3 IP', 'shared', $2)`, [
      householdId,
      ownerId,
    ]);
    const bank = randomUUID();
    await db!.query(
      `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status) VALUES ($1, $2, 'Checking', 'bank', 0, 'active')`,
      [bank, householdId],
    );
    await db!.query(`INSERT INTO legacy_archive.accounts (id, household_id, initial_balance_cents) VALUES ($1, $2, 0)`, [
      bank,
      householdId,
    ]);
    const deadCard = randomUUID();
    await db!.query(
      `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status, deleted_at) VALUES ($1, $2, 'Old Card', 'credit_card', 0, 'inactive', NOW())`,
      [deadCard, householdId],
    );
    await db!.query(
      `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status) VALUES ($1, $2, $3, '2026-09', '2026-09-10', '2026-09-20', 100, 100, 'paid')`,
      [randomUUID(), householdId, deadCard],
    );
    await expect(runBalancesStep(db!, { householdId })).rejects.toThrow(BalanceError);
  }, 60_000);
});
