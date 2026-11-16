import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import { HOUSEHOLD_A, HOUSEHOLD_B } from '../fixtures/seed.js';

const auth = (token: string) => ({ 'x-device-token': token });

describe('GET /audit-logs — canonical audit capability', () => {
  it('requires authentication', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/audit-logs' });
    expect(response.statusCode).toBe(401);
  });

  it('returns only the authenticated household audit records with filters', async () => {
    const { app } = buildTestApp({
      auditLogs: [
        { id: 'log-a1', workspaceId: HOUSEHOLD_A, actorType: 'device', actorId: 'device-a', operation: 'accounts.create', eventType: 'financial_effect.committed', payloadHash: 'hash-a', effectRef: '00000000-0000-4000-8000-0000000000a1', metadata: { entityType: 'account' }, createdAt: '2026-07-31T12:00:00.000Z' },
        { id: 'log-a2', workspaceId: HOUSEHOLD_A, actorType: 'user', actorId: 'user-a', operation: 'accounts.update', eventType: 'financial_effect.committed', payloadHash: 'hash-b', effectRef: '00000000-0000-4000-8000-0000000000a1', metadata: { entityType: 'account' }, createdAt: '2026-07-31T11:00:00.000Z' },
        { id: 'log-b1', workspaceId: HOUSEHOLD_B, actorType: 'device', actorId: 'device-b', operation: 'accounts.create', eventType: 'financial_effect.committed', payloadHash: 'hash-c', effectRef: '00000000-0000-4000-8000-0000000000b1', metadata: { entityType: 'account' }, createdAt: '2026-07-31T13:00:00.000Z' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/audit-logs?operation=accounts.create&actorType=device&limit=1',
      headers: auth(TOKEN_A),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, items: [{ id: 'log-a1', workspaceId: HOUSEHOLD_A, actorType: 'device', operation: 'accounts.create' }] });

    const entityMatch = await app.inject({ method: 'GET', url: '/audit-logs?entityType=account&entityId=00000000-0000-4000-8000-0000000000a1', headers: auth(TOKEN_A) });
    expect(entityMatch.statusCode).toBe(200);
    expect(entityMatch.json()).toMatchObject({ total: 2, items: [{ id: 'log-a1' }, { id: 'log-a2' }] });

    const entityMiss = await app.inject({ method: 'GET', url: '/audit-logs?entityType=category&entityId=00000000-0000-4000-8000-0000000000a1', headers: auth(TOKEN_A) });
    expect(entityMiss.statusCode).toBe(200);
    expect(entityMiss.json()).toMatchObject({ total: 0, items: [] });
  });

  it('rejects invalid query values', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/audit-logs?limit=101', headers: auth(TOKEN_B) });
    expect(response.statusCode).toBe(400);
  });
});
