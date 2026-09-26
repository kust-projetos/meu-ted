/**
 * Postgres integration test — gated by DATABASE_URL.
 *
 * To run:
 *   1. Set DATABASE_URL to a test database (e.g. postgres://user:pw@localhost:5432/pi_finance_api_test)
 *   2. pnpm test
 *
 * If DATABASE_URL is not set, the suite is skipped with an explanatory
 * note. The contract suite (which uses the in-memory store) still runs,
 * so the test command always succeeds on hosts without Postgres.
 *
 * Note: the suite TRUNCATEs all four tables before inserting seed
 * data. It does not drop the schema, so the schema must already be
 * present (run `pnpm db:migrate` first).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runReadModelStoreContract, defaultContractSeed } from '../contract/read-model-store.contract.js';
import { createPostgresReadModelStore } from '../../src/read-models/postgres-store.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import type { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL;
const _SKIP_REASON =
  'DATABASE_URL is not set — skipping Postgres integration test. Set DATABASE_URL and run `pnpm db:migrate` to enable.';

const TEST_TABLES = ['accounts', 'categories', 'transactions', 'device_tokens'] as const;

const truncate = async (pool: Pool): Promise<void> => {
  await requireTestDatabase(pool, 'truncate');
  await pool.query(`TRUNCATE TABLE ${TEST_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
};

const seedData = async (pool: Pool): Promise<void> => {
  const seed = defaultContractSeed();
  await pool.query(
    `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status) VALUES
       ($1, $2, 'A1', 'bank', 100000, 'active'),
       ($3, $2, 'A2', 'cash',  50000,  'active'),
       ($4, $5, 'B1', 'bank', 999,    'active')`,
    [
      seed.accounts[0]!.id, seed.householdId,
      seed.accounts[1]!.id,
      seed.accounts[2]!.id, seed.otherHouseholdId,
    ],
  );
  await pool.query(
    `INSERT INTO categories (id, household_id, name, kind, status) VALUES
       ($1, $2, 'Food',   'expense', 'active'),
       ($3, $2, 'Salary', 'income',  'active')`,
    [seed.categories[0]!.id, seed.householdId, seed.categories[1]!.id],
  );
  await pool.query(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id, transfer_to_account_id) VALUES
       ($1, $2, 'expense',  'Mercado',  480,  '2026-06-10', $3, $4, NULL),
       ($5, $2, 'income',   'Salário',  12000,'2026-06-01', $3, $6, NULL),
       ($7, $2, 'transfer', 'A1 \u2192 A2', 500, '2026-06-08', $3, NULL, $8),
       ($9, $10,'expense',  'Other',    100,  '2026-06-09', $11, NULL, NULL)`,
    [
      seed.transactions[0]!.id, seed.householdId, seed.accounts[0]!.id, seed.categories[0]!.id,
      seed.transactions[1]!.id, seed.categories[1]!.id,
      seed.transactions[2]!.id, seed.accounts[1]!.id,
      seed.transactions[3]!.id, seed.otherHouseholdId, seed.accounts[2]!.id,
    ],
  );
};

const runIfDbAvailable = (): void => {
  if (!DB_URL) {
    describe.skip('Postgres integration: contract', () => {
      // Skip reason is in the test name below; placeholder body for typecheck.
    });
    return;
  }

  let pool: Pool;
  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL! });
    await runMigrations(pool);
    await truncate(pool);
    await seedData(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  const seed = defaultContractSeed();

  runReadModelStoreContract({
    name: 'postgres',
    seed,
    create: async () => {
      // Each test re-seeds so prior tests' data doesn't leak.
      await truncate(pool);
      await seedData(pool);
      return {
        store: createPostgresReadModelStore({ pool }),
        cleanup: async () => {
          // Nothing per-test; the afterAll hook closes the pool.
        },
      };
    },
  });
};

runIfDbAvailable();

describe('Postgres integration: smoke', () => {
  const itOrSkip = DB_URL ? it : it.skip;

  itOrSkip('connects and lists accounts for the seeded household', async () => {
    const pool = createPool({ connectionString: DB_URL! });
    try {
      const store = createPostgresReadModelStore({ pool });
      const seed = defaultContractSeed();
      const accounts = await store.listAccounts(seed.householdId);
      expect(accounts).toHaveLength(2);
    } finally {
      await pool.end();
    }
  }, 30_000);
});
