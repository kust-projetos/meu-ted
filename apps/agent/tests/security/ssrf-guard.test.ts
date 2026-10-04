import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeUrl,
  FETCH_MAX_BYTES,
  fetchWithSsrfGuard,
  isBlockedIp,
  resolveAndValidateHost,
  SsrfBlockedError,
  type GuardedFetchOptions,
  type HostResolver,
} from '../../src/security/ssrf-guard.js';

/**
 * Egress allowlist used by every guarded fetch: the guard fails closed when
 * it is absent (A11 routing ii), so tests that exercise the fetch path must
 * declare the hosts they consider allowlisted. Entries are pre-folded exactly
 * like `parseWebFetchAllowedHosts` does for the operator env.
 */
const allowedHosts = (...hosts: string[]): ReadonlySet<string> =>
  new Set(hosts.map((host) => host.trim().toLowerCase().replace(/\.$/, '')));

const ALLOWED = allowedHosts('exemplo.test', 'alvo.test');

const publicLookup: HostResolver = async (host) => {
  if (host === 'exemplo.test') return ['93.184.216.34'];
  if (host === 'alvo.test') return ['203.0.113.10'];
  throw new Error(`unexpected host in test: ${host}`);
};

const rebindingLookup: HostResolver = async (host) => {
  if (host === 'evil.test') return ['127.0.0.1'];
  return publicLookup(host);
};

describe('isBlockedIp (SPEC §15.4)', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::5',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2001:4860:4860::8888'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe('assertSafeUrl (scheme, credentials, ports)', () => {
  it('rejects non-http schemes and credentialed URLs', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(SsrfBlockedError);
    expect(() => assertSafeUrl('ftp://exemplo.test/x')).toThrow(SsrfBlockedError);
    expect(() => assertSafeUrl('http://user:pass@exemplo.test/')).toThrow(SsrfBlockedError);
  });

  it('rejects arbitrary ports by default (only 80/443)', () => {
    expect(() => assertSafeUrl('http://exemplo.test:22/')).toThrow(SsrfBlockedError);
    expect(() => assertSafeUrl('https://exemplo.test:8080/')).toThrow(SsrfBlockedError);
    expect(assertSafeUrl('https://exemplo.test/').protocol).toBe('https:');
    expect(assertSafeUrl('http://exemplo.test:80/x').protocol).toBe('http:');
  });

  it('honours a configured port allowlist', () => {
    expect(assertSafeUrl('https://exemplo.test:8443/x', { allowedPorts: [443, 8443] }).port).toBe(
      '8443',
    );
    expect(() => assertSafeUrl('https://exemplo.test:22/', { allowedPorts: [443, 8443] })).toThrow(
      SsrfBlockedError,
    );
  });
});

describe('resolveAndValidateHost (DNS rebinding)', () => {
  it('blocks a hostname that resolves to a private IP', async () => {
    await expect(resolveAndValidateHost('evil.test', rebindingLookup)).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('blocks when ANY resolved address is private', async () => {
    const mixed: HostResolver = async () => ['93.184.216.34', '10.0.0.9'];
    await expect(resolveAndValidateHost('mix.test', mixed)).rejects.toThrow(SsrfBlockedError);
  });

  it('accepts a hostname that resolves to public IPs only', async () => {
    await expect(resolveAndValidateHost('exemplo.test', publicLookup)).resolves.toEqual([
      '93.184.216.34',
    ]);
  });

  it('fails closed when DNS resolution fails', async () => {
    const failing: HostResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(resolveAndValidateHost('exemplo.test', failing)).rejects.toThrow(SsrfBlockedError);
  });
});

describe('fetchWithSsrfGuard (redirects re-validated, capped)', () => {
  it('blocks a redirect whose target resolves to a private IP', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://evil.test/x' } }),
    );
    await expect(
      fetchWithSsrfGuard('https://exemplo.test/start', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        lookup: rebindingLookup,
        allowedHosts: ALLOWED,
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps redirect chains', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://alvo.test/next' } }),
    );
    await expect(
      fetchWithSsrfGuard('https://exemplo.test/start', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        lookup: publicLookup,
        maxRedirects: 2,
        allowedHosts: allowedHosts('exemplo.test', 'alvo.test'),
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fetches a public URL end to end', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await fetchWithSsrfGuard('https://exemplo.test/pagina', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      lookup: publicLookup,
      allowedHosts: ALLOWED,
    });
    expect(result.status).toBe(200);
    expect(result.text).toBe('ok');
  });
});

/**
 * A11 (routing ii): DNS pre-resolution cannot pin the effective egress target
 * on the Workers runtime, so the guard requires an operator allowlist and
 * fails closed without it. The check is DNS-independent and runs before any
 * fetch, so a non-allowlisted hostname never reaches the network.
 */
describe('fetchWithSsrfGuard egress allowlist (fail-closed, DNS-independent)', () => {
  const blockedFetch = vi.fn(() => {
    throw new Error('fetch must never be reached for a non-allowlisted host');
  });

  it('blocks every fetch when no allowlist is configured (default-off)', async () => {
    const opts: GuardedFetchOptions = { fetchImpl: blockedFetch as unknown as typeof fetch };
    await expect(fetchWithSsrfGuard('https://exemplo.test/pagina', opts)).rejects.toThrow(SsrfBlockedError);
    await expect(
      fetchWithSsrfGuard('https://exemplo.test/pagina', {
        ...opts,
        lookup: publicLookup,
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it('blocks a host outside the allowlist before any fetch, even with a public resolver', async () => {
    await expect(
      fetchWithSsrfGuard('https://nao-allowlisted.test/x', {
        fetchImpl: blockedFetch as unknown as typeof fetch,
        lookup: async () => ['93.184.216.34'],
        allowedHosts: ALLOWED,
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it('blocks a redirect hop whose host leaves the allowlist (per-hop re-validation)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://saida-nao-allowlisted.test/x' } }),
    );
    await expect(
      fetchWithSsrfGuard('https://exemplo.test/start', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        lookup: publicLookup,
        allowedHosts: ALLOWED,
      }),
    ).rejects.toThrow(SsrfBlockedError);
    // Only the first hop was fetched: the second never left the Worker.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the allowlist matching case-insensitive and dot-terminated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await fetchWithSsrfGuard('HTTP://UPPER.EXAMPLE.COM/x', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      allowedHosts: allowedHosts('Upper.Example.com.', 'exemplo.test'),
    });
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat a subdomain of an allowlisted host as allowlisted', async () => {
    await expect(
      fetchWithSsrfGuard('https://sub.exemplo.test/x', {
        fetchImpl: blockedFetch as unknown as typeof fetch,
        allowedHosts: ALLOWED,
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(blockedFetch).not.toHaveBeenCalled();
  });
});

/**
 * A11 / V8: the body cap must apply while the stream is being read — today
 * `res.text()` materialises the whole response and only then truncates.
 */
describe('fetchWithSsrfGuard byte cap (stream, V8)', () => {
  const CHUNK_BYTES = 64 * 1024;
  const TOTAL_CHUNKS = 100;

  const oversizedBody = (): { stream: ReadableStream<Uint8Array>; stats: { pulls: number; cancelled: boolean } } => {
    const stats = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        stats.pulls += 1;
        if (stats.pulls > TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(97)); // 'a'
      },
      cancel() {
        stats.cancelled = true;
      },
    });
    return { stream, stats };
  };

  const streamingFetch = (stream: ReadableStream<Uint8Array>): typeof fetch =>
    vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch;

  it('stops reading at the configured byte budget and cancels the stream', async () => {
    const { stream, stats } = oversizedBody();
    const result = await fetchWithSsrfGuard('https://exemplo.test/gigante', {
      fetchImpl: streamingFetch(stream),
      allowedHosts: ALLOWED,
      maxBytes: CHUNK_BYTES,
      maxChars: 1_000_000,
    });
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
    // The point of the cap: far fewer chunks than the body has are consumed.
    expect(stats.pulls).toBeLessThanOrEqual(3);
    expect(stats.pulls).toBeLessThan(TOTAL_CHUNKS);
    expect(stats.cancelled).toBe(true);
  });

  it('caps at the default budget without materialising the whole body', async () => {
    const { stream, stats } = oversizedBody();
    const result = await fetchWithSsrfGuard('https://exemplo.test/gigante', {
      fetchImpl: streamingFetch(stream),
      allowedHosts: ALLOWED,
      maxChars: 1_000_000,
    });
    expect(FETCH_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(FETCH_MAX_BYTES);
    expect(stats.pulls).toBeLessThanOrEqual(FETCH_MAX_BYTES / CHUNK_BYTES + 2);
    expect(stats.pulls).toBeLessThan(TOTAL_CHUNKS);
    expect(stats.cancelled).toBe(true);
  });

  it('keeps the char cap on top of the byte cap', async () => {
    const { stream, stats } = oversizedBody();
    const result = await fetchWithSsrfGuard('https://exemplo.test/gigante', {
      fetchImpl: streamingFetch(stream),
      allowedHosts: ALLOWED,
      maxBytes: CHUNK_BYTES,
      maxChars: 100,
    });
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(stats.cancelled).toBe(true);
  });

  it('does not split multibyte characters across chunk boundaries', async () => {
    // '€' is E2 82 AC: the first chunk ends mid-character.
    const euro = new TextEncoder().encode('€'); // 3 bytes
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(euro.subarray(0, 2));
        controller.enqueue(euro.subarray(2));
        controller.enqueue(new TextEncoder().encode('FIM'));
        controller.close();
      },
    });
    const result = await fetchWithSsrfGuard('https://exemplo.test/multibyte', {
      fetchImpl: streamingFetch(body),
      allowedHosts: ALLOWED,
    });
    expect(result.text).toBe('€FIM');
    expect(result.truncated).toBe(false);
  });

  it('falls back to text() for empty bodies and reports no truncation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const result = await fetchWithSsrfGuard('https://exemplo.test/vazio', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      allowedHosts: ALLOWED,
    });
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });
});

/**
 * A11 review round 2 (FIX 1): a body that delivers EXACTLY the byte budget and
 * then holds the connection open (no next chunk, no EOF) must not make the
 * reader ask for one more byte — that read only settles on the fetch timeout,
 * and it also pulls an extra chunk off the wire.
 */
describe('fetchWithSsrfGuard byte cap boundary (FIX 1)', () => {
  const BUDGET_BYTES = 512;

  const exactBudgetThenHang = (): {
    stream: ReadableStream<Uint8Array>;
    stats: { pulls: number; cancelled: boolean };
  } => {
    const stats = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          stats.pulls += 1;
          if (stats.pulls === 1) {
            controller.enqueue(new Uint8Array(BUDGET_BYTES).fill(97)); // 'a'
            return;
          }
          // Deliberately open forever: no enqueue, no close.
        },
        cancel() {
          stats.cancelled = true;
        },
      },
      // highWaterMark 0 ⇒ `pull` only runs while a read is pending, so `pulls`
      // counts reads instead of the stream's eager prefetch.
      { highWaterMark: 0 },
    );
    return { stream, stats };
  };

  const streamingFetch = (stream: ReadableStream<Uint8Array>): typeof fetch =>
    vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch;

  it('cancels at the exact budget instead of waiting for a chunk that never arrives', async () => {
    const { stream, stats } = exactBudgetThenHang();
    const startedAt = Date.now();
    const result = await fetchWithSsrfGuard('https://exemplo.test/exato', {
      fetchImpl: streamingFetch(stream),
      allowedHosts: ALLOWED,
      maxBytes: BUDGET_BYTES,
      maxChars: 1_000_000,
      timeoutMs: 30_000, // a regression would sit here until the fetch timeout
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.text).toHaveLength(BUDGET_BYTES);
    // Conservative: the budget was exhausted, so the body cannot be claimed complete.
    expect(result.truncated).toBe(true);
    // Exactly one pull consumed — zero extra reads past the budget.
    expect(stats.pulls).toBe(1);
    expect(stats.cancelled).toBe(true);
  }, 5_000);
});

/**
 * A11 review round 2 (FIX 2): the body is decoded incrementally while it is
 * read, so the guard never retains the chunk array. Behavioural proof: a flood
 * of 1-byte chunks still decodes to the exact expected text.
 */
describe('fetchWithSsrfGuard incremental decode (FIX 2)', () => {
  const UNIT = '€ok!'; // 4 chars / 6 bytes — multibyte split across 1-byte chunks
  const UNIT_BYTES = 6;
  const UNITS = 50_000; // 300k single-byte chunks if the body were fully drained

  const byteFlood = (): {
    stream: ReadableStream<Uint8Array>;
    stats: { pulls: number; cancelled: boolean };
  } => {
    const bytes = new TextEncoder().encode(UNIT.repeat(UNITS));
    const stats = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (stats.pulls >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(stats.pulls, stats.pulls + 1));
          stats.pulls += 1;
        },
        cancel() {
          stats.cancelled = true;
        },
      },
      // highWaterMark 0 ⇒ `pull` only runs while a read is pending, so `pulls`
      // counts reads instead of the stream's eager prefetch.
      { highWaterMark: 0 },
    );
    return { stream, stats };
  };

  const streamingFetch = (stream: ReadableStream<Uint8Array>): typeof fetch =>
    vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch;

  it('reassembles characters split into 1-byte chunks and stops at the budget', async () => {
    const { stream, stats } = byteFlood();
    const units = 100;
    const result = await fetchWithSsrfGuard('https://exemplo.test/flood', {
      fetchImpl: streamingFetch(stream),
      allowedHosts: ALLOWED,
      maxBytes: units * UNIT_BYTES,
      maxChars: 1_000_000,
    });
    expect(result.text).toBe(UNIT.repeat(units));
    expect(result.truncated).toBe(true);
    expect(stats.pulls).toBe(units * UNIT_BYTES);
    expect(stats.cancelled).toBe(true);
  });

  it('marks the byte-budget cut that lands inside a multibyte character', async () => {
    const { stream, stats } = byteFlood();
    const units = 166;
    const result = await fetchWithSsrfGuard('https://exemplo.test/corte', {
      fetchImpl: streamingFetch(stream),
      allowedHosts: ALLOWED,
      maxBytes: units * UNIT_BYTES + 2, // 2 of the 3 bytes of the next '€'
      maxChars: 1_000_000,
    });
    expect(result.text).toBe(`${UNIT.repeat(units)}�`); // U+FFFD: known byte-budget limitation
    expect(result.truncated).toBe(true);
    expect(stats.pulls).toBe(units * UNIT_BYTES + 2);
    expect(stats.cancelled).toBe(true);
  });
});
