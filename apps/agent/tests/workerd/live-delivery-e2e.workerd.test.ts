/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createAgentConnectionToken } from "../../../api/src/auth/agent-connection-token.js";
import worker from "../../src/worker.js";

const SECRET = "test-agent-connection-secret-32-chars";
const WORKSPACE = "ws";

type AgentEnv = {
  FINANCE_CHAT_AGENT: DurableObjectNamespace;
  API_ORIGIN: string;
};

const frame = (visibility: "private" | "workspace", ownerActorId?: string) =>
  JSON.stringify({
    type: "chat",
    messages: [{ metadata: { workspaceId: WORKSPACE, visibility, ...(ownerActorId ? { ownerActorId } : {}) } }],
  });
const chatFrames = (frames: string[]) => frames.filter((value) => {
  try { return Array.isArray(JSON.parse(value).messages); } catch { return false; }
});

describe("workerd Worker-to-DO live delivery", () => {
  it("authenticates Worker upgrades and delivers private and workspace frames", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === `/internal/workspace-alias/${WORKSPACE}`) {
        return Response.json({ canonicalHouseholdId: WORKSPACE });
      }
      if (url.pathname === "/internal/agent/consume-token") return new Response(null, { status: 200 });
      throw new Error(`Unexpected API request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const agentEnv = env as unknown as AgentEnv;
    const stub = agentEnv.FINANCE_CHAT_AGENT.get(agentEnv.FINANCE_CHAT_AGENT.idFromName(WORKSPACE));
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const open = async (actor: string, received: string[]) => {
      const token = await createAgentConnectionToken({
        sub: actor,
        workspace: WORKSPACE,
        role: "member",
        jti: `e2e-${actor}-${crypto.randomUUID()}`,
      }, SECRET);
      const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${WORKSPACE}/live`, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://pwa.example",
          "Sec-WebSocket-Protocol": `ted.v1, bearer.${token}`,
          "x-agent-actor": "forged-actor",
          "x-agent-workspace": "forged-workspace",
          "x-agent-role": "owner",
        },
      }), env as never);
      expect(response.status).toBe(101);
      expect(response.headers.get("sec-websocket-protocol")).toBe("ted.v1");
      const socket = (response as Response & { webSocket: WebSocket & { accept(): void } }).webSocket;
      expect(socket).toBeDefined();
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
    } finally {
      socketA.close();
      socketB.close();
      vi.unstubAllGlobals();
    }
  });

  it("rejects missing/invalid tokens and disallowed origins before upgrading", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const base = `https://agent.test.local/agents/finance-chat-agent/${WORKSPACE}/live`;
      const absent = await worker.fetch(new Request(base, {
        headers: { Upgrade: "websocket", Origin: "https://pwa.example" },
      }), env as never);
      expect(absent.status).not.toBe(101);

      const invalid = await worker.fetch(new Request(base, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://pwa.example",
          "Sec-WebSocket-Protocol": "ted.v1, bearer.invalid",
        },
      }), env as never);
      expect(invalid.status).not.toBe(101);

      const badOrigin = await worker.fetch(new Request(base, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://attacker.example",
          "Sec-WebSocket-Protocol": "ted.v1, bearer.invalid",
        },
      }), env as never);
      expect(badOrigin.status).toBe(403);
      expect(fetchMock.mock.calls.every(([input]) =>
        String(input).includes("/internal/workspace-alias/"),
      )).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
