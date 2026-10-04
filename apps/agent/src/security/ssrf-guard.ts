/**
 * SSRF guard (V4.1 Phase 8, tasks 8.4-8.5, SPEC §15.4).
 *
 * Complements the hostname-pattern checks with:
 * - an operator egress allowlist (A11 routing ii): the effective fetch target
 *   cannot be pinned on the Workers runtime (no per-hop DNS resolution, no
 *   SNI/IP separation), so the guard fails closed unless the caller passes an
 *   explicit `allowedHosts` set. The check is exact-hostname and
 *   DNS-independent, and runs before any fetch — a non-allowlisted hostname
 *   never reaches the network, on the first hop nor on a redirect;
 * - resolved-IP validation (DNS rebinding): when a `lookup` resolver IS
 *   injected, every address a hostname resolves to must be public —
 *   IPv4/IPv6 private, loopback, link-local, multicast, unspecified and
 *   IPv4-mapped ranges are blocked;
 * - port allowlist (default 80/443);
 * - per-hop re-validation on redirects with a redirect cap;
 * - a byte budget applied while the body stream is read (A11/V8).
 *
 * The module has no runtime imports: DNS resolution is always injected
 * (`HostResolver`) and the allowlist is always resolved by the caller, so the
 * same guard runs in Cloudflare Workers (platform egress + hostname/port
 * checks) and in Node/test contexts (full resolved-IP validation). Both the
 * allowlist and DNS failures fail closed.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Resolves a hostname to all addresses (A + AAAA). Must throw on failure. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const DEFAULT_ALLOWED_PORTS = [80, 443] as const;
export const DEFAULT_MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_CHARS = 50_000;
/**
 * Hard cap on how many bytes of a response body are read (A11/V8: the body was
 * fully materialised by `res.text()` before the char cap applied). 2 MiB is
 * comfortably above any page excerpt TED needs (an HTML page of a few hundred
 * kB) while bounding memory and transfer per call; `FETCH_MAX_CHARS` still
 * applies on top of it.
 */
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;

/** Honest user-facing copy: no egress allowlist is configured at all. */
export const EGRESS_DISABLED_MESSAGE =
  'A leitura de páginas externas está desativada neste ambiente — respondo com os dados do workspace.';
/** Honest user-facing copy: an allowlist exists but this host is not on it. */
export const EGRESS_NOT_ALLOWED_MESSAGE = 'Domínio não autorizado para leitura web.';

/**
 * Canonical hostname form for the allowlist: trimmed, lowercased, without the
 * DNS root dot and without IPv6 brackets.
 */
const normalizeHostname = (hostname: string): string =>
  hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

/**
 * Egress allowlist gate. Exact hostname match (no wildcard, no subdomain
 * expansion: an allowlisted `exemplo.test` must not authorise
 * `sub.exemplo.test`, which widens the surface for whoever controls it).
 * Fails closed when no allowlist is supplied or it is empty. Entries are
 * expected pre-folded (see `parseWebFetchAllowedHosts` for the env form);
 * the incoming hostname is always folded before matching.
 */
export const isAllowedEgressHost = (hostname: string, allowedHosts?: ReadonlySet<string>): boolean => {
  if (!allowedHosts || allowedHosts.size === 0) return false;
  return allowedHosts.has(normalizeHostname(hostname));
};

const assertAllowedEgressHost = (rawUrl: string, allowedHosts?: ReadonlySet<string>): void => {
  const { hostname } = new URL(rawUrl);
  if (isAllowedEgressHost(hostname, allowedHosts)) return;
  throw new SsrfBlockedError(
    !allowedHosts || allowedHosts.size === 0 ? EGRESS_DISABLED_MESSAGE : EGRESS_NOT_ALLOWED_MESSAGE,
  );
};

const stripBrackets = (ip: string): string =>
  ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

const parseIPv4 = (s: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const quads = m.slice(1).map(Number);
  if (quads.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return quads;
};

const isBlockedIPv4 = (q: number[]): boolean => {
  const a = q[0]!;
  const b = q[1]!;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared space
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
};

/** First-hextet classification for pure-hex IPv6 (no embedded dotted quad). */
const isBlockedIPv6FirstHextet = (first: string): boolean => {
  if (first === '') return true; // leading "::" outside the mapped forms = ::/96 compat range
  const v = Number.parseInt(first, 16);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) return true; // malformed → block
  if ((v & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if ((v & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if (v >= 0xfe80 && v <= 0xfebf) return true; // fe80::/10 link-local
  if (v === 0) return true; // unspecified extra
  return false;
};

/**
 * True when the literal IP must never be a fetch target: IPv4/IPv6 private,
 * loopback, link-local, multicast, unspecified, CGNAT and IPv4-mapped
 * addresses whose embedded IPv4 is blocked.
 */
export const isBlockedIp = (ip: string): boolean => {
  const h = stripBrackets(ip);
  // Hostnames are not IP literals — only dotted-numeric strings and
  // colon-containing strings take the IP classification path.
  if (!h.includes(':') && !/^[0-9.]+$/.test(h)) return false;
  // Dotted quad or mapped-with-dots (::ffff:127.0.0.1 and full forms):
  // classify the embedded IPv4.
  if (h.includes('.')) {
    const tail = h.slice(h.lastIndexOf(':') + 1);
    const quads = parseIPv4(h.includes(':') ? tail : h);
    if (!quads) return true; // malformed → block
    return isBlockedIPv4(quads);
  }
  const v4 = parseIPv4(h);
  if (v4) return isBlockedIPv4(v4);
  if (h === '::' || h === '::1') return true;
  // Hex-form mapped ::ffff:7f00:1 → last 32 bits are the embedded IPv4.
  if (h.startsWith('::ffff:')) {
    const parts = h.split(':').filter((p) => p !== '');
    const hi = Number.parseInt(parts[parts.length - 2] ?? '', 16);
    const lo = Number.parseInt(parts[parts.length - 1] ?? '', 16);
    if (!Number.isInteger(hi) || !Number.isInteger(lo)) return true;
    return isBlockedIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
  }
  const first = h.split(':')[0] ?? '';
  return isBlockedIPv6FirstHextet(first);
};

const BLOCKED_HOST_RE =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1?|\[(::1?|::)\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** Hostname-pattern pre-check (no DNS): mirrors the agent web-fetch rules. */
export const isBlockedHostname = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isBlockedIp(bare)) return true;
  return BLOCKED_HOST_RE.test(bare);
};

export type AssertSafeUrlOptions = {
  allowedPorts?: number[];
};

/**
 * Synchronous URL validation: scheme, credentials, hostname pattern,
 * literal-IP targets and port allowlist. DNS-resolved validation happens
 * in `resolveAndValidateHost` / `fetchWithSsrfGuard`.
 */
export const assertSafeUrl = (rawUrl: string, opts?: AssertSafeUrlOptions): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('URL inválida para leitura web.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Leitura web permite apenas endereços http/https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SsrfBlockedError('URL com credenciais não é permitida.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SsrfBlockedError('Endereço interno não pode ser lido pela web.');
  }
  const allowed = opts?.allowedPorts ?? [...DEFAULT_ALLOWED_PORTS];
  const port = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port);
  if (!Number.isInteger(port) || !allowed.includes(port)) {
    throw new SsrfBlockedError(`Porta ${url.port || '(padrão)'} não permitida para leitura web.`);
  }
  return url;
};

/**
 * DNS-resolved hostname validation (anti-rebinding): every resolved
 * address must be public. Fails closed on resolution errors.
 */
export const resolveAndValidateHost = async (
  hostname: string,
  lookup: HostResolver,
): Promise<string[]> => {
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new SsrfBlockedError(`Não foi possível validar o destino (${hostname}).`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new SsrfBlockedError(`Destino sem endereço válido (${hostname}).`);
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlockedError('Endereço interno não pode ser lido pela web.');
    }
  }
  return addresses;
};

export type GuardedFetchResult = {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
};

export type GuardedFetchOptions = {
  fetchImpl?: typeof fetch;
  lookup?: HostResolver;
  /**
   * Operator egress allowlist (exact hostnames). Omitted or empty blocks every
   * fetch — production resolves it from env (`TED_WEB_FETCH_ALLOWED_HOSTS`).
   */
  allowedHosts?: ReadonlySet<string>;
  allowedPorts?: number[];
  timeoutMs?: number;
  maxChars?: number;
  /** Byte budget applied while reading the body (default 2 MiB). */
  maxBytes?: number;
  maxRedirects?: number;
};

/**
 * Reads at most `maxBytes` from the response stream, decoding incrementally so
 * neither the chunk list nor the raw bytes are ever retained, and cancelling
 * the stream the moment the budget is exhausted (A11/V8). Falls back to
 * `text()` for platforms/mocks that carry no body stream.
 *
 * The loop stops on `total >= maxBytes` rather than waiting for one more chunk:
 * a body that delivers exactly the budget and then holds the connection open
 * would otherwise leave `read()` pending until the fetch timeout, and would
 * pull an extra chunk off the wire. `truncated` is set conservatively in that
 * case — an exhausted budget means the body cannot be claimed complete.
 *
 * Known limitation: the budget is enforced in bytes, so cutting a multibyte
 * character mid-sequence leaves it to be flushed as U+FFFD at the cut point.
 * Characters split across *chunk* boundaries (not the budget) are unaffected:
 * the decoder runs in stream mode, so they are reassembled.
 */
const readBodyWithByteBudget = async (
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const raw = await res.text().catch(() => '');
    return { text: raw, truncated: new TextEncoder().encode(raw).byteLength > maxBytes };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Only the decoded string accumulates; each byte chunk is released as soon as
  // it has been decoded, so a flood of tiny chunks costs no retained objects.
  let text = '';
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      const kept = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(kept, { stream: true });
      total += kept.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } catch {
    // The body stream broke mid-read: keep what was already read, but never
    // report a partial body as complete.
    truncated = true;
  } finally {
    // Flush whatever the decoder still holds (including a character cut by the
    // byte budget, which surfaces as U+FFFD).
    text += decoder.decode();
    if (truncated) {
      try {
        if (typeof reader.cancel === 'function') await reader.cancel();
        else await body.cancel();
      } catch {
        /* already errored or released: nothing left to interrupt */
      }
    }
  }
  return { text, truncated };
};

/**
 * SSRF-guarded fetch: egress allowlist + sync URL checks + (when `lookup` is
 * provided) resolved-IP validation on the initial URL and on every redirect
 * hop, manual redirect following with a cap, timeout and a body bounded in
 * both bytes and chars.
 */
export const fetchWithSsrfGuard = async (
  rawUrl: string,
  opts?: GuardedFetchOptions,
): Promise<GuardedFetchResult> => {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxChars = opts?.maxChars ?? FETCH_MAX_CHARS;
  const maxBytes =
    typeof opts?.maxBytes === 'number' && Number.isInteger(opts.maxBytes) && opts.maxBytes > 0
      ? opts.maxBytes
      : FETCH_MAX_BYTES;
  const maxRedirects = opts?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = assertSafeUrl(rawUrl, { allowedPorts: opts?.allowedPorts }).toString();
  assertAllowedEgressHost(current, opts?.allowedHosts);
  if (opts?.lookup) {
    await resolveAndValidateHost(new URL(current).hostname, opts.lookup);
  }
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await fetchImpl(current, {
      method: 'GET',
      headers: { accept: 'text/html,application/json,text/plain,text/*', 'user-agent': 'MeuTed-TED/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === maxRedirects) {
        throw new SsrfBlockedError('Muitos redirecionamentos na leitura web.');
      }
      const next = assertSafeUrl(new URL(location, current).toString(), {
        allowedPorts: opts?.allowedPorts,
      }).toString();
      assertAllowedEgressHost(next, opts?.allowedHosts);
      if (opts?.lookup) {
        await resolveAndValidateHost(new URL(next).hostname, opts.lookup);
      }
      current = next;
      continue;
    }
    if (!res.ok) {
      throw Object.assign(new Error(`web fetch failed: HTTP ${res.status}`), {
        code: `http_${res.status}`,
      });
    }
    const contentType = res.headers.get('content-type') ?? '';
    const { text: raw, truncated: bytesTruncated } = await readBodyWithByteBudget(res, maxBytes);
    const truncated = bytesTruncated || raw.length > maxChars;
    return { url: current, status: res.status, contentType, text: truncated ? raw.slice(0, maxChars) : raw, truncated };
  }
  throw new SsrfBlockedError('Muitos redirecionamentos na leitura web.');
};
