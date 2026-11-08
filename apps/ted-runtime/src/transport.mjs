// Fetch-based finance transport — P1 product.
//
// Deliberately NOT the spike's one-shot tsx bridge (child process into the
// API's in-memory test app) and NOT the PG/synthetic bridge: this transport
// speaks HTTP to a caller-provided baseUrl with a per-call device credential.
// Financial math is never reimplemented here — only plumbing (allowlist,
// timeout, abort, scrubbing) + typed fail-closed errors.
//
// AUTH CONTRACT (verified against the real API — never invented):
// - apps/api/src/routes/accounts.ts:42-46 and dashboard.ts:17-21 resolve
//   identity from `req.authenticatedContext` OR the `x-device-token` header
//   (apps/api/src/auth/device-token.ts:50). Device tokens are durable,
//   device-bound secrets resolving to {deviceId, householdId} server-side.
// - The delegated-bearer preHandler (routes/index.ts:452-555, iss
//   "pi-agent", `financial.read` for GET) is RECOGNIZED but NOT USED here:
//   delegated tokens expire in 300s (auth/delegated-token.ts:25-32), so a
//   bearer is not a durable identity, and issuance is forbidden outside
//   MutationExecutor (Agent) by the A4 gate — this runtime never mints,
//   holds, or sends delegated credentials. A generic `Authorization: Bearer`
//   with the device secret would ALSO be wrong (the preHandler ignores
//   non-pi-agent bearers, falling through to device resolution that would
//   then fail). Hence: `x-device-token` only, never `Authorization`.
// - Workspace selection is explicit AND server-side: the `x-workspace-id`
//   header carries ONLY the frozen host's household (never LLM args —
//   identity keys there are rejected by validateToolArgs). Without it, the
//   route fallback could resolve the token's origin household instead of the
//   selected workspace (device-access.ts:26-31: mismatch is 403).
// - Redirects are NEVER followed (`redirect: "manual"`): a 3xx becomes a
//   typed upstream error instead of re-sending the device secret to another
//   location. No production access: baseUrl is caller-provided (local/stub
//   in P1); nothing here defaults to any production origin.
//
// Allowlist (P1 read slice + P3 opt-in category/statement/card reads): exact
// pathnames GET /accounts, GET /cards/accounts, GET /dashboard/month-summary,
// GET /categories and GET /cards/statements. Query strings pass through to the
// real API (it owns domain validation). Prefix matching is forbidden. No POST,
// no propose/confirm/execute routes.

import { ToolError } from './tool-defs.mjs';

export { ToolError };

const ALLOWED_PATHS = new Set(['/accounts', '/cards/accounts', '/dashboard/month-summary', '/categories', '/cards/statements']);
const ALLOWED_METHODS = new Map([
  ['/accounts', new Set(['GET'])],
  ['/cards/accounts', new Set(['GET'])],
  ['/dashboard/month-summary', new Set(['GET'])],
  ['/categories', new Set(['GET'])],
  ['/cards/statements', new Set(['GET'])],
]);

export function isRouteAllowlisted(route) {
  if (typeof route !== 'string') return false;
  return ALLOWED_PATHS.has(route.split('?')[0]);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function assertLoopbackBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ToolError('tool.invalid_args', 'HttpFinanceTransport: baseUrl must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError('tool.invalid_args', 'HttpFinanceTransport: baseUrl must be http(s)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ToolError('tool.invalid_args', 'HttpFinanceTransport: baseUrl must not embed credentials');
  }
  // WHATWG URL keeps brackets on IPv6 literals (hostname === '[::1]').
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new ToolError(
      'tool.invalid_args',
      `HttpFinanceTransport: baseUrl must be loopback in this local cycle (got '${parsed.hostname}') — no secrets to unauthorized networks`,
    );
  }
  // Origin-only: `${baseUrl}${route}` concatenates strings, so a base with
  // path/search/hash would turn the allowlisted route into a query or a
  // sub-path — the secret would go to the wrong service/path and the
  // allowlist would be bypassed. Bare origin (trailing '/' tolerated).
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new ToolError(
      'tool.invalid_args',
      'HttpFinanceTransport: baseUrl must be a bare origin (no path, search or hash) — route concatenation must not be diverted',
    );
  }
  return parsed;
}

export function scrubSecrets(text, host) {
  let out = String(text);
  if (host && typeof host.token === 'string' && host.token.length > 0) {
    out = out.split(host.token).join('[redacted-token]');
  }
  return out;
}

export class HttpFinanceTransport {
  constructor({ baseUrl, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new ToolError('tool.invalid_args', 'HttpFinanceTransport: baseUrl (string, non-empty) is required');
    }
    assertLoopbackBaseUrl(baseUrl);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    // The executors receive this transport as a bare function
    // (`(args) => transport.call(args)` or destructured), so `call` must
    // not depend on receiver binding. Bind once, fail closed otherwise.
    this.call = this.call.bind(this);
  }

  async call({ route, method = 'GET', host, timeoutMs, signal } = {}) {
    if (!host || typeof host.token !== 'string' || host.token.length === 0) {
      throw new ToolError('tool.invalid_args', 'host-bound token is required (never a tool arg)');
    }
    // device-access.ts:26-31: with x-workspace-id the API resolves the
    // device against the SELECTED workspace (403 on mismatch); without it
    // the route fallback may resolve the token's origin household instead.
    // The header comes EXCLUSIVELY from the frozen server-side host —
    // identity keys in tool args are already rejected by validateToolArgs.
    if (!host || typeof host.household !== 'string' || host.household.length === 0) {
      throw new ToolError('tool.invalid_args', 'host-bound household (workspace) is required — selection must be explicit, never defaulted');
    }
    if (!isRouteAllowlisted(route)) {
      throw new ToolError('tool.invalid_args', `route not allowlisted: ${route}`);
    }
    const pathname = String(route).split('?')[0];
    const methods = ALLOWED_METHODS.get(pathname);
    if (!methods || !methods.has(method)) {
      throw new ToolError('tool.invalid_args', `method not allowlisted for route: ${method} ${pathname}`);
    }
    if (signal && signal.aborted) {
      throw new ToolError('tool.cancelled', `finance call cancelled before execution (route ${route})`);
    }
    const limit = typeof timeoutMs === 'number' ? timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), limit);
    if (timer.unref) timer.unref();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        // Device-bound credential + explicit workspace selection per the
        // real contract (see header note). Never `Authorization`, never
        // workspace from query/args (server-side selection only).
        headers: { 'x-device-token': host.token, 'x-workspace-id': host.household, accept: 'application/json' },
        // Never follow redirects with the device secret: a 3xx is handled
        // below as a typed upstream error (fail-closed, no forwarding).
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        throw new ToolError('tool.upstream_error', `finance call not followed: upstream redirect ${res.status} (route ${route})`, { statusCode: res.status });
      }
      const body = await res.json().catch(() => null);
      if (body === null) {
        throw new ToolError('tool.transport', `malformed upstream payload (route ${route})`);
      }
      return { statusCode: res.status, body };
    } catch (e) {
      if (e instanceof ToolError) throw e; // typed fail-closed codes (redirect/timeout/cancelled) never wrapped
      if (e && e.code === 'tool.cancelled') throw e;
      if (e && (e.name === 'AbortError' || e.code === 20)) {
        // Distinguish caller abort (tool.cancelled) from our timeout.
        if (signal && signal.aborted) {
          throw new ToolError('tool.cancelled', `finance call cancelled (route ${route})`);
        }
        throw new ToolError('tool.timeout', `finance call timed out after ${limit}ms (route ${route})`);
      }
      throw new ToolError('tool.transport', `finance transport failed (route ${route})`);
    } finally {
      clearTimeout(timer);
      try { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort); } catch { /* settle never fails */ }
    }
  }
}
