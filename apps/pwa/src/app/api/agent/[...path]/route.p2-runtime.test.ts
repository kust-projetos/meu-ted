import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

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
});
