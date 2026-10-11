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

type FakeOp = Readonly<{ id: string; status: string }>;

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
}): {
  coordinator: PendingOperationCoordinator;
  executeCalls: () => number;
  active: FakeOp[];
} => {
  const active: FakeOp[] = [...options.active];
  const failures = options.failures ?? {};
  const receipts = options.receipts ?? {};
  let executeCalls = 0;
  let listCalls = 0;
  const listActive = async (): Promise<FakeOp[]> => {
    listCalls += 1;
    if (failures.list && listCalls > (failures.listSucceedFirst ?? 0)) throw failures.list;
    return [...active];
  };
  const coordinator = {
    listActive,
    resolveDecisionTarget: async () => {
      // Like the real coordinator: the target resolves from the listing.
      const decidable = (await listActive()).filter((op) => op.status === 'proposed' || op.status === 'confirmed');
      if (decidable.length === 0) return { kind: 'none', operations: [...active], hasActiveDraft: false, hasProposingDraft: false };
      if (decidable.length > 1) return { kind: 'multiple', operations: [...decidable], hasActiveDraft: false, hasProposingDraft: false };
      return { kind: 'single', operation: decidable[0], operations: [...decidable], hasActiveDraft: false, hasProposingDraft: false };
    },
    confirm: async (operationId: string) => {
      executeCalls += 1;
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
          entity: { type: 'transaction', id: `tx-${operationId}` },
          ...(receipts[operationId] ?? {}),
        },
      };
    },
  } as unknown as PendingOperationCoordinator;
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
    const fake = fakeCoordinator({ active: [{ id: 'op-A', status: 'proposed' }] });
    const orchestrator = orchestratorFor(fake.coordinator, store);

    const first = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));
    expect(first.mutation?.status).toBe('succeeded');
    expect(first.mutation?.operationId).toBe('op-A');
    expect(first.mutation?.receipt).toBeTruthy();
    expect(fake.executeCalls()).toBe(1);

    // A is terminal; B is now the single decidable operation.
    fake.active.push({ id: 'op-B', status: 'proposed' });

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
    const fake = fakeCoordinator({ active: [{ id: 'op-A', status: 'proposed' }] });
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
    const fake = fakeCoordinator({ active: [{ id: 'op-A', status: 'proposed' }] });
    const orchestrator = orchestratorFor(fake.coordinator, store);

    const first = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-A' }, IDENTITY));
    expect(first.mutation?.operationId).toBe('op-A');

    fake.active.push({ id: 'op-B', status: 'proposed' });

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
