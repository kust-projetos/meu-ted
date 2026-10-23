import type { Pool } from 'pg';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createPool } from '../../src/db/pool.js';
import {
  prepareValidationDatabases,
  type ValidationDatabaseProfile,
} from '../../src/db/validation-preflight.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';

// Minimal legacy accounts shape used by both account PG harnesses.
// This fixture DDL only runs after both pre-existing database markers pass.
const LEGACY_ACCOUNT_SHAPE_DDL = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE categories ALTER COLUMN status DROP NOT NULL`,
];

/** Prepares either account harness independently; marker provisioning stays outside tests. */
export const prepareAccountValidationDatabases = (opts: {
  baseUrl: string;
  profile: ValidationDatabaseProfile;
}) =>
  prepareValidationDatabases<Pool>({
    baseUrl: opts.baseUrl,
    profile: opts.profile,
    createPool: (connectionString) => createPool({ connectionString, max: 10 }),
    requireGuard: (pool, operation) => requireTestDatabase(pool as never, operation),
    migrate: (pool) => runMigrations(pool as never),
    afterMigrate: async ({ legacy }) => {
      for (const ddl of LEGACY_ACCOUNT_SHAPE_DDL) await legacy.query(ddl);
    },
  });
