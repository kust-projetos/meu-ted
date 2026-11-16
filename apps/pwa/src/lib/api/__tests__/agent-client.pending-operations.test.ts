/**
 * T5.3 (H-14, SPEC §22) — PWA client for the Agent's active pending-operations
 * listing. The browser only REFLECTS the authoritative lean projection:
 * strict local schema (bundle budget forbids importing the contracts zod
 * entry); any payload carrying attestation/authority material or unknown
 * keys is discarded wholesale — never partially trusted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchActivePendingOperations } from "../agent-client";
import * as agentAuth from "../agent-auth";

const leanItem = {
  id: "op-1",
  status: "proposed",
  tool: "transactions.expense.create",
  createdAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-09-15T15:00:00.000Z",
  amountCents: 8500,
  description: "Mercado",
  date: "2026-09-15",
  accountId: "acc-1",
  categoryId: "cat-1",
};

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetchActivePendingOperations", () => {
  it("GETs the agent rpc listing with the connection token and returns the lean items", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ items: [leanItem], total: 1 }, { status: 200 });
    });

    const items = await fetchActivePendingOperations("workspace-123");

    expect(capturedUrl).toBe(
      "https://agent.example.test/agents/finance-chat-agent/workspace-123/rpc/pending-operations/active",
    );
    expect(capturedInit?.method).toBe("GET");
    expect((capturedInit?.headers as Record<string, string>)["x-agent-connection-token"]).toBe(
      "signed-token-123",
    );
    expect((capturedInit?.headers as Record<string, string>)["X-Workspace-Id"]).toBe("workspace-123");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "op-1", status: "proposed", amountCents: 8500 });
  });

  it("discards the whole payload when any item carries attestation or unknown keys", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          items: [{ ...leanItem, attestation: "a".repeat(64) }],
          total: 1,
        },
        { status: 200 },
      ),
    );

    await expect(fetchActivePendingOperations("workspace-123")).rejects.toThrow();
  });

  it("accepts supersedes as display metadata while still rejecting unallowlisted data", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [{ ...leanItem, supersedes: "op-previous" }], total: 1 }, { status: 200 }),
    );
    const items = await fetchActivePendingOperations("workspace-123");
    expect(items[0]?.supersedes).toBe("op-previous");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [{ ...leanItem, supersedes: "op-previous", normalizedArgs: {} }], total: 1 }, { status: 200 }),
    );
    await expect(fetchActivePendingOperations("workspace-123")).rejects.toThrow();
  });

  it("discards the payload when the top level carries extra keys (e.g. attestation)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [leanItem], total: 1, attestation: "x".repeat(64) }, { status: 200 }),
    );

    await expect(fetchActivePendingOperations("workspace-123")).rejects.toThrow();
  });

  it("maps non-OK responses to an honest operational error (pt-BR)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ code: "agent.unavailable" }), { status: 503 }),
    );

    await expect(fetchActivePendingOperations("workspace-123")).rejects.toThrow(
      "Não foi possível carregar as aprovações agora.",
    );
  });

  it("FIX-P1: accepts the canonical server-derived presentation, rejects poisoned ones", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    const presentation = {
      id: "op-1",
      status: "proposed",
      tool: "transactions.expense.create",
      title: "Confirmar despesa",
      amountCents: 8500,
      description: "Mercado",
      date: "2026-09-15",
      expiresAt: "2026-09-15T15:00:00.000Z",
      warnings: [],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [{ ...leanItem, presentation }], total: 1 }, { status: 200 }),
    );

    const items = await fetchActivePendingOperations("workspace-123");
    expect(items).toHaveLength(1);
    expect(items[0]!.presentation).toMatchObject({ title: "Confirmar despesa" });

    // Poisoned presentation (attestation key) discards the whole payload.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { items: [{ ...leanItem, presentation: { ...presentation, attestation: "a".repeat(64) } }], total: 1 },
        { status: 200 },
      ),
    );
    await expect(fetchActivePendingOperations("workspace-123")).rejects.toThrow();
  });
});
