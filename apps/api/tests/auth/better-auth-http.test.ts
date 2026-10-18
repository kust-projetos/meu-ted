import Fastify from 'fastify';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { registerBetterAuthRoutes } from '../../src/auth/better-auth-http.js';

const makeAuth = (baseURL = 'http://localhost:3001', sessionExpiresIn?: number) => createBetterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  disableSignUp: false,
  transaction: false,
  secret: 'test-secret-that-is-at-least-32-characters',
  baseURL,
  trustedOrigins: ['http://localhost:3000'],
  ...(sessionExpiresIn === undefined ? {} : { sessionExpiresIn }),
});

describe('Better Auth HTTP boundary', () => {
  it('serves sign-up and session lookup through Fastify with the auth cookie', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const signUp = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000' },
        payload: { email: 'owner@example.com', password: 'test-password-123', name: 'Owner' },
      });
      const cookie = signUp.headers['set-cookie'];
      const cookieValue = Array.isArray(cookie) ? cookie.join('; ') : String(cookie ?? '');
      const session = await app.inject({
        method: 'GET',
        url: '/auth/get-session',
        headers: { cookie: cookieValue },
      });

      expect(signUp.statusCode).toBe(200);
      expect(cookieValue).toMatch(/HttpOnly/i);
      expect(cookieValue).toMatch(/SameSite=Lax/i);
      expect(session.statusCode).toBe(200);
      expect(session.json().user.email).toBe('owner@example.com');
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('revokes the session through the HTTP logout endpoint', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const signUp = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000' },
        payload: { email: 'logout@example.com', password: 'test-password-123', name: 'Logout' },
      });
      const cookie = signUp.headers['set-cookie'];
      const cookieValue = Array.isArray(cookie) ? cookie.join('; ') : String(cookie ?? '');
      const signOut = await app.inject({
        method: 'POST',
        url: '/auth/sign-out',
        headers: { origin: 'http://localhost:3000', cookie: cookieValue },
      });
      const session = await app.inject({ method: 'GET', url: '/auth/get-session', headers: { cookie: cookieValue } });

      const clearedCookie = signOut.headers['set-cookie'];
      const clearedCookieValue = Array.isArray(clearedCookie) ? clearedCookie.join('; ') : String(clearedCookie ?? '');
      expect(signOut.statusCode).toBe(200);
      expect(clearedCookieValue).toMatch(/better-auth\.session_token=/i);
      expect(clearedCookieValue).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      expect(session.statusCode).toBe(200);
      expect(session.json()).toBeNull();
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('rejects invalid and expired session cookies', async () => {
    const auth = makeAuth('http://localhost:3001', 1);
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const invalid = await app.inject({ method: 'GET', url: '/auth/get-session', headers: { cookie: 'better-auth.session_token=invalid-token' } });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json()).toBeNull();

      const signUp = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000' },
        payload: { email: 'expired@example.com', password: 'test-password-123', name: 'Expired' },
      });
      const cookie = signUp.headers['set-cookie'];
      const cookieValue = Array.isArray(cookie) ? cookie.join('; ') : String(cookie ?? '');
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const expired = await app.inject({ method: 'GET', url: '/auth/get-session', headers: { cookie: cookieValue } });
      expect(expired.statusCode).toBe(200);
      expect(expired.json()).toBeNull();
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('sets Secure cookies when the configured Better Auth URL is HTTPS', async () => {
    const auth = makeAuth('https://api.example.com');
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000' },
        payload: { email: 'secure@example.com', password: 'test-password-123', name: 'Secure' },
      });
      const cookie = response.headers['set-cookie'];
      const cookieValue = Array.isArray(cookie) ? cookie.join('; ') : String(cookie ?? '');

      expect(response.statusCode).toBe(200);
      expect(cookieValue).toMatch(/Secure/i);
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('rejects a state-changing request from an untrusted origin', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'https://evil.example' },
        payload: { email: 'attacker@example.com', password: 'test-password-123', name: 'Attacker' },
      });

      expect(response.statusCode).toBe(403);

      const trustedRetry = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000' },
        payload: { email: 'attacker@example.com', password: 'test-password-123', name: 'Attacker' },
      });
      expect(trustedRetry.statusCode).toBe(200);
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('answers preflight only for trusted origins, never reflecting an arbitrary origin', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const evil = await app.inject({
        method: 'OPTIONS',
        url: '/auth/sign-up/email',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(evil.statusCode).toBe(204);
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      expect(evil.headers['access-control-allow-credentials']).toBeUndefined();

      const missing = await app.inject({
        method: 'OPTIONS',
        url: '/auth/sign-up/email',
        headers: { 'access-control-request-method': 'POST' },
      });
      expect(missing.statusCode).toBe(204);
      expect(missing.headers['access-control-allow-origin']).toBeUndefined();

      const trusted = await app.inject({
        method: 'OPTIONS',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
      });
      expect(trusted.statusCode).toBe(204);
      expect(trusted.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(trusted.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('rejects a mutation without Origin when Fetch Metadata says cross-site', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { 'sec-fetch-site': 'cross-site' },
        payload: { email: 'attacker@example.com', password: 'test-password-123', name: 'Attacker' },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('keeps allowing non-browser mutations without Origin and without Fetch Metadata', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        payload: { email: 'legit@example.com', password: 'test-password-123', name: 'Legit' },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      await auth.close();
    }
  });

  it('fails closed when the trusted-origin allowlist is unavailable', async () => {
    const auth = makeAuth();
    Object.defineProperty(auth.options, 'trustedOrigins', { value: undefined, configurable: true });
    const app = Fastify({ logger: false });
    registerBetterAuthRoutes(app, auth);

    try {
      const mutation = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000' },
        payload: { email: 'attacker@example.com', password: 'test-password-123', name: 'Attacker' },
      });
      expect(mutation.statusCode).toBe(403);

      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/auth/sign-up/email',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
      await auth.close();
    }
  });
});
