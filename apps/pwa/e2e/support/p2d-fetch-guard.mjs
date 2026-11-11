// P2D live-real fetch guard — allowlist-only interposition for the isolated
// runtime child (test-only infra, never bundled).
//
// Facts confirmed against the installed OpenCode 2.2.4 source:
// - the official model catalog is fetched from
//   `https://models.opencode.ai/experimental/v2.0/api.json` with a plain GET
//   (only `User-Agent` and an optional `If-None-Match`, no credentials) and
//   the observed filter `?type=chat,decision,image` — no `embedding`, no
//   `Accept`;
// - the `opencode-go` provider inference base URL is
//   `https://opencode.ai/inference/go/...` (HTTPS, port 443).
//
// The SAME child process also talks to the synthetic Fastify API over
// loopback (`resolveGatewayIdentity` + `HttpFinanceTransport`). That traffic
// is NOT external egress, but it is not a blanket localhost release either:
// only the EXACT declared origin (`http://127.0.0.1:<port>`) and the exact
// contract pairs the runtime already sends are admitted, with per-route
// header/body allowlists. `localhost`, `::1`, another port, another path,
// any query outside the contract, any credential header and any write are
// denied.
//
// The guard is deliberately narrow: it intercepts `globalThis.fetch` only
// (never a proxy/server and never an OS sandbox) and decides BEFORE any
// socket is opened. Requests are forced to `redirect: "manual"` and a
// redirect response fails closed, so the credential can never be forwarded to
// another host by a redirect chain.
//
// Observation posture: only fixed categories, counts and HTTP statuses are
// recorded. URLs, paths, bodies and header values are never stored, returned
// or logged. The single exception is the non-secret `model` identifier of an
// OpenAI-compatible inference request body (metadata only, never the body).
//
// Model pin (fail-closed, pre-socket): every inference POST must be the
// OpenAI-compatible `/chat/completions` shape and its JSON `model` must equal
// the id resolved from `apps/ted-runtime/src/live-model.json` (passed as
// `expectedModelID`). A missing body, invalid JSON or divergent model throws
// BEFORE `fetchImpl` runs, so a provider fallback can never receive the
// credential; only fixed reason codes/counters are recorded.
import { isIP } from "node:net";

export const LIVE_REAL_CATALOG_URL = "https://models.opencode.ai/experimental/v2.0/api.json";
export const LIVE_REAL_CATALOG_HOST = "models.opencode.ai";
export const LIVE_REAL_CATALOG_PATH = "/experimental/v2.0/api.json";
export const LIVE_REAL_INFERENCE_HOST = "opencode.ai";
export const LIVE_REAL_INFERENCE_PREFIX = "/inference/go/";
// OpenAI-compatible chat endpoint the provider client posts to. The pinned
// `model` lives in this JSON body, so only this exact suffix is admitted.
export const LIVE_REAL_INFERENCE_SUFFIX = "/chat/completions";
export const LIVE_REAL_FETCH_GUARD = "live-real-allowlist";

// Contract pairs the runtime already sends to the synthetic API (verified in
// apps/ted-runtime/src/gateway.mjs and src/transport.mjs). Nothing else is
// reachable — no write, only the explicitly listed read routes.
export const LIVE_REAL_API_ROUTES = Object.freeze([
  "POST /auth/agent-token",
  "GET /auth/devices/me",
  "GET /accounts",
  "GET /cards/accounts",
  "GET /dashboard/month-summary",
  "GET /categories",
  "GET /cards/statements",
  // V1 completion reads (all GET, loopback-only).
  "GET /transactions",
  "GET /insights/spending",
  "GET /analytics/kpis",
  "GET /analytics/category-breakdown",
  "GET /analytics/cashflow-series",
  "GET /analytics/budget-consumption",
  "GET /analytics/net-worth-history",
  "GET /budgets",
  "GET /budgets/check",
  "GET /goals",
  "GET /payables",
  "GET /payables/reminders",
  "GET /audit-logs",
]);

const BUDGET_TRENDS_ROUTE_RE = /^GET \/budgets\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/trends$/;
const READ_ANY_QUERY = new Set([
  "GET /transactions",
  "GET /insights/spending",
  "GET /analytics/kpis",
  "GET /analytics/category-breakdown",
  "GET /analytics/cashflow-series",
  "GET /analytics/budget-consumption",
  "GET /analytics/net-worth-history",
  "GET /budgets/check",
  "GET /goals",
  "GET /payables",
  "GET /audit-logs",
]);
const READ_HEADERS = Object.freeze(["x-device-token", "x-workspace-id", "accept"]);

const API_ROUTE_HEADERS = new Map([
  ["POST /auth/agent-token", Object.freeze(["cookie", "x-workspace-id", "x-device-token", "content-type", "accept"])],
  ["GET /auth/devices/me", Object.freeze(["x-device-token", "accept"])],
  ["GET /accounts", Object.freeze(["x-device-token", "x-workspace-id", "accept"])],
  ["GET /cards/accounts", Object.freeze(["x-device-token", "x-workspace-id", "accept"])],
  ["GET /dashboard/month-summary", Object.freeze(["x-device-token", "x-workspace-id", "accept"])],
  ["GET /categories", Object.freeze(["x-device-token", "x-workspace-id", "accept"])],
  ["GET /cards/statements", Object.freeze(["x-device-token", "x-workspace-id", "accept"])],
  ["GET /transactions", READ_HEADERS],
  ["GET /insights/spending", READ_HEADERS],
  ["GET /analytics/kpis", READ_HEADERS],
  ["GET /analytics/category-breakdown", READ_HEADERS],
  ["GET /analytics/cashflow-series", READ_HEADERS],
  ["GET /analytics/budget-consumption", READ_HEADERS],
  ["GET /analytics/net-worth-history", READ_HEADERS],
  ["GET /budgets", READ_HEADERS],
  ["GET /budgets/check", READ_HEADERS],
  ["GET /goals", READ_HEADERS],
  ["GET /payables", READ_HEADERS],
  ["GET /payables/reminders", READ_HEADERS],
  ["GET /audit-logs", READ_HEADERS],
]);

function allowedApiHeaders(route) {
  const exact = API_ROUTE_HEADERS.get(route);
  if (exact) return exact;
  if (BUDGET_TRENDS_ROUTE_RE.test(route)) return READ_HEADERS;
  return undefined;
}

const CATALOG_ALLOWED_HEADERS = Object.freeze(["user-agent", "if-none-match"]);
// Catalog filter tokens the installed OpenCode 2.2.4 source actually sends:
// `?type=chat,decision,image`. `embedding` is NOT requested by the source and
// is therefore refused (least privilege); `Accept` is not sent either, so it
// stays outside the header allowlist.
const CATALOG_TYPE_TOKENS = new Set(["chat", "decision", "image"]);
const MONTH_QUERY_RE = /^\?yearMonth=(\d{4})-(0[1-9]|1[0-2])$/;
const ACCOUNTS_QUERY_RE = /^(?:\?kind=(bank|cash|credit_card)(?:&includeInactive=(true|false))?|\?includeInactive=(true|false))$/;
const CATEGORY_QUERY_RE = /^\?kind=(expense|income)$/;
// GET /cards/statements query contract (apps/api/src/routes/cards.ts:86-90
// querySchema + tool-defs.mjs routeFor): all optional, any valid subset, any
// order. accountId is a uuid; status is the enum; limit is a canonical 1-50
// integer (tool-defs emits String(integer), never a coerced/leading-zero form).
const STATEMENTS_ACCOUNT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const STATEMENTS_STATUS = new Set(["open", "closed", "paid", "partial", "overdue", "cancelled"]);
const STATEMENTS_LIMIT_RE = /^([1-9]|[1-4][0-9]|50)$/;
function statementsQueryAllowed(search) {
  if (search === "") return true;
  if (!search.startsWith("?")) return false;
  const body = search.slice(1);
  if (body === "") return false;
  const parts = body.split("&");
  if (parts.length > 3) return false;
  const seen = new Set();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (value.length === 0 || value.includes("=")) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "accountId") {
      if (!STATEMENTS_ACCOUNT_ID_RE.test(value)) return false;
    } else if (key === "status") {
      if (!STATEMENTS_STATUS.has(value)) return false;
    } else if (key === "limit") {
      if (!STATEMENTS_LIMIT_RE.test(value)) return false;
    } else {
      return false;
    }
  }
  return true;
}
// Header NAMES that look like credentials. Applied only after the per-route
// allowlist, so `x-device-token`/`cookie` stay allowed exactly where the
// existing contract sends them.
const CREDENTIAL_HEADER_RE = /(?:authorization|cookie|api[-_]?key|token|secret|credential|session|password)/i;
const LOOPBACK_LIKE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

function inputUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  try {
    return String(input);
  } catch {
    return "";
  }
}

function inputMethod(input, init) {
  if (init && typeof init.method === "string" && init.method.length > 0) return init.method.toUpperCase();
  if (input && typeof input === "object" && typeof input.method === "string" && input.method.length > 0) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function headerValue(headers, name) {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value : null;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === wanted) return String(pair[1]);
    }
    return null;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return typeof value === "string" ? value : String(value);
    }
  }
  return null;
}

function headerNames(headers) {
  const names = new Set();
  if (!headers) return names;
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    headers.forEach((_value, key) => names.add(String(key).toLowerCase()));
    return names;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair)) names.add(String(pair[0]).toLowerCase());
    }
    return names;
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) names.add(key.toLowerCase());
  }
  return names;
}

function isRequestLike(input) {
  return typeof Request !== "undefined" && input instanceof Request;
}

function requestHeaders(input, init) {
  const merged = new Set();
  for (const name of headerNames(init && init.headers)) merged.add(name);
  if (isRequestLike(input)) for (const name of headerNames(input.headers)) merged.add(name);
  return merged;
}

function requestBody(input, init) {
  if (init && init.body !== undefined && init.body !== null) return init.body;
  if (isRequestLike(input)) return input.body;
  return null;
}

function hasAuthorization(input, init) {
  if (headerValue(init && init.headers, "authorization") !== null) return true;
  if (input && typeof input === "object" && headerValue(input.headers, "authorization") !== null) return true;
  return false;
}

/**
 * Parses the declared synthetic-API origin. Accepts ONLY a bare
 * `http://127.0.0.1:<explicit port>` (trailing `/` tolerated) — never
 * `localhost`, `::1`, another host, another scheme, userinfo, path, query,
 * hash or an implicit port. Returns the normalized origin or `null`.
 */
export function parseLiveRealApiOrigin(apiOrigin) {
  if (typeof apiOrigin !== "string" || apiOrigin.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(apiOrigin);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname !== "127.0.0.1") return null;
  if (parsed.port === "") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return `http://127.0.0.1:${parsed.port}`;
}

function catalogQueryAllowed(search) {
  if (search === "") return true;
  const match = /^\?type=([a-z]+(?:,[a-z]+)*)$/.exec(search);
  if (!match) return false;
  const tokens = match[1].split(",");
  if (new Set(tokens).size !== tokens.length) return false;
  return tokens.every((token) => CATALOG_TYPE_TOKENS.has(token));
}

function classifyCatalog(input, init, parsed, method) {
  if (parsed.pathname !== LIVE_REAL_CATALOG_PATH) return { action: "deny", reason: "catalog_path" };
  if (method !== "GET") return { action: "deny", reason: "catalog_method" };
  if (!catalogQueryAllowed(parsed.search)) return { action: "deny", reason: "catalog_query" };
  if (hasAuthorization(input, init)) return { action: "deny", reason: "catalog_authorization" };
  for (const name of requestHeaders(input, init)) {
    if (CATALOG_ALLOWED_HEADERS.includes(name)) continue;
    return {
      action: "deny",
      reason: CREDENTIAL_HEADER_RE.test(name) ? "catalog_credential_header" : "catalog_header",
    };
  }
  return { action: "allow-catalog", reason: "catalog" };
}

function classifyApi(input, init, parsed, method) {
  const route = `${method} ${parsed.pathname}`;
  const allowedHeaders = allowedApiHeaders(route);
  if (!allowedHeaders) return { action: "deny", reason: "api_method_path" };
  const queryOk = parsed.pathname === "/dashboard/month-summary"
    ? MONTH_QUERY_RE.test(parsed.search)
    : parsed.pathname === "/accounts"
      ? parsed.search === "" || ACCOUNTS_QUERY_RE.test(parsed.search)
      : parsed.pathname === "/categories"
      ? parsed.search === "" || CATEGORY_QUERY_RE.test(parsed.search)
    : parsed.pathname === "/cards/statements"
      ? statementsQueryAllowed(parsed.search)
      : READ_ANY_QUERY.has(route) || BUDGET_TRENDS_ROUTE_RE.test(route)
        ? true
      : parsed.search === "";
  if (!queryOk) return { action: "deny", reason: "api_query" };
  for (const name of requestHeaders(input, init)) {
    if (allowedHeaders.includes(name)) continue;
    return {
      action: "deny",
      reason: CREDENTIAL_HEADER_RE.test(name) ? "api_credential_header" : "api_header",
    };
  }
  const body = requestBody(input, init);
  if (route === "POST /auth/agent-token") {
    if (typeof body !== "string" || body.trim() !== "{}") return { action: "deny", reason: "api_body" };
    const contentType =
      headerValue(init && init.headers, "content-type") ??
      (isRequestLike(input) ? headerValue(input.headers, "content-type") : null);
    if (contentType === null || !/^application\/json\b/i.test(String(contentType).trim())) {
      return { action: "deny", reason: "api_content_type" };
    }
  } else if (body !== null && body !== undefined) {
    return { action: "deny", reason: "api_body" };
  }
  return { action: "allow-api", reason: "api" };
}

/**
 * Pure classification (no network): returns
 * `{ action: "allow-catalog" | "allow-inference" | "allow-api" | "deny", reason }`.
 * Deny reasons are fixed short codes, safe to count.
 *
 * `options.apiOrigin` is the EXACT synthetic API origin. When the option is
 * present it must be valid (invalid → every request is denied); when absent
 * the loopback branch is simply not available.
 */
export function classifyLiveRealRequest(input, init, options = {}) {
  const method = inputMethod(input, init);
  let parsed;
  try {
    parsed = new URL(inputUrl(input));
  } catch {
    return { action: "deny", reason: "invalid_url" };
  }
  if (parsed.username !== "" || parsed.password !== "") return { action: "deny", reason: "credentials_in_url" };
  if (parsed.hash !== "") return { action: "deny", reason: "fragment" };

  const declaresApiOrigin = Boolean(options) && Object.prototype.hasOwnProperty.call(options, "apiOrigin");
  const apiOrigin = declaresApiOrigin ? parseLiveRealApiOrigin(options.apiOrigin) : null;
  if (declaresApiOrigin && apiOrigin === null) return { action: "deny", reason: "api_origin_invalid" };
  if (apiOrigin !== null) {
    // Loopback API branch FIRST — before the HTTPS/IP rules below.
    if (parsed.origin === apiOrigin) return classifyApi(input, init, parsed, method);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (LOOPBACK_LIKE_HOSTS.has(hostname)) return { action: "deny", reason: "api_origin_mismatch" };
  }

  if (parsed.protocol !== "https:") return { action: "deny", reason: "not_https" };
  if (parsed.port !== "" && parsed.port !== "443") return { action: "deny", reason: "alternate_port" };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname) !== 0) return { action: "deny", reason: "ip_literal" };

  if (hostname === LIVE_REAL_CATALOG_HOST) return classifyCatalog(input, init, parsed, method);
  if (hostname === LIVE_REAL_INFERENCE_HOST) {
    if (!parsed.pathname.startsWith(LIVE_REAL_INFERENCE_PREFIX)) {
      return { action: "deny", reason: "inference_path" };
    }
    // Only the OpenAI-compatible chat POST is admitted: it is the ONE shape
    // whose JSON body carries the pinned `model`, so the model can be
    // validated before any socket opens. Any other inference method/shape
    // fails closed (a request whose model cannot be pinned is not allowed).
    if (method !== "POST") return { action: "deny", reason: "inference_method" };
    if (!parsed.pathname.endsWith(LIVE_REAL_INFERENCE_SUFFIX)) {
      return { action: "deny", reason: "inference_shape" };
    }
    return { action: "allow-inference", reason: "inference" };
  }
  return { action: "deny", reason: "destination" };
}

// Non-secret inference metadata: the OpenAI-compatible `model` identifier,
// validated from the request body BEFORE `fetchImpl` is ever called. The body
// itself is never stored, returned or logged — only the pinned identifier is
// kept (bounded) and fixed failure reason codes are counted.
const INFERENCE_BODY_MAX_CHARS = 262144;
const MODEL_ID_RE = /^[A-Za-z0-9._/-]{1,80}$/;

function bodyText(body) {
  if (typeof body === "string") return body;
  if (typeof Uint8Array !== "undefined" && body instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(body);
    } catch {
      return null;
    }
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    try {
      return new TextDecoder().decode(new Uint8Array(body));
    } catch {
      return null;
    }
  }
  return null;
}

// `Request + init` precedence: `init.body` is what fetch actually sends; a
// Request's own body is only read from a CLONE (the original stream stays
// untouched for the real call).
async function inferenceRequestBody(input, init) {
  if (init && init.body !== undefined && init.body !== null) return init.body;
  if (isRequestLike(input)) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

async function validateInferenceModel(input, init, expectedModelID) {
  const body = await inferenceRequestBody(input, init);
  if (body === null) return { ok: false, reason: "inference_body" };
  const text = bodyText(body);
  if (text === null || text.length === 0 || text.length > INFERENCE_BODY_MAX_CHARS) {
    return { ok: false, reason: "inference_body" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "inference_body" };
  }
  const model = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.model : null;
  if (typeof model !== "string" || !MODEL_ID_RE.test(model) || model !== expectedModelID) {
    return { ok: false, reason: "inference_model" };
  }
  return { ok: true, model };
}

function pushBounded(list, value, max = 32) {
  if (list.length < max) list.push(value);
}

/**
 * Wraps a fetch implementation with the allowlist + manual-redirect policy.
 * `apiOrigin` is REQUIRED (the exact synthetic API origin; fail-closed) and
 * `expectedModelID` is REQUIRED (the model id pinned by
 * `apps/ted-runtime/src/live-model.json`) — without it no inference POST may
 * open a socket, so a silent provider/model fallback can never receive the
 * credential. `stats` only carries fixed categories, counts, status codes and
 * the pinned model identifier.
 */
export function createLiveRealFetchGuard({ fetchImpl, apiOrigin, expectedModelID } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("p2d-fetch-guard: fetchImpl (function) is required (fail-closed)");
  }
  const normalizedApiOrigin = parseLiveRealApiOrigin(apiOrigin);
  if (normalizedApiOrigin === null) {
    throw new Error(
      "p2d-fetch-guard: apiOrigin (bare http://127.0.0.1:<port>) is required (fail-closed)",
    );
  }
  if (typeof expectedModelID !== "string" || !MODEL_ID_RE.test(expectedModelID)) {
    throw new Error(
      "p2d-fetch-guard: expectedModelID (pinned live-model.json model id) is required (fail-closed)",
    );
  }
  const stats = {
    catalogAllowed: 0,
    inferenceAttempts: 0,
    inferenceAllowed: 0,
    inferenceFailures: 0,
    apiAllowed: 0,
    apiBlocked: 0,
    blocked: 0,
    redirectsBlocked: 0,
    // Aggregated counts of real block reasons (fixed short codes only — no
    // URL, header or credential value is ever stored here).
    blockedReasons: {},
    catalogStatuses: [],
    inferenceStatuses: [],
    apiStatuses: [],
    inferenceModels: [],
  };

  const guardedFetch = async (input, init) => {
    const classified = classifyLiveRealRequest(input, init, { apiOrigin: normalizedApiOrigin });
    if (classified.action === "deny") {
      stats.blocked += 1;
      if (classified.reason.startsWith("api_")) stats.apiBlocked += 1;
      stats.blockedReasons[classified.reason] = (stats.blockedReasons[classified.reason] ?? 0) + 1;
      throw new Error(`guard: live-real fetch blocked (${classified.reason})`);
    }
    // Pre-socket model pin: the body is parsed and compared with the resolved
    // live-model.json model id BEFORE fetchImpl runs. A missing body, invalid
    // JSON or divergent model fails closed with a fixed reason code — only
    // counters are recorded, never the body.
    let inferenceModel = null;
    if (classified.action === "allow-inference") {
      stats.inferenceAttempts += 1;
      const modelCheck = await validateInferenceModel(input, init, expectedModelID);
      if (!modelCheck.ok) {
        stats.inferenceFailures += 1;
        stats.blocked += 1;
        stats.blockedReasons[modelCheck.reason] = (stats.blockedReasons[modelCheck.reason] ?? 0) + 1;
        throw new Error(`guard: live-real fetch blocked (${modelCheck.reason})`);
      }
      inferenceModel = modelCheck.model;
    }
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    // Request form: the caller-supplied init MUST be carried into the clone —
    // discarding it would silently drop headers/body/signal. URL form: force
    // `redirect: "manual"` on the init passed to fetch. Both forms force
    // manual redirects so a 3xx can never be followed to another host.
    const response = isRequest
      ? await fetchImpl(new Request(input, { ...(init || {}), redirect: "manual" }))
      : await fetchImpl(input, { ...(init || {}), redirect: "manual" });
    if (
      (response && typeof response.status === "number" && response.status >= 300 && response.status < 400) ||
      (response && response.redirected === true)
    ) {
      stats.redirectsBlocked += 1;
      stats.blockedReasons.redirect = (stats.blockedReasons.redirect ?? 0) + 1;
      throw new Error("guard: live-real redirect blocked (fail-closed)");
    }
    const category =
      classified.action === "allow-catalog" ? "catalog" : classified.action === "allow-api" ? "api" : "inference";
    stats[`${category}Allowed`] += 1;
    if (response && typeof response.status === "number") {
      pushBounded(stats[`${category}Statuses`], response.status);
      if (category === "inference" && (response.status < 200 || response.status >= 300)) {
        stats.inferenceFailures += 1;
      }
    }
    if (category === "inference" && inferenceModel !== null) {
      pushBounded(stats.inferenceModels, inferenceModel, 8);
    }
    return response;
  };

  return { fetch: guardedFetch, stats };
}
