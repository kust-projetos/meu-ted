/**
 * TED Pending-V2 execution audit (HIGH review finding).
 *
 * RED: the V2 executor path (`tool-registry` → `writes.createExpense(...,
 * { idempotencyKey })` → `runKeyedMutation`) books the ledger row + the
 * `pending-v2:` idempotency record but writes NO audit row — so undo
 * preview/eligibility never sees TED-approved writes.
 *
 * GREEN: `runKeyedMutation` accepts a bounded server-side audit context
 * (explicit tool operation + actorId + schema) and commits claim + financial
 * effect + audit in the SAME claim transaction. Replays/recovery never
 * duplicate the audit; old completed rows without audit are NOT repaired;
 * unkeyed writes are untouched.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { runKeyedMutation } from '../../src/writes/pending-idempotency.js';
import type { Transaction } from '../../src/types/domain.js';

const TX_ID = '11111111-1111-4111-8111-111111111111';
const HOUSEHOLD = '99999999-9999-4999-8999-999999999999';
const ACTOR = 'actor-device-1';

type Captured = { text: string; values?: unknown[] };

const makeKeyedFake = () => {
  const queries: Captured[] = [];
  const keys = new Map<string, { payload_hash: unknown; response: unknown }>();
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rowCount: 0, rows: [] };
      if (text.includes('FROM idempotency_keys')) {
        const row = keys.get(String(values?.[1]));
        return row ? { rowCount: 1, rows: [{ payload_hash: row.payload_hash, response: row.response }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('INSERT INTO idempotency_keys')) {
        keys.set(String(values?.[1]), { payload_hash: values?.[2], response: values?.[3] });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries };
};

const fakeTx = () =>
  ({
    id: TX_ID,
    householdId: HOUSEHOLD,
    kind: 'expense',
    description: 'lunch',
    amountCents: 1000,
    date: '2026-09-14',
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }) as unknown as Transaction;

const auditInserts = (queries: Captured[]) => queries.filter((q) => q.text.includes('INSERT INTO audit_logs'));

describe('V2 execution audit — unit (claim-client atomicity, no replay duplicates)', () => {
  it('canonical: commits the audit row in the same claim tx with op/actor/workspace/effectRef', async () => {
    const { pool, queries } = makeKeyedFake();
    const tx = await runKeyedMutation({
      pool,
      householdId: HOUSEHOLD,
      idempotencyKey: 'v2-unit-1',
      payload: { description: 'lunch' },
      mutate: async () => fakeTx(),
      audit: { operation: 'transactions.expense.create', actorId: ACTOR, schema: 'canonical' },
    });
    expect(tx.id).toBe(TX_ID);
    const inserts = auditInserts(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain('workspace_id');
    expect(inserts[0]!.text).toContain('financial_effect.committed');
    const values = inserts[0]!.values as unknown[];
    // values carry workspace, actor, explicit tool op, committed tx id — never raw payload.
    expect(values).toContain(HOUSEHOLD);
    expect(values).toContain(ACTOR);
    expect(values).toContain('transactions.expense.create');
    expect(values).toContain(TX_ID);
  });

  it('canonical: replay of the same key returns the tx with NO new audit row', async () => {
    const { pool, queries } = makeKeyedFake();
    const opts = {
      pool,
      householdId: HOUSEHOLD,
      idempotencyKey: 'v2-unit-replay',
      payload: { description: 'lunch' },
      mutate: async () => fakeTx(),
      audit: { operation: 'transactions.expense.create', actorId: ACTOR, schema: 'canonical' },
    } as const;
    await runKeyedMutation({ ...opts });
    let mutations = 0;
    await runKeyedMutation({
      ...opts,
      mutate: async () => {
        mutations += 1;
        return fakeTx();
      },
    });
    expect(mutations).toBe(0);
    expect(auditInserts(queries)).toHaveLength(1);
  });

  it('legacy: writes the legacy audit shape with action + entity binding', async () => {
    const { pool, queries } = makeKeyedFake();
    await runKeyedMutation({
      pool,
      householdId: HOUSEHOLD,
      idempotencyKey: 'v2-unit-legacy',
      payload: { description: 'lunch' },
      mutate: async () => fakeTx(),
      audit: { operation: 'transactions.income.create', actorId: ACTOR, schema: 'legacy' },
    });
    const inserts = auditInserts(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain('household_id');
    expect(inserts[0]!.text).toContain('action');
    const values = inserts[0]!.values as unknown[];
    expect(values).toContain(HOUSEHOLD);
    expect(values).toContain('transactions.income.create');
    expect(values).toContain(TX_ID);
  });

  it('no audit context: preserves the previous behavior (ledger + record only)', async () => {
    const { pool, queries } = makeKeyedFake();
    await runKeyedMutation({
      pool,
      householdId: HOUSEHOLD,
      idempotencyKey: 'v2-unit-noaudit',
      payload: { description: 'lunch' },
      mutate: async () => fakeTx(),
    });
    expect(auditInserts(queries)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PG end-to-end on the ACTUAL path: PROPOSE → CONFIRM → EXECUTE (API-owned V2
// executor) → audit preview → undo restores the balance exactly once.
// ---------------------------------------------------------------------------

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
import { createPostgresWriteStore, createPostgresIdempotencyStore } from '../../src/writes/postgres.js';
import { createPostgresAuditLogStore } from '../../src/audit/store.js';
import { createUndoService } from '../../src/approvals/undo.js';
import type { WriteStore } from '../../src/writes/store.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfPg = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[v2-execution-audit] SKIP PG e2e: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

describeIfPg('V2 execution audit — PG e2e (actual PROPOSE→CONFIRM→EXECUTE path)', () => {
  let pool: Pool;
  const households: string[] = [];
  let store: PendingOperationV2Store;
  let writes: WriteStore;

  const seedHousehold = async (): Promise<{ householdId: string; identity: PendingIdentity }> => {
    const householdId = randomUUID();
    const identity: PendingIdentity = { workspaceId: householdId, actorId: randomUUID(), deviceId: randomUUID() };
    const ownerId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'V2AUDIT', 'active')`, [
      ownerId,
      `v2audit-${householdId}@example.test`,
    ]);
    await pool.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, $2, 'shared', $3)`, [
      householdId,
      `V2AUDIT ${householdId.slice(0, 8)}`,
      ownerId,
    ]);
    households.push(householdId);
    return { householdId, identity };
  };

  const proposeOp = async (
    identity: PendingIdentity,
    tool: 'transactions.expense.create' | 'transactions.income.create',
    normalizedArgs: Record<string, PendingOperationV2JsonValue>,
  ) => {
    const base = {
      version: 2 as const,
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
      tool,
      normalizedArgs,
      proposalHash: '',
      idempotencyKey: randomUUID(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      bindings: { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId },
    };
    return store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'v2-execution-audit');
    await runMigrations(pool);
    store = createPostgresPendingOperationV2Store(pool);
    writes = createPostgresWriteStore({ pool });
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      for (const h of households) {
        await pool.query('DELETE FROM audit_logs WHERE workspace_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM operation_records WHERE workspace_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM idempotency_keys WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM pending_operations WHERE workspace_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM transactions WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM categories WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM accounts WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM memberships WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM households WHERE id = $1', [h]).catch(() => undefined);
      }
      await pool.end();
    }
  });

  it('EXECUTE writes exactly 1 audit row; preview → undo restores the balance exactly once', async () => {
    const { householdId, identity } = await seedHousehold();
    const executor = createPendingOperationV2Executor(writes);
    const account = await writes.createAccount(householdId, {
      name: 'V2AUDIT Checking',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes.createCategory(householdId, { name: 'V2AUDIT Food', kind: 'expense' });

    const proposed = await proposeOp(identity, 'transactions.expense.create', {
      description: 'V2AUDIT lunch',
      amountCents: 1250,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    });
    const confirmed = await store.confirm(proposed.id, identity);
    const done = await store.execute(confirmed.attestation!, identity, executor);
    expect(done.status).toBe('succeeded');
    const txId = (done.execution as { operationId: string }).operationId;

    // The execution audit: exactly 1 row, server-bound op/actor/workspace + committed effect.
    const audits = await pool.query<{
      operation: string;
      actor_id: string;
      workspace_id: string;
      effect_ref: string | null;
      event_type: string;
    }>(
      `SELECT operation, actor_id, workspace_id, effect_ref, event_type FROM audit_logs WHERE workspace_id = $1`,
      [householdId],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      operation: 'transactions.expense.create',
      actor_id: identity.actorId,
      workspace_id: householdId,
      effect_ref: txId,
      event_type: 'financial_effect.committed',
    });

    // Preview (the same store the Agent verification reads) lists the target.
    const auditStore = createPostgresAuditLogStore(pool);
    const preview = await auditStore.listAuditLogs(householdId, { limit: 10 });
    expect(preview.total).toBe(1);
    expect(preview.items[0]).toMatchObject({ operation: 'transactions.expense.create', effectRef: txId });

    // Spent balance before undo.
    const spent = await pool.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM accounts WHERE id = $1 AND household_id = $2`,
      [account.id, householdId],
    );
    expect(Number(spent.rows[0]!.balance_cents)).toBe(50_000 - 1250);

    // Undo restores the balance; a same-key replay returns the identical receipt (exactly once).
    const undo = createUndoService({
      auditLogs: auditStore,
      writes,
      idempotency: createPostgresIdempotencyStore({ pool }),
    });
    const undoKey = `v2audit-${randomUUID()}`;
    const undone = await undo.undo(householdId, identity.actorId, undoKey);
    expect(undone.undone).toMatchObject({
      operation: 'transactions.expense.create',
      entityId: txId,
      reversal: 'soft_delete',
    });
    const replayed = await undo.undo(householdId, identity.actorId, undoKey);
    expect(replayed).toEqual(undone);

    const restored = await pool.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM accounts WHERE id = $1 AND household_id = $2`,
      [account.id, householdId],
    );
    expect(Number(restored.rows[0]!.balance_cents)).toBe(50_000);
    const txCount = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
      [householdId],
    );
    expect(Number(txCount.rows[0]!.n)).toBe(0);

    // Re-executing the consumed attestation never touches the executor: no duplicate audit.
    // (The undo above records its own generic claim audit row; the execution audit stays exactly 1.)
    await expect(store.execute(confirmed.attestation!, identity, executor)).rejects.toMatchObject({
      code: 'approval.attestation_replayed',
    });
    const auditsAfter = await pool.query<{ operation: string }>(
      `SELECT operation FROM audit_logs WHERE workspace_id = $1`,
      [householdId],
    );
    expect(auditsAfter.rows).toHaveLength(2);
    expect(auditsAfter.rows.filter((r) => r.operation === 'transactions.expense.create')).toHaveLength(1);
  }, 60_000);

  it('crash recovery (expired lease + reconcile) converges with exactly 1 audit row', async () => {    const { householdId, identity } = await seedHousehold();
    const executor = createPendingOperationV2Executor(writes);
    const account = await writes.createAccount(householdId, {
      name: 'V2AUDIT Recovery',
      kind: 'bank',
      initialBalanceCents: 50_000,
    });
    const category = await writes.createCategory(householdId, { name: 'V2AUDIT Rec Food', kind: 'expense' });

    const proposed = await proposeOp(identity, 'transactions.expense.create', {
      description: 'V2AUDIT recovery',
      amountCents: 700,
      date: '2026-09-14',
      accountId: account.id,
      categoryId: category.id,
    });
    const confirmed = await store.confirm(proposed.id, identity);

    // TX1 claim with a blocked executor (process holds the claim, then "dies").
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimed = store.execute(confirmed.attestation!, identity, async (op) => {
      await gate;
      return executor(op);
    });
    const started = Date.now();
    for (;;) {
      const rec = await store.get(proposed.id, identity);
      if (rec.status === 'executing') break;
      if (Date.now() - started > 5_000) throw new Error('claim never committed');
      await new Promise((r) => setTimeout(r, 10));
    }
    await pool.query(`UPDATE pending_operations SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      proposed.id,
    ]);

    const recovered = await store.reconcileExpiredExecuting(proposed.id, identity, executor);
    expect(recovered.status).toBe('succeeded');

    release();
    const firstDone = await claimed;
    expect(firstDone.status).toBe('succeeded');
    const firstTx = (firstDone.execution as { operationId: string }).operationId;
    const recoveredTx = (recovered.execution as { operationId: string }).operationId;
    expect(firstTx).toBe(recoveredTx);

    const audits = await pool.query(`SELECT id FROM audit_logs WHERE workspace_id = $1`, [householdId]);
    expect(audits.rows).toHaveLength(1);
    const txCount = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM transactions WHERE household_id = $1 AND deleted_at IS NULL`,
      [householdId],
    );
    expect(Number(txCount.rows[0]!.n)).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Legacy-shape deployment (production VPS runs DB_SCHEMA=legacy): the V2
// execution audit must commit in the legacy audit shape on a real
// legacy-shaped database. Separate disposable database, same guard.
// ---------------------------------------------------------------------------

const LEGACY_DB_URL = DB_URL ? DB_URL.replace(/\/[^/?]+(\?.*)?$/, '/pi_test_legacy_v2audit$1') : undefined;

const LEGACY_AUDIT_SHAPE_DDL = [
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS household_id UUID`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id UUID`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_json JSONB`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_json JSONB`,
  // Deployment compat (same as XLT-07 legacy DDL): canonical NOT NULL
  // columns are relaxed on legacy-schema deployments, where writers only
  // fill the legacy shape.
  `ALTER TABLE audit_logs ALTER COLUMN workspace_id DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN actor_id DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN operation DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN event_type DROP NOT NULL`,
  `ALTER TABLE audit_logs ALTER COLUMN payload_hash DROP NOT NULL`,
];

describeIfPg('V2 execution audit — legacy-shape PG (runKeyedMutation legacy audit)', () => {
  let db: Pool;

  beforeAll(async () => {
    const admin = createPool({ connectionString: DB_URL!, max: 2 });
    try {
      await requireTestDatabase(admin, 'v2-execution-audit-legacy-admin');
      await admin.query('CREATE DATABASE pi_test_legacy_v2audit').catch((err: Error) => {
        if (!/already exists/.test(err.message)) throw err;
      });
    } finally {
      await admin.end();
    }
    db = createPool({ connectionString: LEGACY_DB_URL!, max: 4 });
    await db.query('CREATE TABLE IF NOT EXISTS _test_marker (marker_value TEXT PRIMARY KEY)');
    await db.query('INSERT INTO _test_marker (marker_value) VALUES ($1) ON CONFLICT DO NOTHING', [
      process.env.DB_TEST_MARKER!,
    ]);
    await requireTestDatabase(db, 'v2-execution-audit-legacy');
    await runMigrations(db);
    for (const ddl of LEGACY_AUDIT_SHAPE_DDL) await db.query(ddl);
  }, 180_000);

  afterAll(async () => {
    await db?.end();
  });

  it('legacy audit row commits with action + entity binding (no canonical columns touched)', async () => {
    const householdId = randomUUID();
    const actorId = randomUUID();
    const key = `v2legacy-${randomUUID()}`;
    const payload = { description: 'legacy lunch' };
    const fakeMutate = async () =>
      ({
        id: '22222222-2222-4222-8222-222222222222',
        householdId,
        kind: 'expense',
        description: 'legacy lunch',
        amountCents: 500,
        date: '2026-09-14',
        accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }) as unknown as Transaction;
    const tx = await runKeyedMutation({
      pool: db,
      householdId,
      idempotencyKey: key,
      payload,
      mutate: fakeMutate,
      audit: { operation: 'transactions.expense.create', actorId, schema: 'legacy' },
    });
    expect(tx.id).toBe('22222222-2222-4222-8222-222222222222');
    const rows = await db.query<{
      action: string;
      entity_type: string;
      entity_id: string | null;
      household_id: string;
    }>(
      `SELECT action, entity_type, entity_id, household_id FROM audit_logs WHERE household_id = $1`,
      [householdId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action: 'transactions.expense.create',
      entity_type: 'transaction',
      entity_id: '22222222-2222-4222-8222-222222222222',
      household_id: householdId,
    });
    // Replay with the SAME key: recorded tx returns, producer never runs, no second audit row.
    let ran = 0;
    const replayed = await runKeyedMutation({
      pool: db,
      householdId,
      idempotencyKey: key,
      payload,
      mutate: async () => {
        ran += 1;
        return fakeMutate();
      },
      audit: { operation: 'transactions.expense.create', actorId, schema: 'legacy' },
    });
    expect(replayed.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(ran).toBe(0);
    const after = await db.query(`SELECT id FROM audit_logs WHERE household_id = $1`, [householdId]);
    expect(after.rows).toHaveLength(1);
  }, 60_000);
});
