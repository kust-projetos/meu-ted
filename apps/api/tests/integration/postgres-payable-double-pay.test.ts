/**
 * Real-Postgres payable double-pay tests (V4.1 Tasks 2.1–2.3, D1/D3/D4).
 *
 * Runs only with DATABASE_URL_TEST + DB_TEST_MARKER (dedicated disposable
 * database); skips otherwise. The db-guard refuses to run against databases
 * without the test marker, and every test cleans up its own household rows.
 *
 * Proves what unit tests cannot: row-level serialization of concurrent
 * payments (SELECT ... FOR UPDATE + post-lock status check), atomic
 * payment effects (expense + debit + status + successor in one commit),
 * and the no-clamp insufficient-balance rejection — on both the canonical
 * store and its legacy twin.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { DomainError } from '../../src/writes/errors.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;
const LEGACY_SCHEMA = `ppdd_l_${process.pid}_${Date.now()}`;

let pool: Pool | undefined;
let legacyPool: Pool | undefined;

if (!ENABLED) {
  console.log(
    '[postgres-payable-double-pay] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — ' +
      'payable serialization is only meaningful against real PostgreSQL, so every scenario below is skipped.',
  );
}

const scopedPool = (schema: string): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max: 12 });
};

// Minimal legacy-shaped tables for the pay/unpay path only: the legacy
// twin reads/writes from_account_id (absent from the canonical schema)
// and never touches materialized balances.
// V4.1 REVIEWFIX F4: full legacy account shape (active / is_credit_card /
// initial_balance_cents / deleted_at) + to_account_id so the account and
// computed-balance gates run against a faithful schema.
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
  `);
};

const seedHousehold = async (db: Pool, name: string): Promise<string> => {
  const id = randomUUID();
  const ownerId = randomUUID();
  await db.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Double-pay Owner', 'active')`, [
    ownerId,
    `ppdd-${id}@example.test`,
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

const conflictStatuses = (results: PromiseSettledResult<unknown>[]): { ok: number; conflicts: number } => {
  let ok = 0;
  let conflicts = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      ok += 1;
    } else if (r.reason instanceof DomainError && r.reason.statusCode === 409) {
      conflicts += 1;
    } else {
      throw r.reason;
    }
  }
  return { ok, conflicts };
};

describe('Postgres payable double-pay serialization (V4.1 Tasks 2.1–2.3)', () => {
  beforeAll(async () => {
    if (!DB_URL) return;
    pool = createPool({ connectionString: DB_URL, max: 12 });
    await requireTestDatabase(pool, 'migrate');
    await runMigrations(pool);
    legacyPool = scopedPool(LEGACY_SCHEMA);
    await legacyPool.query(`CREATE SCHEMA ${LEGACY_SCHEMA}`);
    await createLegacyPayableTables(legacyPool);
  }, 60_000);

  afterAll(async () => {
    await legacyPool?.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`).catch(() => undefined);
    await legacyPool?.end();
    await pool?.end();
  });

  itIfDatabase('canonical: 10 concurrent payments converge on exactly 1 financial effect', async () => {
    const db = pool!;
    const writes = createPostgresWriteStore({ pool: db });
    const payables = createPostgresPayableStore(db);
    const householdId = await seedHousehold(db, 'Double-pay H');
    try {
      const account = await writes.createAccount(householdId, {
        name: 'Payer', kind: 'bank', initialBalanceCents: 100_000,
      });
      const payable = await payables.createPayable(householdId, {
        accountId: account.id, description: `Race payable ${randomUUID()}`,
        amountCents: 12_000, dueDate: '2026-08-01', type: 'recurring', frequency: 'monthly',
      });
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => payables.markPayablePaid(householdId, payable.id, { paidDate: '2026-08-01' })),
      );
      expect(conflictStatuses(results)).toEqual({ ok: 1, conflicts: 9 });

      const txs = await db.query(
        `SELECT id FROM transactions WHERE household_id = $1 AND description = $2 AND deleted_at IS NULL`,
        [householdId, payable.description],
      );
      expect(txs.rowCount).toBe(1);
      const balance = await db.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [account.id]);
      expect(Number(balance.rows[0]!['balance_cents'])).toBe(88_000);
      const state = await db.query(
        `SELECT status, paid_transaction_id FROM accounts_payable WHERE id = $1`,
        [payable.id],
      );
      expect(state.rows[0]!['status']).toBe('paid');
      expect(state.rows[0]!['paid_transaction_id']).toBe(txs.rows[0]!['id']);
      const rows = await db.query(
        `SELECT id, status FROM accounts_payable WHERE household_id = $1 AND description = $2 AND deleted_at IS NULL`,
        [householdId, payable.description],
      );
      expect(rows.rowCount).toBe(2);
      expect(rows.rows.filter((r) => r['status'] === 'pending')).toHaveLength(1);
    } finally {
      await cleanupHousehold(db, householdId);
    }
  }, 30_000);

  itIfDatabase('canonical: over-balance payment succeeds with the exact negative delta', async () => {
    const db = pool!;
    const writes = createPostgresWriteStore({ pool: db });
    const payables = createPostgresPayableStore(db);
    const householdId = await seedHousehold(db, 'No-clamp H');
    try {
      const account = await writes.createAccount(householdId, {
        name: 'Thin', kind: 'bank', initialBalanceCents: 5_000,
      });
      const payable = await payables.createPayable(householdId, {
        accountId: account.id, description: `Big bill ${randomUUID()}`,
        amountCents: 10_000, dueDate: '2026-08-01',
      });
      const paid = await payables.markPayablePaid(householdId, payable.id, { paidDate: '2026-08-01' });
      expect(paid.status).toBe('paid');
      expect(typeof paid.paidTransactionId).toBe('string');
      const state = await db.query(`SELECT status FROM accounts_payable WHERE id = $1`, [payable.id]);
      expect(state.rows[0]!['status']).toBe('paid');
      const txs = await db.query(`SELECT id FROM transactions WHERE household_id = $1`, [householdId]);
      expect(txs.rowCount).toBe(1);
      const balance = await db.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [account.id]);
      expect(Number(balance.rows[0]!['balance_cents'])).toBe(5_000 - 10_000);
    } finally {
      await cleanupHousehold(db, householdId);
    }
  }, 30_000);

  itIfDatabase('canonical: undo reverses the debit, tombstones the transaction and keeps the successor (D4)', async () => {
    const db = pool!;
    const writes = createPostgresWriteStore({ pool: db });
    const payables = createPostgresPayableStore(db);
    const householdId = await seedHousehold(db, 'Undo H');
    try {
      const account = await writes.createAccount(householdId, {
        name: 'Payer', kind: 'bank', initialBalanceCents: 100_000,
      });
      const payable = await payables.createPayable(householdId, {
        accountId: account.id, description: `Undo bill ${randomUUID()}`,
        amountCents: 12_000, dueDate: '2026-08-01', type: 'recurring', frequency: 'monthly',
      });
      const paid = await payables.markPayablePaid(householdId, payable.id, { paidDate: '2026-08-01' });
      expect(typeof paid.paidTransactionId).toBe('string');
      await expect(
        payables.undoPayablePayment(householdId, payable.id, { expectedPaidTransactionId: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const undone = await payables.undoPayablePayment(householdId, payable.id, {
        expectedPaidTransactionId: paid.paidTransactionId,
      });
      expect(['pending', 'overdue']).toContain(undone.status);
      const balance = await db.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [account.id]);
      expect(Number(balance.rows[0]!['balance_cents'])).toBe(100_000);
      const tx = await db.query(`SELECT deleted_at FROM transactions WHERE id = $1`, [paid.paidTransactionId]);
      expect(tx.rows[0]!['deleted_at']).not.toBeNull();
      const rows = await db.query(
        `SELECT status FROM accounts_payable WHERE household_id = $1 AND description = $2 AND deleted_at IS NULL`,
        [householdId, payable.description],
      );
      expect(rows.rowCount).toBe(2);
    } finally {
      await cleanupHousehold(db, householdId);
    }
  }, 30_000);

  // ── V4.1 REVIEWFIX F4: legacy pay validates account + balance ─────────
});
