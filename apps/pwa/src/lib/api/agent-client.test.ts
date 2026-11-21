import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describePendingOperationStatus,
  fetchAgentHistory,
  formatCentsToBRL,
  formatDateToBR,
  requestAgentEmptyAttestation,
  sendAgentMessage,
} from "./agent-client";
import * as agentAuth from "./agent-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("FinanceChatAgent Canonical REST Client & Legacy Adapters", () => {
  it("sendAgentMessage sends POST to /agents/finance-chat-agent/:workspaceId/rpc/chat with x-agent-connection-token and text payload", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          turnId: "turn-abc",
          status: "completed",
          output: "Seu saldo é R$ 1.000,00.",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await sendAgentMessage("workspace-123", "Quanto gastei?");

    expect(capturedUrl).toBe("https://agent.example.test/agents/finance-chat-agent/workspace-123/rpc/chat");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["x-agent-connection-token"]).toBe("signed-token-123");
    // SPEC §7.7: the send carries a stable intentionId (PWA messageId).
    const sentBody = JSON.parse(String(capturedInit?.body)) as { text?: string; intentionId?: string };
    expect(sentBody.text).toBe("Quanto gastei?");
    expect(typeof sentBody.intentionId).toBe("string");
    expect(sentBody.intentionId!.length).toBeGreaterThan(0);
    expect(result.output).toBe("Seu saldo é R$ 1.000,00.");
  });

  it("fetchAgentHistory sends GET to /agents/finance-chat-agent/:workspaceId/rpc/history and parses isOwn correctly", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "msg-1",
              actorId: "user-1",
              role: "user",
              content: "Mensagem 1",
              createdAt: "2026-08-30T10:00:00Z",
              isOwn: true,
            },
            {
              id: "msg-2",
              actorId: "ted",
              role: "assistant",
              content: "Resposta do assistente",
              createdAt: "2026-08-30T10:00:05Z",
              isOwn: false,
            },
            {
              id: "msg-3",
              actorId: "user-2",
              role: "user",
              content: "Mensagem do outro membro",
              createdAt: "2026-08-30T10:01:00Z",
              isOwn: false,
            },
          ],
          total: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const items = await fetchAgentHistory("workspace-123");

    expect(capturedUrl).toBe("https://agent.example.test/agents/finance-chat-agent/workspace-123/rpc/history");
    expect((capturedInit?.headers as Record<string, string>)["x-agent-connection-token"]).toBe("signed-token-123");
    expect(items).toHaveLength(3);
    expect(items[0]!.isOwn).toBe(true);
    expect(items[1]!.isOwn).toBe(false);
    expect(items[2]!.isOwn).toBe(false);
  });

  it("RED (1): fetchAgentHistory fails closed and throws when isOwn is missing in /rpc/history response", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "msg-1",
              actorId: "other-user",
              role: "user",
              content: "Mensagem de outro membro sem isOwn",
              // isOwn is absent
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // Must reject because isOwn is strictly required by the Finance contract
    await expect(fetchAgentHistory("workspace-123")).rejects.toThrow();
  });

  it("RED (2): sendAgentMessage and fetchAgentHistory propagate token error and do not call fetch against the agent", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockRejectedValue(new Error("Token generation failed: Unauthorized"));

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(sendAgentMessage("workspace-123", "Olá")).rejects.toThrow("Token generation failed: Unauthorized");
    expect(fetchSpy).not.toHaveBeenCalled();

    await expect(fetchAgentHistory("workspace-123")).rejects.toThrow("Token generation failed: Unauthorized");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sendAgentMessage propagates safe error message when agent returns failure", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "agent.usage_limit",
          message: "Limite de tokens diário atingido.",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(sendAgentMessage("workspace-123", "Olá")).rejects.toThrow(
      "Limite de tokens diário atingido.",
    );
  });

  it("T4.2 (SPEC section 11 E2, contract change): the retired-runtime helpers are gone — history flows use /rpc/history only", async () => {
    // exportAgentHistory/deleteAgentHistory/fetchAgentAccessLog (and the
    // turn helpers cancel/stream/reconnect) were REMOVED in T4.2, not
    // re-pointed: the retired routes have no canonical equivalent. The
    // dedicated contract lives in __tests__/agent-client.t4-2-legacy-removal.test.ts.
    const ns = (await import("./agent-client")) as Record<string, unknown>;
    for (const name of [
      "exportAgentHistory",
      "deleteAgentHistory",
      "fetchAgentAccessLog",
      "cancelAgentTurn",
      "streamAgentTurn",
      "reconnectAgentTurn",
    ]) {
      expect(ns).not.toHaveProperty(name);
    }

    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
    });

    await fetchAgentHistory("w1");
    expect(capturedUrl).toBe("https://agent.example.test/agents/finance-chat-agent/w1/rpc/history");
  });

  it("defaults to the same-origin /api/agent proxy (ADR-011 canonical) without explicit env", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ turnId: "t1", status: "completed", output: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await sendAgentMessage("ws-1", "oi");

    expect(capturedUrl).toBe("/api/agent/agents/finance-chat-agent/ws-1/rpc/chat");
  });

  it("T3.4 RED: visible-states contract maps every operation status to pt-BR (SPEC §16)", () => {
    expect(describePendingOperationStatus("proposed")).toMatch(/em andamento/i);
    expect(describePendingOperationStatus("executing")).toMatch(/processando/i);
    expect(describePendingOperationStatus("succeeded")).toMatch(/conclu/i);
    expect(describePendingOperationStatus("failed")).toMatch(/falhou/i);
    expect(describePendingOperationStatus("cancelled")).toMatch(/cancelad/i);
    expect(describePendingOperationStatus("expired")).toMatch(/expirad/i);
  });

  it("T3.4 RED: formats currency and date in pt-BR for the card", () => {
    expect(formatCentsToBRL(85000)).toBe("R$ 850,00");
    expect(formatDateToBR("2026-09-14")).toBe("14/09/2026");
  });

  describe("requestAgentEmptyAttestation (FIX-WS-D2-R5: só o handle opaco)", () => {
    const handle = { attestationId: "22222222-2222-4222-8222-222222222222" };
    const inventoryVersion = "a".repeat(64);

    it("recebe SÓ o handle opaco do depósito (POST attest-empty)", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify(handle), { status: 200 });
      });

      await expect(requestAgentEmptyAttestation("ws-1", inventoryVersion)).resolves.toEqual(handle);
      expect(capturedUrl).toBe(
        "https://agent.example.test/agents/finance-chat-agent/ws-1/rpc/workspace/ws-1/attest-empty",
      );
      expect(capturedInit?.method).toBe("POST");
      expect(JSON.parse(String(capturedInit?.body))).toEqual({ inventoryVersion });
    });

    it("rejeita corpo com conteúdo/HMAC (a prova nunca cruza o browser)", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({
            workspaceId: "ws-1",
            inventoryVersion,
            counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
            expiresAt: new Date().toISOString(),
            hmac: "b".repeat(64),
          }),
          { status: 200 },
        ),
      );

      await expect(requestAgentEmptyAttestation("ws-1", inventoryVersion)).rejects.toMatchObject({
        code: "agent.invalid_attestation_response",
      });
    });

    it("propaga o code do Agent (qual lado falhou) sem mascarar", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({ code: "agent.workspace_not_empty", message: "Exclusão bloqueada." }),
          { status: 409 },
        ),
      );

      await expect(requestAgentEmptyAttestation("ws-1", inventoryVersion)).rejects.toMatchObject({
        code: "agent.workspace_not_empty",
        status: 409,
      });
    });

    it("rejeita payload sem handle válido (nunca inventa depósito)", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ workspaceId: "ws-1" }), { status: 200 }),
      );

      await expect(requestAgentEmptyAttestation("ws-1", inventoryVersion)).rejects.toMatchObject({
        code: "agent.invalid_attestation_response",
      });
    });
  });

});
