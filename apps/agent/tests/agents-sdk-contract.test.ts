import { describe, expect, it } from "vitest";
import { AIChatAgent } from "agents/ai-chat-agent";

describe("AIChatAgent live-sync SDK contract", () => {
  it("retains hooks required by the ADR-032/C3 push-only gate", () => {
    // ADR-032/C3 — if the SDK renames/removes these hooks, review the push-only gate before updating its version.
    expect(typeof (AIChatAgent.prototype as any)._notifyStreamResuming).toBe("function");
    expect(typeof (AIChatAgent.prototype as any)._sendStreamChunks).toBe("function");
    expect(typeof AIChatAgent.prototype.onMessage).toBe("function");
    expect(typeof AIChatAgent.prototype.onConnect).toBe("function");
  });
});
