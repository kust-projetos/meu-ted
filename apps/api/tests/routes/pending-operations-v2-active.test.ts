import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryPendingOperationV2Store,
  type PendingIdentity,
} from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const expenseArgs = () => ({
  description: 'Mercado semanal',
  amountCents: 8500,
  date: '2026-09-14',
  accountId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
});

const READ = 'financial.approval.read';
const ALL = [
  'financial.approval.propose',
  READ,
  'financial.approval.confirm',
  'financial.approval.execute',
  'financial.approval.retry',
  'financial.approval.cancel',
];

const scopedApp = (
  identity: { workspace: string; actor: string; device: string },
  capabilities: string[] = ALL,
  opts: { executor?: (operation: never) => Promise<unknown> } = {},
) => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: identity.actor, workspace: identity.workspace,
      role: 'owner', capabilities, jti: crypto.randomUUID(), request: 'r',
      deviceId: identity.device, iat: 1, exp: 301,
    };
    request.authenticatedContext = {
      householdId: identity.workspace, actorId: identity.actor, authUserId: identity.actor,
      actorType: 'user', deviceId: identity.device, role: 'owner',
    };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }),
    v2Store,
    v2Only: true,
    ...(opts.executor ? { v2Executor: opts.executor } : {}),
  });
  return { app, v2Store };
};

const proposeExpense = (app: ReturnType<typeof scopedApp>['app'], key: string, args = expenseArgs()) =>
  app.inject({
    method: 'POST', url: '/pending-operations/v2/propose',
    headers: { 'idempotency-key': key },
    payload: { tool: 'transactions.expense.create', normalizedArgs: args },
  });

describe('GET /pending-operations/v2/active (SPEC §8.3)', () => {
  it('projects only persisted category in_use on failed category deactivation, with a lean HTTP DTO', async () => {
    const id = { workspace: 'ws-in-use-http', actor: 'actor-in-use-http', device: 'device-in-use-http' };
    const { app, v2Store } = scopedApp(id);
    const identity: PendingIdentity = { workspaceId: id.workspace, actorId: id.actor, deviceId: id.device };
    const categoryId = crypto.randomUUID();
    const proposed = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose', headers: { 'idempotency-key': 'category-in-use-http' },
      payload: { tool: 'categories.deactivate', normalizedArgs: { categoryId, expectedName: 'QA category' } },
    });
    expect(proposed.statusCode).toBe(201);
    const proposalId = proposed.json().id as string;
    const confirmed = await v2Store.confirm(proposalId, identity);
    await expect(v2Store.execute(confirmed.attestation!, identity, async () => { throw { code: 'in_use' }; }, proposalId)).rejects.toThrow();

    // Use the real persisted in-memory record as the source; derive malformed
    // and mismatched DTO variants only to exercise the route's projection gate.
    const persisted = (await v2Store.listActive(identity)).find((item) => item.id === proposalId)!;
    expect(persisted).toMatchObject({ status: 'failed', tool: 'categories.deactivate', failureCode: 'in_use' });
    const variants = [
      { ...persisted, id: 'other-tool', tool: 'transactions.expense.create' },
      { ...persisted, id: 'category-proposed', status: 'proposed' },
      { ...persisted, id: 'category-confirmed', status: 'confirmed' },
      { ...persisted, id: 'category-executing', status: 'executing' },
      { ...persisted, id: 'category-other-failure', failureCode: 'executor.failed' },
      { ...persisted, id: 'category-malformed-code', failureCode: 'in_use\nattestation=secret' },
    ];
    const storeListActive = v2Store.listActive.bind(v2Store);
    v2Store.listActive = async (scope) => scope.workspaceId === id.workspace && scope.actorId === id.actor && scope.deviceId === id.device
      ? [persisted, ...variants] : [];

    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(200);
    const { items } = response.json() as { items: Array<Record<string, unknown>> };
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(proposalId)).toHaveProperty('failureCode', 'in_use');
    for (const record of variants) expect(byId.get(record.id)).not.toHaveProperty('failureCode');
    const allowedKeys = new Set(['id', 'status', 'tool', 'createdAt', 'expiresAt', 'categoryId', 'presentation', 'failureCode']);
    for (const item of items) {
      expect(Object.keys(item).every((key) => allowedKeys.has(key))).toBe(true);
      for (const forbidden of ['normalizedArgs', 'attestation', 'attestationHash', 'proposalHash', 'idempotencyKey', 'execution', 'bindings']) {
        expect(item).not.toHaveProperty(forbidden);
      }
    }
    const outsider = await app.inject({ method: 'GET', url: '/pending-operations/v2/active', headers: { 'x-agent-workspace': 'other' } });
    // Identity remains server-derived; an attempted header override cannot alter the scoped result.
    expect(outsider.json().items).toHaveLength(items.length);
    v2Store.listActive = storeListActive;
  });

  it('lists the proposed operation with lean disambiguation fields', async () => {
    const id = { workspace: 'ws-a', actor: 'actor-a', device: 'device-a' };
    const { app } = scopedApp(id);
    const args = expenseArgs();
    const created = await proposeExpense(app, 'active-key-1', args);
    expect(created.statusCode).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.status).toBe('proposed');
    expect(item.tool).toBe('transactions.expense.create');
    expect(item.amountCents).toBe(args.amountCents);
    expect(item.description).toBe(args.description);
    expect(item.date).toBe(args.date);
    expect(item.accountId).toBe(args.accountId);
    expect(typeof item.id).toBe('string');
    expect(typeof item.createdAt).toBe('string');
    expect(typeof item.expiresAt).toBe('string');
    // Never leaks authority material.
    expect(item).not.toHaveProperty('attestation');
    expect(item).not.toHaveProperty('attestation_hash');
    expect(item).not.toHaveProperty('normalizedArgs');
  });

  it('isolates by workspace, actor and device from the authenticated identity', async () => {
    const owner = { workspace: 'ws-iso', actor: 'actor-a', device: 'device-a' };
    const { app } = scopedApp(owner);
    expect((await proposeExpense(app, 'iso-key-1')).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(1);

    const otherActor = scopedApp({ workspace: 'ws-iso', actor: 'actor-b', device: 'device-a' });
    // Separate app instance, same store? No — isolation must also hold on the
    // same store. Re-register on the same store via a second fastify instance
    // is complex; instead assert store-level binding directly plus route-level
    // cross-identity returns empty on its own (empty) store.
    expect((await otherActor.app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(0);
    const otherDevice = scopedApp({ workspace: 'ws-iso', actor: 'actor-a', device: 'device-b' });
    expect((await otherDevice.app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(0);
    const otherWorkspace = scopedApp({ workspace: 'ws-other', actor: 'actor-a', device: 'device-a' });
    expect((await otherWorkspace.app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(0);
  });

  it('scopes strictly by authenticated identity on a shared store', async () => {
    // Same store, two identities: the listing must never cross the boundary.
    const app = Fastify();
    const v2Store = createInMemoryPendingOperationV2Store();
    let current = { workspace: 'ws-shared', actor: 'actor-a', device: 'device-a' };
    app.addHook('preHandler', async (request) => {
      request.delegatedTurn = {
        iss: 'pi-agent', aud: 'pi-finance-api', sub: current.actor, workspace: current.workspace,
        role: 'owner', capabilities: ALL, jti: crypto.randomUUID(), request: 'r',
        deviceId: current.device, iat: 1, exp: 301,
      };
      request.authenticatedContext = {
        householdId: current.workspace, actorId: current.actor, authUserId: current.actor,
        actorType: 'user', deviceId: current.device, role: 'owner',
      };
    });
    registerPendingOperationRoutes(app, {
      store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store, v2Only: true,
    });

    expect((await proposeExpense(app, 'shared-key-1')).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(1);

    current = { workspace: 'ws-shared', actor: 'actor-b', device: 'device-a' };
    expect((await app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(0);
    current = { workspace: 'ws-shared', actor: 'actor-a', device: 'device-other' };
    expect((await app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(0);
    current = { workspace: 'ws-elsewhere', actor: 'actor-a', device: 'device-a' };
    expect((await app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(0);
  });

  it('includes confirmed and failed operations but hides terminal states', async () => {
    const id = { workspace: 'ws-states', actor: 'actor-a', device: 'device-a' };
    const { app, v2Store } = scopedApp(id);
    const identity: PendingIdentity = { workspaceId: id.workspace, actorId: id.actor, deviceId: id.device };

    expect((await proposeExpense(app, 'states-proposed')).statusCode).toBe(201);
    expect((await proposeExpense(app, 'states-confirmed')).statusCode).toBe(201);
    expect((await proposeExpense(app, 'states-failed')).statusCode).toBe(201);
    expect((await proposeExpense(app, 'states-cancelled')).statusCode).toBe(201);

    const listed = await v2Store.listActive(identity);
    const byKey = new Map(listed.map((record) => [record.idempotencyKey, record]));
    const confirmed = await v2Store.confirm(byKey.get('states-confirmed')!.id, identity);
    expect(confirmed.status).toBe('confirmed');
    // failed via a throwing executor (store-level, keeps the route test fast).
    const failedTarget = byKey.get('states-failed')!.id;
    const failedAttestation = (await v2Store.confirm(failedTarget, identity)).attestation!;
    await expect(
      v2Store.execute(failedAttestation, identity, async () => { throw new Error('executor.boom'); }),
    ).rejects.toThrow();
    await v2Store.cancel(byKey.get('states-cancelled')!.id, identity);

    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ id: string; status: string }>; total: number };
    const statuses = new Map(body.items.map((item) => [item.id, item.status]));
    expect(statuses.get(byKey.get('states-proposed')!.id)).toBe('proposed');
    expect(statuses.get(confirmed.id)).toBe('confirmed');
    expect(statuses.get(failedTarget)).toBe('failed');
    expect(body.total).toBe(3);
  });

  it('requires the read capability', async () => {
    const id = { workspace: 'ws-cap', actor: 'actor-a', device: 'device-a' };
    const { app } = scopedApp(id, ['financial.approval.propose']);
    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('auth.delegation_scope_forbidden');
  });

  it('returns an empty listing when nothing is pending', async () => {
    const { app } = scopedApp({ workspace: 'ws-empty', actor: 'actor-a', device: 'device-a' });
    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], total: 0 });
  });
});
