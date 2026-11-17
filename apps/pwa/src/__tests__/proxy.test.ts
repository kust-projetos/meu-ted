import { describe, it, expect } from "vitest";
import {
  generateNonce,
  SECURITY_HEADERS,
  buildCspValue,
  buildPermissionsPolicy,
  PRODUCTION_API_ORIGIN,
} from "../proxy-utils";

describe("generateNonce", () => {
  it("returns a 32-character hex string", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns unique values on successive calls", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});

describe("SECURITY_HEADERS", () => {
  it("includes Strict-Transport-Security with max-age and includeSubDomains", () => {
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("includes X-Content-Type-Options: nosniff", () => {
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("includes Referrer-Policy: strict-origin-when-cross-origin", () => {
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("SECURITY_HEADERS stays the deny-by-default base (microphone denied)", () => {
    expect(SECURITY_HEADERS["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("buildPermissionsPolicy denies microphone unconditionally", () => {
    expect(buildPermissionsPolicy(false)).toBe(
      SECURITY_HEADERS["Permissions-Policy"],
    );
    expect(buildPermissionsPolicy(true)).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("includes X-Frame-Options: DENY", () => {
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});

describe("buildCspValue", () => {
  const nonce = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

  it("allows same-origin Next route chunks with the request nonce", () => {
    const csp = buildCspValue(nonce);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
  });

  it("allows webpack eval only when explicitly enabled for development", () => {
    const developmentCsp = buildCspValue(nonce, true);
    const productionCsp = buildCspValue(nonce, false);

    expect(developmentCsp).toContain("'unsafe-eval'");
    expect(developmentCsp).toContain("http://localhost:3001");
    expect(developmentCsp).toContain("http://127.0.0.1:3001");
    expect(productionCsp).not.toContain("'unsafe-eval'");
    expect(productionCsp).not.toContain("http://localhost:3001");
    expect(productionCsp).not.toContain("http://127.0.0.1:3001");
  });

  it("keeps production connect-src same-origin only (V4 T2.7 G1)", () => {
    const csp = buildCspValue(nonce);
    expect(csp).toContain("connect-src");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain(PRODUCTION_API_ORIGIN);
  });

  it("emits the production hardening directives and the same-origin report target (V4 T2.7 G2/T0.4.8)", () => {
    const csp = buildCspValue(nonce);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("report-uri /api/csp-report");
  });

  it("allows same-origin stylesheet assets and Tailwind inline styles", () => {
    const csp = buildCspValue(nonce);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("allows the same-origin service worker", () => {
    const csp = buildCspValue(nonce);
    expect(csp).toContain("worker-src 'self'");
  });

  it("sets frame-ancestors 'none' (equivalent to X-Frame-Options DENY)", () => {
    const csp = buildCspValue(nonce);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("PRODUCTION_API_ORIGIN", () => {
  it("is the canonical production API URL", () => {
    expect(PRODUCTION_API_ORIGIN).toBe("https://api.synkroo.com.br");
  });
});
