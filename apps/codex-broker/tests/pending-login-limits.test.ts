import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthCacheManager } from '../src/auth-status.js';
import {
  BrowserLoginManager,
  LOGIN_TTL_MS,
  MAX_PENDING_LOGINS,
  type CodeExchangeResult,
} from '../src/browser-login.js';
import {
  computeBodySha256,
  createInMemoryNonceReplayStore,
  signEnvelope,
  verifyEnvelope,
  type HmacEnvelope,
  type NonceReplayStore,
} from '../src/replay-store.js';
import { buildCodexBrokerApp } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

/**
 * BRK-02 (T12e): pending browser logins are bounded (cap + TTL), single-use,
 * and driven by an injectable clock. The replay store purge uses the same
 * `now` that guards the skew check.
 */
describe('Browser login pending limits (BRK-02)', () => {
  let authPath: string;
  let authManager: AuthCacheManager;
  let now: number;
  const clock = (): number => now;
  const exchange = async (code: string): Promise<CodeExchangeResult> => ({
    accessToken: `exchanged-token-for-${code.slice(0, 8)}`,
    expiresIn: 3600,
    email: 'subscriber@example.com',
  });

  beforeEach(() => {
    now = 1_700_000_000_000;
    authPath = join(tmpdir(), `test-brk02-${now}-${Math.random().toString(36).slice(2)}.json`);
    authManager = new AuthCacheManager(authPath);
  });

  afterEach(() => {
    if (existsSync(authPath)) unlinkSync(authPath);
  });

  it('rejects new logins past the cap without corrupting the existing ones', () => {
    const manager = new BrowserLoginManager(authManager, exchange, clock);
    const first = manager.beginLogin();
    for (let i = 1; i < MAX_PENDING_LOGINS; i += 1) {
      manager.beginLogin();
    }
    expect(manager.pendingCount()).toBe(MAX_PENDING_LOGINS);

    let thrown: { statusCode?: unknown; code?: unknown } | undefined;
    try {
      manager.beginLogin();
    } catch (e) {
      thrown = e as { statusCode?: unknown; code?: unknown };
    }
    expect(thrown?.statusCode).toBe(429);
    expect(thrown?.code).toBe('login_pending_limit_exceeded');
    // Existing entries are untouched: the first login still completes.
    expect(manager.pendingCount()).toBe(MAX_PENDING_LOGINS);
    return expect(manager.completeLogin('oauth-code-1234', first.state)).resolves.toMatchObject({
      email: 'subscriber@example.com',
    });
  });

  it('expired logins are rejected and swept, freeing the cap (injected clock)', async () => {
    const manager = new BrowserLoginManager(authManager, exchange, clock);
    const login = manager.beginLogin();
    now += LOGIN_TTL_MS + 1;

    let thrown: { statusCode?: unknown; code?: unknown } | undefined;
    try {
      await manager.completeLogin('oauth-code-1234', login.state);
    } catch (e) {
      thrown = e as { statusCode?: unknown; code?: unknown };
    }
    expect(thrown?.statusCode).toBe(410);
    expect(thrown?.code).toBe('login_expired');

    // The expired entry was consumed; a fresh login fits under the cap.
    const fresh = manager.beginLogin();
    expect(fresh.state).not.toBe(login.state);
    expect(manager.pendingCount()).toBe(1);
  });

  it('a login is single-use: a repeated callback cannot re-execute the exchange', async () => {
    let calls = 0;
    const countingExchange = async (code: string): Promise<CodeExchangeResult> => {
      calls += 1;
      return exchange(code);
    };
    const manager = new BrowserLoginManager(authManager, countingExchange, clock);
    const login = manager.beginLogin();
    await manager.completeLogin('oauth-code-1234', login.state);
    expect(calls).toBe(1);

    let thrown: { statusCode?: unknown; code?: unknown } | undefined;
    try {
      await manager.completeLogin('oauth-code-1234', login.state);
    } catch (e) {
      thrown = e as { statusCode?: unknown; code?: unknown };
    }
    expect(thrown?.statusCode).toBe(400);
    expect(thrown?.code).toBe('login_unknown_state');
    expect(calls).toBe(1);
  });

  it('advancing the injected clock expires pending logins deterministically', () => {
    const manager = new BrowserLoginManager(authManager, exchange, clock);
    manager.beginLogin();
    expect(manager.pendingCount()).toBe(1);
    now += LOGIN_TTL_MS + 1;
    expect(manager.purgeExpired()).toBe(1);
    expect(manager.pendingCount()).toBe(0);
  });

  it('HTTP: /auth/login maps a full pending store to typed 429', async () => {
    const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';
    const CF_ID = 'test-cf-client-id';
    const CF_SECRET = 'test-cf-client-secret';
    const app: FastifyInstance = buildCodexBrokerApp({
      authCachePath: join(tmpdir(), `test-brk02-http-${Date.now()}.json`),
      signingKey: SIGNING_KEY,
      cfAccessClientId: CF_ID,
      cfAccessClientSecret: CF_SECRET,
      codeExchange: exchange,
    });
    try {
      const headers = { 'cf-access-client-id': CF_ID, 'cf-access-client-secret': CF_SECRET };
      for (let i = 0; i < MAX_PENDING_LOGINS; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { ...headers, 'content-type': 'application/json' },
          payload: {},
        });
        expect(res.statusCode).toBe(200);
      }
      const full = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: {},
      });
      expect(full.statusCode).toBe(429);
      expect(full.json()).toMatchObject({ error: 'login_pending_limit_exceeded' });
    } finally {
      await app.close();
    }
  });
});

describe('Replay store clock coherence (BRK-02)', () => {
  const SECRET = 'test-signing-key-at-least-32-chars-long!';

  it('purge uses the injected now, not the wall clock', () => {
    const store = createInMemoryNonceReplayStore();
    expect(store.consume('nonce-a', 1_000, 1_000)).toBe(true);
    // Same nonce inside the 60 s window is a replay — even though the wall
    // clock is far ahead, the injected now must govern the purge.
    expect(store.consume('nonce-a', 2_000, 2_000)).toBe(false);
    // Past the window the entry is swept and the nonce is usable again.
    expect(store.consume('nonce-a', 70_000, 70_000)).toBe(true);
  });

  it('verifyEnvelope forwards its now to the replay store consume', () => {
    const seen: Array<{ nonce: string; timestamp: number; now?: number }> = [];
    const spy: NonceReplayStore = {
      consume: (nonce: string, timestamp: number, now?: number): boolean => {
        seen.push({ nonce, timestamp, now });
        return true;
      },
      clear: (): void => {},
    };
    const body = JSON.stringify({ hello: 'world' });
    const envelope: HmacEnvelope = {
      kid: 'key-1',
      aud: 'pi-codex-broker',
      timestamp: 5_000,
      nonce: 'spy-nonce-1',
      requestId: 'req-spy-1',
      bodySha256: 'x'.repeat(64),
    };
    // Fix the body hash so the envelope validates up to the replay check.
    envelope.bodySha256 = computeBodySha256(body);
    const signature = signEnvelope(envelope, SECRET);
    const result = verifyEnvelope(envelope, signature, SECRET, body, spy, 5_000);
    expect(result).toEqual({ valid: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ nonce: 'spy-nonce-1', timestamp: 5_000, now: 5_000 });
  });
});
