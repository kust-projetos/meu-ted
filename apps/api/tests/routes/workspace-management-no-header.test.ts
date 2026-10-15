import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerRoutes } from '../../src/routes/index.js';
import { createInMemoryDeviceTokenStore } from '../../src/auth/device-token.js';
import { createInMemoryWorkspaceStore } from '../../src/auth/workspaces-http.js';
import { createInMemoryReadModelStore } from '../../src/read-models/store.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import type { createBetterAuth } from '../../src/auth/better-auth.js';
import type { WorkspaceAccessStore } from '../../src/auth/workspace-access.js';

/**
 * FIX-168-167 (P0 #168): archiving the last active workspace leaves the
 * session with no X-Workspace-Id header. Workspace management (list/restore)
 * must stay reachable via session + target + owner — the global preHandler
 * currently answers 403 auth.workspace_required for every headerless route
 * except GET /workspaces, so restore/create are unreachable and the user is
 * stuck. Financial I/O must keep requiring the header.
 *
 * RED first: owner restore without header => 403 workspace_required (want 2xx);
 * owner create without header => 403 workspace_required (want 201).
 */

const TOKENS: Record<string, { id: string; email: string }> = {
  'Bearer token-owner': { id: 'user-1', email: 'owner@example.test' },
  'Bearer token-stranger': { id: 'user-2', email: 'stranger@example.test' },
};

const buildAuthMock = () =>
  ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const authorization = headers.get('authorization') ?? '';
        const user = TOKENS[authorization];
        if (!user) return null;
        return { user, session: { id: `session-${user.id}` } };
      },
    },
    options: { baseURL: 'http://localhost:3001', trustedOrigins: [] },
  }) as unknown as ReturnType<typeof createBetterAuth>;

const workspaceAccess: WorkspaceAccessStore = {
  async resolve(authUserId, householdId) {
    if (authUserId === 'user-1') {
      return { userId: 'user-1', householdId, role: 'owner', kind: 'personal' };
    }
    return undefined;
  },
};

const buildApp = async () => {
  const { writes } = createInMemoryStores({});
  const store = createInMemoryReadModelStore({
    accounts: [],
    categories: [],
    transactions: [],
    deletedTransactionIds: [],
  });
  const workspaceStore = createInMemoryWorkspaceStore();
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    store,
    writes,
    tokenStore: createInMemoryDeviceTokenStore(),
    disableDeviceRegistration: true,
    auth: buildAuthMock(),
    workspaceAccess,
    workspaceStore,
  });
  await app.ready();
  return { app, workspaceStore };
};

describe('FIX-168: workspace management without an active workspace header', () => {
  it('owner restores the archived last workspace without X-Workspace-Id (not workspace_required)', async () => {
    const { app, workspaceStore } = await buildApp();
    try {
      const created = await workspaceStore.create({ authUserId: 'user-1', name: 'Casa', kind: 'personal' });
      const archivedId = created.id;
      await workspaceStore.setStatus({ authUserId: 'user-1', householdId: archivedId, status: 'archived' });

      const res = await app.inject({
        method: 'POST',
        url: `/workspaces/${archivedId}/restore`,
        headers: { authorization: 'Bearer token-owner', 'idempotency-key': 'restore-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: archivedId, status: 'active' });
    } finally {
      await app.close();
    }
  });

  it('non-member restore without X-Workspace-Id stays 403', async () => {
    const { app, workspaceStore } = await buildApp();
    try {
      const created = await workspaceStore.create({ authUserId: 'user-1', name: 'Casa', kind: 'personal' });
      const archivedId = created.id;
      await workspaceStore.setStatus({ authUserId: 'user-1', householdId: archivedId, status: 'archived' });

      const res = await app.inject({
        method: 'POST',
        url: `/workspaces/${archivedId}/restore`,
        headers: { authorization: 'Bearer token-stranger', 'idempotency-key': 'restore-2' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('owner creates a workspace without X-Workspace-Id (session-only management)', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { authorization: 'Bearer token-owner', 'idempotency-key': 'create-1' },
        payload: { name: 'Novo espaço', kind: 'shared' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'Novo espaço', kind: 'shared' });
    } finally {
      await app.close();
    }
  });

  it('financial I/O without X-Workspace-Id still requires the header (guard preserved)', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/accounts',
        headers: { authorization: 'Bearer token-owner' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'auth.workspace_required' });
    } finally {
      await app.close();
    }
  });
});
