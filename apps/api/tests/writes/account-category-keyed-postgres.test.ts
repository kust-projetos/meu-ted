/**
 * T05 — Single-TX for accounts and categories (RED first).
 *
 * PG proof on a dedicated pool with Explicit max:4. Store-level: the route
 * producer shape threads the open claim client into the effect via
 * runAccountMutation / runCategoryMutation, so claim + effect + completion +
 * audit commit together and any failure rolls everything back.
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER + requireTestDatabase
 * (fail-closed marker check before any DDL/DML). Skips cleanly otherwise.
 * Rows isolated by unique household UUIDs; every row cleaned up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore, createPostgresIdempotencyStore } from '../../src/writes/postgres.js';
import { runAccountMutation, runCategoryMutation } from '../../src/writes/keyed-mutations.js';
import { hashPayloadV2 } from '../../src/writes/idempotency.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[account-category-keyed-postgres] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — Postgres proofs skipped.',
  );
}

/** Deterministic start gate: N tasks rendezvous, then fire at once. No sleeps. */
const makeStartGate = (n: number) => {
  let arrived = 0;
  let release!: () => void;
  let allArrived!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const arrivedP = new Promise<void>((r) => { allArrived = r; });
  return {
    arrived: arrivedP,
    go() { release(); },
    async enter() {
      arrived += 1;
      if (arrived === n) allArrived();
      await released;
    },
  };
};

describeIfDb('T05 — accounts/categories single-tx keyed mutations (pool max:4)', () => {
  let pool: Pool;
  const households: string[] = [];
  const track = (h: string): string => {
    households.push(h);
    return h;
  };

  beforeAll(async () => {
    // Pool Explicitly max:4 per plan §255 (the default suite keeps pool 8).
    pool = createPool({ connectionString: DB_URL!, max: 4 });
    await requireTestDatabase(pool, 'account-category-keyed-postgres');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool.query(
        'DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))',
        [households],
      ).catch(() => undefined);
      await pool.query('DELETE FROM operation_records WHERE workspace_id = ANY($1)', [households]);
      await pool.query('DELETE FROM idempotency_keys WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM transactions WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM categories WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM accounts WHERE household_id = ANY($1)', [households]);
    }
    await pool?.end();
  });

  it('PATCH /accounts/:id: 4 concurrent same-key claims (start-gated) commit exactly 1 effect', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const acc = await writes.createAccount(household, { name: 'T05 Base', kind: 'bank', initialBalanceCents: 10_000 });
    const payload = { id: acc.id, name: 'T05 Raced' };
    const gate = makeStartGate(4);

    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't05-acct-patch-same', payload, (claimTx) =>
        runAccountMutation(writes, claimTx, household, 'update', { id: acc.id, patch: { name: 'T05 Raced' } }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);

    const bodies = results.map((r) => r.response);
    // jsonb normalizes recorded key order — compare semantically.
    for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);
    expect((results[0]!.response as { name: string }).name).toBe('T05 Raced');
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM accounts WHERE household_id = $1', [household]);
    expect(count.rows[0]!.n).toBe(1);
    const claims = await pool.query(
      `SELECT status FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2`,
      [household, 't05-acct-patch-same'],
    );
    expect(claims.rows[0]!.status).toBe('completed');
  }, 60_000);

  it('PATCH /accounts/:id: failure between effect and receipt rolls back; retry converges to 1 effect', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const acc = await writes.createAccount(household, { name: 'T05 Crash', kind: 'bank', initialBalanceCents: 10_000 });
    const payload = { id: acc.id, name: 'T05 Crashed' };

    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runAccountMutation(writes, claimTx, household, 'update', { id: acc.id, patch: { name: 'T05 Crashed' } });
      if (attempts === 1) {
        // Crash AFTER the financial write but BEFORE completion.
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO accounts (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 't05-acct-patch-crash', payload, crashing)).rejects.toThrow();
    // Claim + effect + completion are one tx: nothing survived.
    const orphan = await pool.query('SELECT name FROM accounts WHERE id = $1', [acc.id]);
    expect(orphan.rows[0]!.name).toBe('T05 Crash');

    const retry = await idempotency.lookupOrRecord(household, 't05-acct-patch-crash', payload, (claimTx) =>
      runAccountMutation(writes, claimTx, household, 'update', { id: acc.id, patch: { name: 'T05 Crashed' } }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { name: string }).name).toBe('T05 Crashed');

    const replay = await idempotency.lookupOrRecord(household, 't05-acct-patch-crash', payload, (claimTx) =>
      runAccountMutation(writes, claimTx, household, 'update', { id: acc.id, patch: { name: 'T05 Crashed' } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(retry.response);
  }, 60_000);

  it('PATCH /accounts/:id: same key + divergent payload conflicts without a second effect', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const acc = await writes.createAccount(household, { name: 'T05 Div', kind: 'bank', initialBalanceCents: 10_000 });
    const first = await idempotency.lookupOrRecord(household, 't05-acct-patch-div', { id: acc.id, name: 'T05 One' }, (claimTx) =>
      runAccountMutation(writes, claimTx, household, 'update', { id: acc.id, patch: { name: 'T05 One' } }),
    );
    expect((first.response as { name: string }).name).toBe('T05 One');
    await expect(
      idempotency.lookupOrRecord(household, 't05-acct-patch-div', { id: acc.id, name: 'T05 Two' }, (claimTx) =>
        runAccountMutation(writes, claimTx, household, 'update', { id: acc.id, patch: { name: 'T05 Two' } }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
    const row = await pool.query('SELECT name FROM accounts WHERE id = $1', [acc.id]);
    expect(row.rows[0]!.name).toBe('T05 One');
  }, 60_000);

  it('accounts create/deactivate: same-key race commits 1 row; replay after terminal returns the original', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { name: 'T05 Created', kind: 'bank', initialBalanceCents: 5_000 };
    const gate = makeStartGate(4);
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't05-acct-create-same', payload, (claimTx) =>
        runAccountMutation(writes, claimTx, household, 'create', { name: 'T05 Created', kind: 'bank', initialBalanceCents: 5_000 }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);
    const ids = new Set(results.map((r) => (r.response as { id: string }).id));
    expect(ids.size).toBe(1);

    const createdId = (results[0]!.response as { id: string }).id;
    const deactPayload = { id: createdId };
    const first = await idempotency.lookupOrRecord(household, 't05-acct-deact', deactPayload, (claimTx) =>
      runAccountMutation(writes, claimTx, household, 'deactivate', { id: createdId }),
    );
    expect((first.response as { status: string }).status).toBe('inactive');
    const second = await idempotency.lookupOrRecord(household, 't05-acct-deact', deactPayload, (claimTx) =>
      runAccountMutation(writes, claimTx, household, 'deactivate', { id: createdId }),
    );
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual(first.response);
  }, 60_000);

  it('categories create/update/deactivate: race → 1 row; replay + conflict behave', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { name: 'T05 Food', kind: 'expense' };
    const gate = makeStartGate(4);
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't05-cat-create-same', payload, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'create', { name: 'T05 Food', kind: 'expense' }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);
    expect(new Set(results.map((r) => (r.response as { id: string }).id)).size).toBe(1);

    const catId = (results[0]!.response as { id: string }).id;
    const upd = await idempotency.lookupOrRecord(household, 't05-cat-upd', { id: catId, name: 'T05 Meals' }, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'update', { id: catId, patch: { name: 'T05 Meals' } }),
    );
    expect((upd.response as { name: string }).name).toBe('T05 Meals');
    await expect(
      idempotency.lookupOrRecord(household, 't05-cat-upd', { id: catId, name: 'T05 Other' }, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'update', { id: catId, patch: { name: 'T05 Other' } }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });

    const deact = await idempotency.lookupOrRecord(household, 't05-cat-deact', { id: catId }, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'deactivate', { id: catId }),
    );
    expect((deact.response as { status: string }).status).toBe('inactive');
    const deactReplay = await idempotency.lookupOrRecord(household, 't05-cat-deact', { id: catId }, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'deactivate', { id: catId }),
    );
    expect(deactReplay.replayed).toBe(true);
    expect(deactReplay.response).toEqual(deact.response);
  }, 60_000);

  it('workspace isolation + persisted record/hash compatibility', async () => {
    const ha = track(randomUUID());
    const hb = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const accA = await writes.createAccount(ha, { name: 'T05 Iso', kind: 'bank', initialBalanceCents: 1_000 });
    const accB = await writes.createAccount(hb, { name: 'T05 Iso', kind: 'bank', initialBalanceCents: 1_000 });
    const payloadFor = (id: string) => ({ id, name: 'T05 Iso Renamed' });

    const ra = await idempotency.lookupOrRecord(ha, 't05-shared-key', payloadFor(accA.id), (claimTx) =>
      runAccountMutation(writes, claimTx, ha, 'update', { id: accA.id, patch: { name: 'T05 Iso Renamed' } }),
    );
    const rb = await idempotency.lookupOrRecord(hb, 't05-shared-key', payloadFor(accB.id), (claimTx) =>
      runAccountMutation(writes, claimTx, hb, 'update', { id: accB.id, patch: { name: 'T05 Iso Renamed' } }),
    );
    // Same raw key, different workspaces → independent effects, distinct ids.
    expect((ra.response as { id: string }).id).not.toBe((rb.response as { id: string }).id);
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);

    // Persisted record keeps the V2 hash of the recorded payload.
    const row = await pool.query(
      `SELECT payload_hash, status FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2`,
      [ha, 't05-shared-key'],
    );
    expect(row.rows[0]!.status).toBe('completed');
    expect(row.rows[0]!.payload_hash).toBe(hashPayloadV2(payloadFor(accA.id)));

    // Different valid keys never remain stuck: every claim completed.
    const stuck = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operation_records WHERE workspace_id = ANY($1) AND status <> 'completed'`,
      [[ha, hb]],
    );
    expect(stuck.rows[0]!.n).toBe(0);
  }, 60_000);
});
