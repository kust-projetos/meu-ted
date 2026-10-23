import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createInMemoryPendingOperationV2Store, type PendingIdentity } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';

const identity: PendingIdentity = { workspaceId: 'ws-outcome', actorId: 'actor-outcome', deviceId: 'device-outcome' };
const readCapability = ['financial.approval.read', 'financial.approval.propose', 'financial.approval.confirm', 'financial.approval.execute'];

const harness = (initialIdentity: PendingIdentity = identity) => {
  const app = Fastify();
  const store = createInMemoryPendingOperationV2Store();
  let current = initialIdentity;
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: current.actorId, workspace: current.workspaceId,
      role: 'owner', capabilities: readCapability, jti: 'j', request: 'r', deviceId: current.deviceId, iat: 1, exp: 301,
    };
    request.authenticatedContext = { householdId: current.workspaceId, actorId: current.actorId, authUserId: current.actorId, actorType: 'user', deviceId: current.deviceId, role: 'owner' };
  });
  registerPendingOperationRoutes(app, {
    resolveToken: async () => ({ householdId: identity.workspaceId, deviceId: identity.deviceId }),
    v2Store: store,
  });
  return { app, store, setIdentity: (next: PendingIdentity) => { current = next; } };
};

describe('GET /pending-operations/v2/:id/outcome', () => {
  it('returns only a canonical terminal success projection, bound to the stored operation and target', async () => {
    const { app, store } = harness();
    const categoryId = crypto.randomUUID();
    const proposal = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'outcome-read-key' },
      payload: { tool: 'categories.deactivate', normalizedArgs: { categoryId, expectedName: 'Jade' } },
    });
    expect(proposal.statusCode).toBe(201);
    const operationId = proposal.json().id as string;
    const confirmed = await store.confirm(operationId, identity);
    await store.execute(confirmed.attestation!, identity, async () => ({ status: 'succeeded', operationId: categoryId }), operationId);

    const response = await app.inject({ method: 'GET', url: `/pending-operations/v2/${operationId}/outcome` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      operationId, status: 'succeeded', tool: 'categories.deactivate',
      expectedContext: { tool: 'categories.deactivate', entityId: categoryId },
      receipt: { operationId, status: 'succeeded', entity: { type: 'category', id: categoryId } },
    });
    for (const forbidden of ['normalizedArgs', 'attestation', 'idempotencyKey', 'proposalHash', 'execution', 'bindings']) {
      expect(response.json()).not.toHaveProperty(forbidden);
    }
    const getForRead = store.getForRead!.bind(store);
    store.getForRead = async (id, scope) => ({ ...(await getForRead(id, scope)), status: 'proposed' });
    const observational = await app.inject({ method: 'GET', url: `/pending-operations/v2/${operationId}/outcome` });
    expect(observational.json()).toEqual({ operationId, tool: 'categories.deactivate', status: 'proposed' });
    store.getForRead = getForRead;
    store.getForRead = async (id, scope) => {
      const record = await getForRead(id, scope);
      const oldReceipt = (record.execution as Record<string, unknown>).receipt as Record<string, unknown>;
      return { ...record, execution: { status: 'succeeded', operationId: categoryId, receipt: { ...oldReceipt, entity: { type: 'transaction', id: categoryId } } } };
    };
    const tampered = await app.inject({ method: 'GET', url: `/pending-operations/v2/${operationId}/outcome` });
    expect(tampered.statusCode).toBe(200);
    expect(tampered.json()).toMatchObject({ operationId, status: 'unverified' });
    expect(tampered.json()).not.toHaveProperty('receipt');
    store.getForRead = async () => { throw new Error('private SQL driver details'); };
    const unavailable = await app.inject({ method: 'GET', url: `/pending-operations/v2/${operationId}/outcome` });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ code: 'approval.outcome_unavailable' });
    await app.close();
  });

  it('requires the existing read capability and does not expose another identity’s operation', async () => {
    const { app } = harness();
    const denied = Fastify();
    denied.addHook('preHandler', async (request) => {
      request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: identity.actorId, workspace: identity.workspaceId, role: 'owner', capabilities: [], jti: 'j', request: 'r', deviceId: identity.deviceId, iat: 1, exp: 301 };
      request.authenticatedContext = { householdId: identity.workspaceId, actorId: identity.actorId, authUserId: identity.actorId, actorType: 'user', deviceId: identity.deviceId, role: 'owner' };
    });
    registerPendingOperationRoutes(denied, { resolveToken: async () => ({ householdId: identity.workspaceId, deviceId: identity.deviceId }), v2Store: createInMemoryPendingOperationV2Store() });
    expect((await denied.inject({ method: 'GET', url: `/pending-operations/v2/${crypto.randomUUID()}/outcome` })).statusCode).toBe(403);
    await denied.close();
    await app.close();
  });

  it('returns only the allowlisted known category-in-use failure', async () => {
    const { app, store } = harness();
    const proposal = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'outcome-in-use-key' },
      payload: { tool: 'categories.deactivate', normalizedArgs: { categoryId: crypto.randomUUID(), expectedName: 'Jade' } },
    });
    const operationId = proposal.json().id as string;
    const confirmed = await store.confirm(operationId, identity);
    await expect(store.execute(confirmed.attestation!, identity, async () => { throw { code: 'in_use', detail: 'sensitive database text' }; }, operationId)).rejects.toThrow();

    const response = await app.inject({ method: 'GET', url: `/pending-operations/v2/${operationId}/outcome` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operationId, tool: 'categories.deactivate', status: 'failed', failureCode: 'in_use' });
    await app.close();
  });

  it('rejects a different actor/device/workspace lookup on the shared store', async () => {
    const { app, store, setIdentity } = harness();
    const proposal = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'outcome-private-key' },
      payload: { tool: 'categories.deactivate', normalizedArgs: { categoryId: crypto.randomUUID(), expectedName: 'private' } },
    });
    const operationId = proposal.json().id as string;
    const confirmed = await store.confirm(operationId, identity);
    await store.execute(confirmed.attestation!, identity, async () => ({ status: 'succeeded', operationId: crypto.randomUUID() }), operationId);

    for (const next of [
      { ...identity, actorId: 'other-actor' },
      { ...identity, deviceId: 'other-device' },
      { ...identity, workspaceId: 'other-workspace' },
    ]) {
      setIdentity(next);
      const response = await app.inject({ method: 'GET', url: `/pending-operations/v2/${operationId}/outcome` });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'approval.forbidden', message: 'Operação pendente fora do workspace do ator.' });
    }
    await app.close();
  });
});
