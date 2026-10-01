/**
 * Account initial-balance anchor (V058) — Postgres behavioral proof.
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Isolated schema per run
 * so parallel suites never share rows. Hand-built canonical tables in the
 * V058 contract (accounts.initial_balance_cents BIGINT NOT NULL DEFAULT 0),
 * same reason as postgres-canonical-parity-v41.test.ts.
 *
 * Unlike the fake-pool unit test (which asserts the emitted SQL), this
 * suite proves real persistence: create via the canonical writer, then
 * read balance_cents + initial_balance_cents back with plain SQL by
 * id + household.
 *
 * RED coverage (verified before the fixture/fix convergence):
 * - pre-V058 fixture DDL (no anchor column) + V058 writer → every
 *   createAccount fails with `column "initial_balance_cents" of relation
 *   "accounts" does not exist` (reproduced on PG 2026-09-30, 6/6 in
 *   postgres-canonical-parity-v41.test.ts);
 * - pre-V058 writer + V058 DDL → nonzero opening balances persist with
 *   anchor 0 (false drift), caught by the balance==anchor assertions below.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createAccountInTx, createPostgresWriteStore } from '../../src/writes/postgres.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[account-initial-anchor-postgres] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const suffix = `${process.pid}_${Date.now()}`;
const SCHEMA = `anchor_${suffix}`;

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
  `);
};

const readStored = async (
  pool: Pool,
  id: string,
  householdId: string,
): Promise<{ balance: number; anchor: number }> => {
  const r = await pool.query(
    `SELECT balance_cents, initial_balance_cents FROM accounts WHERE id = $1 AND household_id = $2`,
    [id, householdId],
  );
  expect(r.rowCount).toBe(1);
  return {
    balance: Number(r.rows[0]!['balance_cents']),
    anchor: Number(r.rows[0]!['initial_balance_cents']),
  };
};

describeIfDb('account initial-balance anchor V058 (Postgres proof)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    await requireTestDatabase(adminPool, 'schema-create');
    db = scopedPool(SCHEMA, 8);
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await createTables(db);
  }, 120_000);

  afterAll(async () => {
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await db?.end();
    await adminPool?.end();
  });

  it.each([
    { kind: 'bank', initialBalanceCents: 10_000 },
    { kind: 'bank', initialBalanceCents: 0 },
    { kind: 'bank', initialBalanceCents: -50_00 },
    { kind: 'cash', initialBalanceCents: 5_000 },
    { kind: 'cash', initialBalanceCents: -1 },
  ])('persists balance == anchor == input: $kind $initialBalanceCents', async ({ kind, initialBalanceCents }) => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    const acc = await writes.createAccount(hh, {
      name: 'A',
      kind: kind as 'bank' | 'cash',
      initialBalanceCents,
    });
    expect(acc.balanceCents).toBe(initialBalanceCents);
    const stored = await readStored(db!, acc.id, hh);
    expect(stored.balance).toBe(initialBalanceCents);
    expect(stored.anchor).toBe(initialBalanceCents);
  });

  it('updateAccount (rename) never rewrites balance or anchor', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    const acc = await writes.createAccount(hh, { name: 'A', kind: 'bank', initialBalanceCents: 12_345 });
    await writes.updateAccount(hh, acc.id, { name: 'Renamed' });
    const stored = await readStored(db!, acc.id, hh);
    expect(stored.balance).toBe(12_345);
    expect(stored.anchor).toBe(12_345);
  });

  it('credit_card with negative initial balance is rejected and persists nothing', async () => {
    const writes = createPostgresWriteStore({ pool: db! });
    const hh = randomUUID();
    await expect(
      writes.createAccount(hh, { name: 'Card', kind: 'credit_card' as never, initialBalanceCents: -1 }),
    ).rejects.toMatchObject({ code: 'validation.invalid', statusCode: 400 });
    const r = await db!.query(`SELECT COUNT(*)::int AS n FROM accounts WHERE household_id = $1`, [hh]);
    expect(Number(r.rows[0]!['n'])).toBe(0);
  });

  it('createAccountInTx joins the caller tx: ROLLBACK leaves no row', async () => {
    const hh = randomUUID();
    const client = (await db!.connect()) as PoolClient;
    try {
      await client.query('BEGIN');
      const acc = await createAccountInTx(client, hh, {
        name: 'Tmp',
        kind: 'bank',
        initialBalanceCents: 7_000,
      });
      const inside = await client.query(
        `SELECT balance_cents, initial_balance_cents FROM accounts WHERE id = $1 AND household_id = $2`,
        [acc.id, hh],
      );
      expect(inside.rowCount).toBe(1);
      expect(Number(inside.rows[0]!['balance_cents'])).toBe(7_000);
      expect(Number(inside.rows[0]!['initial_balance_cents'])).toBe(7_000);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const after = await db!.query(`SELECT COUNT(*)::int AS n FROM accounts WHERE household_id = $1`, [hh]);
    expect(Number(after.rows[0]!['n'])).toBe(0);
  });
});
