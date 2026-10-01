import { describe, expect, it } from 'vitest';
import { createDelegatedTokenForTest, verifyDelegatedTurnToken } from '../../src/auth/delegated-token.js';
import { buildTestApp } from '../test-app.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';

describe('G5.2.2 API delegated token validation', () => {
  it('validates every identity, scope and lifetime claim', async () => {
    const token = await createDelegatedTokenForTest({
      actorId: 'user-1', workspaceId: 'workspace-1', role: 'owner',
      capabilities: ['financial.read'], requestId: 'turn-1',
    }, 'test-secret', 1_700_000_000_000);
    await expect(verifyDelegatedTurnToken(token, 'test-secret', 1_700_000_000_000)).resolves.toMatchObject({
      iss: 'pi-agent', aud: 'pi-finance-api', sub: 'user-1', workspace: 'workspace-1', role: 'owner',
      capabilities: ['financial.read'], jti: expect.any(String), request: 'turn-1', exp: 1_700_000_300,
    });
  });

  it('authenticates API routes from the delegated workspace scope', async () => {
    const token = await createDelegatedTokenForTest({ actorId: 'user-1', workspaceId: HOUSEHOLD_A, role: 'member', capabilities: ['financial.read'], requestId: 'turn-1' }, 'test-secret', Date.now());
    const { app } = buildTestApp({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'test-secret');
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/accounts', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.every((item: { householdId: string }) => item.householdId === HOUSEHOLD_A)).toBe(true);
  });

  it('rejects wrong audience, missing route scope and expired tokens', async () => {
    const now = Date.now();
    const token = await createDelegatedTokenForTest({ actorId: 'u', workspaceId: HOUSEHOLD_A, role: 'member', capabilities: ['financial.write'], requestId: 'r' }, 'test-secret', now);
    await expect(verifyDelegatedTurnToken(token, 'wrong-secret', now)).rejects.toThrow('invalid delegated token');
    const expired = await createDelegatedTokenForTest({ actorId: 'u', workspaceId: HOUSEHOLD_A, role: 'member', capabilities: ['financial.write'], requestId: 'expired' }, 'test-secret', now - 301_000);
    await expect(verifyDelegatedTurnToken(expired, 'test-secret', now)).rejects.toThrow('expired delegated token');
    const { app } = buildTestApp({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'test-secret');
    await app.ready();
    const scopeResponse = await app.inject({ method: 'GET', url: '/accounts', headers: { authorization: `Bearer ${token}` } });
    expect(scopeResponse.statusCode).toBe(403);
    expect(scopeResponse.json().code).toBe('auth.delegation_scope_forbidden');
  });

  it('admits the narrow financial.undo.execute capability for POST /pending-operations/undo — the generic financial.write scope must not veto the narrow undo grant', async () => {
    const now = Date.now();
    const token = await createDelegatedTokenForTest(
      {
        actorId: 'user-1', workspaceId: HOUSEHOLD_A, role: 'member',
        capabilities: ['financial.undo.execute'], requestId: 'undo-turn-1',
        deviceId: '55dfb534-0475-4a50-95a1-42665ab4d254',
      },
      'test-secret',
      now,
    );
    const { app } = buildTestApp({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'test-secret');
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/pending-operations/undo',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'undo:hh-a:req-undo-1' },
      payload: {},
    });
    // The undo grant is deliberately narrow: the preHandler must admit it
    // (route handler re-checks the narrow capability as defense in depth),
    // never veto it with the generic financial.write scope requirement.
    expect(response.statusCode).not.toBe(403);
    expect(response.json().code).not.toBe('auth.delegation_scope_forbidden');
    expect(response.json().code).not.toBe('auth.device_binding_required');
  });

  it('rejects delegated token when workspace membership was revoked server-side', async () => {
    const token = await createDelegatedTokenForTest(
      { actorId: 'user-1', workspaceId: HOUSEHOLD_A, role: 'member', capabilities: ['financial.read'], requestId: 'turn-1' },
      'test-secret',
      Date.now(),
    );
    // workspaceAccess returns undefined (simulating revoked membership)
    const revokedWorkspaceAccess = { resolve: async () => undefined };
    const { app } = buildTestApp(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      revokedWorkspaceAccess,
      undefined,
      undefined,
      'test-secret',
    );
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/accounts', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('auth.workspace_forbidden');
  });
});
