import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import { canonicalJson } from '../writes/canonical-json.js';
import { domainErrors } from '../writes/errors.js';

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type PendingOperation = {
  id: string;
  householdId: string;
  chatId?: string;
  requesterId: string;
  operation: string;
  payload: unknown;
  reason: 'high_value' | 'destructive';
  idempotencyKey: string;
  status: PendingStatus;
  createdAt: string;
  expiresAt: string;
};

type CreatePendingInput = Omit<PendingOperation, 'id' | 'status' | 'createdAt' | 'expiresAt'>;
type PendingRow = Record<string, unknown>;

const mapPending = (row: PendingRow): PendingOperation => ({
  id: row.id as string,
  householdId: row.workspace_id as string,
  ...(row.chat_id !== null && row.chat_id !== undefined ? { chatId: row.chat_id as string } : {}),
  requesterId: row.requester_id as string,
  operation: row.operation as string,
  payload: row.payload,
  reason: row.reason as PendingOperation['reason'],
  idempotencyKey: row.idempotency_key as string,
  status: row.status as PendingStatus,
  createdAt: new Date(row.created_at as string).toISOString(),
  expiresAt: new Date(row.expires_at as string).toISOString(),
});

export type PendingOperationExecutor = (operation: PendingOperation) => Promise<unknown>;
export type ApprovedPendingOperation = PendingOperation & { execution?: unknown };

export type PendingOperationStore = {
  create(input: CreatePendingInput): Promise<PendingOperation>;
  get(id: string, householdId: string): Promise<PendingOperation>;
  list(householdId: string, status?: PendingStatus): Promise<PendingOperation[]>;
  approve(id: string, householdId: string, actorId: string, execute?: PendingOperationExecutor): Promise<ApprovedPendingOperation>;
  reject(id: string, householdId: string, actorId: string): Promise<PendingOperation>;
  findByChatId(chatId: string, householdId: string): Promise<PendingOperation | undefined>;
};

const EXPIRATION_MS = 30 * 60 * 1000;

/**
 * Security P2 (pending-approval-identity): a reused idempotency key must
 * prove identity. Same workspace + same key with a different operation,
 * requester, or payload is `idempotency.conflict` (409) — never a silent
 * reuse of another operation's pending row. Payload comparison uses
 * canonical JSON so key order alone never conflicts. V2 proposalHash is
 * intentionally untouched here (see pending-v2.ts).
 */
const samePendingIdentity = (
  existing: { operation: string; requesterId: string; payload: unknown },
  candidate: { operation: string; requesterId: string; payload: unknown },
): boolean =>
  existing.operation === candidate.operation &&
  existing.requesterId === candidate.requesterId &&
  canonicalJson(existing.payload) === canonicalJson(candidate.payload);

const samePendingRowIdentity = (
  row: PendingRow,
  input: CreatePendingInput,
): boolean =>
  (row.operation as string) === input.operation &&
  (row.requester_id as string) === input.requesterId &&
  canonicalJson(row.payload) === canonicalJson(input.payload);

export const createPostgresPendingOperationStore = (pool: Pool): PendingOperationStore => {
  const read = async (client: PoolClient, id: string, householdId: string): Promise<PendingOperation> => {
    const result = await client.query<PendingRow>('SELECT * FROM pending_operations WHERE id = $1 AND workspace_id = $2 AND protocol_version IS NULL', [id, householdId]);
    if (!result.rows[0]) throw domainErrors.approvalNotFound();
    return mapPending(result.rows[0]);
  };

  return {
  async create(input) {
    const result = await pool.query<PendingRow>(
      `INSERT INTO pending_operations (workspace_id, chat_id, requester_id, operation, payload, reason, idempotency_key, status, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'pending', NOW() + INTERVAL '30 minutes')
       ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *, (xmax = 0) AS is_insert`,
      [input.householdId, input.chatId ?? null, input.requesterId, input.operation, JSON.stringify(input.payload), input.reason, input.idempotencyKey],
    );
    const row = result.rows[0]!;
    // Racing inserts serialize on the unique (workspace_id, idempotency_key):
    // the loser returns the winner's row via ON CONFLICT. Either path must
    // prove identity — a divergent operation/requester/payload is 409.
    if (!samePendingRowIdentity(row, input)) throw domainErrors.idempotencyConflict();
    return mapPending(row);
  },
  async get(id, householdId) {
    const result = await pool.query<PendingRow>('SELECT * FROM pending_operations WHERE id = $1 AND workspace_id = $2 AND protocol_version IS NULL', [id, householdId]);
    if (!result.rows[0]) throw domainErrors.approvalNotFound();
    return mapPending(result.rows[0]);
  },
  async list(householdId, status) {
    const values: unknown[] = [householdId];
    const statusClause = status ? ' AND status = $2' : '';
    const expiryClause = status === 'pending' ? ' AND expires_at > NOW()' : '';
    if (status) values.push(status);
    const result = await pool.query<PendingRow>(`SELECT * FROM pending_operations WHERE workspace_id = $1 AND protocol_version IS NULL${statusClause}${expiryClause} ORDER BY created_at ASC`, values);
    return result.rows.map(mapPending);
  },
  async approve(id, householdId, actorId, execute) {
    return withTransaction(pool, async (client) => {
      const current = await read(client, id, householdId);
      if (current.requesterId !== actorId) throw domainErrors.approvalRequesterOnly();
      if (current.status === 'approved') return current;
      if (current.status !== 'pending' || Date.parse(current.expiresAt) <= Date.now()) throw domainErrors.approvalNotPending();
      const result = await client.query<PendingRow>(
        "UPDATE pending_operations SET status = 'approved', approved_at = NOW() WHERE id = $1 AND workspace_id = $2 AND requester_id = $3 AND protocol_version IS NULL AND status = 'pending' AND expires_at > NOW() RETURNING *",
        [id, householdId, actorId],
      );
      let row: PendingRow | undefined = result.rows[0];
      if (!row) {
        // Lost the conditional-claim race: re-read under the same transaction.
        // If a concurrent approve settled this operation as approved for the
        // same requester, treat this call as a canonical replay (no side
        // effect, no executor invocation). Otherwise the operation is not
        // approvable anymore.
        const settled = await read(client, id, householdId);
        if (settled.requesterId !== actorId) throw domainErrors.approvalRequesterOnly();
        if (settled.status === 'approved') return settled;
        throw domainErrors.approvalNotPending();
      }
      const approved = mapPending(row);
      if (!execute) return approved;
      return { ...approved, execution: await execute(approved) };
    });
  },
  async reject(id, householdId, actorId) {
    return withTransaction(pool, async (client) => {
      const current = await read(client, id, householdId);
      if (current.requesterId !== actorId) throw domainErrors.approvalRequesterOnly();
      if (current.status !== 'pending' || Date.parse(current.expiresAt) <= Date.now()) throw domainErrors.approvalNotPending();
      const result = await client.query<PendingRow>(
        "UPDATE pending_operations SET status = 'rejected' WHERE id = $1 AND workspace_id = $2 AND requester_id = $3 AND protocol_version IS NULL AND status = 'pending' AND expires_at > NOW() RETURNING *",
        [id, householdId, actorId],
      );
      if (!result.rows[0]) throw domainErrors.approvalNotPending();
      return mapPending(result.rows[0]);
    });
  },
  async findByChatId(chatId, householdId) {
    const result = await pool.query<PendingRow>(
      `SELECT * FROM pending_operations
       WHERE workspace_id = $1
         AND protocol_version IS NULL
         AND chat_id = $2
         AND status = 'pending'
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [householdId, chatId],
    );
    return result.rows[0] ? mapPending(result.rows[0]) : undefined;
  }
};
};

export const createInMemoryPendingOperationStore = (): PendingOperationStore => {
  const records = new Map<string, PendingOperation>();
  const byIdempotencyKey = new Map<string, PendingOperation>();
  const keyOf = (householdId: string, idempotencyKey: string): string => `${householdId}::${idempotencyKey}`;
  const find = (id: string, householdId: string): PendingOperation => {
    const record = records.get(id);
    if (!record || record.householdId !== householdId) throw domainErrors.approvalNotFound();
    if (record.status === 'pending' && Date.parse(record.expiresAt) <= Date.now()) record.status = 'expired';
    return record;
  };

  return {
    async create(input) {
      // Synchronous check+insert: no await before both maps are written, so
      // concurrent racing creates in the same tick serialize — the second
      // observes the first and replays (identical) or conflicts (divergent).
      const composite = keyOf(input.householdId, input.idempotencyKey);
      const existing = byIdempotencyKey.get(composite);
      if (existing) {
        if (!samePendingIdentity(existing, input)) throw domainErrors.idempotencyConflict();
        return existing;
      }
      const createdAt = new Date().toISOString();
      const record: PendingOperation = {
        ...input,
        id: randomUUID(),
        status: 'pending',
        createdAt,
        expiresAt: new Date(Date.now() + EXPIRATION_MS).toISOString(),
      };
      records.set(record.id, record);
      byIdempotencyKey.set(composite, record);
      return record;
    },
    async get(id, householdId) {
      return find(id, householdId);
    },
    async list(householdId, status) {
      const now = Date.now();
      for (const record of records.values()) {
        if (record.status === 'pending' && Date.parse(record.expiresAt) <= now) record.status = 'expired';
      }
      return [...records.values()].filter((record) => record.householdId === householdId && (!status || record.status === status));
    },
    async approve(id, householdId, actorId, execute) {
      const record = find(id, householdId);
      if (record.requesterId !== actorId) throw domainErrors.approvalRequesterOnly();
      if (record.status === 'approved') return { ...record, execution: (record as ApprovedPendingOperation).execution };
      if (record.status !== 'pending') throw domainErrors.approvalNotPending();
      record.status = 'approved';
      try {
        const execution = execute ? await execute(record) : undefined;
        (record as ApprovedPendingOperation).execution = execution;
        return execution === undefined ? record : { ...record, execution };
      } catch (error) {
        record.status = 'pending';
        throw error;
      }
    },
    async reject(id, householdId, actorId) {
      const record = find(id, householdId);
      if (record.requesterId !== actorId) throw domainErrors.approvalRequesterOnly();
      if (record.status !== 'pending') throw domainErrors.approvalNotPending();
      record.status = 'rejected';
      return record;
    },
    async findByChatId(chatId, householdId) {
      const matches = [...records.values()]
        .filter((record) => {
          return record.householdId === householdId
            && record.status === 'pending'
            && Date.parse(record.expiresAt) > Date.now()
            && record.chatId === chatId;
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return matches[0];
    }
  };
};

// V2 is intentionally exposed from the approval boundary without changing the
// legacy store contract used by existing routes during the rollout window.
export * from './pending-v2.js';
