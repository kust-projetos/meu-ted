import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAgentLlmRelayRoutes } from '../../src/routes/internal-agent-llm-relay.js';

const ADMIN_TOKEN = 'test-relay-admin-token-32-chars-min!';
const ZEN_KEY = 'test-zen-key-synthetic-aaa';
const GO_KEY = 'test-go-key-synthetic-bbb';
const headers = { 'x-agent-runtime-admin-token': ADMIN_TOKEN, origin: 'http://localhost:3000' };

const goUpstreamOk = () =>
  new Response(
    JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'go-hi' }] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('FIX-API-OPENCODE-GO-RELAY-KEY — distinct opencode-go credential (RED)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.RELAY_ALLOWED_MODELS = 'relay-regression-model';
    delete process.env.OPENROUTER_API_KEY;
    // Isolate from any ambient credential so the fail-closed assertion is
    // deterministic without ever reading a secret value.
    delete process.env.OPENCODE_GO_API_KEY;
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    vi.restoreAllMocks();
    await app.close();
  });

  it("provider opencode-go authorizes with the distinct Go key (not the Zen key)", async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(goUpstreamOk()));

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: { provider: 'opencode-go', model: 'relay-regression-model', prompt: 'hi' },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://opencode.ai/zen/go/v1/responses');
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${GO_KEY}`);
    expect(sentHeaders.authorization).not.toBe(`Bearer ${ZEN_KEY}`);
  });

  it('provider opencode-zen keeps authorizing with the Zen key', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(goUpstreamOk()));

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: { provider: 'opencode-zen', model: 'relay-regression-model', prompt: 'hi' },
    });

    expect(res.statusCode).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://opencode.ai/zen/v1/responses');
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${ZEN_KEY}`);
  });

  it('opencode-go without a Go key fails closed with OPENCODE_GO_API_KEY (no Zen fallback)', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: { provider: 'opencode-go', model: 'relay-regression-model', prompt: 'hi' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'agent.provider_not_configured',
      message: 'OPENCODE_GO_API_KEY não configurada na API.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FIX-API-OPENCODE-GO-SESSION-HEADER — upstream Go requests carry x-opencode-session', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.RELAY_ALLOWED_MODELS = 'relay-regression-model';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    vi.restoreAllMocks();
    await app.close();
  });

  it('forwards the caller sessionId as x-opencode-session on the Go upstream', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(goUpstreamOk()));

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: {
        provider: 'opencode-go',
        model: 'relay-regression-model',
        prompt: 'hi',
        sessionId: 'ted-ws-abc123',
      },
    });

    expect(res.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders['x-opencode-session']).toBe('ted-ws-abc123');
  });

  it('generates a bounded fallback session id when the caller omits sessionId', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(goUpstreamOk()));

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: { provider: 'opencode-go', model: 'relay-regression-model', prompt: 'hi' },
    });

    expect(res.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(typeof sentHeaders['x-opencode-session']).toBe('string');
    expect(sentHeaders['x-opencode-session']!.length).toBeGreaterThanOrEqual(8);
    expect(sentHeaders['x-opencode-session']).toMatch(/^[A-Za-z0-9._:-]+$/);
  });

  it('does not send the Go session header to the Zen upstream', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(goUpstreamOk()));

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: {
        provider: 'opencode-zen',
        model: 'relay-regression-model',
        prompt: 'hi',
        sessionId: 'ted-ws-abc123',
      },
    });

    expect(res.statusCode).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders['x-opencode-session']).toBeUndefined();
  });

  it('rejects malformed sessionId values with validation.error', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: {
        provider: 'opencode-go',
        model: 'relay-regression-model',
        prompt: 'hi',
        sessionId: 'bad id with spaces!',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation.error' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FIX-RELAY-NO-REDIRECT-FOLLOW — upstream 3xx fails closed without following (RED)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.RELAY_ALLOWED_MODELS = 'relay-regression-model';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    vi.restoreAllMocks();
    await app.close();
  });

  it.each([302, 307])(
    'upstream %i is not followed: single pinned fetch with redirect manual, sanitized 502',
    async (status) => {
      registerAgentLlmRelayRoutes(app, {
        adminToken: ADMIN_TOKEN,
        zenApiKey: ZEN_KEY,
        opencodeGoApiKey: GO_KEY,
      });
      await app.ready();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'redirect marker' } }), {
            status,
            headers: { 'content-type': 'application/json', location: 'https://evil-redirect.example/capture' },
          }),
        );

      const res = await app.inject({
        method: 'POST',
        url: '/internal/agent/llm-relay',
        headers,
        payload: { provider: 'opencode-go', model: 'relay-regression-model', prompt: 'hi' },
      });

      // Fail closed with the existing sanitized provider-error contract.
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'agent.provider_error',
        message: 'Falha no provider. Tente novamente em instantes.',
      });
      expect(JSON.stringify(res.json())).not.toContain('evil-redirect.example');

      // The single upstream fetch stays pinned and never follows the 3xx.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe('https://opencode.ai/zen/go/v1/responses');
      expect(String(url)).not.toContain('evil-redirect.example');
      expect((init as RequestInit).redirect).toBe('manual');
      const sentHeaders = (init as RequestInit).headers as Record<string, string>;
      expect(sentHeaders.authorization).toBe(`Bearer ${GO_KEY}`);
    },
  );
});
