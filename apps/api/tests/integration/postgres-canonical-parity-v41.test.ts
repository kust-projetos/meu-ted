/**
 * V4.1 PHASE 4 (Tasks 4.2–4.11) — Postgres proofs for the canonical store.
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Isolated schema per run so
 * parallel suites never share rows. Hand-built canonical tables (same reason
 * as postgres-cards-v41-hardening.test.ts: runMigrations on a fresh schema
 * is broken at HEAD by pre-existing V049 drift).
 *
 * RED coverage (fails before the fix, passes after):
 * - 4.2/4.3: over-balance expense/transfer succeed with exact negative
 *   deltas (were: silent GREATEST(0, …) clamp / money creation).
 * - 4.4/4.5: update delta matrix on Postgres (amount-only beyond the old
 *   balance, combined amount+account with exact reverse/apply, account-only
 *   move).
 * - 4.6/4.7: opposite-direction concurrent transfers complete without
 *   deadlock and conserve total money (deterministic lock ordering).
 * - 4.8–4.10: pay debits the materialized balance; unpay reopens the
 *   payable, tombstones the linked expense and restores the exact balance.
 * - 4.11: createPayableWithTemplate no longer references the nonexistent
 *   template_id column.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[postgres-canonical-parity-v41] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const suffix = `${process.pid}_${Date.now()}`;
const SCHEMA = `v41p4_${suffix}`;

const scopedPool = (schema: string, max: number): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max, connectionTimeoutMillis: 30_000 });
};

let adminPool: Pool | undefined;
let db: Pool | undefined;

const createTables = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, balance_cents BIGINT NOT NULL DEFAULT 0,
      initial_balance_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT accounts_balance_nonnegative_card_chk CHECK (kind <> 'credit_card' OR balance_cents >= 0)
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', parent_id UUID,
      icon TEXT, color TEXT, sort_order INTEGER,
      is_default BOOLEAN NOT NULL DEFAULT false, is_system BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      account_id UUID NOT NULL, category_id UUID, subcategory_id UUID, notes TEXT,
      transfer_to_account_id UUID,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE accounts_payable (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, due_date DATE NOT NULL,
      type TEXT NOT NULL DEFAULT 'one_time', frequency TEXT, end_date DATE,
      status TEXT NOT NULL DEFAULT 'pending', paid_date DATE,
      paid_amount_cents BIGINT, paid_transaction_id UUID,
      reminder_days_before INTEGER NOT NULL DEFAULT 0, notes TEXT, category_id UUID,
      deleted_at TIMESTAMPTZ,
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

const seedCategory = async (pool: Pool, householdId: string, kind: 'expense' | 'income'): Promise<string> => {
  const r = await pool.query(
    `INSERT INTO categories (id, household_id, name, kind, status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active') RETURNING id`,
    [householdId, `Cat-${kind}-${randomUUID().slice(0, 8)}`, kind],
  );
  return r.rows[0]!['id'] as string;
};

const balanceOf = async (pool: Pool, accountId: string): Promise<number> => {
  const r = await pool.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [accountId]);
  return Number(r.rows[0]!['balance_cents']);
};

const txCount = async (pool: Pool, householdId: string): Promise<number> => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
    [householdId],
  );
  return Number(r.rows[0]!['n']);
};

/** Recompute an account balance purely from the ledger + initial balance. */
const ledgerBalance = async (
  pool: Pool,
  householdId: string,
  accountId: string,
  initial: number,
): Promise<number> => {
  const r = await pool.query(
    `SELECT kind, amount_cents, account_id, transfer_to_account_id
       FROM transactions
      WHERE household_id = $1 AND deleted_at IS NULL
        AND (account_id = $2 OR transfer_to_account_id = $2)`,
    [householdId, accountId],
  );
  let bal = initial;
  for (const row of r.rows) {
    const amount = Number(row['amount_cents']);
    if (row['kind'] === 'expense') bal -= amount;
    else if (row['kind'] === 'income') bal += amount;
    else if (row['kind'] === 'transfer') {
      if (row['account_id'] === accountId) bal -= amount;
      if (row['transfer_to_account_id'] === accountId) bal += amount;
    }
  }
  return bal;
};

describeIfDb('Postgres canonical parity V4.1 (tasks 4.2–4.11)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    await requireTestDatabase(adminPool, 'schema-create');
    // 20 concurrent transfers serialize on two account rows: the pool must
    // fit the fan-out or waiters hit the connection timeout on a reused DB.
    db = scopedPool(SCHEMA, 24);
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await createTables(db);
  }, 120_000);

  afterAll(async () => {
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await db?.end();
    await adminPool?.end();
  });

  it('4.2/4.3 over-balance expense succeeds with the exact negative delta', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    const acc = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 2000 });
    const cat = await seedCategory(db!, hh, 'expense');
    const tx = await writes.createExpense(hh, {
      description: 'Too big',
      amountCents: 10000,
      date: '2026-09-01',
      accountId: acc.id,
      categoryId: cat,
    });
    expect(tx.amountCents).toBe(10000);
    expect(await balanceOf(db!, acc.id)).toBe(2000 - 10000);
    expect(await txCount(db!, hh)).toBe(1);
    expect(await ledgerBalance(db!, hh, acc.id, 2000)).toBe(await balanceOf(db!, acc.id));
  });

  it('4.2/4.3 over-balance transfer succeeds with exact deltas on both sides', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    const a = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 2000 });
    const b = await writes.createAccount(hh, { name: 'B', kind: 'bank', initialBalanceCents: 5000 });
    await writes.createTransfer(hh, {
      description: 'Too big',
      amountCents: 10000,
      date: '2026-09-01',
      fromAccountId: a.id,
      toAccountId: b.id,
    });
    expect(await balanceOf(db!, a.id)).toBe(2000 - 10000);
    expect(await balanceOf(db!, b.id)).toBe(5000 + 10000);
    expect(await txCount(db!, hh)).toBe(1);
  });

  it('4.4/4.5 update delta matrix: amount-only, account-only, both', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    const a = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const b = await writes.createAccount(hh, { name: 'B', kind: 'bank', initialBalanceCents: 50000 });
    const cat = await seedCategory(db!, hh, 'expense');

    // amount-only within balance
    const t1 = await writes.createExpense(hh, {
      description: 'T1', amountCents: 20000, date: '2026-09-01', accountId: a.id, categoryId: cat,
    });
    await writes.updateTransaction(hh, t1.id, { amountCents: 30000 });
    expect(await balanceOf(db!, a.id)).toBe(70000);

    // account-only move: reverses A fully, applies B
    const t2 = await writes.createExpense(hh, {
      description: 'T2', amountCents: 10000, date: '2026-09-01', accountId: a.id, categoryId: cat,
    });
    expect(await balanceOf(db!, a.id)).toBe(60000);
    await writes.updateTransaction(hh, t2.id, { accountId: b.id });
    expect(await balanceOf(db!, a.id)).toBe(70000);
    expect(await balanceOf(db!, b.id)).toBe(40000);

    // combined amount+account: reverse(before) once, apply(after) once
    const t3 = await writes.createExpense(hh, {
      description: 'T3', amountCents: 20000, date: '2026-09-01', accountId: a.id, categoryId: cat,
    });
    expect(await balanceOf(db!, a.id)).toBe(50000);
    await writes.updateTransaction(hh, t3.id, { amountCents: 30000, accountId: b.id });
    expect(await balanceOf(db!, a.id)).toBe(70000);
    expect(await balanceOf(db!, b.id)).toBe(10000);

    // amount-only increase beyond the balance succeeds with the exact
    // negative delta (t3 sits on B at 30000; B holds 10000).
    await writes.updateTransaction(hh, t3.id, { amountCents: 130000 });
    expect(await balanceOf(db!, a.id)).toBe(70000);
    expect(await balanceOf(db!, b.id)).toBe(10000 + 30000 - 130000);

    // invariant: materialized == ledger-derived on both accounts
    expect(await ledgerBalance(db!, hh, a.id, 100000)).toBe(await balanceOf(db!, a.id));
    expect(await ledgerBalance(db!, hh, b.id, 50000)).toBe(await balanceOf(db!, b.id));
  });

  it('4.6/4.7 opposite-direction concurrent transfers conserve money without deadlock', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    const a = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const b = await writes.createAccount(hh, { name: 'B', kind: 'bank', initialBalanceCents: 100000 });
    const N = 10;
    const results = await Promise.allSettled([
      ...Array.from({ length: N }, (_, i) =>
        writes.createTransfer(hh, {
          description: `A→B ${i}`,
          amountCents: 1000,
          date: '2026-09-01',
          fromAccountId: a.id,
          toAccountId: b.id,
        }),
      ),
      ...Array.from({ length: N }, (_, i) =>
        writes.createTransfer(hh, {
          description: `B→A ${i}`,
          amountCents: 1000,
          date: '2026-09-01',
          fromAccountId: b.id,
          toAccountId: a.id,
        }),
      ),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed).toHaveLength(0);
    expect(await balanceOf(db!, a.id)).toBe(100000);
    expect(await balanceOf(db!, b.id)).toBe(100000);
    expect(await ledgerBalance(db!, hh, a.id, 100000)).toBe(100000);
    expect(await ledgerBalance(db!, hh, b.id, 100000)).toBe(100000);
  }, 60_000);

  it('4.8–4.10 pay debits balance; unpay reopens, tombstones and restores exactly', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const payables = createPostgresPayableStore(db!);
    const hh = randomUUID();
    const acc = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const payable = await payables.createPayable(hh, {
      accountId: acc.id,
      description: 'Rent',
      amountCents: 40000,
      dueDate: '2026-09-05',
    });
    const paid = await payables.markPayablePaid(hh, payable.id, { paidDate: '2026-09-05' });
    expect(paid.status).toBe('paid');
    expect(paid.paidTransactionId).toBeDefined();
    expect(await balanceOf(db!, acc.id)).toBe(60000);

    const undone = await payables.undoPayablePayment(hh, payable.id, {
      expectedPaidTransactionId: paid.paidTransactionId,
    });
    expect(['pending', 'overdue']).toContain(undone.status);
    expect(await balanceOf(db!, acc.id)).toBe(100000);
    const tomb = await db!.query(`SELECT deleted_at FROM transactions WHERE id = $1`, [
      paid.paidTransactionId,
    ]);
    expect(tomb.rows[0]!['deleted_at']).not.toBeNull();
    expect(await ledgerBalance(db!, hh, acc.id, 100000)).toBe(100000);
  });

  it('4.11 createPayableWithTemplate persists without template_id', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const payables = createPostgresPayableStore(db!);
    const hh = randomUUID();
    const acc = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 100000 });
    const payable = await payables.createPayableWithTemplate(hh, {
      payable: {
        accountId: acc.id,
        description: 'Templated bill',
        amountCents: 800,
        dueDate: '2026-09-03',
        type: 'recurring',
        frequency: 'monthly',
      },
      template: {
        accountId: acc.id,
        name: 'Tpl',
        description: 'Templated bill',
        amountCents: 800,
        frequency: 'monthly',
        dayOfMonth: 3,
      },
    });
    expect(payable.id).toBeDefined();
    const tpl = await db!.query(`SELECT id FROM payable_templates WHERE household_id = $1`, [hh]);
    expect(tpl.rowCount).toBe(1);
  });
});
