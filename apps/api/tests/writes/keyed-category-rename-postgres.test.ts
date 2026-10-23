/**
 * categories.update (rename-only) keyed PG — prova real em banco descartável isolado.
 *
 * Gate: TED_CATEGORY_PG_URL + TED_CATEGORY_PG_MARKER (mesmo fixture do
 * categories.create keyed). Canonical + companion legacy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';

const DISPOSABLE_DB = 'ted_category_keyed_validation';
const DISPOSABLE_LEGACY_DB = 'ted_category_keyed_validation_legacy';

const assertDisposableUrl = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('URL ausente');
  if (/[?#]/.test(raw)) throw new Error('query/hash na URL');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error('protocolo invalido');
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('host invalido');
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error('porta invalida');
  if (parsed.pathname !== `/${DISPOSABLE_DB}`) throw new Error('database invalido');
  return raw;
};

const companionUrl = (raw: string): string => {
  const url = new URL(assertDisposableUrl(raw));
  url.pathname = `/${DISPOSABLE_LEGACY_DB}`;
  return url.toString();
};

const LEGACY_SHAPE_DDL = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE categories ALTER COLUMN status DROP NOT NULL`,
];

const DB_URL = process.env.TED_CATEGORY_PG_URL;
const MARKER = process.env.TED_CATEGORY_PG_MARKER;
const ENABLED = Boolean(DB_URL && MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

describeIfDb('categories.update keyed PG descartável — canonical + legacy', () => {
  let pool: Pool;
  let legacyPool: Pool;

  beforeAll(async () => {
    const prevMarker = process.env.DB_TEST_MARKER;
    process.env.DB_TEST_MARKER = MARKER!;
    const mainUrl = assertDisposableUrl(DB_URL);
    const main = createPool({ connectionString: mainUrl, max: 10 }) as unknown as Pool;
    const legacy = createPool({ connectionString: companionUrl(DB_URL!), max: 10 }) as unknown as Pool;
    await requireTestDatabase(main as never, 'rename-pg-main');
    await requireTestDatabase(legacy as never, 'rename-pg-legacy');
    for (const [p, expected] of [[main, DISPOSABLE_DB], [legacy, DISPOSABLE_LEGACY_DB]] as const) {
      const cur = await (p as Pool).query<{ current_database: string }>('SELECT current_database()');
      expect(cur.rows[0]!.current_database).toBe(expected);
    }
    await runMigrations(main as never);
    await runMigrations(legacy as never);
    for (const ddl of LEGACY_SHAPE_DDL) await (legacy as Pool).query(ddl);
    pool = main;
    legacyPool = legacy;
    process.env.DB_TEST_MARKER = prevMarker;
  }, 240_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> })?.end();
    await (legacyPool as unknown as { end: () => Promise<void> })?.end();
  });

  for (const [label, getPool, makeStore] of [
    ['canonical', () => pool, (p: Pool) => createPostgresWriteStore({ pool: p })],
    ['legacy', () => legacyPool, (p: Pool) => createLegacyPostgresWriteStore({ pool: p })],
  ] as const) {
    it(`${label}: rename CAS + stale conflict + no-op`, async () => {
      const p = getPool();
      const writes = makeStore(p);
      const hh = randomUUID();
      const cat = await writes.createCategory(hh, { name: 'Old', kind: 'expense' });
      const out = await writes.updateCategory(hh, cat.id, { name: 'New' }, { idempotencyKey: randomUUID(), expectedName: 'Old' });
      expect(out.name).toBe('New');
      await expect(
        writes.updateCategory(hh, cat.id, { name: 'X' }, { idempotencyKey: randomUUID(), expectedName: 'Old' }),
      ).rejects.toMatchObject({ code: 'category.name_conflict' });
      const noop = await writes.updateCategory(hh, cat.id, { name: 'New' }, { idempotencyKey: randomUUID(), expectedName: 'New' });
      expect(noop.name).toBe('New');
    });

    it(`${label}: concurrent rename same expected -> one success`, async () => {
      const p = getPool();
      const writes = makeStore(p);
      const hh = randomUUID();
      const cat = await writes.createCategory(hh, { name: 'Old', kind: 'expense' });
      const keyA = randomUUID();
      const keyB = randomUUID();
      const results = await Promise.allSettled([
        writes.updateCategory(hh, cat.id, { name: 'A' }, { idempotencyKey: keyA, expectedName: 'Old' }),
        writes.updateCategory(hh, cat.id, { name: 'B' }, { idempotencyKey: keyB, expectedName: 'Old' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason?.code).toBe('category.name_conflict');
    });

    it(`${label}: rename to existing sibling name -> in_use (no 23505)`, async () => {
      const p = getPool();
      const writes = makeStore(p);
      const hh = randomUUID();
      await writes.createCategory(hh, { name: 'Taken', kind: 'expense' });
      const cat = await writes.createCategory(hh, { name: 'Orig', kind: 'expense' });
      await expect(
        writes.updateCategory(hh, cat.id, { name: 'Taken' }, { idempotencyKey: randomUUID(), expectedName: 'Orig' }),
      ).rejects.toMatchObject({ code: 'in_use' });
    });

    it(`${label}: replay returns original snapshot after live rename`, async () => {
      const p = getPool();
      const writes = makeStore(p);
      const hh = randomUUID();
      const cat = await writes.createCategory(hh, { name: 'Old', kind: 'expense' });
      const key = randomUUID();
      const first = await writes.updateCategory(hh, cat.id, { name: 'New' }, { idempotencyKey: key, expectedName: 'Old' });
      expect(first.name).toBe('New');
      // live mutation (different key) changes current name
      await writes.updateCategory(hh, cat.id, { name: 'Live' }, { idempotencyKey: randomUUID(), expectedName: 'New' });
      const replay = await writes.updateCategory(hh, cat.id, { name: 'New' }, { idempotencyKey: key, expectedName: 'Old' });
      expect(replay.name).toBe('New');
    });
  }
});