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
import type { Account, Category, Transaction } from '../types/domain.js';
import { withTransaction } from '../db/pool.js';
import { domainErrors } from './errors.js';
import { hashPayloadV2, matchesPayloadHash } from './idempotency.js';
import type { KeyedWriteAuditOperation } from './store.js';

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

const TRANSACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTransactionSnapshot = (value: unknown, householdId: string): value is Transaction => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string' && TRANSACTION_UUID.test(row['id']) &&
    row['householdId'] === householdId && ['expense', 'income', 'transfer'].includes(String(row['kind'])) &&
    typeof row['description'] === 'string' && row['description'].length > 0 && row['description'].length <= 240 &&
    typeof row['amountCents'] === 'number' && Number.isSafeInteger(row['amountCents']) && row['amountCents'] > 0 &&
    typeof row['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row['date']) &&
    typeof row['accountId'] === 'string' && TRANSACTION_UUID.test(row['accountId']) &&
    (row['categoryId'] === undefined || (typeof row['categoryId'] === 'string' && TRANSACTION_UUID.test(row['categoryId']))) &&
    (row['subcategoryId'] === undefined || (typeof row['subcategoryId'] === 'string' && TRANSACTION_UUID.test(row['subcategoryId']))) &&
    (row['transferToAccountId'] === undefined || (typeof row['transferToAccountId'] === 'string' && TRANSACTION_UUID.test(row['transferToAccountId']))) &&
    (row['notes'] === undefined || typeof row['notes'] === 'string');
};

const parseResponse = (response: unknown, householdId: string): { transaction: Transaction } => {
  let envelope: unknown = response;
  if (typeof response === 'string') {
    try { envelope = JSON.parse(response); } catch { throw domainErrors.idempotencyConflict(); }
  }
  if (!envelope || typeof envelope !== 'object' || !('transaction' in envelope) ||
      !isTransactionSnapshot((envelope as { transaction?: unknown }).transaction, householdId)) {
    throw domainErrors.idempotencyConflict();
  }
  return envelope as { transaction: Transaction };
};

const parseAccountResponse = (response: unknown, householdId: string): { account: Account } => {
  let envelope: unknown = response;
  if (typeof response === 'string') {
    // Texto inválido nunca vaza como SyntaxError cru: fail-closed.
    try {
      envelope = JSON.parse(response);
    } catch {
      throw domainErrors.idempotencyConflict();
    }
  }
  if (!envelope || typeof envelope !== 'object' || !('account' in envelope)) {
    throw domainErrors.idempotencyConflict();
  }
  const account = (envelope as { account?: unknown }).account;
  // Round3 MEDIUM — snapshot estrutural: `{ account: {} }`, null, id
  // ausente/não-UUID, household divergente, nome vazio, kind/status fora
  // do vocabulário fechado ou balance não-inteiro nunca replayam.
  // No own-error path o chamador conserva o erro original; nos fluxos de
  // replay normal, conflict fail-closed.
  if (!isAccountSnapshot(account, householdId)) throw domainErrors.idempotencyConflict();
  return { account };
};

/**
 * Round3 MEDIUM: valida o snapshot `{ account }` campo a campo.
 * - `id`: string UUID (PG gera UUID; in-memory usa randomUUID);
 * - `householdId`: EXATAMENTE o household da tentativa (escopo);
 * - `name`: string não vazia; `kind`/`status`: vocabulário fechado;
 * - `balanceCents`: inteiro seguro.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_KINDS: ReadonlySet<string> = new Set(['bank', 'cash', 'credit_card']);
const ACCOUNT_STATUSES: ReadonlySet<string> = new Set(['active', 'inactive']);
const CATEGORY_KINDS: ReadonlySet<string> = new Set(['expense', 'income']);
const CATEGORY_STATUSES: ReadonlySet<string> = new Set(['active', 'inactive']);

const isAccountSnapshot = (value: unknown, householdId: string): value is Account => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string' || !UUID_RE.test(candidate['id'])) return false;
  if (candidate['householdId'] !== householdId) return false;
  if (typeof candidate['name'] !== 'string' || candidate['name'].trim().length === 0) return false;
  if (typeof candidate['kind'] !== 'string' || !ACCOUNT_KINDS.has(candidate['kind'])) return false;
  if (typeof candidate['balanceCents'] !== 'number' || !Number.isSafeInteger(candidate['balanceCents'])) {
    return false;
  }
  if (typeof candidate['status'] !== 'string' || !ACCOUNT_STATUSES.has(candidate['status'])) return false;
  return true;
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
  audit?: {
    operation: KeyedWriteAuditOperation;
    actorId: string;
    schema: 'canonical' | 'legacy';
    idempotencyKey?: string;
    beforeDescription?: string;
    afterDescription?: string;
  };
}): Promise<Transaction> => {
  const { pool, householdId, payload } = opts;
  const key = namespacedPendingV2Key(opts.idempotencyKey);
  if (opts.audit !== undefined && opts.audit.operation !== 'transactions.expense.create' && opts.audit.operation !== 'transactions.income.create' && opts.audit.operation !== 'transaction.update') {
    throw new Error(`unsupported V2 audit operation: ${String((opts.audit as { operation?: unknown }).operation)}`);
  }
  if (opts.audit?.operation === 'transaction.update' &&
      (opts.audit.idempotencyKey !== opts.idempotencyKey || typeof opts.audit.beforeDescription !== 'string' || typeof opts.audit.afterDescription !== 'string')) {
    throw new Error('transaction.update audit context incomplete');
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
         [householdId, opts.audit.actorId, opts.audit.operation, payloadHash, txId, JSON.stringify(opts.audit.operation === 'transaction.update'
           ? { entityType: 'transaction', state: 'completed', idempotencyKey: opts.audit.idempotencyKey, before: { description: opts.audit.beforeDescription }, after: { description: opts.audit.afterDescription } }
           : { entityType: 'transaction' })],
      );
      return;
    }
    await client.query(
      `INSERT INTO audit_logs
         (id, household_id, user_id, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (gen_random_uuid(), $1, NULL, $2, 'transaction', $3, $4, $5, NOW())`,
      [householdId, opts.audit.operation, txId,
        opts.audit.operation === 'transaction.update'
          ? JSON.stringify({ description: opts.audit.beforeDescription })
          : null,
        opts.audit.operation === 'transaction.update'
          ? JSON.stringify({ description: opts.audit.afterDescription, idempotencyKey: opts.audit.idempotencyKey, actorId: opts.audit.actorId, state: 'completed' })
          : null],
    );
  };
  try {
    return await withTransaction(pool, async (client) => {
      // A description CAS can otherwise reject a same-key concurrent retry
      // after the first transaction edits the row but before its idempotency
      // record commits. Serialize only this dedicated audited operation by
      // workspace/key, then read the completed replay before touching data.
      if (opts.audit?.operation === 'transaction.update') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pending-v2:transaction.update:${householdId}:${opts.idempotencyKey}`]);
      }
      const existing = await client.query<KeyRow>(SELECT_KEY, [householdId, key]);
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0]!;
        if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
        return parseResponse(row.response, householdId).transaction;
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
    return parseResponse(row.response, householdId).transaction;
  }
};

/**
 * ted-local.account-idempotency: key-idempotent V2 execution for
 * `accounts.create` — same claim-race contract as runKeyedMutation, but the
 * recorded envelope carries `{ account }` (never `{ transaction }`, so a
 * transaction record can never replay as an account and vice-versa).
 * No audit row: the V2 execution audit vocabulary covers only transaction
 * tools (SPEC §12); account creation records key → account with no audit.
 */
export const runKeyedAccountMutation = async (opts: {
  pool: Pool;
  householdId: string;
  idempotencyKey: string;
  payload: unknown;
  mutate: (client: PoolClient) => Promise<Account>;
}): Promise<Account> => {
  const { pool, householdId, payload } = opts;
  const key = namespacedPendingV2Key(opts.idempotencyKey);
  const payloadHash = hashPayloadV2(payload);
  try {
    return await withTransaction(pool, async (client) => {
      const existing = await client.query<KeyRow>(SELECT_KEY, [householdId, key]);
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0]!;
        if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
        return parseAccountResponse(row.response, householdId).account;
      }
      const result = await opts.mutate(client);
      const claimed = await client.query(INSERT_KEY, [
        householdId,
        key,
        payloadHash,
        JSON.stringify({ account: result }),
      ]);
      if ((claimed.rowCount ?? 0) === 0) throw new KeyReplaySignal();
      return result;
    });
  } catch (err) {
    if (err instanceof KeyReplaySignal) {
      const settled = await pool.query<KeyRow>(SELECT_KEY, [householdId, key]);
      const row = settled.rows[0];
      if (!row) throw domainErrors.idempotencyConflict();
      if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
      return parseAccountResponse(row.response, householdId).account;
    }
    // Round2 achado 1 — own-error path: esta tentativa observou ausência de
    // registro e falhou em seguida, mas um vencedor pode ter commitado no
    // intervalo (o SELECT desta tentativa correu antes do INSERT do vencedor).
    // Consulta o vencedor ANTES de propagar o erro próprio: mesma chave +
    // mesmo payload + envelope íntegro → replay; chave tomada com payload
    // divergente → conflict; sem linha (ou registro ilegível/corrompido) →
    // o erro original é propagado — nunca mascarado.
    let winner: KeyRow | undefined;
    try {
      const settled = await pool.query<KeyRow>(SELECT_KEY, [householdId, key]);
      winner = settled.rows[0];
    } catch {
      winner = undefined;
    }
    if (winner) {
      if (!matchesPayloadHash(winner.payload_hash, payload)) throw domainErrors.idempotencyConflict();
      try {
        return parseAccountResponse(winner.response, householdId).account;
      } catch {
        // Envelope do vencedor corrompido: vale o erro desta tentativa.
      }
    }
    throw err;
  }
};

/**
 * categories-create-api: key-idempotent V2 foundation for
 * `categories.create` — same claim-race contract as runKeyedAccountMutation,
 * but the recorded envelope carries `{ category }` (never `{ account }` /
 * `{ transaction }`, so records can never replay across entity kinds).
 * No audit row: the V2 execution audit vocabulary covers only transaction
 * tools; category creation records key → category with no audit. Effect +
 * snapshot commit atomically; same key + same payload replays the SAME id,
 * divergent payload conflicts, distinct households never collide.
 */
export const runKeyedCategoryMutation = async (opts: {
  pool: Pool;
  householdId: string;
  idempotencyKey: string;
  payload: unknown;
  mutate: (client: PoolClient) => Promise<Category>;
}): Promise<Category> => {
  const { pool, householdId, payload } = opts;
  const key = namespacedPendingV2Key(opts.idempotencyKey);
  const payloadHash = hashPayloadV2(payload);
  try {
    return await withTransaction(pool, async (client) => {
      const existing = await client.query<KeyRow>(SELECT_KEY, [householdId, key]);
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0]!;
        if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
        return parseCategoryResponse(row.response, householdId).category;
      }
      const result = await opts.mutate(client);
      const claimed = await client.query(INSERT_KEY, [
        householdId,
        key,
        payloadHash,
        JSON.stringify({ category: result }),
      ]);
      if ((claimed.rowCount ?? 0) === 0) throw new KeyReplaySignal();
      return result;
    });
  } catch (err) {
    if (err instanceof KeyReplaySignal) {
      const settled = await pool.query<KeyRow>(SELECT_KEY, [householdId, key]);
      const row = settled.rows[0];
      if (!row) throw domainErrors.idempotencyConflict();
      if (!matchesPayloadHash(row.payload_hash, payload)) throw domainErrors.idempotencyConflict();
      return parseCategoryResponse(row.response, householdId).category;
    }
    let winner: KeyRow | undefined;
    try {
      const settled = await pool.query<KeyRow>(SELECT_KEY, [householdId, key]);
      winner = settled.rows[0];
    } catch {
      winner = undefined;
    }
    if (winner) {
      if (!matchesPayloadHash(winner.payload_hash, payload)) throw domainErrors.idempotencyConflict();
      try {
        return parseCategoryResponse(winner.response, householdId).category;
      } catch {
        // Envelope do vencedor corrompido: vale o erro desta tentativa.
      }
    }
    throw err;
  }
};

const parseCategoryResponse = (response: unknown, householdId: string): { category: Category } => {
  let envelope: unknown = response;
  if (typeof response === 'string') {
    try {
      envelope = JSON.parse(response);
    } catch {
      throw domainErrors.idempotencyConflict();
    }
  }
  if (!envelope || typeof envelope !== 'object' || !('category' in envelope)) {
    throw domainErrors.idempotencyConflict();
  }
  const category = (envelope as { category?: unknown }).category;
  if (!isCategorySnapshot(category, householdId)) throw domainErrors.idempotencyConflict();
  return { category };
};

/**
 * Snapshot estrutural `{ category }` campo a campo: id UUID, household da
 * tentativa (escopo), nome não vazio, kind/status no vocabulário fechado,
 * MAIS todos os opcionais do contrato — parentId UUID quando presente,
 * icon/color string-ou-null, sortOrder inteiro seguro, isDefault/isSystem
 * boolean. Qualquer forma fora disso ('3' em sortOrder, null em parentId,
 * número em icon) nunca replaya: fail-closed `idempotency.conflict`.
 * Snapshot imutável por workspace+key, consultado antes de qualquer
 * estado mutável.
 */
const isCategorySnapshot = (value: unknown, householdId: string): value is Category => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string' || !UUID_RE.test(candidate['id'])) return false;
  if (candidate['householdId'] !== householdId) return false;
  if (typeof candidate['name'] !== 'string' || candidate['name'].trim().length === 0) return false;
  if (typeof candidate['kind'] !== 'string' || !CATEGORY_KINDS.has(candidate['kind'])) return false;
  if (typeof candidate['status'] !== 'string' || !CATEGORY_STATUSES.has(candidate['status'])) return false;
  if ('parentId' in candidate && candidate['parentId'] !== undefined) {
    if (typeof candidate['parentId'] !== 'string' || !UUID_RE.test(candidate['parentId'])) return false;
  }
  for (const key of ['icon', 'color'] as const) {
    const v = candidate[key];
    if (v !== undefined && v !== null && typeof v !== 'string') return false;
  }
  if (candidate['sortOrder'] !== undefined) {
    if (typeof candidate['sortOrder'] !== 'number' || !Number.isSafeInteger(candidate['sortOrder'])) return false;
  }
  for (const key of ['isDefault', 'isSystem'] as const) {
    const v = candidate[key];
    if (v !== undefined && typeof v !== 'boolean') return false;
  }
  return true;
};
