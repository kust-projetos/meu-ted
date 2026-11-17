import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch, isApiConfigured } from "../client";
import * as agentAuth from "../agent-auth";
import { sendAgentMessage } from "../agent-client";

/**
 * T2.1 — Converge browser traffic to the same-origin proxies.
 *
 * Production browsers must reach the backend via `/api/backend` and the
 * agent via `/api/agent`. Direct URLs leave the published deploy vars and
 * the explicit `NEXT_PUBLIC_*` envs become a dev/test-only escape hatch
 * (ADR-011 transient compat, ADR-015 session-first Option C).
 */

// Arbitrary production-shaped hostname: the client has no hostname
// dependency (same-origin proxy default), so no real host is needed here.
const PRODUCTION_HOST = "pwa.example";
const originalLocation = window.location;

function stubHostname(hostname: string): void {
  Object.defineProperty(window, "location", {
    value: { ...originalLocation, hostname, origin: `https://${hostname}` },
    writable: true,
    configurable: true,
  });
}

function readWranglerVars(): Record<string, string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(dir, "../../../../wrangler.jsonc");
  const raw = fs.readFileSync(file, "utf8");
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
    } else if (char === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      withoutComments += "\n";
    } else if (char === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
    } else {
      withoutComments += char;
    }
  }
  return (JSON.parse(withoutComments.replace(/,\s*([}\]])/g, "$1")) as { vars: Record<string, string> }).vars;
}

function mockOkFetch(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T2.1 deploy config: published vars carry no direct browser URLs", () => {
  it("does not publish NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", () => {
    expect(readWranglerVars()["NEXT_PUBLIC_PI_FINANCE_API_BASE_URL"]).toBeUndefined();
  });

  it("does not publish NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", () => {
    expect(readWranglerVars()["NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL"]).toBeUndefined();
  });

  it("configures the gateway and excludes retired Agent runtime variables", () => {
    const vars = readWranglerVars();
    expect(vars["TED_OPENCODE_GATEWAY_ORIGIN"]).toBeDefined();
    expect(vars["TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS"]).toBeDefined();
    for (const name of Object.keys(vars)) {
      expect(name).not.toMatch(/^(PWA_AGENT_PROXY_ORIGIN|AGENT_ORIGIN|TED_OPENCODE_RUNTIME_|TED_OPENCODE_WORKSPACES)/);
    }
  });
});

describe("T2.1 api client: same-origin proxy is the production default", () => {
  it("uses /api/backend on the production host without env", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "");
    stubHostname(PRODUCTION_HOST);
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backend/workspaces",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(isApiConfigured()).toBe(true);
  });

  it("honors an explicitly configured env on any host (explicit override wins, SPEC §12.6)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    stubHostname(PRODUCTION_HOST);
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toBe("https://api.example.com/workspaces");
  });

  it("honors an explicit env off the production host (dev/test escape hatch)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    stubHostname("localhost");
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/workspaces",
      expect.anything(),
    );
  });

  it("defaults to the same-origin proxy off the production host without env (V4.1 SPEC §12.6)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "");
    stubHostname("localhost");
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backend/workspaces",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(isApiConfigured()).toBe(true);
  });
});

describe("T2.1 agent client: same-origin proxy is the production default", () => {
  it("defaults to /api/agent without env", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ turnId: "t1", status: "completed", output: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await sendAgentMessage("ws-1", "oi");

    expect(capturedUrl).toBe("/api/agent/agents/finance-chat-agent/ws-1/rpc/chat");
  });

  it("honors an explicitly configured agent env on any host (explicit override wins, SPEC §12.6)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubHostname(PRODUCTION_HOST);
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ turnId: "t1", status: "completed", output: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await sendAgentMessage("ws-1", "oi");

    expect(capturedUrl).toBe(
      "https://agent.example.test/agents/finance-chat-agent/ws-1/rpc/chat",
    );
  });

  it("honors an explicit agent env off the production host (dev/test escape hatch)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubHostname("localhost");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token-123");
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ turnId: "t1", status: "completed", output: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await sendAgentMessage("ws-1", "oi");

    expect(capturedUrl).toBe(
      "https://agent.example.test/agents/finance-chat-agent/ws-1/rpc/chat",
    );
  });
});

describe("T2.1 coexistence: proxy requests keep transport behavior", () => {
  it("keeps session fallback header and credentials:include through the proxy, without device header on normal calls (T2.5 session-first)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "");
    stubHostname(PRODUCTION_HOST);
    localStorage.setItem("pi-finance:session-token", "sess-abc");
    localStorage.setItem("pi-finance:token", "dev-abc");
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backend/workspaces",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sess-abc");
    // T2.5 (ADR-015 Opção C): the stored device token no longer rides normal
    // calls — scoped device flows pass it explicitly.
    expect(headers["x-device-token"]).toBeUndefined();
  });
});
