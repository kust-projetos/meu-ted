import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';
import { AuthCacheManager } from './auth-status.js';
import { BrowserLoginManager, LoginBeginSchema, LoginCallbackSchema, type CodeExchangeResult } from './browser-login.js';
import { CodexRuntimeAdapter, ChatCompletionRequestSchema, ALLOWLISTED_MODELS } from './runtime-adapter.js';
import { assertBrokerConfig, assertReplayTopology, resolveBrokerConfig } from './broker-config.js';
import {
  createInMemoryNonceReplayStore,
  verifyEnvelope,
  type HmacEnvelope,
  type NonceReplayStore,
} from './replay-store.js';

export type ServerOptions = {
  authCachePath: string;
  signingKey: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  replayStore?: NonceReplayStore;
  adapter?: CodexRuntimeAdapter;
  /** ChatGPT OAuth code exchange (injected; default rejects — see browser-login.ts). */
  codeExchange?: (code: string) => Promise<CodeExchangeResult>;
  /** Injectable wall clock for pending-login expiry (BRK-02); defaults to Date.now. */
  now?: () => number;
  /**
   * Explicit escape hatch (SPEC §15.2, env BROKER_TRUST_PRIVATE_NETWORK=1):
   * allow requests without Cloudflare Access credentials. Never implicit —
   * in production without this flag AND without creds, every protected
   * route is denied. Defaults to false (dev callers pass creds or omit
   * them in non-production, where absence still means "local dev").
   */
  trustPrivateNetwork?: boolean;
  /** Fail-closed Cloudflare Access behavior in production (env-derived). */
  isProduction?: boolean;
};

export const buildCodexBrokerApp = (opts: ServerOptions): FastifyInstance => {
  const app = Fastify({ logger: false });
  const authManager = new AuthCacheManager(opts.authCachePath);
  const adapter = opts.adapter ?? new CodexRuntimeAdapter();
  const replayStore = opts.replayStore ?? createInMemoryNonceReplayStore();
  const loginManager = new BrowserLoginManager(
    authManager,
    opts.codeExchange,
    opts.now,
  );

  const verifyCloudflareAccess = (req: FastifyRequest): boolean => {
    if (opts.cfAccessClientId && opts.cfAccessClientSecret) {
      const clientId = req.headers['cf-access-client-id'];
      const clientSecret = req.headers['cf-access-client-secret'];

      const providedId = Array.isArray(clientId) ? clientId[0] : clientId;
      const providedSecret = Array.isArray(clientSecret) ? clientSecret[0] : clientSecret;

      return providedId === opts.cfAccessClientId && providedSecret === opts.cfAccessClientSecret;
    }

    // No credentials configured: fail closed in production unless the
    // operator explicitly trusts the private network (SPEC §15.2).
    // Non-production keeps the historical local-dev behavior.
    if (opts.isProduction && !opts.trustPrivateNetwork) {
      return false;
    }
    return true;
  };

  const verifyHmacRequest = (req: FastifyRequest, rawBodyString: string): { valid: boolean; reason?: string } => {
    const rawEnvelopeHeader = req.headers['x-codex-envelope'];
    const signatureHeader = req.headers['x-codex-signature'];

    const envelopeJson = Array.isArray(rawEnvelopeHeader) ? rawEnvelopeHeader[0] : rawEnvelopeHeader;
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    if (!envelopeJson || !signature) {
      return { valid: false, reason: 'missing_hmac_headers' };
    }

    let envelope: HmacEnvelope;
    try {
      envelope = JSON.parse(envelopeJson) as HmacEnvelope;
    } catch {
      return { valid: false, reason: 'invalid_envelope_json' };
    }

    return verifyEnvelope(envelope, signature, opts.signingKey, rawBodyString, replayStore);
  };

  // Health check endpoint (public / monitoring)
  app.get('/health', async (_req, reply) => {
    const authStatus = authManager.getAuthStatus();
    return reply.code(200).send({
      status: 'ready',
      auth: {
        authenticated: authStatus.authenticated,
        reauthRequired: authStatus.reauthRequired,
        modeVerified: authStatus.modeVerified,
      },
      models: ALLOWLISTED_MODELS,
    });
  });

  // Models catalog
  app.get('/v1/models', async (req, reply) => {
    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }

    return reply.code(200).send({
      object: 'list',
      data: ALLOWLISTED_MODELS.map((id) => ({
        id,
        object: 'model',
        created: 1700000000,
        owned_by: 'openai',
      })),
    });
  });

  // Chat completions endpoint
  app.post('/v1/chat/completions', async (req, reply) => {
    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }

    const rawBody = JSON.stringify(req.body ?? {});
    const hmacCheck = verifyHmacRequest(req, rawBody);
    if (!hmacCheck.valid) {
      return reply.code(401).send({
        error: 'hmac_verification_failed',
        reason: hmacCheck.reason,
      });
    }

    const parsed = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request_schema',
        issues: parsed.error.issues,
      });
    }

    const authStatus = authManager.getAuthStatus();
    if (!authStatus.authenticated || authStatus.reauthRequired) {
      return reply.code(401).send({
        error: 'codex_reauth_required',
        message: 'Codex subscription authentication required or expired',
      });
    }

    try {
      const result = await adapter.executeCompletion(parsed.data, authStatus);
      return reply.code(200).send(result);
    } catch (e) {
      const err = e as { code?: unknown; statusCode?: unknown; message?: unknown };
      // BRK-01: no runtime is wired — fail closed with the typed error,
      // preserving the endpoint shape ({ error, message }).
      if (err?.code === 'codex_runtime_not_configured' || err?.message === 'codex_runtime_not_configured') {
        return reply.code(503).send({
          error: 'codex_runtime_not_configured',
          message: 'Codex runtime not configured',
        });
      }
      const message = (e as Error).message;
      return reply.code(500).send({
        error: 'codex_execution_failed',
        message,
      });
    }
  });

  // Cancel execution
  app.post('/v1/cancel', async (req, reply) => {    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }

    const rawBody = JSON.stringify(req.body ?? {});
    const hmacCheck = verifyHmacRequest(req, rawBody);
    if (!hmacCheck.valid) {
      return reply.code(401).send({
        error: 'hmac_verification_failed',
        reason: hmacCheck.reason,
      });
    }

    const body = (req.body ?? {}) as { requestId?: string };
    if (!body.requestId) {
      return reply.code(400).send({ error: 'requestId_required' });
    }

    const cancelled = adapter.cancelExecution(body.requestId);
    return reply.code(200).send({ ok: true, cancelled });
  });

  // ── Browser login (MVP, refactor item 6) ──────────────────────────
  // Operator flow: POST /auth/login → open verificationUri in a browser and
  // approve the ChatGPT Coding-plan authorization → POST /auth/callback with
  // the returned code. Session persists via atomic 0600 write; tokens never
  // appear in logs or responses.

  app.post('/auth/login', async (req, reply) => {
    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }
    const parsed = LoginBeginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request_schema', issues: parsed.error.issues });
    }
    try {
      const login = loginManager.beginLogin(parsed.data.callbackUrl);
      return reply.code(200).send({
        verificationUri: login.verificationUri,
        userCode: login.userCode,
        state: login.state,
        expiresAt: login.expiresAt,
      });
    } catch (e) {
      const err = e as { statusCode?: unknown; code?: unknown };
      if (typeof err?.statusCode === 'number') {
        return reply.code(err.statusCode).send({ error: err.code ?? 'login_failed' });
      }
      return reply.code(500).send({ error: 'login_failed' });
    }
  });

  app.post('/auth/callback', async (req, reply) => {
    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }
    const parsed = LoginCallbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request_schema', issues: parsed.error.issues });
    }
    try {
      const result = await loginManager.completeLogin(
        parsed.data.code,
        ...(parsed.data.state ? [parsed.data.state] : [] as const),
      );
      return reply.code(200).send({ ok: true, ...result });
    } catch (e) {
      const err = e as { statusCode?: number; code?: string; message?: string };
      if (typeof err?.statusCode === 'number') {
        return reply.code(err.statusCode).send({ error: err.code ?? 'login_failed' });
      }
      return reply.code(502).send({ error: 'login_exchange_failed' });
    }
  });

  app.get('/auth/status', async (req, reply) => {
    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }
    const status = authManager.getAuthStatus();
    // AuthCacheManager already strips tokens — status carries metadata only.
    return reply.code(200).send({ auth: status });
  });

  app.post('/auth/logout', async (req, reply) => {
    if (!verifyCloudflareAccess(req)) {
      return reply.code(403).send({ error: 'invalid_cloudflare_access_credentials' });
    }
    const rawBody = JSON.stringify(req.body ?? {});
    const hmacCheck = verifyHmacRequest(req, rawBody);
    if (!hmacCheck.valid) {
      return reply.code(401).send({ error: 'hmac_verification_failed', reason: hmacCheck.reason });
    }
    loginManager.revokeLocalSession();
    return reply.code(200).send({ ok: true, auth: authManager.getAuthStatus() });
  });

  return app;
};

/** Start the broker only when this module is the container entrypoint. */
const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const cfg = resolveBrokerConfig(process.env);
  assertBrokerConfig(cfg);
  assertReplayTopology({
    instanceCount: cfg.instanceCount,
    storeKind: 'memory',
    sharedReplayConfigured: cfg.sharedReplayConfigured,
  });
  if (cfg.ephemeralSigningKey) {
    console.warn('broker: CODEX_SIGNING_KEY unset — using an ephemeral development key (never for production)');
  }
  const app = buildCodexBrokerApp({
    authCachePath: process.env.CODEX_AUTH_CACHE_PATH ?? '/var/lib/codex-auth/auth.json',
    signingKey: cfg.signingKey,
    cfAccessClientId: cfg.cfAccessClientId,
    cfAccessClientSecret: cfg.cfAccessClientSecret,
    trustPrivateNetwork: cfg.trustPrivateNetwork,
    isProduction: cfg.isProduction,
  });
  const port = Number(process.env.PORT ?? 3005);
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen({ port, host }).catch((error: unknown) => {
    app.log.error(error);
    process.exitCode = 1;
  });
}
