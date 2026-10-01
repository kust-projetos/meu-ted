/**
 * P1 (audit item 7): key-idempotent execution for V2 pending operations.
 *
 * The V2 executor runs every financial mutation with the pending
 * operation's persisted `idempotencyKey`. A retry of the same operation
 * (same key + same payload) must return the first attempt's outcome and
 * never re-execute the write — even when the first attempt's mutation
 * committed but the pending-operation finalization was lost.
 *
 * Persistence reuses the existing `idempotency_keys` table (V002, also
 * created on legacy deployments via V003) — no migration needed. Keys
 * are namespaced with `pending-v2:` so V2 execution records never
 * collide with HTTP-layer `Idempotency-Key` records sharing the table.
 *
 * Concurrency: the record INSERT uses `ON CONFLICT DO NOTHING` inside
 * the SAME transaction as the mutation. A loser of the claim race throws
 * an internal replay signal (rolling its own uncommitted mutation back)
 * and then reads the winner's committed record. In-memory stores dedupe
 * concurrent calls through a shared in-flight promise instead.
 */

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Transaction } from '../types/domain.js';
import { withTransaction } from '../db/pool.js';
import { domainErrors } from './errors.js';
import { hashPayloadV2, matchesPayloadHash } from './idempotency.js';
import type { V2ToolAuditOperation } from './store.js';

/** Namespace isolating V2 execution records inside `idempotency_keys`. */
export const PENDING_V2_IDEMPOTENCY_PREFIX = 'pending-v2:';

export const namespacedPendingV2Key = (idempotencyKey: string): string =>
  `${PENDING_V2_IDEMPOTENCY_PREFIX}${idempotencyKey}`;

const SELECT_KEY =
  'SELECT payload_hash, response FROM idempotency_keys WHERE household_id = $1 AND key = $2';
const INSERT_KEY =
  'INSERT INTO idempotency_keys (household_id, key, payload_hash, response) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING';

/** Internal: unwinds the loser's tx so its duplicate mutation rolls back. */
class KeyReplaySignal extends Error {
  constructor() {
    super('idempotency.replay');
    this.name = 'KeyReplaySignal';
  }
}

type KeyRow = { payload_hash: string; response: unknown };

const parseResponse = (response: unknown): { transaction: Transaction } => {
  const envelope = typeof response === 'string' ? (JSON.parse(response) as unknown) : response;
  if (!envelope || typeof envelope !== 'object' || !('transaction' in envelope)) {
    throw domainErrors.idempotencyConflict();
  }
  return envelope as { transaction: Transaction };
};

/**
 * Runs a Postgres-backed mutation at most once per (household, key).
 * The record is written transactionally with the mutation; a claim-race
 * loser rolls back and replays the winner's recorded transaction.
 *
 * V2 execution audit (bounded): when `audit` is present, the SAME claim
 * transaction additionally inserts ONE audit row (claim + effect + audit
 * commit atomically — the claim client never leaks). The audit carries the
 * explicit tool operation, the server-bound actor, and the committed
 * transaction id as effect_ref. Replay paths (existing record, lost-race
 * replay, recovery re-execution with the same key) NEVER insert — exactly
 * one audit row per financial effect. Old completed rows without audit are
 * NOT repaired. `schema` selects the audit table shape of the deployment
 * (canonical vs legacy); an unknown operation fails closed.
 */
export const runKeyedMutation = async (opts: {
  pool: Pool;
  householdId: string;
  idempotencyKey: string;
  payload: unknown;
  mutate: (client: PoolClient) => Promise<Transaction>;
  audit?: { operation: V2ToolAuditOperation; actorId: string; schema: 'canonical' | 'legacy' };
}): Promise<Transaction> => {
  const { pool, householdId, payload } = opts;
  const key = namespacedPendingV2Key(opts.idempotencyKey);
  if (opts.audit !== undefined && opts.audit.operation !== 'transactions.expense.create' && opts.audit.operation !== 'transactions.income.create') {
    throw new Error(`unsupported V2 audit operation: ${String((opts.audit as { operation?: unknown }).operation)}`);
  }
  // V4.1 Phase 3 Tasks 3.6/3.7: new records hash V2; rows written by older
  // builds (v1-sha256 / legacy h*31) still replay via matchesPayloadHash.
  const payloadHash = hashPayloadV2(payload);
  const insertAudit = async (client: PoolClient, txId: string): Promise<void> => {
    if (opts.audit === undefined) return;
    if (opts.audit.schema === 'canonical') {
      await client.query(
        `INSERT INTO audit_logs
           (id, workspace_id, actor_id, operation, event_type, payload_hash, effect_ref, metadata)
         VALUES (gen_random_uuid(), $1, $2, $3, 'financial_effect.committed', $4, $5, $6)`,
        [householdId, opts.audit.actorId, opts.audit.operation, payloadHash, txId, JSON.stringify({ entityType: 'transaction' })],
      );
      return;
    }
    await client.query(
      `INSERT INTO audit_logs
         (id, household_id, user_id, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (gen_random_uuid(), $1, NULL, $2, 'transaction', $3, NULL, NULL, NOW())`,
      [householdId, opts.audit.operation, txId],
    );
  };
  try {
    return await withTransaction(pool, async (client) => {
      const existing = await client.query<KeyRow>(SELECT_KEY, [householdId, key]);
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0]!;
        if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
        return parseResponse(row.response).transaction;
      }
      const result = await opts.mutate(client);
      const claimed = await client.query(INSERT_KEY, [
        householdId,
        key,
        payloadHash,
        JSON.stringify({ transaction: result }),
      ]);
      if ((claimed.rowCount ?? 0) === 0) throw new KeyReplaySignal();
      await insertAudit(client, result.id);
      return result;
    });
  } catch (err) {
    if (!(err instanceof KeyReplaySignal)) throw err;
    const settled = await pool.query<KeyRow>(SELECT_KEY, [householdId, key]);
    const row = settled.rows[0];
    if (!row) throw domainErrors.idempotencyConflict();
    if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
    return parseResponse(row.response).transaction;
  }
};
