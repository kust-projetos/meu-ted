/**
 * Canonical-schema proof for POST /auth/invites/accept (users.phone bug).
 *
 * Root cause: apps/api/src/auth/invites-postgres.ts runs
 *   INSERT INTO users (auth_user_id, email, name, phone, created_at) ...
 * in ensureApplicationUser (:20) and in the acceptInvite transaction (:101).
 * users.phone exists ONLY in the legacy VPS schema (TEXT NOT NULL, no
 * DEFAULT, users_phone_key UNIQUE); the canonical V020 users table never
 * had it, so the accept failed on canonical with
 * `column "phone" of relation "users" does not exist` (the smoke E2E seed
 * worked around it with a direct memberships INSERT). V050 adds the column
 * canonically (nullable compat; strict no-op on legacy), so this suite
 * exercises the real HTTP route on the full canonical migration chain.
 *
 * Runs only with DATABASE_URL_TEST + DB_TEST_MARKER (CI postgres job or a
 * local disposable database); skips otherwise. Cleans up its own rows.
 */
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { hashInviteToken, normalizeInviteEmail } from '../../src/auth/invites.js';
import { registerPostgresProductionRoutes } from '../../src/server/production-routes.js';
import { createPostgresInviteAuthorizer } from '../../src/auth/invites-postgres.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;

const OWNER_EMAIL = 'invite-accept-owner@example.com';
const MEMBER_EMAIL = 'invite-accept-member@example.com';
const OTHER_EMAIL = 'invite-accept-other@example.com';
const HOUSEHOLD_A = '22222222-2222-4222-8222-222222222222';
const HOUSEHOLD_B = '33333333-3333-4333-8333-333333333333';

let pool: Pool;
let auth: ReturnType<typeof createBetterAuth>;
let app: ReturnType<typeof Fastify>;
let ownerId = '';
let memberId = '';
let otherId = '';
let memberAppId = '';
let otherAppId = '';
let ownerCookie = '';
let memberCookie = '';
let otherCookie = '';
let acceptedToken = '';
let ready = false;
const deliveries: Array<{ email: string; token: string }> = [];

const signUp = async (email: string): Promise<{ id: string; cookie: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/sign-up/email',
    headers: { origin: 'http://localhost:3000' },
    payload: { email, password: 'test-password-123', name: email.split('@')[0] },
  });
  const body = response.json() as { user?: { id: string }; message?: string };
  if (response.statusCode !== 200 || !body.user) {
    throw new Error(`Better Auth signup failed: ${response.statusCode} ${body.message ?? 'unknown error'}`);
  }
  const rawCookie = response.headers['set-cookie'];
  return {
    id: body.user.id,
    cookie: Array.isArray(rawCookie) ? rawCookie.join('; ') : String(rawCookie ?? ''),
  };
};

const createInvite = async (cookie: string, householdId: string, email: string) => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/invites',
    headers: {
      origin: 'http://localhost:3000',
      cookie,
      'idempotency-key': randomBytes(16).toString('hex'),
    },
    payload: { householdId, email, role: 'member', expiresAt: '2030-01-01T00:00:00.000Z' },
  });
  return response;
};

const acceptInvite = async (cookie: string, token: string) => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/invites/accept',
    headers: { origin: 'http://localhost:3000', cookie },
    payload: { token },
  });
  return response;
};

describe('Postgres invites accept on the canonical schema (V050)', () => {
  beforeAll(async () => {
    if (!ENABLED) return;
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'migrate');
    await runMigrations(pool);
    await pool.query('DELETE FROM households WHERE id IN ($1, $2)', [HOUSEHOLD_A, HOUSEHOLD_B]);
    await pool.query('DELETE FROM invites WHERE email_normalized IN ($1, $2, $3)', [OWNER_EMAIL, MEMBER_EMAIL, OTHER_EMAIL]);
    await pool.query('DELETE FROM "user" WHERE email IN ($1, $2, $3)', [OWNER_EMAIL, MEMBER_EMAIL, OTHER_EMAIL]);

    auth = createBetterAuth({
      pool,
      disableSignUp: false,
      secret: 'test-secret-that-is-at-least-32-characters',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3000'],
    });
    app = Fastify({ logger: false });
    registerPostgresProductionRoutes(app, pool, HOUSEHOLD_A, auth, async (message) => {
      deliveries.push({ email: normalizeInviteEmail(message.email), token: message.token });
    });

    const owner = await signUp(OWNER_EMAIL);
    const member = await signUp(MEMBER_EMAIL);
    const other = await signUp(OTHER_EMAIL);
    ownerId = owner.id;
    memberId = member.id;
    otherId = other.id;
    ownerCookie = owner.cookie;
    memberCookie = member.cookie;
    otherCookie = other.cookie;

    // ensureApplicationUser runs the users INSERT that references
    // users.phone — on canonical without V050 this throws 42703 here.
    const authorizeInviteCreate = createPostgresInviteAuthorizer(pool);
    await authorizeInviteCreate({ userId: ownerId, householdId: HOUSEHOLD_A });
    await authorizeInviteCreate({ userId: memberId, householdId: HOUSEHOLD_A });
    await authorizeInviteCreate({ userId: otherId, householdId: HOUSEHOLD_A });
    const appUsers = await pool.query<{ id: string; auth_user_id: string }>(
      'SELECT id, auth_user_id FROM users WHERE auth_user_id IN ($1, $2, $3)',
      [ownerId, memberId, otherId],
    );
    memberAppId = appUsers.rows.find((row) => row.auth_user_id === memberId)!.id;
    otherAppId = appUsers.rows.find((row) => row.auth_user_id === otherId)!.id;
    const ownerAppId = appUsers.rows.find((row) => row.auth_user_id === ownerId)!.id;
    await pool.query(
      `INSERT INTO households (id, name, kind, owner_user_id)
       VALUES ($1, 'Invite accept household A', 'shared', $2)`,
      [HOUSEHOLD_A, ownerAppId],
    );
    await pool.query(
      `INSERT INTO households (id, name, kind, owner_user_id)
       VALUES ($1, 'Invite accept household B', 'shared', $2)`,
      [HOUSEHOLD_B, ownerAppId],
    );
    ready = true;
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    if (ready) {
      await pool.query('DELETE FROM households WHERE id IN ($1, $2)', [HOUSEHOLD_A, HOUSEHOLD_B]);
      await pool.query('DELETE FROM invites WHERE email_normalized IN ($1, $2, $3)', [OWNER_EMAIL, MEMBER_EMAIL, OTHER_EMAIL]);
      await pool.query('DELETE FROM "user" WHERE id IN ($1, $2, $3)', [ownerId, memberId, otherId]);
    }
    await app?.close();
    if (auth) await auth.close();
    else await pool.end();
  });

  itIfDatabase('accepts a valid invite and creates an active membership', async () => {
    const create = await createInvite(ownerCookie, HOUSEHOLD_A, MEMBER_EMAIL);
    expect(create.statusCode).toBe(201);
    const token = deliveries.find((d) => d.email === MEMBER_EMAIL)!.token;
    acceptedToken = token;

    const accept = await acceptInvite(memberCookie, token);
    expect(accept.statusCode).toBe(200);
    const body = accept.json() as { inviteId: string; membership: { userId: string; householdId: string; role: string } };
    expect(body.membership.householdId).toBe(HOUSEHOLD_A);
    expect(body.membership.role).toBe('member');

    const membership = await pool.query<{ status: string }>(
      'SELECT status FROM memberships WHERE user_id = $1 AND household_id = $2',
      [memberAppId, HOUSEHOLD_A],
    );
    expect(membership.rows).toHaveLength(1);
    expect(membership.rows[0]!.status).toBe('active');

    const invite = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM invites WHERE token_hash = $1',
      [hashInviteToken(token)],
    );
    expect(invite.rows[0]!.consumed_at).not.toBeNull();
  }, 30_000);

  itIfDatabase('rejects an expired invite without creating a membership', async () => {
    const create = await createInvite(ownerCookie, HOUSEHOLD_A, OTHER_EMAIL);
    expect(create.statusCode).toBe(201);
    const token = deliveries.filter((d) => d.email === OTHER_EMAIL).at(-1)!.token;
    await pool.query('UPDATE invites SET expires_at = NOW() - INTERVAL \'1 day\' WHERE token_hash = $1', [
      hashInviteToken(token),
    ]);

    const accept = await acceptInvite(otherCookie, token);
    expect(accept.statusCode).toBe(410);
    expect((accept.json() as { code: string }).code).toBe('invite.expired');

    const membership = await pool.query('SELECT 1 FROM memberships WHERE user_id = $1 AND household_id = $2', [
      otherAppId,
      HOUSEHOLD_A,
    ]);
    expect(membership.rows).toHaveLength(0);
  }, 30_000);

  itIfDatabase('rejects a consumed invite on re-accept', async () => {
    const accept = await acceptInvite(memberCookie, acceptedToken);
    expect(accept.statusCode).toBe(409);
    expect((accept.json() as { code: string }).code).toBe('invite.already_used');
  }, 30_000);

  itIfDatabase('returns 404 for an unknown token and stays healthy afterwards', async () => {
    const unknown = await acceptInvite(otherCookie, randomBytes(32).toString('hex'));
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { code: string }).code).toBe('invite.not_found');

    // Route still serves a fresh valid accept after the inconsistent input.
    const create = await createInvite(ownerCookie, HOUSEHOLD_B, OTHER_EMAIL);
    expect(create.statusCode).toBe(201);
    const token = deliveries.filter((d) => d.email === OTHER_EMAIL).at(-1)!.token;
    const accept = await acceptInvite(otherCookie, token);
    expect(accept.statusCode).toBe(200);
    const membership = await pool.query('SELECT 1 FROM memberships WHERE user_id = $1 AND household_id = $2', [
      otherAppId,
      HOUSEHOLD_B,
    ]);
    expect(membership.rows).toHaveLength(1);
  }, 30_000);
});
