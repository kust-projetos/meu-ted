/**
 * PR137-SEC-FIX Fase 1 — confirmation redelivery guards (isolated, seam mocked, no PG).
 *
 * (A) MATERIAL: a replay of A's confirmation (same intentionId) after A went
 * terminal and B became the single decidable operation must NOT confirm+execute
 * B. It must replay A's original success idempotently (same operationId +
 * same receipt), with zero additional execute calls.
 *
 * (B) SEMANTIC: when the confirm+execute path throws after a target was
 * resolved AND the reconciling listing is unreadable, the turn must answer
 * INCONCLUSIVE — the money may have moved, so a definitive `failed` is a
 * false claim.
 *
 * The marker lives in the draft store (durable in prod: SqlMutationDraftStore
 * in the DO SQLite; InMemory here) because the orchestrator is constructed
 * per turn in production — instance memory would never survive a redelivery.
 */
import { describe, expect, it } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnPlan,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { PendingOperationCoordinator } from '../../src/orchestration/pending-operation-coordinator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import {
  renderInconclusive,
  renderMutationResult,
} from '../../src/responses/deterministic-responses.js';

const IDENTITY: AuthenticatedIdentity = {
  actorId: 'actor-redelivery',
  workspaceId: 'workspace-redelivery',
  role: 'member',
  deviceId: 'device-redelivery',
};

const OTHER_IDENTITY: AuthenticatedIdentity = {
  actorId: 'actor-other',
  workspaceId: 'workspace-redelivery',
  role: 'member',
  deviceId: 'device-other',
};

// Review round 4 P1-A3: presentation seeding scope (primary identity).
const CTX: { workspaceId: string; actorId: string; deviceId: string | null } = {
  workspaceId: IDENTITY.workspaceId,
  actorId: IDENTITY.actorId,
  deviceId: IDENTITY.deviceId ?? null,
};

const confirmationPlan = (): TurnPlan => ({
  version: '2',
  mode: 'confirmation',
  domain: 'transactions',
  skillNames: [],
  requestedOperations: [],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

type FakeOp = Readonly<{ id: string; status: string; createdAt?: string; tool?: string }>;

/** Later-appearing ops pushed by tests carry the same authoritative shape (the API always sends `createdAt`/`tool`). */
const laterOp = (id: string): FakeOp => ({ id, status: 'proposed', tool: 'transactions.expense.create', createdAt: '2026-10-11T11:00:00.000Z' });

/** Identity scoping like the real API: a listing only ever shows its own identity's ops. */
type FakeIdentity = Readonly<{ workspaceId: string; actorId: string; deviceId: string | null }>;

const fakeIdentityOf = (identity: { workspaceId: string; actorId: string; deviceId?: string | null }): string =>
  `${identity.workspaceId}\u0000${identity.actorId}\u0000${identity.deviceId ?? ''}`;

/**
 * Minimal coordinator double over an in-memory active set. `confirm`
 * executes exactly once per call (terminal removal + receipt) unless
 * `failures.confirm` is armed; `listActive` throws while `failures.list` is
 * armed. Every execute is counted — the assertions that matter.
 */
const fakeCoordinator = (options: {
  active: FakeOp[];
  failures?: { confirm?: unknown; list?: unknown; listSucceedFirst?: number };
  receipts?: Record<string, Record<string, unknown>>;
  /** Review round 4 P1-A3: pre-present ops (proposal cards shown before the turn). */
  store?: InMemoryMutationDraftStore;
  ctx?: { workspaceId: string; actorId: string; deviceId: string | null };
}): {
  coordinator: PendingOperationCoordinator;
  executeCalls: () => number;
  active: FakeOp[];
} => {
  const active: FakeOp[] = options.active.map((op) => ({
    tool: 'transactions.expense.create',
    createdAt: '2026-10-11T11:00:00.000Z',
    ...op,
  }));
  const failures = options.failures ?? {};
  const receipts = options.receipts ?? {};
  let executeCalls = 0;
  let listCalls = 0;
  // Review round 4 P1-B: API-side intention frontier (per identity).
  const apiIntentions = new Map<string, { firstSeenAt: string }>();
  const apiBindings = new Map<string, string>();
  const intentionKey = (identity: FakeIdentity, intentionId: string): string =>
    `${identity.workspaceId}|${identity.actorId}|${identity.deviceId ?? ''}|${intentionId}`;
  // Review round 4 P1-A3: initial active ops were proposed (card shown)
  // before the turn — seed their presentations at proposal time.
  if (options.store && options.ctx) {
    for (const op of active) {
      const at = Date.parse(op.createdAt ?? '');
      try {
        options.store.noteConfirmationPresentation?.({
          ctx: options.ctx,
          operationIds: [op.id],
          nowMs: Number.isFinite(at) ? at : Date.now(),
        });
      } catch {
        // Best-effort seeding only.
      }
    }
  }
  // Ops are owned by the identity that first listed them (the test's primary
  // identity): a foreign identity lists its own (empty) set, exactly like
  // the authenticated GET /v2/active scoping in production.
  let ownerKey: string | null = null;
  const listActive = async (identity?: FakeIdentity): Promise<FakeOp[]> => {
    listCalls += 1;
    if (failures.list && listCalls > (failures.listSucceedFirst ?? 0)) throw failures.list;
    const key = identity ? fakeIdentityOf(identity) : '';
    if (ownerKey === null && active.length > 0) ownerKey = key;
    if (ownerKey !== null && key !== ownerKey) return [];
    return [...active];
  };
  const coordinator = {
    listActive,
    resolveDecisionTarget: async (identity?: FakeIdentity) => {
      // Like the real coordinator: the target resolves from the listing.
      const decidable = (await listActive(identity)).filter((op) => op.status === 'proposed' || op.status === 'confirmed');
      if (decidable.length === 0) return { kind: 'none', operations: [...active], hasActiveDraft: false, hasProposingDraft: false };
      if (decidable.length > 1) return { kind: 'multiple', operations: [...decidable], hasActiveDraft: false, hasProposingDraft: false };
      return { kind: 'single', operation: decidable[0], operations: [...decidable], hasActiveDraft: false, hasProposingDraft: false };
    },
    confirm: async (operationId: string, identity?: FakeIdentity, intentionId?: string) => {
      executeCalls += 1;
      // Review round 4 P1-B: divergent intention bindings are refused with
      // zero effect (no terminal removal).
      if (typeof intentionId === 'string' && intentionId !== '' && identity) {
        const key = intentionKey(identity, intentionId);
        const bound = apiBindings.get(key);
        if (bound !== undefined && bound !== operationId) {
          throw Object.assign(new Error('approval.intention_conflict'), { statusCode: 409, code: 'approval.intention_conflict' });
        }
        if (bound === undefined) apiBindings.set(key, operationId);
      }
      if (failures.confirm) throw failures.confirm;
      const index = active.findIndex((op) => op.id === operationId);
      if (index >= 0) active.splice(index, 1);
      return {
        operationId,
        status: 'succeeded' as const,
        receipt: {
          operationId,
          mutationId: `mutation-${operationId}`,
          mutationKind: 'transactions.expense.create',
          status: 'succeeded',
          affectedTargets: ['transactions'],
          entity: { type: 'transaction', id: `tx-${operationId}` },
          ...(receipts[operationId] ?? {}),
        },
      };
    },
  } as unknown as PendingOperationCoordinator;
  // Review round 4 P1-B: the pre-listing authoritative bind lives on the
  // coordinator in the orchestrator's call path, so the double carries it.
  (coordinator as unknown as Record<string, unknown>).bindConfirmationIntention = async (
    identity: FakeIdentity,
    intentionId: string,
  ): Promise<{ firstSeenAt: string; fresh: boolean; operationId: string | null }> => {
    const key = intentionKey(identity, intentionId);
    const existing = apiIntentions.get(key);
    if (existing) {
      return { firstSeenAt: existing.firstSeenAt, fresh: false, operationId: apiBindings.get(key) ?? null };
    }
    const at = new Date().toISOString();
    apiIntentions.set(key, { firstSeenAt: at });
    return { firstSeenAt: at, fresh: true, operationId: apiBindings.get(key) ?? null };
  };
  return { coordinator, executeCalls: () => executeCalls, active };
};

const orchestratorFor = (coordinator: PendingOperationCoordinator, draftStore?: InMemoryMutationDraftStore): ConversationOrchestrator =>
  new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request: async () => { throw new Error('must_not_happen'); } }),
    plan: confirmationPlan,
    coordinator,
    ...(draftStore ? { draftStore } : {}),
    events: () => {},
  });

describe('PR137-SEC-FIX (A): confirmation redelivery never confirms a LATER operation', () => {
  it('same identity: replay of A after A terminal + B pending replays A, executes nothing', async () => {
    const store = new InMemoryMutationDraftStore();
    const fake = fakeCoordinator({ active: [{ id: 'op-A', status: 'proposed' }], store, ctx: { ...CTX } });
    const orchestrator = orchestratorFor(fake.coordinator, store);

    const first = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));
    expect(first.mutation?.status).toBe('succeeded');
    expect(first.mutation?.operationId).toBe('op-A');
    expect(first.mutation?.receipt).toBeTruthy();
    expect(fake.executeCalls()).toBe(1);

    // A is terminal; B is now the single decidable operation.
    fake.active.push(laterOp('op-B'));

    const replayed = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));

    // Idempotent replay of the ORIGINAL success — never a second execute, and
    // B stays proposed (untouched, still awaiting its own confirmation).
    expect(fake.executeCalls()).toBe(1);
    expect(replayed.mutation?.status).toBe('succeeded');
    expect(replayed.mutation?.operationId).toBe('op-A');
    expect(replayed.mutation?.receipt).toEqual(first.mutation?.receipt);
    expect(replayed.response?.text).toBe(renderMutationResult('succeeded'));
    expect(fake.active.map((op) => op.id)).toEqual(['op-B']);
  });

  it('cross-actor/device: the marker never leaks across identity contexts', async () => {
    const store = new InMemoryMutationDraftStore();
    const fake = fakeCoordinator({ active: [{ id: 'op-A', status: 'proposed' }], store, ctx: { ...CTX } });
    const orchestrator = orchestratorFor(fake.coordinator, store);

    const first = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));
    expect(first.mutation?.operationId).toBe('op-A');

    // Same intentionId string, but a DIFFERENT actor+device: the listing is
    // empty in that context, so the answer is the no-pending copy — never a
    // replay of somebody else's success.
    const foreign = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, OTHER_IDENTITY));
    expect(fake.executeCalls()).toBe(1);
    expect(foreign.mutation).toBeUndefined();
    expect(foreign.response?.text).toContain('nenhuma operação pendente');
  });

  it('regression: a NEW intentionId still confirms the pending B normally', async () => {
    const store = new InMemoryMutationDraftStore();
    const fake = fakeCoordinator({ active: [{ id: 'op-A', status: 'proposed' }], store, ctx: { ...CTX } });
    const orchestrator = orchestratorFor(fake.coordinator, store);

    const first = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));
    expect(first.mutation?.operationId).toBe('op-A');

    fake.active.push(laterOp('op-B'));
    // B's proposal card was shown when proposed (presented before the fresh
    // intention below), so the new turn may confirm it.
    store.noteConfirmationPresentation?.({
      ctx: { ...CTX },
      operationIds: ['op-B'],
      nowMs: Date.parse('2026-10-11T11:00:00.000Z'),
    });

    const fresh = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-B' }, IDENTITY));
    expect(fake.executeCalls()).toBe(2);
    expect(fresh.mutation?.status).toBe('succeeded');
    expect(fresh.mutation?.operationId).toBe('op-B');
    expect(fake.active).toEqual([]);
  });
});

describe('PR137-SEC-FIX (B): unreadable listing after a resolved target is inconclusive', () => {
  it('execute persisted-or-unknown + listActive throws → inconclusive, mutation undefined', async () => {
    const store = new InMemoryMutationDraftStore();
    // The effect may have landed before the transport failed; the reconciling
    // listing is unreadable, so the turn cannot prove either outcome.
    const transportFailure = Object.assign(new Error('injected_execute_transport_failure'), { statusCode: 502 });
    const listingFailure = new Error('injected_listing_unavailable');
    const fake = fakeCoordinator({
      active: [{ id: 'op-A', status: 'proposed' }],
      failures: { confirm: transportFailure, list: listingFailure, listSucceedFirst: 1 },
      store,
      ctx: { ...CTX },
    });
    const orchestrator = orchestratorFor(fake.coordinator, store);

    const answered = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));

    expect(fake.executeCalls()).toBe(1);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(answered.response?.text).not.toBe(renderMutationResult('failed'));
    expect(answered.response?.text).not.toBe(renderMutationResult('succeeded'));
  });
});
