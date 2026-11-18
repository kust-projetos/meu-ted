import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentCategoryAutoExecTokenRoutes } from '../../src/routes/agent-category-autoexec-token.js';
import { verifyDelegatedTurnToken } from '../../src/auth/delegated-token.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'device-test-1';
const SERVICE = 'synthetic-category-autoexec-service-token-value-32';
const SECRET = 'synthetic-delegation-signing-secret-value-32';
const BODY = { workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE, intentionId: 'intention-test' };

const setup = (opts: { service?: string; member?: boolean; device?: boolean; pool?: boolean; canonical?: string } = {}) => {
  const app = Fastify({ logger: false });
  const pool = opts.pool === false ? null : {
    async query(sql: string) {
      if (sql.includes('FROM households')) return { rows: [{ id: WORKSPACE }], rowCount: opts.canonical === undefined ? 1 : 0 };
      if (sql.includes('FROM invites')) return opts.canonical
        ? { rows: [{ household_id: opts.canonical }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: opts.device === false ? 0 : 1 };
    },
  };
  registerAgentCategoryAutoExecTokenRoutes(app, {
    categoryAutoExecMintServiceToken: opts.service === undefined ? SERVICE : opts.service,
    delegationSecret: SECRET,
    workspaceAccess: { resolve: async () => opts.member === false ? undefined : {
      userId: ACTOR, householdId: WORKSPACE, role: 'owner', kind: 'personal', status: 'active',
    } },
    pool,
  });
  return app;
};

const post = (app: ReturnType<typeof setup>, body: unknown = BODY, token?: string) =>
  app.inject({ method: 'POST', url: '/auth/agent/category-autoexec-token', headers: token ? { 'x-agent-category-autoexec-service-token': token } : {}, payload: body });

describe('POST /auth/agent/category-autoexec-token', () => {
  const apps: ReturnType<typeof setup>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  const make = (opts?: Parameters<typeof setup>[0]) => { const app = setup(opts); apps.push(app); return app; };

  it('fails closed without configuration and rejects invalid service credentials', async () => {
    expect((await post(make({ service: '' }))).statusCode).toBe(503);
    expect((await post(make({ service: 'short' }), BODY, 'short')).statusCode).toBe(503);
    expect((await post(make())).statusCode).toBe(401);
    expect((await post(make(), BODY, 'wrong-synthetic-token')).statusCode).toBe(401);
  });

  it.each([
    { ...BODY, extra: true }, { ...BODY, workspaceId: 'bad' }, { ...BODY, actorId: 'bad' },
    { ...BODY, deviceId: 'bad device' }, { ...BODY, intentionId: '' },
    { ...BODY, intentionId: 'x'.repeat(241) },
  ])('rejects malformed body with 400', async (body) => {
    expect((await post(make(), body, SERVICE)).statusCode).toBe(400);
  });

  it.each([
    ['absent membership', { member: false }],
    ['foreign device', { device: false }],
    ['non-canonical workspace', { canonical: '33333333-3333-4333-8333-333333333333' }],
    ['missing pool', { pool: false }],
  ] as const)('denies %s without leaking secrets', async (_case, opts) => {
    const response = await post(make(opts), BODY, SERVICE);
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.json())).not.toMatch(/token|secret|device-test|intention-test/i);
  });

  it('issues a 300-second token containing only the category-scoped autoexecute grant', async () => {
    const response = await post(make(), BODY, SERVICE);
    expect(response.statusCode).toBe(200);
    const claims = await verifyDelegatedTurnToken(response.json().token, SECRET);
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.capabilities).toEqual([
      'financial.read', 'financial.approval.read', 'financial.approval.propose',
      'financial.approval.execute', 'financial.approval.autoexecute.category',
    ]);
    expect(claims.capabilities).not.toContain('financial.approval.autoexecute');
  });
});
