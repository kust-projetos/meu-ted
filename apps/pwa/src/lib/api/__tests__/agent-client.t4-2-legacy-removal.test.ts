import { describe, expect, it } from "vitest";
import * as agentClient from "../agent-client";

/**
 * T4.2 (SPEC section 11 E2, ARCH-V4-06a): the PWA has zero external consumers
 * of the retired runtime. The legacy helpers were REMOVED (not re-pointed):
 * no code outside apps/agent may reference the retired routes/symbols.
 *
 * Chat/history flows use the canonical FinanceChatAgent routes
 * (/agents/finance-chat-agent/:ws/rpc/chat, /rpc/history) — covered by
 * agent-client.test.ts. This file locks the removal contract.
 */
describe("T4.2 retired-runtime surface removal (ARCH-V4-06a)", () => {
  it("does not export any retired-runtime helper", () => {
    const removed = [
      "exportAgentHistory",
      "deleteAgentHistory",
      "fetchAgentAccessLog",
      "cancelAgentTurn",
      "streamAgentTurn",
      "reconnectAgentTurn",
    ];
    for (const name of removed) {
      expect(agentClient as Record<string, unknown>).not.toHaveProperty(name);
    }
  });

  it("does not export legacy history DTO types/schemas", () => {
    expect(agentClient as Record<string, unknown>).not.toHaveProperty("AgentHistoryExport");
    expect(agentClient as Record<string, unknown>).not.toHaveProperty("DeleteAgentHistoryResult");
    expect(agentClient as Record<string, unknown>).not.toHaveProperty("AgentAccessLog");
    expect(agentClient as Record<string, unknown>).not.toHaveProperty("AgentEvent");
  });

  it("keeps the canonical FinanceChatAgent surface intact", () => {
    for (const name of [
      "sendAgentMessage",
      "fetchAgentHistory",
      "renewAgentSession",
    ]) {
      expect(typeof (agentClient as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
