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
 * FIX-WS-D2-R2 item 4 (HIGH header): o lifecycle é validado pelo
 * workspace EFETIVAMENTE mutado (path), nunca pelo header opcional.
 *
 * Cenário: header aponta para um workspace ATIVO, mas o path muta um
 * workspace ARQUIVADO. O freeze do preHandler (baseado no header) passa
 * cego; o store precisa recusar pelo path — mesmo com o access store
 * legado sem status (fail-open pré-D2).
 */

const TOKENS: Record<string, { id: string; email: string }> = {
  'Bearer token-owner': { id: 'user-1', email: 'owner@example.test' },
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

// Access store legado: owner, SEM status (fail-open pré-D2) — o freeze do
// preHandler não enxerga nada; a decisão precisa vir do path (store).
const legacyAccess: WorkspaceAccessStore = {
  async resolve(authUserId, householdId) {
    if (authUserId === 'user-1') {
      return { userId: 'user-1', householdId, role: 'owner', kind: 'shared' };
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
    workspaceAccess: legacyAccess,
    workspaceStore,
  });
  await app.ready();
  return { app, workspaceStore };
};

describe('FIX-WS-D2-R2 item 4 — lifecycle validado pelo path, não pelo header', () => {
  it('rename de workspace arquivado recusa 403 mesmo com header de workspace ativo', async () => {
    const { app, workspaceStore } = await buildApp();
    try {
      const active = await workspaceStore.create({ authUserId: 'user-1', name: 'Ativo', kind: 'shared' });
      const archived = await workspaceStore.create({ authUserId: 'user-1', name: 'Arquivado', kind: 'shared' });
      await workspaceStore.setStatus({ authUserId: 'user-1', householdId: archived.id, status: 'archived' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/workspaces/${archived.id}`,
        headers: {
          authorization: 'Bearer token-owner',
          'x-workspace-id': active.id,
          'idempotency-key': 'rename-path-1',
        },
        payload: { name: 'Novo nome' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'workspace.archived' });
    } finally {
      await app.close();
    }
  });

  it('rename de workspace ativo com header ativo continua 200', async () => {
    const { app, workspaceStore } = await buildApp();
    try {
      const active = await workspaceStore.create({ authUserId: 'user-1', name: 'Ativo', kind: 'shared' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/workspaces/${active.id}`,
        headers: {
          authorization: 'Bearer token-owner',
          'x-workspace-id': active.id,
          'idempotency-key': 'rename-path-2',
        },
        payload: { name: 'Renomeado' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: active.id, name: 'Renomeado' });
    } finally {
      await app.close();
    }
  });
});
