import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../test-app.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';
import { ROUTE_COVERAGE_IDS, ROUTE_INVENTORY, type RouteInventoryEntry } from '../../src/routes/route-inventory.js';
import { ROUTE_HANDLER_MAP } from '../../src/routes/route-handlers.js';
import type { createBetterAuth } from '../../src/auth/better-auth.js';
import type { InviteService } from '../../src/auth/invites.js';
import type { OwnershipTransferStore } from '../../src/auth/ownership-transfers-postgres.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const pathFor = (entry: RouteInventoryEntry): string => entry.path
  .replace(':householdId', HOUSEHOLD_A)
  .replace(':transferId', UUID)
  .replace(/:id/g, UUID);

const activeSessionAuth = {
  api: { getSession: async () => ({ user: { id: 'auth-member-1', email: 'member@example.test' }, session: { id: 'session-1' } }) },
  options: { baseURL: 'http://localhost:3001', trustedOrigins: [] },
} as unknown as ReturnType<typeof createBetterAuth>;

const missingSessionAuth = {
  api: { getSession: async () => null },
  options: { baseURL: 'http://localhost:3001', trustedOrigins: [] },
} as unknown as ReturnType<typeof createBetterAuth>;

const fakeInviteService = { createInvite: vi.fn(), acceptInvite: vi.fn() } as unknown as InviteService;
const fakeOwnershipTransfers = { create: vi.fn(), accept: vi.fn() } as unknown as OwnershipTransferStore;
const allowInviteCreate = async () => true;

describe('API route authz inventory', () => {
  it('keeps every declared route covered and rejects unrecognized future routes in CI', () => {
    const inventoryIds = ROUTE_INVENTORY.map(({ id }) => id).sort();
    expect(new Set(inventoryIds).size).toBe(inventoryIds.length);
    expect([...ROUTE_COVERAGE_IDS].sort()).toEqual(inventoryIds);
    expect(Object.keys(ROUTE_HANDLER_MAP).sort()).toEqual(inventoryIds);
    expect(Object.values(ROUTE_HANDLER_MAP).every((handler) => handler.startsWith('src/'))).toBe(true);
    const apiRoot = existsSync(resolve(process.cwd(), 'apps/api')) ? resolve(process.cwd(), 'apps/api') : process.cwd();
    expect(Object.values(ROUTE_HANDLER_MAP).every((handler) => {
      const [file, symbol] = handler.split(':');
      return existsSync(resolve(apiRoot, file!)) && new RegExp(`(?:export const|export function|function) ${symbol}\\b`).test(readFileSync(resolve(apiRoot, file!), 'utf8'));
    })).toBe(true);
    expect(ROUTE_INVENTORY.every(({ auth }) => ['public', 'public-denied', 'device', 'workspace', 'session', 'admin', 'internal'].includes(auth))).toBe(true);
  });

  it('declares workspace lifecycle mutations as owner-only session routes', () => {
    expect(ROUTE_INVENTORY.filter(({ id }) => id.startsWith('workspace-lifecycle-'))).toEqual([
      { id: 'workspace-lifecycle-rename', method: 'PATCH', path: '/workspaces/:householdId', auth: 'session', ownership: 'owner' },
      { id: 'workspace-lifecycle-archive', method: 'POST', path: '/workspaces/:householdId/archive', auth: 'session', ownership: 'owner' },
      { id: 'workspace-lifecycle-restore', method: 'POST', path: '/workspaces/:householdId/restore', auth: 'session', ownership: 'owner' },
    ]);
  });

  it.each(ROUTE_INVENTORY.filter(({ auth }) => auth === 'device'))('requires device authentication: $method $path', async (entry) => {
    const testApp = buildTestApp();
    await testApp.app.ready();
    const response = await testApp.app.inject({ method: entry.method as any, url: pathFor(entry) });
    expect(response.statusCode).toBe(401);
    await testApp.app.close();
  });

  it.each(ROUTE_INVENTORY.filter(({ auth }) => auth === 'workspace'))('requires authentication: $method $path', async (entry) => {
    const testApp = entry.path.startsWith('/workspaces/')
      ? buildTestApp({}, undefined, undefined, missingSessionAuth, fakeInviteService, allowInviteCreate, undefined, fakeOwnershipTransfers)
      : buildTestApp();
    await testApp.app.ready();
    const response = await testApp.app.inject({ method: entry.method as any, url: pathFor(entry) });
    expect(response.statusCode).toBe(401);
    await testApp.app.close();
  });

  it.each(ROUTE_INVENTORY.filter(({ ownership }) => ownership === 'membership'))('returns 403 when membership is absent: $method $path', async (entry) => {
    const deniedAccess = { resolve: async () => undefined };
    const testApp = buildTestApp({}, undefined, undefined, activeSessionAuth, undefined, undefined, deniedAccess, fakeOwnershipTransfers);
    await testApp.app.ready();
    const response = await testApp.app.inject({
      method: entry.method as any,
      url: pathFor(entry),
      headers: { 'x-workspace-id': HOUSEHOLD_A },
      payload: { toUserId: 'target' },
    });
    expect(response.statusCode).toBe(403);
    await testApp.app.close();
  });

  it.each(ROUTE_INVENTORY.filter(({ ownership }) => ownership === 'owner'))('returns 403 for non-owner: $method $path', async (entry) => {
    const memberAccess = { resolve: async () => ({ userId: 'member-uuid-1', householdId: HOUSEHOLD_A, role: 'member' as const, kind: 'shared' as const }) };
    const testApp = buildTestApp({}, undefined, undefined, activeSessionAuth, fakeInviteService, async () => false, memberAccess, fakeOwnershipTransfers);
    await testApp.app.ready();
    const payload = entry.path === '/auth/invites'
      ? { householdId: HOUSEHOLD_A, email: 'target@example.test', role: 'member', expiresAt: '2030-01-01T00:00:00.000Z' }
      : entry.path === '/workspaces/:householdId'
        ? { name: 'Renamed workspace' }
      : { toUserId: 'target' };
    const response = await testApp.app.inject({
      method: entry.method as 'POST',
      url: pathFor(entry),
      headers: { 'x-workspace-id': HOUSEHOLD_A },
      payload,
    });
    expect(response.statusCode).toBe(403);
    await testApp.app.close();
  });

  it('keeps public and intentionally disabled routes explicit', async () => {
    const testApp = buildTestApp();
    await testApp.app.ready();
    expect((await testApp.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await testApp.app.inject({ method: 'POST', url: '/auth/devices/register', payload: {} })).statusCode).toBe(403);
    await testApp.app.close();
  });

  it('does not register retired A0 LLM or connection-token consumption routes', async () => {
    const testApp = buildTestApp({}, undefined, undefined, activeSessionAuth, fakeInviteService, allowInviteCreate, { resolve: async () => undefined }, fakeOwnershipTransfers);
    await testApp.app.ready();
    for (const [method, url] of [
      ['POST', '/internal/agent/llm-relay'],
      ['GET', '/internal/agent/llm-config'],
      ['GET', '/admin/agent/llm-config'],
      ['POST', '/auth/agent-token/consume'],
      ['POST', '/internal/agent/consume-token'],
    ] as const) {
      expect(testApp.app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
    }
    await testApp.app.close();
  });

  it.each(ROUTE_INVENTORY.filter(({ auth }) => auth === 'session' || auth === 'admin'))('requires session or admin authentication: $method $path', async (entry) => {
    const testApp = buildTestApp({}, undefined, undefined, missingSessionAuth, fakeInviteService, allowInviteCreate, { resolve: async () => undefined }, fakeOwnershipTransfers);
    await testApp.app.ready();
    const response = await testApp.app.inject({ method: entry.method as 'POST', url: pathFor(entry), payload: { toUserId: 'target' } });
    expect(response.statusCode).toBe(401);
    await testApp.app.close();
  });

  it.each(ROUTE_INVENTORY.filter(({ auth }) => auth === 'internal'))('requires internal token authentication: $method $path', async (entry) => {
    const testApp = buildTestApp();
    await testApp.app.ready();
    const response = await testApp.app.inject({ method: entry.method as 'GET', url: pathFor(entry) });
    expect(response.statusCode).toBe(401);
    await testApp.app.close();
  });
});

describe('route composition invariant (P0.2)', () => {
  const BETTER_AUTH_DEPENDENT_IDS = new Set([
    'auth-provider',
    'auth-invites-create',
    'auth-invites-accept',
    'auth-reconnect',
    'auth-reconnect-token',
    'workspaces-list',
    'workspaces-create',
    'workspace-members-list',
    'workspace-member-remove',
    'workspace-leave',
    'workspace-lifecycle-rename',
    'workspace-lifecycle-archive',
    'workspace-lifecycle-restore',
    'auth-agent-token',
  ]);
  const SAMPLE_ID = '00000000-0000-4000-8000-000000000001';

  it('registers every inventoried route except better-auth-dependent modules (missing dependency)', async () => {
    const { app } = buildTestApp(
      { auditLogs: [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        create: async () => ({ id: 't', householdId: 'h', fromAuthUserId: 'a', toAuthUserId: 'b', status: 'pending', createdAt: new Date().toISOString() }),
        accept: async () => ({ id: 't', householdId: 'h', fromAuthUserId: 'a', toAuthUserId: 'b', status: 'accepted', createdAt: new Date().toISOString(), acceptedAt: new Date().toISOString() }),
      },
    );
    await app.ready();
    const unregistered: string[] = [];
    for (const entry of ROUTE_INVENTORY) {
      if (BETTER_AUTH_DEPENDENT_IDS.has(entry.id)) continue;
      const url = entry.path.replace(/:[A-Za-z0-9_]+/g, SAMPLE_ID);
      const response = await app.inject({ method: entry.method as 'GET', url, payload: {} });
      if (response.statusCode === 404) unregistered.push(`${entry.method} ${entry.path} (${entry.id})`);
    }
    expect(unregistered, `unregistered inventoried routes: ${unregistered.join(', ')}`).toEqual([]);
    await app.close();
  });
});
