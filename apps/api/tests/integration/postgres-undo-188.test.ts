/**
 * FIX-188 — undo fail-closed + cross-key concurrency (real PostgreSQL).
 *
 * Gated by DATABASE_URL_TEST + DB_TEST_MARKER; skips cleanly otherwise
 * (same gate as xlt-07-undo-crash.test.ts). Disposable database only —
 * never production (requireTestDatabase guard + per-test random household
 * + cleanup).
 *
 * Covers ACCEPTANCE_CRITERIA 1–4 against PG descartável (seed 2 expenses):
 *  R1. No lastOperationId + head consumed → undo.nothing_to_undo
 *      fail-closed (predecessor is NEVER silently elected).
 *  R2. Concurrent distinct keys on the same target → exactly 1 completed,
 *      loser undo.nothing_to_undo, balance credited exactly once.
 *  R2b (REVIEW-188 P2). SAME as R2 but across TWO INDEPENDENT undo
 *      instances over the same PG store, with a reversal barrier forcing
 *      both producers to reach the durable reversal before either commits:
 *      R2 on one instance can pass via the same-process `inFlightTargets`
 *      set and mask a missing/broken SQL row guard. R2b's disjoint sets +
 *      barrier arrivals prove the loser traversed the SQL guard path
 *      (conditional tombstone/deactivate + rowCount-zero → not_found →
 *      undo.nothing_to_undo). Covered for all 3 targets: transaction
 *      (soft_delete), account (deactivate), category (deactivate).
 *  R3. Restart (new service instance, same stores) + new key →
 *      undo.nothing_to_undo (never not_found).
 *  R4. Legitimate sequential undo with explicit lastOperationId + same-key
 *      replay/takeover still converge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import {
  createPostgresWriteStore,
  createPostgresIdempotencyStore,
  type PostgresReversalTxExtensions,
} from '../../src/writes/postgres.js';
import type { WriteStore } from '../../src/writes/store.js';
import { createPostgresAuditLogStore } from '../../src/audit/store.js';
import {
  UNDO_IDEMPOTENCY_PREFIX,
  createUndoService,
  type UndoService,
} from '../../src/approvals/undo.js';
import {
  createIdempotencyRequest,
} from '../../src/writes/idempotency.js';
import { DomainError } from '../../src/writes/errors.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[postgres-undo-188] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required.',
  );
}

type Fixture188 = {
  householdId: string;
  actorId: string;
  oldTxId: string;
  headTxId: string;
  oldOpId: string;
  headOpId: string;
  accountId: string;
  oldAmount: number;
  headAmount: number;
  initialBalance: number;
};

const seedTwoExpenses = async (pool: Pool): Promise<Fixture188> => {
  const householdId = randomUUID();
  const actorId = 'undo-188-actor';
  const initialBalance = 100_000;
  const oldAmount = 5_000;
  const headAmount = 7_000;
  const writes = createPostgresWriteStore({ pool });
  const idempotency = createPostgresIdempotencyStore({ pool });
  const account = await writes.createAccount(householdId, {
    name: `U188 ${randomUUID().slice(0, 8)}`,
    kind: 'bank',
    initialBalanceCents: initialBalance,
  });
  const category = await writes.createCategory(householdId, {
    name: `U188 cat ${randomUUID().slice(0, 8)}`,
    kind: 'expense',
  });
  const book = async (description: string, amountCents: number): Promise<string> => {
    const booked = await idempotency.lookupOrRecord(
      createIdempotencyRequest(
        { householdId, deviceId: actorId },
        'transactions.expense.create',
        `u188-seed-${randomUUID()}`,
      ),
      { seed: 'u188' },
      async () => {
        const tx = await writes.createExpense(householdId, {
          description,
          amountCents,
          date: '2026-10-10',
          accountId: account.id,
          categoryId: category.id,
        });
        return { ...tx, transactionId: tx.id };
      },
    );
    return (booked.response as { transactionId: string }).transactionId;
  };
  const oldTxId = await book('U188 old expense', oldAmount);
  const headTxId = await book('U188 head expense', headAmount);
  // Deterministic head: pin audit created_at so the newest expense is
  // unambiguously the undo head (seeds may land in the same millisecond).
  const base = Date.parse('2026-10-10T12:00:00.000Z');
  await pool.query(
    `UPDATE audit_logs SET created_at = to_timestamp($3 / 1000.0)
      WHERE workspace_id = $1 AND effect_ref = $2`,
    [householdId, oldTxId, base],
  );
  await pool.query(
    `UPDATE audit_logs SET created_at = to_timestamp($3 / 1000.0)
      WHERE workspace_id = $1 AND effect_ref = $2`,
    [householdId, headTxId, base + 60_000],
  );
  const ops = await pool.query<{ id: string; effect_ref: string }>(
    `SELECT id, effect_ref FROM audit_logs WHERE workspace_id = $1 AND operation = 'transactions.expense.create'`,
    [householdId],
  );
  const byTx = new Map(ops.rows.map((r) => [r.effect_ref, r.id] as const));
  return {
    householdId,
    actorId,
    oldTxId,
    headTxId,
    oldOpId: byTx.get(oldTxId)!,
    headOpId: byTx.get(headTxId)!,
    accountId: account.id,
    oldAmount,
    headAmount,
    initialBalance,
  };
};

const makeUndo = (pool: Pool): UndoService =>
  createUndoService({
    auditLogs: createPostgresAuditLogStore(pool),
    writes: createPostgresWriteStore({ pool }),
    idempotency: createPostgresIdempotencyStore({ pool }),
  });

// ---------------------------------------------------------------------------
// R2b (REVIEW-188 P2, refined by REVIEW-188-R2): two independent instances
// + snapshot barrier.
// ---------------------------------------------------------------------------
// The barrier lives ENTIRELY in the test (a writes proxy): no production
// hook was added. Each undo instance gets its own proxy, but both proxies
// share one gate. The gate is NOT at reversal entry (REVIEW-188-R2: parking
// at entry lets the loser run its snapshot SELECT after the winner commits,
// so the loser returns `nothing_to_undo` via the initial validation
// `findActive*/status-check` and the test passes even with the SQL guard
// removed — a false-green). Instead each proxy wraps the claim-tx client
// and parks AFTER the snapshot read returns an ACTIVE row but BEFORE any
// mutation or exclusive lock (FOR UPDATE / UPDATE). When both producers are
// parked at the gate, both have already seen the SAME live target (neither
// committed yet — the winner cannot commit before the release, and the
// release requires both arrivals), and neither holds a lock yet, so the
// loser's `undo.nothing_to_undo` can only come from the SQL row guard
// (conditional tombstone/deactivate + rowCount-zero → not_found →
// undo.nothing_to_undo). The per-instance `inFlightTargets` sets are
// disjoint by construction and head re-election is excluded by the barrier
// (both elections precede both commits).
//
// A consumed snapshot (0 rows / inactive status) never arrives: the result
// propagates, production throws via the initial validation, and the gate
// times out LOUD — a silent release would let the race run un-overlapped
// and mask the SQL guard again.
//
// TDD note (criterion 3): with the fix, R2b passes. If the durable SQL
// guard were removed (unconditional UPDATE, no rowCount-zero check), BOTH
// reversals would succeed: `expect(fulfilled).toHaveLength(1)` would see
// 2 fulfilled (account/category: two deactivations, second a no-op flip;
// transaction: the balance credited TWICE), and the single-effect asserts
// below would break. `gate.count() === 2` is the proof the SQL path — not
// the memory set, not re-election, not the initial validation — decided
// the loser.

type ReversalGate = {
  arrive: () => Promise<void>;
  count: () => number;
};

const createBarrier = (parties: number, timeoutMs = 15_000): ReversalGate => {
  let arrivals = 0;
  let release!: () => void;
  let fail!: (err: Error) => void;
  const released = new Promise<void>((resolve, reject) => {
    release = () => resolve();
    fail = (err: Error) => reject(err);
  });
  // Fail LOUD on timeout (never silently release: a silent release would
  // let the race run un-overlapped and mask the SQL guard again).
  const timer = setTimeout(
    () => fail(new Error(`[u188-barrier] timeout: ${arrivals}/${parties} arrivals`)),
    timeoutMs,
  );
  return {
    arrive: async (): Promise<void> => {
      arrivals += 1;
      if (arrivals >= parties) {
        clearTimeout(timer);
        release();
      }
      await released;
    },
    count: (): number => arrivals,
  };
};

type BarrierWrites = WriteStore & PostgresReversalTxExtensions;

/**
 * Wraps the claim-tx client so the gate fires AFTER the snapshot read
 * returns an ACTIVE row and BEFORE any later query (lock / UPDATE) runs.
 * `matchSnapshot` selects the snapshot SELECT for one reversal kind;
 * `isActive` confirms the row is live. Exactly one arrival per party: a
 * consumed snapshot returns without arriving, so the gate times out loud
 * instead of letting the initial validation silently decide the loser.
 */
const withSnapshotGate = (
  client: PoolClient,
  gate: ReversalGate,
  matchSnapshot: (text: string) => boolean,
  isActive: (res: { rowCount: number | null; rows: Array<Record<string, unknown>> }) => boolean,
): PoolClient => {
  let arrived = false;
  const gatedQuery = async (...args: Array<unknown>): Promise<unknown> => {
    const first = args[0];
    const text = typeof first === 'string' ? first : (first as { text?: string } | null)?.text ?? '';
    if (arrived || !matchSnapshot(text)) {
      return (client.query as (...a: Array<unknown>) => Promise<unknown>).apply(client, args);
    }
    const res = (await (client.query as (...a: Array<unknown>) => Promise<unknown>).apply(
      client,
      args,
    )) as { rowCount: number | null; rows: Array<Record<string, unknown>> };
    let active = false;
    try {
      active = isActive(res);
    } catch {
      active = false;
    }
    if (!active) return res;
    arrived = true;
    await gate.arrive();
    return res;
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') return gatedQuery;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const isTxSnapshot = (text: string): boolean =>
  /FROM\s+transactions/i.test(text) && !/COUNT\s*\(/i.test(text) && !/FOR\s+UPDATE/i.test(text);

const isAccountSnapshot = (text: string): boolean =>
  /FROM\s+accounts/i.test(text) && !/FOR\s+UPDATE/i.test(text);

const isCategorySnapshot = (text: string): boolean =>
  /FROM\s+categories/i.test(text) && !/FOR\s+UPDATE/i.test(text);

const withReversalBarrier = (real: BarrierWrites, gate: ReversalGate): BarrierWrites => ({
  ...real,
  softDeleteTransactionInTx: async (client: PoolClient, householdId: string, id: string) => {
    const gated = withSnapshotGate(client, gate, isTxSnapshot, (res) => (res.rowCount ?? 0) > 0);
    return real.softDeleteTransactionInTx(gated, householdId, id);
  },
  deactivateAccountInTx: async (client: PoolClient, householdId: string, id: string) => {
    const gated = withSnapshotGate(
      client,
      gate,
      isAccountSnapshot,
      (res) => res.rows[0]?.['status'] === 'active',
    );
    return real.deactivateAccountInTx(gated, householdId, id);
  },
  deactivateCategoryInTx: async (client: PoolClient, householdId: string, id: string) => {
    const gated = withSnapshotGate(
      client,
      gate,
      isCategorySnapshot,
      (res) => res.rows[0]?.['status'] === 'active',
    );
    return real.deactivateCategoryInTx(gated, householdId, id);
  },
});

/** Two INDEPENDENT undo instances (disjoint inFlightTargets) over one PG pool. */
const makeBarrierUndoPair = (pool: Pool, gate: ReversalGate): [UndoService, UndoService] => {
  const build = (): UndoService =>
    createUndoService({
      auditLogs: createPostgresAuditLogStore(pool),
      writes: withReversalBarrier(createPostgresWriteStore({ pool }) as BarrierWrites, gate),
      idempotency: createPostgresIdempotencyStore({ pool }),
    });
  return [build(), build()];
};

const insertSeedAuditRow = async (
  pool: Pool,
  householdId: string,
  actorId: string,
  operation: 'accounts.create' | 'categories.create',
  entityId: string,
  entityType: 'account' | 'category',
): Promise<void> => {
  // Same canonical shape production keyed routes persist (operation,
  // effect_ref, metadata.entityType) — the undo election only reads these.
  await pool.query(
    `INSERT INTO audit_logs
       (workspace_id, actor_id, operation, event_type, payload_hash, effect_ref, metadata)
     VALUES ($1, $2, $3, 'financial_effect.committed', 'u188-seed', $4, $5)`,
    [householdId, actorId, operation, entityId, JSON.stringify({ entityType })],
  );
};

type AccountTargetFixture = {
  householdId: string;
  actorId: string;
  targetAccountId: string;
  fillerAccountId: string;
};

const seedAccountTarget = async (pool: Pool): Promise<AccountTargetFixture> => {
  const householdId = randomUUID();
  const actorId = 'undo-188-actor';
  const writes = createPostgresWriteStore({ pool });
  await writes.createCategory(householdId, {
    name: `U188 cat ${randomUUID().slice(0, 8)}`,
    kind: 'expense',
  });
  const filler = await writes.createAccount(householdId, {
    name: `U188 filler ${randomUUID().slice(0, 8)}`,
    kind: 'bank',
    initialBalanceCents: 100_000,
  });
  // Target last: no transactions reference it (deactivate guard stays green).
  const target = await writes.createAccount(householdId, {
    name: `U188 target ${randomUUID().slice(0, 8)}`,
    kind: 'bank',
    initialBalanceCents: 50_000,
  });
  // Only the target gets an audit row → it is the unambiguous undo head.
  await insertSeedAuditRow(pool, householdId, actorId, 'accounts.create', target.id, 'account');
  return { householdId, actorId, targetAccountId: target.id, fillerAccountId: filler.id };
};

type CategoryTargetFixture = {
  householdId: string;
  actorId: string;
  targetCategoryId: string;
  fillerCategoryId: string;
};

const seedCategoryTarget = async (pool: Pool): Promise<CategoryTargetFixture> => {
  const householdId = randomUUID();
  const actorId = 'undo-188-actor';
  const writes = createPostgresWriteStore({ pool });
  const filler = await writes.createCategory(householdId, {
    name: `U188 filler ${randomUUID().slice(0, 8)}`,
    kind: 'expense',
  });
  // Target last: no transactions reference it (deactivate guard stays green).
  const target = await writes.createCategory(householdId, {
    name: `U188 target ${randomUUID().slice(0, 8)}`,
    kind: 'expense',
  });
  await insertSeedAuditRow(pool, householdId, actorId, 'categories.create', target.id, 'category');
  return { householdId, actorId, targetCategoryId: target.id, fillerCategoryId: filler.id };
};

const readUndoCompletions = async (
  pool: Pool,
  householdId: string,
  keys: string[],
): Promise<Map<string, string>> => {
  const res = await pool.query<{ idempotency_key: string; status: string }>(
    'SELECT idempotency_key, status FROM operation_records WHERE workspace_id = $1 AND idempotency_key = ANY($2)',
    [householdId, keys.map((k) => `${UNDO_IDEMPOTENCY_PREFIX}${k}`)],
  );
  return new Map(res.rows.map((r) => [r.idempotency_key, r.status] as const));
};

const readAccountStatus = async (pool: Pool, householdId: string, id: string): Promise<string> => {
  const res = await pool.query<{ status: string }>(
    'SELECT status FROM accounts WHERE id = $1 AND household_id = $2',
    [id, householdId],
  );
  return res.rows[0]!.status;
};

const readCategoryStatus = async (pool: Pool, householdId: string, id: string): Promise<string> => {
  const res = await pool.query<{ status: string }>(
    'SELECT status FROM categories WHERE id = $1 AND household_id = $2',
    [id, householdId],
  );
  return res.rows[0]!.status;
};

const readBalance = async (pool: Pool, fx: Fixture188): Promise<number> => {
  const res = await pool.query<{ balance_cents: string }>(
    'SELECT balance_cents FROM accounts WHERE id = $1 AND household_id = $2',
    [fx.accountId, fx.householdId],
  );
  return Number(res.rows[0]!.balance_cents);
};

const isDeleted = async (pool: Pool, householdId: string, txId: string): Promise<boolean> => {
  const res = await pool.query<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM transactions WHERE id = $1 AND household_id = $2',
    [txId, householdId],
  );
  return res.rows[0]?.deleted_at != null;
};

const undoCodeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  throw new Error('expected undo to reject');
};

const cleanupHousehold = async (pool: Pool, householdId: string): Promise<void> => {
  await pool.query('DELETE FROM audit_logs WHERE workspace_id = $1', [householdId]).catch(() => undefined);
  await pool.query('DELETE FROM operation_records WHERE workspace_id = $1', [householdId]).catch(() => undefined);
  await pool.query('DELETE FROM transactions WHERE household_id = $1', [householdId]).catch(() => undefined);
  await pool.query('DELETE FROM categories WHERE household_id = $1', [householdId]).catch(() => undefined);
  await pool.query('DELETE FROM accounts WHERE household_id = $1', [householdId]).catch(() => undefined);
};

describeIfDb('FIX-188 — undo fail-closed + cross-key concurrency (real PostgreSQL)', () => {
  let pool: Pool;
  const households: string[] = [];

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'postgres-undo-188');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      for (const householdId of households) await cleanupHousehold(pool, householdId);
      await pool.end();
    }
  });

  it('R1 — head consumed + new key without lastOperationId → nothing_to_undo (predecessor never elected)', async () => {
    const fx = await seedTwoExpenses(pool);
    households.push(fx.householdId);
    const undo = makeUndo(pool);

    const first = await undo.undo(fx.householdId, fx.actorId, `u188-r1-${randomUUID()}`);
    expect(first.undone.entityId).toBe(fx.headTxId);
    expect(await readBalance(pool, fx)).toBe(fx.initialBalance - fx.oldAmount);

    const code = await undoCodeOf(undo.undo(fx.householdId, fx.actorId, `u188-r1-${randomUUID()}`));
    expect(code).toBe('undo.nothing_to_undo');

    // Predecessor untouched: still active, balance credited exactly once.
    expect(await isDeleted(pool, fx.householdId, fx.oldTxId)).toBe(false);
    expect(await readBalance(pool, fx)).toBe(fx.initialBalance - fx.oldAmount);
  });

  it('R2 — concurrent distinct keys on the same target: exactly 1 completed, loser nothing_to_undo, single credit', async () => {
    const fx = await seedTwoExpenses(pool);
    households.push(fx.householdId);
    const undo = makeUndo(pool);

    const settled = await Promise.allSettled([
      undo.undo(fx.householdId, fx.actorId, `u188-r2-${randomUUID()}`),
      undo.undo(fx.householdId, fx.actorId, `u188-r2-${randomUUID()}`),
    ]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ undone: { entityId: string } }>).value;
    expect(winner.undone.entityId).toBe(fx.headTxId);
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(DomainError);
    expect((loser as DomainError).code).toBe('undo.nothing_to_undo');

    expect(await isDeleted(pool, fx.householdId, fx.headTxId)).toBe(true);
    expect(await isDeleted(pool, fx.householdId, fx.oldTxId)).toBe(false);
    expect(await readBalance(pool, fx)).toBe(fx.initialBalance - fx.oldAmount);
  });

  it('R2b-tx — two independent instances + reversal barrier (transaction): exactly 1 completed, loser nothing_to_undo, single credit, loser never completes', async () => {
    const fx = await seedTwoExpenses(pool);
    households.push(fx.householdId);
    const gate = createBarrier(2);
    const [undoA, undoB] = makeBarrierUndoPair(pool, gate);
    const keyA = `u188-r2b-tx-${randomUUID()}`;
    const keyB = `u188-r2b-tx-${randomUUID()}`;

    const settled = await Promise.allSettled([
      undoA.undo(fx.householdId, fx.actorId, keyA),
      undoB.undo(fx.householdId, fx.actorId, keyB),
    ]);
    // Both producers obtained an ACTIVE snapshot before either mutated or
    // locked: neither loser path came from head re-election NOR from the
    // initial validation, and the per-instance inFlightTargets sets are
    // disjoint — the SQL row guard decided.
    expect(gate.count()).toBe(2);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ undone: { entityId: string; reversal: string } }>).value;
    expect(winner.undone).toMatchObject({ entityId: fx.headTxId, reversal: 'soft_delete' });
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(DomainError);
    expect((loser as DomainError).code).toBe('undo.nothing_to_undo');

    // Single financial effect: head tombstoned, predecessor active, balance
    // credited exactly once (a guard-less second reversal would credit twice).
    expect(await isDeleted(pool, fx.householdId, fx.headTxId)).toBe(true);
    expect(await isDeleted(pool, fx.householdId, fx.oldTxId)).toBe(false);
    expect(await readBalance(pool, fx)).toBe(fx.initialBalance - fx.oldAmount);

    // Exactly one completion: the winner completed; the loser never did
    // (its claim rolled back with the failed reversal — no completion row).
    const winnerKey = settled[0]!.status === 'fulfilled' ? keyA : keyB;
    const loserKey = winnerKey === keyA ? keyB : keyA;
    const completions = await readUndoCompletions(pool, fx.householdId, [keyA, keyB]);
    expect(completions.get(`${UNDO_IDEMPOTENCY_PREFIX}${winnerKey}`)).toBe('completed');
    expect(completions.has(`${UNDO_IDEMPOTENCY_PREFIX}${loserKey}`)).toBe(false);
  });

  it('R2b-account — two independent instances + reversal barrier (account deactivate): exactly 1 completed, loser nothing_to_undo, single flip, loser never completes', async () => {
    const fx = await seedAccountTarget(pool);
    households.push(fx.householdId);
    const gate = createBarrier(2);
    const [undoA, undoB] = makeBarrierUndoPair(pool, gate);
    const keyA = `u188-r2b-acc-${randomUUID()}`;
    const keyB = `u188-r2b-acc-${randomUUID()}`;

    const settled = await Promise.allSettled([
      undoA.undo(fx.householdId, fx.actorId, keyA),
      undoB.undo(fx.householdId, fx.actorId, keyB),
    ]);
    expect(gate.count()).toBe(2);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ undone: { entityId: string; reversal: string } }>).value;
    expect(winner.undone).toMatchObject({ entityId: fx.targetAccountId, reversal: 'deactivate' });
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(DomainError);
    expect((loser as DomainError).code).toBe('undo.nothing_to_undo');

    // Single effect: target inactive, filler untouched.
    expect(await readAccountStatus(pool, fx.householdId, fx.targetAccountId)).toBe('inactive');
    expect(await readAccountStatus(pool, fx.householdId, fx.fillerAccountId)).toBe('active');

    const winnerKey = settled[0]!.status === 'fulfilled' ? keyA : keyB;
    const loserKey = winnerKey === keyA ? keyB : keyA;
    const completions = await readUndoCompletions(pool, fx.householdId, [keyA, keyB]);
    expect(completions.get(`${UNDO_IDEMPOTENCY_PREFIX}${winnerKey}`)).toBe('completed');
    expect(completions.has(`${UNDO_IDEMPOTENCY_PREFIX}${loserKey}`)).toBe(false);
  });

  it('R2b-category — two independent instances + reversal barrier (category deactivate): exactly 1 completed, loser nothing_to_undo, single flip, loser never completes', async () => {
    const fx = await seedCategoryTarget(pool);
    households.push(fx.householdId);
    const gate = createBarrier(2);
    const [undoA, undoB] = makeBarrierUndoPair(pool, gate);
    const keyA = `u188-r2b-cat-${randomUUID()}`;
    const keyB = `u188-r2b-cat-${randomUUID()}`;

    const settled = await Promise.allSettled([
      undoA.undo(fx.householdId, fx.actorId, keyA),
      undoB.undo(fx.householdId, fx.actorId, keyB),
    ]);
    expect(gate.count()).toBe(2);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ undone: { entityId: string; reversal: string } }>).value;
    expect(winner.undone).toMatchObject({ entityId: fx.targetCategoryId, reversal: 'deactivate' });
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(DomainError);
    expect((loser as DomainError).code).toBe('undo.nothing_to_undo');

    // Single effect: target inactive, filler untouched.
    expect(await readCategoryStatus(pool, fx.householdId, fx.targetCategoryId)).toBe('inactive');
    expect(await readCategoryStatus(pool, fx.householdId, fx.fillerCategoryId)).toBe('active');

    const winnerKey = settled[0]!.status === 'fulfilled' ? keyA : keyB;
    const loserKey = winnerKey === keyA ? keyB : keyA;
    const completions = await readUndoCompletions(pool, fx.householdId, [keyA, keyB]);
    expect(completions.get(`${UNDO_IDEMPOTENCY_PREFIX}${winnerKey}`)).toBe('completed');
    expect(completions.has(`${UNDO_IDEMPOTENCY_PREFIX}${loserKey}`)).toBe(false);
  });

  it('R3 — restart (new instance, same stores) + new key → nothing_to_undo, never not_found', async () => {
    const fx = await seedTwoExpenses(pool);
    households.push(fx.householdId);

    const before = makeUndo(pool);
    const first = await before.undo(fx.householdId, fx.actorId, `u188-r3-${randomUUID()}`);
    expect(first.undone.entityId).toBe(fx.headTxId);

    // Restart simulado: nova instância, mesmos stores persistentes.
    const after = makeUndo(pool);
    const code = await undoCodeOf(after.undo(fx.householdId, fx.actorId, `u188-r3-${randomUUID()}`));
    expect(code).toBe('undo.nothing_to_undo');
    expect(code).not.toBe('not_found');
  });

  it('R4 — sequential legitimate undo with explicit lastOperationId + same-key replay converge', async () => {
    const fx = await seedTwoExpenses(pool);
    households.push(fx.householdId);
    const undo = makeUndo(pool);

    const head = await undo.undo(fx.householdId, fx.actorId, `u188-r4-${randomUUID()}`);
    expect(head.undone.entityId).toBe(fx.headTxId);

    const olderKey = `u188-r4-${randomUUID()}`;
    const older = await undo.undo(fx.householdId, fx.actorId, olderKey, fx.oldOpId);
    expect(older.undone.entityId).toBe(fx.oldTxId);

    const replayed = await undo.undo(fx.householdId, fx.actorId, olderKey, fx.oldOpId);
    expect(replayed).toEqual(older);

    expect(await readBalance(pool, fx)).toBe(fx.initialBalance);
  });
});
