import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { isBrowserOriginAllowed, resolveTedGatewayOrigin, readBoundedBody, type AgentProxyEnv } from "@/proxy-utils";

type ProxyEnv = AgentProxyEnv;
type RouteContext = { params: Promise<{ path: string[] }> };
const UPSTREAM_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 2_097_152;
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "host", "transfer-encoding", "upgrade", "content-length", "content-encoding"]);

async function readProxyEnv(): Promise<ProxyEnv> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const cloud = (ctx?.env ?? {}) as ProxyEnv;
    return {
      NODE_ENV: cloud.NODE_ENV ?? process.env.NODE_ENV,
      ALLOW_LOCAL_ORIGIN: cloud.ALLOW_LOCAL_ORIGIN ?? process.env.ALLOW_LOCAL_ORIGIN,
      TED_OPENCODE_GATEWAY_ORIGIN: cloud.TED_OPENCODE_GATEWAY_ORIGIN ?? process.env.TED_OPENCODE_GATEWAY_ORIGIN,
      TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: cloud.TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS ?? process.env.TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS,
    };
  } catch { return process.env as ProxyEnv; }
}
function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}
function responseHeaders(upstream?: Response): Headers {
  const headers = new Headers({ "cache-control": "no-store", "cdn-cache-control": "no-store", "x-ted-runtime": "opencode" });
  if (upstream) {
    upstream.headers.forEach((value, name) => {
      if (name !== "set-cookie" && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
    });
    for (const cookie of upstream.headers.getSetCookie?.() ?? []) headers.append("set-cookie", cookie);
  }
  return headers;
}
async function proxy(request: Request, context: RouteContext): Promise<NextResponse> {
  const env = await readProxyEnv();
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isBrowserOriginAllowed(request.headers.get("origin"), request.url, env)) {
    return errorResponse(403, "csrf.origin_mismatch", "Origem da requisição não autorizada.");
  }
  const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
  if ("error" in bounded) {
    if (bounded.error === "too_large") return new NextResponse(JSON.stringify({ ok: false, error: { code: "request.body_too_large", message: "O corpo da requisição excede o limite permitido." } }), { status: 413, headers: responseHeaders() });
    return new NextResponse(JSON.stringify({ ok: false, error: { code: "request_cancelled", message: "A requisição foi cancelada." } }), { status: 499, headers: responseHeaders() });
  }
  const gateway = resolveTedGatewayOrigin(env);
  if (!gateway) return new NextResponse(JSON.stringify({ ok: false, error: { code: "opencode_runtime_unavailable", message: "O assistente não está disponível no momento." } }), { status: 503, headers: responseHeaders() });
  const { path } = await context.params;
  const target = `${gateway}/${path.map(encodeURIComponent).join("/")}${new URL(request.url).search}`;
  const headers = new Headers();
  for (const name of ["cookie", "x-workspace-id", "x-device-token", "origin", "x-forwarded-proto"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let signal: AbortSignal;
  try { signal = AbortSignal.any([request.signal, timeout]); } catch { signal = timeout; }
  try {
    const upstream = await fetch(target, { method: request.method, headers, ...(bounded.body ? { body: bounded.body } : {}), redirect: "manual", signal });
    return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders(upstream) });
  } catch (cause) {
    if (request.signal.aborted) return errorResponse(499, "request_cancelled", "A requisição foi cancelada.");
    if (cause instanceof Error && cause.name === "TimeoutError") return errorResponse(504, "upstream_timeout", "O assistente não respondeu dentro do tempo limite.");
    return errorResponse(502, "upstream_unavailable", "O assistente está indisponível no momento.");
  }
}
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
