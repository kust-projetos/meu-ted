import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decidePendingOperation,
  describePendingOperationStatus,
  fetchAgentHistory,
  formatCentsToBRL,
  formatDateToBR,
  sendAgentMessage,
} from "./agent-client";
import * as agentAuth from "./agent-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("FinanceChatAgent Canonical REST Client & Legacy Adapters", () => {
  it("sends a pending decision only to the authenticated Agent RPC", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          operationId: "op-1",
          status: "succeeded",
          receipt: {
            mutationId: "mut-1",
            mutationKind: "transactions.expense.create",
            status: "succeeded",
            affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
            operationId: "op-1",
            entity: { type: "transaction", id: "tx-1" },
          },
        }),
        { status: 200 },
      );
    });

    await expect(decidePendingOperation("workspace-123", "op-1", "confirm")).resolves.toEqual({
      operationId: "op-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-1",
        mutationKind: "transactions.expense.create",
        status: "succeeded",
        affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
        operationId: "op-1",
        entity: { type: "transaction", id: "tx-1" },
      },
    });

    expect(capturedUrl).toBe("https://agent.example.test/agents/finance-chat-agent/workspace-123/rpc/pending-operations/op-1/decision");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toMatchObject({ decision: "confirm" });
    expect(body).not.toHaveProperty("attestation");
  });
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

  it("T3.4 RED: sendAgentMessage forwards the canonical presentation (Valor/Conta/Categoria/Data) untouched", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t1",
          status: "completed",
          output: "Proposta: Mercado. Confirma?",
          pendingOperation: {
            id: "pending-v2-1",
            status: "proposed",
            operation: "transactions.expense.create",
            summary: "Mercado",
            presentation: {
              id: "pending-v2-1",
              status: "proposed",
              tool: "transactions.expense.create",
              title: "Confirmar despesa",
              amountCents: 85000,
              description: "Mercado",
              date: "2026-09-14",
              account: { id: "acc-1", label: "Nubank" },
              category: { id: "cat-1", label: "Alimentação" },
              expiresAt: "2026-09-14T13:00:00.000Z",
              warnings: [],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const turn = await sendAgentMessage("ws-1", "gastei 850 no mercado");
    expect(turn.pendingOperation?.presentation?.amountCents).toBe(85000);
    expect(turn.pendingOperation?.presentation?.account).toEqual({ id: "acc-1", label: "Nubank" });
    expect(turn.pendingOperation?.presentation?.category).toEqual({ id: "cat-1", label: "Alimentação" });
    expect(turn.pendingOperation?.presentation?.title).toBe("Confirmar despesa");
  });

  it("T3.4 RED: presentation carrying attestation is stripped before reaching the card", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t1",
          status: "completed",
          output: "ok",
          pendingOperation: {
            id: "op-1",
            status: "proposed",
            operation: "transactions.expense.create",
            presentation: {
              id: "op-1",
              status: "proposed",
              tool: "transactions.expense.create",
              title: "Confirmar despesa",
              expiresAt: "2026-09-14T13:00:00.000Z",
              warnings: [],
              attestation: "must-never-reach-browser",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const turn = await sendAgentMessage("ws-1", "oi");
    expect(JSON.stringify(turn)).not.toContain("attestation");
  });

  it("T3.4 RED: visible-states contract maps every operation status to pt-BR (SPEC §16)", () => {
    expect(describePendingOperationStatus("proposed")).toMatch(/aguardando aprova/i);
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

  it("T6.1 (§25.4): history items carry the authoritative pending operation for reload rehydration", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "msg-1",
              actorId: "user-1",
              role: "user",
              content: "gastei 850 no mercado",
              isOwn: true,
            },
            {
              id: "msg-2",
              actorId: "ted",
              role: "assistant",
              content: "Proposta: Mercado. Confirma?",
              isOwn: false,
              pendingOperation: {
                id: "pending-v2-1",
                status: "proposed",
                operation: "transactions.expense.create",
                summary: "Mercado",
                // Unknown top-level keys never cross into the card.
                attestation: "must-never-reach-card",
                presentation: {
                  id: "pending-v2-1",
                  status: "proposed",
                  tool: "transactions.expense.create",
                  title: "Confirmar despesa",
                  amountCents: 85000,
                  description: "Mercado",
                  date: "2026-09-14",
                  account: { id: "acc-1", label: "Nubank" },
                  category: { id: "cat-1", label: "Alimentação" },
                  expiresAt: "2026-09-14T13:00:00.000Z",
                  warnings: [],
                },
              },
            },
          ],
          total: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const items = await fetchAgentHistory("workspace-123");
    expect(items).toHaveLength(2);
    expect(items[0]!.pendingOperation).toBeUndefined();
    expect(items[1]!.pendingOperation?.id).toBe("pending-v2-1");
    expect(items[1]!.pendingOperation?.presentation?.amountCents).toBe(85000);
    expect(JSON.stringify(items[1])).not.toContain("attestation");
  });

  it("T6.1 (§25.4): invalid pending operation on a history item collapses to no card — history still parses", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "msg-1",
              actorId: "user-1",
              role: "user",
              content: "oi",
              isOwn: true,
              pendingOperation: { id: "op-bad", status: "invented-status", operation: "x" },
            },
          ],
          total: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const items = await fetchAgentHistory("workspace-123");
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe("oi");
    expect(items[0]!.pendingOperation).toBeUndefined();
  });

  describe("T3.3 execution receipt (API → Agent → PWA)", () => {
    const cleanReceipt = {
      mutationId: "mut-1",
      mutationKind: "transactions.expense.create",
      status: "succeeded" as const,
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-1",
      entity: { type: "transaction", id: "tx-1" },
    };

    const mockDecision =
      (body: unknown) =>
      async (): Promise<Response> =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    const stubAgent = () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    };

    it("decidePendingOperation parses and exposes the real execution receipt", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({ operationId: "op-1", status: "succeeded", receipt: cleanReceipt }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      await expect(decidePendingOperation("workspace-123", "op-1", "confirm")).resolves.toEqual({
        operationId: "op-1",
        status: "succeeded",
        receipt: cleanReceipt,
      });
    });

    it("succeeded with distinct pending vs transaction IDs parses (operationId=pending, entity.id=transaction)", async () => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({ operationId: "op-1", status: "succeeded", receipt: cleanReceipt }),
      );

      const result = await decidePendingOperation("workspace-123", "op-1", "confirm");
      expect(result.status).toBe("succeeded");
      expect(result.receipt?.operationId).toBe("op-1");
      expect(result.receipt?.entity?.type).toBe("transaction");
      expect(result.receipt?.entity?.id).toBe("tx-1");
      expect(result.receipt?.entity?.id).not.toBe("op-1");
    });

    it("succeeded with missing receipt rejects — never resolves as success without receipt", async () => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({ operationId: "op-1", status: "succeeded" }),
      );

      const err = await decidePendingOperation("workspace-123", "op-1", "confirm").catch(
        (e: unknown) => e as Error & { code?: string },
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { code?: string }).code).toBe("agent.execution_outcome_unknown");
      expect(err.message).toMatch(/resultado.*verificad/i);
      expect(err.message).not.toMatch(/tente novamente/i);
    });

    it("succeeded with wrong receipt.operationId rejects", async () => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({
          operationId: "op-1",
          status: "succeeded",
          receipt: { ...cleanReceipt, operationId: "op-other" },
        }),
      );

      await expect(decidePendingOperation("workspace-123", "op-1", "confirm")).rejects.toMatchObject({
        code: "agent.execution_outcome_unknown",
      });
    });

    it("succeeded with a mismatched decision operationId rejects as an uncertain outcome", async () => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({ operationId: "op-other", status: "succeeded", receipt: cleanReceipt }),
      );

      const err = await decidePendingOperation("workspace-123", "op-1", "confirm").catch(
        (e: unknown) => e as Error & { code?: string },
      );
      expect(err).toMatchObject({ code: "agent.execution_outcome_unknown" });
      expect(err.message).toMatch(/resultado.*verificad/i);
      expect(err.message).not.toMatch(/tente novamente/i);
    });

    it.each([
      ["wrong entity type", { ...cleanReceipt, entity: { type: "account", id: "tx-1" } }],
      ["missing entity id", { ...cleanReceipt, entity: { type: "transaction", id: "" } }],
      ["missing entity", { ...cleanReceipt, entity: undefined }],
    ])("succeeded with %s rejects", async (_label, receipt) => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({ operationId: "op-1", status: "succeeded", receipt }),
      );

      await expect(decidePendingOperation("workspace-123", "op-1", "confirm")).rejects.toMatchObject({
        code: "agent.execution_outcome_unknown",
      });
    });

    it("cancelled without receipt still parses (no receipt required off the succeeded path)", async () => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({ operationId: "op-1", status: "cancelled" }),
      );

      await expect(decidePendingOperation("workspace-123", "op-1", "cancel")).resolves.toEqual({
        operationId: "op-1",
        status: "cancelled",
      });
    });

    it("failed without receipt still parses (no receipt required off the succeeded path)", async () => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockDecision({ operationId: "op-1", status: "failed", retryable: true }),
      );

      await expect(decidePendingOperation("workspace-123", "op-1", "retry")).resolves.toEqual({
        operationId: "op-1",
        status: "failed",
        retryable: true,
      });
    });

    it.each(["cancelled", "failed"] as const)(
      "%s decision must still identify the requested operation",
      async (status) => {
        stubAgent();
        vi.spyOn(globalThis, "fetch").mockImplementation(
          mockDecision({ operationId: "op-other", status }),
        );

        await expect(decidePendingOperation("workspace-123", "op-1", "cancel")).rejects.toMatchObject({
          code: "agent.execution_outcome_unknown",
        });
      },
    );

    it.each(["cancelled", "failed"] as const)(
      "%s decision with a receipt rejects instead of forwarding it to financial reconciliation",
      async (status) => {
        stubAgent();
        vi.spyOn(globalThis, "fetch").mockImplementation(
          mockDecision({ operationId: "op-1", status, receipt: cleanReceipt }),
        );

        await expect(decidePendingOperation("workspace-123", "op-1", "cancel")).rejects.toMatchObject({
          code: "agent.invalid_decision_result",
        });
      },
    );

    it("a receipt carrying attestation rejects — nothing tainted silently becomes succeeded (INV-05)", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({
            operationId: "op-1",
            status: "succeeded",
            receipt: { ...cleanReceipt, attestation: "must-never-reach-browser" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const captured = await decidePendingOperation("workspace-123", "op-1", "confirm").catch((e: unknown) => e);
      expect(captured).toMatchObject({ code: "agent.execution_outcome_unknown" });
      expect(JSON.stringify(captured)).not.toContain("attestation");
    });

    it("a receipt with an unknown key rejects (strict browser allowlist, never silent success)", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({
            operationId: "op-1",
            status: "succeeded",
            receipt: { ...cleanReceipt, normalizedArgs: { amountCents: 8500 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const captured = await decidePendingOperation("workspace-123", "op-1", "confirm").catch((e: unknown) => e);
      expect(captured).toMatchObject({ code: "agent.execution_outcome_unknown" });
      expect(JSON.stringify(captured)).not.toContain("normalizedArgs");
    });

    it("sendAgentMessage exposes pendingOperation.receipt from a succeeded chat turn", async () => {
      vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
      vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({
            turnId: "t1",
            status: "completed",
            output: "Lançamento registrado com sucesso.",
            pendingOperation: {
              id: "op-1",
              status: "succeeded",
              operation: "transactions.expense.create",
              receipt: cleanReceipt,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const turn = await sendAgentMessage("ws-1", "confirma");
      expect(turn.pendingOperation?.receipt).toEqual(cleanReceipt);
      expect(JSON.stringify(turn)).not.toContain("attestation");
    });

    it.each([
      ["missing receipt", undefined],
      ["receipt for another pending operation", { ...cleanReceipt, operationId: "op-other" }],
      ["receipt without a transaction entity", { ...cleanReceipt, entity: undefined }],
    ])("sendAgentMessage rejects succeeded chat turns with %s", async (_label, receipt) => {
      stubAgent();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(
          JSON.stringify({
            turnId: "t1",
            status: "completed",
            output: "Lançamento registrado com sucesso.",
            pendingOperation: {
              id: "op-1",
              status: "succeeded",
              operation: "transactions.expense.create",
              ...(receipt ? { receipt } : {}),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      await expect(sendAgentMessage("ws-1", "confirma")).rejects.toMatchObject({
        code: "agent.execution_outcome_unknown",
      });
    });
  });

});
