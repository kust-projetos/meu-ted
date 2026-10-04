/**
 * Web access (Part A, item 15): provider-abstracted search + SSRF-safe fetch.
 *
 * - Search providers resolve from env: TAVILY_API_KEY, then BRAVE_API_KEY.
 *   With neither, the provider reports `available: false` and the tool
 *   answers gracefully ("busca web indisponível") — no key is ever required
 *   in code or tests (fetchImpl is injectable, tests use mocks).
 * - webFetch only allows http/https, blocks private/loopback/link-local
 *   hosts and metadata IPs, follows at most 3 redirects (re-validated),
 *   times out in 10s and bounds the body in bytes and chars. Keys never
 *   appear in errors.
 * - V4.1 Phase 8 (SPEC §15.4): scheme/host/port checks and redirect
 *   re-validation delegate to `security/ssrf-guard.ts`; when a `lookup`
 *   resolver is provided, every hop is additionally validated against its
 *   resolved IPs (DNS-rebinding protection) and non-allowlisted ports are
 *   rejected (default 80/443).
 * - A11 (routing ii): the effective fetch target cannot be pinned on the
 *   Workers runtime, so every fetch additionally requires an operator
 *   egress allowlist (`TED_WEB_FETCH_ALLOWED_HOSTS`, CSV of exact hostnames).
 *   Unset/blank ⇒ `web_fetch` is unavailable by default and answers the
 *   graceful "desativado neste ambiente" message; a host outside the list is
 *   refused before any network call. Search providers keep their fixed hosts
 *   and are unaffected by this list.
 */

import {
  EGRESS_DISABLED_MESSAGE,
  EGRESS_NOT_ALLOWED_MESSAGE,
  assertSafeUrl as guardAssertSafeUrl,
  fetchWithSsrfGuard,
  isBlockedHostname,
  SsrfBlockedError,
  type HostResolver,
} from '../security/ssrf-guard.js';

export { EGRESS_DISABLED_MESSAGE, EGRESS_NOT_ALLOWED_MESSAGE };

/**
 * Operator env holding the egress allowlist for `web_fetch`: a CSV of exact
 * hostnames, e.g. `Upper.Example.com,news.test`. Default-off (unset/blank).
 */
export const WEB_FETCH_ALLOWED_HOSTS_ENV = 'TED_WEB_FETCH_ALLOWED_HOSTS';

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResult = {
  provider: 'tavily' | 'brave' | 'disabled';
  available: boolean;
  results: WebSearchResultItem[];
};

export type WebSearchProvider = {
  name: WebSearchResult['provider'];
  available: boolean;
  search: (query: string, opts?: { maxResults?: number }) => Promise<WebSearchResult>;
};

export type WebEnv = {
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
  TED_WEB_FETCH_ALLOWED_HOSTS?: string;
};

/**
 * Resolves the egress allowlist from the operator env. Entries are folded the
 * same way hostnames are (`Upper.Example.com.` → `upper.example.com`); a
 * malformed entry (scheme, port or path) is kept verbatim so it can never
 * match a hostname — the gate fails closed instead of guessing. Unset or
 * blank yields an empty set, i.e. `web_fetch` unavailable.
 */
export const parseWebFetchAllowedHosts = (raw: string | undefined): ReadonlySet<string> => {
  const hosts = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const host = entry.trim().toLowerCase().replace(/\.$/, '');
    if (host !== '') hosts.add(host);
  }
  return hosts;
};

/** Egress allowlist for a turn, resolved from the Worker env. */
export const resolveWebFetchAllowedHosts = (env: WebEnv | undefined): ReadonlySet<string> =>
  parseWebFetchAllowedHosts(env?.[WEB_FETCH_ALLOWED_HOSTS_ENV]);

const clampResults = (n: number | undefined): number => Math.min(Math.max(n ?? 5, 1), 10);

const tavilyProvider = (apiKey: string, fetchImpl: typeof fetch): WebSearchProvider => ({
  name: 'tavily',
  available: true,
  search: async (query, opts) => {
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: clampResults(opts?.maxResults), search_depth: 'basic' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`web search failed: HTTP ${res.status}`), { code: `http_${res.status}` });
    }
    const body = (await res.json().catch(() => null)) as {
      results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
    } | null;
    const results = (Array.isArray(body?.results) ? body!.results! : [])
      .filter((r) => typeof r.url === 'string' && (r.url as string).length > 0)
      .slice(0, 10)
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : String(r.url),
        url: String(r.url),
        snippet: typeof r.content === 'string' ? (r.content as string).slice(0, 500) : '',
      }));
    return { provider: 'tavily', available: true, results };
  },
});

const braveProvider = (apiKey: string, fetchImpl: typeof fetch): WebSearchProvider => ({
  name: 'brave',
  available: true,
  search: async (query, opts) => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${clampResults(opts?.maxResults)}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`web search failed: HTTP ${res.status}`), { code: `http_${res.status}` });
    }
    const body = (await res.json().catch(() => null)) as {
      web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
    } | null;
    const results = (Array.isArray(body?.web?.results) ? body!.web!.results! : [])
      .filter((r) => typeof r.url === 'string' && (r.url as string).length > 0)
      .slice(0, 10)
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : String(r.url),
        url: String(r.url),
        snippet: typeof r.description === 'string' ? (r.description as string).slice(0, 500) : '',
      }));
    return { provider: 'brave', available: true, results };
  },
});

const disabledProvider: WebSearchProvider = {
  name: 'disabled',
  available: false,
  search: async () => ({ provider: 'disabled', available: false, results: [] }),
};

export const WEB_UNAVAILABLE_MESSAGE = 'Busca web indisponível no momento — respondo com os dados do seu workspace.';

export const createWebSearchProvider = (
  env: WebEnv,
  fetchImpl: typeof fetch = fetch,
): WebSearchProvider => {
  if (env.TAVILY_API_KEY && env.TAVILY_API_KEY.trim() !== '') return tavilyProvider(env.TAVILY_API_KEY.trim(), fetchImpl);
  if (env.BRAVE_API_KEY && env.BRAVE_API_KEY.trim() !== '') return braveProvider(env.BRAVE_API_KEY.trim(), fetchImpl);
  return disabledProvider;
};

export class WebFetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchBlockedError';
  }
}

export const isBlockedFetchHost = (hostname: string): boolean => isBlockedHostname(hostname);

const rethrowAsFetchBlocked = (err: unknown): never => {
  if (err instanceof SsrfBlockedError) throw new WebFetchBlockedError(err.message);
  throw err;
};

export const assertFetchableUrl = (rawUrl: string, opts?: { allowedPorts?: number[] }): URL => {
  try {
    return guardAssertSafeUrl(rawUrl, opts);
  } catch (err) {
    return rethrowAsFetchBlocked(err);
  }
};

export type WebFetchResult = {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
};

export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_CHARS = 50_000;
/** Byte budget per read; mirrors `FETCH_MAX_BYTES` on the guard. */
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * SSRF-safe fetch: http/https only, no private hosts (re-validated on
 * every redirect hop), 10s budget, body bounded in bytes and chars. The
 * operator egress allowlist is mandatory (empty/omitted ⇒ blocked); when a
 * `lookup` is provided each hop is additionally validated against its
 * resolved IPs (DNS-rebinding protection, SPEC §15.4); `allowedPorts`
 * defaults to 80/443.
 */
export const webFetchUrl = async (
  rawUrl: string,
  opts?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxChars?: number;
    maxBytes?: number;
    lookup?: HostResolver;
    allowedHosts?: ReadonlySet<string>;
    allowedPorts?: number[];
  },
): Promise<WebFetchResult> => {
  try {
    return await fetchWithSsrfGuard(rawUrl, opts);
  } catch (err) {
    return rethrowAsFetchBlocked(err);
  }
};
