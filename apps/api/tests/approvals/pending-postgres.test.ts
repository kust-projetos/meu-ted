import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createPostgresPendingOperationStore } from '../../src/approvals/pending.js';

const baseRow = () => ({
  id: '00000000-0000-0000-0000-000000000001', workspace_id: 'workspace-1', requester_id: 'user-1',
  operation: 'transactions.expense.create', payload: { amountCents: 50_000 }, reason: 'high_value',
  idempotency_key: 'intent-1', status: 'pending', created_at: '2026-08-04T18:00:00.000Z',
  expires_at: '2099-08-04T18:30:00.000Z', approved_at: null, chat_id: null,
});

type Row = ReturnType<typeof baseRow> & { is_insert?: boolean };
type FakeDb = {
  rows: Map<string, Row>;
  byKey: Map<string, Row>;
  committed: boolean;
  rolledBack: boolean;
  counter: number;
};

function makePool(): { pool: Pool; db: FakeDb } {
  const seed = baseRow() as Row;
  const db: FakeDb = {
    rows: new Map([[seed.id, { ...seed }]]),
    byKey: new Map([[`workspace-1::intent-1`, { ...seed }]]),
    committed: false,
    rolledBack: false,
    counter: 2,
  };
  const result = <R extends QueryResultRow>(rows: unknown[]): QueryResult<R> => ({
    rows: rows as R[], rowCount: rows.length, command: 'TEST', oid: 0, fields: [],
  });
  const client = {
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
      const upper = text.trim().toUpperCase();
      if (upper === 'BEGIN') return result<R>([]);
      if (upper === 'COMMIT') { db.committed = true; return result<R>([]); }
      if (upper === 'ROLLBACK') { db.rolledBack = true; return result<R>([]); }
      if (upper.startsWith('INSERT INTO PENDING_OPERATIONS')) {
        const [workspaceId, chatId, requesterId, operation, payloadJson, reason, idempotencyKey] = values as [
          string, string | null, string, string, string, string, string,
        ];
        const composite = `${workspaceId}::${idempotencyKey}`;
        const existing = db.byKey.get(composite);
        // Racing inserts serialize on the unique key: loser replays winner.
        if (existing) return result<R>([{ ...existing, is_insert: false }]);
        const id = `00000000-0000-0000-0000-0000000000${String(db.counter++).padStart(2, '0')}`;
        const now = new Date().toISOString();
        const row: Row = {
          id, workspace_id: workspaceId, requester_id: requesterId,
          operation, payload: JSON.parse(payloadJson), reason,
          idempotency_key: idempotencyKey, status: 'pending',
          created_at: now, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          approved_at: null, chat_id: chatId,
        };
        db.rows.set(id, row);
        db.byKey.set(composite, row);
        return result<R>([{ ...row, is_insert: true }]);
      }
      if (upper.startsWith('SELECT * FROM PENDING_OPERATIONS')) {
        // get/read path carries (id, workspace_id).
        if (values.length >= 2 && typeof values[0] === 'string') {
          const row = db.rows.get(values[0] as string);
          if (row && row.workspace_id === values[1]) return result<R>([row]);
          return result<R>([]);
        }
        return result<R>([...db.rows.values()]);
      }
      if (upper.startsWith('UPDATE PENDING_OPERATIONS')) {
        const id = values[0] as string;
        const row = db.rows.get(id);
        if (!row) return result<R>([]);
        row.status = text.includes("status = 'approved'") ? 'approved' : 'rejected';
        return result<R>([row]);
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client, query: client.query.bind(client) } as unknown as Pool;
  return { pool, db };
}

describe('Postgres pending operation execution', () => {
  it('claims, executes, and commits exactly once', async () => {
    const { pool } = makePool();
    const store = createPostgresPendingOperationStore(pool);
    let executions = 0;

    const result = await store.approve('00000000-0000-0000-0000-000000000001', 'workspace-1', 'user-1', async () => {
      executions += 1;
      return { transactionId: 'tx-1' };
    });

    expect(result).toMatchObject({ status: 'approved', execution: { transactionId: 'tx-1' } });
    const retried = await store.approve('00000000-0000-0000-0000-000000000001', 'workspace-1', 'user-1', async () => { executions += 1; });
    expect(retried).toMatchObject({ status: 'approved' });
    expect(executions).toBe(1);
  });

  it('rolls back the approval when execution fails', async () => {
    const { pool, db } = makePool();
    const store = createPostgresPendingOperationStore(pool);

    await expect(store.approve('00000000-0000-0000-0000-000000000001', 'workspace-1', 'user-1', async () => {
      throw new Error('effect failed');
    })).rejects.toThrow('effect failed');

    expect(db.rolledBack).toBe(true);
  });
});

describe('Postgres pending create identity (Security P2, fake pool)', () => {
  const input = {
    householdId: 'workspace-fake', requesterId: 'user-1', operation: 'transactions.expense.create',
    payload: { amountCents: 50_000 }, reason: 'high_value' as const, idempotencyKey: 'intent-fake-1',
  };

  it('identical retry returns the same pending id', async () => {
    const { pool } = makePool();
    const store = createPostgresPendingOperationStore(pool);
    const first = await store.create(input);
    const second = await store.create({ ...input });
    expect(second.id).toBe(first.id);
  });

  it('divergent payload conflicts with idempotency.conflict 409', async () => {
    const { pool } = makePool();
    const store = createPostgresPendingOperationStore(pool);
    await store.create(input);
    await expect(store.create({ ...input, payload: { amountCents: 1 } })).rejects.toMatchObject({
      code: 'idempotency.conflict', statusCode: 409,
    });
  });

  it('divergent operation conflicts with idempotency.conflict 409', async () => {
    const { pool } = makePool();
    const store = createPostgresPendingOperationStore(pool);
    await store.create(input);
    await expect(store.create({ ...input, operation: 'transactions.income.create' })).rejects.toMatchObject({
      code: 'idempotency.conflict', statusCode: 409,
    });
  });

  it('divergent requester conflicts with idempotency.conflict 409', async () => {
    const { pool } = makePool();
    const store = createPostgresPendingOperationStore(pool);
    await store.create(input);
    await expect(store.create({ ...input, requesterId: 'user-2' })).rejects.toMatchObject({
      code: 'idempotency.conflict', statusCode: 409,
    });
  });

  it('concurrent racing identical inserts resolve to the same pending id', async () => {
    const { pool } = makePool();
    const store = createPostgresPendingOperationStore(pool);
    const [a, b] = await Promise.all([store.create({ ...input }), store.create({ ...input })]);
    expect(a.id).toBe(b.id);
  });
});

// Real Postgres integration — gated by DATABASE_URL_TEST + DB_TEST_MARKER.
const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;

if (!ENABLED) {
  console.log(
    '[pending-postgres-identity] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — real PG identity proof skipped.',
  );
}

describe('Postgres pending create identity (real PG)', () => {
  let pool: Pool | undefined;
  const createdWorkspaces = new Set<string>();

  afterAll(async () => {
    if (!pool) return;
    for (const ws of createdWorkspaces) {
      await pool.query(`DELETE FROM pending_operations WHERE workspace_id = $1`, [ws]).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  });

  itIfDatabase('identical retry reuses id; divergent operation/requester/payload conflict 409', async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: DB_URL }) as Pool;
    const store = createPostgresPendingOperationStore(pool);
    const workspaceId = randomUUID();
    createdWorkspaces.add(workspaceId);
    const key = `itest-${randomUUID()}`;
    const base = {
      householdId: workspaceId, requesterId: 'itest-user', operation: 'transactions.expense.create',
      payload: { amountCents: 12_345 }, reason: 'high_value' as const, idempotencyKey: key,
    };
    const first = await store.create(base);
    const second = await store.create({ ...base });
    expect(second.id).toBe(first.id);

    await expect(store.create({ ...base, payload: { amountCents: 54_321 } })).rejects.toMatchObject({
      code: 'idempotency.conflict', statusCode: 409,
    });
    await expect(store.create({ ...base, operation: 'transactions.income.create' })).rejects.toMatchObject({
      code: 'idempotency.conflict',
    });
    await expect(store.create({ ...base, requesterId: 'itest-other' })).rejects.toMatchObject({
      code: 'idempotency.conflict',
    });

    // Concurrent racing identical inserts converge on one id.
    const raceKey = `itest-race-${randomUUID()}`;
    const [a, b] = await Promise.all([
      store.create({ ...base, idempotencyKey: raceKey }),
      store.create({ ...base, idempotencyKey: raceKey }),
    ]);
    expect(a.id).toBe(b.id);
  });
});
