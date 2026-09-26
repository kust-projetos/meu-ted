import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import {
  computePendingOperationV2Hash,
  pendingOperationV2Schema,
  verifyPendingOperationV2Hash,
  type PendingOperationV2,
} from '@pi-finance/llm-contracts';
import { validateApprovalToolArgs } from './tool-registry.js';
import { buildTedReceipt } from '../reconciliation/effects-registry.js';
import { buildObservabilityEvent } from '../audit/events.js';

export type PendingOperationV2Status = 'proposed' | 'confirmed' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export type PendingIdentity = Pick<PendingOperationV2, 'workspaceId' | 'actorId' | 'deviceId'>;
export type PendingOperationV2Record = PendingOperationV2 & {
  id: string;
  status: PendingOperationV2Status;
  attestation?: string;
  execution?: unknown;
  /**
   * V052 execution-recovery surface (SPEC §12). Fresh records carry
   * executionAttemptCount 0 with the remaining fields absent; claim/lease
   * writers (T2.3/T2.4) populate them later. Read-only mapping here —
   * no protocol behavior changes.
   */
  attestationIssuedAt?: string;
  executionClaimedAt?: string;
  executionLeaseExpiresAt?: string;
  executionAttemptCount?: number;
  failureCode?: string;
  mutationId?: string;
  /**
   * Set only on propose() results: true when the call deduplicated onto an
   * already-persisted operation (same idempotency key + same proposal hash),
   * false when a new row was created. Never persisted; absent on get/confirm.
   */
  existing?: boolean;
};
export type PendingAuditEvent = { operationId: string; event: 'propose' | 'confirm' | 'execute' | 'cancel' | 'expire' | 'fail'; actorId: string; at: string };
export type PendingExecutor = (operation: PendingOperationV2) => Promise<unknown>;

export class PendingOperationV2Error extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409, readonly details?: unknown) { super(message); this.name = 'PendingOperationV2Error'; }
}

const identityMatches = (a: PendingIdentity, b: PendingIdentity): boolean =>
  a.workspaceId === b.workspaceId && a.actorId === b.actorId && a.deviceId === b.deviceId;
const attestation = (): string => randomBytes(32).toString('base64url');

/**
 * SPEC §7.4: no pending operation the executor would reject may reach the DB.
 * Validates normalizedArgs against the registry inputSchema for the requested
 * tool BEFORE persisting. Defense-in-depth alongside the propose route, which
 * rejects earlier with the same codes for a richer HTTP shape.
 */
const assertCanonicalArgs = (fail: (code: string, message: string, statusCode?: number, details?: unknown) => never, operation: PendingOperationV2): void => {
  const checked = validateApprovalToolArgs(operation.tool, operation.normalizedArgs);
  if (checked.success) return;
  if (checked.code === 'tool.not_allowed') fail('tool.not_allowed', 'Ferramenta não permitida no protocolo de aprovação.', 403);
  fail('approval.invalid_args', 'Argumentos inválidos para a ferramenta de aprovação.', 422, checked.issues);
};
const nowIso = (): string => new Date().toISOString();

/**
 * Security P2 (v2-attestation-route-and-ttl): authoritative TTL helpers.
 * `createdAt` is always server now (a crafted backdated/future `createdAt`
 * in the proposed object is ignored for the lifetime window); the effective
 * expiry is `min(requestedExpiresAt, now + PENDING_V2_MAX_TTL_MS)`. A past
 * (already-expired) effective expiry fails fast with `approval.expired`
 * instead of persisting a dead row. The proposal hash is unaffected: it
 * covers only tool/normalizedArgs/identity, never timestamps.
 */
export const clampPendingV2ExpiresAt = (requestedExpiresAt: string, nowMs = Date.now()): string => {
  const requested = Date.parse(requestedExpiresAt);
  const effective = Number.isNaN(requested)
    ? nowMs + PENDING_V2_MAX_TTL_MS
    : Math.min(requested, nowMs + PENDING_V2_MAX_TTL_MS);
  return new Date(effective).toISOString();
};

/**
 * T3.2 (SPEC §15.1): every TX2 success carries a MutationReceipt with an
 * API-generated mutationId, registry-derived affectedTargets and the origin
 * operationId. Executors built on the tool registry already attach one —
 * honor its mutationId; otherwise synthesize it here from the persisted
 * tool so a custom executor can never produce a receipt-less success.
 * The returned mutationId is what TX2 persists into `mutation_id`.
 */
const withTedReceipt = (
  result: { status: string; operationId: string; receipt?: unknown },
  tool: string,
): { enriched: Record<string, unknown>; mutationId: string } => {
  const existing = result.receipt as { mutationId?: unknown } | undefined;
  if (existing && typeof existing.mutationId === 'string' && existing.mutationId.length > 0) {
    return { enriched: result as Record<string, unknown>, mutationId: existing.mutationId };
  }
  const receipt = buildTedReceipt(
    tool as 'transactions.expense.create' | 'transactions.income.create',
    result.operationId,
  );
  return { enriched: { ...result, receipt }, mutationId: receipt.mutationId };
};

/**
 * SPEC §10 / ADR-013: execution lease written at claim (TX1). The reconciler
 * (T2.4) reaps `executing` rows past this deadline; the value stays a single
 * exported constant so the reconciler and the claim share it by construction.
 */
export const PENDING_V2_EXECUTION_LEASE_MS = 60_000;

/**
 * Security P2 (v2-attestation-route-and-ttl): server-authoritative ceiling
 * for a pending operation's lifetime. `expiresAt` is client-supplied at
 * propose time and could otherwise pin an approval open indefinitely; both
 * the route and the store clamp the effective expiry to
 * `createdAt(server now) + PENDING_V2_MAX_TTL_MS` (existing 30 min norm).
 * Single constant shared by route + both store backends by construction.
 */
export const PENDING_V2_MAX_TTL_MS = 30 * 60_000;

/**
 * SPEC §11 (T2.4): lease duration is configurable — explicit override wins,
 * then `PENDING_V2_EXECUTION_LEASE_MS` env, then the 60s default constant
 * (which stays the default source). Claim (TX1) and the reconciler renew
 * both resolve through here so they share the window by construction.
 */
export type PendingOperationV2StoreOptions = {
  /** Execution-lease window in milliseconds. Must be > 0 to take effect. */
  leaseMs?: number;
  /**
   * V4 T3.1 / T0.4.6 (SPEC §24.6): sink for `mutation.reconcile.enqueued` —
   * emitted when an operation ENTERS reconcile (lease renewed, before the
   * executor re-runs). Follows the T2.2 precedent: injected in tests,
   * defaulting to best-effort structured JSON logging. Telemetry only —
   * never throws, never alters the recovery path.
   */
  observabilitySink?: ReconcileEnqueuedSink;
};

/**
 * V4 T3.1 / T0.4.6 (SPEC §24.6): telemetry emitted when an operation enters
 * reconcile. Dimensions: workspaceId, operationId, reason. Built through the
 * fail-closed buildObservabilityEvent contract.
 */
export type ReconcileEnqueuedTelemetryEvent = {
  eventType: 'mutation.reconcile.enqueued';
  workspaceId: string;
  operationId: string;
  reason: string;
};

export type ReconcileEnqueuedSink = (event: ReconcileEnqueuedTelemetryEvent) => void;

/** Reason recorded when reconcile starts from an expired executing lease. */
export const RECONCILE_REASON_LEASE_EXPIRED = 'executing-lease-expired';

/** Best-effort emission (T2.2 pattern): validates, sinks-or-logs, never throws. */
const emitReconcileEnqueued = (
  sink: ReconcileEnqueuedSink | undefined,
  event: ReconcileEnqueuedTelemetryEvent,
): void => {
  try {
    buildObservabilityEvent('mutation.reconcile.enqueued', {
      workspaceId: event.workspaceId,
      operationId: event.operationId,
      reason: event.reason,
    });
    if (sink) sink(event);
    else console.info(JSON.stringify(event));
  } catch {
    // Telemetry never breaks recovery.
  }
};

export const resolvePendingV2LeaseMs = (override?: number): number => {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return Math.floor(override);
  const fromEnv = Number(process.env.PENDING_V2_EXECUTION_LEASE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return PENDING_V2_EXECUTION_LEASE_MS;
};

/**
 * SPEC §10: TX2 failure persists a SANITIZED code only — never the error
 * message, stack, prompt, or executor payload content. Protocol errors keep
 * their code; foreign string codes are allow-listed by shape; everything
 * else collapses to `executor.failed`.
 */
export const sanitizePendingV2FailureCode = (error: unknown): string => {
  if (error instanceof PendingOperationV2Error) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(code)) return code;
  return 'executor.failed';
};

export type PendingOperationV2Store = {
  propose(operation: PendingOperationV2): Promise<PendingOperationV2Record>;
  get(id: string, identity: PendingIdentity): Promise<PendingOperationV2Record>;
  /**
   * T1.5 (SPEC §8.3): authoritative listing of non-terminal operations for
   * the AUTHENTICATED identity (workspace + actor + device). Never takes
   * client-declared ids. Read-only: no state transitions, no attestation.
   */
  listActive(identity: PendingIdentity): Promise<readonly PendingOperationV2Record[]>;
  confirm(id: string, identity: PendingIdentity): Promise<PendingOperationV2Record>;
  /**
   * Security P2 (v2-attestation-route-and-ttl): `expectedId` binds the URL
   * operation id to the claim. When supplied, the attestation only claims
   * the row with that id — an A-attestation sent to a B-URL is refused
   * with `approval.attestation_replayed` (403) with zero effect (no
   * consumption, no status transition, executor never runs), tenant-scoped
   * by the identity like every other path. Omitted (legacy direct-store
   * callers) keeps the previous token-only claim.
   */
  execute(token: string, identity: PendingIdentity, executor: PendingExecutor, expectedId?: string): Promise<PendingOperationV2Record>;
  retry(id: string, identity: PendingIdentity): Promise<PendingOperationV2Record>;
  cancel(id: string, identity: PendingIdentity): Promise<PendingOperationV2Record>;
  expire(id: string, identity: PendingIdentity): Promise<PendingOperationV2Record>;
  /**
   * SPEC §11.3 (T2.4): reconcile an abandoned `executing` operation whose
   * lease expired — crash recovery, NOT a new approval. Renews the lease,
   * bumps the attempt, and re-runs the SAME executor with the SAME persisted
   * idempotencyKey, persisting TX2 succeeded/failed exactly like execute().
   * Valid lease → `approval.execution_in_progress`; any non-`executing`
   * state (including `confirmed`, whose recovery is attestation re-emission
   * per §9/T2.2) → `approval.reconcile_not_allowed`. Terminal states never
   * re-enter execution.
   *
   * HTTP attach point (wired in routes/pending-operations.ts):
   * `POST /pending-operations/v2/:id/reconcile` (capability
   * `financial.approval.reconcile`) →
   * `v2Store.reconcileExpiredExecuting(id, identity, v2Executor)`.
   *
   * Stale-finalization guard (T6.1): every TX2 write below (execute and
   * reconcile, success and failure) is conditional on the operation STILL
   * being `executing` with the attempt count captured at claim/renew. A
   * late TX2 arriving after recovery already finalized the operation is a
   * no-op returning the authoritative record — status, receipt and
   * mutationId are never overwritten.
   */
  reconcileExpiredExecuting(
    id: string,
    identity: PendingIdentity,
    executor: PendingExecutor,
    opts?: { leaseMs?: number },
  ): Promise<PendingOperationV2Record>;
  readonly audit: readonly PendingAuditEvent[];
};

type PendingV2Row = Record<string, unknown>;
const hashAttestation = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const isoOrUndefined = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
const textOrUndefined = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);
const mapV2 = (row: PendingV2Row, token?: string): PendingOperationV2Record => {
  const attestationIssuedAt = isoOrUndefined(row.attestation_issued_at);
  const executionClaimedAt = isoOrUndefined(row.execution_claimed_at);
  const executionLeaseExpiresAt = isoOrUndefined(row.execution_lease_expires_at);
  const failureCode = textOrUndefined(row.failure_code);
  const mutationId = textOrUndefined(row.mutation_id);
  return {
    version: 2,
    id: String(row.id), workspaceId: String(row.workspace_id), actorId: String(row.actor_id), deviceId: String(row.device_id),
    tool: String(row.tool), normalizedArgs: (row.normalized_args ?? {}) as PendingOperationV2['normalizedArgs'],
    proposalHash: String(row.proposal_hash), idempotencyKey: String(row.idempotency_key),
    createdAt: new Date(row.created_at as string).toISOString(), expiresAt: new Date(row.expires_at as string).toISOString(),
    bindings: { workspaceId: String(row.workspace_id), actorId: String(row.actor_id), deviceId: String(row.device_id) },
    status: (row.execution_status ?? 'proposed') as PendingOperationV2Status,
    executionAttemptCount: typeof row.execution_attempt_count === 'number' ? row.execution_attempt_count : Number(row.execution_attempt_count ?? 0),
    ...(token ? { attestation: token } : {}),
    ...(row.execution_result !== null && row.execution_result !== undefined ? { execution: row.execution_result } : {}),
    ...(attestationIssuedAt !== undefined ? { attestationIssuedAt } : {}),
    ...(executionClaimedAt !== undefined ? { executionClaimedAt } : {}),
    ...(executionLeaseExpiresAt !== undefined ? { executionLeaseExpiresAt } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(mutationId !== undefined ? { mutationId } : {}),
  };
};

export const createPostgresPendingOperationV2Store = (
  pool: Pool,
  options?: PendingOperationV2StoreOptions,
): PendingOperationV2Store => {
  const events: PendingAuditEvent[] = [];
  const fail = (code: string, message: string, statusCode = 409): never => { throw new PendingOperationV2Error(code, message, statusCode); };
  const read = async (client: PoolClient, id: string, identity: PendingIdentity, forUpdate = false): Promise<PendingV2Row> => {
    const result = await client.query<PendingV2Row>(`SELECT * FROM pending_operations WHERE id = $1 AND workspace_id = $2 AND protocol_version = 2${forUpdate ? ' FOR UPDATE' : ''}`, [id, identity.workspaceId]);
    const row = result.rows[0];
    if (!row) return fail('approval.not_found', 'Operação pendente não encontrada.', 404);
    if (String(row.actor_id) !== identity.actorId || String(row.device_id) !== identity.deviceId) return fail('approval.binding_mismatch', 'A operação não pertence ao contexto autenticado.', 403);
    return row;
  };
  return {
    get audit() { return events; },
    async propose(operation) {
      if (!pendingOperationV2Schema.safeParse(operation).success || !(await verifyPendingOperationV2Hash(operation))) fail('approval.invalid_hash', 'Proposta V2 inválida ou hash divergente.', 400);
      assertCanonicalArgs(fail, operation);
      // P2 TTL: authoritative server time — ignore any crafted createdAt for
      // the lifetime window, clamp the expiry to the server max, fail fast
      // on a birth-expired proposal. DB created_at stays the default NOW().
      const nowMs = Date.now();
      const effectiveExpiresAt = clampPendingV2ExpiresAt(operation.expiresAt, nowMs);
      if (Date.parse(effectiveExpiresAt) <= nowMs) fail('approval.expired', 'A proposta já expirou.', 409);
      const result = await pool.query<PendingV2Row>(`INSERT INTO pending_operations (workspace_id, requester_id, operation, payload, reason, idempotency_key, status, expires_at, protocol_version, actor_id, device_id, tool, normalized_args, proposal_hash, execution_status) VALUES ($1,$2,$3,$4::jsonb,'high_value',$5,'pending',$6,$7,$8,$9,$10,$11::jsonb,$12,'proposed') ON CONFLICT (workspace_id,idempotency_key) WHERE protocol_version = 2 AND workspace_id IS NOT NULL AND idempotency_key IS NOT NULL DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING *, (xmax = 0) AS is_insert`, [operation.workspaceId, operation.actorId, operation.tool, JSON.stringify(operation.normalizedArgs), operation.idempotencyKey, effectiveExpiresAt, 2, operation.actorId, operation.deviceId, operation.tool, JSON.stringify(operation.normalizedArgs), operation.proposalHash]);
      const row = result.rows[0]!;
      if (String(row.proposal_hash) !== operation.proposalHash) fail('idempotency.conflict', 'Chave de idempotência já utilizada com proposta diferente.');
      const existing = row.is_insert === false;
      events.push({ operationId: String(row.id), event: 'propose', actorId: operation.actorId, at: nowIso() });
      return { ...mapV2(row), existing };
    },
    async get(id, identity) { return mapV2(await read({ query: pool.query.bind(pool) } as unknown as PoolClient, id, identity)); },
    /**
     * T1.5 (SPEC §8.3) — appended after the terminal transitions so the
     * execute/claim/lease surface above stays untouched (T2.4 owns it).
     * Read-only scan scoped by the authenticated identity; terminal states
     * (succeeded/cancelled/expired) are excluded, actionable
     * (proposed/confirmed) and recovery-relevant (executing/failed) states
     * are included as listing metadata. No covering index is added here:
     * the table holds only live pending operations and the existing
     * V051/V052 partial indexes already narrow the sibling paths — a
     * dedicated (workspace, actor, device, status) index is a V053
     * follow-up if the scan ever shows up in query stats.
     */
    async listActive(identity) {
      const result = await pool.query<PendingV2Row>(
        `SELECT * FROM pending_operations WHERE workspace_id = $1 AND actor_id = $2 AND device_id = $3 AND protocol_version = 2 AND execution_status IN ('proposed','confirmed','executing','failed') ORDER BY created_at DESC`,
        [identity.workspaceId, identity.actorId, identity.deviceId],
      );
      return result.rows.map((row) => mapV2(row));
    },
    async confirm(id, identity) { return withTransaction(pool, async (client) => { const row = await read(client, id, identity, true); const status = String(row.execution_status); if (Date.parse(String(row.expires_at)) <= Date.now()) { await client.query("UPDATE pending_operations SET execution_status='expired' WHERE id=$1", [id]); events.push({ operationId: id, event: 'expire', actorId: identity.actorId, at: nowIso() }); return fail('approval.expired', 'A proposta expirou.'); } if (status === 'confirmed') {
      // SPEC §9 (H-03) recoverable confirm: lost confirm responses re-emit.
      // Unconsumed attestation rotates atomically in this same transaction:
      // new hash replaces the old (old token invalid), only the new token
      // is returned. An already-consumed attestation never re-emits.
      if (row.attestation_consumed_at !== null && row.attestation_consumed_at !== undefined) return mapV2(row);
      const reissued = attestation();
      const reemitted = await client.query<PendingV2Row>("UPDATE pending_operations SET attestation_hash=$2, attestation_issued_at=NOW() WHERE id=$1 RETURNING *", [id, hashAttestation(reissued)]);
      events.push({ operationId: id, event: 'confirm', actorId: identity.actorId, at: nowIso() });
      return mapV2(reemitted.rows[0]!, reissued);
    } if (status !== 'proposed') return fail('approval.not_pending', 'A operação não está pendente.'); const token = attestation(); const updated = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='confirmed', attestation_hash=$2, attestation_issued_at=NOW() WHERE id=$1 RETURNING *", [id, hashAttestation(token)]); events.push({ operationId: id, event: 'confirm', actorId: identity.actorId, at: nowIso() }); return mapV2(updated.rows[0]!, token); }); },
    async execute(token, identity, executor, expectedId?) {
      // TX1 — claim. Consumes the attestation, marks `executing`, writes the
      // lease columns, and COMMITS before the executor runs: a failure after
      // this point can never roll the claim back (H-04). P2: when expectedId
      // (the URL id) is supplied the claim additionally filters by id, so a
      // cross-URL attestation can never claim another row — atomically, in
      // this single UPDATE.
      const claimed = await withTransaction(pool, async (client) => {
        const claim = expectedId === undefined
          ? await client.query<PendingV2Row>("UPDATE pending_operations SET attestation_consumed_at=NOW(), execution_status='executing', execution_claimed_at=NOW(), execution_lease_expires_at=NOW() + ($5 * INTERVAL '1 millisecond'), execution_attempt_count=execution_attempt_count+1 WHERE workspace_id=$1 AND actor_id=$2 AND device_id=$3 AND protocol_version=2 AND attestation_hash=$4 AND attestation_consumed_at IS NULL AND execution_status='confirmed' AND expires_at>NOW() RETURNING *", [identity.workspaceId, identity.actorId, identity.deviceId, hashAttestation(token), resolvePendingV2LeaseMs(options?.leaseMs)])
          : await client.query<PendingV2Row>("UPDATE pending_operations SET attestation_consumed_at=NOW(), execution_status='executing', execution_claimed_at=NOW(), execution_lease_expires_at=NOW() + ($6 * INTERVAL '1 millisecond'), execution_attempt_count=execution_attempt_count+1 WHERE id=$5 AND workspace_id=$1 AND actor_id=$2 AND device_id=$3 AND protocol_version=2 AND attestation_hash=$4 AND attestation_consumed_at IS NULL AND execution_status='confirmed' AND expires_at>NOW() RETURNING *", [identity.workspaceId, identity.actorId, identity.deviceId, hashAttestation(token), expectedId, resolvePendingV2LeaseMs(options?.leaseMs)]);
        const row = claim.rows[0];
        if (!row) {
          // Claim miss: distinguish an in-flight execution (valid OR expired
          // lease — recovery belongs to the reconciler, never to a second
          // executor run) from a genuinely invalid/replayed attestation.
          // P2: the probe is id-aware when expectedId is supplied, so a
          // cross-URL attestation reports replay (never in-progress of
          // another row, never an existence oracle).
          const probe = expectedId === undefined
            ? await pool.query<PendingV2Row>("SELECT execution_status FROM pending_operations WHERE workspace_id=$1 AND protocol_version=2 AND attestation_hash=$2 LIMIT 1", [identity.workspaceId, hashAttestation(token)])
            : await pool.query<PendingV2Row>("SELECT execution_status FROM pending_operations WHERE id=$3 AND workspace_id=$1 AND protocol_version=2 AND attestation_hash=$2 LIMIT 1", [identity.workspaceId, hashAttestation(token), expectedId]);
          if (probe.rows[0] && String(probe.rows[0].execution_status) === 'executing') {
            return fail('approval.execution_in_progress', 'Execução já em andamento.', 409);
          }
          return fail('approval.attestation_replayed', 'Attestation inválida ou já consumida.', 403);
        }
        events.push({ operationId: String(row.id), event: 'execute', actorId: identity.actorId, at: nowIso() });
        return row;
      });
      // T6.1 stale-finalization guard: the attempt captured at claim. Every
      // TX2 below only persists while the row is STILL `executing` with this
      // attempt — a recovery that finalized first wins, the late TX2 is a
      // no-op returning the authoritative record (never overwrites
      // status/receipt/mutationId).
      const claimAttempt = Number((claimed as PendingV2Row).execution_attempt_count ?? 0);
      const stillOurs = (current: PendingV2Row): boolean =>
        String(current.execution_status) === 'executing' &&
        Number(current.execution_attempt_count ?? 0) === claimAttempt;
      // The executor runs OUTSIDE any transaction with the SAME persisted
      // idempotencyKey (WriteStore dedup unchanged).
      let result: unknown;
      try {
        result = await executor(mapV2(claimed));
      } catch (error) {
        // TX2 (failure). The terminal persist COMMITS before the error
        // propagates: the consumed attestation is never resurrected. Guarded:
        // when recovery already finalized, the late error still propagates
        // (the caller's attempt genuinely failed) but persists nothing and
        // records no fail event — the authoritative record is untouched.
        const persistedFailure = await withTransaction(pool, async (client) => {
          const current = await read(client, String(claimed.id), identity, true);
          if (!stillOurs(current)) return false;
          await client.query("UPDATE pending_operations SET execution_status='failed', failed_at=NOW(), failure_code=$2 WHERE id=$1", [String(claimed.id), sanitizePendingV2FailureCode(error)]);
          return true;
        });
        if (persistedFailure) events.push({ operationId: String(claimed.id), event: 'fail', actorId: identity.actorId, at: nowIso() });
        throw error;
      }
      if (!result || typeof result !== 'object' || (result as { status?: unknown }).status !== 'succeeded' || typeof (result as { operationId?: unknown }).operationId !== 'string') {
        // Discriminated outcome: the guard must be evaluated against the row
        // AS READ INSIDE the transaction. Checking it again against the
        // post-update row would misclassify the fresh persist (already
        // 'failed') as stale and silently swallow the protocol error.
        const outcome = await withTransaction(pool, async (client) => {
          const current = await read(client, String(claimed.id), identity, true);
          if (!stillOurs(current)) return { stale: true as const, row: current };
          const failed = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='failed', failed_at=NOW(), failure_code=$2 WHERE id=$1 RETURNING *", [String(claimed.id), 'approval.incomplete_result']);
          return { stale: false as const, row: failed.rows[0]! };
        });
        // Stale incomplete result after recovery finalized: authoritative
        // record wins, no overwrite, no failure reported.
        if (outcome.stale) return mapV2(outcome.row);
        events.push({ operationId: String(claimed.id), event: 'fail', actorId: identity.actorId, at: nowIso() });
        return fail('approval.incomplete_result', 'Executor retornou resultado incompleto.');
      }
      // TX2 (success). Guarded: recovery-finalized rows are returned as-is.
      const updated = await withTransaction(pool, async (client) => {
        const current = await read(client, String(claimed.id), identity, true);
        if (!stillOurs(current)) return current;
        const { enriched, mutationId } = withTedReceipt(
          result as { status: string; operationId: string; receipt?: unknown },
          String(claimed.tool),
        );
        const terminal = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='succeeded', execution_result=$2::jsonb, mutation_id=$3 WHERE id=$1 RETURNING *", [String(claimed.id), JSON.stringify(enriched), mutationId]);
        return terminal.rows[0]!;
      });
      return mapV2(updated);
    },
    async reconcileExpiredExecuting(id, identity, executor, opts) {
      // TX-R — renew. Row lock serializes concurrent reconciles: the loser
      // observes the renewed (valid) lease or the terminal state and aborts
      // WITHOUT running the executor a second time.
      const renewed = await withTransaction(pool, async (client) => {
        const row = await read(client, id, identity, true);
        const status = String(row.execution_status);
        // `confirmed` recovery is attestation re-emission (§9, T2.2) — the
        // lease path must never touch it. Asserted explicitly, not folded
        // into the generic guard below.
        if (status === 'confirmed') return fail('approval.reconcile_not_allowed', 'Operação confirmed recupera-se por reemissão de attestation, nunca por lease.');
        if (status !== 'executing') return fail('approval.reconcile_not_allowed', 'Reconciliação disponível somente para executing com lease expirada.');
        // node-pg returns TIMESTAMPTZ as a JS Date: use its ms value
        // directly. Date.parse(String(date)) truncates to whole seconds
        // (Date#toString has no ms), which makes a freshly renewed lease
        // read as already expired whenever both fall in the same second —
        // a concurrent reconciler would then renew twice (attempt 3,
        // double executor run) instead of aborting with
        // execution_in_progress.
        const leaseValue = row.execution_lease_expires_at;
        const leaseExpiresAt = leaseValue instanceof Date ? leaseValue.getTime() : Date.parse(String(leaseValue));
        if (!Number.isNaN(leaseExpiresAt) && leaseExpiresAt > Date.now()) return fail('approval.execution_in_progress', 'Execução já em andamento.');
        const next = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_lease_expires_at=NOW() + ($2 * INTERVAL '1 millisecond'), execution_attempt_count=execution_attempt_count+1 WHERE id=$1 RETURNING *", [id, resolvePendingV2LeaseMs(opts?.leaseMs ?? options?.leaseMs)]);
        events.push({ operationId: id, event: 'execute', actorId: identity.actorId, at: nowIso() });
        return next.rows[0]!;
      });
      // V4 T3.1 / T0.4.6: the operation ENTERS reconcile here (lease renewed,
      // executor about to re-run). Telemetry only.
      emitReconcileEnqueued(options?.observabilitySink, {
        eventType: 'mutation.reconcile.enqueued',
        workspaceId: identity.workspaceId,
        operationId: id,
        reason: RECONCILE_REASON_LEASE_EXPIRED,
      });
      // The SAME executor runs OUTSIDE any transaction with the SAME
      // persisted idempotencyKey (recovery, not a new approval). T6.1
      // stale-finalization guard mirrors execute(): the renew attempt is
      // captured, and TX2 only persists while the row is STILL `executing`
      // with that attempt (a concurrent direct TX2 that finalized first wins).
      const renewAttempt = Number((renewed as PendingV2Row).execution_attempt_count ?? 0);
      const stillRenewed = (current: PendingV2Row): boolean =>
        String(current.execution_status) === 'executing' &&
        Number(current.execution_attempt_count ?? 0) === renewAttempt;
      let result: unknown;
      try {
        result = await executor(mapV2(renewed));
      } catch (error) {
        // TX2 (failure). Same shape as execute(): sanitized code only.
        const persistedFailure = await withTransaction(pool, async (client) => {
          const current = await read(client, id, identity, true);
          if (!stillRenewed(current)) return false;
          await client.query("UPDATE pending_operations SET execution_status='failed', failed_at=NOW(), failure_code=$2 WHERE id=$1", [id, sanitizePendingV2FailureCode(error)]);
          return true;
        });
        if (persistedFailure) events.push({ operationId: id, event: 'fail', actorId: identity.actorId, at: nowIso() });
        throw error;
      }
      if (!result || typeof result !== 'object' || (result as { status?: unknown }).status !== 'succeeded' || typeof (result as { operationId?: unknown }).operationId !== 'string') {
        // Same discriminated outcome as execute(): guard evaluated against
        // the row AS READ, never against the post-update row.
        const outcome = await withTransaction(pool, async (client) => {
          const current = await read(client, id, identity, true);
          if (!stillRenewed(current)) return { stale: true as const, row: current };
          const failed = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='failed', failed_at=NOW(), failure_code=$2 WHERE id=$1 RETURNING *", [id, 'approval.incomplete_result']);
          return { stale: false as const, row: failed.rows[0]! };
        });
        if (outcome.stale) return mapV2(outcome.row);
        events.push({ operationId: id, event: 'fail', actorId: identity.actorId, at: nowIso() });
        return fail('approval.incomplete_result', 'Executor retornou resultado incompleto.');
      }
      // TX2 (success). Guarded: direct-TX2-finalized rows are returned as-is.
      const updated = await withTransaction(pool, async (client) => {
        const current = await read(client, id, identity, true);
        if (!stillRenewed(current)) return current;
        const { enriched, mutationId } = withTedReceipt(
          result as { status: string; operationId: string; receipt?: unknown },
          String(renewed.tool),
        );
        const terminal = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='succeeded', execution_result=$2::jsonb, mutation_id=$3 WHERE id=$1 RETURNING *", [id, JSON.stringify(enriched), mutationId]);
        return terminal.rows[0]!;
      });
      return mapV2(updated);
    },
    async retry(id, identity) { return withTransaction(pool, async (client) => { const row = await read(client, id, identity, true); if (String(row.execution_status) !== 'failed') return fail('approval.retry_not_allowed', 'Retry disponível somente após falha.'); const token = attestation(); const updated = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='confirmed', attestation_hash=$2, attestation_consumed_at=NULL, attestation_issued_at=NOW() WHERE id=$1 RETURNING *", [id, hashAttestation(token)]); events.push({ operationId: id, event: 'confirm', actorId: identity.actorId, at: nowIso() }); return mapV2(updated.rows[0]!, token); }); },
    async cancel(id, identity) { return withTransaction(pool, async (client) => { const row = await read(client, id, identity, true); if (!['proposed','confirmed'].includes(String(row.execution_status))) return fail('approval.not_pending', 'A operação não está pendente.'); const updated = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='cancelled' WHERE id=$1 RETURNING *", [id]); events.push({ operationId: id, event: 'cancel', actorId: identity.actorId, at: nowIso() }); return mapV2(updated.rows[0]!); }); },
    async expire(id, identity) { return withTransaction(pool, async (client) => { const row = await read(client, id, identity, true); if (!['proposed','confirmed'].includes(String(row.execution_status))) return fail('approval.not_pending', 'A operação não está pendente.'); const updated = await client.query<PendingV2Row>("UPDATE pending_operations SET execution_status='expired' WHERE id=$1 RETURNING *", [id]); events.push({ operationId: id, event: 'expire', actorId: identity.actorId, at: nowIso() }); return mapV2(updated.rows[0]!); }); },
  };
};

export const createInMemoryPendingOperationV2Store = (
  options?: PendingOperationV2StoreOptions,
): PendingOperationV2Store => {
  const records = new Map<string, PendingOperationV2Record>();
  const tokens = new Map<string, { id: string; consumed: boolean }>();
  const events: PendingAuditEvent[] = [];
  const fail = (code: string, message: string, statusCode = 409): never => { throw new PendingOperationV2Error(code, message, statusCode); };
  const resolve = (id: string, identity: PendingIdentity): PendingOperationV2Record => {
    const record = records.get(id);
    if (!record) return fail('approval.not_found', 'Operação pendente não encontrada.', 404);
    if (!identityMatches(record, identity)) return fail('approval.binding_mismatch', 'A operação não pertence ao contexto autenticado.', 403);
    if (record.status === 'proposed' || record.status === 'confirmed') {
      if (Date.parse(record.expiresAt) <= Date.now()) { record.status = 'expired'; events.push({ operationId: id, event: 'expire', actorId: record.actorId, at: nowIso() }); }
    }
    return record;
  };
  const issue = (record: PendingOperationV2Record): PendingOperationV2Record => {
    const token = attestation();
    record.attestation = token;
    tokens.set(token, { id: record.id, consumed: false });
    return record;
  };
  // T3.3: terminal success responses mirror the Postgres store (mapV2) —
  // the plaintext attestation NEVER leaves the store, even consumed. The
  // execution response is the one the Agent relays a receipt projection
  // from, so no authority material may ride along.
  const expose = (record: PendingOperationV2Record): PendingOperationV2Record => {
    const { attestation: _omitted, ...exposed } = record;
    return exposed;
  };

  return {
    get audit() { return events; },
    async propose(operation) {
      if (!pendingOperationV2Schema.safeParse(operation).success || !(await verifyPendingOperationV2Hash(operation))) fail('approval.invalid_hash', 'Proposta V2 inválida ou hash divergente.', 400);
      assertCanonicalArgs(fail, operation);
      // P2 TTL (in-memory mirror of the Postgres path): authoritative server
      // time — a crafted backdated/future createdAt never extends the
      // lifetime window; the expiry is clamped to the server max and a
      // birth-expired proposal fails fast instead of persisting a dead row.
      const nowMs = Date.now();
      const effectiveExpiresAt = clampPendingV2ExpiresAt(operation.expiresAt, nowMs);
      if (Date.parse(effectiveExpiresAt) <= nowMs) fail('approval.expired', 'A proposta já expirou.', 409);
      const authoritativeCreatedAt = new Date(nowMs).toISOString();
      const existing = [...records.values()].find((r) => r.workspaceId === operation.workspaceId && r.idempotencyKey === operation.idempotencyKey);
      if (existing) {
        if (existing.proposalHash !== operation.proposalHash) fail('idempotency.conflict', 'Chave de idempotência já utilizada com proposta diferente.');
        return { ...existing, existing: true };
      }
      const record: PendingOperationV2Record = { ...operation, createdAt: authoritativeCreatedAt, expiresAt: effectiveExpiresAt, id: randomUUID(), status: 'proposed', executionAttemptCount: 0 };
      records.set(record.id, record);
      events.push({ operationId: record.id, event: 'propose', actorId: record.actorId, at: nowIso() });
      return { ...record, existing: false };
    },
    async get(id, identity) {
      // Plaintext attestations never leave the store via reads: only the
      // confirm/retry responses carry the newly issued token.
      const { attestation: _omitted, ...exposed } = resolve(id, identity);
      return exposed;
    },
    async confirm(id, identity) {
      const record = resolve(id, identity);
      if (record.status === 'expired') fail('approval.expired', 'A proposta expirou.');
      if (record.status === 'confirmed') {
        // SPEC §9 (H-03) recoverable confirm: mirror of the Postgres
        // rotation — a new token replaces the old one, the old entry is
        // marked consumed so exactly one attestation stays valid. An
        // already-consumed attestation never re-emits (replay path).
        const current = record.attestation ? tokens.get(record.attestation) : undefined;
        if (!current || current.consumed || current.id !== record.id) {
          const { attestation: _omitted, ...exposed } = record;
          return exposed;
        }
        current.consumed = true;
        record.attestationIssuedAt = nowIso();
        issue(record);
        events.push({ operationId: id, event: 'confirm', actorId: record.actorId, at: nowIso() });
        return record;
      }
      if (record.status !== 'proposed') fail('approval.not_pending', 'A proposta não está pendente.');
      record.status = 'confirmed';
      record.attestationIssuedAt = nowIso();
      issue(record);
      events.push({ operationId: id, event: 'confirm', actorId: record.actorId, at: nowIso() });
      return record;
    },
    async execute(token, identity, executor, expectedId?) {
      const found = tokens.get(token);
      if (!found) throw new PendingOperationV2Error('approval.attestation_replayed', 'Attestation inválida ou já consumida.', 403);
      // P2 binding: the URL id must name the attestation's own operation.
      // Checked BEFORE any consumption or resolve() side effect, so a
      // cross-URL attestation is refused with zero effect on either row
      // (no consumption, no expiry transition, executor never runs) and no
      // existence oracle for the named URL id.
      if (expectedId !== undefined && found.id !== expectedId) {
        throw new PendingOperationV2Error('approval.attestation_replayed', 'Attestation inválida ou já consumida.', 403);
      }
      if (found.consumed) {
        // Consumed attestation on an in-flight execution (valid OR expired
        // lease) → in-progress, never a duplicate run. Recovery of an
        // expired lease belongs to reconcileExpiredExecuting. Plain object
        // lookup (no resolve()) so this error path has no expiry side
        // effects on proposed/confirmed rows.
        const inFlight = records.get(found.id);
        if (inFlight && identityMatches(inFlight, identity) && inFlight.status === 'executing') {
          fail('approval.execution_in_progress', 'Execução já em andamento.');
        }
        fail('approval.attestation_replayed', 'Attestation inválida ou já consumida.', 403);
      }
      // TX1 — claim commits before the executor runs: consumption is never
      // rolled back, so any non-eligible state below is a replay (parity
      // with the Postgres claim, which burns nothing on mismatch but also
      // never resurrects a consumed attestation).
      const claim = found;
      claim.consumed = true;
      const record = resolve(claim.id, identity);
      if (record.status !== 'confirmed' || record.attestation !== token) fail('approval.attestation_replayed', 'Attestation inválida ou já consumida.', 403);
      record.status = 'executing';
      record.executionClaimedAt = nowIso();
      record.executionLeaseExpiresAt = new Date(Date.now() + resolvePendingV2LeaseMs(options?.leaseMs)).toISOString();
      record.executionAttemptCount = (record.executionAttemptCount ?? 0) + 1;
      // T6.1 stale-finalization guard (in-memory mirror of the Postgres
      // status+attempt check): TX2 only persists while the record is STILL
      // `executing` with this claim attempt.
      const claimAttempt = record.executionAttemptCount ?? 0;
      const stillOurs = (): boolean =>
        record.status === 'executing' && (record.executionAttemptCount ?? 0) === claimAttempt;
      events.push({ operationId: record.id, event: 'execute', actorId: record.actorId, at: nowIso() });
      let result: unknown;
      try {
        result = await executor(record);
      } catch (error) {
        // TX2 (failure): terminal persist lands before the error propagates.
        // Guarded: a recovery that finalized first wins; the late error still
        // propagates but persists nothing.
        if (stillOurs()) {
          record.status = 'failed';
          record.failureCode = sanitizePendingV2FailureCode(error);
          events.push({ operationId: record.id, event: 'fail', actorId: record.actorId, at: nowIso() });
        }
        throw error;
      }
      if (!result || typeof result !== 'object' || (result as { status?: unknown }).status !== 'succeeded' || typeof (result as { operationId?: unknown }).operationId !== 'string') {
        // Stale incomplete result after recovery finalized: authoritative
        // record wins, no overwrite.
        if (!stillOurs()) return record;
        record.status = 'failed';
        record.failureCode = 'approval.incomplete_result';
        events.push({ operationId: record.id, event: 'fail', actorId: record.actorId, at: nowIso() });
        fail('approval.incomplete_result', 'Executor retornou resultado incompleto.');
      }
      // TX2 (success). Guarded: recovery-finalized records are returned as-is.
      if (!stillOurs()) return expose(record);
      const { enriched, mutationId } = withTedReceipt(
        result as { status: string; operationId: string; receipt?: unknown },
        record.tool,
      );
      record.execution = enriched;
      record.mutationId = mutationId;
      record.status = 'succeeded';
      return expose(record);
    },
    async reconcileExpiredExecuting(id, identity, executor, opts) {
      // Renew section is synchronous (no await): atomic under the JS event
      // loop, so concurrent reconciles serialize like the Postgres row lock
      // — the loser observes the renewed lease or terminal state and aborts
      // WITHOUT running the executor a second time.
      const record = records.get(id);
      if (!record) return fail('approval.not_found', 'Operação pendente não encontrada.', 404);
      if (!identityMatches(record, identity)) return fail('approval.binding_mismatch', 'A operação não pertence ao contexto autenticado.', 403);
      // `confirmed` recovery is attestation re-emission (§9, T2.2) — the
      // lease path must never touch it. Asserted explicitly.
      if (record.status === 'confirmed') return fail('approval.reconcile_not_allowed', 'Operação confirmed recupera-se por reemissão de attestation, nunca por lease.');
      if (record.status !== 'executing') return fail('approval.reconcile_not_allowed', 'Reconciliação disponível somente para executing com lease expirada.');
      const leaseExpiresAt = record.executionLeaseExpiresAt ? Date.parse(record.executionLeaseExpiresAt) : NaN;
      if (!Number.isNaN(leaseExpiresAt) && leaseExpiresAt > Date.now()) return fail('approval.execution_in_progress', 'Execução já em andamento.');
      record.executionLeaseExpiresAt = new Date(Date.now() + resolvePendingV2LeaseMs(opts?.leaseMs ?? options?.leaseMs)).toISOString();
      record.executionAttemptCount = (record.executionAttemptCount ?? 0) + 1;
      // V4 T3.1 / T0.4.6: the operation ENTERS reconcile here (lease renewed,
      // executor about to re-run). Telemetry only.
      emitReconcileEnqueued(options?.observabilitySink, {
        eventType: 'mutation.reconcile.enqueued',
        workspaceId: identity.workspaceId,
        operationId: id,
        reason: RECONCILE_REASON_LEASE_EXPIRED,
      });
      // T6.1 stale-finalization guard mirrors execute().
      const renewAttempt = record.executionAttemptCount ?? 0;
      const stillRenewed = (): boolean =>
        record.status === 'executing' && (record.executionAttemptCount ?? 0) === renewAttempt;
      events.push({ operationId: id, event: 'execute', actorId: record.actorId, at: nowIso() });
      // The SAME executor runs with the SAME persisted idempotencyKey.
      let result: unknown;
      try {
        result = await executor(record);
      } catch (error) {
        if (stillRenewed()) {
          record.status = 'failed';
          record.failureCode = sanitizePendingV2FailureCode(error);
          events.push({ operationId: id, event: 'fail', actorId: record.actorId, at: nowIso() });
        }
        throw error;
      }
      if (!result || typeof result !== 'object' || (result as { status?: unknown }).status !== 'succeeded' || typeof (result as { operationId?: unknown }).operationId !== 'string') {
        if (!stillRenewed()) return expose(record);
        record.status = 'failed';
        record.failureCode = 'approval.incomplete_result';
        events.push({ operationId: id, event: 'fail', actorId: record.actorId, at: nowIso() });
        return fail('approval.incomplete_result', 'Executor retornou resultado incompleto.');
      }
      if (!stillRenewed()) return expose(record);
      const { enriched, mutationId } = withTedReceipt(
        result as { status: string; operationId: string; receipt?: unknown },
        record.tool,
      );
      record.execution = enriched;
      record.mutationId = mutationId;
      record.status = 'succeeded';
      return expose(record);
    },
    async retry(id, identity) {
      const record = resolve(id, identity);
      if (record.status !== 'failed') fail('approval.retry_not_allowed', 'Retry disponível somente após falha.');
      record.status = 'confirmed';
      record.attestationIssuedAt = nowIso();
      issue(record);
      events.push({ operationId: id, event: 'confirm', actorId: record.actorId, at: nowIso() });
      return record;
    },
    async cancel(id, identity) {
      const record = resolve(id, identity);
      if (!['proposed', 'confirmed'].includes(record.status)) fail('approval.not_pending', 'A operação não está pendente.');
      record.status = 'cancelled';
      events.push({ operationId: id, event: 'cancel', actorId: record.actorId, at: nowIso() });
      return record;
    },
    async expire(id, identity) {
      const record = resolve(id, identity);
      if (!['proposed', 'confirmed'].includes(record.status)) throw new PendingOperationV2Error('approval.not_pending', 'A operação não está pendente.');
      record.status = 'expired';
      events.push({ operationId: id, event: 'expire', actorId: record.actorId, at: nowIso() });
      return record;
    },
    /**
     * T1.5 (SPEC §8.3) — appended after the terminal transitions so the
     * execute/claim/lease surface above stays untouched (T2.4 owns it).
     * In-memory mirror of the Postgres scan: same identity scope, same
     * non-terminal status set, same newest-first order. Plaintext
     * attestations never leave via listing (same omission as get).
     */
    async listActive(identity) {
      return [...records.values()]
        .filter((record) => identityMatches(record, identity))
        .filter((record) => ['proposed', 'confirmed', 'executing', 'failed'].includes(record.status))
        .map(({ attestation: _omitted, ...exposed }) => exposed)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
  };
};

export { computePendingOperationV2Hash };
