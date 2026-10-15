import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPiApiJson } from '../src/tools/api-client.js';
import { detectDuplicateViaApi } from '../src/tools/duplicate-detector.js';
import { executeWithFallback, isRetryableLlmError } from '../src/llm/failover.js';
import { executeLlmAttempts } from '../src/llm/attempts.js';

const dupInput = { kind: 'expense' as const, description: 'Lunch', amountCents: 1000, date: '2026-10-02' };
const dupOpts = { apiOrigin: 'https://api.test', workspaceId: 'w', delegatedToken: 'token' };

afterEach(() => vi.unstubAllGlobals());

describe('FIX-186: api-client timeout/cancelamento', () => {
  it('aborta request pendente dentro do budget (timeout explícito)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    await expect(requestPiApiJson('GET', '/health', { timeoutMs: 30 })).rejects.toMatchObject({ name: 'TimeoutError' });
  }, 5000);

  it('propaga cancelamento do chamador (signal externo)', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const pending = requestPiApiJson('GET', '/health', { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }, 5000);

  it('preserva 401/403 com status (erro apropriado, sem máscara)', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ code: 'auth.invalid', message: 'denied' }) }));
      const err = await requestPiApiJson('GET', '/x').catch((e) => e) as { statusCode?: number; code?: string };
      expect(err.statusCode).toBe(status);
    }
  });
});

describe('FIX-186: duplicate-detector fail-closed + timeout', () => {
  it('modo não-strict falha fechado em erro HTTP (nunca prova inexistência)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const res = await detectDuplicateViaApi(dupInput, dupOpts);
    expect(res.duplicate_detected).toBe(true);
  });

  it('modo não-strict falha fechado em erro de transporte', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const res = await detectDuplicateViaApi(dupInput, dupOpts);
    expect(res.duplicate_detected).toBe(true);
  });

  it('modo não-strict respeita timeout explícito (falha fechado)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const res = await detectDuplicateViaApi(dupInput, { ...dupOpts, timeoutMs: 30 });
    expect(res.duplicate_detected).toBe(true);
  }, 5000);

  it('modo não-strict estoura budget com corpo paralisado pós-headers (falha fechado)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    })));
    const res = await detectDuplicateViaApi(dupInput, { ...dupOpts, timeoutMs: 30 });
    expect(res.duplicate_detected).toBe(true);
  }, 5000);

  it('modo strict estoura budget com corpo paralisado pós-headers (falha fechado)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    })));
    const res = await detectDuplicateViaApi(dupInput, { ...dupOpts, strict: true, timeoutMs: 30 });
    expect(res.duplicate_detected).toBe(true);
  }, 5000);
});

describe('FIX-189: 401/403 nunca elegíveis a fallback', () => {
  it('isRetryableLlmError: 401/403 = false; 429/5xx/timeout = true', () => {
    expect(isRetryableLlmError(Object.assign(new Error('u'), { status: 401 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('f'), { status: 403 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('a'), { code: 'agent.provider_auth' }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('t'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error('r'), { status: 429 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error('s'), { status: 500 }))).toBe(true);
    expect(isRetryableLlmError(Object.assign(new Error('b'), { status: 400 }))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('n'), { status: 404 }))).toBe(false);
  });

  it('executeWithFallback: 401 não dispara fallback (erro apropriado)', async () => {
    const fallback = vi.fn(async () => 'fallback-ok');
    const primaryErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    await expect(executeWithFallback(async () => { throw primaryErr; }, fallback)).rejects.toBe(primaryErr);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('executeLlmAttempts: 403 não dispara fallback', async () => {
    const runLeg = vi.fn(async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); });
    await expect(executeLlmAttempts({
      snapshot: {
        provider_id: 'opencode-zen', model_id: 'opencode-zen:m1',
        fallback_provider_id: 'opencode-go', fallback_model_id: 'opencode-go:m2',
      },
      intentionId: 'i', runLeg,
    })).rejects.toMatchObject({ status: 403 });
    expect(runLeg).toHaveBeenCalledTimes(1);
  });
});
