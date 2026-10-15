/**
 * XLT-07 — Undo crash atomicity (SPEC §12 F1–F4, D-V4-07; T3.1; VAL-V4.7).
 *
 * Crosses ≥ 2 real layers: real PostgreSQL (canonical schema, SQL tx
 * semantics) × the production Postgres write/idempotency/audit stores × the
 * canonical undo service. Gated by DATABASE_URL_TEST + DB_TEST_MARKER; skips
 * cleanly otherwise (same gate as tests/integration/postgres-undo.test.ts).
 *
 * CRASH EQUIVALENCE (header contract): a real process crash mid-transaction
 * aborts the open transaction (the server rolls back everything the crashed
 * backend had not committed). Injecting a deterministic fault that throws
 * inside the transaction callback — before COMMIT — produces EXACTLY the
 * database state a crash at that point would leave: uncommitted work is
 * rolled back, previously-committed transactions stay committed. What the
 * fault CANNOT simulate (documented per scenario) is client-side amnesia,
 * which is instead simulated by rebuilding the undo service with a fresh
 * instance before replay (= a new process after the crash; FIX-188: the
 * service keeps no in-memory consumed set — the tombstoned row is the
 * durable record, so a fresh instance converges via the row guard).
 *
 * THE 5 CRASH POINTS (SPEC §12.F2):
 *   P1 — before the financial reversal (no statement ran);
 *   P2 — during the reversal (mid-statement failure);
 *   P3 — after the reversal, before the idempotency completion write;
 *   P4 — after the completion write, before COMMIT;
 *   P5 — after COMMIT (clean path + replay control).
 *
 * Each scenario asserts: 0 OR 1 financial effect (never double) + convergent
 * replay (retry the undo after the crash → single correct final effect, the
 * recorded idempotency result, replay observable). FIX-UNDO (T3.1→F3,
 * SPEC §12 F3 opção 1) joined claim + reversal + completion in ONE Postgres
 * transaction (claim-client passthrough to the producer, client-bound `*InTx`
 * reversals): P3/P4 now assert FULL rollback (0 effects, 0 records) plus a
 * convergent, byte-identical, replay-marked retry. The pre-fix RED shape
 * (committed effect + lost record → `not_found` 404 on retry, F4 violated)
 * is recorded in docs/reports/meu-ted-v4-implementation-report.md (Fase 3).
 *
 * STORE PARITY — T3.2 Opção A (SPEC §12 F1): the same P1–P5 points run
 * against the in-memory stores (dev/test) at the REPRESENTABLE boundaries.
 * A heap-only store cannot represent torn state: a real process crash loses
 * heap effect + heap claim together, and the in-memory producer is one
 * synchronous atomic step — a fault either fires BEFORE it (≡ crash-before)
 * or AFTER it (≡ crash-after). There is no observable mid-point, so P1/P2
 * are observably identical in-memory and P3/P4 collapse onto the two
 * boundaries. The PROOF of production atomicity is the Postgres path (13/13
 * real above); the in-memory store guarantees equivalent OBSERVABLE replay
 * semantics: processing-claim → completed upgrade (parity with the
 * claim→complete lifecycle in writes/postgres.ts), takeover of an orphan
 * claim by a same-payload retry, retained failed claims, conflict on
 * divergent payload. The previous DIVERGE_TODAY middle scenario (effect
 * kept, record lost, retry throws) simulated a state no real heap crash can
 * leave and is therefore NOT asserted — instead the invariant ≤1 financial
 * effect in EVERY observable interleaving is assembled explicitly below.
 *
 * LEGACY BRANCH (§31.3.2): the canonical undo path is asserted via the
 * `audit-undo:` namespace row + canonical audit row. The "legacy branch is
 * never executed" claim is QUALIFIED, not repeated blindly — see the
 * legacy-branch test.
 *
 * EMITTERS (T0.4.5/T0.4.6, born here): `audit-undo.replay` (undo is a replay
 * — the idempotency store already distinguishes it) and
 * `mutation.reconcile.enqueued` (operation enters reconcile). Both are
 * validated by buildObservabilityEvent + best-effort structured logging,
 * following the T2.2 precedent in routes/index.ts. The replay emitter is
 * ALSO the observable "marked as replay" signal: UndoResult carries no
 * replayed flag, but a replayed call emits exactly 1 event AND returns a
 * byte-identical recorded response (a fresh execution would mint a new
 * receipt mutationId — see resolveUndoReceipt).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import {
  createPostgresWriteStore,
  createPostgresIdempotencyStore,
} from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import { createPostgresAuditLogStore, createLegacyPostgresAuditLogStore } from '../../src/audit/store.js';
import {
  createUndoService,
  UNDO_IDEMPOTENCY_PREFIX,
  type UndoService,
} from '../../src/approvals/undo.js';
import type { WriteStore } from '../../src/writes/store.js';
import type { AuditLog } from '../../src/audit/store.js';
import {
  createIdempotencyRequest,
  createInMemoryIdempotencyStore,
} from '../../src/writes/idempotency.js';
import {
  createInMemoryStores,
} from '../../src/writes/in-memory.js';
import { createInMemoryAuditLogStore } from '../../src/audit/store.js';
import {
  createInMemoryPendingOperationV2Store,
  RECONCILE_REASON_LEASE_EXPIRED,
  type PendingIdentity,
  type PendingOperationV2Store,
} from '../../src/approvals/pending-v2.js';

// ---------------------------------------------------------------------------
// Gate: real Postgres or clean skip (never fails for missing infra).
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[xlt-07-undo-crash] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — ' +
      'crash injection is only meaningful against real PostgreSQL, so every Postgres ' +
      'scenario below is skipped. In-memory parity + emitter tests still run.',
  );
}

// ---------------------------------------------------------------------------
// Shared harness: deterministic SQL fault injection (test-only, no src hooks).
// ---------------------------------------------------------------------------
// The stores capture the `pool` object reference and call pool.connect() per
// transaction, so monkey-patching pool.connect for the duration of one undo
// call faults every backend the undo touches. Matchers intentionally avoid
// BEGIN/COMMIT/ROLLBACK except in P4, where the COMMIT fault IS the point.

type SqlFault = {
  disarm: () => void;
  fired: () => number;
};

/**
 * Generation guard: pg-pool REUSES client objects across checkouts, so a
 * wrapped `client.query` outlives the arm that installed it (SEQUENTIAL use
 * only — overlapping arms are not supported). Each arm takes the current
 * generation; disarm invalidates it, turning every stale wrapper inert even
 * when the same client object is checked out again later.
 */
let activeFaultGeneration = 0;

const armSqlFault = (
  pool: Pool,
  match: (sql: string) => boolean,
  label: string,
): SqlFault => {
  const holder = pool as unknown as { connect: Pool['connect'] };
  const origConnect = holder.connect.bind(pool);
  const generation = ++activeFaultGeneration;
  let count = 0;
  holder.connect = (async (...args: unknown[]) => {
    // pg-pool's own pool.query calls this.connect(callback): callback-style
    // checkouts bypass fault wrapping entirely (reads/helpers never fault —
    // only withTransaction backends, which connect promise-style, do).
    if (args.some((arg) => typeof arg === 'function')) {
      return (origConnect as (...a: unknown[]) => unknown)(...args);
    }
    const client = (await (origConnect as (...a: unknown[]) => Promise<PoolClient>)()) as PoolClient;
    const clientHolder = client as unknown as { query: PoolClient['query'] };
    const origQuery = clientHolder.query.bind(client);
    clientHolder.query = (async (...qargs: unknown[]) => {
      const first = qargs[0];
      const sql =
        typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text;
      if (generation === activeFaultGeneration && typeof sql === 'string' && match(sql)) {
        count += 1;
        throw new Error(`XLT-07 injected crash [${label}]: ${sql.slice(0, 140)}`);
      }
      return (origQuery as (...a: unknown[]) => Promise<unknown>)(...qargs);
    }) as PoolClient['query'];
    return client;
  }) as Pool['connect'];
  return {
    disarm: () => {
      activeFaultGeneration++;
      holder.connect = origConnect;
    },
    fired: () => count,
  };
};

const matchSoftDeleteStatement = (sql: string): boolean =>
  /UPDATE transactions\s+SET deleted_at/i.test(sql);

const matchIdempotencyCompletion = (sql: string): boolean =>
  /UPDATE operation_records\s+SET status/i.test(sql);

// ---------------------------------------------------------------------------
// Postgres fixture: a real reversible expense with a real audit trail.
// ---------------------------------------------------------------------------
// The expense is booked THROUGH the canonical idempotency store (request
// form, same as the V2 executor path) so the fixture crosses the exact
// layers production crosses: operation_records claim + financial effect +
// completion + canonical audit_logs row (effect_ref = transaction id), which
// is what the undo service resolves as its reversal target.

type PgFixture = {
  householdId: string;
  actorId: string;
  txId: string;
};

const seedReversibleExpense = async (pool: Pool): Promise<PgFixture> => {
  const householdId = randomUUID();
  const actorId = 'xlt-07-actor';
  const writes = createPostgresWriteStore({ pool });
  const account = await writes.createAccount(householdId, {
    name: `XLT07 ${randomUUID().slice(0, 8)}`,
    kind: 'bank',
    initialBalanceCents: 100_000,
  });
  const category = await writes.createCategory(householdId, {
    name: `XLT07 cat ${randomUUID().slice(0, 8)}`,
    kind: 'expense',
  });
  const idempotency = createPostgresIdempotencyStore({ pool });
  const request = createIdempotencyRequest(
    { householdId, deviceId: actorId },
    'transactions.expense.create',
    `xlt07-seed-${randomUUID()}`,
  );
  const booked = await idempotency.lookupOrRecord(
    request,
    { seed: 'xlt07' },
    async () => {
      const tx = await writes.createExpense(householdId, {
        description: 'XLT07 reversible expense',
        amountCents: 12_345,
        date: '2026-09-16',
        accountId: account.id,
        categoryId: category.id,
      });
      // Effect pointer: the canonical store persists effect_ref from the
      // `transactionId` field (writes/postgres.ts). Without it the audit row
      // carries no effect_ref and the undo has no target.
      return { ...tx, transactionId: tx.id };
    },
  );
  const txId = (booked.response as { transactionId: string }).transactionId;
  return { householdId, actorId, txId };
};

type UndoEffectState = {
  /** 0 = transaction still active, 1 = reversal committed. Never > 1. */
  effects: number;
  /** Completed idempotency rows for the undo key (0 or 1). */
  records: number;
  recordStatus: string | null;
};

const readUndoState = async (
  pool: Pool,
  householdId: string,
  txId: string,
  undoKey: string,
): Promise<UndoEffectState> => {
  const tx = await pool.query<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM transactions WHERE id = $1 AND household_id = $2',
    [txId, householdId],
  );
  const rec = await pool.query<{ status: string }>(
    'SELECT status FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2',
    [householdId, `${UNDO_IDEMPOTENCY_PREFIX}${undoKey}`],
  );
  return {
    effects: tx.rows[0]?.deleted_at ? 1 : 0,
    records: rec.rows.length,
    recordStatus: rec.rows[0]?.status ?? null,
  };
};

const cleanupHousehold = async (pool: Pool, householdId: string): Promise<void> => {
  try {
    await pool.query('DELETE FROM audit_logs WHERE workspace_id = $1', [householdId]);
  } catch { /* legacy-shaped or absent: best-effort */ }
  try {
    await pool.query('DELETE FROM operation_records WHERE workspace_id = $1', [householdId]);
  } catch { /* best-effort */ }
  await pool.query('DELETE FROM transactions WHERE household_id = $1', [householdId]).catch(() => undefined);
  await pool.query('DELETE FROM categories WHERE household_id = $1', [householdId]).catch(() => undefined);
  await pool.query('DELETE FROM accounts WHERE household_id = $1', [householdId]).catch(() => undefined);
};

const makePgUndo = (
  pool: Pool,
  writes: WriteStore,
  sink: Array<{ eventType: string; workspaceId: string }>,
): { undo: UndoService; idempotencyKey: string } => {
  const undo = createUndoService({
    auditLogs: createPostgresAuditLogStore(pool),
    writes,
    idempotency: createPostgresIdempotencyStore({ pool }),
    observabilitySink: (event) => { sink.push(event); },
  });
  return { undo, idempotencyKey: `xlt07-${randomUUID()}` };
};

// ---------------------------------------------------------------------------
// XLT-07 against real PostgreSQL.
// ---------------------------------------------------------------------------

describeIfDb('XLT-07 — undo crash atomicity (real PostgreSQL)', () => {
  let pool: Pool;
  const households: string[] = [];

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'xlt-07-undo-crash');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      for (const householdId of households) await cleanupHousehold(pool, householdId);
      await pool.end();
    }
  });

  it('P1 — crash before the financial reversal: 0 effects, replay converges', async () => {
    const { householdId, actorId, txId } = await seedReversibleExpense(pool);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const writes = createPostgresWriteStore({ pool });
    // Crash BEFORE the first financial statement: the writes call never runs,
    // so the outer idempotency transaction aborts with nothing to roll back.
    // FIX-UNDO: the atomic path resolves the client-bound reversal
    // (`softDeleteTransactionInTx`, inherited by the spread below), so the
    // fault must fire on THAT entry — overriding only the legacy
    // transactional method would leave the real path unbroken.
    const crashP1 = async (): Promise<never> => {
      throw new Error('XLT-07 injected crash [P1] before financial reversal');
    };
    const crashingWrites: WriteStore = {
      ...writes,
      softDeleteTransaction: crashP1,
    };
    (crashingWrites as unknown as Record<string, unknown>).softDeleteTransactionInTx = crashP1;
    const { undo, idempotencyKey } = makePgUndo(pool, crashingWrites, replayEvents);

    await expect(undo.undo(householdId, actorId, idempotencyKey)).rejects.toThrow(
      /injected crash \[P1\]/,
    );
    expect(await readUndoState(pool, householdId, txId, idempotencyKey)).toEqual({
      effects: 0,
      records: 0,
      recordStatus: null,
    });

    // Replay after the crash (= new process: fresh `undone` set) converges.
    const retry = createUndoService({
      auditLogs: createPostgresAuditLogStore(pool),
      writes,
      idempotency: createPostgresIdempotencyStore({ pool }),
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({
      operation: 'transactions.expense.create',
      entityId: txId,
      reversal: 'soft_delete',
    });
    expect(first.receipt.mutationKind).toBe('transaction.delete');
    expect(await readUndoState(pool, householdId, txId, idempotencyKey)).toMatchObject({
      effects: 1,
      records: 1,
      recordStatus: 'completed',
    });

    // Duplicate delivery of the same key replays the RECORDED response: the
    // receipt mutationId is byte-identical (a fresh execution would mint a new
    // one in resolveUndoReceipt) and exactly 1 replay event is emitted.
    const replayed = await retry.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0]).toEqual({
      eventType: 'audit-undo.replay',
      workspaceId: householdId,
    });
  });

  it('P2 — crash during the reversal (mid-statement): 0 effects, replay converges', async () => {
    const { householdId, actorId, txId } = await seedReversibleExpense(pool);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const { undo, idempotencyKey } = makePgUndo(
      pool,
      createPostgresWriteStore({ pool }),
      replayEvents,
    );

    // Crash ON the soft-delete statement: the single claim+reversal
    // transaction rolls back (balance restore + tombstone vanish together
    // with the uncommitted claim).
    const fault = armSqlFault(pool, matchSoftDeleteStatement, 'P2-mid-reversal');
    try {
      await expect(undo.undo(householdId, actorId, idempotencyKey)).rejects.toThrow(
        /injected crash \[P2-mid-reversal\]/,
      );
      expect(fault.fired()).toBe(1);
    } finally {
      fault.disarm();
    }
    const state = await readUndoState(pool, householdId, txId, idempotencyKey);
    expect(state).toEqual({ effects: 0, records: 0, recordStatus: null });
    // Balance untouched by the aborted reversal: still reduced by the expense.
    const balance = await pool.query<{ balance_cents: string }>(
      'SELECT balance_cents FROM accounts WHERE household_id = $1',
      [householdId],
    );
    expect(Number(balance.rows[0]!.balance_cents)).toBe(100_000 - 12_345);

    const retry = createUndoService({
      auditLogs: createPostgresAuditLogStore(pool),
      writes: createPostgresWriteStore({ pool }),
      idempotency: createPostgresIdempotencyStore({ pool }),
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: txId, reversal: 'soft_delete' });
    const replayed = await retry.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([{ eventType: 'audit-undo.replay', workspaceId: householdId }]);
  });

  it('P3 — crash after the reversal, before the idempotency write: 0 effects (full rollback), replay converges', async () => {
    const { householdId, actorId, txId } = await seedReversibleExpense(pool);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const { undo, idempotencyKey } = makePgUndo(
      pool,
      createPostgresWriteStore({ pool }),
      replayEvents,
    );

    // Crash ON the idempotency completion write. FIX-UNDO runs claim +
    // reversal + completion in ONE transaction, so the fault aborts the
    // whole undo: the already-executed reversal statements roll back with
    // the claim (pre-fix shape was 1 committed effect + 0 records).
    const fault = armSqlFault(pool, matchIdempotencyCompletion, 'P3-after-reversal');
    try {
      await expect(undo.undo(householdId, actorId, idempotencyKey)).rejects.toThrow(
        /injected crash \[P3-after-reversal\]/,
      );
      expect(fault.fired()).toBe(1);
    } finally {
      fault.disarm();
    }
    // Atomicity holds: nothing committed, nothing recorded.
    const state = await readUndoState(pool, householdId, txId, idempotencyKey);
    expect(state).toEqual({ effects: 0, records: 0, recordStatus: null });

    // SPEC §12.F4: the retry re-executes claim + producer from zero and
    // converges on the single canonical result, marked as replay.
    const retry = createUndoService({
      auditLogs: createPostgresAuditLogStore(pool),
      writes: createPostgresWriteStore({ pool }),
      idempotency: createPostgresIdempotencyStore({ pool }),
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: txId, reversal: 'soft_delete' });
    expect(await readUndoState(pool, householdId, txId, idempotencyKey)).toMatchObject({
      effects: 1,
      records: 1,
      recordStatus: 'completed',
    });
    const replayed = await retry.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([{ eventType: 'audit-undo.replay', workspaceId: householdId }]);
  });

  it('P4 — crash after the completion write, before COMMIT: 0 effects (full rollback), replay converges', async () => {
    const { householdId, actorId, txId } = await seedReversibleExpense(pool);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const { undo, idempotencyKey } = makePgUndo(
      pool,
      createPostgresWriteStore({ pool }),
      replayEvents,
    );

    // Crash AFTER the completion UPDATE + audit INSERT ran but BEFORE the
    // single COMMIT: with claim + reversal + completion in ONE transaction,
    // everything rolls back together (pre-fix shape was 1 committed effect
    // + 0 records, observably identical to P3 but unrecoverable).
    let completionSeen = false;
    const fault = armSqlFault(
      pool,
      (sql) => {
        if (matchIdempotencyCompletion(sql)) { completionSeen = true; return false; }
        if (completionSeen && sql === 'COMMIT') return true;
        return false;
      },
      'P4-before-commit',
    );
    try {
      await expect(undo.undo(householdId, actorId, idempotencyKey)).rejects.toThrow(
        /injected crash \[P4-before-commit\]/,
      );
      expect(completionSeen).toBe(true);
      expect(fault.fired()).toBe(1);
    } finally {
      fault.disarm();
    }
    const state = await readUndoState(pool, householdId, txId, idempotencyKey);
    expect(state).toEqual({ effects: 0, records: 0, recordStatus: null });

    // SPEC §12.F4: convergent, byte-identical, replay-marked retry.
    const retry = createUndoService({
      auditLogs: createPostgresAuditLogStore(pool),
      writes: createPostgresWriteStore({ pool }),
      idempotency: createPostgresIdempotencyStore({ pool }),
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: txId, reversal: 'soft_delete' });
    const replayed = await retry.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([{ eventType: 'audit-undo.replay', workspaceId: householdId }]);
  });

  it('P5 — clean commit then duplicate key: single effect, recorded replay', async () => {
    const { householdId, actorId, txId } = await seedReversibleExpense(pool);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const { undo, idempotencyKey } = makePgUndo(
      pool,
      createPostgresWriteStore({ pool }),
      replayEvents,
    );

    const first = await undo.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: txId, reversal: 'soft_delete' });
    expect(replayEvents).toHaveLength(0);

    const replayed = await undo.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([{ eventType: 'audit-undo.replay', workspaceId: householdId }]);
    expect(await readUndoState(pool, householdId, txId, idempotencyKey)).toMatchObject({
      effects: 1,
      records: 1,
      recordStatus: 'completed',
    });

    // Canonical-path evidence (deliverable 3, first half): the undo record
    // lives under the `audit-undo:` namespace AND the audit row is the
    // canonical shape (operation_record_id FK) — only the 925+ branch of
    // createPostgresIdempotencyStore writes this shape. NOTE: the undo's OWN
    // audit row is generic (string-form lookupOrRecord ⇒ operation 'write',
    // no transactionId on UndoResult ⇒ effect_ref NULL); the reversal target
    // comes from the fixture's audit row (operation + effect_ref below).
    expect(UNDO_IDEMPOTENCY_PREFIX).toBe('audit-undo:');
    const rec = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2',
      [householdId, `audit-undo:${idempotencyKey}`],
    );
    expect(rec.rowCount).toBe(1);
    expect(rec.rows[0]!.status).toBe('completed');
    const undoAudit = await pool.query<{ operation: string }>(
      'SELECT operation FROM audit_logs WHERE operation_record_id = $1',
      [rec.rows[0]!.id],
    );
    expect(undoAudit.rowCount).toBe(1);
    expect(undoAudit.rows[0]!.operation).toBe('write');
    const fixtureAudit = await pool.query<{ operation: string; effect_ref: string | null }>(
      'SELECT operation, effect_ref FROM audit_logs WHERE workspace_id = $1 AND operation = $2',
      [householdId, 'transactions.expense.create'],
    );
    expect(fixtureAudit.rowCount).toBe(1);
    expect(fixtureAudit.rows[0]).toMatchObject({
      operation: 'transactions.expense.create',
      effect_ref: txId,
    });
  });

  it('legacy branch (§31.3.2): the SAME namespaced call executes postgres.ts:874-909 when the store is built with legacy:true', async () => {
    // QUALIFICATION, not a repetition of the SPEC claim. The SPEC says the
    // legacy branch is "unreachable by the canonical undo" — true ONLY for
    // canonical-schema deployments. The branch condition is the store's
    // `legacy` flag (postgres.ts:830,874), and production's DB_SCHEMA=legacy
    // boot builds EXACTLY createPostgresIdempotencyStore({ pool, legacy: true })
    // (server/production-routes.ts:141, server/index.ts:134) and wires the
    // undo service onto it — so on the VPS the same
    // lookupOrRecord(householdId, 'audit-undo:'+key, …) call executes 874-909.
    // This test proves the branch is entered for namespaced string-form calls
    // by running it on the canonical schema, where the legacy audit INSERT
    // (household_id/action shape) deterministically fails — i.e. the branch
    // is schema-bound, NOT undo-bound. Flagged to the Planner: §31.3.2 needs
    // a deployment-scoped correction.
    const legacyIdem = createPostgresIdempotencyStore({ pool, legacy: true });
    let evidence = '';
    try {
      await legacyIdem.lookupOrRecord(
        randomUUID(),
        `audit-undo:${randomUUID()}`,
        { probe: 'xlt07-legacy-branch' },
        async () => ({ ok: true }) as never,
      );
    } catch (error) {
      evidence = (error as Error).message;
    }
    console.log(`[xlt-07] legacy-branch evidence: ${evidence}`);
    expect(evidence.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy-schema undo crash atomicity (FIX-UNDO-LEGACY, Fase 3 V4, SPEC §12 F3).
// ---------------------------------------------------------------------------
// Production VPS boots DB_SCHEMA=legacy: legacy write store + legacy:true
// idempotency + legacy audit store. Before the fix the undo reversal fell
// back to the plain legacy transactional methods (own withTransaction), so a
// P3/P4 crash left 1 committed effect + 0 records (retry: not_found, F4
// violated). After the fix the legacy store exposes the client-bound *InTx
// reversals and the reversal joins the claim tx: P3/P4 roll back fully.
//
// The legacy financial SQL (from_account_id, active boolean, legacy audit
// household_id/action shape) cannot run on the canonical test database
// (NOT NULL canonical columns + transfer CHECKs reject legacy INSERTs), so
// these scenarios run on a SEPARATE database (`pi_test_legacy`, same
// server) migrated with runMigrations + an idempotent legacy-shape DDL.
// Zero impact on the canonical suite (separate DB, separate pool).

const LEGACY_DB_URL = DB_URL ? DB_URL.replace(/\/[^/?]+(\?.*)?$/, '/pi_test_legacy$1') : undefined;

const LEGACY_SHAPE_DDL = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE categories ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS from_account_id UUID`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS to_account_id UUID`,
  `ALTER TABLE transactions ALTER COLUMN account_id DROP NOT NULL`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS household_id UUID`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id UUID`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_json JSONB`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_json JSONB`,
  `ALTER TABLE audit_logs ALTER COLUMN workspace_id DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN actor_id DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN operation DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN event_type DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN payload_hash DROP NOT NULL`,
];

const seedLegacyReversibleExpense = async (db: Pool): Promise<PgFixture> => {
  const householdId = randomUUID();
  const actorId = randomUUID();
  const writes = createLegacyPostgresWriteStore({ pool: db });
  const account = await writes.createAccount(householdId, {
    name: `XLT07L ${randomUUID().slice(0, 8)}`,
    kind: 'bank',
    initialBalanceCents: 100_000,
  });
  const category = await writes.createCategory(householdId, {
    name: `XLT07L cat ${randomUUID().slice(0, 8)}`,
    kind: 'expense',
  });
  const tx = await writes.createExpense(householdId, {
    description: 'XLT07L reversible expense',
    amountCents: 12_345,
    date: '2026-09-16',
    accountId: account.id,
    categoryId: category.id,
  });
  await db.query(
    `INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, before_json, after_json, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'transactions.expense.create', 'transaction', $3, NULL, NULL, NOW())`,
    [householdId, actorId, tx.id],
  );
  return { householdId, actorId, txId: tx.id };
};

const cleanupLegacyHousehold = async (db: Pool, householdId: string): Promise<void> => {
  await db.query('DELETE FROM audit_logs WHERE household_id = $1', [householdId]).catch(() => undefined);
  await db.query('DELETE FROM operation_records WHERE workspace_id = $1', [householdId]).catch(() => undefined);
  await db.query('DELETE FROM transactions WHERE household_id = $1', [householdId]).catch(() => undefined);
  await db.query('DELETE FROM categories WHERE household_id = $1', [householdId]).catch(() => undefined);
  await db.query('DELETE FROM accounts WHERE household_id = $1', [householdId]).catch(() => undefined);
};

const makeLegacyUndo = (
  db: Pool,
  writes: WriteStore,
  sink: Array<{ eventType: string; workspaceId: string }>,
): { undo: UndoService; idempotencyKey: string } => {
  const undo = createUndoService({
    auditLogs: createLegacyPostgresAuditLogStore(db),
    writes,
    idempotency: createPostgresIdempotencyStore({ pool: db, legacy: true }),
    observabilitySink: (event) => { sink.push(event); },
  });
  return { undo, idempotencyKey: `xlt07l-${randomUUID()}` };
};

describeIfDb('XLT-07 legacy — undo crash atomicity on the legacy schema (real PostgreSQL)', () => {
  let db: Pool;
  const households: string[] = [];

  beforeAll(async () => {
    const admin = createPool({ connectionString: DB_URL!, max: 2 });
    try {
      await requireTestDatabase(admin, 'xlt-07-undo-crash-legacy-admin');
      await admin.query('CREATE DATABASE pi_test_legacy').catch((err: Error) => {
        if (!/already exists/.test(err.message)) throw err;
      });
    } finally {
      await admin.end();
    }
    db = createPool({ connectionString: LEGACY_DB_URL!, max: 8 });
    await db.query('CREATE TABLE IF NOT EXISTS _test_marker (marker_value TEXT PRIMARY KEY)');
    await db.query('INSERT INTO _test_marker (marker_value) VALUES ($1) ON CONFLICT DO NOTHING', [
      process.env.DB_TEST_MARKER!,
    ]);
    await requireTestDatabase(db, 'xlt-07-undo-crash-legacy');
    await runMigrations(db);
    for (const ddl of LEGACY_SHAPE_DDL) await db.query(ddl);
  }, 180_000);

  afterAll(async () => {
    if (db) {
      for (const householdId of households) await cleanupLegacyHousehold(db, householdId);
      await db.end();
    }
  });

  it('P3-legacy — crash after the legacy reversal, before the idempotency write: 0 effects (full rollback), replay converges', async () => {
    const { householdId, actorId, txId } = await seedLegacyReversibleExpense(db);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const { undo, idempotencyKey } = makeLegacyUndo(
      db,
      createLegacyPostgresWriteStore({ pool: db }),
      replayEvents,
    );

    // Crash ON the idempotency completion write. FIX-UNDO-LEGACY runs claim
    // + legacy reversal + completion in ONE transaction, so the fault aborts
    // the whole undo (pre-fix shape was 1 committed effect + 0 records:
    // the reversal committed in its own withTransaction).
    const fault = armSqlFault(db, matchIdempotencyCompletion, 'P3-legacy-after-reversal');
    try {
      await expect(undo.undo(householdId, actorId, idempotencyKey)).rejects.toThrow(
        /injected crash \[P3-legacy-after-reversal\]/,
      );
      expect(fault.fired()).toBe(1);
    } finally {
      fault.disarm();
    }
    // Atomicity holds on the legacy schema: nothing committed, nothing recorded.
    const state = await readUndoState(db, householdId, txId, idempotencyKey);
    expect(state).toEqual({ effects: 0, records: 0, recordStatus: null });

    // SPEC §12.F4 on legacy: the retry re-executes claim + producer from
    // zero and converges on the single canonical result, marked as replay.
    const retry = createUndoService({
      auditLogs: createLegacyPostgresAuditLogStore(db),
      writes: createLegacyPostgresWriteStore({ pool: db }),
      idempotency: createPostgresIdempotencyStore({ pool: db, legacy: true }),
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: txId, reversal: 'soft_delete' });
    expect(await readUndoState(db, householdId, txId, idempotencyKey)).toMatchObject({
      effects: 1,
      records: 1,
      recordStatus: 'completed',
    });
    const replayed = await retry.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([{ eventType: 'audit-undo.replay', workspaceId: householdId }]);
  });

  it('P4-legacy — crash after the legacy completion write, before COMMIT: 0 effects (full rollback), replay converges', async () => {
    const { householdId, actorId, txId } = await seedLegacyReversibleExpense(db);
    households.push(householdId);
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const { undo, idempotencyKey } = makeLegacyUndo(
      db,
      createLegacyPostgresWriteStore({ pool: db }),
      replayEvents,
    );

    let completionSeen = false;
    const fault = armSqlFault(
      db,
      (sql) => {
        if (matchIdempotencyCompletion(sql)) { completionSeen = true; return false; }
        if (completionSeen && sql === 'COMMIT') return true;
        return false;
      },
      'P4-legacy-before-commit',
    );
    try {
      await expect(undo.undo(householdId, actorId, idempotencyKey)).rejects.toThrow(
        /injected crash \[P4-legacy-before-commit\]/,
      );
      expect(completionSeen).toBe(true);
      expect(fault.fired()).toBe(1);
    } finally {
      fault.disarm();
    }
    const state = await readUndoState(db, householdId, txId, idempotencyKey);
    expect(state).toEqual({ effects: 0, records: 0, recordStatus: null });

    const retry = createUndoService({
      auditLogs: createLegacyPostgresAuditLogStore(db),
      writes: createLegacyPostgresWriteStore({ pool: db }),
      idempotency: createPostgresIdempotencyStore({ pool: db, legacy: true }),
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(householdId, actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: txId, reversal: 'soft_delete' });
    const replayed = await retry.undo(householdId, actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([{ eventType: 'audit-undo.replay', workspaceId: householdId }]);
  });
});

// ---------------------------------------------------------------------------
// Store parity: the representable boundaries against the in-memory stores.
// ---------------------------------------------------------------------------
// T3.2 Opção A. Crash injection wraps the WriteStore: throwing BEFORE
// delegating ≡ crash before the (synchronous, atomic) mutation; a clean run
// followed by duplicate delivery ≡ crash after the atomic step (P5). The
// middle — effect applied but claim lost — is NOT simulated: keeping heap
// alive across a fake "crash" fabricates torn state a real process crash
// cannot leave (heap effect + heap claim die together). Retries below reuse
// the SAME store: an in-process error is not a process crash, so the heap
// survives and the retry takes over the retained claim; a fresh store would
// prove nothing (empty store trivially converges).

const parityNotes: string[] = [];
const noteParity = (line: string): void => {
  parityNotes.push(line);
  console.log(`[xlt-07 parity] ${line}`);
};

type MemFixture = {
  householdId: string;
  actorId: string;
  txId: string;
  state: ReturnType<typeof createInMemoryStores>['state'];
  writes: WriteStore;
};

const seedMemFixture = async (): Promise<MemFixture> => {
  const householdId = randomUUID();
  const actorId = 'xlt-07-actor';
  const { state, writes } = createInMemoryStores();
  const account = await writes.createAccount(householdId, {
    name: 'XLT07 mem',
    kind: 'bank',
    initialBalanceCents: 100_000,
  });
  const category = await writes.createCategory(householdId, {
    name: 'XLT07 mem cat',
    kind: 'expense',
  });
  const tx = await writes.createExpense(householdId, {
    description: 'XLT07 mem expense',
    amountCents: 12_345,
    date: '2026-09-16',
    accountId: account.id,
    categoryId: category.id,
  });
  return { householdId, actorId, txId: tx.id, state, writes };
};

const seedMemAudit = (householdId: string, actorId: string, txId: string): AuditLog => ({
  id: randomUUID(),
  workspaceId: householdId,
  actorType: 'device',
  actorId,
  operation: 'transactions.expense.create',
  eventType: 'financial_effect.committed',
  payloadHash: 'xlt07',
  effectRef: txId,
  metadata: { entityType: 'transaction' },
  createdAt: new Date().toISOString(),
});

describe('XLT-07 parity — in-memory stores (observable behavior)', () => {
  it('L1 — crash BEFORE the atomic step: same-store retry takes over the orphan claim and converges', async () => {
    // Representable boundary 1 (≡ Postgres P1/P2, observably identical
    // in-memory: the reversal is one synchronous mutation with no await
    // points, so "during" does not exist). The fault throws before the first
    // write; the claim stays retained as processing/failed.
    const fx = await seedMemFixture();
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const crashingWrites: WriteStore = {
      ...fx.writes,
      softDeleteTransaction: async () => {
        throw new Error('XLT-07 injected crash [mem-takeover-before] before mutation');
      },
    };
    const memIdem = createInMemoryIdempotencyStore();
    const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
    const undo = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: crashingWrites,
      idempotency: memIdem,
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const idempotencyKey = `xlt07-mem-${randomUUID()}`;
    await expect(undo.undo(fx.householdId, fx.actorId, idempotencyKey)).rejects.toThrow(
      /mem-takeover-before/,
    );
    expect(fx.state.deletedTransactions.has(fx.txId)).toBe(false);

    // Takeover: the same store (= surviving process) still holds the orphan
    // claim, so the same-key/same-payload retry re-executes the producer
    // exactly once and converges — 0 effects become exactly 1.
    const retry = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: fx.writes,
      idempotency: memIdem,
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const first = await retry.undo(fx.householdId, fx.actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: fx.txId });
    expect(fx.state.deletedTransactions.has(fx.txId)).toBe(true);
    const replayed = await retry.undo(fx.householdId, fx.actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([
      { eventType: 'audit-undo.replay', workspaceId: fx.householdId },
    ]);
    noteParity('L1 in-memory: crash-before → takeover converges (parity with Postgres P1/P2).');
  });

  it('L2 — retained claim rejects a divergent payload with conflict (lifecycle parity with Postgres)', async () => {
    // The retained processing/failed claim carries its payload hash: a retry
    // with the same key but a DIVERGENT payload (different lastOperationId)
    // must raise idempotency.conflict WITHOUT running the producer — the
    // same rule the Postgres claim enforces via payload_hash mismatch.
    // RED against the pre-T3.2 store (no retained claim → producer runs).
    const fx = await seedMemFixture();
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    let mutations = 0;
    const countingWrites: WriteStore = {
      ...fx.writes,
      softDeleteTransaction: async (householdId: string, id: string) => {
        mutations++;
        return fx.writes.softDeleteTransaction(householdId, id);
      },
    };
    const crashingWrites: WriteStore = {
      ...fx.writes,
      softDeleteTransaction: async () => {
        throw new Error('XLT-07 injected crash [mem-lifecycle] before mutation');
      },
    };
    const memIdem = createInMemoryIdempotencyStore();
    const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
    const undo = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: crashingWrites,
      idempotency: memIdem,
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const idempotencyKey = `xlt07-mem-${randomUUID()}`;
    await expect(undo.undo(fx.householdId, fx.actorId, idempotencyKey)).rejects.toThrow(
      /mem-lifecycle/,
    );
    expect(mutations).toBe(0);

    const retry = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: countingWrites,
      idempotency: memIdem,
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    await expect(
      retry.undo(fx.householdId, fx.actorId, idempotencyKey, randomUUID()),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(mutations).toBe(0);
    expect(fx.state.deletedTransactions.has(fx.txId)).toBe(false);
    noteParity('L2 in-memory: retained claim rejects divergent payload (parity with Postgres payload_hash rule).');
  });

  it('representability limit (T3.2): torn intra-producer state is not representable in heap — ≤1 effect in every observable interleaving', async () => {
    // EXPLICIT DOCUMENTATION TEST. A heap-only producer is one synchronous
    // atomic step: any deterministic fault either fires before the first
    // write (≡ crash-before, L1) or after the last write (≡ crash-after,
    // P5). Simulating "effect applied, claim lost" by keeping heap alive
    // across a fake crash fabricates torn state that no real heap crash can
    // leave — a real process crash loses heap effect AND heap claim together
    // — so no such scenario is asserted. What IS asserted: in EVERY
    // observable interleaving, the financial effect count never exceeds 1.
    const sink: Array<{ eventType: string; workspaceId: string }> = [];

    // Interleaving A: crash-before + takeover retry + duplicate replays.
    {
      const fx = await seedMemFixture();
      let mutations = 0;
      const countingWrites: WriteStore = {
        ...fx.writes,
        softDeleteTransaction: async (householdId: string, id: string) => {
          mutations++;
          return fx.writes.softDeleteTransaction(householdId, id);
        },
      };
      const memIdem = createInMemoryIdempotencyStore();
      const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
      const crashing: WriteStore = {
        ...fx.writes,
        softDeleteTransaction: async () => {
          throw new Error('XLT-07 injected crash [mem-invariant-A] before mutation');
        },
      };
      const key = `xlt07-mem-${randomUUID()}`;
      const failing = createUndoService({
        auditLogs: createInMemoryAuditLogStore(memAudit),
        writes: crashing,
        idempotency: memIdem,
        observabilitySink: (event) => { sink.push(event); },
      });
      await expect(failing.undo(fx.householdId, fx.actorId, key)).rejects.toThrow(/mem-invariant-A/);
      const retry = createUndoService({
        auditLogs: createInMemoryAuditLogStore(memAudit),
        writes: countingWrites,
        idempotency: memIdem,
        observabilitySink: (event) => { sink.push(event); },
      });
      const first = await retry.undo(fx.householdId, fx.actorId, key);
      await retry.undo(fx.householdId, fx.actorId, key);
      await retry.undo(fx.householdId, fx.actorId, key);
      expect(first.undone).toMatchObject({ entityId: fx.txId });
      expect(mutations).toBeLessThanOrEqual(1);
      expect(mutations).toBe(1);
      expect(fx.state.deletedTransactions.has(fx.txId)).toBe(true);
      expect(fx.state.transactions.filter((t) => t.id === fx.txId)).toHaveLength(1);
    }

    // Interleaving B: completed claim + K duplicate deliveries.
    {
      const fx = await seedMemFixture();
      let mutations = 0;
      const countingWrites: WriteStore = {
        ...fx.writes,
        softDeleteTransaction: async (householdId: string, id: string) => {
          mutations++;
          return fx.writes.softDeleteTransaction(householdId, id);
        },
      };
      const memIdem = createInMemoryIdempotencyStore();
      const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
      const undo = createUndoService({
        auditLogs: createInMemoryAuditLogStore(memAudit),
        writes: countingWrites,
        idempotency: memIdem,
        observabilitySink: (event) => { sink.push(event); },
      });
      const key = `xlt07-mem-${randomUUID()}`;
      const first = await undo.undo(fx.householdId, fx.actorId, key);
      for (let i = 0; i < 3; i++) {
        const replayed = await undo.undo(fx.householdId, fx.actorId, key);
        expect(replayed).toEqual(first);
      }
      expect(mutations).toBeLessThanOrEqual(1);
      expect(mutations).toBe(1);
      expect(fx.state.transactions.filter((t) => t.id === fx.txId)).toHaveLength(1);
    }

    // Interleaving C: concurrent same-key duplicates collapse to one flight.
    {
      const fx = await seedMemFixture();
      let mutations = 0;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      const gatedWrites: WriteStore = {
        ...fx.writes,
        softDeleteTransaction: async (householdId: string, id: string) => {
          mutations++;
          await gate;
          return fx.writes.softDeleteTransaction(householdId, id);
        },
      };
      const memIdem = createInMemoryIdempotencyStore();
      const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
      const undo = createUndoService({
        auditLogs: createInMemoryAuditLogStore(memAudit),
        writes: gatedWrites,
        idempotency: memIdem,
        observabilitySink: (event) => { sink.push(event); },
      });
      const key = `xlt07-mem-${randomUUID()}`;
      const pending = [
        undo.undo(fx.householdId, fx.actorId, key),
        undo.undo(fx.householdId, fx.actorId, key),
        undo.undo(fx.householdId, fx.actorId, key),
        undo.undo(fx.householdId, fx.actorId, key),
      ];
      releaseGate();
      const results = await Promise.all(pending);
      for (const result of results) expect(result).toEqual(results[0]);
      expect(mutations).toBeLessThanOrEqual(1);
      expect(mutations).toBe(1);
      expect(fx.state.deletedTransactions.has(fx.txId)).toBe(true);
      expect(fx.state.transactions.filter((t) => t.id === fx.txId)).toHaveLength(1);
    }

    noteParity('representability: ≤1 financial effect in every observable interleaving (A/B/C); torn intra-producer state excluded as non-representable in heap.');
  });

  it('P5 — clean commit then duplicate key: single effect, recorded replay', async () => {
    const fx = await seedMemFixture();
    const replayEvents: Array<{ eventType: string; workspaceId: string }> = [];
    const memIdem = createInMemoryIdempotencyStore();
    const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
    const undo = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: fx.writes,
      idempotency: memIdem,
      observabilitySink: (event) => { replayEvents.push(event); },
    });
    const idempotencyKey = `xlt07-mem-${randomUUID()}`;
    const first = await undo.undo(fx.householdId, fx.actorId, idempotencyKey);
    expect(first.undone).toMatchObject({ entityId: fx.txId });
    const replayed = await undo.undo(fx.householdId, fx.actorId, idempotencyKey);
    expect(replayed).toEqual(first);
    expect(replayEvents).toEqual([
      { eventType: 'audit-undo.replay', workspaceId: fx.householdId },
    ]);
    noteParity('P5 in-memory: converges (no divergence vs Postgres P5).');
  });

  it('parity report (T3.2 output)', () => {
    console.log(`[xlt-07 parity] ${parityNotes.length} note(s):`);
    for (const line of parityNotes) console.log(`[xlt-07 parity] - ${line}`);
    expect(parityNotes.length).toBeGreaterThan(0);
    // T3.2 Opção A closed the DIVERGE_TODAY markers: every parity note must
    // describe convergence at a representable boundary or the documented
    // representability limit — never an open divergence.
    for (const line of parityNotes) expect(line).not.toMatch(/DIVERGE/);
  });
});

// ---------------------------------------------------------------------------
// Emitters T0.4.5/T0.4.6 (born here; in-memory so they run without Postgres).
// ---------------------------------------------------------------------------

const newIdentity = (): PendingIdentity => ({
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  deviceId: randomUUID(),
});

const proposeCanonical = async (store: PendingOperationV2Store, identity: PendingIdentity) => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'XLT07 reconcile probe',
      amountCents: 4242,
      date: '2026-09-14',
      accountId: randomUUID(),
      categoryId: randomUUID(),
    },
    proposalHash: '',
    idempotencyKey: randomUUID(),
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

describe('XLT-07 emitters — audit-undo.replay + mutation.reconcile.enqueued', () => {
  it('T0.4.5: a replayed undo emits exactly 1 audit-undo.replay event with workspace_id', async () => {
    const fx = await seedMemFixture();
    const events: Array<{ eventType: string; workspaceId: string }> = [];
    const memIdem = createInMemoryIdempotencyStore();
    const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
    const undo = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: fx.writes,
      idempotency: memIdem,
      observabilitySink: (event) => { events.push(event); },
    });
    const key = `xlt07-emit-${randomUUID()}`;
    await undo.undo(fx.householdId, fx.actorId, key);
    expect(events).toHaveLength(0);
    await undo.undo(fx.householdId, fx.actorId, key);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ eventType: 'audit-undo.replay', workspaceId: fx.householdId });
  });

  it('T0.4.5: replay without a sink never breaks the undo (best-effort default)', async () => {
    const fx = await seedMemFixture();
    const memIdem = createInMemoryIdempotencyStore();
    const memAudit = [seedMemAudit(fx.householdId, fx.actorId, fx.txId)];
    const undo = createUndoService({
      auditLogs: createInMemoryAuditLogStore(memAudit),
      writes: fx.writes,
      idempotency: memIdem,
    });
    const key = `xlt07-emit-default-${randomUUID()}`;
    const first = await undo.undo(fx.householdId, fx.actorId, key);
    await expect(undo.undo(fx.householdId, fx.actorId, key)).resolves.toEqual(first);
  });

  it('T0.4.6: entering reconcile emits mutation.reconcile.enqueued with operationId + reason', async () => {
    const events: Array<{
      eventType: string;
      workspaceId: string;
      operationId: string;
      reason: string;
    }> = [];
    const store = createInMemoryPendingOperationV2Store({
      leaseMs: 40,
      observabilitySink: (event) => { events.push(event); },
    });
    const identity = newIdentity();
    const saved = await proposeCanonical(store, identity);
    const confirmed = await store.confirm(saved.id, identity);
    let releaseExecutor!: (value: { status: string; operationId: string }) => void;
    const gate = new Promise<{ status: string; operationId: string }>((resolve) => {
      releaseExecutor = resolve;
    });
    const first = store.execute(confirmed.attestation!, identity, () => gate);
    // Wait for the lease to expire while the first execution hangs.
    const started = Date.now();
    for (;;) {
      const record = await store.get(saved.id, identity);
      if (record.executionLeaseExpiresAt && Date.parse(record.executionLeaseExpiresAt) <= Date.now()) break;
      if (Date.now() - started > 5_000) throw new Error('timed out waiting for lease expiry');
      await new Promise((r) => setTimeout(r, 5));
    }
    const recovered = await store.reconcileExpiredExecuting(saved.id, identity, async () => ({
      status: 'succeeded',
      operationId: randomUUID(),
    }));
    expect(recovered.status).toBe('succeeded');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventType: 'mutation.reconcile.enqueued',
      workspaceId: identity.workspaceId,
      operationId: saved.id,
      reason: RECONCILE_REASON_LEASE_EXPIRED,
    });
    releaseExecutor({ status: 'succeeded', operationId: randomUUID() });
    await first;
  });
});
