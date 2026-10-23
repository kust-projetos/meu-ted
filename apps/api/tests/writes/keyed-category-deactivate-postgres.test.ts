import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';

const ALLOWED_DBS = new Set(['ted_category_keyed_validation', 'ted_category_lifecycle_validation_20261022']);
const DB = process.env.CATEGORY_DEACTIVATE_EXPECTED_DB ?? 'ted_category_keyed_validation';
const LEGACY = process.env.CATEGORY_DEACTIVATE_EXPECTED_LEGACY_DB ?? `${DB}_legacy`;
const rawUrl = process.env.TED_CATEGORY_PG_URL;
const marker = process.env.TED_CATEGORY_PG_MARKER;
const enabled = Boolean(rawUrl && marker);
const describeDb = enabled ? describe : describe.skip;

const checkedUrl = (): string => {
  if (!rawUrl) throw new Error('DB URL ausente');
  const u = new URL(rawUrl);
  if (!ALLOWED_DBS.has(DB) || LEGACY !== `${DB}_legacy` || !['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1', 'localhost'].includes(u.hostname) || Number(u.port) < 49152 || Number(u.port) > 65535 || u.pathname !== `/${DB}` || /[?#]/.test(rawUrl)) throw new Error('DB de teste fora do allowlist');
  return rawUrl;
};
const legacyUrl = (url: string) => { const u = new URL(url); u.pathname = `/${LEGACY}`; return u.toString(); };

describeDb('keyed category deactivate PG descartável — canonical + legacy', () => {
  let canonical: Pool;
  let legacy: Pool;
  beforeAll(async () => {
    const previous = process.env.DB_TEST_MARKER;
    process.env.DB_TEST_MARKER = marker!;
    canonical = createPool({ connectionString: checkedUrl(), max: 10 }) as unknown as Pool;
    legacy = createPool({ connectionString: legacyUrl(checkedUrl()), max: 10 }) as unknown as Pool;
    await requireTestDatabase(canonical as never, 'category-deactivate-canonical');
    await requireTestDatabase(legacy as never, 'category-deactivate-legacy');
    expect((await canonical.query('SELECT current_database()')).rows[0].current_database).toBe(DB);
    expect((await legacy.query('SELECT current_database()')).rows[0].current_database).toBe(LEGACY);
    await runMigrations(canonical as never);
    await runMigrations(legacy as never);
    for (const sql of [
      'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT',
      'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN',
      'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE',
      'ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL',
      'ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL',
      'ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL',
      'ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN',
      'ALTER TABLE categories ALTER COLUMN status DROP NOT NULL',
    ]) await legacy.query(sql);
    process.env.DB_TEST_MARKER = previous;
  }, 240_000);
  afterAll(async () => { await canonical?.end(); await legacy?.end(); });

  for (const [label, getPool, store] of [
    ['canonical', () => canonical, (p: Pool) => createPostgresWriteStore({ pool: p })],
    ['legacy', () => legacy, (p: Pool) => createLegacyPostgresWriteStore({ pool: p })],
  ] as const) {
    it(`${label}: CAS, transactional keyed replay and same-key concurrency`, async () => {
      const writes = store(getPool());
      const household = randomUUID();
      const category = await writes.createCategory(household, { name: 'Unused', kind: 'expense' });
      await expect(writes.deactivateCategory(household, category.id, { idempotencyKey: randomUUID(), expectedName: 'Stale' })).rejects.toMatchObject({ code: 'category.name_conflict' });
      const key = randomUUID();
      const [first, concurrent] = await Promise.all([
        writes.deactivateCategory(household, category.id, { idempotencyKey: key, expectedName: 'Unused' }),
        writes.deactivateCategory(household, category.id, { idempotencyKey: key, expectedName: 'Unused' }),
      ]);
      expect(first).toMatchObject({ id: category.id, status: 'inactive' });
      expect(concurrent).toEqual(first);
      await expect(writes.deactivateCategory(household, category.id, { idempotencyKey: key, expectedName: 'Other' })).rejects.toMatchObject({ code: 'idempotency.conflict' });
    });

    it(`${label}: persistent references block without changing category`, async () => {
      const p = getPool();
      const writes = store(p);
      const household = randomUUID();
      const category = await writes.createCategory(household, { name: 'Referenced', kind: 'expense' });
      const account = await writes.createAccount(household, { name: 'Fixture account', kind: 'cash', initialBalanceCents: 0 });
      await p.query(`INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id) VALUES ($1,$2,'expense','ref',100,'2026-10-22',$3,$4)`, [randomUUID(), household, account.id, category.id]);
      await expect(writes.deactivateCategory(household, category.id, { idempotencyKey: randomUUID(), expectedName: category.name })).rejects.toMatchObject({ code: 'in_use' });
      const current = await p.query('SELECT status, deleted_at FROM categories WHERE id=$1', [category.id]);
      expect(current.rows[0].deleted_at).toBeNull();
    });

    if (label === 'canonical') {
      it('canonical: tombstoned target is not mutated and does not claim the idempotency key', async () => {
        const p = getPool();
        const writes = store(p);
        const household = randomUUID();
        const category = await writes.createCategory(household, { name: 'Tombstoned', kind: 'expense' });
        await p.query(`UPDATE categories SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`, [category.id, household]);
        const before = (await p.query(`SELECT status, deleted_at FROM categories WHERE id = $1`, [category.id])).rows[0];
        const key = randomUUID();

        // A soft-deleted row must be reported as not_found even when the
        // caller's expectedName diverges: the fail-fast snapshot may not
        // surface a rename conflict for a target that no longer exists.
        await expect(writes.deactivateCategory(household, category.id, { idempotencyKey: randomUUID(), expectedName: 'Stale' })).rejects.toMatchObject({ code: 'not_found' });

        await expect(writes.deactivateCategory(household, category.id, { idempotencyKey: key, expectedName: category.name })).rejects.toMatchObject({ code: 'not_found' });

        const after = (await p.query(`SELECT status, deleted_at FROM categories WHERE id = $1`, [category.id])).rows[0];
        expect(after).toEqual(before);
        const recorded = await p.query(`SELECT 1 FROM idempotency_keys WHERE household_id = $1 AND key = $2`, [household, `pending-v2:${key}`]);
        expect(recorded.rowCount).toBe(0);
      });

      it('canonical: completed keyed replay survives a later tombstone unchanged', async () => {
        const p = getPool();
        const writes = store(p);
        const household = randomUUID();
        const category = await writes.createCategory(household, { name: 'Replay then tombstone', kind: 'expense' });
        const key = randomUUID();
        const first = await writes.deactivateCategory(household, category.id, { idempotencyKey: key, expectedName: category.name });
        await p.query(`UPDATE categories SET deleted_at = NOW() WHERE id = $1 AND household_id = $2`, [category.id, household]);
        await expect(writes.deactivateCategory(household, category.id, { idempotencyKey: key, expectedName: category.name })).resolves.toEqual(first);
      });
    }
  }
});
