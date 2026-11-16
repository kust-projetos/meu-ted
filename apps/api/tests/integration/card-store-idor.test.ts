import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import type { CardStore } from '../../src/cards/store.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const describeIfDb = DB_URL ? describe : describe.skip;

const HOUSEHOLD_A = '00000000-0000-4000-8000-00000000000a';
const HOUSEHOLD_B = '00000000-0000-4000-8000-00000000000b';
const CATEGORY_A = '22222222-2222-4222-8222-222222222221';
const CATEGORY_B = '22222222-2222-4222-8222-222222222224';

const scopedPool = (schema: string): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString() });
};

const createLegacyTables = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      initial_balance_cents BIGINT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true,
      is_credit_card BOOLEAN NOT NULL DEFAULT false, credit_limit_cents BIGINT,
      closing_day INTEGER, due_day INTEGER, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, deleted_at TIMESTAMPTZ,
      parent_id UUID REFERENCES categories(id),
      icon TEXT, color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default BOOLEAN NOT NULL DEFAULT false,
      is_system BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (household_id, account_id, cycle_year_month)
    );
    CREATE TABLE card_purchases (
      id UUID PRIMARY KEY, household_id UUID, account_id UUID, statement_id UUID NOT NULL, description TEXT NOT NULL,
      amount_cents BIGINT NOT NULL, date DATE NOT NULL, category_id UUID,
      subcategory_id UUID REFERENCES categories(id), notes TEXT,
      installments_total INTEGER, installment_number INTEGER,
      is_recurring BOOLEAN NOT NULL DEFAULT false, transaction_id UUID, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      from_account_id UUID, category_id UUID, statement_id UUID,
      subcategory_id UUID REFERENCES categories(id), notes TEXT,
      installments_total INTEGER, installment_number INTEGER,
      is_recurring BOOLEAN NOT NULL DEFAULT false, is_credit_card_purchase BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE recurring_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, frequency TEXT NOT NULL,
      start_date DATE NOT NULL, end_date DATE, category_id UUID, status TEXT NOT NULL,
      next_due_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const seedCanonicalCategories = async (pool: Pool): Promise<void> => {
  await pool.query(
    `INSERT INTO categories (id, household_id, name, kind, status) VALUES ($1, $2, 'A food', 'expense', 'active'), ($3, $4, 'B food', 'expense', 'active')`,
    [CATEGORY_A, HOUSEHOLD_A, CATEGORY_B, HOUSEHOLD_B],
  );
};

const seedLegacyCategories = async (pool: Pool): Promise<void> => {
  await pool.query(
    `INSERT INTO categories (id, household_id, name, kind, active) VALUES ($1, $2, 'A food', 'expense', true), ($3, $4, 'B food', 'expense', true)`,
    [CATEGORY_A, HOUSEHOLD_A, CATEGORY_B, HOUSEHOLD_B],
  );
};

const exerciseStore = async (store: CardStore): Promise<void> => {
  const cardA = await store.createCard(HOUSEHOLD_A, { name: 'A card', creditLimitCents: 100000, closingDay: 15, dueDay: 25 });
  const cardB = await store.createCard(HOUSEHOLD_B, { name: 'B card', creditLimitCents: 100000, closingDay: 15, dueDay: 25 });

  await store.createCardPurchase(HOUSEHOLD_A, {
    accountId: cardA.id, categoryId: CATEGORY_A, description: 'A purchase', amountCents: 1000, date: '2026-07-10',
  });
  const purchaseB = await store.createCardPurchase(HOUSEHOLD_B, {
    accountId: cardB.id, categoryId: CATEGORY_B, description: 'B purchase', amountCents: 2000, date: '2026-07-10',
  });

  const statementB = (await store.listStatements(HOUSEHOLD_B))[0]!;
  const detailB = await store.getStatementDetail(HOUSEHOLD_B, statementB.id);
  expect(detailB?.purchases[0]?.categoryId).toBe(CATEGORY_B);
  expect(await store.getStatementDetail(HOUSEHOLD_A, statementB.id)).toBeNull();
  await expect(store.updatePurchase(HOUSEHOLD_A, purchaseB[0]!.id, {
    description: 'cross-household update',
  })).rejects.toMatchObject({ code: 'not_found' });

  await expect(store.createCardPurchase(HOUSEHOLD_A, {
    accountId: cardA.id, categoryId: CATEGORY_B, description: 'foreign category', amountCents: 1000, date: '2026-07-10',
  })).rejects.toMatchObject({ code: 'not_found' });

  await expect(store.createRecurringPurchase(HOUSEHOLD_A, {
    accountId: cardB.id, description: 'foreign account', amountCents: 1000, frequency: 'monthly', startDate: '2026-07-10',
  })).rejects.toMatchObject({ code: 'not_found' });
};

describeIfDb('card stores: real Postgres household isolation', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const canonicalSchema = `g2223_c_${suffix}`;
  const legacySchema = `g2223_l_${suffix}`;
  let adminPool: Pool;
  let canonicalPool: Pool;
  let legacyPool: Pool;

  beforeAll(async () => {
    // V049 probes public.categories.status to pick its canonical no-op
    // branch: migrate public first so schema-scoped applies see the
    // canonical shape even when this file runs first on a fresh database.
    adminPool = createPool({ connectionString: DB_URL! });
    await runMigrations(adminPool);
    canonicalPool = scopedPool(canonicalSchema);
    legacyPool = scopedPool(legacySchema);
    // Defensive on a reused database: a previous timed-out run may have
    // left same-suffix schemas behind (suffix is pid+timestamp, so this is
    // normally a no-op).
    await adminPool.query(`DROP SCHEMA IF EXISTS ${canonicalSchema} CASCADE`).catch(() => undefined);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`).catch(() => undefined);
    await canonicalPool.query(`CREATE SCHEMA ${canonicalSchema}`);
    await legacyPool.query(`CREATE SCHEMA ${legacySchema}`);
    await runMigrations(canonicalPool);
    await createLegacyTables(legacyPool);
    await seedCanonicalCategories(canonicalPool);
    await seedLegacyCategories(legacyPool);
  }, 120_000);

  afterAll(async () => {
    // DROP can hit a transient deadlock against autovacuum on a heavily
    // reused database: retry once before giving up (schemas are
    // pid+timestamp unique, so a leftover is harmless to siblings).
    try {
      await canonicalPool.query(`DROP SCHEMA IF EXISTS ${canonicalSchema} CASCADE`);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      await canonicalPool.query(`DROP SCHEMA IF EXISTS ${canonicalSchema} CASCADE`).catch(() => undefined);
    }
    try {
      await legacyPool.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      await legacyPool.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`).catch(() => undefined);
    }
    await canonicalPool.end();
    await legacyPool.end();
    await adminPool.end();
  });

  it('isolates canonical Postgres card data and references', async () => {
    await exerciseStore(createPostgresCardStore(canonicalPool));
  }, 30_000);

});
