import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchActiveUndoProposals, sendAgentMessage } from "../agent-client";
import * as agentAuth from "../agent-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const TARGET = {
  kind: "Despesa",
  description: "Mercado",
  amountCents: 85000,
  accountLabel: "Nubank",
  occurredOn: "2026-09-14",
};

function mockTurnFetch(body: unknown) {
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

describe("FIX-P1-UX #172: display-safe undo target transport (additive, fail-closed)", () => {
  it("active list preserves an allowlisted display-safe target", async () => {
    mockTurnFetch({
      items: [
        { requestId: "proposal-1", status: "proposed", expiresAt: "2099-01-01T12:00:00Z", target: TARGET },
      ],
      total: 1,
    });

    await expect(fetchActiveUndoProposals("workspace-123")).resolves.toEqual([
      { requestId: "proposal-1", status: "proposed", expiresAt: "2099-01-01T12:00:00Z", target: TARGET },
    ]);
  });

  it("active list without a target still parses (backward compatible legacy shape)", async () => {
    mockTurnFetch({
      items: [{ requestId: "proposal-1", status: "proposed", expiresAt: "2099-01-01T12:00:00Z" }],
      total: 1,
    });

    await expect(fetchActiveUndoProposals("workspace-123")).resolves.toEqual([
      { requestId: "proposal-1", status: "proposed", expiresAt: "2099-01-01T12:00:00Z" },
    ]);
  });

  it("active list rejects a target smuggling key material wholesale", async () => {
    mockTurnFetch({
      items: [
        {
          requestId: "proposal-1",
          status: "proposed",
          expiresAt: "2099-01-01T12:00:00Z",
          target: { description: "Mercado", targetLastOperationId: "audit-op-1" },
        },
      ],
      total: 1,
    });

    await expect(fetchActiveUndoProposals("workspace-123")).rejects.toThrow();
  });

  it("turn path preserves an allowlisted display-safe target", async () => {
    mockTurnFetch({
      turnId: "turn-1",
      status: "completed",
      output: "Encontrei a última ação para desfazer.",
      undoProposal: {
        requestId: "proposal-1",
        status: "proposed",
        expiresAt: "2099-01-01T12:00:00Z",
        target: TARGET,
      },
    });

    const turn = await sendAgentMessage("workspace-123", "desfaz o último");
    expect(turn.undoProposal).toEqual({
      requestId: "proposal-1",
      status: "proposed",
      expiresAt: "2099-01-01T12:00:00Z",
      target: TARGET,
    });
  });

  it("turn path without a target keeps the legacy shape", async () => {
    mockTurnFetch({
      turnId: "turn-1",
      status: "completed",
      output: "Encontrei a última ação para desfazer.",
      undoProposal: { requestId: "proposal-1", status: "proposed", expiresAt: "2099-01-01T12:00:00Z" },
    });

    const turn = await sendAgentMessage("workspace-123", "desfaz o último");
    expect(turn.undoProposal).toEqual({
      requestId: "proposal-1",
      status: "proposed",
      expiresAt: "2099-01-01T12:00:00Z",
    });
  });
});
