import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLegacyBearerAuditSink } from "../../src/audit/legacy-bearer-sink.js";
import type { LegacyBearerUsedAuditEvent } from "../../src/routes/index.js";
import { HOUSEHOLD_A } from "../fixtures/seed.js";

const EVENT: LegacyBearerUsedAuditEvent = {
  eventType: "auth.request.legacy_bearer_used",
  payload: { workspaceId: HOUSEHOLD_A },
};

function makeCapturingPool(reject = false): {
  pool: { query: (text: string, values?: unknown[]) => Promise<unknown> };
  calls: Array<{ text: string; values?: unknown[] }>;
} {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    pool: {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        if (reject) throw new Error("connection refused");
        return { rowCount: 1, rows: [] };
      },
    },
    calls,
  };
}

describe("legacy bearer durable audit sink", () => {
  it("persists the event into audit_logs with the legacy action shape", () => {
    const { pool, calls } = makeCapturingPool();
    const sink = createLegacyBearerAuditSink(pool, () => new Date("2026-10-01T18:00:00.000Z"));

    sink(EVENT);

    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(text).toContain("INSERT INTO audit_logs");
    expect(text).toContain("household_id");
    expect(text).toContain("user_id");
    expect(text).toContain("action");
    expect(text).toContain("after_json");
    expect(text).not.toContain("payload_hash");
    expect(text).not.toContain("operation_record_id");
    // Legacy/canonical audit shape: user_id stays NULL (the bearer request never
    // resolved a session — that is exactly what the event records).
    expect(values?.[0]).toEqual(expect.any(String));
    expect(values?.[1]).toBe(HOUSEHOLD_A);
    expect(values?.[2]).toBe("auth.request.legacy_bearer_used");
    expect(JSON.parse(values?.[3] as string)).toEqual({ workspaceId: HOUSEHOLD_A });
    expect(values?.[4]).toBe("2026-10-01T18:00:00.000Z");
  });

  it("generates a unique row id per emission", () => {
    const { pool, calls } = makeCapturingPool();
    const sink = createLegacyBearerAuditSink(pool, () => new Date("2026-10-01T18:00:00.000Z"));

    sink(EVENT);
    sink(EVENT);

    expect(calls).toHaveLength(2);
    const ids = calls.map((c) => c.values?.[0] as string);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toEqual(expect.any(String));
  });

  it("never breaks authentication: storage failures are swallowed", () => {
    const { pool } = makeCapturingPool(true);
    const sink = createLegacyBearerAuditSink(pool, () => new Date("2026-10-01T18:00:00.000Z"));

    expect(() => sink(EVENT)).not.toThrow();
  });
});

describe("legacy bearer sink production wiring (source contract)", () => {
  it("wires the durable sink in both production boot paths", () => {
    for (const file of [
      "../../src/server/index.ts",
      "../../src/server/production-routes.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, `${file} must wire the durable sink`).toMatch(
        /legacyBearerAuditLog:\s*createLegacyBearerAuditSink\(pool\)/,
      );
      expect(source, `${file} must import the sink factory`).toMatch(
        /import\s*\{[^}]*createLegacyBearerAuditSink[^}]*\}\s*from\s*"[^"]*audit\/legacy-bearer-sink\.js"/,
      );
    }
  });
});

describe("randomUUID guard", () => {
  it("row ids are uuid-shaped", () => {
    expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
