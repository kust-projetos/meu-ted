/**
 * Grounding quota propagation (TDD RED first).
 *
 * Two integration review findings:
 *  (A) A denied grounding-correction reservation must remain an HTTP quota
 *      error (429 `agent.quota_exceeded` / 503 `agent.usage_unavailable`) —
 *      never collapse into a 200 deterministic fallback.
 *  (B) Successful API relay output must not reconcile actual usage unless
 *      `providerAttempted === true`. A 2xx with absent/false receipt keeps
 *      the full reservation and is rejected as invalid receipt (no untrusted
 *      text publish); missing/contradictory receipts never release.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import * as apiClient from '../src/tools/api-client.js';
import { createChannelGrounding } from '../src/orchestration/channel-evidence.js';
import { createGroundedResponseWithRetry } from '../src/responses/grounded-response.js';
import { createEvidenceEnvelope } from '../src/evidence/evidence-envelope.js';
import { assembleCognition } from '../src/agent-config/index.js';
import {
  DEFAULT_POLICY,
  estimateTokens,
  recordUsage,
} from '../src/safety/usage-policy.js';
import {
  attachRelayUsageStorage,
  createRelayUsageStorage,
} from './helpers/relay-usage-storage.js';
import type { TurnInput, TurnPlan } from '../src/orchestration/conversation-orchestrator.js';

const quotaError = (code = 'agent.quota_exceeded', status = 429): Error =>
  Object.assign(new Error(`${code}: usage reservation denied`), {
    code,
    status,
    __usageQuotaPassthrough: true,
  });

const usageUnavailableError = (): Error => quotaError('agent.usage_unavailable', 503);

const stubInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  text: 'Quanto gastei este mês?',
  intentionId: 'intent-quota-prop',
  traceId: 'trace-quota-prop',
  actorId: 'user-1',
  workspaceId: 'ws-1',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
  internalCorrection: false,
  ...overrides,
});

const stubPlan = (overrides: Partial<TurnPlan> = {}): TurnPlan => ({
  version: '2',
  domain: 'transactions',
  mode: 'read',
  skillNames: [],
  requestedOperations: [],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
  ...overrides,
});

const groundedEnvelope = () =>
  createEvidenceEnvelope(
    [
      {
        ref: 'statement',
        source: 'api.transactions',
        retrievedAt: new Date().toISOString(),
        status: 'ok',
        data: [{ description: 'Mercado', date: '2026-09-01', amountCents: 1234 }],
      },
    ],
    {},
  );

describe('grounding quota propagation (RED)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('correction provider rethrows quota/usage-unavailable denials instead of null', async () => {
    const denied = createChannelGrounding({
      respond: async () => {
        throw quotaError();
      },
    });
    await expect(denied.correctionProvider(stubInput(), stubPlan(), ['R$ 999,99'])).rejects.toMatchObject({
      code: 'agent.quota_exceeded',
      status: 429,
    });

    const unavailable = createChannelGrounding({
      respond: async () => {
        throw usageUnavailableError();
      },
    });
    await expect(unavailable.correctionProvider(stubInput(), stubPlan(), ['R$ 999,99'])).rejects.toMatchObject({
      code: 'agent.usage_unavailable',
      status: 503,
    });
  });

  it('correction provider still falls back safe (null) on ordinary transient errors', async () => {
    const grounding = createChannelGrounding({
      respond: async () => {
        throw Object.assign(new Error('boom'), { code: 'agent.provider_error', status: 502 });
      },
    });
    await expect(
      grounding.correctionProvider(stubInput(), stubPlan(), ['R$ 999,99']),
    ).resolves.toBeNull();
    const empty = createChannelGrounding({ respond: async () => '' });
    await expect(empty.correctionProvider(stubInput(), stubPlan(), ['R$ 999,99'])).resolves.toBeNull();
  });

  it('createGroundedResponseWithRetry rethrows typed usage-gate failures; ordinary retry errors still fall back', async () => {
    const envelope = groundedEnvelope();
    await expect(
      createGroundedResponseWithRetry('Seu gasto foi R$ 999,99 este mês.', envelope, {
        retry: async () => {
          throw quotaError();
        },
      }),
    ).rejects.toMatchObject({ code: 'agent.quota_exceeded', status: 429 });

    await expect(
      createGroundedResponseWithRetry('Seu gasto foi R$ 999,99 este mês.', envelope, {
        retry: async () => {
          throw usageUnavailableError();
        },
      }),
    ).rejects.toMatchObject({ code: 'agent.usage_unavailable', status: 503 });

    const fallback = await createGroundedResponseWithRetry('Seu gasto foi R$ 999,99 este mês.', envelope, {
      retry: async () => {
        throw Object.assign(new Error('timeout'), { code: 'agent.provider_timeout', status: 504 });
      },
    });
    expect(fallback.rejected).toBe(true);
    expect(fallback.text).not.toContain('999,99');
  });
});

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

const SNAP_SINGLE = {
  intention_id: 'intent-relay-single',
  version: 1,
  provider_id: 'opencode-zen',
  model_id: 'opencode-zen:zen-primary',
  protocol: 'chat-completions',
  rollout_percentage: 100,
  security_epoch: 1,
  fallback_provider_id: null,
  fallback_model_id: null,
  model_name: 'zen-primary',
  fallback_model_name: null,
  created_at: new Date().toISOString(),
};

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
  const store = createRelayUsageStorage();
  attachRelayUsageStorage(agent, store);
  return { agent, persisted, store };
};

const chatRequest = (text: string, intentionId: string) =>
  new Request('https://agent.test.local/rpc/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-actor': 'user-1',
      'x-agent-workspace': 'ws-1',
    },
    body: JSON.stringify({ text, intentionId }),
  });

describe('relay receipt gating (RED)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('2xx with trustworthy usage but missing receipt keeps the full reservation and rejects (no publish)', async () => {
    const { agent, persisted, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    let relayCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
      }
      if (url.includes('/internal/agent/llm-relay')) {
        relayCalls += 1;
        // 2xx with valid usage counts but NO providerAttempted attestation.
        return new Response(JSON.stringify({ text: 'Olá! Posso ajudar.', usage: { inputTokens: 10, outputTokens: 5 } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-receipt-missing'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.inference_error');
    expect(relayCalls).toBe(1);
    // Full reservation retained (never reconciled downward from an
    // unattested receipt), and the untrusted text is never published.
    const row = [...store.__state.attempts.values()].find((r) => r.intention_id === 'intent-receipt-missing')!;
    expect(row.state).toBe('settled');
    expect(row.counted_input_tokens).toBe(row.reserve_input_tokens);
    expect(row.counted_output_tokens).toBe(row.reserve_output_tokens);
    expect(persisted.filter((m) => m.role === 'assistant').map((m) => JSON.stringify(m))).not.toContainEqual(
      expect.stringContaining('Olá! Posso ajudar.'),
    );
  });

  it('2xx with explicit providerAttempted:false keeps the full reservation and rejects (never releases)', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
      }
      if (url.includes('/internal/agent/llm-relay')) {
        return new Response(
          JSON.stringify({ text: 'Olá! Posso ajudar.', providerAttempted: false, usage: { inputTokens: 10, outputTokens: 5 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-receipt-false'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.inference_error');
    const row = [...store.__state.attempts.values()].find((r) => r.intention_id === 'intent-receipt-false')!;
    // Contradictory success receipt: retained, never released.
    expect(row.state).toBe('settled');
    expect(row.counted_input_tokens).toBe(row.reserve_input_tokens);
  });

  it('end-to-end: grounding failure + denied correction reservation returns 429 with no fallback and no second dispatch', async () => {
    const { agent, persisted, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    // Size one reservation so the initial dispatch fits but the grounding
    // correction redispatch is denied: remaining budget covers exactly one
    // more attempt. The correction input is longer than the initial input,
    // so its reservation can only be larger — denial is deterministic.
    const promptText = 'Quanto gastei este mês?';
    const cognition = assembleCognition(promptText, { webEnv: {} });
    const estimated = estimateTokens(`${cognition.system.slice(0, 7_900)}${promptText.slice(0, 15_000)}`);
    const oneReservation = estimated + DEFAULT_POLICY.maxOutputTokens;
    recordUsage(store, 'user-1', 'seed-quota-prop', DEFAULT_POLICY.actorDailyBudget - oneReservation - 100, 0);

    let relayCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
      }
      if (url.includes('/internal/agent/llm-relay')) {
        relayCalls += 1;
        return new Response(
          JSON.stringify({ text: 'Seu gasto foi R$ 999,99 este mês.', providerAttempted: true }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await agent.fetch(chatRequest(promptText, 'intent-quota-prop-e2e'));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.quota_exceeded');
    // The denied correction never dispatched: exactly the initial leg ran.
    expect(relayCalls).toBe(1);
    // No grounded fallback 200 was published: no assistant message persisted.
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
