import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { createBetterAuth } from '../../src/auth/better-auth.js';
import { createInMemoryWorkspaceStore, registerWorkspaceRoutes, WorkspaceError, type WorkspaceStore } from '../../src/auth/workspaces-http.js';

const auth = {
  api: {
    getSession: async () => ({
      user: { id: 'auth-user-1', email: 'owner@example.com' },
      session: { id: 'session-1' },
    }),
  },
} as unknown as ReturnType<typeof createBetterAuth>;

const makeStore = (): WorkspaceStore => ({
  list: vi.fn<WorkspaceStore['list']>(async () => [{ id: 'workspace-1', name: 'Casa', kind: 'shared', role: 'owner', status: 'active' }]),
  create: vi.fn<WorkspaceStore['create']>(async () => ({ id: 'workspace-2', name: 'Equipe', kind: 'shared', role: 'owner', status: 'active' })),
  listMembers: vi.fn<WorkspaceStore['listMembers']>(async () => [{ userId: 'user-2', name: 'Ana', email: 'ana@example.com', role: 'member', status: 'active' }]),
  removeMember: vi.fn<WorkspaceStore['removeMember']>(async () => undefined),
  leave: vi.fn<WorkspaceStore['leave']>(async () => undefined),
});

describe('workspace management HTTP', () => {
  it('keeps the in-memory workspace fallback scoped to the authenticated owner', async () => {
    const store = createInMemoryWorkspaceStore();
    const first = await store.create({ authUserId: 'auth-user-1', name: 'Casa', kind: 'personal' });
    await store.create({ authUserId: 'auth-user-2', name: 'Outra casa', kind: 'personal' });

    expect((await store.list('auth-user-1')).map((workspace) => workspace.id)).toEqual([first.id]);
    await expect(store.rename({ authUserId: 'auth-user-2', householdId: first.id, name: 'Invasão' })).rejects.toMatchObject({
      code: 'workspace.forbidden',
      statusCode: 403,
    });
  });

  it('lists and creates workspaces from the Better Auth session', async () => {
    const app = Fastify({ logger: false });
    const store = makeStore();
    registerWorkspaceRoutes(app, { auth, store });
    await app.ready();

    const list = await app.inject({ method: 'GET', url: '/workspaces' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [{ id: 'workspace-1', name: 'Casa', kind: 'shared', role: 'owner', status: 'active' }], total: 1 });
    expect(store.list).toHaveBeenCalledWith('auth-user-1');

    const created = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { 'idempotency-key': 'create-1' },
      payload: { name: 'Equipe', kind: 'shared' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'workspace-2', kind: 'shared' });
    expect(store.create).toHaveBeenCalledWith({ authUserId: 'auth-user-1', name: 'Equipe', kind: 'shared' });
    await app.close();
  });

  it('lists members and allows owners to remove a member or leave', async () => {
    const app = Fastify({ logger: false });
    const store = makeStore();
    registerWorkspaceRoutes(app, { auth, store });
    await app.ready();

    const members = await app.inject({ method: 'GET', url: '/workspaces/00000000-0000-4000-8000-000000000001/members' });
    expect(members.statusCode).toBe(200);
    // Regression (item 9): members list must be a paged list contract
    // ({ items, total }) with role + status per member — the PWA client
    // requires `total` and renders the status badge.
    expect(members.json()).toEqual({
      items: [{ userId: 'user-2', name: 'Ana', email: 'ana@example.com', role: 'member', status: 'active' }],
      total: 1,
    });
    expect(store.listMembers).toHaveBeenCalledWith({ authUserId: 'auth-user-1', householdId: '00000000-0000-4000-8000-000000000001' });

    const removed = await app.inject({ method: 'DELETE', url: '/workspaces/00000000-0000-4000-8000-000000000001/members/00000000-0000-4000-8000-000000000002', headers: { 'idempotency-key': 'remove-1' } });
    expect(removed.statusCode).toBe(204);
    expect(store.removeMember).toHaveBeenCalledWith({ authUserId: 'auth-user-1', householdId: '00000000-0000-4000-8000-000000000001', memberUserId: '00000000-0000-4000-8000-000000000002' });

    const left = await app.inject({ method: 'POST', url: '/workspaces/00000000-0000-4000-8000-000000000001/leave', headers: { 'idempotency-key': 'leave-1' } });
    expect(left.statusCode).toBe(204);
    expect(store.leave).toHaveBeenCalledWith({ authUserId: 'auth-user-1', householdId: '00000000-0000-4000-8000-000000000001' });
    await app.close();
  });

  it('returns 403 for an authenticated non-member on every targeted workspace metadata mutation/read', async () => {
    const app = Fastify({ logger: false });
    const store = makeStore();
    const forbidden = new WorkspaceError('workspace.forbidden', 403, 'active workspace membership required');
    vi.mocked(store.listMembers).mockRejectedValue(forbidden);
    vi.mocked(store.removeMember).mockRejectedValue(forbidden);
    vi.mocked(store.leave).mockRejectedValue(forbidden);
    registerWorkspaceRoutes(app, { auth, store });
    await app.ready();
    const workspace = '00000000-0000-4000-8000-000000000001';

    const members = await app.inject({ method: 'GET', url: `/workspaces/${workspace}/members` });
    const remove = await app.inject({ method: 'DELETE', url: `/workspaces/${workspace}/members/user-2`, headers: { 'idempotency-key': 'remove-forbidden-1' } });
    const leave = await app.inject({ method: 'POST', url: `/workspaces/${workspace}/leave`, headers: { 'idempotency-key': 'leave-forbidden-1' } });
    expect(members.statusCode).toBe(403);
    expect(remove.statusCode).toBe(403);
    expect(leave.statusCode).toBe(403);
    expect(store.listMembers).toHaveBeenCalled();
    expect(store.removeMember).toHaveBeenCalled();
    expect(store.leave).toHaveBeenCalled();
    await app.close();
  });

  it('requires a session before exposing workspace metadata', async () => {
    const app = Fastify({ logger: false });
    const store = makeStore();
    const noSession = { api: { getSession: async () => null } } as unknown as ReturnType<typeof createBetterAuth>;
    registerWorkspaceRoutes(app, { auth: noSession, store });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/workspaces' });
    expect(response.statusCode).toBe(401);
    expect(store.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('renames and toggles workspace lifecycle with an idempotency key', async () => {
    const app = Fastify({ logger: false });
    const store = {
      ...makeStore(),
      rename: vi.fn(async () => ({ id: 'workspace-1', name: 'Novo nome', kind: 'shared' as const, role: 'owner' as const, status: 'active' as const })),
      setStatus: vi.fn(async (_input: unknown) => ({ id: 'workspace-1', name: 'Novo nome', kind: 'shared' as const, role: 'owner' as const, status: 'archived' as const })),
    };
    registerWorkspaceRoutes(app, { auth, store });
    await app.ready();

    const missingKey = await app.inject({
      method: 'PATCH',
      url: '/workspaces/00000000-0000-4000-8000-000000000001',
      payload: { name: 'Novo nome' },
    });
    expect(missingKey.statusCode).toBe(400);

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/workspaces/00000000-0000-4000-8000-000000000001',
      headers: { 'idempotency-key': 'rename-1' },
      payload: { name: 'Novo nome' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Novo nome', status: 'active' });
    expect(store.rename).toHaveBeenCalledWith({
      authUserId: 'auth-user-1',
      householdId: '00000000-0000-4000-8000-000000000001',
      name: 'Novo nome',
    });

    const replayed = await app.inject({
      method: 'PATCH',
      url: '/workspaces/00000000-0000-4000-8000-000000000001',
      headers: { 'idempotency-key': 'rename-1' },
      payload: { name: 'Novo nome' },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(store.rename).toHaveBeenCalledTimes(1);

    const conflict = await app.inject({
      method: 'PATCH',
      url: '/workspaces/00000000-0000-4000-8000-000000000001',
      headers: { 'idempotency-key': 'rename-1' },
      payload: { name: 'Outro nome' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(store.rename).toHaveBeenCalledTimes(1);

    const archived = await app.inject({
      method: 'POST',
      url: '/workspaces/00000000-0000-4000-8000-000000000001/archive',
      headers: { 'idempotency-key': 'archive-1' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: 'archived' });
    expect(store.setStatus).toHaveBeenCalledWith({
      authUserId: 'auth-user-1',
      householdId: '00000000-0000-4000-8000-000000000001',
      status: 'archived',
    });
    await app.close();
  });

  it('rejects lifecycle mutations from a non-owner workspace member', async () => {
    const app = Fastify({ logger: false });
    const store = {
      ...makeStore(),
      rename: vi.fn(async () => ({ id: 'workspace-1', name: 'Novo nome', kind: 'shared' as const, role: 'owner' as const, status: 'active' as const })),
      setStatus: vi.fn(async () => ({ id: 'workspace-1', name: 'Casa', kind: 'shared' as const, role: 'owner' as const, status: 'archived' as const })),
    };
    const memberAccess = {
      resolve: async () => ({
        userId: 'user-1',
        householdId: '00000000-0000-4000-8000-000000000001',
        role: 'member' as const,
        kind: 'shared' as const,
      }),
    };
    registerWorkspaceRoutes(app, { auth, store, workspaceAccess: memberAccess });
    await app.ready();
    const workspace = '00000000-0000-4000-8000-000000000001';

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/workspaces/${workspace}`,
      headers: { 'idempotency-key': 'rename-member-1', 'x-workspace-id': workspace },
      payload: { name: 'Tentativa' },
    });
    const archived = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspace}/archive`,
      headers: { 'idempotency-key': 'archive-member-1', 'x-workspace-id': workspace },
    });

    expect(renamed.statusCode).toBe(403);
    expect(archived.statusCode).toBe(403);
    expect(store.rename).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it('R3 item 1 (HIGH atestação): agentAttestation forjada no body é recusada (409, sem efeito)', async () => {
    const app = Fastify({ logger: false });
    // Segredo explícito de teste (nunca default embutido; sem ele a
    // emissão/verificação recusam fail-closed — sem depender de env).
    const store = createInMemoryWorkspaceStore(undefined, { deletionHmacSecret: 'test-only-workspace-deletion-hmac-secret' });
    registerWorkspaceRoutes(app, { auth, store });
    await app.ready();

    const created = await store.create({ authUserId: 'auth-user-1', name: 'Vazio', kind: 'shared' });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: created.id });
    expect(inventory.empty).toBe(true);

    // String 'verified-empty' declarada pelo cliente, sem prova server-side:
    // indistinguível de falsificação — recusada com 409 dedicado.
    const forged = await app.inject({
      method: 'DELETE',
      url: `/workspaces/${created.id}`,
      headers: { 'idempotency-key': 'delete-forged-1' },
      payload: {
        confirmation: {
          workspaceId: created.id,
          action: 'workspace.delete',
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
          agentAttestation: 'verified-empty',
        },
      },
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json()).toMatchObject({ code: 'workspace.agent_unverified' });
    // Sem efeito: workspace segue listado e ativo.
    expect((await store.list('auth-user-1')).map((w) => w.id)).toContain(created.id);
    await app.close();
  });
});
