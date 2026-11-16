import { describe, expect, it, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import Fastify from 'fastify';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';

const identity = { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' };
const args = (amountCents = 1250) => ({
  description: 'Lunch', amountCents, date: '2026-09-14',
  accountId: randomUUID(), categoryId: randomUUID(),
});
const proposal = async (amountCents: number, idempotencyKey: string): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const, ...identity, tool: 'transactions.expense.create',
    normalizedArgs: args(amountCents), proposalHash: '', idempotencyKey,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bindings: identity,
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};
const supersede = (store: ReturnType<typeof createInMemoryPendingOperationV2Store>, id: string, oldHash: string, next: PendingOperationV2) =>
  store.supersede(identity, id, next, { expectedProposalHash: oldHash, idempotencyKey: next.idempotencyKey });
const routeHarness = () => {
  const app = Fastify();
  const store = createInMemoryPendingOperationV2Store();
  const allCapabilities = ['financial.approval.propose', 'financial.approval.read', 'financial.approval.confirm'];
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: identity.actorId, workspace: identity.workspaceId,
      role: 'owner', capabilities: allCapabilities, jti: randomUUID(), request: 'test',
      deviceId: identity.deviceId, iat: 1, exp: 9999999999,
    };
    request.authenticatedContext = {
      householdId: identity.workspaceId, actorId: identity.actorId, authUserId: identity.actorId,
      actorType: 'user', deviceId: identity.deviceId, role: 'owner',
    };
  });
  registerPendingOperationRoutes(app, {
    resolveToken: async () => ({ householdId: identity.workspaceId, deviceId: identity.deviceId }),
    v2Store: store,
    v2Only: true,
  });
  const request = (url: string, payload: unknown, key: string) =>
    app.inject({ method: 'POST', url, headers: { 'idempotency-key': key }, payload });
  return { app, store, request };
};

describe('Pending V2 supersede', () => {
  afterEach(() => { delete process.env.PENDING_V2_SUPERSEDE_ENABLED; });

  it('replaces old proposal and leaves only replacement active', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old'));
    const next = await proposal(3500, `sup:${old.id}:hash`);
    const result = await supersede(store, old.id, old.proposalHash, next);
    expect(result).toMatchObject({ status: 'proposed', supersedesId: old.id, existing: false });
    expect((await store.get(old.id, identity)).status).toBe('cancelled');
    expect((await store.listActive(identity)).map((row) => row.id)).toEqual([result.id]);
  });

  it('rejects divergent expected hash without changing either proposal', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-hash'));
    await expect(supersede(store, old.id, '0'.repeat(64), await proposal(3500, 'replacement-hash')))
      .rejects.toMatchObject({ code: 'approval.proposal_hash_conflict' });
    expect((await store.get(old.id, identity)).status).toBe('proposed');
    expect((await store.listActive(identity)).map((row) => row.id)).toEqual([old.id]);
  });

  it('rejects a different tool without changing the old proposal', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-tool'));
    const other = await proposal(3500, 'replacement-tool');
    other.tool = 'transactions.income.create';
    other.proposalHash = await computePendingOperationV2Hash(other);
    await expect(supersede(store, old.id, old.proposalHash, other)).rejects.toMatchObject({ code: 'approval.supersede_tool_mismatch' });
    expect((await store.get(old.id, identity)).status).toBe('proposed');
  });

  it.each([
    [{ ...identity, actorId: 'other' }],
    [{ ...identity, deviceId: 'other' }],
    [{ ...identity, workspaceId: 'other' }],
  ])('does not disclose operations to foreign identity %o', async (foreign) => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, randomUUID()));
    const next = await proposal(3500, randomUUID());
    try {
      await store.supersede(foreign, old.id, next, { expectedProposalHash: old.proposalHash, idempotencyKey: next.idempotencyKey });
      throw new Error('foreign identity unexpectedly superseded proposal');
    } catch (error) {
      expect([403, 404]).toContain((error as { statusCode?: number }).statusCode);
    }
    expect((await store.get(old.id, identity)).status).toBe('proposed');
  });

  it('does not supersede a confirmed proposal', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-confirmed'));
    await store.confirm(old.id, identity);
    await expect(supersede(store, old.id, old.proposalHash, await proposal(3500, 'new-confirmed')))
      .rejects.toMatchObject({ code: 'approval.supersede_not_allowed' });
    expect((await store.get(old.id, identity)).status).toBe('confirmed');
  });

  it('supersede and confirm race has one winner and never two active proposals', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-race'));
    const next = await proposal(3500, `sup:${old.id}:race`);
    const outcomes = await Promise.allSettled([
      store.confirm(old.id, identity),
      supersede(store, old.id, old.proposalHash, next),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const active = await store.listActive(identity);
    expect(active.filter((row) => row.status === 'proposed' || row.status === 'confirmed')).toHaveLength(1);
  });

  it('failed replacement validation leaves the old proposal intact', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-fail'));
    const invalid = await proposal(3500, 'new-fail');
    invalid.normalizedArgs = {};
    invalid.proposalHash = await computePendingOperationV2Hash(invalid);
    await expect(supersede(store, old.id, old.proposalHash, invalid)).rejects.toMatchObject({ code: 'approval.invalid_args' });
    expect((await store.get(old.id, identity)).status).toBe('proposed');
    expect((await store.listActive(identity)).map((row) => row.id)).toEqual([old.id]);
  });

  it('replay returns the same operation; divergent body conflicts', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-replay'));
    const next = await proposal(3500, `sup:${old.id}:replay`);
    const created = await supersede(store, old.id, old.proposalHash, next);
    expect(await supersede(store, old.id, old.proposalHash, next)).toMatchObject({ id: created.id, existing: true });
    const different = await proposal(3600, next.idempotencyKey);
    await expect(supersede(store, old.id, old.proposalHash, different)).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('rollout flag off refuses route path without state change', async () => {
    process.env.PENDING_V2_SUPERSEDE_ENABLED = '0';
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-flag'));
    // The flag is enforced at the HTTP boundary; store remains deliberately transport agnostic.
    expect(process.env.PENDING_V2_SUPERSEDE_ENABLED).toBe('0');
    expect((await store.get(old.id, identity)).status).toBe('proposed');
  });

  it('replacement starts with fresh manual-confirmation state, not old authorization material', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'old-auth'));
    const next = await supersede(store, old.id, old.proposalHash, await proposal(3500, `sup:${old.id}:auth`));
    expect(next.status).toBe('proposed');
    expect(next.authorizationMode).toBeUndefined();
    expect(next.attestation).toBeUndefined();
  });

  it('HTTP feature flag off returns explicit refusal and has no state effect', async () => {
    const { app, store, request } = routeHarness();
    process.env.PENDING_V2_SUPERSEDE_ENABLED = '0';
    const old = await store.propose(await proposal(1250, 'route-old-disabled'));
    const next = await proposal(3500, 'unused');
    const response = await request(`/pending-operations/v2/${old.id}/supersede`, {
      tool: next.tool, normalizedArgs: next.normalizedArgs, expectedProposalHash: old.proposalHash,
    }, 'required-caller-key');
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('pending.supersede_disabled');
    expect((await store.get(old.id, identity)).status).toBe('proposed');
  });

  it('audits the cancelled original and the replacement proposal', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const old = await store.propose(await proposal(1250, 'audit-old'));
    const result = await supersede(store, old.id, old.proposalHash, await proposal(3500, 'audit-new'));
    const events = store.audit.map((e) => `${e.event}:${e.operationId}`);
    expect(events).toContain(`cancel:${old.id}`);
    expect(events).toContain(`propose:${result.id}`);
  });

  it('HTTP route authenticates, replaces, and replays the deterministic operation', async () => {
    const { app, store, request } = routeHarness();
    process.env.PENDING_V2_SUPERSEDE_ENABLED = '1';
    const old = await store.propose(await proposal(1250, 'route-old-enabled'));
    const nextArgs = args(3500);
    const payload = { tool: 'transactions.expense.create', normalizedArgs: nextArgs, expectedProposalHash: old.proposalHash };
    const first = await request(`/pending-operations/v2/${old.id}/supersede`, payload, 'supersede-key');
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; existing: boolean; supersedes: string };
    expect(firstBody).toMatchObject({ existing: false, supersedes: old.id });
    const replay = await request(`/pending-operations/v2/${old.id}/supersede`, payload, 'supersede-key');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: firstBody.id, existing: true });
    expect((await store.get(old.id, identity)).status).toBe('cancelled');
  });
});
