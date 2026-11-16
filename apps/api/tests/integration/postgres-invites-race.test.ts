import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { registerPostgresProductionRoutes } from '../../src/server/production-routes.js';
import { createPostgresInviteAuthorizer } from '../../src/auth/invites-postgres.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const OWNER_EMAIL = 'invite-race-owner@example.com';
const MEMBER_EMAIL = 'invite-race-member@example.com';
const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';

const itIfDatabase = ENABLED ? it : it.skip;
let pool: Pool;
let auth: ReturnType<typeof createBetterAuth>;
let app: ReturnType<typeof Fastify>;
let ownerId: string;
let memberId: string;
let memberAppId: string;
let ownerCookie: string;
let memberCookie: string;
let ready = false;
const deliveries: Array<{ token: string }> = [];

const signUp = async (email: string): Promise<{ id: string; cookie: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/sign-up/email',
    headers: { origin: 'http://localhost:3000' },
    payload: { email, password: 'test-password-123', name: email.split('@')[0] },
  });
  const body = response.json() as { user?: { id: string }; message?: string };
  if (response.statusCode !== 200 || !body.user) throw new Error(`Better Auth signup failed: ${response.statusCode} ${body.message ?? 'unknown error'}`);
  const rawCookie = response.headers['set-cookie'];
  return {
    id: body.user.id,
    cookie: Array.isArray(rawCookie) ? rawCookie.join('; ') : String(rawCookie ?? ''),
  };
};

describe('Postgres invite race integration', () => {
  beforeAll(async () => {
    if (!ENABLED) return;
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await runMigrations(pool);
    await pool.query('DELETE FROM households WHERE id = $1', [HOUSEHOLD_ID]);
    await pool.query('DELETE FROM invites WHERE email_normalized IN ($1, $2)', [OWNER_EMAIL, MEMBER_EMAIL]);
    await pool.query('DELETE FROM "user" WHERE email IN ($1, $2)', [OWNER_EMAIL, MEMBER_EMAIL]);

    auth = createBetterAuth({
      pool,
      disableSignUp: false,
      secret: 'test-secret-that-is-at-least-32-characters',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3000'],
    });
    app = Fastify({ logger: false });
    registerPostgresProductionRoutes(app, pool, HOUSEHOLD_ID, auth, async (message) => {
      deliveries.push({ token: message.token });
    });

    const owner = await signUp(OWNER_EMAIL);
    const member = await signUp(MEMBER_EMAIL);
    ownerId = owner.id;
    memberId = member.id;
    const authorizeInviteCreate = createPostgresInviteAuthorizer(pool);
    await authorizeInviteCreate({ userId: ownerId, householdId: HOUSEHOLD_ID });
    await authorizeInviteCreate({ userId: memberId, householdId: HOUSEHOLD_ID });
    const appUsers = await pool.query<{ id: string; auth_user_id: string }>(
      'SELECT id, auth_user_id FROM users WHERE auth_user_id IN ($1, $2)',
      [ownerId, memberId],
    );
    memberAppId = appUsers.rows.find((row) => row.auth_user_id === memberId)!.id;
    const ownerAppId = appUsers.rows.find((row) => row.auth_user_id === ownerId)!.id;
    await pool.query(
      `INSERT INTO households (id, name, kind, owner_user_id)
       VALUES ($1, 'Invite race household', 'shared', $2)`,
      [HOUSEHOLD_ID, ownerAppId],
    );
    ownerCookie = owner.cookie;
    memberCookie = member.cookie;
    ready = true;
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    if (ready) {
      await pool.query('DELETE FROM households WHERE id = $1', [HOUSEHOLD_ID]);
      await pool.query('DELETE FROM invites WHERE email_normalized = $1', [MEMBER_EMAIL]);
      await pool.query('DELETE FROM "user" WHERE id IN ($1, $2)', [ownerId, memberId]);
    }
    await app?.close();
    if (auth) await auth.close();
    else await pool.end();
  });

  itIfDatabase('runs the production Postgres routes with two concurrent accepts', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/auth/invites',
      headers: { origin: 'http://localhost:3000', cookie: ownerCookie, 'idempotency-key': randomBytes(16).toString('hex') },
      payload: { householdId: HOUSEHOLD_ID, email: ` ${MEMBER_EMAIL.toUpperCase()} `, role: 'member', expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    expect(create.statusCode).toBe(201);
    expect(deliveries).toHaveLength(1);

    const accepts = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/invites/accept', headers: { origin: 'http://localhost:3000', cookie: memberCookie }, payload: { token: deliveries[0]!.token } }),
      app.inject({ method: 'POST', url: '/auth/invites/accept', headers: { origin: 'http://localhost:3000', cookie: memberCookie }, payload: { token: deliveries[0]!.token } }),
    ]);
    const membership = await pool.query(
      'SELECT user_id, household_id FROM memberships WHERE user_id = $1 AND household_id = $2',
      [memberAppId, HOUSEHOLD_ID],
    );

    expect(accepts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(membership.rows).toHaveLength(1);
  }, 30_000);
});
