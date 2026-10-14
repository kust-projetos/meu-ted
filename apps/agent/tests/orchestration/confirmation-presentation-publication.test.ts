/**
 * PR137-FIX R6 — "testemunho antes da publicação": presentation witnesses
 * must not outlive an unpublished turn.
 *
 * Hole: proposal/disambiguation turns persisted `noteConfirmationPresentation`
 * rows BEFORE returning the response to the channel, with no compensation
 * when the publication failed. Scenario: turn X lists A+B and writes
 * witnesses; the response never publishes; A leaves; a new intention Y lists
 * only B — the entry snapshot + temporal checks admitted B on a testimony
 * whose card was never exhibited, and Y confirmed+executed B.
 *
 * Fix (compensation, option (b)): the orchestrator ledgers exactly the ids
 * THIS turn newly presented (pre-existing rows from earlier published cards
 * are never ledgered — first-presentation-wins), and
 * `revertUnpublishedTurnPresentations()` deletes only those when the caller
 * observes that the response never reached the channel (send/persist failure,
 * post-`runTurn` error, or `runTurn` itself throwing before any response).
 * Rejections write no witness (ROUND5-1), so there is nothing to compensate
 * there.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnPlan,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { PendingOperationCoordinator } from '../../src/orchestration/pending-operation-coordinator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  initializeMutationDraftSchema,
  SqlMutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import { renderInconclusive } from '../../src/responses/deterministic-responses.js';

const IDENTITY: AuthenticatedIdentity = {
  actorId: 'actor-r6',
  workspaceId: 'workspace-r6',
  role: 'member',
  deviceId: 'device-r6',
};

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

type FakeOp = { id: string; status: string; createdAt: string; tool: string };

/** Ops born well before any turn anchor, so the temporal check admits them. */
const op = (id: string): FakeOp => ({
  id,
  status: 'proposed',
  createdAt: '2026-10-11T11:00:00.000Z',
  tool: 'transactions.expense.create',
});

type FakeIdentity = Readonly<{ workspaceId: string; actorId: string; deviceId: string | null }>;

/**
 * Lean coordinator double: resolves the target from the live listing
 * (none/multiple/single) and counts executes. No presentation seeding — the
 * witnesses under test must come from the turn itself.
 */
const fakeCoordinator = (active: FakeOp[]): {
  coordinator: PendingOperationCoordinator;
  executeCalls: () => number;
  active: FakeOp[];
} => {
  let executeCalls = 0;
  const apiIntentions = new Map<string, { firstSeenAt: string }>();
  const apiBindings = new Map<string, string>();
  const intentionKey = (identity: FakeIdentity, intentionId: string): string =>
    `${identity.workspaceId}|${identity.actorId}|${identity.deviceId ?? ''}|${intentionId}`;
  const coordinator = {
    listActive: async (): Promise<FakeOp[]> => [...active],
    resolveDecisionTarget: async () => {
      const decidable = active.filter((item) => item.status === 'proposed' || item.status === 'confirmed');
      if (decidable.length === 0) return { kind: 'none', operations: [...active], hasActiveDraft: false, hasProposingDraft: false };
      if (decidable.length > 1) return { kind: 'multiple', operations: [...decidable], hasActiveDraft: false, hasProposingDraft: false };
      return { kind: 'single', operation: decidable[0], operations: [...decidable], hasActiveDraft: false, hasProposingDraft: false };
    },
    confirm: async (operationId: string, identity?: FakeIdentity, intentionId?: string) => {
      executeCalls += 1;
      if (typeof intentionId === 'string' && intentionId !== '' && identity) {
        const key = intentionKey(identity, intentionId);
        const bound = apiBindings.get(key);
        if (bound !== undefined && bound !== operationId) {
          throw Object.assign(new Error('approval.intention_conflict'), { statusCode: 409, code: 'approval.intention_conflict' });
        }
        if (bound === undefined) apiBindings.set(key, operationId);
      }
      const index = active.findIndex((item) => item.id === operationId);
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
        },
      };
    },
  } as unknown as PendingOperationCoordinator;
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

const orchestratorFor = (coordinator: PendingOperationCoordinator, draftStore: InMemoryMutationDraftStore): ConversationOrchestrator =>
  new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request: async () => { throw new Error('must_not_happen'); } }),
    plan: confirmationPlan,
    coordinator,
    draftStore,
    events: () => {},
  });

describe('PR137-FIX R6 — unpublished presentation witnesses are compensated', () => {
  it('publish failure → A leaves → new intention Y cannot confirm B (0 executes, fail-closed)', async () => {
    const store = new InMemoryMutationDraftStore();
    const fake = fakeCoordinator([op('op-A'), op('op-B')]);
    const orchestrator = orchestratorFor(fake.coordinator, store);

    // Turn X: A+B decidable → disambiguation (no mutation, no execution).
    const x = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-X' }, IDENTITY));
    expect(x.mutation).toBeUndefined();
    expect(x.clarification).toBeTruthy();
    expect(fake.executeCalls()).toBe(0);

    // The witnesses were written pre-publish…
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-A')).toBeTruthy();
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-B')).toBeTruthy();

    // …but the response never reached the channel → compensate.
    orchestrator.revertUnpublishedTurnPresentations();
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-A')).toBeUndefined();
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-B')).toBeUndefined();

    // A leaves; Y is a fresh intention that only ever lists B.
    fake.active.splice(fake.active.findIndex((item) => item.id === 'op-A'), 1);
    const y = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-Y' }, IDENTITY));

    // B was never exhibited to this identity: fail closed, zero executes.
    expect(fake.executeCalls()).toBe(0);
    expect(y.mutation).toBeUndefined();
    expect(y.response?.text).toBe(renderInconclusive());
    expect(fake.active.map((item) => item.id)).toEqual(['op-B']);
  });

  it('published presentation stays confirmable: Z confirms the exhibited B normally', async () => {
    const store = new InMemoryMutationDraftStore();
    const fake = fakeCoordinator([op('op-A'), op('op-B')]);
    const orchestrator = orchestratorFor(fake.coordinator, store);

    // Turn X disambiguates AND publishes (no compensation).
    const x = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-X' }, IDENTITY));
    expect(x.clarification).toBeTruthy();

    // A leaves; Z is a fresh intention whose entry snapshot holds B.
    fake.active.splice(fake.active.findIndex((item) => item.id === 'op-A'), 1);
    const z = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-Z' }, IDENTITY));

    expect(fake.executeCalls()).toBe(1);
    expect(z.mutation?.operationId).toBe('op-B');
    expect(z.mutation?.status).toBe('succeeded');
  });

  it('compensation keeps pre-existing rows: an earlier PUBLISHED card for B survives a later failed turn', async () => {
    const store = new InMemoryMutationDraftStore();
    const fake = fakeCoordinator([op('op-A'), op('op-B')]);
    const orchestrator = orchestratorFor(fake.coordinator, store);

    // B's card was published by an earlier turn (seeded, never ledgered).
    store.noteConfirmationPresentation?.({
      ctx: { ...CTX },
      operationIds: ['op-B'],
      nowMs: Date.parse('2026-10-11T11:00:00.000Z'),
    });

    // Turn X disambiguates [A,B] but never publishes.
    const x = await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'intent-X' }, IDENTITY));
    expect(x.clarification).toBeTruthy();
    orchestrator.revertUnpublishedTurnPresentations();

    // Only this turn's fresh testimony (A) is withdrawn; B's stays.
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-A')).toBeUndefined();
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-B')).toBeTruthy();
  });

  it('SQL store: forgetConfirmationPresentations deletes only the listed ids of the identity', () => {
    const db = new DatabaseSync(':memory:');
    const sql = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
          return statement.all(...(bindings as never[])) as T[];
        }
        statement.run(...(bindings as never[]));
        return [] as T[];
      },
    };
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    const nowMs = Date.parse('2026-10-11T12:00:00.000Z');
    store.noteConfirmationPresentation?.({ ctx: { ...CTX }, operationIds: ['op-A', 'op-B'], nowMs });
    store.noteConfirmationPresentation?.({
      ctx: { ...CTX, deviceId: 'device-other' },
      operationIds: ['op-A'],
      nowMs,
    });

    store.forgetConfirmationPresentations?.({ ...CTX }, ['op-A']);

    expect(store.findConfirmationPresentation({ ...CTX }, 'op-A')).toBeUndefined();
    expect(store.findConfirmationPresentation({ ...CTX }, 'op-B')).toBeTruthy();
    // Another identity's row for the same operation id is untouched.
    expect(store.findConfirmationPresentation({ ...CTX, deviceId: 'device-other' }, 'op-A')).toBeTruthy();
    // Empty + unknown ids are safe no-ops.
    expect(() => store.forgetConfirmationPresentations?.({ ...CTX }, [])).not.toThrow();
    expect(() => store.forgetConfirmationPresentations?.({ ...CTX }, ['op-missing'])).not.toThrow();
  });
});
