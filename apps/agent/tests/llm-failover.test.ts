import { describe, expect, it, vi } from 'vitest';
import {
  executeWithFallback,
  failoverReasonOf,
  isRetryableLlmError,
  logFailoverEvent,
} from '../src/llm/failover.js';
import { isCodexProviderId } from '../src/finance-chat-agent.js';

describe('LLM failover (refactor item 5)', () => {
  it('uses the primary result when it succeeds (no fallback)', async () => {
    const fallback = vi.fn();
    const outcome = await executeWithFallback(async () => 'primary-ok', fallback);
    expect(outcome).toMatchObject({ result: 'primary-ok', usedFallback: false, failoverReason: null });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('ativo-falha -> fallback-succeed: retries the fallback in the same request', async () => {
    const primaryErr = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const fallback = vi.fn(async () => 'fallback-ok');
    const outcome = await executeWithFallback(
      async () => {
        throw primaryErr;
      },
      fallback,
    );
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ result: 'fallback-ok', usedFallback: true, failoverReason: 'http_429' });
  });

  it('ambos-falham: propagates the fallback error when both legs fail', async () => {
    const primaryErr = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const fallbackErr = Object.assign(new Error('Gateway Timeout'), { status: 504 });
    await expect(
      executeWithFallback(
        async () => {
          throw primaryErr;
        },
        async () => {
          throw fallbackErr;
        },
      ),
    ).rejects.toBe(fallbackErr);
  });

  it('does not retry non-retryable errors (400 validation fails closed)', async () => {
    const fallback = vi.fn();
    const primaryErr = Object.assign(new Error('Bad Request'), { status: 400 });
    await expect(
      executeWithFallback(
        async () => {
          throw primaryErr;
        },
        fallback,
      ),
    ).rejects.toBe(primaryErr);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('classifies timeout, 429/5xx as retryable and 401/403 as never-fallback (FIX-189)', () => {
    expect(isRetryableLlmError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { status: 500 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { status: 403 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { name: 'AbortError', status: 403 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { code: 'agent.provider_auth' }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
    expect(failoverReasonOf(Object.assign(new Error('x'), { status: 429 }))).toBe('http_429');
    expect(failoverReasonOf(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
  });

  it('logs the failover metric without secrets', () => {
    const log = vi.fn();
    const event = logFailoverEvent(
      {
        intentionId: 'intent-1',
        primaryProviderId: 'openai',
        primaryModelId: 'gpt-4o',
        fallbackProviderId: 'deepseek',
        fallbackModelId: 'deepseek-chat',
      },
      { usedFallback: true, failoverReason: 'http_429' },
      log,
    );
    expect(event).toMatchObject({ usedFallback: true, failoverReason: 'http_429' });
    const line = String(log.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('llm.failover');
    // W2: raw caller id never appears — opaque per-event correlation only.
    expect(line).not.toContain('intent-1');
    expect(line).toMatch(/corr=corr-[0-9a-f]{16}/);
    expect(event.intentionId).toMatch(/^corr-[0-9a-f]{16}$/);
    expect(event.intentionId).not.toBe('intent-1');
    expect(line).not.toContain('sk-');
    expect(JSON.stringify(event)).not.toContain('sk-');
  });

  it('W2: hostile intention on primary success never leaks raw id/control', () => {
    const hostile = 'account-secret-abc\nforged-second-line';
    const log = vi.fn();
    const first = logFailoverEvent(
      { intentionId: hostile, primaryProviderId: 'opencode-zen', primaryModelId: 'zen-primary' },
      { usedFallback: false, failoverReason: null },
      log,
    );
    const second = logFailoverEvent(
      { intentionId: hostile, primaryProviderId: 'opencode-zen', primaryModelId: 'zen-primary' },
      { usedFallback: false, failoverReason: null },
      log,
    );
    const lines = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(lines).not.toContain('account-secret-abc');
    expect(lines).not.toContain('forged-second-line');
    expect(lines).not.toContain('account-secret-abc\n');
    expect(JSON.stringify(first)).not.toContain('account-secret-abc');
    expect(JSON.stringify(second)).not.toContain('account-secret-abc');
    // Independent random per event, not deterministic.
    expect(first.intentionId).toMatch(/^corr-[0-9a-f]{16}$/);
    expect(second.intentionId).toMatch(/^corr-[0-9a-f]{16}$/);
    expect(first.intentionId).not.toEqual(second.intentionId);
  });

  it('FIX-AGENT-FAILOVER-LOGGER-BEST-EFFORT: throwing logger still returns safe event', () => {
    const throwingLog = () => {
      throw new Error('logger boom');
    };
    let event!: ReturnType<typeof logFailoverEvent>;
    expect(() => {
      event = logFailoverEvent(
        { intentionId: 'intent-1', primaryProviderId: 'openai', primaryModelId: 'gpt-4o' },
        { usedFallback: true, failoverReason: 'http_429' },
        throwingLog as unknown as typeof console.info,
      );
    }).not.toThrow();
    expect(event).toMatchObject({ usedFallback: true, failoverReason: 'http_429' });
    expect(event.intentionId).toMatch(/^corr-[0-9a-f]{16}$/);
  });

  it('routes codex provider ids to the private broker leg', () => {
    expect(isCodexProviderId('openai-codex-subscription')).toBe(true);
    expect(isCodexProviderId('codex')).toBe(true);
    expect(isCodexProviderId('openai')).toBe(false);
    expect(isCodexProviderId('deepseek')).toBe(false);
  });
});
