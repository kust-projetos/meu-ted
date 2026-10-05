import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  isBrowserOriginAllowed,
  resolveAgentOrigin,
  resolveForwardOrigin,
  type AgentProxyEnv,
} from "@/proxy-utils";

type ProxyEnv = AgentProxyEnv;

/**
 * Reads the proxy env with the Cloudflare runtime first (wrangler vars /
 * dashboard bindings via getCloudflareContext, the in-repo pwa-control
 * pattern) and process.env as the local/test fallback. Runtime wins so a
 * deploy-time `--var` overrides anything baked in at build time.
 */
async function readProxyEnv(): Promise<ProxyEnv> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const cloudEnv = (ctx?.env ?? {}) as ProxyEnv;
    return {
      NODE_ENV: cloudEnv.NODE_ENV ?? process.env.NODE_ENV,
      ALLOW_LOCAL_ORIGIN: cloudEnv.ALLOW_LOCAL_ORIGIN ?? process.env.ALLOW_LOCAL_ORIGIN,
      PWA_ORIGIN: cloudEnv.PWA_ORIGIN ?? process.env.PWA_ORIGIN,
      PWA_AGENT_PROXY_ORIGIN: cloudEnv.PWA_AGENT_PROXY_ORIGIN ?? process.env.PWA_AGENT_PROXY_ORIGIN,
      AGENT_ORIGIN: cloudEnv.AGENT_ORIGIN ?? process.env.AGENT_ORIGIN,
    };
  } catch {
    return process.env as ProxyEnv;
  }
}

/** Upstream budget: generous for streaming/LLM agent responses. */
const UPSTREAM_TIMEOUT_MS = 120_000;
/** Chat/JSON RPC budget (unchanged): short text plus metadata-only attachments. */
const MAX_BODY_BYTES = 2_097_152;
/**
 * A19: the A13 binary attachment upload route gets its OWN ceiling, mirroring
 * the per-kind ceilings of `ATTACHMENT_LIMITS` (apps/agent/src/attachments/
 * types.ts) — 10 MB image, 10 MB audio, 15 MB pdf. The Worker derives the same
 * value from that contract; this copy exists because the PWA workspace has no
 * dependency on the agent workspace, so a literal here would silently drift.
 * The proxy only bounds memory: the per-kind validation stays in the DO.
 */
const ATTACHMENT_KIND_MAX_BYTES = { image: 10_485_760, pdf: 15_728_640, audio: 10_485_760 } as const;
const MAX_ATTACHMENT_BODY_BYTES = Math.max(...Object.values(ATTACHMENT_KIND_MAX_BYTES));
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

/** The A13 binary upload route is the only path with the attachment ceiling. */
function isAttachmentUploadPath(path: string[]): boolean {
  return path.length >= 2 && path[path.length - 1] === "attachments" && path[path.length - 2] === "rpc";
}

function upstreamUrl(agentOrigin: string, path: string[], search: string): string {
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  return `${agentOrigin}/${encodedPath}${search}`;
}

function forwardHeaders(request: Request, env: ProxyEnv): Headers {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "cookie",
    "authorization",
    "x-workspace-id",
    "x-agent-connection-token",
    "cache-control",
    // A19: the A13 upload route carries the kind and display name as claims;
    // they are validated server-side against the sniffed bytes and never used
    // as a storage key. Identity headers are still stripped (not listed).
    "x-ted-attachment-kind",
    "x-ted-attachment-name",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // V4 T2.7 G3: spoof to the production PWA host (upstream Cloudflare
  // Worker escape hatch for local testing via the same-origin proxy)
  // ONLY when the localhost bypass is enabled (non-production + explicit
  // ALLOW_LOCAL_ORIGIN=1); production forwards unchanged (fail-closed).
  const origin = request.headers.get("origin");
  const forwarded = resolveForwardOrigin(origin, env);
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

function hasValidBrowserOrigin(request: Request, env: ProxyEnv): boolean {
  return isBrowserOriginAllowed(request.headers.get("origin"), request.url, env);
}

function isTimeoutError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "TimeoutError"
  );
}

async function proxy(request: Request, context: RouteContext): Promise<NextResponse> {
  const env = await readProxyEnv();
  let agentOrigin: string;
  try {
    agentOrigin = resolveAgentOrigin(env);
  } catch (err) {
    console.error(`agent-proxy.misconfigured: ${(err as Error).message}`);
    return upstreamErrorResponse(500, "upstream_misconfigured", "O assistente não está configurado. Tente novamente mais tarde.");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !hasValidBrowserOrigin(request, env)) {
    return upstreamErrorResponse(403, "csrf.origin_mismatch", "Origem da requisição não autorizada.");
  }
  const { path } = await context.params;
  // A19: the ceiling is PER ROUTE. The A13 binary upload carries real bytes
  // (10/15 MB per the agent contract), so it gets the attachment budget;
  // every other route keeps the small chat budget. The Worker applies the same
  // split on its side — both hops must agree or a valid upload is rejected.
  const maxBodyBytes = isAttachmentUploadPath(path) ? MAX_ATTACHMENT_BODY_BYTES : MAX_BODY_BYTES;
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBodyBytes) {
    return upstreamErrorResponse(413, "request.body_too_large", "O corpo da requisição excede o limite permitido.");
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (body && body.byteLength > maxBodyBytes) {
    return upstreamErrorResponse(413, "request.body_too_large", "O corpo da requisição excede o limite permitido.");
  }
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(agentOrigin, path, new URL(request.url).search), {
      method: request.method,
      headers: forwardHeaders(request, env),
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      return upstreamErrorResponse(
        504,
        "upstream_timeout",
        "O assistente não respondeu dentro do tempo limite. Tente novamente.",
      );
    }
    return upstreamErrorResponse(
      502,
      "upstream_unavailable",
      "O assistente está indisponível no momento. Tente novamente mais tarde.",
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
