import { describe, expect, it, vi } from 'vitest';
import {
  computeSha256,
  signBrokerEnvelope,
  executeBrokerCompletion,
  type BrokerEnvelope,
} from '../src/llm/private-broker-client.js';

describe('Private Broker Client (Task 5A)', () => {
  const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';

  it('computes sha256 of payload string', async () => {
    const hash = await computeSha256('{"test":"payload"}');
    expect(hash).toHaveLength(64);
  });

  it('signs envelope using HMAC-SHA256', async () => {
    const envelope: BrokerEnvelope = {
      kid: 'agent-worker',
      aud: 'pi-codex-broker',
      timestamp: 1700000000000,
      nonce: 'nonce-123',
      requestId: 'req-123',
      bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };

    const signature = await signBrokerEnvelope(envelope, SIGNING_KEY);
    expect(signature).toHaveLength(64);
  });

  it('executes completion with Cloudflare Access and HMAC headers', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-123',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'Resposta do broker' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { status: 200 },
      ),
    );

    const result = await executeBrokerCompletion(
      {
        brokerOrigin: 'https://broker.example.test',
        cfAccessClientId: 'cf-id-1',
        cfAccessClientSecret: 'cf-secret-1',
        signingKey: SIGNING_KEY,
      },
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Olá' }],
        requestId: 'req-1',
        intentionId: 'intent-1',
        workspaceId: 'ws-1',
        actorId: 'user-1',
      },
      fetchMock,
    );

    expect(result.id).toBe('chatcmpl-123');
    expect(result.choices[0]?.message.content).toBe('Resposta do broker');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://broker.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'cf-access-client-id': 'cf-id-1',
          'cf-access-client-secret': 'cf-secret-1',
        }),
        redirect: 'manual',
      }),
    );
  });

  it('non-2xx throws a fixed generic message without echoing upstream body', async () => {
    const marker = 'PROMPT-MARKER-xyz system-prompt-secret sk-secret-BBB\r\nINJECTED-CRLF';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(marker, { status: 502 }));
    const err = await executeBrokerCompletion(
      {
        brokerOrigin: 'https://broker.example.test',
        signingKey: SIGNING_KEY,
      },
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Olá' }],
        requestId: 'req-1',
        intentionId: 'intent-1',
        workspaceId: 'ws-1',
        actorId: 'user-1',
      },
      fetchMock,
      { timeoutMs: 1_000 },
    ).catch((e: unknown) => e as Error & { code?: string; status?: number });
    const msg = String((err as Error).message ?? '');
    expect(msg).not.toContain('PROMPT-MARKER-xyz');
    expect(msg).not.toContain('system-prompt-secret');
    expect(msg).not.toContain('sk-secret-BBB');
    expect(msg).not.toContain('INJECTED-CRLF');
    expect((err as { code?: string }).code).toBe('agent.provider_error');
    expect((err as { status?: number }).status).toBe(502);
  });

  it('delayed event loop: body resolving past the monotonic deadline fails closed as timeout', async () => {
    let now = 2_000;
    const lateBodyFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          now = 2_000 + 5_000;
          return {
            id: 'late',
            model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      }) as unknown as Response,
    );
    await expect(
      executeBrokerCompletion(
        { brokerOrigin: 'https://broker.example.test', signingKey: SIGNING_KEY },
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Olá' }],
          requestId: 'req-1',
          intentionId: 'intent-1',
          workspaceId: 'ws-1',
          actorId: 'user-1',
        },
        lateBodyFetch as unknown as typeof fetch,
        { timeoutMs: 50, now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'agent.provider_timeout' });
  });
});

describe('FIX-AGENT-BROKER-BOUNDED-SAFE-ERRORS (TDD RED)', () => {
  const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';
  const baseOptions = { brokerOrigin: 'https://broker.example.test', signingKey: SIGNING_KEY };
  const basePayload = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Olá' }],
    requestId: 'req-1',
    intentionId: 'intent-1',
    workspaceId: 'ws-1',
    actorId: 'user-1',
  };
  const loadMod = () => import('../src/llm/private-broker-client.js');

  it('exposes a testable effective-timeout helper bounded to 60s', async () => {
    const mod = await loadMod();
    const resolve = (mod as unknown as { resolveBrokerTimeoutMs?: unknown }).resolveBrokerTimeoutMs;
    expect(typeof resolve).toBe('function');
    const fn = resolve as (callMs?: number, optionsMs?: number) => number;
    expect(fn(undefined, undefined)).toBe(60_000);
    expect(fn(Number.POSITIVE_INFINITY, undefined)).toBe(60_000);
    expect(fn(120_000, undefined)).toBe(60_000);
    expect(fn(0, undefined)).toBe(60_000);
    expect(fn(Number.NaN, undefined)).toBe(60_000);
    expect(fn(-5, undefined)).toBe(60_000);
    expect(fn(undefined, Number.POSITIVE_INFINITY)).toBe(60_000);
    expect(fn(undefined, 120_000)).toBe(60_000);
    expect(fn(5_000, undefined)).toBe(5_000);
  });

  it('actual timer uses the capped budget (120s override fires at 60s scale)', async () => {
    const mod = await loadMod();
    const delays: unknown[] = [];
    const orig = globalThis.setTimeout;
    const spy = vi.fn(((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms);
      return orig(cb as never, ms as never, ...(rest as []));
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(spy as unknown as typeof setTimeout);
    try {
      const okFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'ok',
            model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        ),
      );
      await executeBrokerCompletion(baseOptions, basePayload, okFetch as unknown as typeof fetch, {
        timeoutMs: 120_000,
      });
      expect(delays.length).toBeGreaterThan(0);
      expect(delays[0]).toBe(60_000);
      void mod;
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('Infinity override resolves to the safe default instead of an unbounded timer', async () => {
    // No hanging fetch here: the capped 60 s budget is verified via the
    // armed setTimeout delay plus immediate TimeoutError conversion, so the
    // test never waits out the real 60 s budget.
    const delays: unknown[] = [];
    const orig = globalThis.setTimeout;
    const spy = vi.fn(((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms);
      return orig(cb as never, ms as never, ...(rest as []));
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(spy as unknown as typeof setTimeout);
    try {
      const raw = Object.assign(new Error('upstream PROMPT-MARKER-xyz sk-secret-BBB'), {
        name: 'TimeoutError',
      });
      const badFetch = vi.fn(async () => {
        throw raw;
      });
      const err = await executeBrokerCompletion(
        baseOptions,
        basePayload,
        badFetch as unknown as typeof fetch,
        { timeoutMs: Number.POSITIVE_INFINITY },
      ).catch((e: unknown) => e as Error & { code?: string });
      expect((err as { code?: string }).code).toBe('agent.provider_timeout');
      expect(String((err as Error).message)).toContain('60000ms');
      expect(String((err as Error).message)).not.toContain('Infinity');
      expect(String((err as Error).message)).not.toContain('PROMPT-MARKER-xyz');
      expect(delays.length).toBeGreaterThan(0);
      expect(delays[0]).toBe(60_000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('AbortError carrying a raw secret never leaks the message', async () => {
    const raw = Object.assign(new Error('sk-secret-AAA abort upstream PROMPT-MARKER'), {
      name: 'AbortError',
    });
    const badFetch = vi.fn(async () => {
      throw raw;
    });
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      badFetch as unknown as typeof fetch,
      { timeoutMs: 1_000 },
    ).catch((e: unknown) => e as Error & { code?: string });
    const msg = String((err as Error).message ?? '');
    expect(msg).not.toContain('sk-secret-AAA');
    expect(msg).not.toContain('PROMPT-MARKER');
    expect((err as { code?: string }).code).toBe('agent.provider_error');
  });

  it('AbortError past the monotonic deadline becomes the fixed timeout', async () => {
    let now = 9_000;
    const raw = Object.assign(new Error('sk-secret-AAA abort late'), { name: 'AbortError' });
    const badFetch = vi.fn(async () => {
      now = 9_000 + 5_000;
      throw raw;
    });
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      badFetch as unknown as typeof fetch,
      { timeoutMs: 50, now: () => now },
    ).catch((e: unknown) => e as Error & { code?: string });
    expect((err as { code?: string }).code).toBe('agent.provider_timeout');
    expect(String((err as Error).message)).not.toContain('sk-secret-AAA');
  });

  it('TimeoutError with raw body/message is converted to the fixed broker timeout', async () => {
    const raw = Object.assign(
      new Error('upstream says: PROMPT-MARKER-xyz sk-secret-BBB body-hostile'),
      { name: 'TimeoutError' },
    );
    const badFetch = vi.fn(async () => {
      throw raw;
    });
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      badFetch as unknown as typeof fetch,
      { timeoutMs: 1_000 },
    ).catch((e: unknown) => e as Error & { code?: string; status?: number });
    const msg = String((err as Error).message ?? '');
    expect((err as { code?: string }).code).toBe('agent.provider_timeout');
    expect((err as { status?: number }).status).toBe(504);
    expect(msg).not.toContain('PROMPT-MARKER-xyz');
    expect(msg).not.toContain('sk-secret-BBB');
    expect(msg).not.toContain('body-hostile');
  });

  it('JSON parse error maps to fixed invalid output without echoing the hostile token', async () => {
    const hostile = 'HOSTILE-TOKEN-zzz <not-json {{{';
    const badFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token '${hostile}' at position 0`);
        },
      }) as unknown as Response,
    );
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      badFetch as unknown as typeof fetch,
      { timeoutMs: 1_000 },
    ).catch((e: unknown) => e as Error & { code?: string });
    const msg = String((err as Error).message ?? '');
    expect((err as { code?: string }).code).toBe('agent.invalid_provider_output');
    expect(msg).not.toContain('HOSTILE-TOKEN-zzz');
  });

  it('non-2xx hostile body is never echoed and keeps a safe status/code', async () => {
    const marker = 'PROMPT-MARKER-xyz system-prompt-secret sk-secret-BBB\r\nINJECTED-CRLF';
    const badFetch = vi.fn(async () => new Response(marker, { status: 500 }));
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      badFetch as unknown as typeof fetch,
      { timeoutMs: 1_000 },
    ).catch((e: unknown) => e as Error & { code?: string; status?: number });
    const msg = String((err as Error).message ?? '');
    expect(msg).not.toContain('PROMPT-MARKER-xyz');
    expect(msg).not.toContain('sk-secret-BBB');
    expect((err as { code?: string }).code).toBe('agent.provider_error');
    expect((err as { status?: number }).status).toBe(500);
  });

  it('late/discarded response best-effort cancels the body without blocking the timeout', async () => {
    let now = 4_000;
    const cancel = vi.fn(async () => {});
    const lateFetch = vi.fn(async () => {
      now = 4_000 + 5_000;
      return {
        ok: true,
        status: 200,
        body: { cancel },
        json: async () => ({
          id: 'late',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      lateFetch as unknown as typeof fetch,
      { timeoutMs: 50, now: () => now },
    ).catch((e: unknown) => e as Error & { code?: string });
    expect((err as { code?: string }).code).toBe('agent.provider_timeout');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('locked-body cancel failure never blocks the timeout', async () => {
    let now = 7_000;
    const cancel = vi.fn(() => {
      throw new TypeError('body is locked');
    });
    const lateFetch = vi.fn(async () => {
      now = 7_000 + 5_000;
      return {
        ok: true,
        status: 200,
        body: { cancel },
        json: async () => ({
          id: 'late',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });
    const err = await executeBrokerCompletion(
      baseOptions,
      basePayload,
      lateFetch as unknown as typeof fetch,
      { timeoutMs: 50, now: () => now },
    ).catch((e: unknown) => e as Error & { code?: string });
    expect((err as { code?: string }).code).toBe('agent.provider_timeout');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('FIX-AGENT-BROKER-LATE-HEADERS-CANCEL (TDD)', () => {
  const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';
  const baseOptions = { brokerOrigin: 'https://broker.example.test', signingKey: SIGNING_KEY };
  const basePayload = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Olá' }],
    requestId: 'req-1',
    intentionId: 'intent-1',
    workspaceId: 'ws-1',
    actorId: 'user-1',
  };

  it('late headers resolving after timeout get body canceled exactly once; timeout stays settled', async () => {
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
    await expect(pending).rejects.toMatchObject({
      code: 'agent.provider_timeout',
      status: 504,
    });
    resolveFetch({
      ok: true,
      status: 200,
      body: { cancel },
      json: async () => ({
        id: 'late',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);
    await new Promise((r) => setTimeout(r, 10));
    expect(cancel).toHaveBeenCalledTimes(1);
    // Timeout stays settled: no late success resurrects the call.
    await expect(pending).rejects.toMatchObject({ code: 'agent.provider_timeout' });
  });

  it('fast success never cancels the body and exposes no raw body', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const okFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        body: { cancel },
        json: async () => ({
          id: 'ok',
          model: 'gpt-4o',
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
