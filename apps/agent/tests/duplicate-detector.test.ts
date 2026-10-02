import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectDuplicateSuspectedStrict } from '../src/tools/duplicate-detector.js';

const opts = { apiOrigin: 'https://api.test', workspaceId: 'w', delegatedToken: 'token' };
const input = { kind: 'expense' as const, description: 'Lunch', amountCents: 1000, date: '2026-10-02' };

afterEach(() => vi.unstubAllGlobals());

describe('strict duplicate check', () => {
  it('fails closed on transport and HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(detectDuplicateSuspectedStrict(input, opts)).resolves.toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(detectDuplicateSuspectedStrict(input, opts)).resolves.toBe(true);
  });

  it('treats the API 503 duplicate_detection_unavailable response as suspected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ code: 'duplicate_detection_unavailable', message: 'A verificação de duplicidade está indisponível.' }),
    }));
    await expect(detectDuplicateSuspectedStrict(input, opts)).resolves.toBe(true);
  });

  it('passes only a definitive negative and suspects malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ duplicate_detected: false }) }));
    await expect(detectDuplicateSuspectedStrict(input, opts)).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(detectDuplicateSuspectedStrict(input, opts)).resolves.toBe(true);
  });
});
