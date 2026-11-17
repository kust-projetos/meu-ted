/**
 * Next.js 16 middleware — security proxy.
 *
 * Applies security headers and CSP nonce to all routes.
 * Uses experimental-edge runtime for Cloudflare compatibility via OpenNext.
 *
 * ACCEPTED COMPATIBILITY EXCEPTION (Next.js 16 + OpenNext Cloudflare):
 * Next.js 16 recommends src/proxy.ts but a Next 16 proxy.ts cannot set a
 * runtime (build error: "Route segment config is not allowed in Proxy file.
 * Proxy always runs on Node.js runtime.") and always runs on Node.js.
 * OpenNext Cloudflare rejects Node.js middleware
 * ("ERROR Node.js middleware is not currently supported."), which breaks
 * `opennext build`. So the deprecated src/middleware.ts with
 * `runtime = "experimental-edge"` is REQUIRED for the deploy to build.
 * The Next 16 middleware.ts deprecation *warning* is non-fatal; the OpenNext
 * Node.js rejection is fatal. Do NOT "fix" the warning by renaming to proxy.ts.
 *
 * MIGRATION TRIGGER — switch to src/proxy.ts only when BOTH hold:
 *   1. OpenNext Cloudflare no longer errors "Node.js middleware is not
 *      currently supported" (after upgrading @opennextjs/cloudflare), AND
 *   2. Next.js (16+) allows an Edge runtime in proxy.ts (a `runtime` export
 *      is currently rejected).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  generateNonce,
  buildProductionEmissionHeaders,
} from "./proxy-utils";

// experimental-edge required for OpenNext/Cloudflare deployment.
// Proxy.ts (Next.js 16 native) is Node.js-only and rejected by OpenNext.
export const runtime = "experimental-edge";

export function middleware(request: NextRequest) {
  // Single source of emission (V4 FIX-F0): the exact function XLT-00
  // executes over a real HTTP server — middleware and test share it.
  const emission = buildProductionEmissionHeaders({
    nonce: generateNonce(),
    isDevelopment: process.env.NODE_ENV === "development",
    micEnabled: false,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", emission["x-nonce"]!);
  requestHeaders.set("Content-Security-Policy", emission["Content-Security-Policy"]!);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Apply CSP with nonce and static security headers. Microphone access is
  // denied by the fixed Permissions-Policy; the product has no mic capability.
  for (const [key, value] of Object.entries(emission)) {
    response.headers.set(key, value);
  }

  // Strip X-Powered-By as safety net
  const rawHeaders = response.headers as unknown as Headers;
  if (rawHeaders.get("X-Powered-By")) {
    rawHeaders.delete("X-Powered-By");
  }

  return response;
}

// Match all routes except static assets and Next.js internals
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest\\.webmanifest|\\.well-known|\\.open-next).*)",
  ],
};
