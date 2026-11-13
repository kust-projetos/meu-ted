/// <reference types="@cloudflare/vitest-plugin/types" />
// Opens the DO directly without Worker auth (covered in worker-live-upgrade.test.ts).
// TTL behavior is the residual covered in live-delivery.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type AgentEnv = {
  FINANCE_CHAT_AGENT: DurableObjectNamespace;
};

const frame = (visibility: "private" | "workspace", ownerActorId?: string) =>
  JSON.stringify({
    type: "chat",
    messages: [{ metadata: { workspaceId: "ws", visibility, ...(ownerActorId ? { ownerActorId } : {}) } }],
  });
const chatFrames = (frames: string[]) => frames.filter((value) => {
  try { return Array.isArray(JSON.parse(value).messages); } catch { return false; }
});

describe("workerd live delivery", () => {
  it("delivers real DO broadcast frames only to permitted WebSockets", async () => {
    const agentEnv = env as unknown as AgentEnv;
    const stub = agentEnv.FINANCE_CHAT_AGENT.get(agentEnv.FINANCE_CHAT_AGENT.idFromName("ws"));
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const open = async (actor: string, received: string[]) => {
      const response = await stub.fetch("https://do/live", {
        headers: {
          Upgrade: "websocket",
          "x-partykit-room": "ws",
          "x-agent-actor": actor,
          "x-agent-workspace": "ws",
          "x-agent-role": "member",
        },
      });
      expect(response.status).toBe(101);
      const socket = (response as Response & { webSocket: WebSocket & { accept(): void } }).webSocket;
      socket.accept();
      socket.addEventListener("message", (event: MessageEvent) => { received.push(String(event.data)); });
      return socket;
    };

    const socketA = await open("A", receivedA);
    const socketB = await open("B", receivedB);
    try {
      await runInDurableObject(stub, (instance) => instance.broadcast(frame("private", "A")));
      expect(chatFrames(receivedA)).toEqual([frame("private", "A")]);
      expect(chatFrames(receivedB)).toEqual([]);

      await runInDurableObject(stub, (instance) => instance.broadcast(frame("workspace")));
      expect(chatFrames(receivedA)).toEqual([frame("private", "A"), frame("workspace")]);
      expect(chatFrames(receivedB)).toEqual([frame("workspace")]);

      const previousA = chatFrames(receivedA).length;
      const previousB = chatFrames(receivedB).length;
      await runInDurableObject(stub, (instance) => instance.broadcast(JSON.stringify({ type: "chat" })));
      expect(chatFrames(receivedA)).toHaveLength(previousA);
      expect(chatFrames(receivedB)).toHaveLength(previousB);

      await runInDurableObject(stub, (instance) => instance.broadcast(frame("workspace")));
      expect(chatFrames(receivedA)).toHaveLength(previousA + 1);
      expect(chatFrames(receivedB)).toHaveLength(previousB + 1);
    } finally {
      socketA.close();
      socketB.close();
    }
  });
});
