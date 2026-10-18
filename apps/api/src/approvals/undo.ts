import type { PoolClient } from 'pg';
import type { AuditLog, AuditLogStore } from '../audit/store.js';
import type { WriteStore } from '../writes/store.js';
import type { PostgresReversalTxExtensions } from '../writes/postgres.js';
import { domainErrors, DomainError } from '../writes/errors.js';
import { createInMemoryIdempotencyStore, type IdempotencyStore } from '../writes/idempotency.js';
import type { MutationReceipt } from '@pi-finance/llm-contracts';
import { resolveUndoReceipt } from '../reconciliation/effects-registry.js';
import { buildObservabilityEvent } from '../audit/events.js';

export type UndoResult = {
  undone: {
    operation: string;
    entityId: string;
    reversal: string;
  };
  /** Server-generated receipt (SPEC §15.1, T3.2): registry-derived targets, no operationId. */
  receipt: MutationReceipt;
};

export type UndoService = {
  undo(householdId: string, actorId: string, idempotencyKey: string, lastOperationId?: string): Promise<UndoResult>;
};

/**
 * V4 T3.1 / T0.4.5 (SPEC §24.5): telemetry emitted when an undo call is a
 * replay of an already-recorded idempotent result. Dimension: workspace_id.
 * Built through the fail-closed buildObservabilityEvent contract — never
 * carries credentials or financial payloads.
 */
export type UndoReplayTelemetryEvent = {
  eventType: 'audit-undo.replay';
  workspaceId: string;
};

export type UndoObservabilitySink = (event: UndoReplayTelemetryEvent) => void;

/** Best-effort structured-log fallback (T2.2 pattern): never throws. */
const logUndoReplay = (workspaceId: string): void => {
  try {
    console.info(JSON.stringify({ event: 'audit-undo.replay', workspaceId }));
  } catch {
    // Telemetry never breaks the undo.
  }
};

const REVERSIBLE_OPERATIONS = new Set([
  'transactions.expense.create',
  'transactions.income.create',
  'transactions.transfer.create',
  'accounts.create',
  'categories.create',
]);

/**
 * Namespace isolating undo records inside the shared `IdempotencyStore`
 * (same pattern as `pending-v2:` in pending-idempotency.ts): undo keys never
 * collide with HTTP-layer write keys sharing the same store/table.
 */
export const UNDO_IDEMPOTENCY_PREFIX = 'audit-undo:';

export const createUndoService = (deps: {
  auditLogs: AuditLogStore;
  writes: WriteStore;
  /** Persistent store shared with the writes (in-memory ↔ in-memory, Postgres ↔ Postgres). */
  idempotency?: IdempotencyStore;
  /**
   * V4 T3.1 / T0.4.5 (SPEC §24.5): sink for `audit-undo.replay` — emitted
   * when the undo is a replay (the idempotency store already distinguishes
   * it). Follows the T2.2 precedent (routes/index.ts legacyBearerAuditLog):
   * injected in tests, defaulting to best-effort structured JSON logging.
   * Telemetry only — never throws, never alters the financial path.
   */
  observabilitySink?: UndoObservabilitySink;
}): UndoService => {
  const idempotency = deps.idempotency ?? createInMemoryIdempotencyStore();
  /**
   * FIX-188: same-process cross-key guard. The idempotency store serializes
   * same-key callers, but DISTINCT keys electing the SAME target run
   * independent producers. This set is claimed synchronously (no await
   * between election and claim inside the producer continuation) so exactly
   * one same-process producer owns a target; the loser fails closed with
   * `undo.nothing_to_undo`. Cross-process races are owned by the durable
   * row guard (conditional tombstone/deactivate inside the claim tx rolls
   * the loser back); a restart loses this set and the loser then maps the
   * consumed row to `undo.nothing_to_undo` below. Completed targets are NOT
   * remembered here — the tombstoned/inactive row is the durable record.
   */
  const inFlightTargets = new Set<string>();

  const resolveEntityId = (log: AuditLog): string | undefined => {
    const metaId = log.metadata.entityId;
    if (metaId !== undefined && metaId !== null) return String(metaId);
    if (log.effectRef) return String(log.effectRef);
    const after = (log.metadata.after as Record<string, unknown> | undefined)?.id;
    if (after) return String(after);
    return undefined;
  };

  const applyReversal = async (householdId: string, log: AuditLog, claimTx?: unknown): Promise<string> => {
    const entityId = resolveEntityId(log);
    if (!entityId) throw domainErrors.undoNothingToUndo();
    // FIX-UNDO (F3, SPEC §12 F3 opção 1): when the idempotency store runs
    // this producer inside the claim transaction (Postgres), run the
    // reversal on the SAME client so claim + effect + completion commit
    // atomically — a crash anywhere rolls everything back and the replay
    // re-executes claim + producer from zero and converges (F4). Any other
    // combination (in-memory idempotency, foreign write store) runs the
    // plain transactional methods with the previous semantics.
    // V4.1 Phase 4 (fail-closed): with an open claim tx the reversal MUST
    // run on that client. A missing `*InTx` extension is an invariant error
    // — never a plain fallback (the effect would commit outside the claim
    // tx and silently lose atomicity).
    const extensions = deps.writes as Partial<PostgresReversalTxExtensions>;
    const inTx =
      typeof claimTx === 'object' &&
      claimTx !== null &&
      typeof (claimTx as { query?: unknown }).query === 'function'
        ? (claimTx as PoolClient)
        : undefined;
    switch (log.operation) {
      case 'transactions.expense.create':
      case 'transactions.income.create':
      case 'transactions.transfer.create':
        if (inTx) {
          if (typeof extensions.softDeleteTransactionInTx !== 'function') {
            throw domainErrors.atomicMutationNotSupported();
          }
          await extensions.softDeleteTransactionInTx(inTx, householdId, entityId);
        } else {
          await deps.writes.softDeleteTransaction(householdId, entityId);
        }
        return 'soft_delete';
      case 'accounts.create':
        if (inTx) {
          if (typeof extensions.deactivateAccountInTx !== 'function') {
            throw domainErrors.atomicMutationNotSupported();
          }
          await extensions.deactivateAccountInTx(inTx, householdId, entityId);
        } else {
          await deps.writes.deactivateAccount(householdId, entityId);
        }
        return 'deactivate';
      case 'categories.create':
        if (inTx) {
          if (typeof extensions.deactivateCategoryInTx !== 'function') {
            throw domainErrors.atomicMutationNotSupported();
          }
          await extensions.deactivateCategoryInTx(inTx, householdId, entityId);
        } else {
          await deps.writes.deactivateCategory(householdId, entityId);
        }
        return 'deactivate';
      default:
        throw domainErrors.undoNothingToUndo();
    }
  };

  return {
    async undo(householdId, actorId, idempotencyKey, lastOperationId) {
      // FIX-P1-UNDO-IDEMPOTENCY: atomic claim BEFORE applyReversal through
      // the shared IdempotencyStore. Concurrent callers with the same key
      // attach to the winner's in-flight execution (in-memory) or lose the
      // claim race (Postgres) and replay the canonical recorded result —
      // the reversal runs EXACTLY once. Same key + divergent
      // lastOperationId → payload mismatch → idempotency.conflict.
      const namespacedKey = `${UNDO_IDEMPOTENCY_PREFIX}${idempotencyKey}`;
      const payload = { lastOperationId: lastOperationId ?? null };
      const { response, replayed } = await idempotency.lookupOrRecord(householdId, namespacedKey, payload, async (claimTx?: unknown) => {
        const { items } = await deps.auditLogs.listAuditLogs(householdId, { limit: 50 });
        const candidates = items
          .filter(
            (log) =>
              REVERSIBLE_OPERATIONS.has(log.operation) &&
              resolveEntityId(log) !== undefined,
          )
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

        let target: AuditLog | undefined;
        if (lastOperationId) {
          target = candidates.find((log) => log.id === lastOperationId);
          if (!target) throw domainErrors.undoNothingToUndo();
        } else {
          // T09 own-actor-only (ADR-028): without an explicit
          // lastOperationId the ONLY eligible targets are the caller's own
          // reversible rows, newest first. A caller with no own operations
          // fails with `undo.nothing_to_undo` — the election NEVER falls
          // back to the household head, so it cannot silently reverse a
          // predecessor owned by another actor. A consumed own head surfaces
          // below as `undo.nothing_to_undo` (row guard), never a walk-back.
          const own = candidates.filter((log) => log.actorId === actorId);
          if (own.length === 0) throw domainErrors.undoNothingToUndo();
          target = own[0]!;
        }
        const entityId = resolveEntityId(target)!;
        // FIX-188: claim the target synchronously (no await between this
        // check-add and the election above within this continuation), so
        // concurrent same-process producers with distinct keys converge to
        // exactly one owner. Released in `finally` — a failure before the
        // reversal leaves the row untouched and a retry may proceed.
        const targetClaim = `${householdId}:${entityId}`;
        if (inFlightTargets.has(targetClaim)) throw domainErrors.undoNothingToUndo();
        inFlightTargets.add(targetClaim);
        try {
          let reversal: string;
          try {
            reversal = await applyReversal(householdId, target, claimTx);
          } catch (err) {
            // FIX-188: a consumed target surfaces as `not_found` from the
            // row guard (already tombstoned/inactive — restart, replay with
            // a new key, or a lost cross-key race). That is
            // `undo.nothing_to_undo`, never a bare `not_found`. Genuine
            // conflicts (in_use, paid-payable link, atomicity invariant)
            // pass through untouched.
            if (err instanceof DomainError && err.code === 'not_found') {
              throw domainErrors.undoNothingToUndo();
            }
            throw err;
          }
          // Receipt is built inside the claim (before the idempotency record
          // write) so replays return the identical receipt.
          const receipt = resolveUndoReceipt(target.operation, entityId);
          const result: UndoResult = {
            undone: { operation: target.operation, entityId, reversal },
            receipt,
          };
          return result;
        } finally {
          inFlightTargets.delete(targetClaim);
        }
      });
      if (replayed) {
        try {
          buildObservabilityEvent('audit-undo.replay', { workspaceId: householdId });
          const sink = deps.observabilitySink;
          if (sink) sink({ eventType: 'audit-undo.replay', workspaceId: householdId });
          else logUndoReplay(householdId);
        } catch {
          // Telemetry never breaks the undo.
        }
      }
      return response;
    },
  };
};
