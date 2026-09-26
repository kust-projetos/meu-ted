/**
 * card-debt FK deadlock (reviewer HIGH).
 *
 * Scope: apps/api/src/cards/postgres.ts + this focused test only.
 *
 * Finding: `findOrCreateStatementTx` INSERTs into `statements(account_id
 * REFERENCES accounts(id))`, which acquires a KEY SHARE row lock on the
 * referenced `accounts` row. `applyCardDebtDeltaTx` then locked the same
 * card row with `SELECT ... FOR UPDATE`. FOR UPDATE conflicts with a
 * concurrent tx's KEY SHARE, so two purchases/installments in different
 * cycles on the same card (each holding KEY SHARE from its own statement
 * INSERT while requesting FOR UPDATE for the debt delta) could deadlock
 * (Postgres 40P01) instead of serializing.
 *
 * Fix: lock the card balance row with `FOR NO KEY UPDATE` — the update
 * mutates only non-key columns (`balance_cents`, `updated_at`; PK `id`
 * never mutated), which is compatible with a concurrent KEY SHARE. Two
 * holders then serialize on the row lock instead of deadlocking.
 *
 * TDD: the no-DB fake-pool test below is RED before the fix (expects
 * `FOR NO KEY UPDATE` on the balance SELECT) and GREEN after. The
 * PG-gated suite (DATABASE_URL_TEST + DB_TEST_MARKER, isolated schema
 * with a production-like FK) proves the runtime behavior when a DB is
 * available and skips otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';

// ── No-DB lock-mode proof (always runs; RED before fix) ─────────────

const makeFakeCardPool = () => {
  const sqlLog: string[] = [];
  let balance = 0;
  const stmts = new Map<string, string>();

  const stmtRow = (cycle: string, id: string) => ({
    id,
    household_id: 'h1',
    account_id: 'card-1',
    cycle_year_month: cycle,
    closing_date: new Date(`${cycle}-10T00:00:00.000Z`),
    due_date: new Date(`${cycle}-20T00:00:00.000Z`),
    total_cents: 0,
    paid_cents: 0,
    status: 'open',
  });

  const query = async (text: string, values: unknown[] = []) => {
    await Promise.resolve();
    const t = text.replace(/\s+/g, ' ').trim();
    sqlLog.push(t);
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (t.includes('ON CONFLICT')) {
      const cycle = values[2] as string;
      if (!stmts.has(cycle)) stmts.set(cycle, `stmt-${cycle}`);
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('SELECT id FROM statements')) {
      const cycle = values[2] as string;
      return { rows: [{ id: stmts.get(cycle)! }], rowCount: 1 };
    }
    if (t.startsWith('SELECT * FROM statements')) {
      const id = values[0] as string;
      const cycle = [...stmts.entries()].find(([, v]) => v === id)?.[0] ?? '2030-07';
      return { rows: [stmtRow(cycle, id)], rowCount: 1 };
    }
    if (t.startsWith('SELECT id, kind, closing_day')) {
      return {
        rows: [{ id: 'card-1', kind: 'credit_card', closing_day: 10, due_day: 20, credit_limit_cents: 500000 }],
        rowCount: 1,
      };
    }
    if (t.startsWith('INSERT INTO transactions') || t.startsWith('INSERT INTO card_purchases')) {
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('SUM(amount_cents)')) {
      return { rows: [{ total: 10000 }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE statements SET total_cents')) {
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('SELECT balance_cents FROM accounts')) {
      return { rows: [{ balance_cents: balance }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE accounts SET balance_cents')) {
      balance += values[0] as number;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected fake query: ${t.slice(0, 120)}`);
  };

  const pool = {
    connect: async () => ({ query, release: () => undefined }),
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  return { pool, sqlLog };
};

describe('card-debt FK deadlock — lock mode (no DB)', () => {
  it('locks the card balance row with FOR NO KEY UPDATE (non-key update, KEY SHARE compatible)', async () => {
    const fake = makeFakeCardPool();
    const store = createPostgresCardStore(fake.pool as unknown as Pool);
    await store.createCardPurchase('h1', {
      accountId: 'card-1',
      description: 'Mercado',
      amountCents: 100_00,
      date: '2030-07-05',
    });
    const balanceSelect = fake.sqlLog.find((t) => t.startsWith('SELECT balance_cents FROM accounts'));
    expect(balanceSelect).toBeDefined();
    // RED before fix (FOR UPDATE), GREEN after (FOR NO KEY UPDATE).
    expect(balanceSelect!).toContain('FOR NO KEY UPDATE');
    // The debt UPDATE must never mutate the primary key.
    const debtUpdate = fake.sqlLog.find((t) => t.startsWith('UPDATE accounts SET balance_cents'));
    expect(debtUpdate).toBeDefined();
    expect(debtUpdate!).not.toMatch(/SET\s+id\s*=/i);
  });
});

// ── PG-gated concurrency proof (skips without DATABASE_URL_TEST) ────

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[postgres-card-debt-fk-deadlock] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const suffix = `${process.pid}_${Date.now()}`;
const SCHEMA = `fkdead_${suffix}`;

const scopedPool = (schema: string, max: number): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max });
};

let adminPool: Pool | undefined;
let db: Pool | undefined;

const createFocusedTables = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, balance_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      credit_limit_cents BIGINT, closing_day INTEGER, due_day INTEGER,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL,
      account_id UUID NOT NULL REFERENCES accounts(id),
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT statements_cycle_uniq UNIQUE (household_id, account_id, cycle_year_month)
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', parent_id UUID,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      account_id UUID NOT NULL, category_id UUID, subcategory_id UUID, notes TEXT,
      transfer_to_account_id UUID, statement_id UUID REFERENCES statements(id),
      statement_payment_id UUID,
      installments_total INTEGER, installment_number INTEGER,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE card_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      statement_id UUID NOT NULL REFERENCES statements(id), description TEXT NOT NULL,
      amount_cents BIGINT NOT NULL, date DATE NOT NULL, category_id UUID,
      subcategory_id UUID, notes TEXT,
      installments_total INTEGER, installment_number INTEGER,
      is_recurring BOOLEAN NOT NULL DEFAULT false, transaction_id UUID,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

describeIfDb('card-debt FK deadlock — concurrent different-cycle purchases (PG)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    await requireTestDatabase(adminPool, 'schema-create');
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    db = scopedPool(SCHEMA, 6);
    await createFocusedTables(db);
  }, 120_000);

  afterAll(async () => {
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await db?.end();
    await adminPool?.end();
  });

  it('two distinct purchases in different cycles on the same card both commit with exact debt and no deadlock', async () => {
    const store = createPostgresCardStore(db!);
    const hh = randomUUID();
    // closingDay 10: 2030-07-05 → closing 2030-07-10 → cycle 2030-07;
    // 2030-07-15 → closing 2030-08-10 → cycle 2030-08 (distinct statements).
    const card = await store.createCard(hh, {
      name: 'Nubank',
      creditLimitCents: 5000_00,
      closingDay: 10,
      dueDay: 20,
    });
    const cardId = card.id;

    // Distinct keyed operations (separate idempotency keys / txs) racing on
    // the same card row with different statement FK targets.
    const runA = store.createCardPurchase(hh, {
      accountId: cardId,
      description: 'Keyed-A Mercado',
      amountCents: 100_00,
      date: '2030-07-05',
    });
    const runB = store.createCardPurchase(hh, {
      accountId: cardId,
      description: 'Keyed-B Farmacia',
      amountCents: 250_00,
      date: '2030-07-15',
    });
    let deadlock = false;
    let results: Awaited<ReturnType<typeof store.createCardPurchase>>[] | undefined;
    try {
      results = await Promise.all([runA, runB]);
    } catch (err) {
      if ((err as { code?: string })?.code === '40P01') deadlock = true;
      throw err;
    }
    expect(deadlock).toBe(false);
    expect(results!).toHaveLength(2);

    // Debt exact: 100_00 + 250_00.
    const bal = await db!.query(`SELECT id, balance_cents FROM accounts WHERE id = $1`, [cardId]);
    expect(bal.rows[0]!['id']).toBe(cardId); // PK never mutated.
    expect(Number(bal.rows[0]!['balance_cents'])).toBe(350_00);

    // One statement per cycle, each with its exact total.
    const stmts = await store.listStatements(hh, cardId);
    expect(stmts.map((s) => s.cycleYearMonth).sort()).toEqual(['2030-07', '2030-08']);
    const totals = new Map(stmts.map((s) => [s.cycleYearMonth, s.totalCents]));
    expect(totals.get('2030-07')).toBe(100_00);
    expect(totals.get('2030-08')).toBe(250_00);

    await db!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
    await db!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
    await db!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
    await db!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
  }, 30_000);

  it('a failed concurrent purchase rolls back cleanly while the valid one commits exact', async () => {
    const store = createPostgresCardStore(db!);
    const hh = randomUUID();
    const card = await store.createCard(hh, {
      name: 'Nubank',
      creditLimitCents: 5000_00,
      closingDay: 10,
      dueDay: 20,
    });
    const cardId = card.id;

    const valid = store.createCardPurchase(hh, {
      accountId: cardId,
      description: 'Keyed-OK',
      amountCents: 120_00,
      date: '2030-07-05',
    });
    const failing = store.createCardPurchase(hh, {
      accountId: randomUUID(), // unknown card → not_found, whole tx rolls back.
      description: 'Keyed-FAIL',
      amountCents: 999_00,
      date: '2030-07-15',
    });
    const settled = await Promise.allSettled([valid, failing]);
    expect(settled[0]!.status).toBe('fulfilled');
    expect(settled[1]!.status).toBe('rejected');

    const bal = await db!.query(`SELECT id, balance_cents FROM accounts WHERE id = $1`, [cardId]);
    expect(bal.rows[0]!['id']).toBe(cardId);
    expect(Number(bal.rows[0]!['balance_cents'])).toBe(120_00);

    const leaked = await db!.query(
      `SELECT COUNT(*) AS n FROM transactions WHERE household_id = $1 AND description = $2 AND deleted_at IS NULL`,
      [hh, 'Keyed-FAIL'],
    );
    expect(Number(leaked.rows[0]!['n'])).toBe(0);

    await db!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
    await db!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
    await db!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
    await db!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
  }, 30_000);
});
