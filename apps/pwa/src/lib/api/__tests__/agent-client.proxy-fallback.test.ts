import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendAgentMessage, fetchAgentHistory, agentBaseUrl } from "../agent-client";
import * as agentAuth from "../agent-auth";

/**
 * Regressão para fallback seguro ao proxy /api/agent
 * - Quando NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL ausente, cliente deve usar /api/agent (Next.js proxy)
 *   preservando x-agent-connection-token e X-Workspace-Id sem mascarar 401/403
 * - Preserva isOwn parsing e propaga status/code
 */
describe("agent-client proxy fallback (regressão chat widget)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("usa /api/agent quando env direta ausente e preserva token + X-Workspace-Id", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ turnId: "turn-123", status: "completed", output: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await sendAgentMessage("ws-123", "oi");
    expect(result.status).toBe("completed");
    expect(capturedUrl).toBe("/api/agent/agents/finance-chat-agent/ws-123/rpc/chat");
    expect(capturedHeaders["X-Workspace-Id"]).toBe("ws-123");
    expect(capturedHeaders["x-agent-connection-token"]).toBe("conn-token-123");
  });

  it("preserva 401/403 sem mascarar e alinha X-Workspace-Id com token", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("t-401");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "auth.workspace_forbidden", message: "Acesso ao workspace proibido." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(sendAgentMessage("ws-123", "hi")).rejects.toMatchObject({ message: expect.stringContaining("Acesso") });
    try {
      await sendAgentMessage("ws-123", "hi");
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      expect(err.status).toBe(403);
      expect(err.code).toBe("auth.workspace_forbidden");
    }
  });

  it("fetchAgentHistory usa fallback e propaga isOwn corretamente, falha fechada quando isOwn ausente", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("t-hist");

    let url = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      url = String(u);
      return new Response(JSON.stringify({ items: [{ id: "m1", actorId: "u1", role: "user", content: "hi", isOwn: true }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const items = await fetchAgentHistory("ws-1");
    expect(url).toBe("/api/agent/agents/finance-chat-agent/ws-1/rpc/history");
    expect(items[0]!.isOwn).toBe(true);

    // contrato estrito: quando isOwn ausente, deve rejeitar (fail closed)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: "m1", actorId: "other", role: "user", content: "hi" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(fetchAgentHistory("ws-1")).rejects.toThrow();
  });
});

describe("agentBaseUrl NODE_ENV gate (issue #251)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores NEXT_PUBLIC override in production and returns /api/agent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    expect(agentBaseUrl()).toBe("/api/agent");
  });

  it("uses NEXT_PUBLIC override in development when set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    expect(agentBaseUrl()).toBe("https://agent.example.test");
  });

  it("uses NEXT_PUBLIC override in test env when set", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    expect(agentBaseUrl()).toBe("https://agent.example.test");
  });

  it("defaults to /api/agent when override absent (any env)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "");
    expect(agentBaseUrl()).toBe("/api/agent");
  });
});
