import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, sendAgentMessage } from "../agent-client";
import * as agentAuth from "../agent-auth";

const OP = "00000000-0000-4000-8000-000000000062";
const TX = "11111111-1111-4111-8111-111111111018";
const receipt = {
  mutationId: "22222222-2222-4222-8222-222222222018",
  mutationKind: "transactions.update",
  status: "succeeded",
  affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
  operationId: OP,
  entity: { type: "transaction", id: TX },
};

const stubAuth = () => vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("connection");
const success = () => Response.json({ operationId: OP, status: "succeeded", receipt }, { status: 200 });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("transactions.update receipt binding (real PWA parsers)", () => {
  it("accepts decision only with the exact expected transaction target", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAuth();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(success());

    const decision = await decidePendingOperation("workspace-56d", OP, "confirm", {
      tool: "transactions.update",
      entityId: TX,
    });

    expect(decision.status).toBe("succeeded");
    if (decision.status === "succeeded") expect(decision.receipt.entity).toEqual({ type: "transaction", id: TX });
  });

  it.each([
    ["missing expected context", undefined],
    ["wrong target", { tool: "transactions.update", entityId: "33333333-3333-4333-8333-333333333333" }],
    ["wrong tool", { tool: "accounts.update", entityId: TX }],
  ])("rejects decision with %s", async (_label, expected) => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAuth();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(success());

    await expect(decidePendingOperation("workspace-56d", OP, "confirm", expected))
      .rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("accepts a succeeded turn bound by the actual transaction card target", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAuth();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      turnId: "turn-update",
      status: "completed",
      output: "Descrição alterada.",
      pendingOperation: {
        id: OP,
        operation: "transactions.update",
        status: "succeeded",
        presentation: {
          id: OP,
          status: "succeeded",
          tool: "transactions.update",
          title: "Alterar descrição",
          transactionTargetId: TX,
          expiresAt: "2026-10-23T12:00:00.000Z",
          warnings: [],
        },
        receipt,
      },
    }, { status: 200 }));

    const turn = await sendAgentMessage("workspace-56d", "alterar descrição", { messageId: "message-update" });
    expect(turn.pendingOperation?.status).toBe("succeeded");
    if (turn.pendingOperation?.status === "succeeded") {
      expect(turn.pendingOperation.receipt.entity).toEqual({ type: "transaction", id: TX });
    }
  });
});
