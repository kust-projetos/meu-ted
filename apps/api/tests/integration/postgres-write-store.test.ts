/**
 * Postgres write store integration test — gated by DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWriteStoreContract } from '../contract/write-store.contract.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import type { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL;

const TEST_TABLES = ['accounts', 'categories', 'transactions', 'device_tokens'];

const runIfDbAvailable = (): void => {
  if (!DB_URL) {
    describe.skip('Postgres write-store: contract', () => {});
    return;
  }

  let pool: Pool;
  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL! });
    await runMigrations(pool);
    await requireTestDatabase(pool, 'truncate');
    await pool.query(`TRUNCATE TABLE ${TEST_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  runWriteStoreContract({
    name: 'postgres',
    create: async () => {
      await requireTestDatabase(pool, 'truncate');
      await pool.query(`TRUNCATE TABLE ${TEST_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
      return {
        writes: createPostgresWriteStore({ pool }),
        cleanup: async () => {},
      };
    },
  });

  const itOrSkip = DB_URL ? it : it.skip;

  itOrSkip('smoke: create and read an account', async () => {
    const writes = createPostgresWriteStore({ pool });
    const acc = await writes.createAccount(
      '00000000-0000-4000-8000-00000000000a',
      { name: 'Smoke', kind: 'bank', initialBalanceCents: 100 },
    );
    expect(acc.name).toBe('Smoke');
  }, 10_000);
};

runIfDbAvailable();
