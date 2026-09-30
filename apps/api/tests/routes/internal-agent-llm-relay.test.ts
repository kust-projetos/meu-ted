import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAgentLlmRelayRoutes } from '../../src/routes/internal-agent-llm-relay.js';
import { createInMemoryLlmConfigStore } from '../../src/agent/llm-config-memory.js';

const ADMIN_TOKEN = 'test-relay-admin-token-32-chars-min!';
const ZEN_KEY = 'test-zen-key';

const headers = { 'x-agent-runtime-admin-token': ADMIN_TOKEN, origin: 'http://localhost:3000' };

const upstreamOk = () =>
  new Response(
    JSON.stringify({
      // FIX-API-RELAY-PROTOCOL-AWARE: both wire shapes — the relay extracts
      // per the model's registered protocol (responses OR chat-completions).
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
      choices: [{ message: { content: 'hi' } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('Fase 2 item 8 — dynamic relay allowlist (RED)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
    // The missing-credential contract must not depend on a developer or CI
    // process inheriting a real OpenRouter credential.
    delete process.env.OPENROUTER_API_KEY;
    // Same hermeticity for the opencode-go credential fallback
    // (deps.opencodeGoApiKey ?? process.env.OPENCODE_GO_API_KEY): the
    // R7-rev test below passes its go key explicitly, and no test in this
    // file may inherit an ambient OPENCODE_GO_API_KEY.
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

  it('passes a DB-enabled model and blocks a disabled one', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.setProviderEnabled('opencode-zen', true);
    const on = await store.upsertModel({
      providerId: 'opencode-zen', modelId: 'db-on', protocol: 'chat-completions', privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(on.id, true);
    await store.upsertModel({
      providerId: 'opencode-zen', modelId: 'db-off', protocol: 'chat-completions', privacyClass: 'training_prohibited', enabled: false,
    });
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, llmConfigStore: store });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstreamOk());

    const ok = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'db-on', prompt: 'hi' },
    });
    expect(ok.statusCode).toBe(200);

    const blocked = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'db-off', prompt: 'hi' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: 'agent.model_not_allowlisted' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('env override wins over the DB list', async () => {
    process.env.RELAY_ALLOWED_MODELS = 'custom-env-model';
    const store = createInMemoryLlmConfigStore();
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, llmConfigStore: store });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstreamOk());

    const ok = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'custom-env-model', prompt: 'hi' },
    });
    expect(ok.statusCode).toBe(200);

    const blocked = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('falls back to the built-in allowlist without env or store', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstreamOk());

    const ok = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('caches the DB list and refetches after TTL expiry', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.setProviderEnabled('opencode-zen', true);
    const m = await store.upsertModel({
      providerId: 'opencode-zen', modelId: 'cached-model', protocol: 'chat-completions', privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(m.id, true);
    let now = 1_000_000;
    const listSpy = vi.spyOn(store, 'listModels');
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, llmConfigStore: store, cacheTtlMs: 60_000, now: () => now,
    });
    await app.ready();
    // Fresh Response per call: a Response body can only be consumed once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(upstreamOk()));
    const payload = { provider: 'opencode-zen', model: 'cached-model', prompt: 'hi' };

    expect((await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload })).statusCode).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(1);

    now += 61_000;
    expect((await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload })).statusCode).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('fail-closed: store failure returns 503 without silent fallback (Fase 3 item 5/D3)', async () => {
    const store = createInMemoryLlmConfigStore();
    vi.spyOn(store, 'listModels').mockRejectedValueOnce(new Error('db down'));
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, llmConfigStore: store });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'anything', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'agent.relay_allowlist_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks an enabled model whose provider is disabled (Fase 3 item 5/D3)', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.upsertProvider({
      id: 'zen-extra', kind: 'opencode-zen', transport: 'direct', authMode: 'api-key',
      secretAlias: 'OPENCODE_ZEN_API_KEY', enabled: false, eligibility: 'approved',
    });
    const m = await store.upsertModel({
      providerId: 'zen-extra', modelId: 'orphan-model', protocol: 'chat-completions',
      privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(m.id, true);
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, llmConfigStore: store });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(upstreamOk()));
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'orphan-model', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'agent.model_not_allowlisted' });
  });

  it('clears its timer when the upstream request fails (Fase 3 item 1)', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
      const res = await app.inject({
        method: 'POST', url: '/internal/agent/llm-relay', headers,
        payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
      });
      expect(res.statusCode).toBe(504);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('aborts hung upstream headers within the request timeout (Fase 3 item 1)', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 50,
    });
    await app.ready();
    // Hanging fetch that honors abort like the real one.
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout' });
  }, 10_000);

  it('aborts a slow upstream body within the request timeout (Fase 3 item 1)', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 50,
    });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    } as unknown as Response);
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout' });
  }, 10_000);

  it('slow headers + slow body share ONE absolute budget (Fase 3-FIX R4-rev)', async () => {
    // Budget 240ms; headers take ~180ms and the body needs ~180ms more
    // (360ms combined). A restarted body budget would allow ~420ms; the
    // absolute deadline must abort at ~240ms instead.
    const BUDGET_MS = 240;
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: BUDGET_MS,
    });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: () => new Promise((resolveBody) => setTimeout(() => resolveBody({ output: [] }), 180)),
            } as unknown as Response);
          }, 180);
        }),
    );
    const startedAt = Date.now();
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout' });
    expect(elapsedMs).toBeLessThan(360);
  }, 15_000);

  it('allowlist preserves the (provider, model) pair: same modelId under a disabled provider is 403 (Fase 3-FIX R7-rev)', async () => {
    const store = createInMemoryLlmConfigStore();
    for (const [id, kind, alias] of [
      ['opencode-zen', 'opencode-zen', 'OPENCODE_ZEN_API_KEY'],
      ['opencode-go', 'opencode-go', 'OPENCODE_GO_API_KEY'],
    ] as const) {
      await store.upsertProvider({
        id, kind, transport: 'direct', authMode: 'api-key', secretAlias: alias, eligibility: 'approved',
      });
      await store.setProviderEnabled(id, true);
      const m = await store.upsertModel({
        providerId: id, modelId: 'shared-model', protocol: 'chat-completions',
        privacyClass: 'training_prohibited', enabled: true,
      });
      await store.setModelEnabled(m.id, true);
    }
    // The opencode-go provider goes down: its (go, shared-model) pair must
    // stop being relayable while (zen, shared-model) keeps working.
    // Both credentials are passed explicitly so the allowlist verdict (403)
    // never depends on an ambient OPENCODE_GO_API_KEY.
    await store.setProviderEnabled('opencode-go', false);
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, opencodeGoApiKey: 'test-go-key', llmConfigStore: store,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(upstreamOk()));

    const zen = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'shared-model', prompt: 'hi' },
    });
    expect(zen.statusCode).toBe(200);

    const go = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-go', model: 'shared-model', prompt: 'hi' },
    });
    expect(go.statusCode).toBe(403);
    expect(go.json()).toMatchObject({ code: 'agent.model_not_allowlisted' });
    // Only the allowlisted pair reached the upstream.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('late headers from an abort-ignoring upstream with immediate body is still a timeout (FIX R1)', async () => {
    // Reprodução adversarial §3.5: o mock ignora AbortSignal de propósito,
    // resolve headers APÓS o budget (150ms > 100ms) com body imediato e
    // VÁLIDO. Sem checagem explícita de deadline, o body imediato vence o
    // race de saldo ~0 e o handler retorna 200/502 em vez de timeout.
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 100,
    });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'late but valid' }] }],
              }),
            } as unknown as Response);
          }, 150);
        }),
    );
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout' });
  }, 10_000);

  it('fails with 503 when openrouter provider is used but openrouterApiKey is missing', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'openrouter', model: 'openai/gpt-4o-mini', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'agent.provider_not_configured',
      message: 'OPENROUTER_API_KEY não configurada na API.',
    });
  });

  it('successfully relays to openrouter and parses OpenAI-compatible response', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.upsertProvider({
      id: 'openrouter', kind: 'openrouter', transport: 'direct', authMode: 'api-key',
      secretAlias: 'OPENROUTER_API_KEY', eligibility: 'approved',
    });
    await store.setProviderEnabled('openrouter', true);
    const m = await store.upsertModel({
      providerId: 'openrouter', modelId: 'openai/gpt-4o-mini', protocol: 'chat-completions',
      privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(m.id, true);

    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      openrouterApiKey: 'test-openrouter-key',
      llmConfigStore: store,
    });
    await app.ready();

    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown = null;

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Olá do OpenRouter!' } }],
          cost: 0.00001,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        prompt: 'Olá assistente',
        system: 'Você é o TED',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text: 'Olá do OpenRouter!',
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      cost: 0.00001,
      providerAttempted: true,
    });
    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedHeaders.authorization).toBe('Bearer test-openrouter-key');
    expect(capturedBody).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é o TED' },
        { role: 'user', content: 'Olá assistente' },
      ],
      max_tokens: 2000,
    });
  });

  it('upstream 400/403 policy rejection maps to non-eligible agent.provider_rejected with safe message (item5)', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const rawUpstream = 'rejeitado por policy: eco do prompt secreto PROMPT-SECRETO-XYZ';
    const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };
    for (const status of [400, 403]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: rawUpstream } }), {
          status, headers: { 'content-type': 'application/json' },
        }),
      );
      const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
      const json = res.json() as { code?: string; message?: string };
      // RED: current contract returns agent.provider_error here (fallback-eligible).
      expect(json.code).toBe('agent.provider_rejected');
      expect(res.statusCode).toBe(502);
      // Safe boundary: raw upstream text (may echo prompt/system) never relayed.
      expect(JSON.stringify(json)).not.toContain(rawUpstream);
      expect(JSON.stringify(json)).not.toContain('PROMPT-SECRETO-XYZ');
      // Classificador do Agent (relay-failover.ts, read-only): só
      // rate_limited+429 / provider_timeout / provider_error+5xx são elegíveis.
      // provider_rejected + 502 deve ser inelegível — demonstra via mismatch.
      expect(json.code === 'agent.provider_error' && res.statusCode >= 500 && res.statusCode <= 599).toBe(false);
    }
  });

  it('upstream 429/5xx keep their eligible typing; other 4xx (422) is rejected non-eligible (item5)', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 }),
    );
    const limited = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'agent.rate_limited' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'bad request policy' } }), { status: 422 }),
    );
    const rejected = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(rejected.json()).toMatchObject({ code: 'agent.provider_rejected' });
    expect(rejected.statusCode).toBe(502);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }),
    );
    const failed = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: 'agent.provider_error' });
  });
});

describe('FIX-API-RELAY-MONOTONIC-AND-CANCEL — monotonic deadline + body cancel (RED)', () => {
  let app: FastifyInstance;

  const SAFE_TIMEOUT = 'Timeout aguardando provider.';
  const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };
  const validBody = () => ({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
  });

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
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

  it('injected monotonic clock past deadline forces timeout even when wall clock is within budget', async () => {
    // The monotonic clock crosses the budget inside the fetch mock; wall-clock
    // Date.now barely advances. Date.now-based rechecks would accept (200);
    // monotonic rechecks must fail closed (504).
    let mono = 1_000;
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 100,
      monotonicNow: () => mono,
    });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      mono += 500; // cross the 100ms budget before headers resolve
      return {
        ok: true, status: 200,
        json: async () => validBody(),
      } as unknown as Response;
    });
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout', message: SAFE_TIMEOUT });
  }, 8000);

  it('wall-clock jump backward does not revive a late body (monotonic wins)', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 100,
    });
    await app.ready();
    // First Date.now call (start) returns real time; later calls jump 10s
    // into the past so a Date.now-based elapsed check would go negative and
    // wrongly accept the late body.
    const realNow = Date.now.bind(Date);
    const startReal = realNow();
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      if (calls <= 1) return startReal;
      return startReal - 10_000;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true, status: 200, json: async () => validBody() } as unknown as Response);
        }, 150);
      }),
    );
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout' });
  }, 8000);

  it('timeout best-effort cancels the upstream body when it exists', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 50,
    });
    await app.ready();
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {});
      return {
        ok: true, status: 200,
        body: { cancel: cancelSpy },
        json: () => new Promise(() => {}),
      } as unknown as Response;
    });
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout', message: SAFE_TIMEOUT });
    expect(cancelSpy).toHaveBeenCalled();
  }, 8000);

  it('late response resolving after the deadline is canceled on discard', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 100,
    });
    await app.ready();
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: true, status: 200,
            body: { cancel: cancelSpy },
            json: async () => validBody(),
          } as unknown as Response);
        }, 150);
      }),
    );
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'agent.provider_timeout' });
    // The abort-ignoring fetch resolves after the race settled; allow the
    // background continuation to run its late-discard cancel.
    await new Promise((r) => setTimeout(r, 250));
    expect(cancelSpy).toHaveBeenCalled();
  }, 8000);
});

describe('FIX-API-RELAY-ALL-ERROR-MESSAGES-SAFE — fixed safe messages on every non-2xx path (RED)', () => {
  let app: FastifyInstance;

  const SAFE_429 = 'Provider com muitas requisições. Tente novamente em instantes.';
  const SAFE_401 = 'Falha de autenticação no provider.';
  const SAFE_5XX = 'Falha no provider. Tente novamente em instantes.';
  const SAFE_NETWORK = 'Falha de comunicação com o provider.';
  const SAFE_TIMEOUT = 'Timeout aguardando provider.';

  const PROMPT_MARK = 'PROMPT-SEGREDO-ABC-429';
  const KEY_MARK = 'sk-secret-XYZ123-EVIL';

  const evilUpstream = (mark: string) =>
    `Quota exceeded for ${mark} key=${KEY_MARK}\r\nInjected-Log-Line: evil prompt=${PROMPT_MARK}`;

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    app = Fastify({ logger: false });
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    vi.restoreAllMocks();
    await app.close();
  });

  it('upstream 429 keeps 429/agent.rate_limited with fixed safe message', async () => {
    const raw = evilUpstream(PROMPT_MARK);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: raw } }), {
        status: 429, headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(429);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.rate_limited');
    expect(json.message).toBe(SAFE_429);
    const raw2 = JSON.stringify(json);
    expect(raw2).not.toContain(raw);
    expect(raw2).not.toContain(PROMPT_MARK);
    expect(raw2).not.toContain(KEY_MARK);
    expect(raw2).not.toContain('Injected-Log-Line');
  });

  it('upstream 401 keeps 502/agent.provider_auth with fixed safe message', async () => {
    const raw = evilUpstream(PROMPT_MARK);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: raw } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(502);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_auth');
    expect(json.message).toBe(SAFE_401);
    const raw2 = JSON.stringify(json);
    expect(raw2).not.toContain(PROMPT_MARK);
    expect(raw2).not.toContain(KEY_MARK);
    expect(raw2).not.toContain('Injected-Log-Line');
  });

  it('upstream 500 keeps 502/agent.provider_error with fixed safe message', async () => {
    const raw = evilUpstream(PROMPT_MARK);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: raw } }), {
        status: 500, headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(502);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_error');
    expect(json.message).toBe(SAFE_5XX);
    const raw2 = JSON.stringify(json);
    expect(raw2).not.toContain(PROMPT_MARK);
    expect(raw2).not.toContain(KEY_MARK);
    expect(raw2).not.toContain('Injected-Log-Line');
  });

  it('network throw keeps 504/agent.provider_timeout with fixed safe message', async () => {
    const evil = new TypeError(`fetch failed for prompt ${PROMPT_MARK} key=${KEY_MARK}\r\nInjected: evil`);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(evil);
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(504);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_timeout');
    expect(json.message).toBe(SAFE_NETWORK);
    const raw2 = JSON.stringify(json);
    expect(raw2).not.toContain(PROMPT_MARK);
    expect(raw2).not.toContain(KEY_MARK);
    expect(raw2).not.toContain('Injected');
  });

  it('abort/timeout throw keeps 504/agent.provider_timeout with fixed safe message', async () => {
    const evilAbort = Object.assign(
      new Error(`aborted with prompt ${PROMPT_MARK} key=${KEY_MARK}\r\nInjected: evil`),
      { name: 'AbortError' },
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(evilAbort);
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(504);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_timeout');
    expect(json.message).toBe(SAFE_TIMEOUT);
    const raw2 = JSON.stringify(json);
    expect(raw2).not.toContain(PROMPT_MARK);
    expect(raw2).not.toContain(KEY_MARK);
    expect(raw2).not.toContain('Injected');
  });
});

describe('W2-ITEM6 — absolute transport deadline: fetch/body que ignoram abort terminam em prazo finito (RED)', () => {
  let app: FastifyInstance;

  const SAFE_TIMEOUT = 'Timeout aguardando provider.';
  const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
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

  it('fetch que nunca resolve (ignora abort) termina em 504 finito com mensagem segura', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 60,
    });
    await app.ready();
    let abortFired = false;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>(() => {
          // Ignora o abort de propósito: nunca resolve nem rejeita.
          init?.signal?.addEventListener('abort', () => {
            abortFired = true;
          });
        }),
    );
    const startedAt = Date.now();
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    const elapsedMs = Date.now() - startedAt;
    expect(res.statusCode).toBe(504);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_timeout');
    expect(json.message).toBe(SAFE_TIMEOUT);
    // O sinal de abort foi enviado no deadline, mesmo o upstream ignorando.
    expect(abortFired).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
  }, 8000);

  it('headers imediatos mas .json() pendente (ignora abort) termina em 504 finito', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 60,
    });
    await app.ready();
    let abortFired = false;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        abortFired = true;
      });
      return {
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      } as unknown as Response;
    });
    const startedAt = Date.now();
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    const elapsedMs = Date.now() - startedAt;
    expect(res.statusCode).toBe(504);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_timeout');
    expect(json.message).toBe(SAFE_TIMEOUT);
    expect(abortFired).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
  }, 8000);

  it('body válido que chega logo após o deadline é rejeitado (sem sucesso sintetizado)', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 100,
    });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'late but valid' }] }],
              }),
            } as unknown as Response);
          }, 150);
        }),
    );
    const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(res.statusCode).toBe(504);
    const json = res.json() as { code?: string; message?: string };
    expect(json.code).toBe('agent.provider_timeout');
    expect(json.message).toBe(SAFE_TIMEOUT);
    expect(JSON.stringify(json)).not.toContain('late but valid');
  }, 8000);

  it('resposta rápida antes do deadline segue normal e limpa o timer', async () => {
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY, requestTimeoutMs: 1000,
    });
    await app.ready();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(upstreamOk()));
      const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ text: 'hi' });
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});

const GO_KEY_LOCAL = 'test-go-key-synthetic-ccc';

describe('FIX-API-RELAY-PROTOCOL-AWARE — upstream path follows the model protocol', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
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

  it('routes an opencode model registered as chat-completions to /chat/completions', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.setProviderEnabled('opencode-go', true);
    const created = await store.upsertModel({
      providerId: 'opencode-go', modelId: 'glm-like', protocol: 'chat-completions', privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(created.id, true);
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY_LOCAL,
      llmConfigStore: store,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'cc-hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-go', model: 'glm-like', prompt: 'hi', sessionId: 'ted-ws-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'cc-hi' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    const sentBody = JSON.parse(String((init as RequestInit).body)) as { messages?: unknown; input?: unknown };
    expect(Array.isArray(sentBody.messages)).toBe(true);
    expect(sentBody.input).toBeUndefined();
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders['x-opencode-session']).toBe('ted-ws-1');
  });

  it('keeps /responses for a responses-protocol model', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.setProviderEnabled('opencode-go', true);
    const created = await store.upsertModel({
      providerId: 'opencode-go', modelId: 'muse-like', protocol: 'responses', privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(created.id, true);
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY_LOCAL,
      llmConfigStore: store,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstreamOk());

    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-go', model: 'muse-like', prompt: 'hi' },
    });

    expect(res.statusCode).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://opencode.ai/zen/go/v1/responses');
    const sentBody = JSON.parse(String((init as RequestInit).body)) as { messages?: unknown; input?: unknown };
    expect(sentBody.input).toBe('hi');
    expect(sentBody.messages).toBeUndefined();
  });

  it('defaults an env-allowlisted model without a DB row to /responses', async () => {
    process.env.RELAY_ALLOWED_MODELS = 'env-only-model';
    const store = createInMemoryLlmConfigStore();
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN,
      zenApiKey: ZEN_KEY,
      opencodeGoApiKey: GO_KEY_LOCAL,
      llmConfigStore: store,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstreamOk());

    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-go', model: 'env-only-model', prompt: 'hi' },
    });

    expect(res.statusCode).toBe(200);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://opencode.ai/zen/go/v1/responses');
  });
});

describe('RELAY-ATTEMPT-RECEIPT — maxOutputTokens + providerAttempted + usage (TASK pi-financeiro-api-relay-attempt-receipt)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
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

  it('success forwards the output cap to chat-completions as max_tokens, marks providerAttempted true, returns normalized usage', async () => {
    const store = createInMemoryLlmConfigStore();
    await store.upsertProvider({
      id: 'openrouter', kind: 'openrouter', transport: 'direct', authMode: 'api-key',
      secretAlias: 'OPENROUTER_API_KEY', eligibility: 'approved',
    });
    await store.setProviderEnabled('openrouter', true);
    const m = await store.upsertModel({
      providerId: 'openrouter', modelId: 'openai/gpt-4o-mini', protocol: 'chat-completions',
      privacyClass: 'training_prohibited', enabled: true,
    });
    await store.setModelEnabled(m.id, true);
    registerAgentLlmRelayRoutes(app, {
      adminToken: ADMIN_TOKEN, openrouterApiKey: 'test-openrouter-key', llmConfigStore: store,
    });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      const sentBody = JSON.parse(String((init as RequestInit).body ?? '{}'));
      expect(sentBody.max_tokens).toBe(500);
      expect(sentBody.max_output_tokens).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'capped hi' } }],
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'openrouter', model: 'openai/gpt-4o-mini', prompt: 'hi', maxOutputTokens: 500 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text: 'capped hi',
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      cost: 0,
      providerAttempted: true,
      usage: { inputTokens: 12, outputTokens: 34 },
    });
  });

  it('success forwards the output cap to responses as max_output_tokens', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      const sentBody = JSON.parse(String((init as RequestInit).body ?? '{}'));
      expect(sentBody.max_output_tokens).toBe(321);
      expect(sentBody.max_tokens).toBeUndefined();
      return new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'resp hi' }] }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi', maxOutputTokens: 321 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      text: 'resp hi',
      providerAttempted: true,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('defaults maxOutputTokens to 2000 when omitted', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      const sentBody = JSON.parse(String((init as RequestInit).body ?? '{}'));
      expect(sentBody.max_output_tokens).toBe(2000);
      return new Response(
        JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ providerAttempted: true });
    expect(res.json()).not.toHaveProperty('usage');
  });

  it('omitted or invalid provider usage returns no usage field', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }] }] }), { status: 200 }),
    );
    const noUsage = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(noUsage.statusCode).toBe(200);
    expect(noUsage.json()).toMatchObject({ providerAttempted: true });
    expect(noUsage.json()).not.toHaveProperty('usage');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'b' }] }],
          usage: { input_tokens: '10', output_tokens: null, total_tokens: 99, extra: 'leak' },
        }),
        { status: 200 },
      ),
    );
    const badUsage = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(badUsage.statusCode).toBe(200);
    expect(badUsage.json()).toMatchObject({ providerAttempted: true });
    expect(badUsage.json()).not.toHaveProperty('usage');
  });

  it('every pre-provider rejection returns providerAttempted:false', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const badAuth = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay',
      headers: { 'x-agent-runtime-admin-token': 'wrong-token' },
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(badAuth.statusCode).toBe(401);
    expect(badAuth.json()).toMatchObject({ providerAttempted: false });

    const badBody = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: '', prompt: '' },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toMatchObject({ providerAttempted: false });

    const notAllowlisted = await app.inject({
      method: 'POST', url: '/internal/agent/llm-relay', headers,
      payload: { provider: 'opencode-zen', model: 'nope-not-allowlisted', prompt: 'hi' },
    });
    expect(notAllowlisted.statusCode).toBe(403);
    expect(notAllowlisted.json()).toMatchObject({ providerAttempted: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatched failures report providerAttempted:true without raw provider text', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };
    const rawSecret = 'UPSTREAM-SECRET-MARK-XYZ';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: rawSecret } }), { status: 500 }),
    );
    const failed = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: 'agent.provider_error', providerAttempted: true });
    expect(JSON.stringify(failed.json())).not.toContain(rawSecret);

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const timedOut = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json()).toMatchObject({ code: 'agent.provider_timeout', providerAttempted: true });
  });

  it('invalid maxOutputTokens is 400 with providerAttempted:false and no fetch', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const maxOutputTokens of [0, 2001, 1.5]) {
      const res = await app.inject({
        method: 'POST', url: '/internal/agent/llm-relay', headers,
        payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi', maxOutputTokens },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ providerAttempted: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('RELAY-RECEIPT-REVIEW-FIXES — parser errors carry receipt + strict cost (RED)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.RELAY_ALLOWED_MODELS;
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

  it('malformed JSON returns providerAttempted:false with sanitized body and no fetch', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{bad-json-prompt-PROMPT-SECRETO-RED',
    });
    const json = res.json() as { code?: string; message?: string; providerAttempted?: boolean };
    expect(res.statusCode).toBe(400);
    expect(json.providerAttempted).toBe(false);
    expect(json.code).toBe('validation.error');
    expect(json.message).toBe('Corpo da requisição inválido.');
    expect(JSON.stringify(json)).not.toContain('PROMPT-SECRETO-RED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('unsupported content type returns providerAttempted:false and no fetch', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers: { ...headers, 'content-type': 'application/xml' },
      payload: '<prompt>PROMPT-SECRETO-RED-CT</prompt>',
    });
    const json = res.json() as { code?: string; message?: string; providerAttempted?: boolean };
    expect(res.statusCode).toBe(415);
    expect(json.providerAttempted).toBe(false);
    expect(json.code).toBe('validation.error');
    expect(json.message).toBe('Tipo de conteúdo não suportado. Use application/json.');
    expect(JSON.stringify(json)).not.toContain('PROMPT-SECRETO-RED-CT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('body over the limit returns providerAttempted:false and no fetch', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const bigPrompt = `BIG-PROMPT-${'x'.repeat(1_100_000)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: bigPrompt },
    });
    const json = res.json() as { code?: string; message?: string; providerAttempted?: boolean };
    expect(res.statusCode).toBe(413);
    expect(json.providerAttempted).toBe(false);
    expect(json.code).toBe('validation.error');
    expect(json.message).toBe('Corpo da requisição excede o limite permitido.');
    // Raw oversized prompt must never be echoed back.
    expect(JSON.stringify(json).length).toBeLessThan(5000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('other routes keep their default error handling (no relay receipt leak)', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    app.get('/other-probe', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/no-such-route-xyz' });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).not.toContain('providerAttempted');
  });

  it('malformed upstream cost (object/string/NaN/negative/Infinity) is never echoed', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    const payload = { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' };
    const evilCosts: unknown[] = [
      { amount: 1, evil: 'COST-SECRETO-RED' },
      'COST-SECRETO-RED-string',
      '0.01',
      NaN,
      Infinity,
      -5,
      null,
    ];
    for (const cost of evilCosts) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
          cost,
        }),
      } as unknown as Response);
      const res = await app.inject({ method: 'POST', url: '/internal/agent/llm-relay', headers, payload });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { cost?: unknown; providerAttempted?: boolean };
      expect(json.providerAttempted).toBe(true);
      expect(json.cost).toBe(0);
      expect(Number.isFinite(json.cost)).toBe(true);
      expect(JSON.stringify(json)).not.toContain('COST-SECRETO-RED');
      vi.restoreAllMocks();
    }
  });

  it('valid numeric cost still passes through exactly', async () => {
    registerAgentLlmRelayRoutes(app, { adminToken: ADMIN_TOKEN, zenApiKey: ZEN_KEY });
    await app.ready();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        cost: 0.0123,
      }),
    } as unknown as Response);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent/llm-relay',
      headers,
      payload: { provider: 'opencode-zen', model: 'muse-spark-1.2-contributor-free', prompt: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cost: 0.0123, providerAttempted: true });
  });
});
