import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stateful device-store double: `fetchAgentConnectionToken` simulates the
// real mint self-heal by persisting the fresh device token when awaited, so
// tests can prove the client reads the device token AFTER the mint
// completed (same first request) instead of snapshotting headers beforehand.
const deviceState = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../agent-auth", () => ({
  fetchAgentConnectionToken: vi.fn(async () => {
    // Simulated self-heal persistence finishing during the mint — exactly
    // like the real `readDeviceToken() ?? await ensureDeviceToken()`: it
    // registers ONLY when the store is empty, never overwriting a device
    // that is already registered.
    if (deviceState.current === null) {
      deviceState.current = "dev-fresh-from-self-heal";
    }
    return "conn-1";
  }),
  clearAgentConnectionTokenCache: vi.fn(),
  getActiveDeviceToken: vi.fn(() => deviceState.current),
  trackAgentConnection: vi.fn((_external?: AbortSignal | null) => {
    const controller = new AbortController();
    if (_external) {
      if (_external.aborted) controller.abort();
      else _external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return { signal: controller.signal, release: () => undefined };
  }),
}));

import * as agentAuth from "../agent-auth";
import { fetchAgentHistory, renewAgentSession, sendAgentMessage } from "../agent-client";
import {
  clearTedRuntimeViews,
  getTedRuntimeView,
  noteTedRuntimeView,
} from "../ted-runtime-view";

type Captured = { url: string; init: RequestInit };

let calls: Captured[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockFetchJson(payload: unknown, status = 200, headers?: Record<string, string>): void {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
    });
  });
}

function headersOf(call: Captured): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  calls = [];
  deviceState.current = null;
  clearTedRuntimeViews();
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

describe("P2 client — scoped device header and AbortSignal", () => {
  it("sendAgentMessage carries x-device-token with an unchanged {text, intentionId} DTO", async () => {
    deviceState.current = "dev-123";
    mockFetchJson({ turnId: "t-1", status: "completed", output: "ok" });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-1" });
    expect(calls.length).toBe(1);
    const headers = headersOf(calls[0]);
    expect(headers["x-device-token"]).toBe("dev-123");
    expect(headers["x-agent-connection-token"]).toBe("conn-1");
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["intentionId", "text"]);
    expect(payload.text).toBe("oi");
    expect(payload.intentionId).toBe("m-1");
  });

  it("empty device store: self-heal finishes during mint, same first request carries the fresh device token", async () => {
    // Store starts empty (fresh session, no registered device yet).
    deviceState.current = null;
    mockFetchJson({ turnId: "t-heal", status: "completed", output: "ok" });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-heal" });
    expect(calls.length).toBe(1);
    // The mint self-heal persisted during the call; the outgoing request must
    // carry THAT fresh token — read after the mint, not snapshotted before it.
    expect(deviceState.current).toBe("dev-fresh-from-self-heal");
    expect(headersOf(calls[0])["x-device-token"]).toBe("dev-fresh-from-self-heal");
  });

  it("direct external/dev base URL never receives x-device-token (same-origin proxy only)", async () => {
    deviceState.current = "dev-123";
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.direct.example");
    mockFetchJson({ turnId: "t-ext", status: "completed", output: "ok" });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-ext" });
    expect(calls.length).toBe(1);
    expect(calls[0].url.startsWith("https://agent.direct.example")).toBe(true);
    expect(headersOf(calls[0])["x-device-token"]).toBeUndefined();
    expect(headersOf(calls[0])["x-agent-connection-token"]).toBe("conn-1");
  });

  it("direct external response header never confirms a runtime (same-origin proxy is the only authority)", async () => {
    deviceState.current = "dev-123";
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.direct.example");
    mockFetchJson({ turnId: "t-ext", status: "completed", output: "ok" }, 200, {
      "x-ted-runtime": "opencode",
    });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-ext-hdr" });
    expect(calls[0].url.startsWith("https://agent.direct.example")).toBe(true);
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
    // A previously confirmed view is never overwritten by a foreign header.
    noteTedRuntimeView("ws-1", "agent");
    await sendAgentMessage("ws-1", "oi", { messageId: "m-ext-hdr2" });
    expect(getTedRuntimeView("ws-1")).toBe("agent");
  });

  it("sendAgentMessage accepts an optional AbortSignal and links it to the flight", async () => {
    deviceState.current = "dev-123";
    mockFetchJson({ turnId: "t-2", status: "completed", output: "ok" });
    const caller = new AbortController();
    await sendAgentMessage("ws-1", "oi", { messageId: "m-2", signal: caller.signal });
    const sentSignal = calls[0].init.signal as AbortSignal;
    expect(sentSignal).toBeInstanceOf(AbortSignal);
    expect(sentSignal.aborted).toBe(false);
    caller.abort();
    expect(sentSignal.aborted).toBe(true);
  });

  it("sendAgentMessage omits x-device-token when no device is registered (gateway fails closed server-side)", async () => {
    // No device before the call AND the mint heals nothing (stale session).
    deviceState.current = null;
    vi.mocked(agentAuth.fetchAgentConnectionToken).mockImplementationOnce(async () => "conn-1");
    mockFetchJson({ turnId: "t-3", status: "completed", output: "ok" });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-3" });
    expect(headersOf(calls[0])["x-device-token"]).toBeUndefined();
  });

  it("fetchAgentHistory carries the scoped x-device-token", async () => {
    deviceState.current = "dev-123";
    mockFetchJson({ items: [], total: 0 });
    await fetchAgentHistory("ws-1");
    expect(headersOf(calls[0])["x-device-token"]).toBe("dev-123");
    expect(headersOf(calls[0])["X-Workspace-Id"]).toBe("ws-1");
  });

  it("renewAgentSession carries the scoped x-device-token with an empty body by default", async () => {
    deviceState.current = "dev-123";
    mockFetchJson({ ok: true, sessionId: "s-1", previousSessionId: null, messageCount: 0, summarized: false });
    await renewAgentSession("ws-1");
    expect(headersOf(calls[0])["x-device-token"]).toBe("dev-123");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
  });

  it("sendAgentMessage captures x-ted-runtime: opencode into the workspace view", async () => {
    deviceState.current = "dev-123";
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
    mockFetchJson({ turnId: "t-v", status: "completed", output: "ok" }, 200, {
      "x-ted-runtime": "opencode",
    });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-v" });
    expect(getTedRuntimeView("ws-1")).toBe("opencode");
  });

  it("fetchAgentHistory error with opencode header still reveals B (first B history load)", async () => {
    deviceState.current = "dev-123";
    mockFetchJson({ code: "gateway.invalid_args", message: "conversation cookie is required" }, 400, {
      "x-ted-runtime": "opencode",
    });
    await expect(fetchAgentHistory("ws-1")).rejects.toThrow();
    expect(getTedRuntimeView("ws-1")).toBe("opencode");
  });

  it("fetchAgentHistory without the header leaves the view unknown (legacy A0 byte-identical)", async () => {
    deviceState.current = "dev-123";
    mockFetchJson({ items: [], total: 0 });
    await fetchAgentHistory("ws-1");
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
  });

  it("renewAgentSession success resets the view then captures the agent header", async () => {
    noteTedRuntimeView("ws-1", "opencode");
    mockFetchJson(
      { ok: true, sessionId: "s-1", previousSessionId: null, messageCount: 0, summarized: false },
      200,
      { "x-ted-runtime": "agent" },
    );
    await renewAgentSession("ws-1");
    expect(getTedRuntimeView("ws-1")).toBe("agent");
  });

  it("renewAgentSession success without the header resets the view to unknown (fresh lifecycle)", async () => {
    noteTedRuntimeView("ws-1", "opencode");
    mockFetchJson({ ok: true, sessionId: "s-1", previousSessionId: null, messageCount: 0, summarized: false });
    await renewAgentSession("ws-1");
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
  });

  it("confirmed agent view omits x-device-token on same-origin requests (no new A0 credentials)", async () => {
    deviceState.current = "dev-123";
    noteTedRuntimeView("ws-1", "agent");
    mockFetchJson({ turnId: "t-ag", status: "completed", output: "ok" });
    await sendAgentMessage("ws-1", "oi", { messageId: "m-ag" });
    expect(headersOf(calls[0])["x-device-token"]).toBeUndefined();
    expect(headersOf(calls[0])["x-agent-connection-token"]).toBe("conn-1");
  });
});
