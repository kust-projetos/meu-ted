/**
 * V4.1 Phase 3 Tasks 3.2–3.7 — Postgres proofs (gated).
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER + requireTestDatabase (fail-closed
 * marker check before any DDL/DML), same pattern as
 * tests/integration/postgres-goals-transactions-v41.test.ts. Skips cleanly
 * otherwise. Rows isolated by unique household UUIDs; every row cleaned up.
 *
 * - 3.2/3.3: N concurrent same-key claims → 1 financial effect (single tx:
 *   claim + effect + completion commit together on the claim client).
 * - 3.4: crash between claim → effect → completion rolls everything back;
 *   retry with the same key converges to exactly 1 effect.
 * - 3.6: new claims record V2 hashes.
 * - 3.7: fixture rows with v1/legacy hashes still replay the original receipt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresIdempotencyStore } from '../../src/writes/postgres.js';
import { runTransactionMutation } from '../../src/writes/keyed-mutations.js';
import { hashPayloadV2, hashIdempotencyPayload } from '../../src/writes/idempotency.js';
import { runKeyedMutation } from '../../src/writes/pending-idempotency.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[keyed-mutations-postgres] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — Postgres proofs skipped.',
  );
}

const legacyH32 = (payload: unknown): string => {
  const json = typeof payload === 'object' && payload !== null
    ? JSON.stringify(payload, Object.keys(payload as object).sort())
    : JSON.stringify(payload);
  let h = 0;
  for (let i = 0; i < json.length; i++) h = (h * 31 + json.charCodeAt(i)) | 0;
  return String(h);
};

describeIfDb('V4.1 Phase 3 — Postgres single-tx keyed mutations', () => {
  let pool: Pool;
  const households: string[] = [];

  const track = (h: string): string => {
    households.push(h);
    return h;
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'keyed-mutations-postgres');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool.query(
        'DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))',
        [households],
      );
      await pool.query('DELETE FROM operation_records WHERE workspace_id = ANY($1)', [households]);
      await pool.query('DELETE FROM idempotency_keys WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM transactions WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM categories WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM accounts WHERE household_id = ANY($1)', [households]);
    }
    await pool?.end();
  });

  const seedAccountAndCategory = async (household: string) => {
    const writes = createPostgresWriteStore({ pool });
    const acc = await writes.createAccount(household, { name: 'PG A', kind: 'bank', initialBalanceCents: 100_000 });
    const cat = await writes.createCategory(household, { name: 'PG Food', kind: 'expense' });
    return { acc, cat };
  };

  it('N concurrent same-key claims commit exactly 1 effect; N different keys commit N', async () => {
    const household = track(randomUUID());
    const { acc, cat } = await seedAccountAndCategory(household);
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { description: 'PG race', amountCents: 1200, date: '2026-06-10', accountId: acc.id, categoryId: cat.id };

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        idempotency.lookupOrRecord(household, 'pg-race-same', payload, (claimTx) =>
          runTransactionMutation(writes, claimTx, household, 'expense', payload),
        ),
      ),
    );
    const ids = new Set(results.map((r) => (r.response as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    // Seed creates no transactions; the race must leave exactly one.
    expect(count.rows[0]!.n).toBe(1);

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        idempotency.lookupOrRecord(household, `pg-race-diff-${i}`, { ...payload, description: `PG diff ${i}` }, (claimTx) =>
          runTransactionMutation(writes, claimTx, household, 'expense', { ...payload, description: `PG diff ${i}` }),
        ),
      ),
    );
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(after.rows[0]!.n).toBe(5);
  }, 60_000);

  it('failure injection: crash after partial work rolls back; retry converges to 1 effect', async () => {
    const household = track(randomUUID());
    const { acc, cat } = await seedAccountAndCategory(household);
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { description: 'PG crash', amountCents: 700, date: '2026-06-10', accountId: acc.id, categoryId: cat.id };

    let attempts = 0;
    const crashingProducer = async (claimTx: unknown) => {
      attempts += 1;
      const tx = await runTransactionMutation(writes, claimTx, household, 'expense', payload);
      if (attempts === 1) {
        // Simulate a crash AFTER the financial write but BEFORE completion:
        // a deliberate constraint violation aborts the whole claim tx.
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO transactions (id) VALUES (NULL)',
        );
      }
      return tx;
    };
    await expect(idempotency.lookupOrRecord(household, 'pg-crash-1', payload, crashingProducer)).rejects.toThrow();

    const orphaned = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(orphaned.rows[0]!.n).toBe(0);

    const retry = await idempotency.lookupOrRecord(household, 'pg-crash-1', payload, (claimTx) =>
      runTransactionMutation(writes, claimTx, household, 'expense', payload),
    );
    expect(retry.replayed).toBe(false);
    const final = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(final.rows[0]!.n).toBe(1);

    const replay = await idempotency.lookupOrRecord(household, 'pg-crash-1', payload, (claimTx) =>
      runTransactionMutation(writes, claimTx, household, 'expense', payload),
    );
    expect(replay.replayed).toBe(true);
    expect((replay.response as { id: string }).id).toBe((retry.response as { id: string }).id);
  }, 60_000);

  it('new claims record V2 hashes (Task 3.6)', async () => {
    const household = track(randomUUID());
    const { acc, cat } = await seedAccountAndCategory(household);
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { description: 'PG v2', amountCents: 300, date: '2026-06-10', accountId: acc.id, categoryId: cat.id };
    await idempotency.lookupOrRecord(household, 'pg-v2-1', payload, (claimTx) =>
      runTransactionMutation(writes, claimTx, household, 'expense', payload),
    );
    const row = await pool.query('SELECT payload_hash FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2', [household, 'pg-v2-1']);
    expect(row.rows[0]!.payload_hash).toBe(hashPayloadV2(payload));
  }, 60_000);

  it('replays fixture claims stored with v1/legacy hashes and returns the original receipt (Task 3.7)', async () => {
    const household = track(randomUUID());
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { description: 'PG old', amountCents: 400 };

    // Legacy 32-bit hash fixture in operation_records.
    const legacyResponse = { status: 201, body: { id: 'old-tx-1', kind: 'expense' } };
    await pool.query(
      `INSERT INTO operation_records
         (workspace_id, actor_id, operation, idempotency_key, payload_hash, status, response,
          lease_until, retry_until, retention_until, completed_at)
       VALUES ($1, 'device', 'write', 'pg-old-h32', $2, 'completed', $3,
               NOW() + INTERVAL '5 minutes', NOW() + INTERVAL '7 days', NOW() + INTERVAL '90 days', NOW())`,
      [household, legacyH32(payload), JSON.stringify(legacyResponse)],
    );
    const replayH32 = await idempotency.lookupOrRecord(household, 'pg-old-h32', payload, async () => {
      throw new Error('producer must not run on replay');
    });
    expect(replayH32.replayed).toBe(true);
    expect(replayH32.response).toEqual(legacyResponse);

    // v1-sha256 hash fixture in operation_records.
    await pool.query(
      `INSERT INTO operation_records
         (workspace_id, actor_id, operation, idempotency_key, payload_hash, status, response,
          lease_until, retry_until, retention_until, completed_at)
       VALUES ($1, 'device', 'write', 'pg-old-v1', $2, 'completed', $3,
               NOW() + INTERVAL '5 minutes', NOW() + INTERVAL '7 days', NOW() + INTERVAL '90 days', NOW())`,
      [household, hashIdempotencyPayload(payload), JSON.stringify(legacyResponse)],
    );
    const replayV1 = await idempotency.lookupOrRecord(household, 'pg-old-v1', payload, async () => {
      throw new Error('producer must not run on replay');
    });
    expect(replayV1.replayed).toBe(true);
    expect(replayV1.response).toEqual(legacyResponse);

    // Neither hash matches → conflict, never silent reuse.
    await expect(
      idempotency.lookupOrRecord(household, 'pg-old-v1', { ...payload, amountCents: 999 }, async () => ({}) as never),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });

    // v1-sha256 fixture in idempotency_keys (pending-V2 store) replays too.
    const keyedPayload = { description: 'PG keyed old', amountCents: 50 };
    const legacyKeyedTransaction = {
      id: '00000000-0000-4000-8000-000000000010',
      householdId: household,
      kind: 'expense' as const,
      description: 'PG keyed old',
      amountCents: 50,
      date: '2026-10-20',
      accountId: '00000000-0000-4000-8000-000000000011',
      categoryId: '00000000-0000-4000-8000-000000000012',
      notes: 'legacy replay snapshot',
    };
    await pool.query(
      'INSERT INTO idempotency_keys (household_id, key, payload_hash, response) VALUES ($1, $2, $3, $4)',
      [household, 'pending-v2:pg-keyed-old', hashIdempotencyPayload(keyedPayload), JSON.stringify({ transaction: legacyKeyedTransaction })],
    );
    const keyed = await runKeyedMutation({
      pool,
      householdId: household,
      idempotencyKey: 'pg-keyed-old',
      payload: keyedPayload,
      mutate: async () => {
        throw new Error('mutate must not run on replay');
      },
    });
    expect(keyed).toEqual(legacyKeyedTransaction);
  }, 60_000);

  it('rejects a malformed keyed transaction snapshot without effect or audit', async () => {
    const household = track(randomUUID());
    const key = 'pg-keyed-malformed-snapshot';
    const payload = { tool: 'transactions.description.update', args: { transactionId: randomUUID(), description: 'new', expectedDescription: 'old' } };
    const malformed = {
      id: '00000000-0000-4000-8000-000000000020',
      householdId: household,
      kind: 'expense',
      description: 'old',
      amountCents: 50,
      date: '2026-10-20',
      // accountId intentionally absent: not a valid transaction DTO.
    };
    await pool.query(
      'INSERT INTO idempotency_keys (household_id, key, payload_hash, response) VALUES ($1, $2, $3, $4)',
      [household, `pending-v2:${key}`, hashIdempotencyPayload(payload), JSON.stringify({ transaction: malformed })],
    );
    let mutations = 0;
    await expect(runKeyedMutation({
      pool,
      householdId: household,
      idempotencyKey: key,
      payload,
      audit: {
        operation: 'transaction.update', actorId: 'test-server-actor', schema: 'canonical',
        idempotencyKey: key, beforeDescription: 'old', afterDescription: 'new',
      },
      mutate: async () => {
        mutations += 1;
        throw new Error('malformed snapshot must not invoke mutation');
      },
    })).rejects.toMatchObject({ code: 'idempotency.conflict', statusCode: 409 });
    expect(mutations).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id=$1', [household])).rows[0]!.n).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id=$1', [household])).rows[0]!.n).toBe(0);
  }, 60_000);

  it('Phase 4 (V2 fail-closed by construction): mutate throw rolls back claim + effect together', async () => {
    const household = track(randomUUID());
    const { acc, cat } = await seedAccountAndCategory(household);
    const payload = { description: 'PG v2 atomic', amountCents: 800, date: '2026-06-10', accountId: acc.id, categoryId: cat.id };
    await expect(
      runKeyedMutation({
        pool,
        householdId: household,
        idempotencyKey: 'pg-v2-atomic-1',
        payload,
        mutate: async (client) => {
          await client.query(
            `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id)
             VALUES (gen_random_uuid(), $1, 'expense', $2, $3, $4, $5, $6)`,
            [household, 'PG v2 atomic', 800, '2026-06-10', acc.id, cat.id],
          );
          throw new Error('simulated crash after the effect, before completion');
        },
      }),
    ).rejects.toThrow('simulated crash');
    // Claim + effect + completion are one tx: nothing survived.
    const txCount = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(txCount.rows[0]!.n).toBe(0);
    const retry = await runKeyedMutation({
      pool,
      householdId: household,
      idempotencyKey: 'pg-v2-atomic-1',
      payload,
      mutate: async (client) => {
        const res = await client.query(
          `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, category_id)
           VALUES (gen_random_uuid(), $1, 'expense', $2, $3, $4, $5, $6)
           RETURNING id`,
          [household, 'PG v2 atomic', 800, '2026-06-10', acc.id, cat.id],
        );
        return { id: res.rows[0]!.id } as never;
      },
    });
    expect(retry.id).toBeDefined();
    const final = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(final.rows[0]!.n).toBe(1);
  }, 60_000);
});
