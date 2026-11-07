import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import { domainErrors } from '../writes/errors.js';
import { hashPayloadV2, matchesPayloadHash } from '../writes/idempotency.js';
import { namespacedPendingV2Key } from '../writes/pending-idempotency.js';
import type { Transaction } from '../types/domain.js';

const SELECT_KEY = 'SELECT payload_hash, response FROM idempotency_keys WHERE household_id = $1 AND key = $2';
const INSERT_KEY = 'INSERT INTO idempotency_keys (household_id, key, payload_hash, response) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING';

class KeyReplaySignal extends Error {
  constructor() { super('idempotency.replay'); this.name = 'KeyReplaySignal'; }
}

const isTransactionSnapshot = (value: unknown, householdId: string): value is Transaction => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return typeof row['id'] === 'string' && uuid.test(row['id']) &&
    row['householdId'] === householdId &&
    ['expense', 'income', 'transfer'].includes(String(row['kind'])) &&
    typeof row['description'] === 'string' && row['description'].length > 0 &&
    typeof row['amountCents'] === 'number' && Number.isSafeInteger(row['amountCents']) && row['amountCents'] > 0 &&
    typeof row['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row['date']) &&
    typeof row['accountId'] === 'string' && uuid.test(row['accountId']);
};

const parseResponse = (response: unknown, householdId: string): Transaction[] => {
  let envelope: unknown = response;
  if (typeof response === 'string') {
    try { envelope = JSON.parse(response); } catch { throw domainErrors.idempotencyConflict(); }
  }
  if (!envelope || typeof envelope !== 'object' || !('transactions' in envelope)) throw domainErrors.idempotencyConflict();
  const txs = (envelope as { transactions?: unknown }).transactions;
  if (!Array.isArray(txs) || txs.length === 0) throw domainErrors.idempotencyConflict();
  for (const t of txs) if (!isTransactionSnapshot(t, householdId)) throw domainErrors.idempotencyConflict();
  return txs as Transaction[];
};

export const runKeyedCardPurchase = async (opts: {
  pool: Pool;
  householdId: string;
  idempotencyKey: string;
  payload: unknown;
  mutate: (client: PoolClient) => Promise<Transaction[]>;
}): Promise<Transaction[]> => {
  const { pool, householdId, payload } = opts;
  const key = namespacedPendingV2Key(opts.idempotencyKey);
  const payloadHash = hashPayloadV2(payload);
  try {
    return await withTransaction(pool, async (client) => {
      const existing = await client.query<{ payload_hash: string; response: unknown }>(SELECT_KEY, [householdId, key]);
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0]!;
        if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
        return parseResponse(row.response, householdId);
      }
      const result = await opts.mutate(client);
      const claimed = await client.query(INSERT_KEY, [householdId, key, payloadHash, JSON.stringify({ transactions: result })]);
      if ((claimed.rowCount ?? 0) === 0) throw new KeyReplaySignal();
      return result;
    });
  } catch (err) {
    if (!(err instanceof KeyReplaySignal)) throw err;
    const settled = await pool.query<{ payload_hash: string; response: unknown }>(SELECT_KEY, [householdId, key]);
    const row = settled.rows[0];
    if (!row) throw domainErrors.idempotencyConflict();
    if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
    return parseResponse(row.response, householdId);
  }
};
