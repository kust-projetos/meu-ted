import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { ROUTE_INVENTORY } from '../../src/routes/route-inventory.js';

const serverSource = readFileSync(new URL('../../src/server/index.ts', import.meta.url), 'utf8');

const V1_IDS = [
  'pending-operations-list',
  'pending-operations-details-dual',
  'pending-operations-details',
  'pending-operations-approve-dual',
  'pending-operations-approve',
  'pending-operations-reject-dual',
  'pending-operations-reject',
] as const;

/**
 * PR-1 (retire-pending-v1): the V1 pending-operations HTTP surface is
 * retired — the registration is unconditionally V2-only (the `v2Only`
 * opt is a deprecated no-op kept for call-site compatibility). The Agent
 * never used V1 from the model surface (RETIRED_MODEL_TOOLS blocklist in
 * apps/agent) and the generated registry entries are OpenAPI-owned
 * (regen follow-up, not this slice).
 *
 * This guard locks the post-V1 posture: no V1 store wired in server
 * composition, no V1 route registered with or without the legacy opt,
 * and no V1 entry left in the route inventory.
 */
describe('pending V1 retirement posture (Phase 7 guard, post-V1)', () => {
  it('server composition wires no V1 pending store', () => {
    expect(serverSource).not.toContain('createPostgresPendingOperationStore');
    expect(serverSource).not.toContain('createInMemoryPendingOperationStore');
  });

  it('default registration serves V2 and undo without a V1 store and leaves V1 unmounted', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'actor-auth', workspace: 'workspace-auth', role: 'owner', capabilities: ['financial.approval.read'], jti: 'j', request: 'r', deviceId: 'device-auth', iat: 1, exp: 301 };
      request.authenticatedContext = {
        householdId: 'workspace-auth', actorId: 'actor-auth', authUserId: 'actor-auth',
        actorType: 'user', deviceId: 'device-auth', role: 'owner',
      };
    });
    // No `store`, no `v2Only`: post-V1 the registration is V2-only by
    // construction, so the legacy opts must not be needed to hide V1.
    registerPendingOperationRoutes(app, {
      resolveToken: async () => ({ householdId: 'workspace-token', deviceId: 'device-token' }),
      v2Store: createInMemoryPendingOperationV2Store(),
    });

    const v1Urls: Array<{ method: 'GET' | 'POST'; url: string }> = [
      { method: 'GET', url: '/pending-operations' },
      { method: 'GET', url: '/pending-operations?status=pending' },
      { method: 'GET', url: '/pending-operations/details?pendingOperationId=11111111-1111-4111-8111-111111111111' },
      { method: 'GET', url: '/pending-operations/11111111-1111-4111-8111-111111111111' },
      { method: 'POST', url: '/pending-operations/approve?pendingOperationId=11111111-1111-4111-8111-111111111111' },
      { method: 'POST', url: '/pending-operations/11111111-1111-4111-8111-111111111111/approve' },
      { method: 'POST', url: '/pending-operations/reject?pendingOperationId=11111111-1111-4111-8111-111111111111' },
      { method: 'POST', url: '/pending-operations/11111111-1111-4111-8111-111111111111/reject' },
    ];
    for (const { method, url } of v1Urls) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Not Found');
    }
    const v2 = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(v2.statusCode).not.toBe(404);
    await app.close();
  });

  it('route inventory keeps undo and no V1 pending-operations entry', () => {
    const ids = new Set(ROUTE_INVENTORY.map(({ id }) => id));
    for (const id of V1_IDS) expect(ids.has(id)).toBe(false);
    expect(ids.has('pending-operations-undo')).toBe(true);
  });
});
