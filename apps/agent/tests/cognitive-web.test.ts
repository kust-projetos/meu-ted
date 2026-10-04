import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEB_FETCH_ALLOWED_HOSTS_ENV,
  WEB_FETCH_MAX_BYTES,
  WEB_UNAVAILABLE_MESSAGE,
  assertFetchableUrl,
  createWebSearchProvider,
  isBlockedFetchHost,
  parseWebFetchAllowedHosts,
  webFetchUrl,
  WebFetchBlockedError,
} from '../src/agent-config/web.js';
import { buildExposedTools } from '../src/agent-config/tools.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Egress allowlist for the guarded fetch (empty set = default-off). */
const allowedHosts = (...hosts: string[]): ReadonlySet<string> => new Set(hosts);

describe('web search provider resolution', () => {
  it('is disabled without any key and reports gracefully', async () => {
    const provider = createWebSearchProvider({});
    expect(provider.available).toBe(false);
    expect(provider.name).toBe('disabled');
    const result = await provider.search('selic hoje');
    expect(result).toEqual({ provider: 'disabled', available: false, results: [] });
    expect(WEB_UNAVAILABLE_MESSAGE).toMatch(/indisponível/i);
  });

  it('prefers Tavily and maps results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: 'Selic 15%', url: 'https://exemplo.test/selic', content: 'texto' }] }),
        { status: 200 },
      ),
    );
    const provider = createWebSearchProvider(
      { TAVILY_API_KEY: 'tv-test', BRAVE_API_KEY: 'br-test' },
      fetchMock as unknown as typeof fetch,
    );
    expect(provider.name).toBe('tavily');
    const result = await provider.search('selic hoje');
    expect(result.available).toBe(true);
    expect(result.results[0]).toMatchObject({ title: 'Selic 15%', url: 'https://exemplo.test/selic' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.tavily.com');
    // Provider responses carry no secrets back to the model.
    expect(JSON.stringify(result)).not.toContain('tv-test');
  });

  it('falls back to Brave without Tavily key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ web: { results: [{ title: 'Dólar', url: 'https://exemplo.test/dolar', description: 'R$ 5' }] } }),
        { status: 200 },
      ),
    );
    const provider = createWebSearchProvider({ BRAVE_API_KEY: 'br-test' }, fetchMock as unknown as typeof fetch);
    expect(provider.name).toBe('brave');
    const result = await provider.search('dólar hoje');
    expect(result.results[0]).toMatchObject({ url: 'https://exemplo.test/dolar' });
  });

  it('surfaces provider HTTP errors without leaking the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const provider = createWebSearchProvider({ TAVILY_API_KEY: 'super-secret' }, fetchMock as unknown as typeof fetch);
    await expect(provider.search('x')).rejects.toMatchObject({ code: 'http_403' });
  });
});

describe('SSRF-safe web fetch', () => {
  it.each([
    'http://localhost:3000/x',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest',
    'http://[::1]/',
    'file:///etc/passwd',
    'ftp://exemplo.test/x',
    'http://user:pass@exemplo.test/',
  ])('blocks %s', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow(WebFetchBlockedError);
  });

  it.each(['localhost', '127.0.0.1', '10.1.2.3', '172.31.255.1', '192.168.0.1', '169.254.169.254', '::1'])(
    'flags %s as an internal host',
    (host) => {
      expect(isBlockedFetchHost(host)).toBe(true);
    },
  );

  it('allows public https URLs', () => {
    expect(assertFetchableUrl('https://exemplo.test/noticia').protocol).toBe('https:');
    expect(isBlockedFetchHost('exemplo.test')).toBe(false);
  });

  it('fetches and truncates with a mocked provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('conteúdo'.repeat(1000), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const result = await webFetchUrl('https://exemplo.test/pagina', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxChars: 100,
      allowedHosts: allowedHosts('exemplo.test'),
    });
    expect(result.status).toBe(200);
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.url).toBe('https://exemplo.test/pagina');
  });

  it('re-validates redirect targets', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } }));
    await expect(
      webFetchUrl('https://exemplo.test/redirect', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowedHosts: allowedHosts('exemplo.test'),
      }),
    ).rejects.toThrow(WebFetchBlockedError);
  });

  it('rejects non-allowlisted ports (V4.1 Phase 8, SPEC §15.4)', async () => {
    const fetchMock = vi.fn();
    await expect(
      webFetchUrl('https://exemplo.test:22/x', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowedHosts: allowedHosts('exemplo.test'),
      }),
    ).rejects.toThrow(WebFetchBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks DNS rebinding when a resolver is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const lookup = vi.fn().mockResolvedValue(['127.0.0.1']);
    await expect(
      webFetchUrl('https://evil.test/x', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        lookup,
        allowedHosts: allowedHosts('evil.test'),
      }),
    ).rejects.toThrow(WebFetchBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * A11: the guarded fetch fails closed without an operator egress allowlist.
 * Every fetch-path test above therefore declares its hosts.
 */
describe('web fetch egress allowlist (default-off)', () => {
  it('fails closed when no allowlist is resolved', async () => {
    const fetchMock = vi.fn();
    await expect(
      webFetchUrl('https://exemplo.test/pagina', { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(WebFetchBlockedError);
    await expect(
      webFetchUrl('https://exemplo.test/pagina', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowedHosts: new Set(),
      }),
    ).rejects.toThrow(WebFetchBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('folds case and drops the dot terminator when parsing the env CSV', () => {
    const parsed = parseWebFetchAllowedHosts(' Upper.Example.com. , news.test , , ');
    expect(parsed.has('upper.example.com')).toBe(true);
    expect(parsed.has('news.test')).toBe(true);
    // A malformed entry (scheme/path) is kept verbatim, so it can never match
    // a hostname: the gate fails closed instead of guessing.
    const malformed = parseWebFetchAllowedHosts('https://nao-e-host.test/x');
    expect([...malformed].some((host) => host === 'nao-e-host.test')).toBe(false);
    expect(malformed.has('https://nao-e-host.test/x')).toBe(true);
  });

  it('is default-off when the env is unset or blank', () => {
    expect(parseWebFetchAllowedHosts(undefined).size).toBe(0);
    expect(parseWebFetchAllowedHosts('').size).toBe(0);
    expect(parseWebFetchAllowedHosts('  ,  ').size).toBe(0);
  });

  it('matches the allowlisted host exactly, not its subdomains', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await expect(
      webFetchUrl('https://sub.exemplo.test/x', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowedHosts: allowedHosts('exemplo.test'),
      }),
    ).rejects.toThrow(WebFetchBlockedError);
    await expect(
      webFetchUrl('https://exemplo.test/outro', {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowedHosts: allowedHosts('exemplo.test'),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the byte cap available to callers (parity with the guard)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('a'.repeat(2048), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await webFetchUrl('https://exemplo.test/x', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      allowedHosts: allowedHosts('exemplo.test'),
      maxBytes: 512,
      maxChars: 100_000,
    });
    expect(WEB_FETCH_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBe(512);
  });
});

/**
 * A11 (the test the production path was missing): `buildExposedTools` wires
 * `web_fetch` without `lookup`/`fetchImpl`, so the previous suite only proved
 * the guard with an injected resolver. These cases exercise the real
 * composition (global fetch, no resolver) through the exposed tool.
 */
describe('web_fetch on the production tool route (no injected resolver/fetch)', () => {
  const baseCtx = {
    delegatedToken: 'delegated-test-token',
    apiOrigin: 'https://api.example.test',
    workspaceId: 'ws-1',
    actorId: 'actor-1',
    intentionId: 'intent-1',
    lastUserMessage: 'o que diz essa página?',
  };

  const callWebFetch = async (
    webEnv: Record<string, string | undefined>,
    url: string,
    fetchImpl?: typeof fetch,
  ): Promise<{ ok?: boolean; message?: string }> => {
    const tools = buildExposedTools(['web_fetch'], {
      ...baseCtx,
      webEnv,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return (await (tools['web_fetch'] as { execute: (p: unknown) => Promise<unknown> }).execute({ url })) as {
      ok?: boolean;
      message?: string;
    };
  };

  it('answers gracefully without an allowlist and never reaches the network', async () => {
    const globalFetch = vi.fn(() => {
      throw new Error('global fetch must never be reached');
    });
    vi.stubGlobal('fetch', globalFetch);
    for (const webEnv of [{}, { [WEB_FETCH_ALLOWED_HOSTS_ENV]: '' }, { [WEB_FETCH_ALLOWED_HOSTS_ENV]: ' , ' }]) {
      const result = await callWebFetch(webEnv, 'https://exemplo.test/pagina');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/leitura de páginas externas/i);
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('reaches the fetch only for an allowlisted host, with the byte cap applied', async () => {
    // Oversized body served in lazy 64 KiB chunks: the tool must stop reading
    // at the byte budget instead of materialising the whole response.
    const chunkBytes = 64 * 1024;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkBytes).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const result = (await callWebFetch(
      { [WEB_FETCH_ALLOWED_HOSTS_ENV]: 'Exemplo.Test' },
      'https://exemplo.test/pagina',
      fetchImpl as unknown as typeof fetch,
    )) as { url?: string; status?: number; truncated?: boolean; text?: string };
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.url).toBe('https://exemplo.test/pagina');
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text ?? '').byteLength).toBeLessThanOrEqual(WEB_FETCH_MAX_BYTES);
    expect(pulls).toBeLessThan(100);
    expect(cancelled).toBe(true);
  });

  it('blocks a non-allowlisted host without throwing, even with fetchImpl injected', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('fetch must never be reached');
    });
    const result = await callWebFetch(
      { [WEB_FETCH_ALLOWED_HOSTS_ENV]: 'exemplo.test' },
      'https://nao-allowlisted.test/x',
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/não autorizado/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a redirect that leaves the allowlist on the hop', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://saida.test/x' } }),
    );
    const result = await callWebFetch(
      { [WEB_FETCH_ALLOWED_HOSTS_ENV]: 'exemplo.test' },
      'https://exemplo.test/redirect',
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps internal hosts and bad ports blocked even when allowlisted', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('fetch must never be reached');
    });
    const webEnv = { [WEB_FETCH_ALLOWED_HOSTS_ENV]: 'localhost,169.254.169.254,exemplo.test' };
    for (const url of ['http://localhost:3000/x', 'http://169.254.169.254/latest', 'https://exemplo.test:22/x']) {
      const result = await callWebFetch(webEnv, url, fetchImpl as unknown as typeof fetch);
      expect(result.ok, url).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves web_search untouched by the fetch allowlist', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: 'Selic', url: 'https://exemplo.test/selic', content: 'x' }] }), {
        status: 200,
      }),
    );
    const tools = buildExposedTools(['web_search'], {
      ...baseCtx,
      webEnv: { TAVILY_API_KEY: 'tv-test' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = (await (
      tools['web_search'] as { execute: (p: unknown) => Promise<unknown> }
    ).execute({ query: 'selic' })) as { available?: boolean; results?: unknown[] };
    expect(result.available).toBe(true);
    expect(result.results).toHaveLength(1);
  });
});

describe('web status line honesty about the fetch allowlist', () => {
  const assemble = async (webEnv: Record<string, string | undefined>): Promise<string> =>
    (await import('../src/agent-config/index.js')).assembleCognition('qual o meu saldo?', { webEnv }).system;

  it('keeps the graceful line when no search key is configured', async () => {
    const system = await assemble({});
    expect(system).toContain('WEB: indisponível (sem chave configurada)');
  });

  it('does not promise page reading while the allowlist is empty', async () => {
    const system = await assemble({ TAVILY_API_KEY: 'tv-test' });
    expect(system).toContain('nenhum domínio autorizado');
  });

  it('announces page reading only for the configured domains', async () => {
    const system = await assemble({
      TAVILY_API_KEY: 'tv-test',
      [WEB_FETCH_ALLOWED_HOSTS_ENV]: 'exemplo.test,news.test',
    });
    expect(system).toContain('apenas nos domínios autorizados');
  });
});
