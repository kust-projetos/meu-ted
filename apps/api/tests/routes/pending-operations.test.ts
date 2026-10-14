import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';

const OP_ID = '11111111-1111-4111-8111-111111111111';

/**
 * PR-1 (retire-pending-v1): the V1 pending-operations HTTP surface is
 * retired. Every V1 route must answer with the router 404 (Fastify
 * `{ error: 'Not Found' }` — never a domain 404), while
 * POST /pending-operations/undo stays mounted.
 */
describe('pending operations V1 retirement', () => {
  const v1Cases: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'GET', url: '/pending-operations' },
    { method: 'GET', url: '/pending-operations?status=pending' },
    { method: 'GET', url: `/pending-operations/details?pendingOperationId=${OP_ID}` },
    { method: 'GET', url: `/pending-operations/${OP_ID}` },
    { method: 'POST', url: `/pending-operations/approve?pendingOperationId=${OP_ID}` },
    { method: 'POST', url: `/pending-operations/${OP_ID}/approve` },
    { method: 'POST', url: `/pending-operations/reject?pendingOperationId=${OP_ID}` },
    { method: 'POST', url: `/pending-operations/${OP_ID}/reject` },
  ];

  it.each(v1Cases)('V1 route is absent: $method $url', async ({ method, url }) => {
    const { app } = buildTestApp();
    const res = await app.inject({ method, url, headers: { 'x-device-token': TOKEN_A } });
    expect(res.statusCode).toBe(404);
    // Router 404 shape — proves no route handler ran (a domain 404 would
    // carry `{ code, message }` instead of `{ error: 'Not Found' }`).
    expect(res.json().error).toBe('Not Found');
    await app.close();
  });

  it('keeps POST /pending-operations/undo mounted', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/pending-operations/undo',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
      payload: {},
    });
    // Empty audit log: the undo handler runs and answers its domain outcome
    // (`undo.nothing_to_undo`), proving the route is still registered.
    expect(res.json().code).toBe('undo.nothing_to_undo');
    await app.close();
  });
});
