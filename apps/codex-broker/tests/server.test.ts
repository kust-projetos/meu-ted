import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildCodexBrokerApp } from '../src/server.js';
import { computeBodySha256, signEnvelope, type HmacEnvelope } from '../src/replay-store.js';
import type { FastifyInstance } from 'fastify';

describe('Codex Broker Server (Task 5A)', () => {
  let app: FastifyInstance;
  let testAuthPath: string;
  const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';
  const CF_ID = 'test-cf-client-id';
  const CF_SECRET = 'test-cf-client-secret';

  beforeEach(() => {
    testAuthPath = join(tmpdir(), `test-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    // AuthCacheManager enforces 0600 on POSIX (production cache is owner-only),
    // so the fixture must be written with the same mode or every authed path
    // 401s/503s on Linux CI while passing on Windows (mode check bypassed).
    writeFileSync(
      testAuthPath,
      JSON.stringify({
        accessToken: 'valid-access-token',
        expiresAt: Date.now() + 3600_000,
        email: 'subscriber@example.com',
      }),
      { encoding: 'utf8', mode: 0o600 },
    );

    app = buildCodexBrokerApp({
      authCachePath: testAuthPath,
      signingKey: SIGNING_KEY,
      cfAccessClientId: CF_ID,
      cfAccessClientSecret: CF_SECRET,
    });
  });

  afterEach(async () => {
    await app.close();
    if (existsSync(testAuthPath)) {
      unlinkSync(testAuthPath);
    }
  });

  it('GET /health returns server and auth status without secret leaks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'ready',
      auth: {
        authenticated: true,
        reauthRequired: false,
      },
    });
    expect(body.models).toContain('gpt-4o');
    // Ensure no token in response
    expect(JSON.stringify(body)).not.toContain('valid-access-token');
  });

  it('POST /v1/chat/completions validates Cloudflare Access headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'cf-access-client-id': 'wrong-id',
        'cf-access-client-secret': 'wrong-secret',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'invalid_cloudflare_access_credentials' });
  });

  it('POST /v1/chat/completions validates HMAC envelope and rejects tampered body', async () => {
    const payload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Olá TED' }],
      requestId: 'req-1',
      intentionId: 'intent-1',
      workspaceId: 'ws-1',
      actorId: 'user-1',
    };
    const rawBody = JSON.stringify(payload);

    const envelope: HmacEnvelope = {
      kid: 'key-1',
      aud: 'pi-codex-broker',
      timestamp: Date.now(),
      nonce: randomUUID(),
      requestId: 'req-1',
      bodySha256: computeBodySha256(rawBody),
    };
    const signature = signEnvelope(envelope, SIGNING_KEY);

    // 1. Valid request reaches the (unwired) runtime and fails closed typed.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'cf-access-client-id': CF_ID,
        'cf-access-client-secret': CF_SECRET,
        'x-codex-envelope': JSON.stringify(envelope),
        'x-codex-signature': signature,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'codex_runtime_not_configured' });

    // 2. Tampered body is rejected
    const tamperedPayload = { ...payload, model: 'o1' };
    const resTampered = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'cf-access-client-id': CF_ID,
        'cf-access-client-secret': CF_SECRET,
        'x-codex-envelope': JSON.stringify(envelope),
        'x-codex-signature': signature,
        'content-type': 'application/json',
      },
      payload: tamperedPayload,
    });

    expect(resTampered.statusCode).toBe(401);
    expect(resTampered.json().reason).toBe('body_hash_mismatch');
  });

  it('POST /v1/chat/completions rejects replayed nonce', async () => {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Teste Replay' }],
      requestId: 'req-replay-1',
      intentionId: 'intent-replay-1',
      workspaceId: 'ws-1',
      actorId: 'user-1',
    };
    const rawBody = JSON.stringify(payload);

    const envelope: HmacEnvelope = {
      kid: 'key-1',
      aud: 'pi-codex-broker',
      timestamp: Date.now(),
      nonce: 'fixed-nonce-replay-12345',
      requestId: 'req-replay-1',
      bodySha256: computeBodySha256(rawBody),
    };
    const signature = signEnvelope(envelope, SIGNING_KEY);

    const headers = {
      'cf-access-client-id': CF_ID,
      'cf-access-client-secret': CF_SECRET,
      'x-codex-envelope': JSON.stringify(envelope),
      'x-codex-signature': signature,
      'content-type': 'application/json',
    };

    // First attempt -> reaches the unwired runtime (typed 503), consuming the nonce
    const res1 = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload });
    expect(res1.statusCode).toBe(503);
    expect(res1.json()).toMatchObject({ error: 'codex_runtime_not_configured' });

    // Second attempt with exact same nonce -> 401 nonce_replayed
    const res2 = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload });
    expect(res2.statusCode).toBe(401);
    expect(res2.json().reason).toBe('nonce_replayed');
  });
});
