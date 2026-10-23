/**
 * ROUND5-RED — 4 invariantes do Debugger (código HEAD 914928f).
 * Estes testes DEVEM FALHAR antes da correção e PASSAR depois.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, sendAgentMessage } from "../agent-client";
import * as agentAuth from "../agent-auth";

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const chatTurn = (pendingOperation: unknown) =>
  new Response(
    JSON.stringify({ turnId: "t-r5", status: "completed", output: "ok.", pendingOperation }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("ROUND5 RED — invariantes PWA", () => {
  it("R5-1 turno: presentation update SEM account.id + recibo conta arbitrária NEGA", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      chatTurn({
        id: "op-r5-1",
        status: "succeeded",
        operation: "list_accounts",
        presentation: {
          id: "op-r5-1",
          status: "proposed",
          tool: "accounts.update",
          title: "Renomear conta",
          // SEM account.id — sem alvo prévio resolvido
          accountName: "roxo",
          expiresAt: "2026-10-21T15:30:00.000Z",
          warnings: [],
        },
        receipt: {
          mutationId: "m-r5-1",
          mutationKind: "accounts.update",
          status: "succeeded",
          affectedTargets: ["accounts"],
          operationId: "op-r5-1",
          entity: { type: "account", id: "acc-arbitraria" },
        },
      }),
    );
    await expect(sendAgentMessage("ws-1", "renomeie")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });

  it("R5-2 decision: expected {tool} SEM entityId + recibo conta arbitrária NEGA", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-r5-2",
          status: "succeeded",
          receipt: {
            mutationId: "m-r5-2",
            mutationKind: "accounts.update",
            status: "succeeded",
            affectedTargets: ["accounts"],
            operationId: "op-r5-2",
            entity: { type: "account", id: "acc-arbitraria" },
          },
        },
        { status: 200 },
      ),
    );
    await expect(
      decidePendingOperation("ws-1", "op-r5-2", "confirm", { tool: "accounts.update" }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("R5-3 turno: presentation acc-1 × echo acc-2 (mesmo tool) NEGA por conflito", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      chatTurn({
        id: "op-r5-3",
        status: "succeeded",
        operation: "list_accounts",
        presentation: {
          id: "op-r5-3",
          status: "proposed",
          tool: "accounts.update",
          title: "Renomear conta",
          account: { id: "acc-1", label: "nubank" },
          accountName: "roxo",
          expiresAt: "2026-10-21T15:30:00.000Z",
          warnings: [],
        },
        expected: { tool: "accounts.update", entityId: "acc-2" },
        receipt: {
          mutationId: "m-r5-3",
          mutationKind: "accounts.update",
          status: "succeeded",
          affectedTargets: ["accounts"],
          operationId: "op-r5-3",
          entity: { type: "account", id: "acc-1" },
        },
      }),
    );
    await expect(sendAgentMessage("ws-1", "renomeie")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });

  it("R5-4 turno: presentation update SEM account.id + recibo tipo transaction NEGA", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      chatTurn({
        id: "op-r5-4",
        status: "succeeded",
        operation: "list_accounts",
        presentation: {
          id: "op-r5-4",
          status: "proposed",
          tool: "accounts.update",
          title: "Renomear conta",
          accountName: "roxo",
          expiresAt: "2026-10-21T15:30:00.000Z",
          warnings: [],
        },
        receipt: {
          mutationId: "m-r5-4",
          mutationKind: "accounts.update",
          status: "succeeded",
          affectedTargets: ["transactions"],
          operationId: "op-r5-4",
          entity: { type: "transaction", id: "tx-qualquer" },
        },
      }),
    );
    await expect(sendAgentMessage("ws-1", "renomeie")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });
});
