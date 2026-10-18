import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildCodexBrokerApp } from '../src/server.js';
import { CodexRuntimeAdapter } from '../src/runtime-adapter.js';
import { computeBodySha256, signEnvelope, type HmacEnvelope } from '../src/replay-store.js';
import type { FastifyInstance } from 'fastify';

/**
 * BRK-01 (T12e): the broker has no real Codex runtime wired. The stub must
 * fail closed with the typed error `codex_runtime_not_configured` — never a
 * fabricated completion.
 */
describe('Codex broker runtime fail-closed (BRK-01)', () => {
  const SIGNING_KEY = 'test-signing-key-at-least-32-chars-long!';
  const CF_ID = 'test-cf-client-id';
  const CF_SECRET = 'test-cf-client-secret';
  const cfHeaders = { 'cf-access-client-id': CF_ID, 'cf-access-client-secret': CF_SECRET };

  const authedRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Ola TED' }],
    requestId: 'req-1',
    intentionId: 'intent-1',
    workspaceId: 'ws-1',
    actorId: 'user-1',
  };

  it('adapter rejects with typed codex_runtime_not_configured, never a completion', async () => {
    const adapter = new CodexRuntimeAdapter();
    let resolved = false;
    try {
      await adapter.executeCompletion(
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
          requestId: 'req-typed-1',
          intentionId: 'intent-typed-1',
          workspaceId: 'ws-1',
          actorId: 'u-1',
        },
        { authenticated: true, reauthRequired: false },
      );
      resolved = true;
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      expect(err.code ?? err.message).toBe('codex_runtime_not_configured');
    }
    expect(resolved).toBe(false);
  });

  describe('HTTP contract', () => {
    let app: FastifyInstance;
    let testAuthPath: string;

    beforeEach(() => {
      testAuthPath = join(tmpdir(), `test-brk01-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(
        testAuthPath,
        JSON.stringify({ accessToken: 'valid-access-token', expiresAt: Date.now() + 3600_000 }),
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
      if (existsSync(testAuthPath)) unlinkSync(testAuthPath);
    });

    it('POST /v1/chat/completions returns typed 503, never a fabricated completion', async () => {
      const rawBody = JSON.stringify(authedRequest);
      const envelope: HmacEnvelope = {
        kid: 'key-1',
        aud: 'pi-codex-broker',
        timestamp: Date.now(),
        nonce: randomUUID(),
        requestId: 'req-1',
        bodySha256: computeBodySha256(rawBody),
      };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          ...cfHeaders,
          'x-codex-envelope': JSON.stringify(envelope),
          'x-codex-signature': signEnvelope(envelope, SIGNING_KEY),
          'content-type': 'application/json',
        },
        payload: authedRequest,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'codex_runtime_not_configured' });
      expect(JSON.stringify(res.json())).not.toContain('Processado com seguranca');
    });
  });
});
