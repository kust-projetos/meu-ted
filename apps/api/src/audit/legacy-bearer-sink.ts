import { createHash, randomUUID } from "node:crypto";
import type { LegacyBearerUsedAuditEvent } from "../routes/index.js";

/**
 * Release B (SPEC V4.1 §20, gate D11): durable sink for the
 * `auth.request.legacy_bearer_used` telemetry event. The routes layer only
 * emits to the structured logger when no sink is injected (routes/index.ts),
 * which left the 14-day zero-use window unverifiable (container logs are
 * destroyed on every release recreation). This factory closes that gap: the
 * event lands in `audit_logs`, which is exactly what
 * `release-b-reminder.yml` and the window verification count.
 *
 * Dual shape, mirroring the two proven audit INSERT paths:
 * - DB_SCHEMA=canonical → canonical columns (workspace_id/event_type/
 *   payload_hash/metadata; operation_record_id nullable; gen_random_uuid),
 *   same shape as writes/pending-idempotency.ts canonical branch.
 * - otherwise → legacy columns (household_id/action/user_id/after_json),
 *   same shape as the legacy audit branch.
 *
 * Telemetry contract (routes/index.ts:311-317): never breaks authentication —
 * storage failures are swallowed; emission is fire-and-forget. `user_id` /
 * `actor_id` records 'device' on purpose: the bearer request never resolved a
 * user session, and that is precisely the fact being recorded.
 */
export const createLegacyBearerAuditSink = (
  pool: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  now: () => Date = () => new Date(),
): ((event: LegacyBearerUsedAuditEvent) => void) => {
  const canonical = process.env.DB_SCHEMA === "canonical";
  return (event: LegacyBearerUsedAuditEvent): void => {
    void (async () => {
      if (canonical) {
        const payloadJson = JSON.stringify({ workspaceId: event.payload.workspaceId });
        const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
        await pool.query(
          `INSERT INTO audit_logs
             (id, workspace_id, actor_id, operation, event_type, payload_hash, effect_ref, metadata)
           VALUES (gen_random_uuid(), $1, 'device', $2, $2, $3, NULL, $4)`,
          [event.payload.workspaceId, event.eventType, payloadHash, payloadJson],
        );
        return;
      }
      await pool.query(
        `INSERT INTO audit_logs
           (id, household_id, user_id, action, entity_type, entity_id, before_json, after_json, created_at)
         VALUES ($1, $2, NULL, $3, 'auth', NULL, NULL, $4, $5)`,
        [
          randomUUID(),
          event.payload.workspaceId,
          event.eventType,
          payloadJsonOf(event),
          now().toISOString(),
        ],
      );
    })().catch(() => {
      // Telemetry never breaks authentication (routes/index.ts contract).
    });
  };
};

function payloadJsonOf(event: LegacyBearerUsedAuditEvent): string {
  return JSON.stringify({ workspaceId: event.payload.workspaceId });
}
