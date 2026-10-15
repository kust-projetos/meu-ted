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
 *  R3. Restart (new service instance, same stores) + new key →
 *      undo.nothing_to_undo (never not_found).
 *  R4. Legitimate sequential undo with explicit lastOperationId + same-key
 *      replay/takeover still converge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import {
  createPostgresWriteStore,
  createPostgresIdempotencyStore,
} from '../../src/writes/postgres.js';
import { createPostgresAuditLogStore } from '../../src/audit/store.js';
import {
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
