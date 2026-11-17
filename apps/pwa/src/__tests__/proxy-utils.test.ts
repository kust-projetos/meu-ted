import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { middleware } from "../middleware";
import {
  SECURITY_HEADERS,
  buildCspValue,
  buildPermissionsPolicy,
  isTedConversationalRpcPath,
  isTedRuntimeRpcPath,
} from "../proxy-utils";

describe("Ted runtime RPC path classifiers", () => {
  const path = (...tail: string[]) => ["agents", "finance-chat-agent", "ws-1", "rpc", ...tail];
  const conversational = [
    path("chat"), path("history"), path("session", "new"),
  ];
  const runtimeOnly = [
    path("pending-operations", "propose"), path("pending-operations", "active"),
    path("pending-operations", "id-1", "decision"), path("undo", "active"),
    path("undo", "decision"), path("workspace", "ws-2", "attest-empty"),
  ];
  it.each([...conversational, ...runtimeOnly].map((value) => [value]))(
    "accepts runtime path %j",
    (value) => expect(isTedRuntimeRpcPath(value)).toBe(true),
  );
  it.each(conversational.map((value) => [value]))(
    "accepts conversational path %j",
    (value) => expect(isTedConversationalRpcPath(value)).toBe(true),
  );
  it.each(runtimeOnly.map((value) => [value]))(
    "does not classify runtime-only path as conversational %j",
    (value) => expect(isTedConversationalRpcPath(value)).toBe(false),
  );
  it.each([
    path("attachments"), path("attachments", "observability"), path("memory", "prefs"),
    path("pending-operations"), path("pending-operations", "id-1"),
    path("pending-operations", "", "decision"), path("workspace", "ws-2"),
    path("workspace", "", "attest-empty"), ["rpc", "chat"], path("unknown"),
  ].map((value) => [value]))("rejects both classifiers for %j", (value) => {
    expect(isTedRuntimeRpcPath(value)).toBe(false);
    expect(isTedConversationalRpcPath(value)).toBe(false);
  });
});

describe("security policy after live-sync and microphone removal", () => {
  it("keeps the CSP connect-src same-origin only", () => {
    expect(buildCspValue("n")).toContain("connect-src 'self';");
  });

  it("denies microphone regardless of the compatibility argument", () => {
    expect(buildPermissionsPolicy(false)).toBe("camera=(), microphone=(), geolocation=()");
    expect(buildPermissionsPolicy(true)).toBe("camera=(), microphone=(), geolocation=()");
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
