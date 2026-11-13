import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { middleware } from "../middleware";
import { SECURITY_HEADERS } from "../proxy-utils";

describe("live-sync CSP origins", () => {
  it("adds only the configured HTTPS and WSS origins without changing the policy", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ORIGIN", "https://agent.example.test");
    vi.resetModules();
    const { buildCspValue } = await import("../proxy-utils");

    expect(buildCspValue("n")).toBe(
      "script-src 'self' 'nonce-n'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self' https://agent.example.test wss://agent.example.test; default-src 'self'; object-src 'none'; form-action 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; report-uri /api/csp-report",
    );

    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ORIGIN", "");
    vi.resetModules();
    const withoutOrigin = await import("../proxy-utils");
    expect(withoutOrigin.buildCspValue("n")).toBe(
      "script-src 'self' 'nonce-n'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; default-src 'self'; object-src 'none'; form-action 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; report-uri /api/csp-report",
    );
  });
});

function mockRequest(url = "https://example.com/"): NextRequest {
  return new NextRequest(url);
}

describe("middleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sets Content-Security-Policy header on response", () => {
    const response = middleware(mockRequest());
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets x-nonce header on response", () => {
    const response = middleware(mockRequest());
    const nonce = response.headers.get("x-nonce");
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("x-nonce in header matches CSP nonce", () => {
    const response = middleware(mockRequest());
    const nonce = response.headers.get("x-nonce")!;
    const csp = response.headers.get("Content-Security-Policy")!;
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it("forwards the nonce and CSP to the rendered request", () => {
    const spy = vi.spyOn(NextResponse, "next");

    middleware(mockRequest());

    const options = spy.mock.calls[0]?.[0] as {
      request?: { headers?: Headers };
    };
    const requestHeaders = options.request?.headers;
    const nonce = requestHeaders?.get("x-nonce");

    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(requestHeaders?.get("Content-Security-Policy")).toContain(
      `'nonce-${nonce}'`,
    );
  });

  it("sets all SECURITY_HEADERS on response", () => {
    const response = middleware(mockRequest());
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }
  });

  it("removes X-Powered-By header if present", () => {
    const response = middleware(mockRequest());
    expect(response.headers.get("X-Powered-By")).toBeNull();
  });

  it("deletes an existing X-Powered-By header (covered branch)", () => {
    const spy = vi
      .spyOn(NextResponse, "next")
      .mockReturnValue(
        new Response(null, { headers: { "X-Powered-By": "Next.js" } }) as unknown as ReturnType<
          typeof NextResponse.next
        >,
      );
    const response = middleware(mockRequest());
    expect(response.headers.get("X-Powered-By")).toBeNull();
    spy.mockRestore();
  });
});
