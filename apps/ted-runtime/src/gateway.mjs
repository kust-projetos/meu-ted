// TED gateway identity resolution — P1 product (server-side only).
//
// Resolves actor/workspace/device EXCLUSIVELY from the existing API
// authority over loopback HTTP. The gateway never trusts workspace / actor /
// device / session IDs from tool args, request bodies, or browser-supplied
// fields as authorization — only the three server-side sources below:
//
//   1. Better-Auth session, verified server-side: the forwarded `cookie`
//      header is presented to `POST /auth/agent-token`, which resolves the
//      session inside the API (401 when absent/invalid). The cookie value
//      itself is opaque to the gateway — it is forwarded, never parsed for
//      identity, never logged.
//   2. Device context, resolved server-side: the presented `x-device-token`
//      is resolved via `GET /auth/devices/me` to { deviceId, householdId }.
//      Missing/invalid device token fails closed (no anonymous device).
//   3. Canonical workspace/role/membership, issued server-side:
//      `POST /auth/agent-token` (cookie + x-workspace-id + x-device-token)
//      returns { token, workspace, role } after membership revalidation.
//      The workspace in the response is canonical — the gateway uses it,
//      never the requested string, for every downstream check.
//
// Agreement rule: cookie session (proven by a successful mint), the
// API-issued canonical workspace/role, and the device household/deviceId
// must all agree — device.householdId === canonical workspace, and the
// JWT device claim (when the authority binds one) === resolved deviceId.
// Any disagreement fails closed before any OpenCode handle is touched.
//
// Credential hygiene: secrets (cookie header, device token, minted
// connection token) live only in process memory for the duration of the
// call, travel only to the loopback API origin, and never enter logs,
// traces, error text, or persisted records. `redactForLog` strips them
// from any object before logging.

export class GatewayError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.details = details;
    if (details && typeof details.statusCode === 'number') this.statusCode = details.statusCode;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Explicit, exact-origin allowlist for a co-located deployment (Docker
// network): the API travels over plain HTTP inside the private network, so
// the loopback rule alone cannot express it. Every entry is validated with
// the same strict bare-origin rules and compared by exact `URL.origin` —
// the allowlist can never widen to a prefix, a wildcard, or a public host.
export function parseAllowedApiOrigins(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  const origins = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new GatewayError('gateway.invalid_origin', 'gateway: TED_API_ALLOWED_ORIGINS entry must be an absolute http(s) origin');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new GatewayError('gateway.invalid_origin', 'gateway: TED_API_ALLOWED_ORIGINS entry must be http(s)');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new GatewayError('gateway.invalid_origin', 'gateway: TED_API_ALLOWED_ORIGINS entry must not embed credentials');
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (LOOPBACK_HOSTS.has(hostname)) {
      throw new GatewayError('gateway.invalid_origin', 'gateway: TED_API_ALLOWED_ORIGINS must not repeat a loopback origin (already allowed)');
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new GatewayError('gateway.invalid_origin', 'gateway: TED_API_ALLOWED_ORIGINS entry must be a bare origin (no path, search or hash)');
    }
    origins.push(parsed.origin);
  }
  return origins;
}

function assertBareOrigin(apiBaseUrl) {
  let parsed;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new GatewayError('gateway.invalid_origin', 'gateway: apiBaseUrl must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayError('gateway.invalid_origin', 'gateway: apiBaseUrl must be http(s)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new GatewayError('gateway: apiBaseUrl must not embed credentials');
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new GatewayError(
      'gateway.invalid_origin',
      'gateway: apiBaseUrl must be a bare origin (no path, search or hash)',
    );
  }
  return parsed;
}

export function assertLoopbackApiOrigin(apiBaseUrl, { allowedOrigins = [] } = {}) {
  const parsed = assertBareOrigin(apiBaseUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(hostname)) return parsed;
  const allowlist = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  if (allowlist.includes(parsed.origin)) return parsed;
  throw new GatewayError(
    'gateway.invalid_origin',
    'gateway: apiBaseUrl must be loopback or an explicitly allowlisted internal origin (TED_API_ALLOWED_ORIGINS) — no secrets to unlisted origins',
  );
}

// Keys whose VALUES must never appear in logs/traces/errors.
const SECRET_KEYS = new Set([
  'cookie', 'Cookie', 'set-cookie', 'set-Cookie',
  'x-device-token', 'X-Device-Token',
  'token', 'deviceToken', 'device_token',
  'authorization', 'Authorization',
]);

export function redactForLog(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) ? '[redacted]' : redactForLog(v);
    }
    return out;
  }
  return value;
}

function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) throw new GatewayError('gateway.bad_token', 'gateway: authority token is not a JWT');
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    throw new GatewayError('gateway.bad_token', 'gateway: authority token payload is unreadable');
  }
}

async function fetchJson({ fetchImpl, url, init, timeoutMs, what }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  const onAbort = () => controller.abort();
  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      throw new GatewayError('gateway.cancelled', `gateway: ${what} cancelled before execution`);
    }
    if (typeof callerSignal.addEventListener === 'function') {
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  let res;
  try {
    res = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 20)) {
      if (callerSignal && callerSignal.aborted) {
        throw new GatewayError('gateway.cancelled', `gateway: ${what} cancelled`);
      }
      throw new GatewayError('gateway.timeout', `gateway: ${what} timed out after ${timeoutMs}ms`);
    }
    throw new GatewayError('gateway.transport', `gateway: ${what} transport failed`);
  } finally {
    clearTimeout(timer);
    try {
      if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
        callerSignal.removeEventListener('abort', onAbort);
      }
    } catch { /* settle never fails */ }
  }
  if (res.status >= 300 && res.status < 400) {
    throw new GatewayError('gateway.upstream_redirect', `gateway: ${what} redirected (never followed with credentials)`, { statusCode: res.status });
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function mapAgentTokenStatus(status) {
  if (status === 401) return 'auth.session_required';
  if (status === 403) return 'auth.workspace_forbidden';
  if (status === 400) return 'auth.workspace_required';
  return 'gateway.upstream_error';
}

// Server-side identity resolution. All inputs are TRANSPORT material, not
// authorization claims: cookie proves nothing until the API mints, and
// workspaceId is a selection hint — the canonical workspace comes back
// from the authority and is what every downstream check uses.
//
// Returns { actorId, workspace, role, deviceId, deviceHousehold } — the
// minted connection token itself is NOT returned (in-memory only, held by
// the caller when needed for the current turn, never persisted/logged).
export async function resolveGatewayIdentity({
  apiBaseUrl,
  cookie,
  deviceToken,
  workspaceId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  signal,
  allowedApiOrigins = [],
} = {}) {
  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.length === 0) {
    throw new GatewayError('gateway.invalid_args', 'gateway: apiBaseUrl is required');
  }
  assertLoopbackApiOrigin(apiBaseUrl, { allowedOrigins: allowedApiOrigins });
  const origin = apiBaseUrl.replace(/\/+$/, '');
  if (typeof cookie !== 'string' || cookie.length === 0) {
    throw new GatewayError('auth.session_required', 'gateway: session cookie is required');
  }
  if (typeof deviceToken !== 'string' || deviceToken.length === 0) {
    throw new GatewayError('auth.device_required', 'gateway: device token is required (never anonymous)');
  }
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new GatewayError('auth.workspace_required', 'gateway: workspace selection is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new GatewayError('gateway.invalid_args', 'gateway: fetchImpl is required');
  }

  // 1 + 3. Mint verifies the Better-Auth session server-side AND
  // revalidates membership, returning the canonical workspace/role.
  const mint = await fetchJson({
    fetchImpl,
    url: `${origin}/auth/agent-token`,
    init: {
      method: 'POST',
      headers: {
        cookie,
        'x-workspace-id': workspaceId,
        'x-device-token': deviceToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
      signal,
    },
    timeoutMs,
    what: 'agent-token mint',
  });
  if (mint.status !== 200 || !mint.body || typeof mint.body !== 'object') {
    throw new GatewayError(
      mapAgentTokenStatus(mint.status),
      'gateway: session/workspace verification failed',
      { statusCode: mint.status },
    );
  }
  const { token, workspace, role } = mint.body;
  if (typeof token !== 'string' || token.length === 0) {
    throw new GatewayError('gateway.bad_token', 'gateway: authority mint returned no token');
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new GatewayError('gateway.bad_token', 'gateway: authority mint returned no canonical workspace');
  }
  const claims = decodeJwtPayload(token);
  const actorId = claims.sub;
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new GatewayError('gateway.bad_token', 'gateway: authority token carries no subject');
  }

  // 2. Device context resolved server-side from the presented token.
  const device = await fetchJson({
    fetchImpl,
    url: `${origin}/auth/devices/me`,
    init: {
      method: 'GET',
      headers: { 'x-device-token': deviceToken, accept: 'application/json' },
      signal,
    },
    timeoutMs,
    what: 'device resolution',
  });
  if (device.status === 401 || device.status === 403) {
    throw new GatewayError('auth.device_required', 'gateway: device token invalid or revoked', { statusCode: device.status });
  }
  if (device.status !== 200 || !device.body || typeof device.body !== 'object') {
    throw new GatewayError('gateway.upstream_error', 'gateway: device resolution failed', { statusCode: device.status });
  }
  const { deviceId, householdId } = device.body;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new GatewayError('gateway.bad_device', 'gateway: authority returned no deviceId');
  }
  if (typeof householdId !== 'string' || householdId.length === 0) {
    throw new GatewayError('gateway.bad_device', 'gateway: authority returned no device household');
  }

  // Agreement: device household MUST equal the canonical mint workspace —
  // a device from workspace B can never act inside workspace A.
  if (householdId !== workspace) {
    throw new GatewayError('auth.workspace_forbidden', 'gateway: device workspace disagrees with canonical workspace');
  }
  // When the authority binds the mint to a device, it must be THIS device.
  if (typeof claims.deviceId === 'string' && claims.deviceId.length > 0 && claims.deviceId !== deviceId) {
    throw new GatewayError('auth.workspace_forbidden', 'gateway: minted device disagrees with resolved device');
  }

  return { actorId, workspace, role: typeof role === 'string' ? role : 'member', deviceId, deviceHousehold: householdId };
}
