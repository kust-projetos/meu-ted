/**
 * T06 — Close seven mutations without an idempotent store (RED first).
 *
 * PG proof on a dedicated pool with Explicit max:4. Store-level: the route
 * producer shape threads the open claim client into the effect via the
 * domain dispatchers, so claim + effect + completion commit together and any
 * failure rolls everything back.
 *
 * Closed list:
 * - POST /categories/apply-defaults
 * - POST /categories/:id/delete
 * - POST /payables/:id/unpay
 * - POST /payables/:id/cancel
 * - POST /goals/:id/cancel
 * - POST /subscriptions/:id/cancel
 * - PATCH /subscriptions/:id
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
import { runCategoryMutation } from '../../src/writes/keyed-mutations.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { runPayableMutation } from '../../src/payables/keyed-mutations.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';
import { runGoalMutation } from '../../src/goals/keyed-mutations.js';
import { createPostgresSubscriptionStore } from '../../src/subscriptions/postgres.js';
import { runSubscriptionMutation } from '../../src/subscriptions/keyed-mutations.js';
import { hashPayloadV2, httpIdempotencyPayload } from '../../src/writes/idempotency.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[seven-mutations-keyed-postgres] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — Postgres proofs skipped.',
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

describeIfDb('T06 — seven keyed mutations, single-tx (pool max:4)', () => {
  let pool: Pool;
  const households: string[] = [];
  const owners: string[] = [];
  const track = (h: string): string => {
    households.push(h);
    return h;
  };
  // R3 lifecycle fixtures: households rows need a users row for
  // households_shared_owner_chk (shared kind requires owner_user_id), and
  // V062 requires archived_at alongside archived.
  const trackHouseholdRow = async (status: 'active' | 'archived' | 'deleted', name: string): Promise<string> => {
    const household = track(randomUUID());
    const ownerId = randomUUID();
    owners.push(ownerId);
    await pool.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'R3 Owner', 'active')`, [
      ownerId,
      `r3-${household}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO households (id, name, kind, status, archived_at, owner_user_id) VALUES ($1, $2, 'shared', $3, CASE WHEN $3 = 'archived' THEN NOW() ELSE NULL END, $4)`,
      [household, name, status, ownerId],
    );
    return household;
  };

  beforeAll(async () => {
    // Pool Explicitly max:4 per plan §255.
    pool = createPool({ connectionString: DB_URL!, max: 4 });
    await requireTestDatabase(pool, 'seven-mutations-keyed-postgres');
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
      await pool.query('DELETE FROM accounts_payable WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM payable_templates WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM transactions WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = ANY($1))', [households]);
      await pool.query('DELETE FROM goals WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM subscriptions WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM categories WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM accounts WHERE household_id = ANY($1)', [households]);
      // R3: lifecycle fixtures own their households rows (archived/deleted).
      await pool.query('DELETE FROM households WHERE id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [owners]).catch(() => undefined);
    }
    await pool?.end();
  });

  const seedBank = async (household: string) => {
    const writes = createPostgresWriteStore({ pool });
    return writes.createAccount(household, { name: 'T06 Bank', kind: 'bank', initialBalanceCents: 500_000 });
  };

  it('payables unpay: 4 concurrent same-key claims reverse the payment exactly once', async () => {
    const household = track(randomUUID());
    const acc = await seedBank(household);
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'T06 energy', amountCents: 2500, dueDate: '2026-08-10',
    });
    const paid = await payables.markPayablePaid(household, payable.id, {});
    const payload = { id: payable.id, expectedPaidTransactionId: paid.paidTransactionId };
    const gate = makeStartGate(4);

    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't06-unpay-same', payload, (claimTx) =>
        runPayableMutation(payables, claimTx, household, 'unpay', { id: payable.id, opts: { expectedPaidTransactionId: paid.paidTransactionId! } }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);

    const bodies = results.map((r) => r.response);
    // jsonb normalizes recorded key order — compare semantically.
    for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
    // Exactly one reversal: the linked expense is tombstoned once.
    const liveTx = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [household, paid.paidTransactionId],
    );
    expect(liveTx.rows[0]!.n).toBe(0);
    const status = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(status.rows[0]!.status).not.toBe('paid');
    // Same-key sequential replay returns the same response even though the
    // state is already terminal (no new status code, no second reversal).
    const replay = await idempotency.lookupOrRecord(household, 't06-unpay-same', payload, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'unpay', { id: payable.id, opts: { expectedPaidTransactionId: paid.paidTransactionId! } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(results[0]!.response);
    // A different key re-executes against terminal state → existing 409 semantics.
    await expect(
      idempotency.lookupOrRecord(household, 't06-unpay-other-key', payload, (claimTx) =>
        runPayableMutation(payables, claimTx, household, 'unpay', { id: payable.id, opts: { expectedPaidTransactionId: paid.paidTransactionId! } }),
      ),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
  }, 60_000);

  it('payables unpay: crash between effect and receipt rolls back; retry converges with no duplicated reversal', async () => {
    const household = track(randomUUID());
    const acc = await seedBank(household);
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'T06 crash', amountCents: 1200, dueDate: '2026-08-10',
    });
    const paid = await payables.markPayablePaid(household, payable.id, {});
    const payload = { id: payable.id, expectedPaidTransactionId: paid.paidTransactionId };

    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runPayableMutation(payables, claimTx, household, 'unpay', { id: payable.id, opts: { expectedPaidTransactionId: paid.paidTransactionId! } });
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO accounts_payable (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 't06-unpay-crash', payload, crashing)).rejects.toThrow();
    // Nothing survived: still paid, linked expense still live.
    const still = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(still.rows[0]!.status).toBe('paid');
    const live = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [household, paid.paidTransactionId],
    );
    expect(live.rows[0]!.n).toBe(1);

    const retry = await idempotency.lookupOrRecord(household, 't06-unpay-crash', payload, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'unpay', { id: payable.id, opts: { expectedPaidTransactionId: paid.paidTransactionId! } }),
    );
    expect(retry.replayed).toBe(false);
    const after = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(after.rows[0]!.status).not.toBe('paid');
  }, 60_000);

  it('payables cancel + goals cancel: keyed race → 1 effect; replay after terminal returns the original', async () => {
    const household = track(randomUUID());
    const acc = await seedBank(household);
    const payables = createPostgresPayableStore(pool);
    const goals = createPostgresGoalStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });

    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'T06 cancel', amountCents: 900, dueDate: '2026-09-10',
    });
    const gate = makeStartGate(4);
    const cancelPayload = { id: payable.id };
    const cancelTasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't06-paycancel-same', cancelPayload, (claimTx) =>
        runPayableMutation(payables, claimTx, household, 'cancel', { id: payable.id }),
      );
    })());
    await gate.arrived;
    gate.go();
    const cancelled = await Promise.all(cancelTasks);
    // jsonb normalizes recorded key order — compare semantically.
    for (const c of cancelled.slice(1)) expect(c.response).toEqual(cancelled[0]!.response);
    expect((cancelled[0]!.response as { status: string }).status).toBe('cancelled');

    const goal = await goals.createGoal(household, {
      name: 'T06 trip', goalType: 'savings', targetAmountCents: 50_000, startDate: '2026-01-01',
    });
    const goalPayload = { id: goal.id };
    const first = await idempotency.lookupOrRecord(household, 't06-goalcancel', goalPayload, (claimTx) =>
      runGoalMutation(goals, claimTx, household, 'cancel', { id: goal.id }),
    );
    expect((first.response as { status: string }).status).toBe('cancelled');
    const second = await idempotency.lookupOrRecord(household, 't06-goalcancel', goalPayload, (claimTx) =>
      runGoalMutation(goals, claimTx, household, 'cancel', { id: goal.id }),
    );
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual(first.response);
    await expect(
      idempotency.lookupOrRecord(household, 't06-goalcancel', { id: goal.id, reason: 'other' }, (claimTx) =>
        runGoalMutation(goals, claimTx, household, 'cancel', { id: goal.id }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  }, 60_000);

  it('subscriptions cancel + update: keyed race → 1 effect; replay + conflict behave', async () => {
    const household = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sub = await subs.createSubscription(household, {
      name: 'T06 Stream', amountCents: 4990, cycle: 'monthly', day: 5, paymentMethod: 'card',
    });
    const gate = makeStartGate(4);
    const cancelPayload = { id: sub.id };
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't06-subcancel-same', cancelPayload, (claimTx) =>
        runSubscriptionMutation(subs, claimTx, household, 'cancel', { id: sub.id }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);
    // jsonb normalizes recorded key order — compare semantically.
    for (const r of results.slice(1)) expect(r.response).toEqual(results[0]!.response);
    expect((results[0]!.response as { status: string }).status).toBe('cancelled');

    const sub2 = await subs.createSubscription(household, {
      name: 'T06 Music', amountCents: 1990, cycle: 'monthly', day: 7, paymentMethod: 'card',
    });
    const updPayload = { id: sub2.id, name: 'T06 Music Plus' };
    const first = await idempotency.lookupOrRecord(household, 't06-subupd', updPayload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub2.id, patch: { name: 'T06 Music Plus' } }),
    );
    expect((first.response as { name: string }).name).toBe('T06 Music Plus');
    const replay = await idempotency.lookupOrRecord(household, 't06-subupd', updPayload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub2.id, patch: { name: 'T06 Music Plus' } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    await expect(
      idempotency.lookupOrRecord(household, 't06-subupd', { id: sub2.id, name: 'T06 Other' }, (claimTx) =>
        runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub2.id, patch: { name: 'T06 Other' } }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  }, 60_000);

  it('categories apply-defaults + delete: keyed race converges; replay returns the original receipt', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const gate = makeStartGate(4);
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 't06-apply-defaults', {}, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'applyDefaults', {}),
      );
    })());
    await gate.arrived;
    gate.go();
    const applied = await Promise.all(tasks);
    // All four see the same recorded receipt (winner's counts); jsonb
    // normalizes recorded key order — compare semantically.
    for (const a of applied.slice(1)) expect(a.response).toEqual(applied[0]!.response);
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE household_id = $1 AND deleted_at IS NULL`,
      [household],
    );
    expect(total.rows[0]!.n).toBeGreaterThan(0);

    // Delete with move: keyed race executes once; replay returns the original.
    const cat = await writes.createCategory(household, { name: 'T06 Doomed', kind: 'expense' });
    const dest = await writes.createCategory(household, { name: 'T06 Haven', kind: 'expense' });
    const delPayload = { id: cat.id, mode: 'move', destinationCategoryId: dest.id };
    const first = await idempotency.lookupOrRecord(household, 't06-catdelete', delPayload, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'delete', { id: cat.id, input: { mode: 'move', destinationCategoryId: dest.id } }),
    );
    expect((first.response as { deletedCategoryIds: string[] }).deletedCategoryIds).toContain(cat.id);
    const replay = await idempotency.lookupOrRecord(household, 't06-catdelete', delPayload, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'delete', { id: cat.id, input: { mode: 'move', destinationCategoryId: dest.id } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);

    // Persisted record keeps the V2 hash.
    const row = await pool.query(
      `SELECT payload_hash FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2`,
      [household, 't06-catdelete'],
    );
    expect(row.rows[0]!.payload_hash).toBe(hashPayloadV2(delPayload));

    // Same key in another workspace is independent.
    const other = track(randomUUID());
    const otherCat = await writes.createCategory(other, { name: 'T06 Doomed', kind: 'expense' });
    const otherDest = await writes.createCategory(other, { name: 'T06 Haven', kind: 'expense' });
    const otherRes = await idempotency.lookupOrRecord(other, 't06-catdelete', { id: otherCat.id, mode: 'move', destinationCategoryId: otherDest.id }, (claimTx) =>
      runCategoryMutation(writes, claimTx, other, 'delete', { id: otherCat.id, input: { mode: 'move', destinationCategoryId: otherDest.id } }),
    );
    expect(otherRes.replayed).toBe(false);
  }, 60_000);

  it('R2 goals cancel: 4 concurrent same-key claims cancel exactly once', async () => {
    const household = track(randomUUID());
    const goals = createPostgresGoalStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const goal = await goals.createGoal(household, {
      name: 'R2 trip', goalType: 'savings', targetAmountCents: 50_000, startDate: '2026-01-01',
    });
    const payload = { id: goal.id };
    const gate = makeStartGate(4);
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 'r2-goalcancel-same', payload, (claimTx) =>
        runGoalMutation(goals, claimTx, household, 'cancel', { id: goal.id }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);
    // jsonb normalizes recorded key order — compare semantically.
    for (const r of results.slice(1)) expect(r.response).toEqual(results[0]!.response);
    expect((results[0]!.response as { id: string }).id).toBe(goal.id);
    expect((results[0]!.response as { status: string }).status).toBe('cancelled');
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
    const row = await pool.query('SELECT status FROM goals WHERE id = $1', [goal.id]);
    expect(row.rows[0]!.status).toBe('cancelled');
  }, 60_000);

  it('R2 categories delete: 4 concurrent same-key claims execute the move once', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const cat = await writes.createCategory(household, { name: 'R2 Doomed', kind: 'expense' });
    const dest = await writes.createCategory(household, { name: 'R2 Haven', kind: 'expense' });
    const payload = { id: cat.id, mode: 'move', destinationCategoryId: dest.id };
    const gate = makeStartGate(4);
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 'r2-catdelete-same', payload, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'delete', { id: cat.id, input: { mode: 'move', destinationCategoryId: dest.id } }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);
    // jsonb normalizes recorded key order — compare semantically.
    for (const r of results.slice(1)) expect(r.response).toEqual(results[0]!.response);
    expect((results[0]!.response as { deletedCategoryIds: string[] }).deletedCategoryIds).toContain(cat.id);
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
    const row = await pool.query(`SELECT status FROM categories WHERE id = $1`, [cat.id]);
    expect(row.rows[0]!.status).toBe('inactive');
  }, 60_000);

  it('R2 subscriptions update: 4 concurrent same-key claims patch exactly once', async () => {
    const household = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sub = await subs.createSubscription(household, {
      name: 'R2 Music', amountCents: 1990, cycle: 'monthly', day: 7, paymentMethod: 'card',
    });
    const payload = { id: sub.id, name: 'R2 Music Plus' };
    const gate = makeStartGate(4);
    const tasks = Array.from({ length: 4 }, () => (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 'r2-subupd-same', payload, (claimTx) =>
        runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub.id, patch: { name: 'R2 Music Plus' } }),
      );
    })());
    await gate.arrived;
    gate.go();
    const results = await Promise.all(tasks);
    // jsonb normalizes recorded key order — compare semantically.
    for (const r of results.slice(1)) expect(r.response).toEqual(results[0]!.response);
    expect((results[0]!.response as { id: string }).id).toBe(sub.id);
    expect((results[0]!.response as { name: string }).name).toBe('R2 Music Plus');
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('R2 payables cancel: same key + divergent payload conflicts; correct payload replays', async () => {
    const household = track(randomUUID());
    const acc = await seedBank(household);
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'R2 cancel', amountCents: 900, dueDate: '2026-09-10',
    });
    const payload = { id: payable.id };
    const first = await idempotency.lookupOrRecord(household, 'r2-paycancel-conf', payload, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'cancel', { id: payable.id }),
    );
    expect((first.response as { status: string }).status).toBe('cancelled');
    // Divergent payload on the same key conflicts — never executes.
    await expect(
      idempotency.lookupOrRecord(household, 'r2-paycancel-conf', { id: payable.id, reason: 'other' }, (claimTx) =>
        runPayableMutation(payables, claimTx, household, 'cancel', { id: payable.id, reason: 'other' }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
    // Retry with the correct payload converges to the original receipt.
    const replay = await idempotency.lookupOrRecord(household, 'r2-paycancel-conf', payload, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'cancel', { id: payable.id }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
  }, 60_000);

  it('R2 subscriptions cancel: same key + divergent payload conflicts; correct payload replays', async () => {
    const household = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sub = await subs.createSubscription(household, {
      name: 'R2 Stream', amountCents: 4990, cycle: 'monthly', day: 5, paymentMethod: 'card',
    });
    const payload = { id: sub.id };
    const first = await idempotency.lookupOrRecord(household, 'r2-subcancel-conf', payload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'cancel', { id: sub.id }),
    );
    expect((first.response as { status: string }).status).toBe('cancelled');
    // Divergent payload on the same key conflicts — never executes.
    await expect(
      idempotency.lookupOrRecord(household, 'r2-subcancel-conf', { id: sub.id, note: 'other' }, (claimTx) =>
        runSubscriptionMutation(subs, claimTx, household, 'cancel', { id: sub.id }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
    // Retry with the correct payload converges to the original receipt.
    const replay = await idempotency.lookupOrRecord(household, 'r2-subcancel-conf', payload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'cancel', { id: sub.id }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
  }, 60_000);

  it('R2 payables cancel: same key in another workspace executes independently', async () => {
    const ha = track(randomUUID());
    const hb = track(randomUUID());
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const accA = await seedBank(ha);
    const accB = await seedBank(hb);
    const pa = await payables.createPayable(ha, {
      accountId: accA.id, description: 'R2 iso', amountCents: 100, dueDate: '2026-09-10',
    });
    const pb = await payables.createPayable(hb, {
      accountId: accB.id, description: 'R2 iso', amountCents: 100, dueDate: '2026-09-10',
    });
    const ra = await idempotency.lookupOrRecord(ha, 'r2-shared-key', { id: pa.id }, (claimTx) =>
      runPayableMutation(payables, claimTx, ha, 'cancel', { id: pa.id }),
    );
    const rb = await idempotency.lookupOrRecord(hb, 'r2-shared-key', { id: pb.id }, (claimTx) =>
      runPayableMutation(payables, claimTx, hb, 'cancel', { id: pb.id }),
    );
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
    expect((ra.response as { id: string }).id).not.toBe((rb.response as { id: string }).id);
    const rows = await pool.query(
      `SELECT workspace_id, status FROM operation_records WHERE idempotency_key = 'r2-shared-key' AND workspace_id = ANY($1)`,
      [[ha, hb]],
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.every((r) => r.status === 'completed')).toBe(true);
  }, 60_000);

  it('R2 goals cancel: same key in another workspace executes independently', async () => {
    const ha = track(randomUUID());
    const hb = track(randomUUID());
    const goals = createPostgresGoalStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const ga = await goals.createGoal(ha, {
      name: 'R2 iso', goalType: 'savings', targetAmountCents: 10_000, startDate: '2026-01-01',
    });
    const gb = await goals.createGoal(hb, {
      name: 'R2 iso', goalType: 'savings', targetAmountCents: 10_000, startDate: '2026-01-01',
    });
    const ra = await idempotency.lookupOrRecord(ha, 'r2-shared-key', { id: ga.id }, (claimTx) =>
      runGoalMutation(goals, claimTx, ha, 'cancel', { id: ga.id }),
    );
    const rb = await idempotency.lookupOrRecord(hb, 'r2-shared-key', { id: gb.id }, (claimTx) =>
      runGoalMutation(goals, claimTx, hb, 'cancel', { id: gb.id }),
    );
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
    expect((ra.response as { id: string }).id).not.toBe((rb.response as { id: string }).id);
    const rows = await pool.query(
      `SELECT workspace_id, status FROM operation_records WHERE idempotency_key = 'r2-shared-key' AND workspace_id = ANY($1)`,
      [[ha, hb]],
    );
    expect(rows.rowCount).toBe(2);
  }, 60_000);

  it('R2 subscriptions cancel: same key in another workspace executes independently', async () => {
    const ha = track(randomUUID());
    const hb = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sa = await subs.createSubscription(ha, {
      name: 'R2 iso', amountCents: 1000, cycle: 'monthly', day: 1, paymentMethod: 'card',
    });
    const sb = await subs.createSubscription(hb, {
      name: 'R2 iso', amountCents: 1000, cycle: 'monthly', day: 1, paymentMethod: 'card',
    });
    const ra = await idempotency.lookupOrRecord(ha, 'r2-shared-key', { id: sa.id }, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, ha, 'cancel', { id: sa.id }),
    );
    const rb = await idempotency.lookupOrRecord(hb, 'r2-shared-key', { id: sb.id }, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, hb, 'cancel', { id: sb.id }),
    );
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
    expect((ra.response as { id: string }).id).not.toBe((rb.response as { id: string }).id);
  }, 60_000);

  it('R2 subscriptions update: same key in another workspace executes independently', async () => {
    const ha = track(randomUUID());
    const hb = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sa = await subs.createSubscription(ha, {
      name: 'R2 iso', amountCents: 1000, cycle: 'monthly', day: 1, paymentMethod: 'card',
    });
    const sb = await subs.createSubscription(hb, {
      name: 'R2 iso', amountCents: 1000, cycle: 'monthly', day: 1, paymentMethod: 'card',
    });
    const ra = await idempotency.lookupOrRecord(ha, 'r2-shared-key', { id: sa.id, name: 'R2 A' }, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, ha, 'update', { id: sa.id, patch: { name: 'R2 A' } }),
    );
    const rb = await idempotency.lookupOrRecord(hb, 'r2-shared-key', { id: sb.id, name: 'R2 B' }, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, hb, 'update', { id: sb.id, patch: { name: 'R2 B' } }),
    );
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
    expect((ra.response as { name: string }).name).toBe('R2 A');
    expect((rb.response as { name: string }).name).toBe('R2 B');
  }, 60_000);

  it('R2 apply-defaults: same key in another workspace executes independently', async () => {
    const ha = track(randomUUID());
    const hb = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const ra = await idempotency.lookupOrRecord(ha, 'r2-shared-key', {}, (claimTx) =>
      runCategoryMutation(writes, claimTx, ha, 'applyDefaults', {}),
    );
    const rb = await idempotency.lookupOrRecord(hb, 'r2-shared-key', {}, (claimTx) =>
      runCategoryMutation(writes, claimTx, hb, 'applyDefaults', {}),
    );
    // Independent intentions: neither replays the other's receipt.
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
    expect(ra.response).toEqual(rb.response);
    const rows = await pool.query(
      `SELECT workspace_id, status FROM operation_records WHERE idempotency_key = 'r2-shared-key' AND workspace_id = ANY($1)`,
      [[ha, hb]],
    );
    expect(rows.rowCount).toBe(2);
  }, 60_000);

  it('R2 payables cancel: crash between effect and receipt rolls back; retry converges once', async () => {
    const household = track(randomUUID());
    const acc = await seedBank(household);
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'R2 crash', amountCents: 1200, dueDate: '2026-08-10',
    });
    const payload = { id: payable.id };
    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runPayableMutation(payables, claimTx, household, 'cancel', { id: payable.id });
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO accounts_payable (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 'r2-paycancel-crash', payload, crashing)).rejects.toThrow();
    // Claim + effect + completion are one tx: the payable is untouched.
    const still = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(still.rows[0]!.status).toBe('pending');
    const retry = await idempotency.lookupOrRecord(household, 'r2-paycancel-crash', payload, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'cancel', { id: payable.id }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { status: string }).status).toBe('cancelled');
    // Exactly one effect: a single completed claim, single terminal row.
    const claims = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operation_records WHERE workspace_id = $1 AND idempotency_key = 'r2-paycancel-crash' AND status = 'completed'`,
      [household],
    );
    expect(claims.rows[0]!.n).toBe(1);
  }, 60_000);

  it('R2 goals cancel: crash between effect and receipt rolls back; retry converges once', async () => {
    const household = track(randomUUID());
    const goals = createPostgresGoalStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const goal = await goals.createGoal(household, {
      name: 'R2 crash', goalType: 'savings', targetAmountCents: 10_000, startDate: '2026-01-01',
    });
    const payload = { id: goal.id };
    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runGoalMutation(goals, claimTx, household, 'cancel', { id: goal.id });
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO goals (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 'r2-goalcancel-crash', payload, crashing)).rejects.toThrow();
    const still = await pool.query('SELECT status FROM goals WHERE id = $1', [goal.id]);
    expect(still.rows[0]!.status).not.toBe('cancelled');
    const retry = await idempotency.lookupOrRecord(household, 'r2-goalcancel-crash', payload, (claimTx) =>
      runGoalMutation(goals, claimTx, household, 'cancel', { id: goal.id }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { status: string }).status).toBe('cancelled');
  }, 60_000);

  it('R2 subscriptions cancel: crash between effect and receipt rolls back; retry converges once', async () => {
    const household = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sub = await subs.createSubscription(household, {
      name: 'R2 crash', amountCents: 1000, cycle: 'monthly', day: 1, paymentMethod: 'card',
    });
    const payload = { id: sub.id };
    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runSubscriptionMutation(subs, claimTx, household, 'cancel', { id: sub.id });
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO subscriptions (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 'r2-subcancel-crash', payload, crashing)).rejects.toThrow();
    const still = await pool.query('SELECT status FROM subscriptions WHERE id = $1', [sub.id]);
    expect(still.rows[0]!.status).toBe('active');
    const retry = await idempotency.lookupOrRecord(household, 'r2-subcancel-crash', payload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'cancel', { id: sub.id }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { status: string }).status).toBe('cancelled');
  }, 60_000);

  it('R2 subscriptions update: crash between effect and receipt rolls back; retry converges once', async () => {
    const household = track(randomUUID());
    const subs = createPostgresSubscriptionStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const sub = await subs.createSubscription(household, {
      name: 'R2 crash', amountCents: 1000, cycle: 'monthly', day: 1, paymentMethod: 'card',
    });
    const payload = { id: sub.id, name: 'R2 crashed' };
    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub.id, patch: { name: 'R2 crashed' } });
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO subscriptions (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 'r2-subupd-crash', payload, crashing)).rejects.toThrow();
    const still = await pool.query('SELECT name FROM subscriptions WHERE id = $1', [sub.id]);
    expect(still.rows[0]!.name).toBe('R2 crash');
    const retry = await idempotency.lookupOrRecord(household, 'r2-subupd-crash', payload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub.id, patch: { name: 'R2 crashed' } }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { name: string }).name).toBe('R2 crashed');
    const replay = await idempotency.lookupOrRecord(household, 'r2-subupd-crash', payload, (claimTx) =>
      runSubscriptionMutation(subs, claimTx, household, 'update', { id: sub.id, patch: { name: 'R2 crashed' } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(retry.response);
  }, 60_000);

  it('R2 apply-defaults: crash between effect and receipt rolls back; retry converges once', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runCategoryMutation(writes, claimTx, household, 'applyDefaults', {});
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO categories (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 'r2-apply-crash', {}, crashing)).rejects.toThrow();
    // Nothing survived: no categories, no completed claim.
    const orphaned = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE household_id = $1 AND deleted_at IS NULL`,
      [household],
    );
    expect(orphaned.rows[0]!.n).toBe(0);
    const retry = await idempotency.lookupOrRecord(household, 'r2-apply-crash', {}, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'applyDefaults', {}),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { created: number }).created).toBeGreaterThan(0);
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE household_id = $1 AND deleted_at IS NULL`,
      [household],
    );
    expect(total.rows[0]!.n).toBeGreaterThan(0);
  }, 60_000);

  it('R2 categories delete: crash between effect and receipt rolls back; retry converges once', async () => {
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    const cat = await writes.createCategory(household, { name: 'R2 Doomed', kind: 'expense' });
    const dest = await writes.createCategory(household, { name: 'R2 Haven', kind: 'expense' });
    const payload = { id: cat.id, mode: 'move', destinationCategoryId: dest.id };
    let attempts = 0;
    const crashing = async (claimTx: unknown) => {
      attempts += 1;
      const out = await runCategoryMutation(writes, claimTx, household, 'delete', { id: cat.id, input: { mode: 'move', destinationCategoryId: dest.id } });
      if (attempts === 1) {
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO categories (id) VALUES (NULL)',
        );
      }
      return out;
    };
    await expect(idempotency.lookupOrRecord(household, 'r2-catdelete-crash', payload, crashing)).rejects.toThrow();
    const still = await pool.query(`SELECT status FROM categories WHERE id = $1`, [cat.id]);
    expect(still.rows[0]!.status).toBe('active');
    const retry = await idempotency.lookupOrRecord(household, 'r2-catdelete-crash', payload, (claimTx) =>
      runCategoryMutation(writes, claimTx, household, 'delete', { id: cat.id, input: { mode: 'move', destinationCategoryId: dest.id } }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { deletedCategoryIds: string[] }).deletedCategoryIds).toContain(cat.id);
  }, 60_000);

  it('R3 keyed apply-defaults against an ARCHIVED household is rejected with zero effect', async () => {
    const household = await trackHouseholdRow('archived', 'R3 frozen');
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    await expect(
      idempotency.lookupOrRecord(household, 'r3-apply-archived', {}, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'applyDefaults', {}),
      ),
    ).rejects.toMatchObject({ code: 'workspace.archived' });
    // Transaction rolled back: zero categories, NO completion row, no audit.
    const cats = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE household_id = $1 AND deleted_at IS NULL`,
      [household],
    );
    expect(cats.rows[0]!.n).toBe(0);
    const claims = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operation_records WHERE workspace_id = $1 AND idempotency_key = 'r3-apply-archived'`,
      [household],
    );
    expect(claims.rows[0]!.n).toBe(0);
    const audits = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1`,
      [household],
    );
    expect(audits.rows[0]!.n).toBe(0);
  }, 60_000);

  it('R3 keyed apply-defaults against a DELETED household is rejected with zero effect', async () => {
    const household = await trackHouseholdRow('deleted', 'R3 gone');
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    await expect(
      idempotency.lookupOrRecord(household, 'r3-apply-deleted', {}, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'applyDefaults', {}),
      ),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
    const cats = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE household_id = $1 AND deleted_at IS NULL`,
      [household],
    );
    expect(cats.rows[0]!.n).toBe(0);
    const claims = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operation_records WHERE workspace_id = $1 AND idempotency_key = 'r3-apply-deleted'`,
      [household],
    );
    expect(claims.rows[0]!.n).toBe(0);
  }, 60_000);

  it('R3 lifecycle race: keyed apply-defaults vs concurrent archive converges to exactly one winner', async () => {
    const household = await trackHouseholdRow('active', 'R3 race');
    const writes = createPostgresWriteStore({ pool });
    const idempotency = createPostgresIdempotencyStore({ pool });
    // Deterministic start-gate (no sleeps): both sides fire at once. FOR SHARE
    // (apply guard) vs FOR UPDATE (archive) serializes them — either the apply
    // commits fully before the archive lands, or the archive wins and the
    // apply loses gracefully with zero effect. Both post-states consistent.
    const gate = makeStartGate(2);
    const applyTask = (async () => {
      await gate.enter();
      return idempotency.lookupOrRecord(household, 'r3-apply-race', {}, (claimTx) =>
        runCategoryMutation(writes, claimTx, household, 'applyDefaults', {}),
      );
    })();
    const archiveTask = (async () => {
      await gate.enter();
      return pool.query(`UPDATE households SET status = 'archived', archived_at = NOW() WHERE id = $1`, [household]);
    })();
    await gate.arrived;
    gate.go();
    const [applySettled] = await Promise.allSettled([applyTask, archiveTask]).then((r) => [r[0]]);
    await archiveTask;
    const status = await pool.query(`SELECT status FROM households WHERE id = $1`, [household]);
    expect(status.rows[0]!.status).toBe('archived');
    const cats = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE household_id = $1 AND deleted_at IS NULL`,
      [household],
    );
    const record = await pool.query(
      `SELECT status FROM operation_records WHERE workspace_id = $1 AND idempotency_key = 'r3-apply-race'`,
      [household],
    );
    if (applySettled.status === 'fulfilled') {
      // Apply won: full effect committed before the archive landed.
      expect(cats.rows[0]!.n).toBeGreaterThan(0);
      expect(record.rowCount).toBe(1);
      expect(record.rows[0]!.status).toBe('completed');
    } else {
      // Archive won: the apply lost gracefully — lifecycle error, rollback.
      expect((applySettled.reason as { code?: string }).code).toBe('workspace.archived');
      expect(cats.rows[0]!.n).toBe(0);
      expect(record.rowCount).toBe(0);
    }
  }, 60_000);

  it('R3 legacy create envelope replays stored status verbatim at the store layer', async () => {
    // Stored-side proof for P2: a pre-upgrade record keeps {status:200};
    // the route layer remaps it to the original 201 on emit (route tests).
    const household = track(randomUUID());
    const idempotency = createPostgresIdempotencyStore({ pool });
    const legacyBody = { id: randomUUID(), kind: 'bank', name: 'R3 legacy' };
    const payload = { name: 'R3 legacy', kind: 'bank', initialBalanceCents: 100 };
    await idempotency.lookupOrRecord(
      household,
      'r3-legacy-acc-create',
      httpIdempotencyPayload({ route: 'POST /accounts' }, payload),
      async () => ({ status: 200, body: legacyBody }),
    );
    const replay = await idempotency.lookupOrRecord(
      household,
      'r3-legacy-acc-create',
      httpIdempotencyPayload({ route: 'POST /accounts' }, payload),
      async () => { throw new Error('producer must not run on replay'); },
    );
    expect(replay.replayed).toBe(true);
    expect((replay.response as { status: number }).status).toBe(200);
    expect((replay.response as { body: unknown }).body).toEqual(legacyBody);
  }, 60_000);
});
