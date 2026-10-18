import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it, afterEach } from 'vitest';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import {
  createAccountInviteService,
  createInMemoryAccountInviteStore,
} from '../../src/auth/account-invites.js';
import { registerRoutes } from '../../src/routes/index.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryReadModelStoreFromState } from '../../src/read-models/store.js';
import { createInMemoryDeviceTokenStore } from '../../src/auth/device-token.js';
import { createInMemoryIdempotencyStore } from '../../src/writes/idempotency.js';

// API-03 (T12a): the ACTIVE account-invite route must fail CLOSED with a typed
// 503 (`invite.delivery_unavailable`) when delivery is unavailable, instead of
// surfacing a generic 500 from the bootstrap fallback in
// `src/server/index.ts:137-142`.
describe('account invite delivery unavailable (API-03)', () => {
  let app: FastifyInstance | undefined;
  let auth: ReturnType<typeof createBetterAuth> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (auth) await auth.close();
    app = undefined;
    auth = undefined;
  });

  const setupApp = async (opts: {
    deliver: (message: { email: string; token: string }) => Promise<void>;
    insertAccountInvite?: (record: never) => Promise<void>;
  }) => {
    const deliveries: Array<{ email: string; token: string }> = [];
    auth = createBetterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      disableSignUp: true,
      transaction: false,
      secret: 'test-secret-that-is-at-least-32-characters',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3000'],
    });

    await auth.api.createUser({
      body: {
        email: 'admin@example.com',
        password: 'AdminPassword123!',
        name: 'Admin',
      },
    });

    const store = createInMemoryAccountInviteStore();
    const baseInsert = store.insertAccountInvite.bind(store);
    if (opts.insertAccountInvite) {
      const failing = opts.insertAccountInvite;
      store.insertAccountInvite = async (record) => failing(record as never);
    }
    const service = createAccountInviteService({
      store,
      deliver: async (message) => {
        deliveries.push({ email: message.email, token: message.token });
        await opts.deliver({ email: message.email, token: message.token });
      },
    });

    const { state, writes } = createInMemoryStores();
    const readStore = createInMemoryReadModelStoreFromState(state);
    app = Fastify({ logger: false });
    registerRoutes(app, {
      store: readStore,
      writes,
      tokenStore: createInMemoryDeviceTokenStore(),
      idempotency: createInMemoryIdempotencyStore(),
      auth,
      adminEmails: ['admin@example.com'],
      accountInviteService: service,
      disableDeviceRegistration: true,
    });

    const signIn = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      payload: { email: 'admin@example.com', password: 'AdminPassword123!' },
    });
    expect(signIn.statusCode).toBe(200);
    const rawCookie = signIn.headers['set-cookie'];
    const cookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : String(rawCookie ?? '');
    return { app: app!, cookie, deliveries, restoreInsert: baseInsert };
  };

  it('(a) unavailable delivery fails closed with typed 503 invite.delivery_unavailable', async () => {
    // Replicates the pre-fix `src/server/index.ts:137-142` fallback shape
    // (generic Error) — the route must still answer with the typed 503.
    const { app: testApp, cookie } = await setupApp({
      deliver: async () => {
        throw new Error('invite delivery is not configured');
      },
    });

    const res = await testApp.inject({
      method: 'POST',
      url: '/admin/invites/account',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'api03-delivery-unavailable-1',
      },
      payload: { email: 'guest@example.com' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'invite.delivery_unavailable' });
  });

  it('(b1) invalid email is a semantic 400, not an unavailability', async () => {
    const { app: testApp, cookie } = await setupApp({ deliver: async () => {} });

    const res = await testApp.inject({
      method: 'POST',
      url: '/admin/invites/account',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'api03-invalid-email-1',
      },
      payload: { email: 'not-an-email' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('(b2) unknown token verifies as 404 invite.not_found', async () => {
    const { app: testApp } = await setupApp({ deliver: async () => {} });

    const res = await testApp.inject({
      method: 'POST',
      url: '/auth/account-invites/verify',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'b'.repeat(64) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'invite.not_found' });
  });

  it('(b3) past expiry is a semantic 400 invite.expired', async () => {
    const { app: testApp, cookie } = await setupApp({ deliver: async () => {} });

    const res = await testApp.inject({
      method: 'POST',
      url: '/admin/invites/account',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'api03-past-expiry-1',
      },
      payload: { email: 'guest@example.com', expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invite.expired' });
  });

  it('(c) persistence outage fails closed (5xx) with no invite receipt', async () => {
    const { app: testApp, cookie } = await setupApp({
      deliver: async () => {},
      insertAccountInvite: async () => {
        throw new Error('connection refused');
      },
    });

    const res = await testApp.inject({
      method: 'POST',
      url: '/admin/invites/account',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'api03-store-outage-1',
      },
      payload: { email: 'guest@example.com' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json()).not.toHaveProperty('inviteId');
  });

  it('pins the active bootstrap fallback as typed InviteError 503 (not generic Error)', () => {
    const source = readFileSync(new URL('../../src/server/index.ts', import.meta.url), 'utf8');
    // Anchor to the ACTIVE `deliver` fallback wired into the bootstrap
    // (`deliver: inviteDelivery ?? (async () => { ... })`). A global
    // `toContain('invite.delivery_unavailable')` anywhere in the file would
    // stay green under a 503->500 mutation of this block, so every assertion
    // below targets the extracted block text, not the whole file.
    const anchor = 'deliver: inviteDelivery ??';
    const anchorIndex = source.indexOf(anchor);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    const block = source.slice(anchorIndex, anchorIndex + 600);
    expect(block).toContain('async () => {');
    const isTypedFallback = (text: string): boolean =>
      text.includes('InviteError') &&
      text.includes('invite.delivery_unavailable') &&
      text.includes('503') &&
      !text.includes('new Error(');
    // (a)-(d) jointly on the SAME active block.
    expect(block).toContain('InviteError');
    expect(block).toContain('invite.delivery_unavailable');
    expect(block).toContain('503');
    expect(block).not.toContain('new Error(');
    expect(isTypedFallback(block)).toBe(true);
    // In-memory mutation proof (no source file touched): the same predicate
    // must reject a 503->500 regression and an InviteError->Error regression.
    expect(isTypedFallback(block.replace('503', '500'))).toBe(false);
    expect(isTypedFallback(block.replace('InviteError', 'Error'))).toBe(false);
    // NOTE: `src/server/index.ts` builds the full production server
    // (pool/env/config), so it is not importable as a unit; the HTTP cases
    // above exercise the route contract with an injected service while this
    // textual guard pins the real bootstrap wiring.
  });
});
