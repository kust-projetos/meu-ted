/**
 * Relay usage-attempt ledger wiring (TDD RED first).
 *
 * Every provider transport dispatch on the active REST relay path must
 * reserve `estimateTokens(system+prompt) + DEFAULT_POLICY.maxOutputTokens`
 * BEFORE the relay fetch, forward `maxOutputTokens` to the API, and settle
 * the attempt from the private API attempt receipt (`providerAttempted` +
 * trustworthy `usage`). Only an explicit `providerAttempted:false` releases;
 * everything dispatched, missing, or contradictory retains the reservation.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import * as apiClient from '../src/tools/api-client.js';
import {
  DEFAULT_POLICY,
  estimateTokens,
  recordUsage,
} from '../src/safety/usage-policy.js';
import {
  attachRelayUsageStorage,
  createRelayUsageStorage,
  type RelayUsageTestStorage,
} from './helpers/relay-usage-storage.js';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(() => ({
      text: Promise.resolve('resposta-mockada'),
      finishReason: Promise.resolve('stop'),
      totalUsage: Promise.resolve({ totalTokens: 1 }),
    })),
  };
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

const SNAP_FALLBACK = {
  ...SNAP_SINGLE,
  intention_id: 'intent-relay-fallback',
  fallback_provider_id: 'opencode-go',
  fallback_model_id: 'opencode-go:go-fallback',
  fallback_model_name: 'go-fallback',
};

type RelayCall = { provider: string; model: string; raw: Record<string, unknown> };

const createChatAgent = (snapshot: Record<string, unknown>, storage?: RelayUsageTestStorage) => {
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
  const store = storage ?? createRelayUsageStorage();
  attachRelayUsageStorage(agent, store);
  return { agent, persisted, store };
};

const chatRequest = (
  text: string,
  intentionId: string,
  opts: { actor?: string; workspace?: string; bodyExtra?: Record<string, unknown> } = {},
) =>
  new Request('https://agent.test.local/rpc/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-actor': opts.actor ?? 'user-1',
      'x-agent-workspace': opts.workspace ?? 'ws-1',
    },
    body: JSON.stringify({ text, intentionId, ...(opts.bodyExtra ?? {}) }),
  });

type RelayResponder = (call: RelayCall, callIndex: number) => Response;

const stubEgress = (responder: RelayResponder, onRelayCall?: (call: RelayCall) => void) => {
  const calls: RelayCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (info, init) => {
    const url = String(info);
    if (url.includes('/internal/agent/llm-config')) {
      return new Response(JSON.stringify(snapshotBody(1)), { status: 200 });
    }
    if (url.includes('/internal/agent/llm-relay')) {
      const raw = JSON.parse(String((init as RequestInit)?.body ?? '{}')) as Record<string, unknown>;
      const call: RelayCall = {
        provider: String(raw.provider ?? ''),
        model: String(raw.model ?? ''),
        raw,
      };
      calls.push(call);
      onRelayCall?.(call);
      return responder(call, calls.length);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
};

const okRelay = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ text: 'Olá! Posso ajudar com suas finanças.', providerAttempted: true, ...extra }), {
    status: 200,
  });

describe('relay usage attempts (RED)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reserves estimate + maxOutputTokens before dispatch and forwards the cap', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress(() => okRelay({ usage: { inputTokens: 120, outputTokens: 40 } }));

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-cap-1'));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.raw.maxOutputTokens).toBe(DEFAULT_POLICY.maxOutputTokens);
    expect(calls[0]!.raw.sessionId).toBe('ted-ws-1');

    const rows = [...store.__state.attempts.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('settled');
    expect(rows[0]!.reserve_output_tokens).toBe(DEFAULT_POLICY.maxOutputTokens);
    expect(rows[0]!.reserve_input_tokens).toBeGreaterThan(0);
    expect(rows[0]!.actor_id).toBe('user-1');
    expect(rows[0]!.intention_id).toBe('intent-cap-1');
  });

  it('success with reliable usage reconciles to actuals; missing/invalid usage retains the reserve', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    stubEgress((call, index) => {
      if (index === 1) return okRelay({ usage: { inputTokens: 120, outputTokens: 40 } });
      if (index === 2) return okRelay();
      return okRelay({ usage: { inputTokens: -5, outputTokens: 'dez' } });
    });

    expect((await agent.fetch(chatRequest('Olá, como você está?', 'intent-use-1'))).status).toBe(200);
    expect((await agent.fetch(chatRequest('Olá, como você está?', 'intent-use-2'))).status).toBe(200);
    expect((await agent.fetch(chatRequest('Olá, como você está?', 'intent-use-3'))).status).toBe(200);

    const byIntention = new Map(
      [...store.__state.attempts.values()].map((r) => [r.intention_id, r] as const),
    );
    expect(byIntention.get('intent-use-1')?.counted_input_tokens).toBe(120);
    expect(byIntention.get('intent-use-1')?.counted_output_tokens).toBe(40);
    const missing = byIntention.get('intent-use-2')!;
    expect(missing.counted_input_tokens).toBe(missing.reserve_input_tokens);
    expect(missing.counted_output_tokens).toBe(missing.reserve_output_tokens);
    const invalid = byIntention.get('intent-use-3')!;
    expect(invalid.counted_input_tokens).toBe(invalid.reserve_input_tokens);
    expect(invalid.counted_output_tokens).toBe(invalid.reserve_output_tokens);
  });

  it('explicit providerAttempted:false releases the attempt and preserves the error code', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress(
      () =>
        new Response(JSON.stringify({ code: 'validation.error', message: 'bad', providerAttempted: false }), {
          status: 400,
        }),
    );

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-false-1'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('validation.error');
    expect(calls).toHaveLength(1);

    const rows = [...store.__state.attempts.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('not_dispatched');
    expect(rows[0]!.counted_input_tokens).toBe(0);
    expect(rows[0]!.counted_output_tokens).toBe(0);
  });

  it('dispatched 429/5xx retains the full reservation with exact code/status', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress((_call, index) =>
      index === 1
        ? new Response(JSON.stringify({ code: 'agent.rate_limited', message: 'slow', providerAttempted: true }), {
            status: 429,
          })
        : new Response(JSON.stringify({ code: 'agent.provider_error', message: 'boom', providerAttempted: true }), {
            status: 502,
          }),
    );

    const res429 = await agent.fetch(chatRequest('Olá, como você está?', 'intent-429-1'));
    expect(res429.status).toBe(429);
    expect(((await res429.json()) as { code?: string }).code).toBe('agent.rate_limited');
    const res502 = await agent.fetch(chatRequest('Olá, como você está?', 'intent-502-1'));
    expect(res502.status).toBe(502);
    expect(((await res502.json()) as { code?: string }).code).toBe('agent.provider_error');
    expect(calls).toHaveLength(2);

    for (const id of ['intent-429-1', 'intent-502-1']) {
      const row = [...store.__state.attempts.values()].find((r) => r.intention_id === id)!;
      expect(row.state).toBe('settled');
      expect(row.counted_input_tokens).toBe(row.reserve_input_tokens);
      expect(row.counted_output_tokens).toBe(row.reserve_output_tokens);
    }
  });

  it('quota deny sends zero relay calls, no fallback, and preserves the typed error', async () => {
    const { agent, store } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress(() => okRelay());
    // Exhaust the actor/workspace budgets on the legacy ledger. The seed is
    // derived from the LIVE policy constants (not hardcoded) so a budget
    // recalibration cannot silently turn this "denied" case into a pass.
    recordUsage(store, 'user-1', 'seed-exhaust', DEFAULT_POLICY.actorDailyBudget, 0);

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-quota-1'));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('agent.quota_exceeded');
    expect(calls).toHaveLength(0);
    // Denied reservations never create rows, so no fallback leg can consume them.
    expect(store.__state.attempts.size).toBe(0);
  });

  it('primary failure + fallback dispatch reserves two independent attempts', async () => {
    const { agent, store } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ transactions: [] });
    const calls = stubEgress((call) =>
      call.provider === 'opencode-zen'
        ? new Response(JSON.stringify({ code: 'agent.rate_limited', message: 'slow', providerAttempted: true }), {
            status: 429,
          })
        : okRelay({ usage: { inputTokens: 90, outputTokens: 20 } }),
    );

    const res = await agent.fetch(chatRequest('Quanto gastei este mês?', 'intent-two-legs'));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.provider).toBe('opencode-zen');
    expect(calls[1]!.provider).toBe('opencode-go');

    const rows = [...store.__state.attempts.values()];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.attempt_id)).size).toBe(2);
    for (const row of rows) expect(row.state).toBe('settled');
  });

  it('grounding correction reentry reserves a separate attempt', async () => {
    const { agent, store } = createChatAgent(SNAP_FALLBACK);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ transactions: [] });
    const calls = stubEgress((_call, index) =>
      index === 1
        ? new Response(
            JSON.stringify({ text: 'Seu gasto foi R$ 999,99 este mês.', providerAttempted: true }),
            { status: 200 },
          )
        : okRelay(),
    );

    const res = await agent.fetch(chatRequest('Quanto gastei este mês?', 'intent-correction'));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const rows = [...store.__state.attempts.values()];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.attempt_id)).size).toBe(2);
  });

  it('missing transactionSync returns safe 503 before any relay dispatch', async () => {
    const { agent } = createChatAgent(SNAP_SINGLE);
    // Degraded storage: exec-only, no atomic check-and-reserve.
    Object.defineProperty(agent, 'ctx', {
      value: {
        storage: {
          sql: {
            exec: (<T>(query: string, ..._bindings: unknown[]): Iterable<T> => {
              if (query.includes('SELECT COUNT(*) AS req_count')) return [{ req_count: 0 }] as unknown as Iterable<T>;
              if (query.includes('SELECT COALESCE(SUM')) return [{ total_tokens: 0 }] as unknown as Iterable<T>;
              return [] as unknown as Iterable<T>;
            }),
          },
        },
      },
      writable: true,
      configurable: true,
    });
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress(() => okRelay());

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-no-tx'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('agent.persistence_unavailable');
    expect(calls).toHaveLength(0);
  });

  it('deterministic no-provider turns stay free (mutation proposal without device)', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress(() => okRelay());

    const res = await agent.fetch(chatRequest('registrar despesa de 50 reais no mercado hoje', 'intent-free-1'));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(store.__state.attempts.size).toBe(0);
    expect(store.__transactionSyncCalls()).toBe(0);
  });

  it('quota identity comes from verified headers, never payload IDs', async () => {
    const { agent, store } = createChatAgent(SNAP_SINGLE);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    stubEgress(() => okRelay({ usage: { inputTokens: 10, outputTokens: 5 } }));

    const res = await agent.fetch(
      chatRequest('Olá, como você está?', 'intent-spoof-1', {
        bodyExtra: { actorId: 'spoofed-actor', workspaceId: 'spoofed-ws', actor_id: 'spoofed-actor-2' },
      }),
    );
    expect(res.status).toBe(200);
    const rows = [...store.__state.attempts.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe('user-1');
    expect(rows[0]!.intention_id).toBe('intent-spoof-1');
  });

  it('estimateTokens covers the full transmitted system+prompt', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(DEFAULT_POLICY.maxOutputTokens).toBe(2000);
  });

  it('usageAttemptStorage preserves the DurableObjectStorage receiver for transactionSync', () => {
    const { agent } = createChatAgent(SNAP_SINGLE);
    const base = createRelayUsageStorage();
    const strictStorage = {
      sql: { exec: base.exec },
      transactionSync<T>(this: unknown, fn: () => T): T {
        if (this !== strictStorage) throw new TypeError('transactionSync receiver lost');
        return fn();
      },
    };
    Object.defineProperty(agent, 'ctx', {
      value: { storage: strictStorage },
      writable: true,
      configurable: true,
    });
    const priv = agent as unknown as {
      usageAttemptStorage(): { transactionSync<T>(fn: () => T): T } | null;
    };
    const wrapped = priv.usageAttemptStorage();
    expect(wrapped).not.toBeNull();
    expect(wrapped!.transactionSync(() => 'ok')).toBe('ok');
  });

  it('storage reserve failure maps to sanitized 503 with zero relay calls', async () => {
    const { agent, persisted, store } = createChatAgent(SNAP_FALLBACK);
    const rawDbError = 'SECRET-DB-PATH /var/data/ted.db: disk I/O error';
    const baseExec = store.exec;
    const failingExec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
      if (query.includes('INSERT INTO usage_attempts')) throw new Error(rawDbError);
      return (baseExec as (q: string, ...p: unknown[]) => Iterable<T>)(query, ...params);
    }) as typeof store.exec;
    const failing = { ...store, exec: failingExec };
    attachRelayUsageStorage(agent, failing);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({});
    const calls = stubEgress(() => okRelay());

    const res = await agent.fetch(chatRequest('Olá, como você está?', 'intent-reserve-fail-1'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('agent.persistence_unavailable');
    expect(calls).toHaveLength(0);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
    // No database error text leaks to the client.
    expect(JSON.stringify(body)).not.toContain('SECRET-DB-PATH');
    expect(JSON.stringify(body)).not.toContain('disk I/O error');
  });

  it('grounding correction reserve failure maps to sanitized 503 with one relay call', async () => {
    const { agent, persisted, store } = createChatAgent(SNAP_FALLBACK);
    const rawDbError = 'SECRET-DB-PATH /var/data/ted.db: disk I/O error';
    const baseExec = store.exec;
    let reserveInserts = 0;
    const failingExec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
      if (query.includes('INSERT INTO usage_attempts')) {
        reserveInserts += 1;
        if (reserveInserts >= 2) throw new Error(rawDbError);
      }
      return (baseExec as (q: string, ...p: unknown[]) => Iterable<T>)(query, ...params);
    }) as typeof store.exec;
    const failing = { ...store, exec: failingExec };
    attachRelayUsageStorage(agent, failing);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ transactions: [] });
    const calls = stubEgress((_call, index) =>
      index === 1
        ? new Response(
            JSON.stringify({ text: 'Seu gasto foi R$ 999,99 este mês.', providerAttempted: true }),
            { status: 200 },
          )
        : okRelay(),
    );

    const res = await agent.fetch(chatRequest('Quanto gastei este mês?', 'intent-correction-reserve-fail'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('agent.persistence_unavailable');
    // Initial leg dispatched once; the denied correction reservation never
    // dispatches a fallback leg or a correction redispatch.
    expect(calls).toHaveLength(1);
    // No database error text leaks to the client.
    expect(JSON.stringify(body)).not.toContain('SECRET-DB-PATH');
    expect(JSON.stringify(body)).not.toContain('disk I/O error');
    // No grounded assistant success was published.
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
