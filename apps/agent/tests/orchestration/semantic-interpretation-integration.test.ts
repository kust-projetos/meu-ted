import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { routeIntent } from '../../src/orchestration/intent-router.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { buildDraftRecord, InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import { TurnBudget } from '../../src/orchestration/turn-budget.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';
import { hasExplicitMutationIntent } from '../../src/safety/tool-approvals.js';

/**
 * A06 / SPEC R06 (AC12): the informal utterance travels the SAME pipeline as a
 * well-formed one — router → authoritative entity resolution → proposal. The
 * turn stays a proposal/confirmation turn: no authorization is inferred.
 */

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const CATEGORY_CARNE = { id: '00000000-0000-4000-8000-000000000011', name: 'Carne' };

const mutationPlan = () => ({
  version: '2' as const,
  mode: 'mutation-proposal' as const,
  domain: 'transactions' as const,
  skillNames: ['transactions'],
  requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' as const }],
  missingFields: [] as readonly string[],
  ambiguity: null,
  confidence: 1,
});

const reader = (accounts: { id: string; name: string }[], categories: { id: string; name: string }[]): EntityReader => ({
  listAccounts: async () => accounts,
  listCategories: async () => categories,
});

const mockProposeClient = () => {
  const request = vi.fn().mockImplementation(async (method: string, path: string) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'pending-1' };
    throw new Error(`unexpected request ${method} ${path}`);
  });
  return { api: new MutationApiClient({ request }), request };
};

const proposedArgs = (request: ReturnType<typeof mockProposeClient>['request']): Record<string, unknown> => {
  const body = request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } } | undefined;
  return body?.body?.normalizedArgs ?? {};
};

describe('A06/R06 AC12 — informal utterance walks the existing proposal pipeline', () => {
  it('proposes 5.000 cents / "carne" resolved against the real Nubank account', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gstei 50 d carne hj no nubnk', intentionId: 'intent-ac12' }, identity),
    );

    expect(result.mutation?.status).toBe('proposed');
    expect(proposedArgs(request)).toMatchObject({
      amountCents: 5000,
      description: 'carne',
      accountId: ACCOUNT_NUBANK.id,
      categoryId: CATEGORY_CARNE.id,
    });
  });

  it('resolves the relative date from the message instant in the workspace timezone', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    });
    const before = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gstei 50 d carne hj no nubnk', intentionId: 'intent-ac12-date' }, identity),
    );
    const after = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

    expect(result.mutation?.status).toBe('proposed');
    expect([before, after]).toContain(proposedArgs(request).date);
  });

  it('infers no authorization: the turn is a proposal awaiting confirmation', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gstei 50 d carne hj no nubnk', intentionId: 'intent-ac12-auth' }, identity),
    );

    expect(result.policy.writeAuthorized).toBe(false);
    expect(result.policy.approvalRequired).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('POST');
    expect(request.mock.calls[0]?.[1]).toBe('/pending-operations/v2/propose');
    // V5 eligibility is untouched: an abbreviated narrative is not a mutation
    // imperative, so nothing may execute on the strength of the interpretation.
    expect(hasExplicitMutationIntent('gstei 50 d carne hj no nubnk')).toBe(false);
  });

  it('routes the informal utterance to the same mutation plan as a well-formed one', () => {
    const informal = routeIntent('gstei 50 d carne hj no nubnk');
    const wellFormed = routeIntent('Gastei R$ 50 de carne no mercado');

    expect(informal.mode).toBe('mutation-proposal');
    expect(informal.requestedOperations).toEqual(wellFormed.requestedOperations);
    expect(informal.missingFields).toEqual(wellFormed.missingFields);
  });
});

describe('A06/R06 AC13 — an ambiguous utterance never reaches a proposal', () => {
  it.each([
    ['approximate amount', 'gastei uns 80 no mercado'],
    ['unsupported currency', 'gastei 50 dolares no mercado'],
    ['ambiguous separator', 'gastei 1,500 no mercado'],
    ['contradictory dates', 'gastei 50 no mercado ontem e anteontem'],
  ])('asks instead of registering: %s', async (_label, text) => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: `intent-ac13-${_label}` }, identity),
    );

    expect(result.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(result.clarification?.text).toBeTruthy();
    expect(result.clarification?.missingFields.length).toBeGreaterThan(0);
  });

  it('does not plan a mutation operation for an approximate value', () => {
    const plan = routeIntent('gastei uns 80 no mercado');

    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
    expect(plan.requestedTools ?? []).not.toContain('transactions.expense.create');
  });
});

/**
 * Review fix 1: the ambiguity must reach the REAL routing, not only the
 * orchestrator's defensive re-check. These tests use the real router (no
 * injected `plan`) and a real adapter, so the turn can only clarify if the
 * planner itself routes the ambiguous utterance to the deterministic
 * clarification terminal — no read, no proposal, no provider.
 */
describe('A06 review fix 1 — ambiguity reaches the real router and the deterministic terminal', () => {
  it('routes "gastei uns 80 no mercado" to the clarification terminal, never to a read plan', () => {
    const plan = routeIntent('gastei uns 80 no mercado');

    // No operation at all — neither a mutation nor an authoritative read: a
    // mutation utterance must not silently become a transactions query.
    expect(plan.requestedOperations).toHaveLength(0);
    expect(plan.requestedTools ?? []).toHaveLength(0);
    // No mutation plan either: an ambiguous intent has nothing to propose and
    // needs no device, so it answers with the deterministic clarification.
    expect(plan.mode).toBe('unsupported');
    expect(plan.missingFields).toContain('amount');
    expect(plan.ambiguity).toContain('approximate_amount');
  });

  it('answers with the approximation clarification, zero reads, zero proposals, zero provider calls', async () => {
    const { api, request } = mockProposeClient();
    const listAccounts = vi.fn(async () => [ACCOUNT_NUBANK]);
    const listCategories = vi.fn(async () => [CATEGORY_CARNE]);
    const responseProvider = vi.fn(async () => 'resposta do modelo');
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { listAccounts, listCategories } as EntityReader,
      responseProvider,
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei uns 80 no mercado', intentionId: 'intent-fix1-router' }, identity),
    );

    expect(result.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listCategories).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.clarification?.text).toMatch(/valor exato/i);
    expect(result.clarification?.missingFields).toContain('amount');
  });

  it('never treats the bare approximate amount as a mutation (an amount is not an intent)', () => {
    // Behavior preserved from AC13: without a mutation signal there is no plan.
    const plan = routeIntent('uns 80');
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });
});

/**
 * Review fix 2: an ACTIVE draft must not route an ambiguous message into the
 * draft continuation. The draft is preserved untouched (no CAS, no write) and
 * the deterministic clarification answers the turn.
 */
describe('A06 review fix 2 — an ambiguous message never consumes the active draft', () => {
  const seedDraft = (store: InMemoryMutationDraftStore) =>
    store.getOrCreate(buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'intent-fix2-seed',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'carne', date: '2026-10-03' },
      missingFields: ['accountId', 'categoryId'],
      question: 'Em qual conta?',
    })).record;

  it('clarifies the approximation instead of completing the draft with its own amount', async () => {
    const { api, request } = mockProposeClient();
    const store = new InMemoryMutationDraftStore();
    const draft = seedDraft(store);
    const listAccounts = vi.fn(async () => [ACCOUNT_NUBANK]);
    const listCategories = vi.fn(async () => [CATEGORY_CARNE]);
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { listAccounts, listCategories } as EntityReader,
      draftStore: store,
      events: (type, fields) => seen.push({ type, fields }),
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gstei uns 80 no Nubank', intentionId: 'intent-fix2-clarify' }, identity),
    );

    expect(result.mutation).toBeUndefined();
    expect(result.clarification?.text).toMatch(/valor exato/i);
    // Zero authoritative reads and zero proposals: the ambiguity stops first.
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listCategories).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    // The draft survives intact — no CAS, no consumption, no field update.
    expect(store.get(draft.draftId)).toEqual(draft);
    expect(draft.status).toBe('active');
    expect(store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, Date.now())).toHaveLength(1);
    expect(store.listProposing({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, Date.now())).toHaveLength(0);
    // A10 coherence: the turn still emits its budget snapshot and the
    // interception happens BEFORE any resolution, so no recovery slot is spent.
    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget?.fields.resolutionRecoveries).toBe(0);
    expect(budget?.fields.proposeAttempts).toBe(0);
    expect(budget?.fields.stop).toBe('clarification_needed');
  });

  it('still completes the draft for an unambiguous continuation', async () => {
    const { api, request } = mockProposeClient();
    const store = new InMemoryMutationDraftStore();
    seedDraft(store);
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_CARNE]) as EntityReader,
      draftStore: store,
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Nubank', intentionId: 'intent-fix2-clean' }, identity),
    );

    expect(result.mutation?.status).toBe('proposed');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review fix 4: `continueDraft` and `freshMutationFlow` must derive the
 * resolution base from the SAME interpretation string, so one logical attempt
 * has one fingerprint (A06×A10 coherence). The second identical attempt is
 * blocked as a repetition, keeping the ≤2 propose cap and a safe stop.
 */
describe('A06 review fix 4 — resolution fingerprint is coherent across draft paths', () => {
  it('blocks the second identical resolution attempt as a repetition, keeping the propose cap', async () => {
    const { api, request } = mockProposeClient();
    const store = new InMemoryMutationDraftStore();
    const listAccounts = vi.fn(async () => []);
    const listCategories = vi.fn(async () => []);
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    // One shared budget across both turns: the production budget is per turn,
    // and injecting it is the documented way to observe the SAME attempt twice
    // (one per path) instead of two unrelated recoveries.
    const sharedBudget = new TurnBudget();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { listAccounts, listCategories } as EntityReader,
      draftStore: store,
      turnBudgetFactory: () => sharedBudget,
      events: (type, fields) => seen.push({ type, fields }),
    });

    // Turn 1: FRESH path. The authoritative lists answer nothing, so the
    // resolution attempt is recorded and the turn asks (draft stays active).
    const fresh = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei 50 de carne', intentionId: 'intent-fix4-fresh' }, identity),
    );
    expect(fresh.mutation).toBeUndefined();
    expect(fresh.clarification).toBeDefined();
    expect(store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, Date.now())).toHaveLength(1);
    const readsAfterFresh = listAccounts.mock.calls.length;

    // Turn 2: CONTINUATION path with the SAME resolution text. Same logical
    // attempt ⇒ same fingerprint ⇒ refused as a repetition, no re-read, no
    // proposal, safe stop.
    const second = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei 50 de carne', intentionId: 'intent-fix4-repeat' }, identity),
    );

    expect(second.clarification).toBeDefined();
    expect(second.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(listAccounts.mock.calls.length).toBe(readsAfterFresh);

    const budget = seen.filter((event) => event.type === 'turn.budget').pop();
    expect(budget?.fields.blockedRepeats).toBe(1);
    expect(budget?.fields.stop).toBe('no_new_strategy');
    // The structural caps stay untouched: the shared cap is still 2 and a
    // refused attempt never became a propose attempt.
    expect(budget?.fields.recoveryCap).toBe(2);
    expect(budget?.fields.resolutionRecoveries).toBe(1);
    expect(budget?.fields.proposeAttempts).toBe(0);
  });
});