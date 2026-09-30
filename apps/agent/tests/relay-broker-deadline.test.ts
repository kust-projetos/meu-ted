import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';
import * as apiClient from '../src/tools/api-client.js';
import { executeBrokerCompletion } from '../src/llm/private-broker-client.js';
// RED: this helper does not exist yet — it must enforce one absolute
// deadline over relay fetch headers AND body parsing, even when fetch or
// body ignores abort.
import { fetchRelayJsonWithDeadline } from '../src/finance-chat-agent.js';

const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const snapshotBody = () => ({
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: 1,
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

describe('W2-ITEM6 RED: relay absolute deadline (headers + body)', () => {
  it('header-hung fetch ignoring abort still rejects within the absolute budget', async () => {
    const gate = deferred<Response>();
    const hangingFetch = vi.fn(() => gate.promise);
    const start = Date.now();
    await expect(
      fetchRelayJsonWithDeadline(
        hangingFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        30,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    // The abort signal must have been sent to the hung fetch.
    const signal = (hangingFetch.mock.calls[0] as unknown as Array<{ signal?: AbortSignal }> | undefined)?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    gate.resolve(new Response(JSON.stringify({ text: 'late success must not win' }), { status: 200 }));
  });

  it('body-hung response.json ignoring abort still rejects; late body cannot become success', async () => {
    const bodyGate = deferred<unknown>();
    const hangingFetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: () => bodyGate.promise }) as unknown as Response,
    );
    await expect(
      fetchRelayJsonWithDeadline(
        hangingFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        30,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    // Late body resolution after the deadline must not resurrect success.
    bodyGate.resolve({ text: 'late body' });
    await new Promise((r) => setTimeout(r, 10));
  });

  it('ordinary fast success before the deadline preserves content', async () => {
    const okFetch = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'hello' }), { status: 200 }),
    );
    const res = await fetchRelayJsonWithDeadline(
      okFetch as unknown as typeof fetch,
      'https://api.test.local/internal/agent/llm-relay',
      { method: 'POST', headers: {}, body: '{}' },
      1_000,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'hello' });
  });

  it('delayed event loop: headers resolving before timer callback still fail closed via monotonic deadline', async () => {
    let now = 1_000;
    const fastButLateFetch = vi.fn(async () => {
      // Event loop was blocked: headers resolve only after the absolute
      // deadline passed, but the timer callback has not fired yet.
      now = 1_000 + 5_000;
      return new Response(JSON.stringify({ text: 'late success must not win' }), { status: 200 });
    });
    await expect(
      fetchRelayJsonWithDeadline(
        fastButLateFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        50,
        { now: () => now },
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('delayed event loop: body resolving before timer callback still fail closed via monotonic deadline', async () => {
    let now = 2_000;
    const lateBodyFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          now = 2_000 + 5_000;
          return { text: 'late body' };
        },
      }) as unknown as Response,
    );
    await expect(
      fetchRelayJsonWithDeadline(
        lateBodyFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        50,
        { now: () => now },
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('W2-ITEM6 resource cleanup: relay body cancel (FIX-AGENT-RELAY-DISCARDED-BODY-CANCEL)', () => {
  it('timeout while .json() is pending cancels the known response body without awaiting', async () => {
    const bodyGate = deferred<unknown>();
    const cancel = vi.fn(() => Promise.resolve());
    const hangingBodyFetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: () => bodyGate.promise, body: { cancel } }) as unknown as Response,
    );
    await expect(
      fetchRelayJsonWithDeadline(
        hangingBodyFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        30,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    bodyGate.resolve({ text: 'late body' });
    await new Promise((r) => setTimeout(r, 10));
  });

  it('late headers resolving after the race timeout get their body canceled; late data never accepted', async () => {
    const gate = deferred<Response>();
    const cancel = vi.fn(() => Promise.resolve());
    const hangingFetch = vi.fn(() => gate.promise);
    await expect(
      fetchRelayJsonWithDeadline(
        hangingFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        30,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    gate.resolve({ ok: true, status: 200, json: async () => ({ text: 'late' }), body: { cancel } } as unknown as Response);
    await new Promise((r) => setTimeout(r, 10));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('FIX-AGENT-RELAY-CANCEL-ONCE: expired monotonic clock with timer not yet fired discards exactly once', async () => {
    let now = 1_000;
    const cancel = vi.fn(() => Promise.resolve());
    const lateButPreTimerFetch = vi.fn(async () => {
      // Headers resolve after the absolute deadline, but the real timer
      // (50 ms) has not fired yet — fail-closed via the monotonic clock.
      now = 1_000 + 5_000;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'late success must not win' }),
        body: { cancel },
      } as unknown as Response;
    });
    await expect(
      fetchRelayJsonWithDeadline(
        lateButPreTimerFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        50,
        { now: () => now },
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    // No arbitrary wall wait: the monotonic expiry settles synchronously
    // with the fetch fulfillment; the late-handler microtask has run by the
    // time the race continuation rejects. Exactly one discard, typed timeout.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('ordinary fast success never cancels the body', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const okFetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ text: 'hello' }), body: { cancel } }) as unknown as Response,
    );
    const res = await fetchRelayJsonWithDeadline(
      okFetch as unknown as typeof fetch,
      'https://api.test.local/internal/agent/llm-relay',
      { method: 'POST', headers: {}, body: '{}' },
      1_000,
    );
    expect(res.body).toEqual({ text: 'hello' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('timeout stays typed/finite when body.cancel is locked (sync throw is swallowed)', async () => {
    const bodyGate = deferred<unknown>();
    const cancel = vi.fn(() => {
      throw new Error('locked');
    });
    const hangingBodyFetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: () => bodyGate.promise, body: { cancel } }) as unknown as Response,
    );
    const start = Date.now();
    await expect(
      fetchRelayJsonWithDeadline(
        hangingBodyFetch as unknown as typeof fetch,
        'https://api.test.local/internal/agent/llm-relay',
        { method: 'POST', headers: {}, body: '{}' },
        30,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(cancel).toHaveBeenCalledTimes(1);
    bodyGate.resolve({ text: 'late body' });
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('W2-ITEM6 RED: private broker bounded fetch/body', () => {
  const baseOptions = {
    brokerOrigin: 'https://broker.example.test',
    signingKey: SIGNING_KEY,
  };
  const basePayload = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Olá' }],
    requestId: 'req-1',
    intentionId: 'intent-1',
    workspaceId: 'ws-1',
    actorId: 'user-1',
  };

  it('fetch that ignores abort fails safe with a typed timeout (no fabricated output)', async () => {
    const gate = deferred<Response>();
    const hangingFetch = vi.fn(() => gate.promise);
    await expect(
      executeBrokerCompletion(baseOptions, basePayload, hangingFetch as unknown as typeof fetch, {
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'agent.provider_timeout' });
    gate.resolve(new Response('late', { status: 200 }));
  });

  it('hung body json fails safe with a typed timeout', async () => {
    const bodyGate = deferred<unknown>();
    const hangingBodyFetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: () => bodyGate.promise }) as unknown as Response,
    );
    await expect(
      executeBrokerCompletion(
        baseOptions,
        basePayload,
        hangingBodyFetch as unknown as typeof fetch,
        { timeoutMs: 30 },
      ),
    ).rejects.toMatchObject({ code: 'agent.provider_timeout' });
    bodyGate.resolve({ id: 'late', model: 'm', choices: [], usage: {} });
  });

  it('delayed event loop: headers resolving before timer callback still fail closed via monotonic deadline', async () => {
    let now = 1_000;
    const fastButLateFetch = vi.fn(async () => {
      now = 1_000 + 5_000;
      return new Response(
        JSON.stringify({
          id: 'late',
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    });
    await expect(
      executeBrokerCompletion(baseOptions, basePayload, fastButLateFetch as unknown as typeof fetch, {
        timeoutMs: 50,
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: 'agent.provider_timeout' });
  });

  it('delayed event loop: body resolving before timer callback still fail closed via monotonic deadline', async () => {
    let now = 2_000;
    const lateBodyFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          now = 2_000 + 5_000;
          return {
            id: 'late',
            model: 'm',
            choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      }) as unknown as Response,
    );
    await expect(
      executeBrokerCompletion(
        baseOptions,
        basePayload,
        lateBodyFetch as unknown as typeof fetch,
        { timeoutMs: 50, now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'agent.provider_timeout' });
  });

  it('non-2xx never echoes upstream body (prompt/system/secret/CRLF markers stay out)', async () => {
    const marker = `PROMPT-MARKER-xyz system-prompt-secret sk-secret-BBB\r\nINJECTED-CRLF`;
    const badFetch = vi.fn(async () => new Response(marker, { status: 502 }));
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      badFetch as unknown as typeof fetch,
      { timeoutMs: 1_000 },
    ).catch((e: unknown) => e as Error & { code?: string; status?: number });
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message ?? '');
    expect(msg).not.toContain('PROMPT-MARKER-xyz');
    expect(msg).not.toContain('system-prompt-secret');
    expect(msg).not.toContain('sk-secret-BBB');
    expect(msg).not.toContain('INJECTED-CRLF');
    expect((err as { code?: string }).code).toBe('agent.provider_error');
    expect((err as { status?: number }).status).toBe(502);
  });

  it('FIX-AGENT-BROKER-LATE-HEADERS-CANCEL: late headers after timeout get body canceled exactly once', async () => {
    let resolveFetch!: (v: unknown) => void;
    const gate = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    const cancel = vi.fn(() => Promise.resolve());
    const hangingFetch = vi.fn(() => gate as Promise<Response>);
    const pending = executeBrokerCompletion(
      baseOptions,
      basePayload,
      hangingFetch as unknown as typeof fetch,
      { timeoutMs: 30 },
    );
    await expect(pending).rejects.toMatchObject({ code: 'agent.provider_timeout' });
    resolveFetch({
      ok: true,
      status: 200,
      body: { cancel },
      json: async () => ({
        id: 'late',
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);
    await new Promise((r) => setTimeout(r, 10));
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({ code: 'agent.provider_timeout' });
  });

  it('FIX-AGENT-BROKER-LATE-HEADERS-CANCEL: fast success never cancels the body', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const okFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        body: { cancel },
        json: async () => ({
          id: 'ok',
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      }) as unknown as Response,
    );
    const result = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      okFetch as unknown as typeof fetch,
      { timeoutMs: 1_000 },
    );
    expect(result.id).toBe('ok');
    expect(cancel).not.toHaveBeenCalled();
    expect((result as unknown as { body?: unknown }).body).toBeUndefined();
  });
});

describe('W2-ITEM6 RED: next REST turn not queued behind a hung relay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createChatAgent = (relayTimeoutMs = '40') => {
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
        // Timeout injection per test: the adjacent 504 test keeps the short
        // 40 ms budget; the concurrency proof below injects a large budget.
        // Production default stays RELAY_ATTEMPT_TIMEOUT_MS (60 s).
        AGENT_RELAY_TIMEOUT_MS: relayTimeoutMs,
      },
      writable: true,
      configurable: true,
    });
    (agent as unknown as { resolveIntentionSnapshot: () => Promise<unknown> }).resolveIntentionSnapshot =
      async () => ({
        intention_id: 'intent-x',
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
      });
    return { agent, persisted };
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

  it('/rpc/chat never routes through enqueueChat (import-only serialization)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/finance-chat-agent.ts', import.meta.url), 'utf8');
    const chatStart = source.indexOf('if (url.pathname === "/rpc/chat" && request.method === "POST")');
    const memoryStart = source.indexOf('if (url.pathname === "/rpc/memory/prefs" && request.method === "POST")');
    expect(chatStart).toBeGreaterThanOrEqual(0);
    const restHandler = source.slice(chatStart, memoryStart);
    expect(restHandler).not.toContain('enqueueChat');
  });

  it('a later unrelated turn completes while the earlier relay fetch stays hung', async () => {
    // Concurrency proof: the first leg gets a large test-only per-leg
    // budget so it stays pending while the short second turn runs. A
    // serialized /rpc/chat would queue the second turn behind the hung
    // first relay fetch and hit the test-local guard below.
    const { agent } = createChatAgent('5000');
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ transactions: [] });
    const hungGate = deferred<Response>();
    // Deterministic barrier: resolved when the first relay fetch actually
    // starts (HUNG-TURN prompt reaches agent.fetch), not via sleep().
    const firstFetchStarted = deferred<void>();
    let firstSettled = false;
    const okRelayBody = () => JSON.stringify({ text: 'Aqui está o resumo das suas movimentações.', providerAttempted: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info, init) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      const body = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as {
        prompt?: string;
      };
      if (body.prompt?.includes('HUNG-TURN')) {
        // Hung provider request that ignores abort — stays pending.
        firstFetchStarted.resolve();
        return hungGate.promise;
      }
      return new Response(okRelayBody(), {
        status: 200,
      });
    });
    const first = agent.fetch(chatRequest('Quanto gastei este mês? HUNG-TURN', 'intent-hung-1'));
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    try {
      // Wait for proof the first HTTP turn itself is pending in its relay
      // fetch before starting the second turn — no sleep-based ordering.
      await firstFetchStarted.promise;
      // Test-local guard only: fail closed if the second turn never
      // completes because it serialized behind the hung first turn.
      const secondGuard = deferred<never>();
      const secondTimer = setTimeout(() => {
        secondGuard.reject(
          new Error('second turn did not complete while first relay fetch stayed hung — /rpc/chat appears serialized'),
        );
      }, 5_000);
      try {
        const second = await Promise.race([
          agent.fetch(chatRequest('Quanto gastei este mês?', 'intent-free-2')),
          secondGuard.promise,
        ]);
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as { status?: string };
        expect(secondBody.status).toBe('completed');
        // The second 200 completed while the first HTTP turn itself is
        // still pending and its provider promise is unresolved.
        expect(firstSettled).toBe(false);
      } finally {
        clearTimeout(secondTimer);
      }
    } finally {
      // Always release the hung provider promise to avoid leaks on failure.
      hungGate.resolve(new Response(okRelayBody(), { status: 200 }));
    }
    // First leg resolves successfully once its gate is released, well
    // before its large test-only deadline — strictly 200, no 504 branch.
    const firstRes = await first;
    expect(firstSettled).toBe(true);
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as { status?: string };
    expect(firstBody.status).toBe('completed');
    vi.restoreAllMocks();
  });

  it('first hung relay times out with typed 504 and no assistant persistence, then second turn succeeds while provider promise stays pending', async () => {
    const { agent, persisted } = createChatAgent();
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ transactions: [] });
    // Never-resolved provider promise: the first leg stays hung forever.
    const hungGate = deferred<Response>();
    let hungSettled = false;
    void hungGate.promise.then(
      () => { hungSettled = true; },
      () => { hungSettled = true; },
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info, init) => {
      const url = String(info);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      const body = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as {
        prompt?: string;
      };
      if (body.prompt?.includes('HUNG-TIMEOUT-TURN')) {
        return hungGate.promise;
      }
      return new Response(JSON.stringify({ text: 'Aqui está o resumo das suas movimentações.', providerAttempted: true }), {
        status: 200,
      });
    });
    try {
      // First turn hangs until its short injected per-leg budget expires.
      const firstRes = await agent.fetch(chatRequest('Quanto gastei este mês? HUNG-TIMEOUT-TURN', 'intent-hung-timeout-1'));
      expect(firstRes.status).toBe(504);
      const firstBody = (await firstRes.json()) as { code?: string };
      expect(firstBody.code).toBe('agent.provider_timeout');
      // No successful assistant persistence from the timed-out turn.
      expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
      // Provider promise still unresolved after the timeout.
      await new Promise((r) => setTimeout(r, 10));
      expect(hungSettled).toBe(false);
      // Second unrelated turn succeeds while the first provider promise
      // remains pending. Supplements (does not replace) the pre-timeout
      // concurrency test above; no broader DO serialization claim.
      const second = await agent.fetch(chatRequest('Quanto gastei este mês?', 'intent-free-after-timeout-2'));
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { status?: string };
      expect(secondBody.status).toBe('completed');
      expect(hungSettled).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
