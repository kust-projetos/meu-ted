import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { createBetterAuth } from './better-auth.js';
import { getBetterAuthSessionContext } from './better-auth.js';
import type { ReconnectTokenStore } from './reconnect-tokens.js';
import type { ReconnectSocketRegistry } from './reconnect-sockets.js';
import type { InviteSignupGuard } from './invite-signup-guard.js';
import { z } from 'zod';

type BetterAuth = ReturnType<typeof createBetterAuth>;

const reconnectInput = z.object({ token: z.string().trim().min(1) });

export const registerBetterAuthRoutes = (
  app: FastifyInstance,
  auth: BetterAuth,
  reconnectTokens?: ReconnectTokenStore,
  reconnectSockets?: ReconnectSocketRegistry,
  inviteSignupGuard?: InviteSignupGuard,
  consumeAccountInvite?: (email: string) => Promise<void>,
): void => {
  app.post('/auth/reconnect', async (request, reply) => {
    if (isUntrustedMutation(request, auth)) return reply.code(403).send({ code: 'auth.invalid_origin', message: 'Invalid origin' });
    if (!reconnectTokens) return reply.code(503).send({ code: 'auth.reconnect_unavailable', message: 'reconnect tokens are unavailable' });
    const parsed = reconnectInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'auth.invalid_reconnect_token', message: 'valid reconnect token required' });
    const sessionId = reconnectTokens.resolve(parsed.data.token);
    if (!sessionId) return reply.code(401).send({ code: 'auth.invalid_reconnect_token', message: 'invalid or expired reconnect token' });
    return reply.send({ sessionId });
  });

  app.post('/auth/reconnect-token', async (request, reply) => {
    if (isUntrustedMutation(request, auth)) return reply.code(403).send({ code: 'auth.invalid_origin', message: 'Invalid origin' });
    const context = await getBetterAuthSessionContext(auth, new Headers(request.headers as Record<string, string>));
    if (!context) return reply.code(401).send({ code: 'auth.missing_session', message: 'authenticated session required' });
    if (!reconnectTokens) return reply.code(503).send({ code: 'auth.reconnect_unavailable', message: 'reconnect tokens are unavailable' });
    const expiresInSeconds = 300;
    return reply.send({ token: reconnectTokens.issue(context.sessionId, expiresInSeconds * 1000, context.userId), expiresInSeconds });
  });

  app.get('/auth/session', async (request, reply) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const session = await auth.api.getSession({ headers });
    if (!session) {
      return reply.code(401).send({ code: 'auth.missing_session', message: 'authenticated session required' });
    }
    return reply.code(200).send({ user: session.user, session: session.session });
  });

  app.all('/auth/*', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      // CORS preflight must be answered with 204 before reaching the
      // better-auth handler (which returns 404 for OPTIONS, breaking the
      // browser preflight flow for /auth/sign-in/email and friends).
      // T10: never reflect an arbitrary Origin — echo only a trusted one,
      // with the same exact-match validation as the mutation gate below
      // (and server/cors.ts). Untrusted/missing Origin still gets 204, but
      // without ACAO/credentials headers.
      if (isTrustedAuthOrigin(request, auth)) {
        reply.header('Access-Control-Allow-Origin', request.headers.origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
      }
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Device-Token, Idempotency-Key, Accept, Authorization, X-Workspace-Id');
      reply.header('Access-Control-Expose-Headers', 'set-auth-token');
      return reply.code(204).send();
    }
    if (isUntrustedMutation(request, auth)) {
      return reply.code(403).send({ code: 'auth.invalid_origin', message: 'Invalid origin' });
    }
    // Invite-restricted signup: only allow creating account when e-mail has a pending invite.
    if (inviteSignupGuard && request.method === 'POST' && request.url.split('?')[0] === '/auth/sign-up/email') {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const email = typeof body.email === 'string' ? body.email : '';
      if (!email) {
        return reply.code(400).send({ code: 'auth.invalid_email', message: 'E-mail é obrigatório.' });
      }
      const hasInvite = await inviteSignupGuard(email);
      if (!hasInvite) {
        return reply.code(403).send({
          code: 'auth.signup_requires_invite',
          message: 'É necessário um convite pendente para criar conta com este e-mail. Peça ao owner do workspace para enviar um convite.',
        });
      }
    }
    const isSignOut = request.method === 'POST' && request.url.split('?')[0] === '/auth/sign-out';
    const session = isSignOut && reconnectTokens
      ? await getBetterAuthSessionContext(auth, new Headers(request.headers as Record<string, string>))
      : undefined;
    const isSignUp = request.method === 'POST' && request.url.split('?')[0] === '/auth/sign-up/email';
    const signUpEmail = isSignUp ? ((request.body as Record<string, unknown>)?.email as string | undefined) : undefined;
    const response = await auth.handler(toWebRequest(request, auth.options.baseURL));
    if (isSignOut && session && reconnectTokens) {
      reconnectTokens.invalidateSession(session.sessionId);
      reconnectSockets?.closeSession(session.sessionId, 'session signed out');
    }
    // Consume account invite after successful signup (account invite is signup-only)
    if (isSignUp && consumeAccountInvite && signUpEmail && response.status >= 200 && response.status < 300) {
      try {
        await consumeAccountInvite(signUpEmail);
      } catch {
        // Best-effort: signup already succeeded, do not fail the response
      }
    }
    return sendWebResponse(reply, response);
  });
};

const isTrustedAuthOrigin = (request: FastifyRequest, auth: BetterAuth): boolean => {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (typeof auth.options.trustedOrigins !== 'object' || !Array.isArray(auth.options.trustedOrigins)) return false;
  return auth.options.trustedOrigins.includes(origin);
};

const isCrossSiteWithoutOrigin = (request: FastifyRequest): boolean => {
  if (request.headers.origin) return false;
  const site = request.headers['sec-fetch-site'];
  const value = Array.isArray(site) ? site[0] : site;
  return (value ?? '').trim().toLowerCase() === 'cross-site';
};

const isUntrustedMutation = (request: FastifyRequest, auth: BetterAuth): boolean => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
  // T10: a mutation with no Origin but cross-site Fetch Metadata is a browser
  // cross-site request hiding its Origin — refuse it. Legit non-browser
  // clients (no Origin, no Fetch Metadata) keep passing.
  if (isCrossSiteWithoutOrigin(request)) return true;
  const origin = request.headers.origin;
  if (!origin) return false;
  // T10: fail closed when the allowlist is unavailable — an Origin that cannot
  // be validated is not trusted.
  return !isTrustedAuthOrigin(request, auth);
};

const toWebRequest = (request: FastifyRequest, baseURL: string): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== undefined;
  return new Request(new URL(request.url, baseURL), {
    method: request.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
};

const sendWebResponse = async (reply: FastifyReply, response: Response) => {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') reply.header(name, value);
  });
  if (setCookies.length > 0) reply.header('set-cookie', setCookies);
  if (response.status === 204) return reply.code(response.status).send();

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') && text !== '' ? JSON.parse(text) : text;
  return reply.code(response.status).send(body);
};
