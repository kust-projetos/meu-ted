import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore, createCategoryLegacyInTx } from '../../src/writes/legacy-postgres.js';
import { createPostgresBudgetStore } from '../../src/budgets/postgres.js';
import { createLegacyPostgresBudgetStore } from '../../src/budgets/legacy-postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { createLegacyPostgresPayableStore } from '../../src/payables/legacy-postgres.js';
import type { CreateExpenseInput } from '../../src/writes/types.js';

const DATABASE_URL = process.env.DATABASE_URL_TEST;
const EXPECTED_DATABASE = process.env.CATEGORY_LIFECYCLE_EXPECTED_DB;
const LEGACY_DATABASE_URL = process.env.CATEGORY_LIFECYCLE_LEGACY_DATABASE_URL;
const EXPECTED_LEGACY_DATABASE = process.env.CATEGORY_LIFECYCLE_EXPECTED_LEGACY_DB;
const ENABLED = Boolean(
  DATABASE_URL && process.env.DB_TEST_MARKER && EXPECTED_DATABASE &&
  LEGACY_DATABASE_URL && process.env.CATEGORY_LIFECYCLE_LEGACY_MARKER && EXPECTED_LEGACY_DATABASE,
);
const itIfDatabase = ENABLED ? it : it.skip;
let pool: Pool | undefined;
let legacyPool: Pool | undefined;
let appName = '';

const LEGACY_SHAPE_DDL = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE categories ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ALTER COLUMN status SET DEFAULT 'active'`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS from_account_id UUID`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS to_account_id UUID`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_credit_card_purchase BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE transactions ALTER COLUMN account_id DROP NOT NULL`,
];

const poolUrlWithAppName = (raw: string, name: string): string => {
  const url = new URL(raw);
  url.searchParams.set('application_name', name);
  return url.toString();
};

const waitForAdvisoryWait = async (db: Pool, name: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await db.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING (pid)
          WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'
            AND a.query ILIKE '%pg_advisory_xact_lock%' AND l.locktype = 'advisory'
            AND NOT l.granted
       ) AS waiting`,
      [name],
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for observed advisory lock wait (${name})`);
};

const barrierPool = (
  source: Pool,
  blocks: (sql: string) => boolean,
): { pool: Pool; entered: Promise<void>; release: () => void } => {
  let enteredOnce = false;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const wrapped = {
    connect: async () => {
      const client = await source.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (sql: string, values?: unknown[]) => {
              if (!enteredOnce && blocks(sql)) {
                enteredOnce = true;
                enter();
                await released;
              }
              return target.query(sql, values);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
    query: source.query.bind(source),
  };
  return { pool: wrapped as unknown as Pool, entered, release };
};

const categoryExtensions = (store: unknown) => store as {
  createCategoryInTx: (client: PoolClient, householdId: string, input: { name: string; kind: 'expense'; parentId?: string }) => Promise<unknown>;
  createExpenseInTx: (client: PoolClient, householdId: string, input: CreateExpenseInput) => Promise<unknown>;
};

const budgetExtension = (store: unknown) => store as {
  createBudgetInTx: (client: PoolClient, householdId: string, input: {
    categoryId: string; name: string; amountCents: number; period: 'monthly'; startDate: string; alertThreshold: number;
  }) => Promise<unknown>;
};

const payableExtension = (store: unknown) => store as {
  createPayableInTx: (client: PoolClient, householdId: string, input: {
    accountId: string; description: string; amountCents: number; dueDate: string; categoryId: string;
  }) => Promise<unknown>;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const referenceWins = async (args: {
  db: Pool;
  householdId: string;
  deactivate: () => Promise<unknown>;
  writeReference: (client: PoolClient) => Promise<unknown>;
  isActive: () => Promise<boolean>;
  assertReference: () => Promise<void>;
  app: string;
}): Promise<void> => {
  const client = await args.db.connect();
  let committed = false;
  let deactivation: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN');
    await args.writeReference(client);
    deactivation = args.deactivate();
    await waitForAdvisoryWait(args.db, args.app);
    await client.query('COMMIT');
    committed = true;
    await expect(deactivation).rejects.toMatchObject({ code: 'in_use' });
    expect(await args.isActive()).toBe(true);
    await args.assertReference();
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    if (deactivation) await deactivation.catch(() => undefined);
    client.release();
  }
};

const deactivateWins = async (args: {
  db: Pool;
  app: string;
  deactivate: (pool: Pool) => Promise<{ status?: string }>;
  sqlPredicate: (sql: string) => boolean;
  writeReference: () => Promise<unknown>;
  assertNoReference: () => Promise<void>;
}): Promise<void> => {
  const barrier = barrierPool(args.db, args.sqlPredicate);
  const deactivation = args.deactivate(barrier.pool);
  try {
    await withTimeout(barrier.entered, 5_000, 'deactivation update barrier');
    const writer = args.writeReference();
    await waitForAdvisoryWait(args.db, args.app);
    barrier.release();
    const deactivated = await deactivation;
    expect(deactivated.status).toBe('inactive');
    await expect(writer).rejects.toMatchObject({ code: 'not_found' });
    await args.assertNoReference();
  } finally {
    barrier.release();
    await deactivation.catch(() => undefined);
  }
};

const activeCanonical = async (db: Pool, householdId: string, categoryId: string): Promise<boolean> => {
  const result = await db.query<{ status: string }>(
    `SELECT status FROM categories WHERE id = $1 AND household_id = $2`, [categoryId, householdId],
  );
  return result.rows[0]?.status === 'active';
};

const activeLegacy = async (db: Pool, householdId: string, categoryId: string): Promise<boolean> => {
  const result = await db.query<{ active: boolean }>(
    `SELECT active FROM categories WHERE id = $1 AND household_id = $2`, [categoryId, householdId],
  );
  return result.rows[0]?.active === true;
};

const transactionReferenceCount = async (db: Pool, householdId: string, categoryId: string): Promise<number> => {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM transactions
      WHERE household_id = $1 AND (category_id = $2 OR subcategory_id = $2)`,
    [householdId, categoryId],
  );
  return Number(result.rows[0]?.count ?? 0);
};

const childrenCount = async (db: Pool, householdId: string, categoryId: string): Promise<number> => {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categories WHERE household_id = $1 AND parent_id = $2`,
    [householdId, categoryId],
  );
  return Number(result.rows[0]?.count ?? 0);
};

describe('Postgres category lifecycle foundation', () => {
  beforeAll(async () => {
    if (!DATABASE_URL || !LEGACY_DATABASE_URL) return;
    appName = `catlife-${randomUUID().replaceAll('-', '')}`;
    pool = createPool({
      connectionString: poolUrlWithAppName(DATABASE_URL, appName), max: 12,
      lockTimeoutMillis: 8_000, statementTimeoutMillis: 20_000, idleInTransactionSessionTimeoutMillis: 20_000,
    });
    legacyPool = createPool({
      connectionString: poolUrlWithAppName(LEGACY_DATABASE_URL, `${appName}-l`), max: 12,
      lockTimeoutMillis: 8_000, statementTimeoutMillis: 20_000, idleInTransactionSessionTimeoutMillis: 20_000,
    });
    await requireTestDatabase(pool, 'category-lifecycle');
    const identity = await pool.query<{ database_name: string }>(`SELECT current_database() AS database_name`);
    if (identity.rows[0]?.database_name !== EXPECTED_DATABASE) {
      throw new Error('category-lifecycle test refused unexpected database identity');
    }
    const canonicalMarker = process.env.DB_TEST_MARKER;
    process.env.DB_TEST_MARKER = process.env.CATEGORY_LIFECYCLE_LEGACY_MARKER;
    try {
      await requireTestDatabase(legacyPool, 'category-lifecycle-legacy');
      const legacyIdentity = await legacyPool.query<{ database_name: string }>(`SELECT current_database() AS database_name`);
      if (legacyIdentity.rows[0]?.database_name !== EXPECTED_LEGACY_DATABASE) {
        throw new Error('category-lifecycle test refused unexpected legacy database identity');
      }
    } finally {
      process.env.DB_TEST_MARKER = canonicalMarker;
    }
    await runMigrations(pool);
    await runMigrations(legacyPool);
    for (const ddl of LEGACY_SHAPE_DDL) await legacyPool.query(ddl);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await legacyPool?.end();
  });

  itIfDatabase('blocks deactivation for soft-deleted transaction history without rewriting it', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const categoryId = randomUUID();
    const transactionId = randomUUID();
    await pool.query(
      `INSERT INTO categories (id, household_id, name, kind, status, parent_id)
       VALUES ($1, $2, 'Lifecycle history', 'expense', 'active', NULL)`,
      [categoryId, householdId],
    );
    await pool.query(
      `INSERT INTO transactions
         (id, household_id, kind, description, amount_cents, date, account_id, category_id, deleted_at)
       VALUES ($1, $2, 'expense', 'historical reference', 100, CURRENT_DATE, $3, $4, NOW())`,
      [transactionId, householdId, randomUUID(), categoryId],
    );

    const writes = createPostgresWriteStore({ pool });
    await expect(writes.deactivateCategory(householdId, categoryId)).rejects.toMatchObject({
      code: 'in_use',
    });
    const category = await pool.query(`SELECT status FROM categories WHERE id = $1`, [categoryId]);
    const transaction = await pool.query(
      `SELECT category_id, deleted_at FROM transactions WHERE id = $1`,
      [transactionId],
    );
    expect(category.rows[0]?.['status']).toBe('active');
    expect(transaction.rows[0]?.['category_id']).toBe(categoryId);
    expect(transaction.rows[0]?.['deleted_at']).not.toBeNull();
  });

  itIfDatabase('blocks deactivation when even an inactive child row exists', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    await pool.query(
      `INSERT INTO categories (id, household_id, name, kind, status, parent_id)
       VALUES ($1, $2, 'Lifecycle parent', 'expense', 'active', NULL),
              ($3, $2, 'Lifecycle child', 'expense', 'inactive', $1)`,
      [parentId, householdId, childId],
    );
    const writes = createPostgresWriteStore({ pool });
    await expect(writes.deactivateCategory(householdId, parentId)).rejects.toMatchObject({
      code: 'in_use',
    });
    const parent = await pool.query(`SELECT status FROM categories WHERE id = $1`, [parentId]);
    expect(parent.rows[0]?.['status']).toBe('active');
  });

  itIfDatabase('serializes a concurrent child-category insert before deactivation', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const parent = await createPostgresWriteStore({ pool }).createCategory(householdId, {
      name: 'Race parent', kind: 'expense',
    });
    const writes = createPostgresWriteStore({ pool });
    await referenceWins({
      db: pool,
      app: appName,
      householdId,
      deactivate: () => writes.deactivateCategory(householdId, parent.id),
      writeReference: (client) => categoryExtensions(writes).createCategoryInTx(client, householdId, {
        name: 'Race child', kind: 'expense', parentId: parent.id,
      }),
      isActive: () => activeCanonical(pool, householdId, parent.id),
      assertReference: async () => expect(await childrenCount(pool, householdId, parent.id)).toBe(1),
    });
  });

  itIfDatabase('serializes a concurrent budget reference before deactivation', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(householdId, { name: 'Race budget', kind: 'expense' });
    const budgets = createPostgresBudgetStore(pool);
    await referenceWins({
      db: pool,
      app: appName,
      householdId,
      deactivate: () => writes.deactivateCategory(householdId, category.id),
      writeReference: (client) => budgetExtension(budgets).createBudgetInTx(client, householdId, {
        categoryId: category.id, name: 'Race budget', amountCents: 5_000,
        period: 'monthly', startDate: '2026-10-01', alertThreshold: 80,
      }),
      isActive: () => activeCanonical(pool, householdId, category.id),
      assertReference: async () => {
        const result = await pool.query(`SELECT COUNT(*)::int AS count FROM budgets WHERE household_id = $1`, [householdId]);
        expect(result.rows[0]?.['count']).toBe(1);
      },
    });
  });

  itIfDatabase('serializes canonical expense creation before deactivation', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(householdId, { name: 'Race expense', kind: 'expense' });
    const account = await writes.createAccount(householdId, {
      name: 'Race expense account', kind: 'bank', initialBalanceCents: 10_000,
    });
    const input: CreateExpenseInput = {
      description: 'Race expense', amountCents: 100, date: '2026-10-22', accountId: account.id, categoryId: category.id,
    };
    await referenceWins({
      db: pool, app: appName, householdId,
      deactivate: () => writes.deactivateCategory(householdId, category.id),
      writeReference: (client) => categoryExtensions(writes).createExpenseInTx(client, householdId, input),
      isActive: () => activeCanonical(pool, householdId, category.id),
      assertReference: async () => expect(await transactionReferenceCount(pool, householdId, category.id)).toBe(1),
    });
    const balance = await pool.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [account.id]);
    expect(Number(balance.rows[0]?.['balance_cents'])).toBe(9_900);
  });

  itIfDatabase('serializes canonical payable creation before deactivation', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(householdId, { name: 'Race payable', kind: 'expense' });
    const account = await writes.createAccount(householdId, {
      name: 'Race payable account', kind: 'bank', initialBalanceCents: 10_000,
    });
    const payables = createPostgresPayableStore(pool);
    await referenceWins({
      db: pool, app: appName, householdId,
      deactivate: () => writes.deactivateCategory(householdId, category.id),
      writeReference: (client) => payableExtension(payables).createPayableInTx(client, householdId, {
        accountId: account.id, description: 'Race payable', amountCents: 100,
        dueDate: '2026-11-01', categoryId: category.id,
      }),
      isActive: () => activeCanonical(pool, householdId, category.id),
      assertReference: async () => {
        const result = await pool.query(`SELECT COUNT(*)::int AS count FROM accounts_payable WHERE household_id = $1 AND category_id = $2`, [householdId, category.id]);
        expect(result.rows[0]?.['count']).toBe(1);
      },
    });
  });

  itIfDatabase('canonical deactivation wins against a waiting expense writer', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(householdId, { name: 'Deactivate expense', kind: 'expense' });
    const account = await writes.createAccount(householdId, {
      name: 'Deactivate expense account', kind: 'bank', initialBalanceCents: 10_000,
    });
    const input: CreateExpenseInput = {
      description: 'Blocked expense', amountCents: 100, date: '2026-10-22', accountId: account.id, categoryId: category.id,
    };
    await deactivateWins({
      db: pool, app: appName,
      deactivate: (barrier) => createPostgresWriteStore({ pool: barrier }).deactivateCategory(householdId, category.id),
      sqlPredicate: (sql) => /UPDATE categories[\s\S]*SET status = 'inactive'/i.test(sql),
      writeReference: () => writes.createExpense(householdId, input),
      assertNoReference: async () => {
        expect(await transactionReferenceCount(pool, householdId, category.id)).toBe(0);
        const balance = await pool.query(`SELECT balance_cents FROM accounts WHERE id = $1`, [account.id]);
        expect(Number(balance.rows[0]?.['balance_cents'])).toBe(10_000);
      },
    });
  });

  itIfDatabase('canonical deactivation wins against a waiting child-category writer', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const writes = createPostgresWriteStore({ pool });
    const parent = await writes.createCategory(householdId, { name: 'Deactivate parent', kind: 'expense' });
    await deactivateWins({
      db: pool, app: appName,
      deactivate: (barrier) => createPostgresWriteStore({ pool: barrier }).deactivateCategory(householdId, parent.id),
      sqlPredicate: (sql) => /UPDATE categories[\s\S]*SET status = 'inactive'/i.test(sql),
      writeReference: () => writes.createCategory(householdId, {
        name: 'Blocked child', kind: 'expense', parentId: parent.id,
      }),
      assertNoReference: async () => expect(await childrenCount(pool, householdId, parent.id)).toBe(0),
    });
  });

  itIfDatabase('canonical deactivation wins against a waiting payable writer', async () => {
    if (!pool) throw new Error('test database not initialized');
    const householdId = randomUUID();
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(householdId, { name: 'Deactivate payable', kind: 'expense' });
    const account = await writes.createAccount(householdId, {
      name: 'Deactivate payable account', kind: 'bank', initialBalanceCents: 10_000,
    });
    const payables = createPostgresPayableStore(pool);
    await deactivateWins({
      db: pool, app: appName,
      deactivate: (barrier) => createPostgresWriteStore({ pool: barrier }).deactivateCategory(householdId, category.id),
      sqlPredicate: (sql) => /UPDATE categories[\s\S]*SET status = 'inactive'/i.test(sql),
      writeReference: () => payables.createPayable(householdId, {
        accountId: account.id, description: 'Blocked payable', amountCents: 100,
        dueDate: '2026-11-01', categoryId: category.id,
      }),
      assertNoReference: async () => {
        const result = await pool.query(`SELECT COUNT(*)::int AS count FROM accounts_payable WHERE household_id = $1 AND category_id = $2`, [householdId, category.id]);
        expect(result.rows[0]?.['count']).toBe(0);
      },
    });
  });

  itIfDatabase('serializes legacy child-category creation before deactivation', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const parent = await writes.createCategory(householdId, { name: 'Legacy race parent', kind: 'expense' });
    await referenceWins({
      db: legacyPool, app: `${appName}-l`, householdId,
      deactivate: () => writes.deactivateCategory(householdId, parent.id),
      writeReference: (client) => createCategoryLegacyInTx(client, householdId, {
        name: 'Legacy race child', kind: 'expense', parentId: parent.id,
      }),
      isActive: () => activeLegacy(legacyPool, householdId, parent.id),
      assertReference: async () => expect(await childrenCount(legacyPool, householdId, parent.id)).toBe(1),
    });
  });

  itIfDatabase('serializes legacy expense creation before deactivation', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const category = await createLegacyPostgresWriteStore({ pool: legacyPool }).createCategory(
      householdId, { name: 'Legacy race expense', kind: 'expense' },
    );
    const accountId = randomUUID();
    await legacyPool.query(
      `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active, is_credit_card)
       VALUES ($1, $2, 'Legacy race account', 10000, true, false)`,
      [accountId, householdId],
    );
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const input: CreateExpenseInput = {
      description: 'Legacy race expense', amountCents: 100, date: '2026-10-22', accountId, categoryId: category.id,
    };
    await referenceWins({
      db: legacyPool, app: `${appName}-l`, householdId,
      deactivate: () => writes.deactivateCategory(householdId, category.id),
      writeReference: (client) => categoryExtensions(writes).createExpenseInTx(client, householdId, input),
      isActive: () => activeLegacy(legacyPool, householdId, category.id),
      assertReference: async () => expect(await transactionReferenceCount(legacyPool, householdId, category.id)).toBe(1),
    });
  });

  itIfDatabase('serializes legacy budget creation before deactivation', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const category = await writes.createCategory(householdId, { name: 'Legacy race budget', kind: 'expense' });
    const budgets = createLegacyPostgresBudgetStore(legacyPool);
    await referenceWins({
      db: legacyPool, app: `${appName}-l`, householdId,
      deactivate: () => writes.deactivateCategory(householdId, category.id),
      writeReference: (client) => budgetExtension(budgets).createBudgetInTx(client, householdId, {
        categoryId: category.id, name: 'Legacy race budget', amountCents: 5_000,
        period: 'monthly', startDate: '2026-10-01', alertThreshold: 80,
      }),
      isActive: () => activeLegacy(legacyPool, householdId, category.id),
      assertReference: async () => {
        const result = await legacyPool.query(`SELECT COUNT(*)::int AS count FROM budgets WHERE household_id = $1 AND category_id = $2`, [householdId, category.id]);
        expect(result.rows[0]?.['count']).toBe(1);
      },
    });
  });

  itIfDatabase('serializes legacy payable creation before deactivation', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const category = await writes.createCategory(householdId, { name: 'Legacy race payable', kind: 'expense' });
    const accountId = randomUUID();
    await legacyPool.query(
      `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active, is_credit_card)
       VALUES ($1, $2, 'Legacy payable account', 10000, true, false)`,
      [accountId, householdId],
    );
    const payables = createLegacyPostgresPayableStore(legacyPool);
    await referenceWins({
      db: legacyPool, app: `${appName}-l`, householdId,
      deactivate: () => writes.deactivateCategory(householdId, category.id),
      writeReference: (client) => payableExtension(payables).createPayableInTx(client, householdId, {
        accountId, description: 'Legacy race payable', amountCents: 100,
        dueDate: '2026-11-01', categoryId: category.id,
      }),
      isActive: () => activeLegacy(legacyPool, householdId, category.id),
      assertReference: async () => {
        const result = await legacyPool.query(`SELECT COUNT(*)::int AS count FROM accounts_payable WHERE household_id = $1 AND category_id = $2`, [householdId, category.id]);
        expect(result.rows[0]?.['count']).toBe(1);
      },
    });
  });

  itIfDatabase('legacy deactivation wins against a waiting expense writer', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const category = await createLegacyPostgresWriteStore({ pool: legacyPool }).createCategory(
      householdId, { name: 'Legacy deactivate expense', kind: 'expense' },
    );
    const accountId = randomUUID();
    await legacyPool.query(
      `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active, is_credit_card)
       VALUES ($1, $2, 'Legacy blocked account', 10000, true, false)`,
      [accountId, householdId],
    );
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    await deactivateWins({
      db: legacyPool, app: `${appName}-l`,
      deactivate: (barrier) => createLegacyPostgresWriteStore({ pool: barrier }).deactivateCategory(householdId, category.id),
      sqlPredicate: (sql) => /UPDATE categories[\s\S]*SET active = false/i.test(sql),
      writeReference: () => writes.createExpense(householdId, {
        description: 'Blocked legacy expense', amountCents: 100, date: '2026-10-22', accountId, categoryId: category.id,
      }),
      assertNoReference: async () => expect(await transactionReferenceCount(legacyPool, householdId, category.id)).toBe(0),
    });
  });

  itIfDatabase('legacy deactivation wins against a waiting child-category writer', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const parent = await writes.createCategory(householdId, { name: 'Legacy deactivate parent', kind: 'expense' });
    await deactivateWins({
      db: legacyPool, app: `${appName}-l`,
      deactivate: (barrier) => createLegacyPostgresWriteStore({ pool: barrier }).deactivateCategory(householdId, parent.id),
      sqlPredicate: (sql) => /UPDATE categories[\s\S]*SET active = false/i.test(sql),
      writeReference: () => writes.createCategory(householdId, {
        name: 'Legacy blocked child', kind: 'expense', parentId: parent.id,
      }),
      assertNoReference: async () => expect(await childrenCount(legacyPool, householdId, parent.id)).toBe(0),
    });
  });

  itIfDatabase('legacy deactivation wins against a waiting payable writer', async () => {
    if (!legacyPool) throw new Error('legacy test database not initialized');
    const householdId = randomUUID();
    const writes = createLegacyPostgresWriteStore({ pool: legacyPool });
    const category = await writes.createCategory(householdId, { name: 'Legacy deactivate payable', kind: 'expense' });
    const accountId = randomUUID();
    await legacyPool.query(
      `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active, is_credit_card)
       VALUES ($1, $2, 'Legacy blocked payable account', 10000, true, false)`,
      [accountId, householdId],
    );
    const payables = createLegacyPostgresPayableStore(legacyPool);
    await deactivateWins({
      db: legacyPool, app: `${appName}-l`,
      deactivate: (barrier) => createLegacyPostgresWriteStore({ pool: barrier }).deactivateCategory(householdId, category.id),
      sqlPredicate: (sql) => /UPDATE categories[\s\S]*SET active = false/i.test(sql),
      writeReference: () => payables.createPayable(householdId, {
        accountId, description: 'Legacy blocked payable', amountCents: 100,
        dueDate: '2026-11-01', categoryId: category.id,
      }),
      assertNoReference: async () => {
        const result = await legacyPool.query(`SELECT COUNT(*)::int AS count FROM accounts_payable WHERE household_id = $1 AND category_id = $2`, [householdId, category.id]);
        expect(result.rows[0]?.['count']).toBe(0);
      },
    });
  });
});
