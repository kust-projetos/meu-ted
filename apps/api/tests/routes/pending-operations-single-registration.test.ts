import { describe, expect, it } from 'vitest';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { buildTestApp, TOKEN_A } from '../test-app.js';

const OP_ID = '11111111-1111-4111-8111-111111111111';

// P0 boot crash: PR-1 retired the V1 routes and dropped the
// `if (opts.v2Only) return;` early-return, so the production composition
// (registerRoutes + server/index.ts registerPendingOperationRoutes with
// v2Only on the SAME app) registers POST /pending-operations/undo twice
// and Fastify crashes boot with FST_ERR_DUPLICATED_ROUTE. These tests pin
// the production composition: the second registration must be a no-op for
// /undo, /undo must keep serving, and V1 must stay retired (404).
const secondRegistration = (app: Parameters<typeof registerPendingOperationRoutes>[0]) =>
  registerPendingOperationRoutes(app, {
    resolveToken: async () => {
      throw Object.assign(new Error('unused second resolver'), {
        statusCode: 401,
        code: 'auth.invalid_token',
      });
    },
    v2Only: true,
  });

describe('pending-operations single registration (production boot composition)', () => {
  it('second registration with v2Only does not throw FST_ERR_DUPLICATED_ROUTE', async () => {
    const { app } = buildTestApp();
    expect(() => secondRegistration(app)).not.toThrow();
    await app.close();
  });

  it('POST /pending-operations/undo serves after the double composition', async () => {
    const { app } = buildTestApp();
    secondRegistration(app);
    const res = await app.inject({
      method: 'POST',
      url: '/pending-operations/undo',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
      payload: {},
    });
    expect(res.json().code).toBe('undo.nothing_to_undo');
    await app.close();
  });

  it('V1 stays retired (router 404) after the double composition', async () => {
    const { app } = buildTestApp();
    secondRegistration(app);
    const res = await app.inject({
      method: 'GET',
      url: `/pending-operations/${OP_ID}`,
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Not Found');
    await app.close();
  });
});
