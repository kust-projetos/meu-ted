-- V060: authoritative confirmation-intention bindings (PR137-HARDEN round 4, P1-B).
--
-- Independent durable frontier for the financial confirmation path: the Agent
-- binds intentionId BEFORE resolving the listing, and confirm() binds
-- intentionId→operationId atomically inside its own transaction. A redelivery
-- that lost every agent-side marker (total agent-storage outage) can never
-- resolve-and-confirm a later operation B under the old intention: the bind
-- proves X was seen before (post-outage redelivery fails closed), and a
-- confirm carrying an intention bound to another operation is refused with
-- `approval.intention_conflict` (409) with zero effect.
--
-- Dual-schema safe (pure new table, no FK, no canonical-only columns), so it
-- stays applicable in legacy mode like V051/V052 (pending-operation V2
-- execution bindings/recovery).
CREATE TABLE IF NOT EXISTS pending_operation_confirmation_intentions (
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  intention_id TEXT NOT NULL,
  operation_id TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bound_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, actor_id, device_id, intention_id)
);
