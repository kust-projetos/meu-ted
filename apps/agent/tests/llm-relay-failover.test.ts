import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';
import * as apiClient from '../src/tools/api-client.js';
import {
  RELAY_MAX_ATTEMPTS,
  executeRelayAttempts,
  isRelayFallbackEligible,
  resolveRelayTargets,
} from '../src/llm/relay-failover.js';

const relayErr = (status: number, code: string, message = code) =>
  Object.assign(new Error(message), { status, code });

const SNAP_BASE = {
  provider_id: 'opencode-zen',
  model_id: 'opencode-zen:zen-primary',
  model_name: 'zen-primary',
  fallback_provider_id: 'opencode-go',
  fallback_model_id: 'opencode-go:go-fallback',
  fallback_model_name: 'go-fallback',
};

describe('item5: relay classifier explicito (sem isRetryableLlmError)', () => {
  it('elegivel: 429 rate_limited, timeout de provider, erro operacional do provider', () => {
    expect(isRelayFallbackEligible(relayErr(429, 'agent.rate_limited'))).toBe(true);
    expect(isRelayFallbackEligible(relayErr(504, 'agent.provider_timeout'))).toBe(true);
    expect(isRelayFallbackEligible(Object.assign(new Error('t'), { name: 'AbortError' }))).toBe(true);
    expect(isRelayFallbackEligible(relayErr(502, 'agent.provider_error'))).toBe(true);
  });

  it('inelegivel: 400, 401, 403 policy, 409 epoch, 503 config/allowlist, output invalido, nao classificado', () => {
    expect(isRelayFallbackEligible(relayErr(400, 'validation.error'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(401, 'auth.invalid_token'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(502, 'agent.provider_auth'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(403, 'agent.model_not_allowlisted'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(409, 'agent.security_epoch_changed'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(503, 'agent.provider_not_configured'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(503, 'agent.relay_allowlist_unavailable'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(502, 'agent.inference_error'))).toBe(false);
    expect(isRelayFallbackEligible(relayErr(500, 'unknown_thing'))).toBe(false);
    expect(isRelayFallbackEligible(Object.assign(new Error('nope'), { status: 404 }))).toBe(false);
  });

  it('nao reutiliza isRetryableLlmError: 401/403/503 nao disparam fallback de relay', async () => {
    // isRetryableLlmError legado trataria 401/403/503 como retryable; o
    // classificador de relay deve negar explicitamente.
    const { isRetryableLlmError } = await import('../src/llm/failover.js');
    expect(isRetryableLlmError(relayErr(401, 'auth.invalid_token'))).toBe(true);
    expect(isRelayFallbackEligible(relayErr(401, 'auth.invalid_token'))).toBe(false);
    expect(isRetryableLlmError(relayErr(403, 'agent.model_not_allowlisted'))).toBe(true);
    expect(isRelayFallbackEligible(relayErr(403, 'agent.model_not_allowlisted'))).toBe(false);
    expect(isRetryableLlmError(relayErr(503, 'agent.provider_not_configured'))).toBe(true);
    expect(isRelayFallbackEligible(relayErr(503, 'agent.provider_not_configured'))).toBe(false);
  });
});

describe('item5: resolucao de alvos do relay', () => {
  it('resolve par primario+fallback distinto via mecanismo existente', () => {
    const { primary, fallback, fallbackOmittedReason } = resolveRelayTargets({ ...SNAP_BASE });
    expect(primary).toEqual({ providerId: 'opencode-zen', modelName: 'zen-primary' });
    expect(fallback).toEqual({ providerId: 'opencode-go', modelName: 'go-fallback' });
    expect(fallbackOmittedReason).toBeNull();
  });

  it('sem fallback configurado => 1-shot com motivo exato', () => {
    const r = resolveRelayTargets({ ...SNAP_BASE, fallback_provider_id: null, fallback_model_id: null });
    expect(r.primary).not.toBeNull();
    expect(r.fallback).toBeNull();
    expect(r.fallbackOmittedReason).toBe('no_fallback_configured');
  });

  it('fallback igual ao primario => 1-shot, nunca double-spend', () => {
    const r = resolveRelayTargets({
      ...SNAP_BASE,
      fallback_provider_id: 'opencode-zen',
      fallback_model_id: 'opencode-zen:zen-primary',
      fallback_model_name: 'zen-primary',
    });
    expect(r.fallback).toBeNull();
    expect(r.fallbackOmittedReason).toBe('fallback_indistinct_from_primary');
  });

  it('fallback nao relayavel ou irresoluvel => 1-shot', () => {
    const notRelayable = resolveRelayTargets({
      ...SNAP_BASE,
      fallback_provider_id: 'deepseek',
      fallback_model_id: 'deepseek:deepseek-chat',
      fallback_model_name: 'deepseek-chat',
    });
    expect(notRelayable.fallback).toBeNull();
    expect(notRelayable.fallbackOmittedReason).toBe('fallback_provider_not_relayable');

    const opaque = resolveRelayTargets({
      ...SNAP_BASE,
      fallback_provider_id: 'openai-api',
      fallback_model_id: 'row-id-opaco',
      fallback_model_name: null,
    });
    expect(opaque.fallback).toBeNull();
    expect(opaque.fallbackOmittedReason).toBe('fallback_unresolvable_model');
  });
});

describe('item5: executor com no maximo 1 fallback', () => {
  const primary = { providerId: 'opencode-zen', modelName: 'zen-primary' };
  const fallback = { providerId: 'opencode-go', modelName: 'go-fallback' };

  it('429/timeout/provider_error => exatamente 1 fallback distinto', async () => {
    for (const err of [
      relayErr(429, 'agent.rate_limited'),
      relayErr(504, 'agent.provider_timeout'),
      relayErr(502, 'agent.provider_error'),
    ]) {
      const seen: string[] = [];
      const outcome = await executeRelayAttempts({
        primary,
        fallback,
        runLeg: async (target) => {
          seen.push(`${target.providerId}/${target.modelName}`);
          if (target.providerId === 'opencode-zen') throw err;
          return 'fallback-ok';
        },
      });
      expect(seen).toEqual(['opencode-zen/zen-primary', 'opencode-go/go-fallback']);
      expect(outcome).toMatchObject({ result: 'fallback-ok', usedFallback: true });
      expect(outcome.attempts).toBe(2);
    }
    expect(RELAY_MAX_ATTEMPTS).toBe(2);
  });

  it('400, 403 policy, 401, 409 epoch, 503 config, sem fallback, mesmo modelo => zero fallback', async () => {
    for (const err of [
      relayErr(400, 'validation.error'),
      relayErr(403, 'agent.model_not_allowlisted'),
      relayErr(401, 'auth.invalid_token'),
      relayErr(409, 'agent.security_epoch_changed'),
      relayErr(503, 'agent.provider_not_configured'),
    ]) {
      const runLeg = vi.fn(async () => {
        throw err;
      });
      await expect(executeRelayAttempts({ primary, fallback, runLeg })).rejects.toMatchObject({
        status: (err as { status?: number }).status,
      });
      expect(runLeg).toHaveBeenCalledTimes(1);
    }
    const noFallback = vi.fn(async () => {
      throw relayErr(429, 'agent.rate_limited');
    });
    await expect(executeRelayAttempts({ primary, fallback: null, runLeg: noFallback })).rejects.toMatchObject({
      status: 429,
      code: 'agent.rate_limited',
    });
    expect(noFallback).toHaveBeenCalledTimes(1);
  });

  it('ambas falham => erro composto seguro sem detalhes brutos', async () => {
    const err = await executeRelayAttempts({
      primary,
      fallback,
      runLeg: async (target) => {
        if (target.providerId === 'opencode-zen') {
          throw Object.assign(new Error('boom sk-secret-AAA'), { status: 429, code: 'agent.rate_limited' });
        }
        throw Object.assign(new Error('crash sk-secret-BBB'), { status: 502, code: 'agent.provider_error' });
      },
    }).catch((e) => e) as { code?: string; status?: number; message?: string };
    expect(err.code).toBe('agent.inference_error');
    expect(err.status).toBe(502);
    expect(String(err.message)).not.toContain('sk-secret-AAA');
    expect(String(err.message)).not.toContain('sk-secret-BBB');
  });

  it('mudanca de epoch entre pernas nega o fallback', async () => {
    const runLeg = vi.fn(async () => 'never');
    await expect(
      executeRelayAttempts({
        primary,
        fallback,
        runLeg: async () => {
          throw relayErr(429, 'agent.rate_limited');
        },
        authorizeBetween: async () => {
          throw Object.assign(new Error('epoch'), { code: 'agent.security_epoch_changed', status: 409 });
        },
      }),
    ).rejects.toMatchObject({ code: 'agent.security_epoch_changed', status: 409 });
    expect(runLeg).not.toHaveBeenCalled();
  });
});

// ---- integracao /rpc/chat via relay ----

const snapshotBody = (epoch = 1) => ({
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: epoch,
    activeProviderId: 'opencode-zen',
    activeModelId: 'opencode-zen:zen-1',
    activeProtocol: 'chat-completions',
    activeRolloutPercentage: 100,
    activeRolloutMode: 'all',
    fallbackProviderId: null,
    fallbackModelId: null,
    updatedBy: null,
  },
  activeProvider: null,
  activeModel: null,
  fallbackProvider: null,
  fallbackModel: null,
  activeDisabled: false,
  fallbackDisabled: false,
});

const createChatAgent = (snapshot: Record<string, unknown>) => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (msgs: UIMessage[]) => Promise<void>;
  };
  agent.messages = [];
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
  // Usage-attempt ledger: the relay leg reserves per dispatch (fail-closed
  // 503 without atomic storage), so the harness provides it like production.
  attachRelayUsageStorage(agent);
  Object.defineProperty(agent, 'env', {
    value: {
      API_ORIGIN: 'https://api.test.local',
      AGENT_RUNTIME_ADMIN_TOKEN: 'admin-test-token',
      AGENT_CONFIG_TOKEN: 'config-test-token',
    },
    writable: true,
    configurable: true,
  });
  (agent as unknown as { resolveIntentionSnapshot: () => Promise<unknown> }).resolveIntentionSnapshot =
    async () => ({ ...snapshot });
  return { agent, persisted };
};

const CHAT_REQ = (intentionId: string) =>
  new Request('https://agent.test.local/rpc/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-actor': 'user-1',
      'x-agent-workspace': 'ws-1',
    },
    body: JSON.stringify({ text: 'Quanto gastei este mês?', intentionId }),
  });

const SNAP_FALLBACK = {
  intention_id: 'intent-relay-1',
  version: 1,
  provider_id: 'opencode-zen',
  model_id: 'opencode-zen:zen-primary',
  protocol: 'chat-completions',
  rollout_percentage: 100,
  security_epoch: 1,
  fallback_provider_id: 'opencode-go',
  fallback_model_id: 'opencode-go:go-fallback',
  model_name: 'zen-primary',
  fallback_model_name: 'go-fallback',
  created_at: new Date().toISOString(),
};

describe('item5: /rpc/chat via relay com failover restrito', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('primario 429 + fallback configurado => 1 fallback distinto, user persiste 1x, output final grounded', async () => {
    const { agent, persisted } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    const relayCalls: Array<{ provider: string; model: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info, init) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
      }
      if (url.includes('/internal/agent/llm-relay')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { provider: string; model: string };
        relayCalls.push(body);
        if (body.provider === 'opencode-zen') {
          return new Response(JSON.stringify({ code: 'agent.rate_limited', message: 'slow down' }), {
            status: 429,
          });
        }
        return new Response(JSON.stringify({ text: 'Aqui está o resumo das suas movimentações.', providerAttempted: true }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await agent.fetch(CHAT_REQ('intent-relay-ok'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; output?: string };
    expect(body.status).toBe('completed');
    expect(body.output).toBe('Aqui está o resumo das suas movimentações.');
    expect(relayCalls.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: 'opencode-zen', model: 'zen-primary' },
      { provider: 'opencode-go', model: 'go-fallback' },
    ]);
    expect(persisted.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('403 model_not_allowlisted preserva code/status e nao tenta fallback', async () => {
    const { agent } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    let relayCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
      }
      relayCalls += 1;
      return new Response(JSON.stringify({ code: 'agent.model_not_allowlisted', message: 'Modelo não permitido no relay.' }), {
        status: 403,
      });
    });

    const res = await agent.fetch(CHAT_REQ('intent-relay-403'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'agent.model_not_allowlisted' });
    expect(relayCalls).toBe(1);
  });

  it('epoch muda entre pernas => 409 sem fallback nem output', async () => {
    const { agent, persisted } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    let configCalls = 0;
    let relayCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        configCalls += 1;
        // primeira + reautorizacao entre pernas: epoch salta para 2
        return new Response(JSON.stringify(snapshotBody(configCalls >= 2 ? 2 : 1)), { status: 200 });
      }
      relayCalls += 1;
      return new Response(JSON.stringify({ code: 'agent.rate_limited', message: 'slow' }), { status: 429 });
    });

    const res = await agent.fetch(CHAT_REQ('intent-relay-epoch'));
    expect(res.status).toBe(409);
    expect(relayCalls).toBe(1);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('epoch muda apos resposta final => sem publicacao', async () => {
    const { agent, persisted } = createChatAgent({
      ...SNAP_FALLBACK,
      fallback_provider_id: null,
      fallback_model_id: null,
      fallback_model_name: null,
    });
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    let relaySeen = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        // pos-inferencia (3a chamada) retorna epoch novo
        return new Response(JSON.stringify(snapshotBody(relaySeen ? 2 : 1)), { status: 200 });
      }
      relaySeen = true;
      return new Response(JSON.stringify({ text: 'Aqui está o resumo das suas movimentações.', providerAttempted: true }), { status: 200 });
    });

    const res = await agent.fetch(CHAT_REQ('intent-relay-post-epoch'));
    expect(res.status).toBe(409);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('ambas falham => 502 composto seguro, sem vazar provider', async () => {
    const { agent } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info, init) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { provider: string };
      if (body.provider === 'opencode-zen') {
        return new Response(JSON.stringify({ code: 'agent.rate_limited', message: 'sk-secret-AAA' }), {
          status: 429,
        });
      }
      return new Response(JSON.stringify({ code: 'agent.provider_error', message: 'sk-secret-BBB' }), {
        status: 502,
      });
    });

    const res = await agent.fetch(CHAT_REQ('intent-relay-both-fail'));
    expect(res.status).toBe(502);
    const raw = await res.text();
    expect(raw).not.toContain('sk-secret-AAA');
    expect(raw).not.toContain('sk-secret-BBB');
  });
});
