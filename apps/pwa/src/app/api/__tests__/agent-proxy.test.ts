import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GET } from "@/app/api/agent/[...path]/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ctx = { params: Promise.resolve({ path: ["agents", "ping"] }) };
const request = (signal?: AbortSignal) => new Request("https://pwa.test/api/agent/agents/ping", { signal });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
  vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", "http://127.0.0.1:8787");
});

describe("agent proxy upstream failures (P1-7)", () => {
  it("returns 503 without a configured gateway", async () => {
    vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request(), ctx);
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("x-ted-runtime")).toBe("opencode");
  });

  it("returns 504 structured JSON when upstream times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    );

    const res = await GET(request(), ctx);

    expect(res.status).toBe(504);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("upstream_timeout");
    expect(typeof body.error.message).toBe("string");
  });

  it("returns 502 structured JSON when upstream fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );

    const res = await GET(request(), ctx);

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("upstream_unavailable");
    expect(typeof body.error.message).toBe("string");
  });

  it("still proxies successful upstream responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pong: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const res = await GET(request(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("returns 499 when the incoming request was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request(controller.signal), ctx);
    expect(res.status).toBe(499);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
