import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { buildTestApp, TOKEN_A } from "../test-app.js";
import { registerDuplicateDetectRoutes } from "../../src/routes/duplicate-detect.js";

const validPayload = { kind: "expense", description: "almoço", amountCents: 3500, date: "2026-10-02" };
const registerDirectRoute = (pool?: Pool) => {
  const app = Fastify({ logger: false });
  registerDuplicateDetectRoutes(app, {
    resolveToken: vi.fn(async () => ({ householdId: "household-1", actorId: "actor-1", authUserId: "actor-1", actorType: "user", deviceId: "device-1", role: "member" })),
    ...(pool ? { pool } : {}),
  });
  return app;
};

describe("POST /transactions/detect-duplicate", () => {
  it("requires authentication", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/transactions/detect-duplicate", payload: { kind: "expense", description: "teste", amountCents: 1000, date: "2026-08-26" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns 503 when the pool is unavailable", async () => {
    const app = registerDirectRoute();
    const res = await app.inject({
      method: "POST",
      url: "/transactions/detect-duplicate",
      payload: validPayload,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "duplicate_detection_unavailable" });
    await app.close();
  });

  it("returns 503 when duplicate lookup fails", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("sensitive driver detail")) } as unknown as Pool;
    const app = registerDirectRoute(pool);
    const res = await app.inject({ method: "POST", url: "/transactions/detect-duplicate", payload: validPayload });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "duplicate_detection_unavailable" });
    expect(res.body).not.toContain("sensitive driver detail");
    await app.close();
  });

  it("returns a definitive negative only when the database lookup finds no rows", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const app = registerDirectRoute(pool);
    const res = await app.inject({ method: "POST", url: "/transactions/detect-duplicate", payload: validPayload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ duplicate_detected: false });
    await app.close();
  });

  it("returns the matched duplicate payload when the database finds a match", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      id: "transaction-1", description: "almoço", amount_cents: "3500", date: new Date("2026-10-02T00:00:00.000Z"),
      from_account_id: null, to_account_id: null, created_at: new Date("2026-10-02T00:00:00.000Z"),
    }] }) } as unknown as Pool;
    const app = registerDirectRoute(pool);
    const res = await app.inject({ method: "POST", url: "/transactions/detect-duplicate", payload: validPayload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ duplicate_detected: true, match: { id: "transaction-1", match_type: "semantic", similarity: 1 } });
    await app.close();
  });

  it("validates payload", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/transactions/detect-duplicate",
      headers: { "x-device-token": TOKEN_A },
      payload: { kind: "invalid", description: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
