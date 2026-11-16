/**
 * DEBT-CODER-BULKTX (RED) — bulk payable effects must be all-or-nothing
 * on real PostgreSQL, for the canonical store AND its legacy twin.
 *
 * Runs only with DATABASE_URL_TEST + DB_TEST_MARKER (dedicated disposable
 * database); skips otherwise. Uses `requireTestDatabase` + per-test
 * household cleanup (canonical) and an isolated schema (legacy), following
 * tests/integration/postgres-payable-double-pay.test.ts.
 *
 * Mid-batch failure is forced by a test-local BEFORE INSERT trigger on
 * accounts_payable that raises only for a unique marker description, so no
 * other test running against the shared test database is affected. The
 * trigger is always dropped in `finally`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresIdempotencyStore } from '../../src/writes/postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { runPayableBulkMutation } from '../../src/payables/keyed-mutations.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;
const LEGACY_SCHEMA = `pbba_l_${process.pid}_${Date.now()}`;

let pool: Pool | undefined;
let legacyPool: Pool | undefined;

if (!ENABLED) {
  console.log(
    '[postgres-payable-bulk-atomicity] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — ' +
      'bulk atomicity is only meaningful against real PostgreSQL, so every scenario below is skipped.',
  );
}

const createLegacyPayableTables = async (db: Pool): Promise<void> => {
  await db.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      initial_balance_cents BIGINT NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      is_credit_card BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      from_account_id UUID, to_account_id UUID, category_id UUID,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE accounts_payable (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, due_date DATE NOT NULL,
      type TEXT NOT NULL, frequency TEXT, end_date DATE, paid_date DATE,
      reminder_days_before INTEGER NOT NULL DEFAULT 0, notes TEXT, category_id UUID,
      status TEXT NOT NULL, paid_transaction_id UUID, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE payable_templates (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL, amount_cents BIGINT NOT NULL,
      frequency TEXT NOT NULL, day_of_month INTEGER NOT NULL,
      reminder_days_before INTEGER NOT NULL DEFAULT 0, notes TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const seedHousehold = async (db: Pool, name: string): Promise<string> => {
  const id = randomUUID();
  const ownerId = randomUUID();
  await db.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Bulk Owner', 'active')`, [
    ownerId,
    `pbba-${id}@example.test`,
  ]);
  await db.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, $2, 'shared', $3)`, [id, name, ownerId]);
  return id;
};

const cleanupHousehold = async (db: Pool, id: string): Promise<void> => {
  const owner = await db.query(`SELECT owner_user_id FROM households WHERE id = $1`, [id]).catch(() => null);
  await db.query(`DELETE FROM accounts_payable WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM transactions WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM payable_templates WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM categories WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM accounts WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM memberships WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM households WHERE id = $1`, [id]).catch(() => undefined);
  const ownerId = (owner as { rows: Array<Record<string, unknown>> } | null)?.rows[0]?.['owner_user_id'] as
    | string
    | undefined;
  if (ownerId) await db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => undefined);
};

/** Fail only the payable insert carrying the marker description. */
const installFailTrigger = async (db: Pool, marker: string): Promise<void> => {
  await db.query(`
    CREATE OR REPLACE FUNCTION bulk_atomic_fail_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.description = '${marker}' THEN
        RAISE EXCEPTION 'bulk-atomic-boom';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS bulk_atomic_fail_trg ON accounts_payable;
    CREATE TRIGGER bulk_atomic_fail_trg
      BEFORE INSERT ON accounts_payable
      FOR EACH ROW EXECUTE FUNCTION bulk_atomic_fail_fn();
  `);
};

const dropFailTrigger = async (db: Pool): Promise<void> => {
  await db.query(`DROP TRIGGER IF EXISTS bulk_atomic_fail_trg ON accounts_payable`).catch(() => undefined);
  await db.query(`DROP FUNCTION IF EXISTS bulk_atomic_fail_fn()`).catch(() => undefined);
};

const payableCount = async (db: Pool, householdId: string): Promise<number> => {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM accounts_payable WHERE household_id = $1 AND deleted_at IS NULL`, [
    householdId,
  ]);
  return Number(r.rows[0]!['n']);
};

describe('Postgres bulk payable atomicity (DEBT-CODER-BULKTX)', () => {
  beforeAll(async () => {
    if (!DB_URL) return;
    pool = createPool({ connectionString: DB_URL, max: 12 });
    await requireTestDatabase(pool, 'migrate');
    await runMigrations(pool);
    // Defensive: a crashed previous run could have left the fail trigger
    // behind (it raises only for a random marker, but drop it anyway so a
    // reused database starts clean).
    await dropFailTrigger(pool);
    const url = new URL(DB_URL);
    url.searchParams.set('options', `-c search_path=${LEGACY_SCHEMA},public`);
    legacyPool = createPool({ connectionString: url.toString(), max: 12 });
    await legacyPool.query(`CREATE SCHEMA ${LEGACY_SCHEMA}`);
    await createLegacyPayableTables(legacyPool);
  }, 60_000);

  afterAll(async () => {
    await legacyPool?.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`).catch(() => undefined);
    await legacyPool?.end();
    await pool?.end();
  });

  itIfDatabase('(a) canonical: 3rd-row failure persists ZERO payables (all-or-nothing)', async () => {
    const db = pool!;
    const writes = createPostgresWriteStore({ pool: db });
    const payables = createPostgresPayableStore(db);
    const householdId = await seedHousehold(db, 'Bulk atomic H');
    const tag = randomUUID();
    const marker = `bulk-fail-${tag}`;
    try {
      const account = await writes.createAccount(householdId, {
        name: 'Bulk payer', kind: 'bank', initialBalanceCents: 100_000,
      });
      const dayOfMonth = new Date().getUTCDate();
      // Inserted in order: the marker template is processed last.
      await payables.createTemplate(householdId, {
        accountId: account.id, name: `a1-${tag}`, description: `bulk-ok-1-${tag}`,
        amountCents: 1000, frequency: 'monthly', dayOfMonth,
      });
      await payables.createTemplate(householdId, {
        accountId: account.id, name: `a2-${tag}`, description: `bulk-ok-2-${tag}`,
        amountCents: 2000, frequency: 'monthly', dayOfMonth,
      });
      await payables.createTemplate(householdId, {
        accountId: account.id, name: `z9-${tag}`, description: marker,
        amountCents: 3000, frequency: 'monthly', dayOfMonth,
      });
      await installFailTrigger(db, marker);
      try {
        await expect(payables.autoCreateFromTemplates(householdId, 30)).rejects.toThrow('bulk-atomic-boom');
        expect(await payableCount(db, householdId)).toBe(0);
      } finally {
        await dropFailTrigger(db);
      }
    } finally {
      await cleanupHousehold(db, householdId);
    }
  }, 30_000);

  itIfDatabase('(b) canonical: same-key replay of a completed bulk returns the same response, no duplicates', async () => {
    const db = pool!;
    const writes = createPostgresWriteStore({ pool: db });
    const payables = createPostgresPayableStore(db);
    const householdId = await seedHousehold(db, 'Bulk replay H');
    const tag = randomUUID();
    const key = `bulk-replay-${tag}`;
    try {
      const account = await writes.createAccount(householdId, {
        name: 'Replay payer', kind: 'bank', initialBalanceCents: 100_000,
      });
      const dayOfMonth = new Date().getUTCDate();
      await payables.createTemplate(householdId, {
        accountId: account.id, name: `r1-${tag}`, description: `bulk-replay-${tag}`,
        amountCents: 1500, frequency: 'monthly', dayOfMonth,
      });
      const payload = { daysAhead: 30 };
      const idempotency = createPostgresIdempotencyStore({ pool: db });
      // Same shape as the POST /payables/auto-create-from-templates route
      // producer: the batch joins the open claim tx (claim + every row +
      // completion commit atomically).
      const producer = async (claimTx?: unknown) => {
        const created = await runPayableBulkMutation(payables, claimTx, householdId, 'autoCreate', { daysAhead: 30 });
        return { status: 201 as const, body: { created, createdCount: created.length } };
      };
      const first = await idempotency.lookupOrRecord(householdId, key, payload, producer);
      expect(first.replayed).toBe(false);
      expect(first.response.body.createdCount).toBe(1);
      const second = await idempotency.lookupOrRecord(householdId, key, payload, producer);
      expect(second.replayed).toBe(true);
      expect(second.response).toEqual(first.response);
      expect(await payableCount(db, householdId)).toBe(1);
    } finally {
      await cleanupHousehold(db, householdId);
    }
  }, 30_000);

});
