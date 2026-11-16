import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { registerPostgresProductionRoutes } from '../../src/server/production-routes.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createBetterAuth } from '../../src/auth/better-auth.js';

const mockPool = {
  async query(sql: string) {
    if (sql.includes('information_schema.columns')) return { rows: [] };
    if (sql.includes('FROM _migrations')) return { rows: [] };
    if (sql.includes('FROM device_tokens')) return { rows: [{ device_id: 'test-device', household_id: HOUSEHOLD_A }] };
    return { rows: [] };
  },
} as unknown as Pool;

const makeAuth = () => createBetterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  disableSignUp: false,
  transaction: false,
  secret: 'test-secret-that-is-at-least-32-characters',
  baseURL: 'http://localhost:3001',
  trustedOrigins: ['http://localhost:3000'],
});

describe('workspace production composition', () => {
  it('mounts workspace and ownership transfer routes in the production composition', async () => {
    const auth = makeAuth();
    const canonicalApp = Fastify({ logger: false });

    registerPostgresProductionRoutes(canonicalApp, mockPool, HOUSEHOLD_A, auth);

    // Canonical app
    const canonicalWorkspaces = await canonicalApp.inject({ method: 'GET', url: '/workspaces' });
    expect(canonicalWorkspaces.statusCode).toBe(401);
    expect(canonicalWorkspaces.json()).toMatchObject({ code: 'auth.missing_session' });

    const canonicalTransfers = await canonicalApp.inject({
      method: 'POST',
      url: `/workspaces/${HOUSEHOLD_A}/ownership-transfers`,
      payload: { toUserId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(canonicalTransfers.statusCode).toBe(401);

    await canonicalApp.close();
    await auth.close();
  });

  it('mounts protected invite routes when inviteDelivery is omitted', async () => {
    const auth = makeAuth();
    const app = Fastify({ logger: false });
    // inviteDelivery omitted: management remains available but delivery fails closed.
    registerPostgresProductionRoutes(app, mockPool, HOUSEHOLD_A, auth, undefined);

    const inviteRes = await app.inject({
      method: 'POST',
      url: '/auth/invites',
      payload: { householdId: HOUSEHOLD_A, email: 'guest@example.com', role: 'member', expiresAt: new Date().toISOString() },
    });
    expect(inviteRes.statusCode).toBe(401);

    await app.close();
    await auth.close();
  });

  it('mounts protected invite routes when explicit inviteDelivery is provided', async () => {
    const auth = makeAuth();
    const explicitDelivery = async () => undefined;
    const app = Fastify({ logger: false });
    registerPostgresProductionRoutes(app, mockPool, HOUSEHOLD_A, auth, explicitDelivery);

    const inviteRes = await app.inject({
      method: 'POST',
      url: '/auth/invites',
      payload: {},
    });
    // With explicit delivery, the route is mounted and responds 401 when unauthenticated (NOT 404)
    expect(inviteRes.statusCode).toBe(401);

    await app.close();
    await auth.close();
  });

  it('rejects invite creation by an authenticated non-owner', async () => {
    const auth = makeAuth();
    await auth.api.createUser({
      body: {
        email: 'member@example.com',
        password: 'MemberPassword123!',
        name: 'Workspace Member',
      },
    });
    const signIn = await auth.api.signInEmail({
      body: {
        email: 'member@example.com',
        password: 'MemberPassword123!',
      },
      asResponse: true,
    });
    const cookie = signIn.headers.get('set-cookie') ?? '';
    const app = Fastify({ logger: false });
    registerPostgresProductionRoutes(app, mockPool, HOUSEHOLD_A, auth, async () => undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/invites',
      headers: { cookie },
      payload: {
        householdId: HOUSEHOLD_A,
        email: 'guest@example.com',
        role: 'member',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'auth.invite_forbidden' });
    await app.close();
    await auth.close();
  });
});
