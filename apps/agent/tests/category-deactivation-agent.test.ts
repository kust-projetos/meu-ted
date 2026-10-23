import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { MutationExecutor } from '../src/mutations/mutation-executor.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';

const CATEGORY_ID = '33333333-3333-4333-8333-333333333333';
const CATEGORY_CANCELADA_ID = '55555555-5555-4555-8555-555555555555';
const identity: AuthenticatedIdentity = { actorId: 'actor-cat-deactivate', workspaceId: 'workspace-cat-deactivate', role: 'member', deviceId: 'device-cat-deactivate' };
const now = Date.parse('2026-10-22T12:00:00Z');
const category = { id: CATEGORY_ID, name: 'QA Viagem Jade', kind: 'expense', status: 'active', householdId: identity.workspaceId };

const harness = (loseFirstProposeResponse = false, categories = [category]) => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[])); return [] as T[];
    },
    transactionSync: <T>(fn: () => T) => fn(),
  };
  initializeMutationDraftSchema(sql as never);
  const store = new SqlMutationDraftStore(sql as never);
  const proposals: Array<{ tool: string; normalizedArgs: unknown; idempotencyKey?: string }> = [];
  const request = vi.fn(async (method: string, path: string, options: unknown) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as { body: { tool: string; normalizedArgs: unknown } }).body;
      const idempotencyKey = (options as { idempotencyKey?: string }).idempotencyKey;
      proposals.push({ ...body, idempotencyKey });
      const id = loseFirstProposeResponse ? 'op-cat-deactivate-committed' : `op-cat-deactivate-${proposals.length}`;
      if (loseFirstProposeResponse && proposals.length === 1) throw new Error('transport lost after API commit');
      return { id, existing: loseFirstProposeResponse, summary: 'desativar categoria', operation: { id, expiresAt: new Date(now + 600_000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { listAccounts: async () => [], listCategories: async () => categories },
    draftStore: store, draftNow: () => now,
    responseProvider: vi.fn(async () => 'modelo não decide categoria'),
    evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
    events: () => undefined,
  });
  return { store, orchestrator, proposals };
};

describe('categories.deactivate conversational manual-only flow', () => {
  it('fresh exact target creates a manual V2 proposal bound to category id and expectedName', async () => {
    const h = harness();
    const result = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'desative a categoria QA Viagem Jade', intentionId: 'cat-deact-fresh' }, identity));
    expect(result.mutation?.status).toBe('proposed');
    expect(result.policy?.authorizationMode).toBe('manual');
    expect(h.proposals[0]).toMatchObject({ tool: 'categories.deactivate', normalizedArgs: { categoryId: CATEGORY_ID, expectedName: 'QA Viagem Jade' } });
  });

  it('bare target fills the durable missing-target draft and proposes only after resolution', async () => {
    const h = harness();
    const first = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'desative a categoria', intentionId: 'cat-deact-fragment' }, identity));
    expect(first.mutation).toBeUndefined();
    expect(h.proposals).toHaveLength(0);
    const second = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'QA Viagem Jade', intentionId: 'cat-deact-target' }, identity));
    expect(second.mutation?.status).toBe('proposed');
    expect(h.proposals[0]?.normalizedArgs).toEqual({ categoryId: CATEGORY_ID, expectedName: 'QA Viagem Jade' });
  });

  it('redelivery after uncertain propose reuses the same idempotency key and operation', async () => {
    const h = harness(true);
    const turn = { text: 'desative categoria QA Viagem Jade', intentionId: 'cat-deact-replay' };
    const first = await h.orchestrator.runTurn(normalizeRestTurn(turn, identity));
    expect(first.mutation).toBeUndefined();
    const replay = await h.orchestrator.runTurn(normalizeRestTurn(turn, identity));
    expect(replay.mutation).toMatchObject({ status: 'proposed', operationId: 'op-cat-deactivate-committed' });
    expect(h.proposals).toHaveLength(2);
    expect(h.proposals[0]?.idempotencyKey).toBeTruthy();
    expect(h.proposals[1]?.idempotencyKey).toBe(h.proposals[0]?.idempotencyKey);
    expect(h.proposals[0]?.normalizedArgs).toEqual(h.proposals[1]?.normalizedArgs);
  });

  it('a category literally named Cancelada is a target, while an exact cancel phrase only discards the incomplete draft', async () => {
    const cancelada = { ...category, id: CATEGORY_CANCELADA_ID, name: 'Cancelada' };
    const h = harness(false, [cancelada]);
    const first = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'desative a categoria', intentionId: 'cat-deact-cancelada-a' }, identity));
    expect(first.mutation).toBeUndefined();
    const second = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'Cancelada', intentionId: 'cat-deact-cancelada-b' }, identity));
    expect(second.mutation?.status).toBe('proposed');
    expect(h.proposals[0]?.normalizedArgs).toEqual({ categoryId: CATEGORY_CANCELADA_ID, expectedName: 'Cancelada' });

    const cancel = harness(false, [category]);
    await cancel.orchestrator.runTurn(normalizeRestTurn({ text: 'desative a categoria', intentionId: 'cat-deact-cancel-c' }, identity));
    const cancelled = await cancel.orchestrator.runTurn(normalizeRestTurn({ text: 'cancele', intentionId: 'cat-deact-cancel-d' }, identity));
    expect(cancelled.mutation).toBeUndefined();
    expect(cancel.proposals).toHaveLength(0);
    expect(cancel.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, now)).toHaveLength(0);
  });

  it('a private missing-target draft is not completed from another private conversation', async () => {
    const h = harness();
    const privateAudience = (conversationId: string) => ({ visibility: 'private' as const, ownerActorId: identity.actorId, conversationId });
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'desative a categoria', intentionId: 'cat-deact-private-a' }, identity, { audience: privateAudience('conv-a') }));
    const other = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'QA Viagem Jade', intentionId: 'cat-deact-private-b' }, identity, { audience: privateAudience('conv-b') }));
    expect(other.mutation).toBeUndefined();
    expect(h.proposals).toHaveLength(0);
    expect(h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null, conversationId: 'conv-a' }, now)).toHaveLength(1);
  });

  it('Agent execution receipt parser binds the pending id, original tool, and category target', async () => {
    const valid = {
      id: 'op-category', status: 'succeeded', execution: {
        status: 'succeeded', operationId: CATEGORY_ID,
        receipt: { mutationId: 'mutation-1', mutationKind: 'categories.deactivate', status: 'succeeded', affectedTargets: ['categories', 'transactions'], operationId: 'op-category', entity: { type: 'category', id: CATEGORY_ID } },
      },
    };
    const executor = new MutationExecutor({ request: vi.fn(async () => valid) as never });
    const input = { operationId: 'op-category', attestation: 'x'.repeat(32), identity: { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! }, expected: { tool: 'categories.deactivate', entityId: CATEGORY_ID } };
    const result = await executor.execute(input);
    expect(result.receipt?.mutationKind).toBe('categories.deactivate');
    const wrong = new MutationExecutor({ request: vi.fn(async () => ({ ...valid, execution: { ...valid.execution, receipt: { ...valid.execution.receipt, entity: { type: 'category', id: 'another-category' } } } })) as never });
    await expect(wrong.execute(input)).rejects.toMatchObject({ message: 'approval.incomplete_result' });
  });
});
