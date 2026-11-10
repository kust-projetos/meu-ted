import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { EXPECTED_AGENT_ORIGIN } from "@/proxy-utils";
import { GET, POST } from "./route";

const B_UUID = "123e4567-e89b-12d3-a456-426614174000";
const B_PIN = `ted-runtime-conversation=opencode.${B_UUID}`;
const GATEWAY = "http://127.0.0.1:8787";

function chatContext(ws = "ws-1") {
  return { params: Promise.resolve({ path: ["agents", "finance-chat-agent", ws, "rpc", "chat"] }) };
}

function sessionNewContext(ws = "ws-1") {
  return {
    params: Promise.resolve({ path: ["agents", "finance-chat-agent", ws, "rpc", "session", "new"] }),
  };
}

function pendingContext(ws = "ws-1") {
  return {
    params: Promise.resolve({
      path: ["agents", "finance-chat-agent", ws, "rpc", "pending-operations", "active"],
    }),
  };
}

function setCookiesOf(res: Response): string[] {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(res.headers);
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

describe("P2 runtime routing — gateway absent keeps the frozen A0 path", () => {
  beforeEach(() => {
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("gateway absent + no pin: A0 exact, no pin cookie is set", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": "ws-1" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(captured!.url.startsWith("https://agent.example")).toBe(true);
    expect(setCookiesOf(res).some((c) => c.includes("ted-runtime-conversation"))).toBe(false);
  });

  it("gateway absent + no pin: legacy frozen path sets no x-ted-runtime header", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": "ws-1" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ted-runtime")).toBeNull();
  });

  it("gateway absent + no pin: a client-sent x-device-token is still stripped on A0", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-id": "ws-1",
        "x-agent-connection-token": "conn-1",
        "x-device-token": "dev-should-not-forward",
      },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(captured!.headers.get("x-agent-connection-token")).toBe("conn-1");
    expect(captured!.headers.get("x-device-token")).toBeNull();
    expect(setCookiesOf(res).some((c) => c.includes("ted-runtime-conversation"))).toBe(false);
  });

  it("gateway absent + B pin: fail-closed 503, upstream never called (no A0 fallback)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B_PIN },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "opencode_runtime_unavailable",
    );
  });

  it("flag ON + no pin + missing gateway: fail-closed 503, upstream never called (never A0)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "opencode_runtime_unavailable",
    );
  });

  it("flag ON + no pin + invalid gateway: fail-closed 503, upstream never called (never A0)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", "https://gateway.attacker.example");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "opencode_runtime_unavailable",
    );
  });
});

describe("P2 runtime routing — gateway configured (development/test)", () => {
  beforeEach(() => {
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("flag OFF + no pin: A0 with a scoped HttpOnly agent pin (no Secure on http)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input).startsWith("https://agent.example")).toBe(true);
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": "ws-1" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    const pins = setCookiesOf(res).filter((c) => c.includes("ted-runtime-conversation=agent"));
    expect(pins.length).toBe(1);
    expect(pins[0]).toContain("Path=/api/agent/agents/finance-chat-agent/ws-1/rpc");
    expect(pins[0]).toContain("HttpOnly");
    expect(pins[0]).toContain("SameSite=Lax");
    expect(pins[0]).toContain("Max-Age=2592000");
    expect(pins[0]).not.toContain("Secure");
  });

  it("pinless flag OFF + gateway configured chat carries agent + A0 pin", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": "ws-1" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ted-runtime")).toBe("agent");
    expect(setCookiesOf(res).some((c) => c.includes("ted-runtime-conversation=agent"))).toBe(true);
  });

  it("flag ON + no pin + session/new: B gateway with device token only (no connection token, no authorization)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(
        JSON.stringify({ ok: true, sessionId: B_UUID, previousSessionId: null, messageCount: 0, summarized: false }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `${B_PIN}; Path=/api/agent/agents/finance-chat-agent/ws-1/rpc; Max-Age=2592000; HttpOnly; SameSite=Lax`,
          },
        },
      );
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/session/new", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=abc",
        "x-workspace-id": "ws-1",
        "x-agent-connection-token": "conn-must-not-forward",
        authorization: "Bearer must-not-forward",
        "x-device-token": "dev-123",
      },
      body: JSON.stringify({}),
    });
    const res = await POST(req, sessionNewContext());
    expect(res.status).toBe(200);
    expect(captured!.url.startsWith(GATEWAY)).toBe(true);
    expect(captured!.headers.get("cookie")).toContain("better-auth.session_token=abc");
    expect(captured!.headers.get("x-workspace-id")).toBe("ws-1");
    expect(captured!.headers.get("x-device-token")).toBe("dev-123");
    expect(captured!.headers.get("x-agent-connection-token")).toBeNull();
    expect(captured!.headers.get("authorization")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(setCookiesOf(res).some((c) => c.includes(`opencode.${B_UUID}`))).toBe(true);
  });

  it("B chat 200 carries x-ted-runtime: opencode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B_PIN, "x-device-token": "dev-1" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ted-runtime")).toBe("opencode");
  });

  it("B history error still reveals opencode (first B history load reveals the runtime)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ code: "gateway.invalid_args", message: "conversation cookie is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const historyReq = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/history", {
      method: "GET",
      headers: { cookie: B_PIN },
    });
    const res = await GET(historyReq, {
      params: Promise.resolve({ path: ["agents", "finance-chat-agent", "ws-1", "rpc", "history"] }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-ted-runtime")).toBe("opencode");
  });

  it("B 401 carries opencode with no A0 fallback", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ code: "auth.device_required", message: "denied" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B_PIN },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.get("x-ted-runtime")).toBe("opencode");
  });

  it("A0 pin + flag ON chat carries x-ted-runtime: agent", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request(
      "http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/history",
      { method: "GET", headers: { cookie: "ted-runtime-conversation=agent" } },
    );
    const res = await GET(req, {
      params: Promise.resolve({ path: ["agents", "finance-chat-agent", "ws-1", "rpc", "history"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ted-runtime")).toBe("agent");
  });

  it("non-P2 with gateway configured carries no runtime header (P2-only seam)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request(
      "http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/pending-operations/active",
      { method: "GET", headers: { "x-workspace-id": "ws-1" } },
    );
    const res = await GET(req, pendingContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ted-runtime")).toBeNull();
  });

  it("B pin stays on B with the flag OFF", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    let seen = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B_PIN, "x-device-token": "dev-1" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(seen.startsWith(GATEWAY)).toBe(true);
  });

  it("A0 pin stays on A0 with the flag ON (no B cookie is minted)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    let seen = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request(
      "http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/history",
      { method: "GET", headers: { cookie: "ted-runtime-conversation=agent" } },
    );
    const res = await GET(req, {
      params: Promise.resolve({ path: ["agents", "finance-chat-agent", "ws-1", "rpc", "history"] }),
    });
    expect(res.status).toBe(200);
    expect(seen.startsWith("https://agent.example")).toBe(true);
    expect(setCookiesOf(res).some((c) => c.includes("opencode."))).toBe(false);
  });

  it("non-P2 operations stay on A0 with the flag ON (no conversational turn to B)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    let seen = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request(
      "http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/pending-operations/active",
      { method: "GET", headers: { "x-workspace-id": "ws-1" } },
    );
    const res = await GET(req, pendingContext());
    expect(res.status).toBe(200);
    expect(seen.startsWith("https://agent.example")).toBe(true);
  });

  it("session/new with the flag OFF stays on A0 (and pins A0)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", GATEWAY);
    let seen = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen = String(input);
      return new Response(
        JSON.stringify({ ok: true, sessionId: "s-1", previousSessionId: null, messageCount: 0, summarized: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/session/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req, sessionNewContext());
    expect(res.status).toBe(200);
    expect(seen.startsWith("https://agent.example")).toBe(true);
    expect(setCookiesOf(res).some((c) => c.includes("ted-runtime-conversation=agent"))).toBe(true);
  });

  it("B pin + external (non-loopback) gateway origin: fail-closed 503, upstream never called", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", "https://gateway.attacker.example");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const req = new Request("http://localhost:3000/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B_PIN },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("P2 runtime routing — production never touches the local runtime", () => {
  beforeEach(() => {
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("production without a B pin: A0 exact, no local pin cookies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PWA_AGENT_PROXY_ORIGIN", EXPECTED_AGENT_ORIGIN);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pwa.example" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(setCookiesOf(res).some((c) => c.includes("ted-runtime-conversation"))).toBe(false);
  });

  it("production with the flag set and no gateway: fail-closed 503 (never silently A0)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PWA_AGENT_PROXY_ORIGIN", EXPECTED_AGENT_ORIGIN);
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pwa.example" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("production + flag + allowlisted HTTPS gateway: routes to the gateway (canary)", async () => {
    const gateway = "https://ted-gateway.synkroo.com.br";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PWA_AGENT_PROXY_ORIGIN", EXPECTED_AGENT_ORIGIN);
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", gateway);
    vi.stubEnv("TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS", gateway);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input).startsWith(gateway)).toBe(true);
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "ted-runtime-conversation=opencode.11111111-1111-4111-8111-111111111111; Path=/; HttpOnly",
        },
      });
    });
    const req = new Request("https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pwa.example" },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.get("x-ted-runtime")).toBe("opencode");
    expect(setCookiesOf(res).some((c) => c.includes("ted-runtime-conversation=opencode."))).toBe(true);
  });

  it("kill switch: an opencode.* pin goes back to A0 and the pin is expired", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PWA_AGENT_PROXY_ORIGIN", EXPECTED_AGENT_ORIGIN);
    vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
    vi.stubEnv("TED_OPENCODE_WORKSPACES", "ws-1");
    vi.stubEnv("TED_OPENCODE_RUNTIME_KILL_SWITCH", "1");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", "https://ted-gateway.synkroo.com.br");
    vi.stubEnv("TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS", "https://ted-gateway.synkroo.com.br");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input).startsWith(EXPECTED_AGENT_ORIGIN)).toBe(true);
      return new Response(JSON.stringify({ turnId: "t", status: "completed", output: "oi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const req = new Request("https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pwa.example", cookie: B_PIN },
      body: JSON.stringify({ text: "oi" }),
    });
    const res = await POST(req, chatContext());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setCookiesOf(res).some((c) => c.startsWith("ted-runtime-conversation=;"))).toBe(true);
    expect(res.headers.get("x-ted-runtime")).toBe("agent");
  });
});
