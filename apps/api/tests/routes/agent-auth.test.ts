import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { registerRoutes } from '../../src/routes/index.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryReadModelStoreFromState } from '../../src/read-models/store.js';
import { createInMemoryDeviceTokenStore } from '../../src/auth/device-token.js';
import { createInMemoryIdempotencyStore } from '../../src/writes/idempotency.js';
import { Buffer } from 'node:buffer';

describe('Agent Auth Routes (Task 3)', () => {
  let app: FastifyInstance;
  let auth: ReturnType<typeof createBetterAuth>;

  const USER_EMAIL = 'member@example.com';
  const HOUSEHOLD_A = 'household-uuid-a';
  const HOUSEHOLD_B = 'household-uuid-b';
  const CONNECTION_SECRET = 'test-agent-connection-secret-at-least-32-chars!';

  let memberCookie = '';
  let userId = '';
  let tokenStore: ReturnType<typeof createInMemoryDeviceTokenStore>;

  beforeEach(async () => {
    const memoryDb = { user: [], session: [], account: [], verification: [] };
    auth = createBetterAuth({
      database: memoryAdapter(memoryDb),
      disableSignUp: true,
      transaction: false,
      secret: 'test-secret-that-is-at-least-32-characters',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3000'],
    });

    const user = await auth.api.createUser({
      body: {
        email: USER_EMAIL,
        password: 'Password123!',
        name: 'Test Member',
      },
    });
    userId = user?.user?.id ?? 'user-uuid-1';

    const signIn = await auth.api.signInEmail({
      body: {
        email: USER_EMAIL,
        password: 'Password123!',
      },
      asResponse: true,
    });
    memberCookie = signIn.headers.get('set-cookie') ?? '';

    const { state, writes } = createInMemoryStores();
    const store = createInMemoryReadModelStoreFromState(state);
    tokenStore = createInMemoryDeviceTokenStore();

    const workspaceAccess = {
      resolve: async (uId: string, hId: string) => {
        if (uId === userId && hId === HOUSEHOLD_A) {
          return {
            userId,
            householdId: HOUSEHOLD_A,
            role: 'owner' as const,
            kind: 'personal' as const,
          };
        }
        return undefined;
      },
    };

    app = Fastify({ logger: false });
    registerRoutes(app, {
      store,
      writes,
      tokenStore,
      idempotency: createInMemoryIdempotencyStore(),
      auth,
      workspaceAccess,
      agentConnectionSecret: CONNECTION_SECRET,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await auth.close();
  });

  describe('POST /auth/agent-token (Token Emission)', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: { 'x-workspace-id': HOUSEHOLD_A },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'auth.session_required' });
    });

    it('returns 400 when x-workspace-id header is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'auth.workspace_required' });
    });

    it('returns 403 when user is not a member of the workspace', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: {
          cookie: memberCookie,
          'x-workspace-id': HOUSEHOLD_B, // User does not belong to B
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'auth.workspace_forbidden' });
    });

    it('emits short-lived JWT token for verified workspace membership and ignores forged body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: {
          cookie: memberCookie,
          'x-workspace-id': HOUSEHOLD_A,
        },
        payload: {
          // Forged body attempting privilege escalation
          sub: 'hacker-uuid',
          role: 'admin',
          workspace: 'other-workspace',
        },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data).toMatchObject({
        expiresIn: 120,
        workspace: HOUSEHOLD_A,
        role: 'owner',
      });
      expect(data.token).toBeTypeOf('string');

      // Verify claims directly
      const claims = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString('utf8'));
      expect(claims.sub).toBe(userId);
      expect(claims.workspace).toBe(HOUSEHOLD_A);
      expect(claims.role).toBe('owner');
    });
  });

  describe('H-12: device binding at mint (POST /auth/agent-token)', () => {
    it('embeds the server-resolved deviceId when a device token is presented', async () => {
      const deviceToken = (await tokenStore.register('mint-device', HOUSEHOLD_A)).token;
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: {
          cookie: memberCookie,
          'x-workspace-id': HOUSEHOLD_A,
          'x-device-token': deviceToken,
        },
      });
      expect(res.statusCode).toBe(200);
      const claims = JSON.parse(Buffer.from(res.json().token.split('.')[1], 'base64url').toString('utf8'));
      // The bound device is the one resolved server-side (never a client claim).
      const expected = await tokenStore.resolve(deviceToken);
      expect(claims.deviceId).toBe(expected.deviceId);
    });

    it('denies the mint when the presented device was revoked', async () => {
      const { token } = await tokenStore.register('revoked-device', HOUSEHOLD_A);
      await tokenStore.revoke(token, HOUSEHOLD_A);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: {
          cookie: memberCookie,
          'x-workspace-id': HOUSEHOLD_A,
          'x-device-token': token,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('mints deviceless when no device token is presented (session-only compat)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-token',
        headers: {
          cookie: memberCookie,
          'x-workspace-id': HOUSEHOLD_A,
        },
      });
      expect(res.statusCode).toBe(200);
      const claims = JSON.parse(Buffer.from(res.json().token.split('.')[1], 'base64url').toString('utf8'));
      expect(claims.deviceId).toBeUndefined();
    });
  });
});
