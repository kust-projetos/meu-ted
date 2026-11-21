import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const ctx = { params: Promise.resolve({ path: ["agents", "finance-chat-agent", "ws-1", "rpc", "chat"] }) };
const req = (headers: Record<string, string> = {}) => new Request("https://pwa.example/api/agent/agents/ws/rpc/chat", {
  method: "POST", headers: { origin: "https://pwa.example", ...headers }, body: "{}",
});
const setGateway = () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", "https://gateway.example");
  vi.stubEnv("TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS", "https://gateway.example");
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("gateway-only agent proxy", () => {
  it("returns 503 without a configured gateway", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(req(), ctx);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("opencode_runtime_unavailable");
    expect(response.headers.get("x-ted-runtime")).toBe("opencode");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("always uses gateway, forwards only the allowlisted headers and marks response", async () => {
    setGateway();
    let target = "";
    let sent: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      target = String(input); sent = new Headers(init?.headers);
      return new Response("ok", { headers: { "x-upstream": "yes" } });
    }));
    const response = await POST(req({
      cookie: "session=1", "x-workspace-id": "ws-1", "x-device-token": "device",
      "x-forwarded-proto": "https", authorization: "discard", "x-agent-role": "admin",
    }), ctx);
    expect(response.status).toBe(200);
    expect(target).toBe("https://gateway.example/agents/finance-chat-agent/ws-1/rpc/chat");
    expect([...sent!.keys()].sort()).toEqual(["cookie", "origin", "x-device-token", "x-forwarded-proto", "x-workspace-id"]);
    expect(response.headers.get("x-ted-runtime")).toBe("opencode");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects cross-origin mutation and enforces request size before gateway lookup", async () => {
    const csrf = await POST(new Request("https://pwa.example/api/agent/x", {
      method: "POST", headers: { origin: "https://evil.example" }, body: "{}",
    }), ctx);
    expect(csrf.status).toBe(403);
    setGateway();
    const large = new Request("https://pwa.example/api/agent/x", {
      method: "POST", headers: { origin: "https://pwa.example", "content-length": "2097153" }, body: "{}",
    });
    expect((await POST(large, ctx)).status).toBe(413);
  });

  it("strips legacy ted-runtime-conversation=agent pins while keeping session cookies and returning new B cookie", async () => {
    setGateway();
    let forwardedCookie: string | null = null;
    const bSetCookie = "ted-runtime-conversation=opencode.11111111-1111-4111-8111-111111111111; Path=/api/agent/agents/finance-chat-agent/ws-1/rpc; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure";
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedCookie = new Headers(init?.headers).get("cookie");
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": bSetCookie },
      });
    }));

    const historyReq = new Request("https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/history", {
      method: "GET",
      headers: { cookie: "better-auth.session_token=tok; ted-runtime-conversation=agent" },
    });
    const historyRes = await GET(historyReq, { params: Promise.resolve({ path: ["agents", "finance-chat-agent", "ws-1", "rpc", "history"] }) });
    expect(historyRes.status).toBe(200);
    expect(forwardedCookie).toBe("better-auth.session_token=tok");
    expect(historyRes.headers.get("set-cookie")).toBe(bSetCookie);

    const chatRes = await POST(req({ cookie: 'ted-runtime-conversation="agent"; other=1' }), ctx);
    expect(chatRes.status).toBe(200);
    expect(forwardedCookie).toBe("other=1");
  });

  it("omits the cookie header completely when only legacy ted-runtime-conversation=agent was sent", async () => {
    setGateway();
    let sentHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ code: "auth.session_required" }), { status: 401 });
    }));

    const res = await POST(req({ cookie: "ted-runtime-conversation=agent" }), ctx);
    expect(res.status).toBe(401);
    expect(sentHeaders?.has("cookie")).toBe(false);
  });

  it("preserves valid and invalid opencode pins unchanged and drops only legacy agent when both exist", async () => {
    setGateway();
    const captured: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new Headers(init?.headers).get("cookie"));
      return new Response("ok", { status: 200 });
    }));

    const validPin = "ted-runtime-conversation=opencode.11111111-1111-4111-8111-111111111111";
    await POST(req({ cookie: `session=s; ${validPin}` }), ctx);
    await POST(req({ cookie: "session=s; ted-runtime-conversation=opencode.not-a-uuid" }), ctx);
    await POST(req({ cookie: `ted-runtime-conversation=agent; session=s; ${validPin}` }), ctx);

    expect(captured).toEqual([
      `session=s; ${validPin}`,
      "session=s; ted-runtime-conversation=opencode.not-a-uuid",
      `session=s; ${validPin}`,
    ]);
  });
});
