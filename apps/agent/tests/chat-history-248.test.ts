import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "agents/ai-chat-agent";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";
import { attachRelayUsageStorage } from "./helpers/relay-usage-storage.js";

const createTestAgent = () => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (msgs: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });
  Object.defineProperty(agent, "state", {
    value: { storage: {} },
    writable: true,
    configurable: true,
  });
  attachRelayUsageStorage(agent);
  Object.defineProperty(agent, "env", {
    value: {
      API_ORIGIN: "https://api.test.local",
      AGENT_DELEGATION_SECRET: "agent-test-secret-248",
    },
    writable: true,
    configurable: true,
  });
  return { agent, persisted };
};

describe("issue #248 failed turn persists assistant error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists one assistant error bubble on failure", async () => {
    const { agent, persisted } = createTestAgent();
    (agent as unknown as { orchestratorForChannel: () => unknown }).orchestratorForChannel = () => ({ runTurn: async () => { throw Object.assign(new Error("boom"), { status: 500, code: "agent.inference_error" }); } }) as never;
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-actor": "actor-248",
          "x-agent-workspace": "workspace-248",
        },
        body: JSON.stringify({ text: "qual o saldo?", intentionId: "intent-248-a" }),
      }),
    );
    expect(res.status).not.toBe(200);
    expect(persisted.filter((m) => m.role === "assistant")).toHaveLength(1);
    const asst = persisted.find((m) => m.role === "assistant");
    expect(asst?.id).toBe("msg-asst-intent-248-a");
    expect(asst?.parts?.[0]?.text).toContain("Tente novamente.");
    expect(persisted.filter((m) => m.role === "user")).toHaveLength(1);
    expect(agent.persistMessages).toHaveBeenCalledTimes(1);
    expect(agent.persistMessages).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "msg-user-intent-248-a", role: "user" }),
      expect.objectContaining({ id: "msg-asst-intent-248-a", role: "assistant" }),
    ]));
  });

  it("does not persist an orphan question when the pair write rejects", async () => {
    const { agent, persisted } = createTestAgent();
    agent.persistMessages = vi.fn(async () => { throw Object.assign(new Error("write failed"), { code: "agent.persistence_unavailable", status: 503 }); });
    (agent as unknown as { orchestratorForChannel: () => unknown }).orchestratorForChannel = () => ({ runTurn: async () => { throw Object.assign(new Error("boom"), { status: 500, code: "agent.inference_error" }); } }) as never;
    await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-actor": "actor-248",
          "x-agent-workspace": "workspace-248",
        },
        body: JSON.stringify({ text: "qual o saldo?", intentionId: "intent-248-fault" }),
      }),
    );
    expect(agent.persistMessages).toHaveBeenCalledTimes(1);
    expect(agent.persistMessages).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "msg-user-intent-248-fault", role: "user" }),
      expect.objectContaining({ id: "msg-asst-intent-248-fault", role: "assistant" }),
    ]));
    expect(persisted).toHaveLength(0);
  });

  it("is idempotent on redelivery", async () => {
    const { agent, persisted } = createTestAgent();
    (agent as unknown as { orchestratorForChannel: () => unknown }).orchestratorForChannel = () => ({ runTurn: async () => { throw Object.assign(new Error("boom"), { status: 500, code: "agent.inference_error" }); } }) as never;
    const makeReq = () => new Request("https://agent.test.local/rpc/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-actor": "actor-248",
        "x-agent-workspace": "workspace-248",
      },
      body: JSON.stringify({ text: "qual o saldo?", intentionId: "intent-248-b" }),
    });
    await agent.fetch(makeReq());
    const countAfterFirst = persisted.filter((m) => m.role === "assistant").length;
    await agent.fetch(makeReq());
    const countAfterSecond = persisted.filter((m) => m.role === "assistant").length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
