/**
 * Security proxy utilities (shared between proxy and tests).
 *
 * Does NOT contain secrets or hardcoded tokens.
 */

/** Production API origin (retired from the production CSP — see below). */
export const PRODUCTION_API_ORIGIN = "https://api.synkroo.com.br";

/**
 * Non-prod fallback Agent origin (DEBT2 allowlist migration). Reference
 * only (upstream target the PWA agent proxy forwards to in dev/test);
 * production MUST set PWA_AGENT_PROXY_ORIGIN (or AGENT_ORIGIN) — see
 * resolveAgentOrigin below. Kept exported under its historic name so existing
 * importers keep compiling.
 */
export const PRODUCTION_AGENT_ORIGIN = "https://agent.example";

export const FALLBACK_AGENT_ORIGIN = "https://agent.example";

/**
 * Exact production hosts (DEBT2-CODER-ALLOWLISTS-FIX, security review HIGH:
 * shell-injection / open-proxy hardening). These literals are the pinned
 * allowlist for origin validation — every runtime origin (deploy repo
 * variables, worker bindings, proxy env) must match them exactly, or the
 * code fails closed. They are values being PINNED, not secrets; their
 * presence is an irreducible detector-like exception, allowlisted in
 * scripts/check-public-safety.mjs with reason and covered by the
 * edge-gate / route test suites (the safety gate: any host change breaks
 * those tests loudly before it can ship).
 */
export const EXPECTED_PWA_ORIGIN = "https://pi-finance-pwa.walissonead.workers.dev";
export const EXPECTED_AGENT_ORIGIN = "https://pi-finance-agent.walissonead.workers.dev";

/**
 * Strict origin check shared by the PWA proxies and deploy validation.
 * Accepts ONLY the exact expected https origin: no userinfo, no explicit
 * port, no path beyond "/", no query, no fragment, exact hostname. Any
 * deviation (lookalike hosts, userinfo smuggling, scheme downgrade,
 * shell metacharacters — none of which survive URL parsing as the exact
 * origin) returns false and the caller fails closed.
 */
export function isExpectedOrigin(value: string, expectedOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  let expected: URL;
  try {
    expected = new URL(expectedOrigin);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname === expected.hostname &&
    parsed.port === "" &&
    (parsed.pathname === "" || parsed.pathname === "/") &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.origin === expected.origin
  );
}

/**
 * V4 T2.7 G1 — remaining external origins allowed by the production CSP.
 *
 * EMPTY by design: T2.1 converged browser traffic to the same-origin
 * proxies (/api/backend, /api/agent), so production connect-src is 'self'
 * only. PRODUCTION_API_ORIGIN / PRODUCTION_AGENT_ORIGIN above are kept as
 * documented reference (upstream targets the proxies forward to), never as
 * browser connect targets. Any future external origin needs a per-origin
 * capability entry here before it may enter connect-src.
 */
export const REMAINING_EXTERNAL_ORIGINS: readonly string[] = [];

/**
 * Non-prod fallback PWA host (DEBT2 allowlist migration). Used as the
 * localhost-spoof target in dev/test and as the fallback when PWA_ORIGIN is
 * unset/malformed (see resolvePwaOrigin); production MUST set PWA_ORIGIN to
 * the pinned EXPECTED_PWA_ORIGIN (wrangler vars / Cloudflare dashboard,
 * value from the PWA_PROD_URL repo variable). Kept exported under its
 * historic name so existing importers keep compiling; treat it as the
 * dev/test placeholder, never as the production value.
 */
export const PRODUCTION_PWA_ORIGIN = "https://pwa.example";

type EnvLike = {
  NODE_ENV?: string;
  ALLOW_LOCAL_ORIGIN?: string;
  PWA_ORIGIN?: string;
  PWA_AGENT_PROXY_ORIGIN?: string;
  AGENT_ORIGIN?: string;
};

export type AgentProxyEnv = EnvLike;

function readEnv(env: EnvLike | undefined): EnvLike {
  if (env) return env;
  try {
    return {
      NODE_ENV: process.env.NODE_ENV,
      ALLOW_LOCAL_ORIGIN: process.env.ALLOW_LOCAL_ORIGIN,
    };
  } catch {
    return {};
  }
}

/** True for http(s) localhost / 127.0.0.1 origins (pure, no env). */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

/**
 * V4 T2.7 G3 — localhost bypass gate (shared by both Next proxies).
 *
 * Fail-closed: production NEVER enables the bypass, even with the flag set.
 * Outside production the bypass additionally requires the explicit
 * ALLOW_LOCAL_ORIGIN=1 flag (dev/test escape hatch). Reads env at
 * call-time so tests can pass an explicit object or vi.stubEnv.
 */
export function isLocalBypassEnabled(env?: EnvLike): boolean {
  const { NODE_ENV, ALLOW_LOCAL_ORIGIN } = readEnv(env);
  if (NODE_ENV === "production") return false;
  return ALLOW_LOCAL_ORIGIN === "1";
}

/**
 * V4 T2.7 G3 — shared browser-origin decision used by both Next proxies.
 * Missing origin (non-browser / same-document navigation) and exact
 * same-origin pass; localhost passes only when the bypass is enabled;
 * everything else is rejected.
 */
export function isBrowserOriginAllowed(
  origin: string | null,
  requestUrl: string,
  env?: EnvLike,
): boolean {
  if (!origin) return true;
  try {
    if (new URL(origin).origin === new URL(requestUrl).origin) return true;
  } catch {
    return false;
  }
  return isLocalOrigin(origin) && isLocalBypassEnabled(env);
}

/**
 * Resolves the trusted PWA origin from the PWA_ORIGIN env (Cloudflare
 * runtime binding or process.env). Returns the pinned expected origin when
 * the binding matches exactly, the non-prod placeholder when unset (or set
 * to the placeholder itself, the documented dev value), and the placeholder
 * fail-closed otherwise — a misconfigured value never becomes a trusted or
 * spoofed origin (the upstream worker enforces the same pin).
 */
export function resolvePwaOrigin(env?: EnvLike): string {
  const configured = env?.PWA_ORIGIN?.trim();
  if (configured) {
    if (isExpectedOrigin(configured, EXPECTED_PWA_ORIGIN)) return EXPECTED_PWA_ORIGIN;
    if (configured === PRODUCTION_PWA_ORIGIN) return PRODUCTION_PWA_ORIGIN;
  }
  return PRODUCTION_PWA_ORIGIN;
}

/**
 * Strict well-formed HTTP loopback upstream check (pure, no env).
 *
 * Accepts ONLY `http://localhost[:port]` or `http://127.0.0.1[:port]` with
 * no userinfo, no path beyond "/", no query, no fragment. Returns the
 * normalized origin (`URL.origin`, trailing slash stripped) or null. The
 * caller still gates on NODE_ENV + ALLOW_LOCAL_ORIGIN; this function alone
 * never authorizes anything. Port is allowed (local Wrangler binds an
 * ephemeral port); unlike isExpectedOrigin, which pins production HTTPS
 * without a port, this is a test-only/local-dev shape check.
 */
function parseLoopbackAgentUpstream(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

/**
 * Resolves the Agent upstream only when the runtime binding matches the
 * pinned production origin. This keeps the same-origin proxy from forwarding
 * user credentials to a misconfigured target.
 *
 * Test-only/local-dev exception (PWA-LOCAL-AGENT-PROXY-GATE): a well-formed
 * HTTP loopback origin (`localhost` / `127.0.0.1`, no userinfo/path/query/
 * hash) is returned ONLY when NODE_ENV is exactly `development` or `test`
 * AND ALLOW_LOCAL_ORIGIN is exactly `1`. Every other case (production or
 * undefined NODE_ENV, missing flag, malformed/credentialed/path/external
 * target) falls through to the existing fail-closed path: placeholder
 * outside production, throw in production. Pinned HTTPS behavior unchanged.
 */
export function resolveAgentOrigin(env?: AgentProxyEnv): string {
  const override = env?.PWA_AGENT_PROXY_ORIGIN?.trim() || env?.AGENT_ORIGIN?.trim();
  if (override) {
    if (isExpectedOrigin(override, EXPECTED_AGENT_ORIGIN)) return EXPECTED_AGENT_ORIGIN;
    const loopback = parseLoopbackAgentUpstream(override);
    if (
      loopback &&
      (env?.NODE_ENV === "development" || env?.NODE_ENV === "test") &&
      env?.ALLOW_LOCAL_ORIGIN === "1"
    ) {
      return loopback;
    }
    console.error("agent-proxy.invalid_upstream_origin");
  } else if (env?.NODE_ENV !== "production") {
    return FALLBACK_AGENT_ORIGIN;
  }
  if (env?.NODE_ENV === "production") {
    throw new Error(
      "FATAL: PWA_AGENT_PROXY_ORIGIN (or AGENT_ORIGIN) must match the pinned Agent origin in production; refusing to proxy to unsafe defaults.",
    );
  }
  return FALLBACK_AGENT_ORIGIN;
}

/**
 * V4 T2.7 G3 — shared upstream-Origin decision used by both Next proxies.
 * The spoof to the production host (upstream trustedOrigins escape hatch)
 * happens ONLY when the bypass is enabled; otherwise the origin is
 * forwarded unchanged so the upstream allowlist decides (fail-closed).
 */
export function resolveForwardOrigin(
  origin: string | null,
  env?: EnvLike,
): string | null {
  if (origin && isLocalOrigin(origin) && isLocalBypassEnabled(env)) {
    return resolvePwaOrigin(env);
  }
  return origin;
}

/**
 * T10 — backend upstream allowlist (pure, no env access).
 *
 * The backend proxy forwards the auth cookie, so its target must never be an
 * arbitrary host taken from the environment. The allowed set is NOT expanded:
 * the pinned production API origin, or a well-formed HTTP loopback upstream
 * (`localhost` / `127.0.0.1`, any port — the E2E fixture and local API run on
 * ephemeral ports with ALLOW_LOCAL_ORIGIN=0). Anything else throws and the
 * route answers 500 upstream_misconfigured WITHOUT contacting the target.
 * Blank/unset keeps the historical production default.
 */
export function resolveBackendOrigin(raw: string | undefined | null): string {
  const value = raw?.trim();
  if (!value) return PRODUCTION_API_ORIGIN;
  if (isExpectedOrigin(value, PRODUCTION_API_ORIGIN)) return PRODUCTION_API_ORIGIN;
  const loopback = parseLoopbackBackendUpstream(value);
  if (loopback) return loopback;
  throw new Error(
    "FATAL: PWA_BACKEND_PROXY_ORIGIN must be the production API origin or a well-formed http://localhost|127.0.0.1 upstream; refusing to forward credentials elsewhere.",
  );
}

/**
 * T10 — strict well-formed HTTP loopback upstream check (pure, no env).
 * Mirrors the shape of parseLoopbackAgentUpstream (no userinfo, no path
 * beyond "/", no query, no fragment). Port is allowed: the E2E fixture and
 * local dev API bind ephemeral ports. This function alone never authorizes
 * anything — resolveBackendOrigin decides.
 */
function parseLoopbackBackendUpstream(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

/**
 * T10 — Fetch Metadata gate for requests WITHOUT Origin (pure, no env).
 *
 * Legit non-browser clients (curl, server-to-server, health checks) send
 * neither Origin nor Fetch Metadata and keep passing. A browser cross-site
 * request always carries `Sec-Fetch-Site: cross-site`, so a mutation that
 * claims to have no Origin but carries that marker is refused. The Origin
 * allowlist itself stays where it already is; this only closes the
 * no-Origin hole.
 */
export function isCrossSiteWithoutOrigin(
  origin: string | null,
  secFetchSite: string | null | undefined,
): boolean {
  if (origin) return false;
  return (secFetchSite ?? "").trim().toLowerCase() === "cross-site";
}

export type BoundedBodyResult =
  | { body?: ArrayBuffer }
  | { error: "too_large" }
  | { error: "aborted" };

/**
 * T10 — reads the request body up to `limit` bytes, cutting the stream BEFORE
 * buffering the excess (mirrors the Agent proxy `readBoundedBody` ceiling
 * semantics; kept as a shared pure helper so both proxies agree).
 *
 * A declared Content-Length above the ceiling is rejected before reading a
 * single byte, but the declared value is never trusted: the stream is still
 * measured chunk by chunk and cancelled the moment the ceiling is crossed, so
 * a missing or lying Content-Length can no longer buy an unbounded buffer.
 * A read failure/abort mid-stream returns `aborted` (the route answers 4xx)
 * instead of throwing a 500.
 *
 * R10-1: bytes accumulate in ONE contiguous buffer grown by bounded
 * reallocation (capped at `limit`). Chunk objects are copied on arrival and
 * never retained, so a 1 MiB body in 1-byte chunks holds ~1 MiB — not one
 * object per byte. The ceiling is enforced BEFORE retaining, so the store
 * never holds more than `limit` bytes.
 *
 * R10-2: the request AbortSignal is observed. An already-aborted signal
 * short-circuits before any read; an abort racing a pending `reader.read()`
 * (or a delivered chunk) cancels the reader and resolves `aborted`
 * (the route answers 400 `request.body_aborted`).
 */
export async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<BoundedBodyResult> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const signal = request.signal;
  if (signal?.aborted) return { error: "aborted" };
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) return { error: "too_large" };
  }
  const stream = request.body;
  if (!stream) {
    // Fallback only: some runtimes hand over a Request without an exposed
    // body stream. The ceiling is re-checked after buffering so the fallback
    // never becomes a hole in it; a failed read is an abort, not a 500.
    // Single race (ONE reaction, no loop): no per-chunk accumulation here.
    let onAbort: (() => void) | undefined;
    const aborted =
      signal === undefined
        ? null
        : new Promise<"aborted">((resolve) => {
            onAbort = () => resolve("aborted");
            signal.addEventListener("abort", onAbort, { once: true });
            // Abort fired in the gap between the early check and subscribe.
            if (signal.aborted) resolve("aborted");
          });
    try {
      const buffered =
        aborted === null
          ? await request.arrayBuffer()
          : await Promise.race([request.arrayBuffer(), aborted]);
      if (buffered === "aborted") return { error: "aborted" };
      if (buffered.byteLength > limit) return { error: "too_large" };
      return buffered.byteLength === 0 ? {} : { body: buffered };
    } catch {
      return { error: "aborted" };
    } finally {
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
  // R10-r2: SINGLE-listener abort pattern. ONE `abort` listener is registered
  // once before the loop; on fire it sets a local flag and cancels the reader
  // so a pending `read()` settles promptly. Each iteration is a plain
  // `await reader.read()` followed by a flag check — no race, no new
  // reactions on any shared promise — so 1 MiB in 1-byte chunks iterates ~1M
  // times with zero accumulation. The listener is removed once in `finally`.
  const reader = stream.getReader();
  let abortedFlag = false;
  const onAbort = (): void => {
    abortedFlag = true;
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = new Uint8Array(0);
  let total = 0;
  try {
    // Abort fired in the gap between the early check and subscribe.
    if (signal?.aborted) abortedFlag = true;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        await reader.cancel().catch(() => {});
        return { error: "aborted" };
      }
      // An abort racing the read (pending or delivered chunk) always wins:
      // partial bytes are discarded and the caller sees `aborted`, never a
      // partial body. Checked BEFORE `done` so a cancel-settled read can
      // never surface as a clean empty body.
      if (abortedFlag || signal?.aborted) {
        await reader.cancel().catch(() => {});
        return { error: "aborted" };
      }
      if (next.done) break;
      const chunk = next.value;
      // Ceiling enforced BEFORE retaining: the over-limit chunk is dropped
      // and the source cancelled instead of drained.
      if (total + chunk.byteLength > limit) {
        // Stop reading NOW: cancel the source instead of draining the rest.
        await reader.cancel().catch(() => {});
        return { error: "too_large" };
      }
      if (total + chunk.byteLength > buffer.byteLength) {
        const capacity = Math.min(
          limit,
          Math.max(buffer.byteLength * 2, total + chunk.byteLength),
        );
        const grown = new Uint8Array(capacity);
        grown.set(buffer.subarray(0, total));
        buffer = grown;
      }
      buffer.set(chunk, total);
      total += chunk.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (total === 0) return {};
  return { body: buffer.slice(0, total).buffer as ArrayBuffer };
}

/** Canonical security headers applied to every response. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
};

/**
 * Build the Permissions-Policy value from the microphone capability
 * (V4 T1.1, INV-08 bidirectional).
 *
 * - mic enabled → `microphone=(self)`: live capture works in a real browser.
 * - mic disabled (default) → `microphone=()`: denied, matching the absent UI.
 *
 * Camera and geolocation stay blocked in every configuration, and no
 * cross-origin value is ever emitted for the microphone directive.
 */
export function buildPermissionsPolicy(micEnabled: boolean): string {
  const microphone = micEnabled ? "microphone=(self)" : "microphone=()";
  return `camera=(), ${microphone}, geolocation=()`;
}

/**
 * Generate a CSP nonce — 32 random hex characters.
 * Unique per request.
 */
export function generateNonce(): string {
  // Use Web Crypto API (Edge-compatible).
  // crypto.getRandomValues fills with cryptographically strong random values.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Production header emission shared by src/middleware.ts and XLT-00.
 *
 * This is the SAME function the middleware calls (not a reimplementation):
 * per-response CSP with a fresh nonce + the static security headers, with
 * Permissions-Policy built from the microphone capability (V4 T1.1).
 * Kept pure (no Next.js imports) so both the edge middleware and a plain
 * node:http server in tests can execute it.
 */
export interface ProductionEmissionInput {
  nonce: string;
  isDevelopment: boolean;
  micEnabled: boolean;
}

export function buildProductionEmissionHeaders(
  input: ProductionEmissionInput,
): Record<string, string> {
  const headers: Record<string, string> = {};
  headers["Content-Security-Policy"] = buildCspValue(input.nonce, input.isDevelopment);
  headers["x-nonce"] = input.nonce;
  const permissionsPolicy = buildPermissionsPolicy(input.micEnabled);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers[key] = key === "Permissions-Policy" ? permissionsPolicy : value;
  }
  return headers;
}

/**
 * Build the Content-Security-Policy value for a given nonce.
 *
 * - script-src: same-origin Next chunks + nonce-based inline scripts (no unsafe-inline)
 *   and optional unsafe-eval for the webpack development runtime
 * - style-src: same-origin stylesheets + unsafe-inline for Tailwind-generated styles
 * - worker-src: same-origin service worker (Serwist)
 * - connect-src: 'self' ONLY in production (V4 T2.7 G1 — browser traffic
 *   flows through the same-origin proxies since T2.1; no external origin
 *   remains — see REMAINING_EXTERNAL_ORIGINS), plus local API origins in
 *   development when gated
 * - default-src/object-src/form-action: hardened in production (V4 T2.7 G2);
 *   img-src/media-src keep blob:/data: so attachment previews
 *   (URL.createObjectURL) and audio playback keep working under
 *   default-src 'self' — PWA/Serwist compatibility guard
 * - frame-ancestors: none (equivalent to X-Frame-Options DENY)
 * - base-uri: self
 * - report-uri: same-origin violation endpoint (V4 T2.7/T0.4.8, SPEC §24.8)
 */
export function buildCspValue(nonce: string, allowUnsafeEval = false): string {
  const scriptSource = [
    `script-src 'self' 'nonce-${nonce}'`,
    ...(allowUnsafeEval ? ["'unsafe-eval'"] : []),
  ].join(" ");
  const connectSources = [
    "connect-src 'self'",
    ...REMAINING_EXTERNAL_ORIGINS,
    ...(allowUnsafeEval
      ? ["http://localhost:3001", "http://127.0.0.1:3001"]
      : []),
  ].join(" ");

  return [
    scriptSource,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    connectSources,
    "default-src 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}
