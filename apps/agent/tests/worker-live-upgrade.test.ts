import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { createAgentConnectionToken } from "../../api/src/auth/agent-connection-token.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const secret = "secret-for-testing-purposes-at-least-32-chars!";
const alias = "workspace-alias";
const canonical = "00000000-0000-4000-8000-000000000001";

afterEach(() => vi.restoreAllMocks());

describe("live-sync websocket upgrade", () => {
  it("gates flag, origin, authorization and stamps only authorized headers", async () => {
    const token = await createAgentConnectionToken({ sub: "verified-actor", workspace: canonical, role: "owner" }, secret);
    const doFetch = vi.fn(async (request: Request) => new Response(null, { status: 200, headers: { "x-seen-upgrade": request.headers.get("upgrade") ?? "" } }));
    const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName, get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example",
      AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    const call = (headers: HeadersInit = {}, enabled?: string) => worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, { headers: { origin: "https://pwa.example", upgrade: "WebSocket", "x-agent-connection-token": token, ...headers } }), { ...env, TED_LIVE_SYNC_ENABLED: enabled } as WorkerEnv);
    expect((await call({}, "0")).status).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
    expect((await call({ origin: "https://evil.example" }, "1")).status).toBe(403);
    expect(doFetch).not.toHaveBeenCalled();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/internal/workspace-alias/")) return Response.json({ canonicalHouseholdId: canonical });
      if (url.includes("/internal/agent/consume-token")) return Response.json({ ok: true, consumed: true });
      return new Response("unexpected", { status: 500 });
    });
    const response = await call({ cookie: "session=secret", authorization: "Bearer forged", "x-agent-actor": "forged", "x-agent-role": "member", "x-agent-workspace": "forged", "x-agent-device": "forged" }, "1");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-seen-upgrade")).toBe("WebSocket");
    expect(doFetch).toHaveBeenCalledOnce();
    const forwarded = doFetch.mock.calls[0]![0];
    for (const key of ["cookie", "authorization", "x-agent-connection-token"]) expect(forwarded.headers.has(key)).toBe(false);
    expect(forwarded.headers.get("x-agent-actor")).toBe("verified-actor");
    expect(forwarded.headers.get("x-agent-workspace")).toBe(canonical);
    expect(forwarded.headers.get("x-agent-role")).toBe("owner");
    expect(forwarded.headers.get("x-partykit-room")).toBe(canonical);
    expect(forwarded.headers.has("x-agent-device")).toBe(false);
    expect(idFromName).toHaveBeenCalledWith(canonical);
  });

  it("returns authorization failure without forwarding when token is absent", async () => {
    const doFetch = vi.fn();
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: () => ({} as DurableObjectId), get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example", TED_LIVE_SYNC_ENABLED: "1",
      AGENT_CONNECTION_TOKEN_SECRET: secret,
      AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ canonicalHouseholdId: canonical }));
    const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, { headers: { origin: "https://pwa.example", upgrade: "websocket", "x-agent-connection-token": "invalid-token" } }), env);
    expect([401, 403]).toContain(response.status);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
