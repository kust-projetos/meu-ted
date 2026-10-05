import { FinanceChatAgent } from "./finance-chat-agent.js";
import { ATTACHMENT_LIMITS } from "./attachments/types.js";
import { authorizeWorkspaceMembership } from "./index.js";
import { probeProvider } from "./llm/provider-probe.js";
import { FIXED_ENDPOINTS } from "./llm/provider-registry.js";

export { FinanceChatAgent };

type ExportedHandler<E, _U = unknown> = { fetch(request: Request, env: E, ctx?: unknown): Promise<Response> };

type FinanceAgentStub = {
  fetch: (request: Request) => Promise<Response>;
};

type TypedAgentNamespace<T> = {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => T;
};

type Env = {
  FINANCE_CHAT_AGENT: TypedAgentNamespace<FinanceAgentStub>;
  API_ORIGIN: string;
  /**
   * DEBT2 allowlist migration: the browser (PWA) origin trusted by CORS.
   * Production MUST set this binding to the real PWA host (deploy `--var
   * PWA_ORIGIN:<host>` or the Cloudflare dashboard — value from the
   * PWA_PROD_URL repo variable). Absent/invalid → non-prod placeholder
   * below, which denies the real PWA (fail-closed for legit traffic; the
   * placeholder TLD never resolves to an attacker).
   */
  PWA_ORIGIN?: string;
  AGENT_CONNECTION_TOKEN_SECRET?: string;
  AGENT_AUTH_SERVICE_TOKEN?: string;
  AGENT_DELEGATION_SECRET?: string;
  AGENT_RUNTIME_ADMIN_TOKEN?: string;
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /**
   * V4 T2.7 G3: dev/test-only escape hatch. When "1", localhost origins
   * join the CORS allowlist for local testing through the PWA proxy;
   * production (flag absent) stays fail-closed on the PWA origin alone.
   */
  ALLOW_LOCAL_ORIGIN?: string;
  /**
   * V4.1 Phase 9 (Task 9.9): release identity injected at deploy time
   * (wrangler vars / CI env). Absent in dev → "dev" fallbacks.
   */
  BUILD_SHA?: string;
  BUILD_ID?: string;
  BUILD_TIME?: string;
  /**
   * A13/R11 — optional R2 binding for attachment bytes. Declared here for
   * typing honesty only: the Durable Object OWNS the capability switch
   * (`getAttachmentStorage(this.env)`), so an absent binding keeps answering
   * `attachment_storage_unavailable` (fail-closed 503) and the Worker never
   * reads it. Wiring the binding is a separate rollout step.
   */
  TED_ATTACHMENTS_BUCKET?: unknown;
};

/**
 * Non-prod fallback PWA origin (DEBT2 allowlist migration). Production MUST
 * set the PWA_ORIGIN binding to the pinned EXPECTED_PWA_ORIGIN below
 * (deploy `--var PWA_ORIGIN:<host>` or the Cloudflare dashboard — value
 * from the PWA_PROD_URL repo variable, itself validated by
 * scripts/validate-deploy-origins.mjs). Kept exported under its historic
 * name so existing importers keep compiling; treat it as the dev/test
 * placeholder, never as the production value.
 */
export const PRODUCTION_PWA_ORIGIN = "https://pwa.example";

/**
 * Exact production PWA host (DEBT2-CODER-ALLOWLISTS-FIX, security review
 * HIGH: CORS allowlist hardening). This literal is the pinned allowlist for
 * origin validation — the worker trusts no other browser origin in
 * production. It is a value being PINNED, not a secret; its presence is an
 * irreducible detector-like exception, allowlisted in
 * scripts/check-public-safety.mjs with reason and covered by the
 * worker-cors-gate suite (the safety gate: any host change breaks those
 * tests loudly before it can ship).
 */
export const EXPECTED_PWA_ORIGIN = "https://pi-finance-pwa.walissonead.workers.dev";

/**
 * Strict origin check: ONLY the exact expected https origin — no userinfo,
 * no explicit port, no path beyond "/", no query, no fragment, exact
 * hostname. Used for the CORS allowlist source below.
 */
export function isExpectedPwaOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname === new URL(EXPECTED_PWA_ORIGIN).hostname &&
    parsed.port === "" &&
    (parsed.pathname === "" || parsed.pathname === "/") &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.origin === EXPECTED_PWA_ORIGIN
  );
}

/**
 * FIX-FINAL-2 FINDING 2: ceiling for RPC bodies buffered before forwarding
 * to the Durable Object. Chat/mutation RPC payloads are small (short text
 * plus metadata-only attachments), so 2MB leaves ample headroom while
 * bounding memory per request. Oversized bodies are rejected with 413
 * before a single byte reaches the DO.
 */
export const MAX_RPC_BODY_BYTES = 2 * 1024 * 1024;

/**
 * A19: the attachment upload route has its OWN ceiling, derived STRUCTURALLY
 * from the A13 contract (`ATTACHMENT_LIMITS`) — never a literal here, so this
 * can never drift below what `ingestAttachment` accepts (image/audio 10 MB,
 * pdf 15 MB). The Worker only rejects bodies above the contract ceiling; the
 * per-kind bound stays enforced by the DO's ingestion validator, so a valid
 * 10 MB PNG reaches it while a body above 15 MB never gets buffered.
 */
export const MAX_ATTACHMENT_BODY_BYTES = Math.max(
  ...Object.values(ATTACHMENT_LIMITS).map((limit) => limit.maxBytes),
);
// Review F3: a contract entry missing `maxBytes` would make the spread yield
// NaN, and `total > NaN` is ALWAYS false — the streaming ceiling would never
// trip and the worker would buffer without bound. A malformed contract is a
// load-time failure, never a silent unbounded read.
if (!Number.isFinite(MAX_ATTACHMENT_BODY_BYTES)) {
  throw new Error("ATTACHMENT_LIMITS is malformed: no finite maxBytes entry");
}

const bodyTooLarge = (limit: number): Response =>
  Response.json(
    { code: "agent.payload_too_large", message: `Request body exceeds ${limit} bytes` },
    { status: 413 },
  );

/**
 * Reads the request body up to `limit` bytes. A declared Content-Length above
 * the ceiling is rejected up front; otherwise the stream is consumed in
 * chunks and aborted the moment the ceiling is crossed — the worker never
 * buffers an unbounded body. GET/HEAD requests carry no body and resolve to an
 * empty result.
 */
async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<{ body?: ArrayBuffer } | { response: Response }> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) return { response: bodyTooLarge(limit) };
  }
  const stream = request.body;
  if (!stream) {
    const buffered = await request.arrayBuffer();
    if (buffered.byteLength > limit) return { response: bodyTooLarge(limit) };
    return buffered.byteLength === 0 ? {} : { body: buffered };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { response: bodyTooLarge(limit) };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return {};
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: merged.buffer as ArrayBuffer };
}

const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

/**
 * Resolves the trusted PWA origin from the PWA_ORIGIN binding. Returns the
 * pinned expected origin when the binding matches exactly, the non-prod
 * placeholder when unset (or set to the placeholder itself, the documented
 * dev value), and the placeholder fail-closed otherwise: a misconfigured
 * production denies the real PWA instead of trusting an attacker-controlled
 * value, and an invalid value is never allowlisted.
 */
export function resolvePwaOrigin(env?: { PWA_ORIGIN?: string }): string {
  const configured = env?.PWA_ORIGIN?.trim();
  if (configured) {
    if (isExpectedPwaOrigin(configured)) return EXPECTED_PWA_ORIGIN;
    if (configured !== PRODUCTION_PWA_ORIGIN) {
      console.warn(`worker.config_invalid_pwa_origin fallback=${PRODUCTION_PWA_ORIGIN}`);
    }
  }
  return PRODUCTION_PWA_ORIGIN;
}

/**
 * V4 T2.7 G3 — CORS allowlist with the localhost environment gate.
 * Production (no explicit flag) accepts the PWA origin only (PWA_ORIGIN
 * binding, placeholder fallback); localhost joins exclusively behind
 * ALLOW_LOCAL_ORIGIN=1. No route contract changes: callers keep passing
 * the same env through.
 */
export function resolveAllowedOrigins(env?: { ALLOW_LOCAL_ORIGIN?: string; PWA_ORIGIN?: string }): string[] {
  const pwaOrigin = resolvePwaOrigin(env);
  if (env?.ALLOW_LOCAL_ORIGIN === "1") {
    return [pwaOrigin, ...LOCAL_ORIGINS];
  }
  return [pwaOrigin];
}

const verifyAdminToken = (request: Request, adminToken?: string): boolean => {
  if (!adminToken) return false;
  const authHeader = request.headers.get("authorization");
  let bearerToken: string | undefined;
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    bearerToken = authHeader.slice(7).trim();
  }
  const customHeader = request.headers.get("x-agent-runtime-admin-token");
  const provided = customHeader?.trim() || bearerToken;
  if (!provided) return false;

  const expectedBytes = new TextEncoder().encode(adminToken);
  const providedBytes = new TextEncoder().encode(provided);
  if (expectedBytes.length !== providedBytes.length) return false;

  let match = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    match |= expectedBytes[i]! ^ providedBytes[i]!;
  }
  return match === 0;
};

export default {
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    const url = new URL(request.url);

    const ALLOWED_ORIGINS = resolveAllowedOrigins(env);
    const requestOrigin = request.headers.get("origin") ?? "";
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(requestOrigin);
    const corsHeaders = (): Record<string, string> => ({
      "access-control-allow-origin": isAllowedOrigin ? requestOrigin : "null",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
      "access-control-allow-headers":
        "content-type, x-workspace-id, x-agent-connection-token, authorization, x-ted-attachment-kind, x-ted-attachment-name",
      "access-control-max-age": "600",
    });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const handle = async (): Promise<Response> => {
      if (url.pathname === "/health/agent") {
        return Response.json({ status: "ready", binding: "FINANCE_CHAT_AGENT" });
      }
      if (url.pathname === "/health") {
        // V4.1 Phase 9 (Task 9.9) — release identity from deploy-time env
        // (BUILD_SHA/BUILD_ID/BUILD_TIME), dev fallbacks otherwise.
        return Response.json({
          status: "ready",
          schemaVersion: 5,
          buildSha: env.BUILD_SHA || "dev",
          buildId: env.BUILD_ID || "dev",
          builtAt: env.BUILD_TIME || "dev",
        });
      }

    // Internal admin routes: Catalog & Provider Probe
    if (url.pathname === "/internal/agent/catalog") {
      if (!verifyAdminToken(request, env.AGENT_RUNTIME_ADMIN_TOKEN)) {
        return Response.json({ code: "agent.unauthorized", message: "Invalid runtime admin token" }, { status: 401 });
      }
      return Response.json({
        providers: Object.keys(FIXED_ENDPOINTS),
      });
    }

    if (url.pathname === "/internal/agent/probe" && request.method === "POST") {
      if (!verifyAdminToken(request, env.AGENT_RUNTIME_ADMIN_TOKEN)) {
        return Response.json({ code: "agent.unauthorized", message: "Invalid runtime admin token" }, { status: 401 });
      }
      let body: { provider?: string; model?: string };
      try {
        body = (await request.json()) as { provider?: string; model?: string };
      } catch {
        return Response.json({ code: "agent.invalid_payload", message: "Invalid JSON payload" }, { status: 400 });
      }

      if (!body.provider || !body.model) {
        return Response.json({ code: "agent.missing_parameters", message: "provider and model are required" }, { status: 400 });
      }

      const probeResult = await probeProvider(
        body.provider,
        body.model,
        env as unknown as Record<string, string | undefined>,
      );

      return Response.json(probeResult);
    }

    // SDK routing for FinanceChatAgent – authenticated before persist
    const financeMatch = url.pathname.match(/^\/agents\/finance-chat-agent\/([^/]+)/);
    if (financeMatch) {
      const workspaceId = decodeURIComponent(financeMatch[1]!);
      const auth = await authorizeWorkspaceMembership(request, env as unknown as { API_ORIGIN: string; AGENT_CONNECTION_TOKEN_SECRET?: string; AGENT_AUTH_SERVICE_TOKEN?: string }, workspaceId);
      if (auth instanceof Response) return auth;

      // C-05: every Durable Object name and every persistent key derives
      // from the AUTHORIZED canonical id — never from the raw path id,
      // which may be an unresolved alias. Alias-namespaced DOs created
      // before this fix are abandoned (never read/written); see
      // docs/ops/do-canonical-namespace.md for the migration policy.
      const canonicalId = auth.workspaceId;
      if (canonicalId !== workspaceId) {
        console.warn(`do.alias_namespace_avoided alias=${workspaceId} canonical=${canonicalId}`);
      }

      const subPath = url.pathname.slice(financeMatch[0].length);
      // T4.3 (SPEC section 11 E4): the retired legacy-agent migration gate
      // is gone — the canonical RPC surface talks to FinanceChatAgent
      // directly (INV-07, single runtime).
      const isRestRpc = subPath === "/rpc/chat" || subPath === "/rpc/history" || subPath === "/rpc/session/new" || subPath === "/rpc/memory/prefs" || subPath === "/rpc/pending-operations/active" || subPath === "/rpc/undo/active" || subPath === "/rpc/undo/decision" || subPath === "/rpc/attachments" || /^\/rpc\/undo\/[^/]+\/verify-target$/.test(subPath) || /^\/rpc\/pending-operations\/[^/]+\/decision$/.test(subPath);

      if (isRestRpc) {
        const financeAgent = env.FINANCE_CHAT_AGENT.get(env.FINANCE_CHAT_AGENT.idFromName(canonicalId));

        const headers = new Headers(request.headers);
        headers.set("x-agent-actor", auth.actorId);
        headers.set("x-agent-role", auth.role);
        headers.set("x-agent-workspace", auth.workspaceId);
        // H-12: stamp (OVERWRITE) the device binding from the verified
        // authorization. A free client x-agent-device header is never
        // trusted; deviceless authorizations delete any presented value.
        if (auth.deviceId) headers.set("x-agent-device", auth.deviceId);
        else headers.delete("x-agent-device");
        const rpcUrl = new URL(request.url);
        rpcUrl.pathname = subPath;
        // Buffer the body before forwarding: relaying the live stream
        // throws outside the Workers runtime (Node requires duplex) and
        // after any prior read — an ArrayBuffer forwards safely on both.
        // Bounded (FIX-FINAL-2 FINDING 2): the body is read with a byte
        // ceiling and rejected with 413 before reaching the DO. The ceiling is
        // PER ROUTE: A19 gives the binary attachment upload the A13 contract
        // ceiling (ATTACHMENT_LIMITS) while every chat/JSON RPC keeps the
        // small 2 MB budget — a shared 2 MB cap would reject valid uploads.
        const bounded = await readBoundedBody(
          request,
          subPath === "/rpc/attachments" ? MAX_ATTACHMENT_BODY_BYTES : MAX_RPC_BODY_BYTES,
        );
        if ("response" in bounded) return bounded.response;
        const rpcBody = bounded.body;
        return financeAgent.fetch(
          new Request(rpcUrl, { method: request.method, headers, body: rpcBody }),
        );
      }

      // Block all non-RPC routes to FinanceChatAgent to prevent unauthenticated/spoofed SDK routing
      return new Response("Not found", { status: 404 });
    }

    // T4.3 (SPEC section 11 E4, INV-07): the retired legacy agent route
    // is gone — unknown paths fall through to 404 below.
    return new Response("Not found", { status: 404 });
    };

    const response = await handle();
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env, unknown>;
