import { readFileSync } from "node:fs";
import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { registerPostgresProductionRoutes } from "../../src/server/production-routes.js";
import { createPostgresIdempotencyStore } from "../../src/writes/postgres.js";
import { HOUSEHOLD_A } from "../fixtures/seed.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";

function makeLegacyPool(): { pool: Pool; sql: string[] } {
  const sql: string[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      sql.push(text);
      if (text.includes("SELECT id FROM users")) {
        // For push subscription, actor is device token not a user -> return 0 (NULL user_id)
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("INSERT INTO operation_records")) {
        // V016 adiciona `actor_type` a operation_records (incondicional,
        // com CHECK IN ('device','user')); só `household_id` (coluna
        // inexistente no canônico, que usa `workspace_id`) e
        // `request_payload` (envelope legado inexistente) seguem recusados.
        if (text.includes("household_id") || text.includes("request_payload")) {
          throw new Error(
            'column "household_id" of relation "operation_records" does not exist',
          );
        }
        // Return claim row with id for successful insert, or empty for conflict case
        if (text.includes("ON CONFLICT (workspace_id, idempotency_key) DO NOTHING")) {
          return { rowCount: 1, rows: [{ id: OPERATION_ID, status: "processing", response: null, effect_ref: null }] };
        }
        return { rowCount: 1, rows: [{ id: OPERATION_ID }] };
      }
      if (text.includes("INSERT INTO audit_logs")) {
        if (text.includes("operation_record_id") || text.includes("workspace_id") || text.includes("payload_hash")) {
          throw new Error(
            'column "operation_record_id" of relation "audit_logs" does not exist',
          );
        }
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT status, response, payload_hash")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("UPDATE operation_records")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT id, household_id, user_id")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };

  const pool = {
    async query(text: string) {
      sql.push(text);
      if (text.includes("UPDATE device_tokens SET last_used_at")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM device_tokens")) {
        return {
          rowCount: 1,
          rows: [{ device_id: "legacy-device", household_id: HOUSEHOLD_A, expires_at: null }],
        };
      }
      if (text.includes("INSERT INTO push_subscriptions")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "subscription-1",
              workspace_id: HOUSEHOLD_A,
              user_id: "legacy-device",
              endpoint: "https://push.example.test/subscription-1",
              p256dh: "p256dh",
              auth: "auth",
              user_agent: "test",
              created_at: "2026-08-29T00:00:00.000Z",
              updated_at: "2026-08-29T00:00:00.000Z",
              last_used_at: null,
            },
          ],
        };
      }
      throw new Error(`unexpected pool query: ${text}`);
    },
    async connect() {
      return client;
    },
  } as unknown as Pool;

  return { pool, sql };
}

describe("legacy production idempotency wiring", () => {
  it("uses the legacy audit shape for push subscription writes", async () => {
    const { pool, sql } = makeLegacyPool();
    const app = Fastify({ logger: false });
    registerPostgresProductionRoutes(app, pool, true, HOUSEHOLD_A);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/push/subscriptions",
        headers: {
          "x-device-token": `${HOUSEHOLD_A}.legacy-token`,
          "idempotency-key": "push-subscription-1",
        },
        payload: {
          endpoint: "https://push.example.test/subscription-1",
          keys: { p256dh: "p256dh", auth: "auth" },
          userAgent: "test",
        },
      });

      expect(response.statusCode).toBe(201);
      const operationInsert = sql.find((statement) => statement.includes("INSERT INTO operation_records"));
      expect(operationInsert).toContain("workspace_id");
      expect(operationInsert).toContain("payload_hash");
      expect(operationInsert).toContain("status");
      expect(operationInsert).toContain("lease_until");
      expect(operationInsert).toContain("retry_until");
      expect(operationInsert).toContain("retention_until");
      expect(operationInsert).toContain("ON CONFLICT (workspace_id, idempotency_key) DO NOTHING");
      expect(operationInsert).not.toContain("household_id");
      expect(operationInsert).not.toContain("request_payload");
      // T09: o claim canônico transporta o ator autenticado (V016:
      // `actor_type` existe em operation_records desde a migration).
      expect(operationInsert).toContain("actor_type");

      const auditInsert = sql.find((statement) =>
        statement.includes("INSERT INTO audit_logs"),
      );
      expect(auditInsert).toContain("household_id");
      expect(auditInsert).toContain("user_id");
      expect(auditInsert).toContain("action");
      expect(auditInsert).toContain("entity_type");
      expect(auditInsert).toContain("entity_id");
      expect(auditInsert).toContain("before_json");
      expect(auditInsert).toContain("after_json");
      expect(auditInsert).not.toContain("operation_record_id");
      expect(auditInsert).not.toContain("workspace_id");
      expect(auditInsert).not.toContain("payload_hash");
      // V016 só adiciona `actor_type` ao audit_logs quando `workspace_id`
      // existe — nunca no audit legacy hybrid (sem workspace_id).
      expect(auditInsert).not.toContain("actor_type");
    } finally {
      await app.close();
    }
  });

  it("passes legacy mode to the idempotency store in both production boot paths", () => {
    for (const file of [
      "../../src/server/index.ts",
      "../../src/server/production-routes.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).toMatch(
        /createPostgresIdempotencyStore\(\{\s*pool,\s*legacy:\s*true,?\s*\}\)/,
      );
    }
  });

  it("resolves Better-Auth auth_user_id to users.id for invite audit (FK ok)", async () => {
    const authUserId = "WUCGTzoQ7LRRe8eftJjFyKowx96Ryrbs";
    const resolvedUserId = "adbb7007-7b8d-4cf3-8c86-e1057c43f4ff";
    const captured: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        captured.push({ text, values });
        if (text.includes("SELECT id FROM users")) {
          if (values?.[0] === authUserId) return { rowCount: 1, rows: [{ id: resolvedUserId }] };
          return { rowCount: 0, rows: [] };
        }
        if (text.includes("INSERT INTO operation_records")) {
          return { rowCount: 1, rows: [{ id: OPERATION_ID, status: "processing", response: null, effect_ref: null }] };
        }
        if (text.includes("UPDATE operation_records")) return { rowCount: 1, rows: [] };
        if (text.includes("INSERT INTO audit_logs")) {
          const userIdParam = values?.[2];
          expect(userIdParam).toBe(resolvedUserId);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const store = createPostgresIdempotencyStore({ pool, legacy: true });
    const result = await store.lookupOrRecord(
      { workspaceId: HOUSEHOLD_A, actorType: "user", actorId: authUserId, operation: "invites.create", key: "invite-1" },
      { email: "convidado@example.com" },
      async () => ({ inviteId: "inv-1" }),
    );
    expect(result.replayed).toBe(false);
  });

  it("falls back to NULL user_id when actorId cannot be resolved (FK safe)", async () => {
    const unknownActor = "nonexistent-auth-id";
    const captured: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        captured.push({ text, values });
        if (text.includes("SELECT id FROM users")) {
          return { rowCount: 0, rows: [] };
        }
        if (text.includes("INSERT INTO operation_records")) {
          return { rowCount: 1, rows: [{ id: OPERATION_ID, status: "processing", response: null, effect_ref: null }] };
        }
        if (text.includes("UPDATE operation_records")) return { rowCount: 1, rows: [] };
        if (text.includes("INSERT INTO audit_logs")) {
          const userIdParam = values?.[2];
          expect(userIdParam).toBeNull();
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const store = createPostgresIdempotencyStore({ pool, legacy: true });
    const result = await store.lookupOrRecord(
      { workspaceId: HOUSEHOLD_A, actorType: "user", actorId: unknownActor, operation: "workspaces.create", key: "ws-1" },
      { name: "Ws" },
      async () => ({ id: "ws-1" }),
    );
    expect(result.replayed).toBe(false);
  });
});
