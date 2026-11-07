/**
 * T1.6 — Real end-to-end protocol tests: agent-flow semantics → API →
 * PostgreSQL → real WriteStore for expense and income (SPEC §25.5).
 *
 * Postgres-backed ONLY (REAL Postgres store + REAL production V2 executor
 * wiring `createPendingOperationV2Executor`). Gated by DATABASE_URL_TEST +
 * DB_TEST_MARKER; skips cleanly otherwise with an explicit skip report.
 *
 * If a REAL src bug surfaces (e.g. duplicated writes), this suite must FAIL
 * and be reported as a BLOCKER — never weaken the assertions to pass.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { computePendingOperationV2Hash, type PendingOperationV2JsonValue } from '@pi-finance/llm-contracts';
import {
  createPostgresPendingOperationV2Store,
  type PendingIdentity,
  type PendingOperationV2Store,
} from '../../src/approvals/pending-v2.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import type { WriteStore } from '../../src/writes/store.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;

if (!ENABLED) {
  console.log(
    '[pending-v2-e2e] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — ' +
      'this suite is inherently Postgres-backed (real WriteStore), so every test below is skipped. ' +
      'Set both env vars to run the real end-to-end protocol tests.',
  );
}

let pool: Pool | undefined;
const households = new Set<string>();

const seedHousehold = async (db: Pool): Promise<string> => {
  const id = randomUUID();
  const ownerId = randomUUID();
  await db.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'E2E Owner', 'active')`, [
    ownerId,
    `e2e-${id}@example.test`,
  ]);
  await db.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, $2, 'shared', $3)`, [
    id,
    `E2E ${id.slice(0, 8)}`,
    ownerId,
  ]);
  households.add(id);
  return id;
};

const cleanupHousehold = async (db: Pool, id: string): Promise<void> => {
  const owner = await db.query(`SELECT owner_user_id FROM households WHERE id = $1`, [id]).catch(() => null);
  await db.query(`DELETE FROM pending_operations WHERE workspace_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM transactions WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM idempotency_keys WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM categories WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM accounts WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM memberships WHERE household_id = $1`, [id]).catch(() => undefined);
  await db.query(`DELETE FROM households WHERE id = $1`, [id]).catch(() => undefined);
  const ownerId = (owner as { rows: Array<Record<string, unknown>> } | null)?.rows[0]?.['owner_user_id'] as
    | string
    | undefined;
  if (ownerId) await db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => undefined);
  households.delete(id);
};

const identityFor = (householdId: string): PendingIdentity => ({
  workspaceId: householdId,
  actorId: randomUUID(),
  deviceId: randomUUID(),
});

const proposeOp = async (
  store: PendingOperationV2Store,
  identity: PendingIdentity,
  tool: 'transactions.expense.create' | 'transactions.income.create' | 'transactions.transfer.create',
  normalizedArgs: Record<string, PendingOperationV2JsonValue>,
  idempotencyKey?: string,
) => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool,
    normalizedArgs,
    proposalHash: '',
    idempotencyKey: idempotencyKey ?? randomUUID(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    bindings: {
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    },
  };
  const proposalHash = await computePendingOperationV2Hash(base);
  return store.propose({ ...base, proposalHash });
};

const transactionCount = async (db: Pool, householdId: string): Promise<number> => {
  const res = await db.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`, [
    householdId,
  ]);
  return Number(res.rows[0]!['n']);
};

const transferCount = async (db: Pool, householdId: string): Promise<number> => {
  const res = await db.query(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1 AND kind = 'transfer' AND deleted_at IS NULL`,
    [householdId],
  );
  return Number(res.rows[0]!['n']);
};

const balanceOf = async (db: Pool, accountId: string): Promise<number> => {
  const res = await db.query(`SELECT balance_cents::int AS n FROM accounts WHERE id = $1`, [accountId]);
  return Number(res.rows[0]!['n']);
};

/** Derived DRE legs: internal transfers must not change either. */
const dreTotals = async (db: Pool, householdId: string): Promise<{ income: number; expense: number }> => {
  const res = await db.query(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'income'), 0)::int AS income,
       COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'expense'), 0)::int AS expense
     FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
    [householdId],
  );
  return { income: Number(res.rows[0]!['income']), expense: Number(res.rows[0]!['expense']) };
};

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
  message = 'timed out waiting for condition',
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('pending-v2 end-to-end (real executor + real Postgres WriteStore)', () => {
  let store: PendingOperationV2Store | undefined;
  let writes: WriteStore | undefined;
  let realExecutor: ReturnType<typeof createPendingOperationV2Executor> | undefined;

  beforeAll(async () => {
    if (!DB_URL) return;
    pool = createPool({ connectionString: DB_URL, max: 8 });
    await requireTestDatabase(pool, 'pending-v2-e2e');
    await runMigrations(pool);
    store = createPostgresPendingOperationV2Store(pool);
    writes = createPostgresWriteStore({ pool });
    realExecutor = createPendingOperationV2Executor(writes);
  }, 60_000);

  afterEach(async () => {
    if (!pool || households.size === 0) return;
    for (const id of [...households]) await cleanupHousehold(pool, id);
  });

  afterAll(async () => {
    if (pool && households.size > 0) {
      for (const id of [...households]) await cleanupHousehold(pool, id);
    }
    await pool?.end();
  });

  itIfDatabase('expense happy path: propose → confirm → execute writes exactly 1 canonical row', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const account = await writes!.createAccount(householdId, {
      name: 'E2E Checking',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes!.createCategory(householdId, { name: 'E2E Food', kind: 'expense' });
    const args = {
      description: 'E2E lunch',
      amountCents: 1250,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    };

    const proposed = await proposeOp(store!, id, 'transactions.expense.create', args);
    const confirmed = await store!.confirm(proposed.id, id);
    expect(confirmed.attestation).toBeTruthy();

    const done = await store!.execute(confirmed.attestation!, id, realExecutor!);
    expect(done.status).toBe('succeeded');
    // T3.2 receipt (additive): execution carries the receipt, mutation_id persists its identity.
    const execution = done.execution as {
      status: string;
      operationId: string;
      receipt: { mutationId: string; mutationKind: string; affectedTargets: unknown[] };
    };
    expect(execution.receipt).toBeTruthy();
    expect(typeof execution.receipt.mutationId).toBe('string');
    expect(execution.receipt.mutationKind).toBe('transactions.expense.create');
    expect(Array.isArray(execution.receipt.affectedTargets)).toBe(true);
    expect(done.mutationId).toBe(execution.receipt.mutationId);

    // INV-02: exactly 1 row with the EXACT canonical args.
    expect(await transactionCount(db, householdId)).toBe(1);
    const row = await db.query(
      `SELECT id, kind, description, amount_cents::int AS amount_cents, date::text AS date, account_id, category_id
         FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
      [householdId],
    );
    expect(row.rows[0]).toMatchObject({
      kind: 'expense',
      description: 'E2E lunch',
      amount_cents: 1250,
      date: '2026-09-14',
      account_id: account.id,
      category_id: category.id,
    });
    expect(execution.operationId).toBe(row.rows[0]!['id']);
  }, 30_000);

  itIfDatabase('income happy path: propose → confirm → execute writes exactly 1 canonical row', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const account = await writes!.createAccount(householdId, {
      name: 'E2E Savings',
      kind: 'bank',
      initialBalanceCents: 10_000,
    });
    const category = await writes!.createCategory(householdId, { name: 'E2E Salary', kind: 'income' });
    const args = {
      description: 'E2E paycheck',
      amountCents: 250_000,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    };

    const proposed = await proposeOp(store!, id, 'transactions.income.create', args);
    const confirmed = await store!.confirm(proposed.id, id);
    const done = await store!.execute(confirmed.attestation!, id, realExecutor!);
    expect(done.status).toBe('succeeded');
    const execution = done.execution as {
      status: string;
      operationId: string;
      receipt: { mutationId: string; mutationKind: string; affectedTargets: unknown[] };
    };
    expect(execution.receipt.mutationKind).toBe('transactions.income.create');
    expect(done.mutationId).toBe(execution.receipt.mutationId);

    expect(await transactionCount(db, householdId)).toBe(1);
    const row = await db.query(
      `SELECT kind, description, amount_cents::int AS amount_cents, date::text AS date, account_id, category_id
         FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
      [householdId],
    );
    expect(row.rows[0]).toMatchObject({
      kind: 'income',
      description: 'E2E paycheck',
      amount_cents: 250_000,
      date: '2026-09-14',
      account_id: account.id,
      category_id: category.id,
    });
  }, 30_000);

  itIfDatabase('handoff idempotency E2E: same key + same payload dedups to the same operation, 1 transaction', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const account = await writes!.createAccount(householdId, {
      name: 'E2E Handoff',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes!.createCategory(householdId, { name: 'E2E Handoff Food', kind: 'expense' });
    const args = {
      description: 'E2E handoff lunch',
      amountCents: 999,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    };
    const key = randomUUID();

    // First propose response is discarded/lost (handoff); the retry carries the SAME key + payload.
    const lost = await proposeOp(store!, id, 'transactions.expense.create', args, key);
    expect(lost.existing).toBe(false);
    const retried = await proposeOp(store!, id, 'transactions.expense.create', args, key);
    expect(retried.existing).toBe(true);
    expect(retried.id).toBe(lost.id);

    const confirmed = await store!.confirm(retried.id, id);
    const done = await store!.execute(confirmed.attestation!, id, realExecutor!);
    expect(done.status).toBe('succeeded');
    expect(await transactionCount(db, householdId)).toBe(1);
  }, 30_000);

  itIfDatabase('cancellation E2E: propose → cancel → zero rows; execute-after-cancel is attestation_replayed', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const account = await writes!.createAccount(householdId, {
      name: 'E2E Cancel',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes!.createCategory(householdId, { name: 'E2E Cancel Food', kind: 'expense' });

    const proposed = await proposeOp(store!, id, 'transactions.expense.create', {
      description: 'E2E cancelled',
      amountCents: 500,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    });
    const confirmed = await store!.confirm(proposed.id, id);
    const cancelled = await store!.cancel(proposed.id, id);
    expect(cancelled.status).toBe('cancelled');

    expect(await transactionCount(db, householdId)).toBe(0);

    let ran = false;
    await expect(
      store!.execute(confirmed.attestation!, id, async (op) => {
        ran = true;
        return realExecutor!(op);
      }),
    ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
    expect(ran).toBe(false);
    expect(await transactionCount(db, householdId)).toBe(0);
  }, 30_000);

  itIfDatabase('confirm re-emission E2E: old token replays, new token executes exactly once', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const account = await writes!.createAccount(householdId, {
      name: 'E2E Reemit',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes!.createCategory(householdId, { name: 'E2E Reemit Food', kind: 'expense' });

    const proposed = await proposeOp(store!, id, 'transactions.expense.create', {
      description: 'E2E reemit',
      amountCents: 700,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    });
    const first = await store!.confirm(proposed.id, id);
    const second = await store!.confirm(proposed.id, id);
    expect(second.attestation).toBeTruthy();
    expect(second.attestation).not.toBe(first.attestation);

    // The OLD (rotated) token is dead: replay rejection without running the executor.
    let ran = false;
    await expect(
      store!.execute(first.attestation!, id, async (op) => {
        ran = true;
        return realExecutor!(op);
      }),
    ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
    expect(ran).toBe(false);
    expect(await transactionCount(db, householdId)).toBe(0);

    const done = await store!.execute(second.attestation!, id, realExecutor!);
    expect(done.status).toBe('succeeded');
    expect(await transactionCount(db, householdId)).toBe(1);
  }, 30_000);

  itIfDatabase('crash-after-claim E2E: expired lease + real-executor reconcile → 0 or 1 transaction total', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const account = await writes!.createAccount(householdId, {
      name: 'E2E Crash',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes!.createCategory(householdId, { name: 'E2E Crash Food', kind: 'expense' });

    const proposed = await proposeOp(store!, id, 'transactions.expense.create', {
      description: 'E2E crash',
      amountCents: 1100,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    });
    const confirmed = await store!.confirm(proposed.id, id);

    // TX1 claim with a blocked executor (process holds the claim, then "dies").
    const gate = deferred<void>();
    const claimed = store!.execute(confirmed.attestation!, id, async (op) => {
      await gate.promise;
      return realExecutor!(op);
    });
    await waitFor(async () => (await store!.get(proposed.id, id)).status === 'executing', 5_000, 'claim never committed');

    // Simulate process death: manually expire the lease past its deadline.
    await db.query(`UPDATE pending_operations SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      proposed.id,
    ]);

    // Crash recovery with the REAL executor and the SAME persisted idempotencyKey.
    const recovered = await store!.reconcileExpiredExecuting(proposed.id, id, realExecutor!);
    expect(recovered.status).toBe('succeeded');
    expect(await transactionCount(db, householdId)).toBeLessThanOrEqual(1);

    // The abandoned attempt finally completes through the same real executor:
    // WriteStore key-dedup must replay, never duplicate.
    gate.resolve();
    const firstDone = await claimed;
    expect(firstDone.status).toBe('succeeded');
    const total = await transactionCount(db, householdId);
    expect(total).toBeLessThanOrEqual(1);
    expect(total).toBe(1);
    const firstExecution = firstDone.execution as { operationId: string };
    const recoveredExecution = recovered.execution as { operationId: string };
    expect(firstExecution.operationId).toBe(recoveredExecution.operationId);
  }, 30_000);

  itIfDatabase('transfer happy path: ONE atomic transfer row, both balances, DRE untouched', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const from = await writes!.createAccount(householdId, {
      name: 'E2E Transfer From',
      kind: 'bank',
      initialBalanceCents: 100_000,
    });
    const to = await writes!.createAccount(householdId, {
      name: 'E2E Transfer To',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const args = {
      description: 'E2E internal transfer',
      amountCents: 30_000,
      date: '2026-11-07',
      fromAccountId: from.id,
      toAccountId: to.id,
    };

    const proposed = await proposeOp(store!, id, 'transactions.transfer.create', args);
    expect(await transferCount(db, householdId)).toBe(0);
    const confirmed = await store!.confirm(proposed.id, id);
    const done = await store!.execute(confirmed.attestation!, id, realExecutor!);
    expect(done.status).toBe('succeeded');
    const execution = done.execution as {
      status: string;
      operationId: string;
      receipt: { mutationId: string; mutationKind: string; affectedTargets: string[] };
    };
    expect(execution.receipt.mutationKind).toBe('transactions.transfer.create');
    expect(execution.receipt.affectedTargets).toEqual(['transactions', 'accounts', 'dashboard-summary']);
    expect(done.mutationId).toBe(execution.receipt.mutationId);

    // Exactly ONE `transfer` row (never two expense/income legs).
    expect(await transactionCount(db, householdId)).toBe(1);
    expect(await transferCount(db, householdId)).toBe(1);
    const row = await db.query(
      `SELECT id, kind, description, amount_cents::int AS amount_cents, date::text AS date,
              account_id, transfer_to_account_id, category_id
         FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
      [householdId],
    );
    expect(row.rows[0]).toMatchObject({
      kind: 'transfer',
      description: 'E2E internal transfer',
      amount_cents: 30_000,
      date: '2026-11-07',
      account_id: from.id,
      transfer_to_account_id: to.id,
      category_id: null,
    });
    expect(execution.operationId).toBe(row.rows[0]!['id']);

    // Both balance legs moved by the exact amount (no clamp, no duplication).
    expect(await balanceOf(db, from.id)).toBe(70_000);
    expect(await balanceOf(db, to.id)).toBe(80_000);

    // DRE: no revenue and no expense was created by the transfer.
    expect(await dreTotals(db, householdId)).toEqual({ income: 0, expense: 0 });
  }, 30_000);

  itIfDatabase('transfer rejection writes zero rows; repeated execution cannot duplicate', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const from = await writes!.createAccount(householdId, {
      name: 'E2E Transfer Cancel From',
      kind: 'bank',
      initialBalanceCents: 100_000,
    });
    const to = await writes!.createAccount(householdId, {
      name: 'E2E Transfer Cancel To',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const args = {
      description: 'E2E transfer cancel',
      amountCents: 5_000,
      date: '2026-11-07',
      fromAccountId: from.id,
      toAccountId: to.id,
    };

    const rejected = await proposeOp(store!, id, 'transactions.transfer.create', args);
    const rejectedConfirmed = await store!.confirm(rejected.id, id);
    await store!.cancel(rejected.id, id);
    expect(await transactionCount(db, householdId)).toBe(0);
    expect(await balanceOf(db, from.id)).toBe(100_000);
    expect(await balanceOf(db, to.id)).toBe(50_000);
    await expect(
      store!.execute(rejectedConfirmed.attestation!, id, realExecutor!),
    ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });

    // Same key + same payload replays the SAME pending operation.
    const key = randomUUID();
    const first = await proposeOp(store!, id, 'transactions.transfer.create', { ...args, description: 'E2E transfer replay' }, key);
    const second = await proposeOp(store!, id, 'transactions.transfer.create', { ...args, description: 'E2E transfer replay' }, key);
    expect(second.id).toBe(first.id);
    const confirmed = await store!.confirm(second.id, id);
    await store!.execute(confirmed.attestation!, id, realExecutor!);
    expect(await transferCount(db, householdId)).toBe(1);
    expect(await balanceOf(db, from.id)).toBe(95_000);
    expect(await balanceOf(db, to.id)).toBe(55_000);
  }, 120_000);

  itIfDatabase('transfer fails closed for same account, foreign account and credit card with NO partial movement', async () => {
    const db = pool!;
    const householdId = await seedHousehold(db);
    const otherHouseholdId = await seedHousehold(db);
    const id = identityFor(householdId);
    const from = await writes!.createAccount(householdId, {
      name: 'E2E Transfer Guard From',
      kind: 'bank',
      initialBalanceCents: 100_000,
    });
    const foreign = await writes!.createAccount(otherHouseholdId, {
      name: 'E2E Foreign Destination',
      kind: 'bank',
      initialBalanceCents: 10_000,
    });
    const card = await db.query<{ id: string }>(
      `INSERT INTO accounts (household_id, name, kind, balance_cents, initial_balance_cents, status)
       VALUES ($1, 'E2E Card', 'credit_card', 0, 0, 'active') RETURNING id`,
      [householdId],
    );
    const cardId = card.rows[0]!.id;
    const base = {
      description: 'E2E guarded transfer',
      amountCents: 12_345,
      date: '2026-11-07',
      fromAccountId: from.id,
    };

    // Same account.
    await expect(
      writes!.createTransfer(householdId, { ...base, toAccountId: from.id }),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
    // Foreign-workspace destination.
    await expect(
      writes!.createTransfer(householdId, { ...base, toAccountId: foreign.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Credit card on either side keeps the existing restriction.
    await expect(
      writes!.createTransfer(householdId, { ...base, toAccountId: cardId }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      writes!.createTransfer(householdId, { ...base, fromAccountId: cardId, toAccountId: from.id }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // No partial movement and no row from any failed attempt.
    expect(await transactionCount(db, householdId)).toBe(0);
    expect(await balanceOf(db, from.id)).toBe(100_000);
    expect(await balanceOf(db, foreign.id)).toBe(10_000);
    expect(await balanceOf(db, cardId)).toBe(0);

    // A direct executor attempt with a foreign destination is deterministic
    // (pre-write DomainError) — never `executing`/uncertain.
    const proposed = await proposeOp(store!, id, 'transactions.transfer.create', {
      ...base,
      toAccountId: foreign.id,
    });
    const confirmed = await store!.confirm(proposed.id, id);
    await expect(store!.execute(confirmed.attestation!, id, realExecutor!)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await transactionCount(db, householdId)).toBe(0);
    expect(await balanceOf(db, from.id)).toBe(100_000);
  }, 120_000);
});
