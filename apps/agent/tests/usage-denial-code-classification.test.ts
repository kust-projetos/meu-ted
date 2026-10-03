/**
 * FINDING 4 (review) — a rate-window denial is not a daily-quota denial.
 *
 * `reserveUsageAttempt` denies for three distinct reasons (per-request input
 * cap, sliding-window rate limit, daily budget) and the relay leg used to map
 * ALL of them to `agent.quota_exceeded`. The PWA then told the user the daily
 * quota was gone "try again tomorrow" — wrong guidance for a 20 req/60s rate
 * limit that clears in seconds.
 *
 * Contract pinned here:
 * - rate-window denial → `agent.usage_rate_limited` (still 429);
 * - per-request input-cap denial → `agent.usage_input_cap` (still 429);
 * - daily-budget denial → `agent.quota_exceeded`;
 * - unknown/absent reason → `agent.quota_exceeded` (conservative default);
 * - ALL of them remain usage-quota passthrough errors: no fallback leg, no
 *   retry of the same leg, no collapse into the generic safe-relay 502.
 *
 * FINDING 4 (review, round 3): the input cap is not a budget — retrying the
 * same oversized message can never succeed, so telling the user to "come back
 * tomorrow" is wrong. It needs its own code and copy.
 *
 * The `usage_` prefix is load-bearing: `agent.rate_limited` is the PROVIDER
 * rate limit relayed by the API relay and is fallback-ELIGIBLE by contract
 * (`isRelayFallbackEligible`). Reusing it here would silently disable
 * failover for every upstream 429.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent, usageReservationErrorCode } from '../src/finance-chat-agent.js';
import * as apiClient from '../src/tools/api-client.js';
import { DEFAULT_POLICY, recordUsage } from '../src/safety/usage-policy.js';
import { isRelayFallbackEligible, isUsageQuotaPassthroughError } from '../src/llm/relay-failover.js';
import { attachRelayUsageStorage, createRelayUsageStorage } from './helpers/relay-usage-storage.js';

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
    fallbackProtocol: null,
    fallbackRolloutPercentage: 0,
    fallbackRolloutMode: 'all',
    updatedBy: null,
  },
  activeProvider: null,
  activeModel: null,
  fallbackProvider: null,
  fallbackModel: null,
  activeDisabled: false,
  fallbackDisabled: false,
});

const SNAP_FALLBACK = {
  intention_id: 'intent-rate-classification',
  version: 1,
  provider_id: 'opencode-zen',
  model_id: 'opencode-zen:zen-primary',
  protocol: 'chat-completions',
  rollout_percentage: 100,
  security_epoch: 1,
  fallback_provider_id: 'opencode-zen',
  fallback_model_id: 'opencode-zen:zen-fallback',
  fallback_protocol: 'chat-completions',
  fallback_rollout_percentage: 100,
  model_name: 'zen-primary',
  fallback_model_name: 'zen-fallback',
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

const stubEgress = (): string[] => {
  const relayUrls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
    const url = String(info);
    if (url.includes('/internal/agent/llm-config')) {
      return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
    }
    if (url.includes('/internal/agent/llm-relay')) {
      relayUrls.push(url);
      return new Response(
        JSON.stringify({ text: 'Olá! Posso ajudar.', providerAttempted: true, usage: { inputTokens: 10, outputTokens: 5 } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return relayUrls;
};

describe('FINDING 4 — rate-window denial is agent.usage_rate_limited, daily budget stays agent.quota_exceeded', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a sliding-window rate denial answers 429 agent.usage_rate_limited with zero relay calls', async () => {
    const { agent, store } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const relayUrls = stubEgress();
    // Fill the sliding window (maxRequestsPerWindow) on the legacy ledger.
    for (let i = 0; i < DEFAULT_POLICY.maxRequestsPerWindow; i += 1) {
      recordUsage(store, 'user-1', `seed-rate-${i}`, 1, 1);
    }

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-rate-limited'));

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('agent.usage_rate_limited');
    // No leg dispatched and no fallback attempt consumed.
    expect(relayUrls).toHaveLength(0);
    expect(store.__state.attempts.size).toBe(0);
  });

  it('a daily-budget denial keeps answering 429 agent.quota_exceeded', async () => {
    const { agent, store } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const relayUrls = stubEgress();
    // Exhaust the actor daily budget (one seed row, sized from the policy).
    recordUsage(store, 'user-1', 'seed-budget', DEFAULT_POLICY.actorDailyBudget, 0);

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-budget-denied'));

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('agent.quota_exceeded');
    expect(relayUrls).toHaveLength(0);
  });

  it('both denial codes are usage-quota passthrough (no fallback leg, no retry)', () => {
    expect(isUsageQuotaPassthroughError({ code: 'agent.usage_rate_limited', status: 429 })).toBe(true);
    expect(isUsageQuotaPassthroughError({ code: 'agent.quota_exceeded', status: 429 })).toBe(true);
    // Still passthrough without the internal marker (cloned/rethrown errors).
    expect(isUsageQuotaPassthroughError(Object.assign(new Error('x'), { code: 'agent.usage_rate_limited' }))).toBe(true);
    // A plain provider error is NOT a quota gate: it must keep failing over.
    expect(isUsageQuotaPassthroughError({ code: 'agent.provider_error', status: 502 })).toBe(false);
  });

  it('the PROVIDER 429 code stays fallback-eligible and is NOT a usage passthrough', () => {
    // Regression guard for the code collision: `agent.rate_limited` is the
    // upstream/provider rate limit relayed by the API relay. Folding it into
    // the usage-passthrough set would disable provider failover entirely.
    const providerRateLimit = { code: 'agent.rate_limited', status: 429 };
    expect(isUsageQuotaPassthroughError(providerRateLimit)).toBe(false);
    expect(isRelayFallbackEligible(providerRateLimit)).toBe(true);
  });

  it('classifies every denial reason into its own code, defaulting to the quota code', () => {
    // The three ledger reasons, verbatim from `reserveUsageAttempt`.
    expect(usageReservationErrorCode('Rate limit exceeded: 20/20 requests in the last 60s')).toBe(
      'agent.usage_rate_limited',
    );
    expect(
      usageReservationErrorCode('Message exceeds maximum allowed input token limit of 2000 (estimated: 5725)'),
    ).toBe('agent.usage_input_cap');
    expect(usageReservationErrorCode('Daily token budget of 400000 exceeded (used: 400000, attempted: 7725)')).toBe(
      'agent.quota_exceeded',
    );
    expect(usageReservationErrorCode('Actor daily token budget of 200000 exceeded (used: 200000, attempted: 7725)')).toBe(
      'agent.quota_exceeded',
    );
    // Default: anything unrecognized (including a missing reason) stays the
    // conservative quota code — never a new, less-known one.
    expect(usageReservationErrorCode(undefined)).toBe('agent.quota_exceeded');
    expect(usageReservationErrorCode(null)).toBe('agent.quota_exceeded');
    expect(usageReservationErrorCode('')).toBe('agent.quota_exceeded');
    expect(usageReservationErrorCode('some future reason')).toBe('agent.quota_exceeded');
  });

  it('the input-cap code is usage-quota passthrough too (nothing was dispatched)', () => {
    expect(isUsageQuotaPassthroughError({ code: 'agent.usage_input_cap', status: 429 })).toBe(true);
    expect(isUsageQuotaPassthroughError(Object.assign(new Error('x'), { code: 'agent.usage_input_cap' }))).toBe(true);
  });

  it('an oversized message is denied as the input cap with zero relay calls', async () => {
    const { agent, store } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const relayUrls = stubEgress();

    // A prompt longer than maxInputTokens once combined with the system
    // prompt: the per-request cap denies it before any dispatch.
    const oversized = 'x'.repeat(DEFAULT_POLICY.maxInputTokens * 4 + 1);
    const res = await agent.fetch(chatRequest(oversized, 'intent-input-cap'));

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('agent.usage_input_cap');
    expect(relayUrls).toHaveLength(0);
    expect(store.__state.attempts.size).toBe(0);
  });
});
