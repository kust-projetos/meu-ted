/**
 * GW-040 (workspace-switch isolation) — seam-level isolation of the isolated
 * backend, v1.
 *
 * The end-to-end golden case proves a cross-workspace "sim" never executes
 * (proposal in A, no pending in B, zero executions). This suite pins the
 * seam that makes it load-bearing: the operation ledger is scoped by the
 * `x-workspace-id` header — listings, confirm/execute/cancel and the
 * idempotency map never cross workspaces (404 / empty / distinct op, like
 * the real API). Synthetic workspaces only (`ws-golden-a` / `ws-golden-b`).
 */
import { describe, expect, it } from "vitest";
import { IsolatedBackend } from "./backend.js";

const headersFor = (workspaceId: string): Record<string, string | number | undefined> => ({
  "x-workspace-id": workspaceId,
  "x-actor-id": "actor-golden",
  "x-device-id": "golden-device-1",
});

const proposeArgs = {
  tool: "transactions.expense.create",
  normalizedArgs: { amount: 50 },
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
};

const statusOf = async (promise: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; statusCode: unknown }> => {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, statusCode: (error as { statusCode?: unknown }).statusCode };
  }
};

describe("GW-040 seam isolation: the isolated ledger is workspace-scoped", () => {
  it("a listing in B never shows an operation proposed in A", async () => {
    const backend = new IsolatedBackend({});
    const proposed = (await backend.request("POST", "/pending-operations/v2/propose", {
      headers: headersFor("ws-golden-a"),
      idempotencyKey: "key-a-1",
      body: proposeArgs,
    })) as { id: string };
    const inA = (await backend.request("GET", "/pending-operations/v2/active", {
      headers: headersFor("ws-golden-a"),
    })) as { items: unknown[]; total: number };
    expect(inA.total).toBe(1);
    const inB = (await backend.request("GET", "/pending-operations/v2/active", {
      headers: headersFor("ws-golden-b"),
    })) as { items: unknown[]; total: number };
    expect(inB).toEqual({ items: [], total: 0 });
    expect(proposed.id).toMatch(/^golden-op-/);
  });

  it("confirm/execute/cancel of A's operation from B resolve 404 with zero effect", async () => {
    const backend = new IsolatedBackend({});
    const proposed = (await backend.request("POST", "/pending-operations/v2/propose", {
      headers: headersFor("ws-golden-a"),
      idempotencyKey: "key-a-1",
      body: proposeArgs,
    })) as { id: string };
    const id = proposed.id;
    for (const path of [`/pending-operations/v2/${id}/confirm`, `/pending-operations/v2/${id}/execute`, `/pending-operations/v2/${id}/cancel`]) {
      const outcome = await statusOf(backend.request("POST", path, { headers: headersFor("ws-golden-b"), body: { intentionId: "x" } }));
      expect(outcome.ok, path).toBe(false);
      if (!outcome.ok) expect(outcome.statusCode, path).toBe(404);
    }
    expect(backend.proposalsCreated).toBe(1);
    expect(backend.executionsSucceeded).toBe(0);
    expect(backend.ops[0]?.status).toBe("proposed");
  });

  it("the same idempotency key in B proposes a distinct operation (no cross-workspace replay)", async () => {
    const backend = new IsolatedBackend({});
    const inA = (await backend.request("POST", "/pending-operations/v2/propose", {
      headers: headersFor("ws-golden-a"),
      idempotencyKey: "shared-key",
      body: proposeArgs,
    })) as { id: string; existing: boolean };
    const inB = (await backend.request("POST", "/pending-operations/v2/propose", {
      headers: headersFor("ws-golden-b"),
      idempotencyKey: "shared-key",
      body: proposeArgs,
    })) as { id: string; existing: boolean };
    expect(inA.existing).toBe(false);
    expect(inB.existing).toBe(false);
    expect(inB.id).not.toBe(inA.id);
    expect(backend.proposalsCreated).toBe(2);
  });
});
