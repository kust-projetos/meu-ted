import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentPendingTokenRoutes } from '../../src/routes/agent-pending-token.js';
import { verifyDelegatedTurnToken } from '../../src/auth/delegated-token.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'device-test-1';
const SERVICE = 'synthetic-pending-service-token-value-32';
const AUTOEXEC_SERVICE = 'synthetic-autoexec-service-token-value-32';
const SECRET = 'synthetic-delegation-signing-secret-value-32';
const BODY = { workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE, requestId: 'intention-test' };

const setup = (opts: { service?: string; member?: boolean; device?: boolean; pool?: boolean; canonical?: string } = {}) => {
  const app = Fastify({ logger: false });
  const queryCalls: unknown[][] = [];
  const pool = opts.pool === false ? null : {
    async query(sql: string, values: unknown[] = []) {
      queryCalls.push(values);
      if (sql.includes('FROM households')) {
        return { rows: [{ id: WORKSPACE }], rowCount: opts.canonical === undefined ? 1 : 0 };
      }
      if (sql.includes('FROM invites')) return opts.canonical
        ? { rows: [{ household_id: opts.canonical }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: opts.device === false ? 0 : 1 };
    },
  };
  registerAgentPendingTokenRoutes(app, {
    pendingMintServiceToken: opts.service === undefined ? SERVICE : opts.service,
    delegationSecret: SECRET,
    workspaceAccess: { resolve: async () => opts.member === false ? undefined : {
      userId: ACTOR, householdId: WORKSPACE, role: 'owner', kind: 'personal', status: 'active',
    } },
    pool,
  });
  return { app, queryCalls };
};

const post = (app: ReturnType<typeof setup>['app'], body: unknown = BODY, token?: string) =>
  app.inject({ method: 'POST', url: '/auth/agent/pending-token', headers: token ? { 'x-agent-pending-service-token': token } : {}, payload: body });

describe('POST /auth/agent/pending-token', () => {
  const apps: ReturnType<typeof setup>['app'][] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  const make = (opts?: Parameters<typeof setup>[0]) => { const result = setup(opts); apps.push(result.app); return result; };

  it('fails closed without service configuration; rejects absent or incorrect service credentials', async () => {
    const unconfigured = make({ service: '' });
    expect((await post(unconfigured.app)).statusCode).toBe(503);
    const short = make({ service: 'short' });
    const shortResponse = await post(short.app, BODY, 'short');
    expect(shortResponse.statusCode).toBe(503);
    expect(shortResponse.json()).toEqual({ code: 'auth.service_unavailable' });
    const configured = make();
    expect((await post(configured.app)).statusCode).toBe(401);
    expect((await post(configured.app, BODY, 'wrong-synthetic-token')).statusCode).toBe(401);
    const dedicated = make();
    expect((await post(dedicated.app, BODY, AUTOEXEC_SERVICE)).statusCode).toBe(401);
    expect((await post(dedicated.app, BODY, SERVICE)).statusCode).toBe(200);
  });

  it.each([
    { ...BODY, extra: true }, { ...BODY, workspaceId: 'bad' }, { ...BODY, actorId: 'bad' },
    { ...BODY, deviceId: 'bad device' }, { ...BODY, requestId: '' },
    { ...BODY, requestId: 'x'.repeat(241) },
  ])('rejects malformed body with 400', async (body) => {
    const { app } = make();
    const response = await post(app, body, SERVICE);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'validation.error' });
  });

  it.each([
    ['absent membership', { member: false }],
    ['foreign, revoked or expired device', { device: false }],
    ['non-canonical workspace', { canonical: '33333333-3333-4333-8333-333333333333' }],
    ['missing pool', { pool: false }],
  ] as const)('denies %s', async (_case, opts) => {
    const { app } = make(opts);
    const response = await post(app, BODY, SERVICE);
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.json())).not.toMatch(/token|secret|device-test|intention-test/i);
  });

  it('issues only the minimal, short-lived delegated claims', async () => {
    const { app } = make();
    const response = await post(app, BODY, SERVICE);
    expect(response.statusCode).toBe(200);
    const claims = await verifyDelegatedTurnToken(response.json().token, SECRET);
    expect(claims.sub).toBe(ACTOR);
    expect(claims.workspace).toBe(WORKSPACE);
    expect(claims.deviceId).toBe(DEVICE);
    expect(claims.request).toBe(BODY.requestId);
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.capabilities).toEqual([
      'financial.read', 'financial.approval.read', 'financial.approval.propose',
      'financial.approval.confirm', 'financial.approval.cancel', 'financial.approval.retry',
      'financial.approval.reconcile', 'financial.approval.execute', 'financial.undo.execute',
    ]);
    expect(claims.capabilities).not.toContain('financial.approval.autoexecute');
    expect(response.json().expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
  });
});

