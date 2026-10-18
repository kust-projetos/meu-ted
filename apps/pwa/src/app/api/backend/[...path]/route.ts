import { NextResponse } from "next/server";
import {
  isBrowserOriginAllowed,
  isCrossSiteWithoutOrigin,
  readBoundedBody,
  resolveBackendOrigin,
  resolveForwardOrigin,
} from "@/proxy-utils";

const UPSTREAM_TIMEOUT_MS = 20_000;
/** Request body budget (1 MB): enforced WHILE streaming, before buffering. */
const MAX_BODY_BYTES = 1_048_576;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "host",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

type RouteContext = { params: Promise<{ path: string[] }> };

function upstreamUrl(apiOrigin: string, path: string[], search: string): string {
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  return `${apiOrigin}/${encodedPath}${search}`;
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of [
    "accept", "content-type", "cookie", "authorization",
    "x-device-token",
    "cache-control", "x-workspace-id", "idempotency-key",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // V4 T2.7 G3: the spoof to the production host (upstream Better-Auth
  // trustedOrigins escape hatch for local testing via the same-origin
  // proxy) happens ONLY when the localhost bypass is enabled
  // (non-production + explicit ALLOW_LOCAL_ORIGIN=1). In production the
  // origin is forwarded unchanged so the upstream allowlist decides
  // (fail-closed); the proxy itself is same-origin, so browser CORS is
  // not involved.
  const origin = request.headers.get("origin");
  const forwarded = resolveForwardOrigin(origin, process.env);
  if (forwarded) {
    headers.set("origin", forwarded);
  }
  return headers;
}

function upstreamErrorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status, headers: { "content-type": "application/json" } },
  );
}

function hasValidBrowserOrigin(request: Request): boolean {
  return isBrowserOriginAllowed(request.headers.get("origin"), request.url, process.env);
}

function isTimeoutError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "TimeoutError"
  );
}

async function proxy(request: Request, context: RouteContext): Promise<NextResponse> {
  // T10: the upstream target is validated per request (module import time is
  // too early for the allowlist decision, and the env must never silently
  // become an open proxy for the auth cookie). A disallowed target answers
  // 500 WITHOUT contacting it.
  let apiOrigin: string;
  try {
    apiOrigin = resolveBackendOrigin(process.env.PWA_BACKEND_PROXY_ORIGIN);
  } catch (err) {
    console.error(`backend-proxy.invalid_upstream_origin: ${(err as Error).message}`);
    return upstreamErrorResponse(500, "upstream_misconfigured", "A API não está configurada. Tente novamente mais tarde.");
  }
  // T10: mutation without Origin but with cross-site Fetch Metadata is a
  // browser cross-site request hiding its Origin — refuse it. Legit
  // non-browser clients (no Origin, no Fetch Metadata) keep passing.
  if (isCrossSiteWithoutOrigin(request.headers.get("origin"), request.headers.get("sec-fetch-site"))) {
    return upstreamErrorResponse(403, "csrf.origin_mismatch", "Origem da requisição não autorizada.");
  }
  // T10: OPTIONS is no longer exempt — a preflight with a disallowed Origin
  // is refused locally instead of being forwarded upstream. GET/HEAD stay
  // exempt (safe methods, same as the Agent proxy).
  if (!["GET", "HEAD"].includes(request.method) && !hasValidBrowserOrigin(request)) {
    return upstreamErrorResponse(403, "csrf.origin_mismatch", "Origem da requisição não autorizada.");
  }
  const { path } = await context.params;
  // T10: the ceiling is enforced WHILE the body is read, not after buffering
  // it: a missing or lying Content-Length used to let the whole body land in
  // memory before the 413, and an abort mid-read threw a 500.
  const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
  if ("error" in bounded) {
    return bounded.error === "too_large"
      ? upstreamErrorResponse(413, "request.body_too_large", "O corpo da requisição excede o limite permitido.")
      : upstreamErrorResponse(400, "request.body_aborted", "A leitura do corpo foi interrompida. Tente novamente.");
  }
  const body = bounded.body;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(apiOrigin, path, new URL(request.url).search), {
      method: request.method,
      headers: forwardHeaders(request),
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      return upstreamErrorResponse(
        504,
        "upstream_timeout",
        "A API não respondeu dentro do tempo limite. Tente novamente.",
      );
    }
    return upstreamErrorResponse(
      502,
      "upstream_unavailable",
      "A API está indisponível no momento. Tente novamente mais tarde.",
    );
  }

  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (name !== "set-cookie" && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) headers.append("set-cookie", cookie);
  headers.set("cache-control", "no-store");
  headers.set("cdn-cache-control", "no-store");

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
