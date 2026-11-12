import { describe, expect, it, vi } from "vitest";
import { AIChatAgent } from "agents/ai-chat-agent";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";

describe("AIChatAgent live-sync SDK contract", () => {
  it("retains hooks required by the ADR-032/C3 push-only gate", () => {
    // ADR-032/C3 — if the SDK renames/removes these hooks, review the push-only gate before updating its version.
    expect(typeof (AIChatAgent.prototype as any)._notifyStreamResuming).toBe("function");
    expect(typeof (AIChatAgent.prototype as any)._sendStreamChunks).toBe("function");
    expect(typeof AIChatAgent.prototype.onMessage).toBe("function");
    expect(typeof AIChatAgent.prototype.onConnect).toBe("function");
  });

  it("blocks inbound chat and stream hooks on a minimal DO fixture", async () => {
    const sql = Object.assign((_strings: TemplateStringsArray, ..._values: unknown[]) => [], { exec: (_query: string, ..._values: unknown[]) => [] });
    const storage = { sql, transactionSync: <T>(fn: () => T): T => fn(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    const state = {
      id: { toString: () => "test-agent" }, storage,
      blockConcurrencyWhile: <T>(fn: () => T) => fn(), acceptWebSocket: () => {}, getWebSockets: () => [], waitUntil: () => {},
    } as unknown as DurableObjectState;
    const agent = new FinanceChatAgent(state, { TED_LIVE_SYNC_ENABLED: "1" });
    const close = vi.fn();
    const send = vi.fn();
    const connection = { close, send };
    await agent.onMessage(connection as never, '{"type":"cf_agent_use_chat_request"}');
    expect(close).toHaveBeenCalledWith(1008, "inbound_not_allowed");
    expect(send).not.toHaveBeenCalled();
    (agent as any)._notifyStreamResuming(connection);
    (agent as any)._sendStreamChunks(connection, "s", "r");
    expect(send).not.toHaveBeenCalled();
  });
});
