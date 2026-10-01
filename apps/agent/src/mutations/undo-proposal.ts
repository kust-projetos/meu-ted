/**
 * Conversational undo as a separate service (ADR-021 follow-up
 * `debt-undo-confirmation-protocol`).
 *
 * The model NEVER executes undo. Free text only requests a persistent
 * proposal whose target operation is fixed at proposal time by an
 * authoritative preview. Confirmation/cancel happens exclusively through the
 * authenticated PWA RPC (`POST /rpc/undo/decision`) bound to this DO record.
 *
 * Separate from PendingOperation V2: no proposalHash, no attestation, no
 * V2 registry entry, no generic capability.
 */

export const UNDO_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Narrow delegated capability for the undo confirm call (not generic). */
export const UNDO_DELEGATED_CAPABILITY = 'financial.undo.execute';

/** Narrow delegated capability for read-only verification (audit reads). */
export const UNDO_VERIFY_READ_CAPABILITY = 'financial.read';

/** Strict UUID shape shared with the entity resolver (no invented ids). */
export const UNDO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * closure-undo-verify: operations whose created entity is a transaction and
 * can therefore be compared against an expected `{ type: 'transaction' }`.
 */
export const UNDO_VERIFY_ALLOWED_OPERATIONS: ReadonlySet<string> = new Set([
  'transactions.expense.create',
  'transactions.income.create',
  'transactions.transfer.create',
]);

const UNDO_INTENT_RE = /(desfaz|desfazer|desfaç|\bundo\b)/i;
/** Natural-language negation: any "não"/"nao" fails the request closed. */
const UNDO_NEGATION_RE = /\bn[aã]o\b/i;

export const isUndoProposalRequest = (text: string): boolean =>
  UNDO_INTENT_RE.test(text ?? '') && !UNDO_NEGATION_RE.test(text ?? '');

export const isUndoNegation = (text: string): boolean =>
  UNDO_INTENT_RE.test(text ?? '') && UNDO_NEGATION_RE.test(text ?? '');

export const deriveUndoIdempotencyKey = (workspaceId: string, requestId: string): string =>
  `undo:${workspaceId}:${requestId}`;

export type UndoProposalStatus = 'proposed' | 'executing' | 'confirmed' | 'cancelled' | 'expired';

/**
 * debt-undo-proposal-rehydration: browser-safe rehydration summary. Identity
 * (workspace/actor/device) is the query binding and never part of the
 * payload; the fixed target, the idempotency key and raw operation data
 * never leave the DO.
 */
export type UndoProposalSummary = Readonly<{
  requestId: string;
  status: 'proposed' | 'executing';
  expiresAt: string;
}>;

export type UndoProposalRecord = Readonly<{
  requestId: string;
  workspaceId: string;
  actorId: string;
  deviceId: string;
  targetLastOperationId: string;
  idempotencyKey: string;
  status: UndoProposalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  resultJson?: string;
}>;

export type UndoSql = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

export const initializeUndoProposalSchema = (sql: UndoSql): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS undo_proposals (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      target_last_operation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      result_json TEXT
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_undo_proposals_context
    ON undo_proposals (workspace_id, actor_id, status);
  `);
};

const rowToRecord = (row: Record<string, unknown>): UndoProposalRecord =>
  Object.freeze({
    requestId: String(row.request_id ?? ''),
    workspaceId: String(row.workspace_id ?? ''),
    actorId: String(row.actor_id ?? ''),
    deviceId: String(row.device_id ?? ''),
    targetLastOperationId: String(row.target_last_operation_id ?? ''),
    idempotencyKey: String(row.idempotency_key ?? ''),
    status: String(row.status ?? 'proposed') as UndoProposalStatus,
    createdAt: String(row.created_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    ...(row.decided_at != null ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.result_json != null ? { resultJson: String(row.result_json) } : {}),
  });

export class SqlUndoProposalStore {
  constructor(private readonly sql: UndoSql) {}

  get(requestId: string): UndoProposalRecord | undefined {
    const rows = [...this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM undo_proposals WHERE request_id = ?`,
      requestId,
    )];
    return rows.length > 0 && rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  insert(record: UndoProposalRecord): void {
    this.sql.exec(
      `INSERT INTO undo_proposals (request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
      record.requestId,
      record.workspaceId,
      record.actorId,
      record.deviceId,
      record.targetLastOperationId,
      record.idempotencyKey,
      record.status,
      record.createdAt,
      record.expiresAt,
      record.decidedAt ?? null,
      record.resultJson ?? null,
    );
  }

  /**
   * Atomic CAS out of `proposed`. Single UPDATE with the status predicate,
   * so concurrent deciders elect exactly one winner at the storage engine.
   * Cancel uses this (it wins ONLY while proposed — never against
   * `executing`); confirm claims via `claimExecuting` below.
   */
  casProposedTo(
    requestId: string,
    to: 'cancelled' | 'expired',
    patch: { decidedAt: string; resultJson?: string } = { decidedAt: new Date().toISOString() },
  ): UndoProposalRecord | undefined {
    this.sql.exec(
      `UPDATE undo_proposals SET status = ?, decided_at = ?, result_json = COALESCE(?, result_json) WHERE request_id = ? AND status = 'proposed'`,
      to,
      patch.decidedAt,
      patch.resultJson ?? null,
      requestId,
    );
    const current = this.get(requestId);
    return current && current.status === to ? current : undefined;
  }

  /**
   * debt-undo-confirmation-race-fix: persistent confirm claim. Moves
   * `proposed → executing` atomically BEFORE any external API effect, so a
   * racing cancel can never pair an effect with a persisted `cancelled`
   * state. `decided_at` stays NULL until the terminal transition — the
   * claim is ownership of the in-flight effect, not a decision.
   */
  claimExecuting(requestId: string): UndoProposalRecord | undefined {
    this.sql.exec(
      `UPDATE undo_proposals SET status = 'executing' WHERE request_id = ? AND status = 'proposed'`,
      requestId,
    );
    const current = this.get(requestId);
    return current && current.status === 'executing' ? current : undefined;
  }

  /**
   * Terminal transition of a claimed confirm. Guarded on `executing`, so
   * only the claim holder (or a same-binding retry converging on the same
   * idempotent effect) can persist `confirmed`.
   */
  confirmExecuting(requestId: string, decidedAt: string, resultJson: string): UndoProposalRecord | undefined {
    this.sql.exec(
      `UPDATE undo_proposals SET status = ?, decided_at = ?, result_json = ? WHERE request_id = ? AND status = 'executing'`,
      'confirmed',
      decidedAt,
      resultJson,
      requestId,
    );
    const current = this.get(requestId);
    return current && current.status === 'confirmed' ? current : undefined;
  }

  markExpired(requestId: string, decidedAt: string): void {
    this.sql.exec(
      `UPDATE undo_proposals SET status = 'expired', decided_at = ? WHERE request_id = ? AND status = 'proposed'`,
      decidedAt,
      requestId,
    );
  }

  /**
   * debt-undo-proposal-rehydration: all rows for one exact identity binding.
   * The caller (service.listActive) applies the status/expiry filter and the
   * safe projection — this stays a raw bound read, never a cross-identity
   * scan.
   */
  listBound(identity: UndoIdentity): UndoProposalRecord[] {
    const rows = [...this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM undo_proposals WHERE workspace_id = ? AND actor_id = ? AND device_id = ?`,
      identity.workspaceId,
      identity.actorId,
      identity.deviceId,
    )];
    return rows.map(rowToRecord);
  }
}

export type UndoIdentity = Readonly<{
  workspaceId: string;
  actorId: string;
  deviceId: string;
}>;

export type UndoPreview = (identity: UndoIdentity) => Promise<{ id: string } | null>;

/**
 * closure-undo-verify: read-only audit surface for target verification.
 * Returns the workspace's recent audit entries (newest first is fine — the
 * verifier locates the FIXED proposal target by exact id, never the head).
 * Never previews, never decides, never mutates.
 */
export type UndoAuditItem = Readonly<{
  id: string;
  workspaceId?: string;
  operation?: string;
  effectRef?: string;
  metadata?: Record<string, unknown>;
}>;

export type UndoAuditReader = (identity: UndoIdentity) => Promise<readonly UndoAuditItem[]>;

export type UndoExpectedEntity = Readonly<{
  type: 'transaction';
  id: string;
}>;

export type UndoApi = {
  undo(input: { lastOperationId: string; idempotencyKey: string; identity: UndoIdentity }): Promise<unknown>;
};

const fail = (code: string, message?: string): never => {
  throw Object.assign(new Error(message ?? code), { code });
};

export class UndoProposalService {
  constructor(
    private readonly deps: {
      store: SqlUndoProposalStore;
      preview: UndoPreview;
      api: UndoApi;
      /**
       * closure-undo-verify: read-only audit reader used ONLY by `verify`.
       * Optional so existing construction sites keep compiling; `verify`
       * fails closed when it is absent (never falls back to `preview`).
       */
      audit?: UndoAuditReader;
      now?: () => number;
      ttlMs?: number;
    },
  ) {}

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return this.deps.ttlMs ?? UNDO_PROPOSAL_TTL_MS;
  }

  /**
   * Free-text request path: persists exactly one proposal per requestId.
   * Same requestId + same binding reuses the stored row (redelivery safe);
   * same requestId + different binding fails closed. Target operation is
   * fixed by the authoritative preview — never from client input.
   */
  async propose(input: { requestId: string; identity: UndoIdentity }): Promise<
    | { kind: 'proposed'; record: UndoProposalRecord; created: boolean }
    | { kind: 'unavailable' }
  > {
    const { requestId, identity } = input;
    if (!requestId || !identity.workspaceId || !identity.actorId || !identity.deviceId) {
      return fail('undo.context_required', 'undo.context_required');
    }
    const existing = this.deps.store.get(requestId);
    if (existing) {
      if (
        existing.workspaceId !== identity.workspaceId ||
        existing.actorId !== identity.actorId ||
        existing.deviceId !== identity.deviceId
      ) {
        return fail('undo.binding_mismatch', 'Undo proposal belongs to another actor/device/workspace.');
      }
      return { kind: 'proposed', record: existing, created: false };
    }
    const target = await this.deps.preview(identity);
    if (!target) return { kind: 'unavailable' };
    const now = this.nowMs();
    const record: UndoProposalRecord = Object.freeze({
      requestId,
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
      targetLastOperationId: target.id,
      idempotencyKey: deriveUndoIdempotencyKey(identity.workspaceId, requestId),
      status: 'proposed' as const,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs()).toISOString(),
    });
    this.deps.store.insert(record);
    // A concurrent proposer may have won the insert race: reuse the winner
    // when bindings match, fail closed otherwise (same rule as redelivery).
    const stored = this.deps.store.get(requestId) ?? record;
    if (
      stored.workspaceId !== identity.workspaceId ||
      stored.actorId !== identity.actorId ||
      stored.deviceId !== identity.deviceId
    ) {
      return fail('undo.binding_mismatch', 'Undo proposal belongs to another actor/device/workspace.');
    }
    return { kind: 'proposed', record: stored, created: stored.createdAt === record.createdAt };
  }

  /**
   * debt-undo-proposal-rehydration: read-only rehydration listing for chat
   * startup/workspace change. Returns ONLY the bound identity's live
   * summaries (`proposed` + truthful `executing`) as safe projections —
   * never targets, keys or raw operation data. Expired `proposed` rows are
   * omitted AND lazily marked `expired` (same rule as the decision path);
   * expired `executing` rows are omitted but left untouched (the in-flight
   * confirm claim owns that row until its terminal transition). Terminal
   * rows are omitted. Never calls preview/api: rehydration never decides.
   */
  listActive(identity: UndoIdentity): UndoProposalSummary[] {
    if (!identity.workspaceId || !identity.actorId || !identity.deviceId) {
      return fail('undo.context_required', 'undo.context_required');
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    const items: UndoProposalSummary[] = [];
    for (const record of this.deps.store.listBound(identity)) {
      if (record.status !== 'proposed' && record.status !== 'executing') continue;
      if (record.expiresAt <= nowIso) {
        if (record.status === 'proposed') this.deps.store.markExpired(record.requestId, nowIso);
        continue;
      }
      items.push(Object.freeze({
        requestId: record.requestId,
        status: record.status,
        expiresAt: record.expiresAt,
      }));
    }
    return items;
  }

  /**
   * RPC decision path: strict binding + expiry + persistent claim.
   *
   * debt-undo-confirmation-race-fix: confirm atomically claims the proposal
   * (`proposed → executing`) BEFORE calling the existing undo API, and only
   * then runs the effect with the FIXED target and the STABLE
   * proposal-derived idempotency key. Cancel wins ONLY while `proposed` — a
   * cancel racing an in-flight confirm fails closed with `undo.executing`
   * (truthful pending, never a `cancelled` state paired with an effect).
   * A retry after transport failure finds `executing` and re-attempts the
   * SAME key/target (the API idempotency record converges concurrent and
   * retried calls to a single effect); a replay after `confirmed` returns
   * the stored result without a second effect.
   */
  async decide(input: { requestId: string; decision: 'confirm' | 'cancel'; identity: UndoIdentity }): Promise<
    | { kind: 'confirmed'; record: UndoProposalRecord; result: unknown }
    | { kind: 'cancelled'; record: UndoProposalRecord }
  > {
    const { requestId, decision, identity } = input;
    const stored = this.deps.store.get(requestId);
    if (!stored) return fail('undo.not_found', 'Undo proposal not found.');
    if (
      stored.workspaceId !== identity.workspaceId ||
      stored.actorId !== identity.actorId ||
      stored.deviceId !== identity.deviceId
    ) {
      return fail('undo.binding_mismatch', 'Undo proposal belongs to another actor/device/workspace.');
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    if (stored.status === 'expired' || (stored.status === 'proposed' && stored.expiresAt <= nowIso)) {
      if (stored.status === 'proposed') this.deps.store.markExpired(requestId, nowIso);
      return fail('undo.expired', 'Undo proposal expired.');
    }
    if (stored.status === 'confirmed') {
      if (decision !== 'confirm') return fail('undo.terminal', 'Undo proposal already decided.');
      // Recovery-safe retry: the first confirm persisted its result.
      const result = stored.resultJson ? (JSON.parse(stored.resultJson) as unknown) : { ok: true };
      const current = this.deps.store.get(requestId) ?? stored;
      return { kind: 'confirmed', record: current, result };
    }
    if (stored.status === 'cancelled') {
      if (decision !== 'cancel') return fail('undo.terminal', 'Undo proposal already decided.');
      return { kind: 'cancelled', record: stored };
    }
    // --- Cancel wins ONLY while proposed. Against `executing` it fails
    // closed with the truthful pending state (the effect is already owned
    // by the confirm claim and can no longer be un-claimed).
    if (decision === 'cancel') {
      if (stored.status === 'executing') {
        return fail('undo.executing', 'Undo already in progress.');
      }
      if (stored.status !== 'proposed') return fail('undo.terminal', 'Undo proposal already decided.');
      const next = this.deps.store.casProposedTo(requestId, 'cancelled', { decidedAt: nowIso });
      if (!next) {
        const current = this.deps.store.get(requestId);
        if (current?.status === 'cancelled') return { kind: 'cancelled', record: current };
        if (current?.status === 'executing') return fail('undo.executing', 'Undo already in progress.');
        return fail('undo.terminal', 'Undo proposal already decided.');
      }
      return { kind: 'cancelled', record: next };
    }
    // --- Confirm: claim persistently BEFORE the external effect. Exactly
    // one of (claim wins → effect owned) or (lost → converge on the winner)
    // is possible; an effect is never paired with a `cancelled` row.
    if (stored.status !== 'proposed' && stored.status !== 'executing') {
      return fail('undo.terminal', 'Undo proposal already decided.');
    }
    let holder = stored;
    if (stored.status === 'proposed') {
      const claimed = this.deps.store.claimExecuting(requestId);
      if (!claimed) {
        const current = this.deps.store.get(requestId);
        if (current?.status === 'executing') {
          // A concurrent confirm owns the in-flight effect: converge on it.
          // The API call below reuses the same fixed target + stable key,
          // so the API idempotency record folds it into the single effect.
          holder = current;
        } else if (current?.status === 'confirmed') {
          // Fully decided while we raced: replay the winner, no new effect.
          const winner = current.resultJson ? (JSON.parse(current.resultJson) as unknown) : { ok: true };
          return { kind: 'confirmed', record: current, result: winner };
        } else if (current?.status === 'cancelled') {
          // Cancel won before any claim: no effect was ever initiated.
          return fail('undo.terminal', 'Undo proposal already decided.');
        } else if (current?.status === 'expired' || (current && current.status === 'proposed' && current.expiresAt <= nowIso)) {
          if (current?.status === 'proposed') this.deps.store.markExpired(requestId, nowIso);
          return fail('undo.expired', 'Undo proposal expired.');
        }
        return fail('undo.terminal', 'Undo proposal already decided.');
      }
      holder = claimed;
    }
    // Identity-bound holder: the claim row carries the same
    // workspace/actor/device verified above (binding columns are immutable —
    // only status/decided_at/result_json ever change).
    if (
      holder.workspaceId !== identity.workspaceId ||
      holder.actorId !== identity.actorId ||
      holder.deviceId !== identity.deviceId
    ) {
      return fail('undo.binding_mismatch', 'Undo proposal belongs to another actor/device/workspace.');
    }
    const result = await this.deps.api.undo({
      lastOperationId: holder.targetLastOperationId,
      idempotencyKey: holder.idempotencyKey,
      identity,
    });
    const resultJson = JSON.stringify(result ?? { ok: true });
    const next = this.deps.store.confirmExecuting(requestId, nowIso, resultJson);
    if (!next) {
      // Lost the terminal race after a successful effect: the winner's
      // stored result is canonical (same key/target, so same effect).
      const current = this.deps.store.get(requestId);
      if (current?.status === 'confirmed') {
        const winner = current.resultJson ? (JSON.parse(current.resultJson) as unknown) : result;
        return { kind: 'confirmed', record: current, result: winner };
      }
      return fail('undo.terminal', 'Undo proposal already decided.');
    }
    return { kind: 'confirmed', record: next, result };
  }

  /**
   * closure-undo-verify: read-only target check for a proposed undo.
   *
   * Compares the client-supplied expected transaction entity against the
   * entity actually created by the proposal's FIXED `targetLastOperationId`
   * (resolved from the workspace audit trail), answering
   * `{ requestId, matches }` without persisting anything:
   *
   * - identity is checked against the stored row BEFORE any audit read;
   * - only `proposed` + unexpired rows verify (expired/terminal/executing
   *   fail closed — and expiry here never writes `markExpired`);
   * - the audit trail is queried for the EXACT fixed target id — never the
   *   preview's newest candidate, so a proposal fixed on an old head cannot
   *   be confirmed against a newer operation;
   * - the entity resolves `metadata.entityId > effectRef > metadata.after.id`
   *   with conflicting sources failing closed as ambiguous, and only
   *   `transactions.*.create` operations are comparable;
   * - after the audit await the stored row is re-read and its fixed
   *   target/status/TTL/bindings must be unchanged, otherwise the check
   *   fails closed as `undo.target_changed` (lost race, retry the verify).
   *
   * Never calls `preview`, `api.undo`, or any store mutation — a spy on
   * those surfaces must observe zero calls across a verify.
   */
  async verify(input: { requestId: string; expectedEntity: UndoExpectedEntity; identity: UndoIdentity }): Promise<
    { kind: 'verified'; requestId: string; matches: boolean }
  > {
    const { requestId, expectedEntity, identity } = input;
    if (!requestId || !identity.workspaceId || !identity.actorId || !identity.deviceId) {
      return fail('undo.context_required', 'undo.context_required');
    }
    if (
      !expectedEntity ||
      (expectedEntity as { type?: unknown }).type !== 'transaction' ||
      typeof (expectedEntity as { id?: unknown }).id !== 'string' ||
      !UNDO_UUID_RE.test((expectedEntity as { id: string }).id)
    ) {
      return fail('undo.invalid_target', 'Expected entity must be { type: \'transaction\', id: UUID }.');
    }
    const expectedId = (expectedEntity as { id: string }).id.toLowerCase();
    const stored = this.deps.store.get(requestId);
    if (!stored) return fail('undo.not_found', 'Undo proposal not found.');
    if (
      stored.workspaceId !== identity.workspaceId ||
      stored.actorId !== identity.actorId ||
      stored.deviceId !== identity.deviceId
    ) {
      return fail('undo.binding_mismatch', 'Undo proposal belongs to another actor/device/workspace.');
    }
    const snapshot = {
      workspaceId: stored.workspaceId,
      actorId: stored.actorId,
      deviceId: stored.deviceId,
      targetLastOperationId: stored.targetLastOperationId,
      status: stored.status,
      expiresAt: stored.expiresAt,
    };
    // Read-only liveness: unlike `decide`, expiry here never persists
    // `markExpired` — the row is left untouched for the decision path.
    if (stored.status === 'executing') {
      return fail('undo.executing', 'Undo already in progress.');
    }
    if (stored.status !== 'proposed') {
      return fail('undo.terminal', 'Undo proposal already decided.');
    }
    if (stored.expiresAt <= new Date(this.nowMs()).toISOString()) {
      return fail('undo.expired', 'Undo proposal expired.');
    }
    const audit = this.deps.audit;
    if (!audit) {
      return fail('agent.audit_unavailable', 'Undo verification is not available.');
    }
    const items = await audit(identity);
    const target = (Array.isArray(items) ? items : []).find((item) => item?.id === snapshot.targetLastOperationId);
    if (!target) return fail('undo.target_missing', 'Undo target is no longer available.');
    if (target.workspaceId !== undefined && target.workspaceId !== identity.workspaceId) {
      return fail('undo.target_missing', 'Undo target is no longer available.');
    }
    if (target.operation !== undefined && !UNDO_VERIFY_ALLOWED_OPERATIONS.has(target.operation)) {
      return fail('undo.unsupported_operation', 'Undo target cannot be verified for this operation.');
    }
    const metadata = target.metadata && typeof target.metadata === 'object' ? (target.metadata as Record<string, unknown>) : {};
    const fromMeta = typeof metadata.entityId === 'string' && metadata.entityId.trim() ? metadata.entityId.trim() : undefined;
    const fromRef = typeof target.effectRef === 'string' && target.effectRef.trim() ? target.effectRef.trim() : undefined;
    const after = metadata.after && typeof metadata.after === 'object' ? (metadata.after as Record<string, unknown>) : undefined;
    const fromAfter = after && typeof after.id === 'string' && after.id.trim() ? after.id.trim() : undefined;
    // API writer gap (separate owner): `effectRef` may be absent on rows the
    // writer never populated — the priority chain above degrades gracefully,
    // but a present conflict is never guessed through.
    if (fromMeta && fromRef && fromMeta !== fromRef) {
      return fail('undo.target_ambiguous', 'Undo target entity is ambiguous.');
    }
    const resolved = fromMeta ?? fromRef ?? fromAfter;
    if (!resolved) return fail('undo.target_missing', 'Undo target entity is not available.');
    if (!UNDO_UUID_RE.test(resolved)) {
      return fail('undo.invalid_entity', 'Undo target entity is invalid.');
    }
    // Race gate: the audit await yielded — the fixed target, status, TTL and
    // bindings must be exactly what the pre-read snapshotted, otherwise a
    // concurrent decide/expire moved the row under this check.
    const current = this.deps.store.get(requestId);
    if (
      !current ||
      current.workspaceId !== snapshot.workspaceId ||
      current.actorId !== snapshot.actorId ||
      current.deviceId !== snapshot.deviceId ||
      current.targetLastOperationId !== snapshot.targetLastOperationId ||
      current.status !== snapshot.status ||
      current.expiresAt !== snapshot.expiresAt
    ) {
      return fail('undo.target_changed', 'Undo proposal changed during verification.');
    }
    if (current.expiresAt <= new Date(this.nowMs()).toISOString()) {
      return fail('undo.expired', 'Undo proposal expired.');
    }
    return { kind: 'verified', requestId, matches: resolved.toLowerCase() === expectedId };
  }
}
