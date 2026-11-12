import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { createAgentConnectionToken } from "../../api/src/auth/agent-connection-token.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

afterEach(() => vi.restoreAllMocks());

describe("worker live-sync surface", () => {
  it("denies SDK live-sync paths for distinct actors while preserving RPC forwarding", async () => {
    const secret = "secret-for-testing-purposes-at-least-32-chars!";
    const workspace = "00000000-0000-4000-8000-000000000001";
    const actors = ["actor-one", "actor-two"];
    const tokens = await Promise.all(actors.map((sub) => createAgentConnectionToken(
      { sub, workspace, role: "owner" },
      secret,
    )));
    const mockDoFetch = vi.fn(async () => new Response("do", { status: 200 }));
    const mockEnv: WorkerEnv = {
      FINANCE_CHAT_AGENT: {
        idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
        get: vi.fn(() => ({
          importLegacyHistory: vi.fn(async () => ({ success: true, importedCount: 0, skipped: true })),
          fetch: mockDoFetch,
        })),
      },
      API_ORIGIN: "https://api.test.local",
      AGENT_CONNECTION_TOKEN_SECRET: secret,
      AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/internal/workspace-alias/")) {
        return new Response(JSON.stringify({ canonicalHouseholdId: workspace }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/internal/agent/consume-token")) {
        return new Response(JSON.stringify({ ok: true, consumed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected upstream", { status: 500 });
    });

    const paths = ["ws", "get-messages", "sync", "stream", "websocket"];
    for (const token of tokens) {
      for (const path of paths) {
        const headers = new Headers({
          "x-agent-connection-token": token,
          origin: "https://pwa.example",
        });
        if (path === "ws") {
          headers.set("Upgrade", "websocket");
          headers.set("Connection", "Upgrade");
        }
        const response = await worker.fetch(
          new Request(`https://agent.test.local/agents/finance-chat-agent/${workspace}/${path}`, { headers }),
          mockEnv,
        );
        expect(response.status, `${actors[tokens.indexOf(token)]} /${path}`).toBe(404);
        expect(mockDoFetch).not.toHaveBeenCalled();
      }
    }

    const rpc = await worker.fetch(
      new Request(`https://agent.test.local/agents/finance-chat-agent/${workspace}/rpc/history`, {
        headers: { "x-agent-connection-token": tokens[0]!, origin: "https://pwa.example" },
      }),
      mockEnv,
    );
    expect(rpc.status).toBe(200);
    expect(mockDoFetch).toHaveBeenCalledTimes(1);
  });
});
