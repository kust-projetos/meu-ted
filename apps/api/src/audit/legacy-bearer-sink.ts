import { randomUUID } from "node:crypto";
import type { LegacyBearerUsedAuditEvent } from "../routes/index.js";

/**
 * Release B (SPEC V4.1 §20, gate D11): durable sink for the
 * `auth.request.legacy_bearer_used` telemetry event. The routes layer only
 * emits to the structured logger when no sink is injected (routes/index.ts),
 * which left the 14-day zero-use window unverifiable (container logs are
 * destroyed on every release recreation). This factory closes that gap: the
 * event lands in `audit_logs` (legacy-compatible shape: household_id/action/
 * after_json), which is exactly what `release-b-reminder.yml` counts.
 *
 * Telemetry contract (routes/index.ts:311-317): never breaks authentication —
 * storage failures are swallowed; emission is fire-and-forget.
 *
 * The pool is the server's own pool, so the row lands in whichever database
 * the API is serving (legacy today, canonical after the cutover) — both use
 * the same audit_logs column shape (household_id/action/user_id/after_json).
 * `user_id` stays NULL on purpose: the bearer request never resolved a
 * session, and that is precisely the fact being recorded.
 */
export const createLegacyBearerAuditSink = (
  pool: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  now: () => Date = () => new Date(),
): ((event: LegacyBearerUsedAuditEvent) => void) => {
  return (event: LegacyBearerUsedAuditEvent): void => {
    void (async () => {
      await pool.query(
        `INSERT INTO audit_logs
           (id, household_id, user_id, action, entity_type, entity_id, before_json, after_json, created_at)
         VALUES ($1, $2, NULL, $3, 'auth', NULL, NULL, $4, $5)`,
        [
          randomUUID(),
          event.payload.workspaceId,
          event.eventType,
          JSON.stringify({ workspaceId: event.payload.workspaceId }),
          now().toISOString(),
        ],
      );
    })().catch(() => {
      // Telemetry never breaks authentication (routes/index.ts contract).
    });
  };
};
