/**
 * R10 (AC20/AC30) — turn recovery budget wired into the ConversationOrchestrator.
 *
 * Proves, at the orchestrator level: a grounding correction retry consumes the
 * shared slot so a second recovery clarifies with `budget_exhausted`; an
 * identical resolution recovery is blocked by fingerprint before any re-read;
 * and `completeTurn` emits a numeric-only `turn.budget` snapshot.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import {
  InMemoryMutationDraftStore,
  buildDraftRecord,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import { MutationApiClient, type MutationRequest } from '../../src/mutations/mutation-api-client.js';
import { TurnBudget } from '../../src/orchestration/turn-budget.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const readPlan = () => ({
  version: '2' as const,
  mode: 'read' as const,
  domain: 'general' as const,
  skillNames: ['s'],
  requestedOperations: [{ name: 'list_accounts', kind: 'read' as const }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const mutationPlan = () => ({
  version: '2' as const,
  mode: 'mutation-proposal' as const,
  domain: 'transactions' as const,
  skillNames: ['t'],
  requestedOperations: [{ name: 'create_expense', kind: 'mutation' as const }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const unshapedEnvelope: EvidenceEnvelope = {
  version: '1',
  items: [{
    ref: 'note',
    source: 'api.notes',
    retrievedAt: '2026-10-03T00:00:00.000Z',
    status: 'ok',
    data: { note: 'sem formato determinístico', hint: 'Conta principal' },
  }],
};

/** Entity reader that never resolves the account, forcing a clarify. */
const unresolvedReader: EntityReader = {
  listAccounts: async () => [],
  listCategories: async () => [],
};

/** Authoritative listing with nothing pending — the turn never proposes. */
const makeApi = () => {
  // The client calls this generically; the stub answers a typed-empty
  // listing and is cast at the boundary (same convention as the other
  // orchestrator tests).
  const request = vi.fn(async () => ({ items: [], total: 0 })) as unknown as MutationRequest;
  return { api: new MutationApiClient({ request }), request };
};

const NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

/**
 * Propose-capable fake: `POST /pending-operations/v2/propose` answers a fresh
 * id, and any other request answers a typed-empty listing (same convention as
 * the sibling mutation-draft tests). `failFirstPropose` reproduces a transient
 * (non-definitive) failure so the propose retry loop can be observed.
 */
const makeProposeApi = (options: { failFirstPropose?: boolean } = {}) => {
  let proposes = 0;
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      proposes += 1;
      if (options.failFirstPropose && proposes === 1) throw new Error('fetch failed');
      return { id: `pending-${proposes}` };
    }
    return { items: [], total: 0 };
  });
  return { api: new MutationApiClient({ request: request as unknown as MutationRequest }), request, proposePosts: () => proposes };
};

/** Everything resolves on the first turn, so the flow reaches `client.propose`. */
const resolvingReader: EntityReader = {
  listAccounts: async () => [NUBANK],
  listCategories: async () => [MERCADO],
};

describe('R10 turn recovery budget wiring', () => {
  it('emits a numeric-only turn.budget snapshot on every terminal turn', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const orchestrator = new ConversationOrchestrator({
      plan: readPlan,
      evidenceProvider: async () => unshapedEnvelope,
      responseProvider: async () => 'Resumo na Conta principal.',
      events: (type, fields) => seen.push({ type, fields }),
    });
    await orchestrator.runTurn(normalizeRestTurn({ text: 'resuma', intentionId: 'intent-budget-read' }, identity));

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget).toBeDefined();
    for (const [key, value] of Object.entries(budget!.fields)) {
      if (key === 'stop') continue;
      expect(typeof value, key).toBe('number');
    }
    const blob = JSON.stringify(budget!.fields);
    expect(blob).not.toMatch(/resuma|Conta principal|actor-authenticated|workspace-authenticated|intent-budget-read/);
    expect(budget!.fields.stop).toBe('completed');
  });

  it('counts the grounding correction retry on the shared budget', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const orchestrator = new ConversationOrchestrator({
      plan: readPlan,
      evidenceProvider: async () => unshapedEnvelope,
      responseProvider: async () => 'Seu saldo é R$ 999,99 na Conta principal.',
      correctionProvider: async () => 'Outro texto na Conta principal.',
      events: (type, fields) => seen.push({ type, fields }),
    });
    await orchestrator.runTurn(normalizeRestTurn({ text: 'resuma', intentionId: 'intent-budget-retry' }, identity));

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget!.fields.groundingRetries).toBe(1);
    expect(budget!.fields.recoveriesUsed).toBe(1);
  });

  it('blocks an identical resolution recovery by fingerprint without re-reading entities', async () => {
    const listAccounts = vi.fn(async () => []);
    const budget = new TurnBudget();
    // First recovery runs and consumes slot #1.
    budget.tryResolutionRecovery({
      kind: 'expense',
      args: { amountCents: 1234, description: 'Mercado', date: '2026-10-03' },
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
    });
    // The orchestrator's recovery for the same turn repeats the identical request.
    const repeat = budget.tryResolutionRecovery({
      kind: 'expense',
      args: { amountCents: 1234, description: 'Mercado', date: '2026-10-03' },
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
    });
    expect(repeat).toEqual({ allowed: false, stop: 'no_new_strategy' });
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('clarifies with budget_exhausted when the shared cap is already spent, never throwing', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const listAccounts = vi.fn(async () => []);
    const store: MutationDraftStore = new InMemoryMutationDraftStore();
    const { api } = makeApi();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      draftStore: store,
      plan: mutationPlan,
      entityReader: { listAccounts, listCategories: async () => [] } as EntityReader,
      // A budget already holding both shared slots for this turn.
      turnBudgetFactory: () => {
        const budget = new TurnBudget();
        budget.noteGroundingRetry();
        budget.tryResolutionRecovery({
          kind: 'income',
          args: { amountCents: 999, description: 'Salário', date: '2026-10-01' },
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
        });
        return budget;
      },
      events: (type, fields) => seen.push({ type, fields }),
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei R$ 12,34 no mercado', intentionId: 'intent-budget-exhausted' }, identity),
    );

    // Safe clarification — no unhandled error, no fabricated success.
    expect(result.clarification).toBeDefined();
    expect(result.response?.text).toMatch(/segurança|Esclareça/i);
    // The blocked recovery never re-read the authoritative entity lists.
    expect(listAccounts).not.toHaveBeenCalled();

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget!.fields.stop).toBe('budget_exhausted');
    expect(budget!.fields.recoveriesUsed).toBe(2);
  });

  it('admits a first resolution recovery on a fresh turn and accounts for it', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const store: MutationDraftStore = new InMemoryMutationDraftStore();
    const { api } = makeApi();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      draftStore: store,
      plan: mutationPlan,
      entityReader: unresolvedReader,
      events: (type, fields) => seen.push({ type, fields }),
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei R$ 12,34 no mercado', intentionId: 'intent-budget-first' }, identity),
    );
    expect(result.clarification).toBeDefined();

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget!.fields.resolutionRecoveries).toBe(1);
    expect(budget!.fields.recoveriesUsed).toBe(1);
    expect(budget!.fields.stop).toBe('clarification_needed');
  });

  it('gates a draft continuation the same way, without re-reading entities', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const listAccounts = vi.fn(async () => []);
    const listCategories = vi.fn(async () => []);
    const store: MutationDraftStore = new InMemoryMutationDraftStore();
    const { api, request } = makeApi();
    // A draft left ACTIVE by a previous turn, still pending its account.
    const seeded = store.getOrCreate(buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'intent-budget-draft-seed',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 1234, description: 'Mercado', date: '2026-10-03' },
      missingFields: ['accountId'],
      question: 'Em qual conta?',
    })).record;
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      draftStore: store,
      plan: mutationPlan,
      entityReader: { listAccounts, listCategories } as EntityReader,
      turnBudgetFactory: () => {
        const budget = new TurnBudget();
        budget.noteGroundingRetry();
        budget.tryResolutionRecovery({
          kind: 'income',
          args: { amountCents: 999, description: 'Salário', date: '2026-10-01' },
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
        });
        return budget;
      },
      events: (type, fields) => seen.push({ type, fields }),
    });

    // A bare entity answer continues the pending draft.
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Nubank', intentionId: 'intent-budget-continuation' }, identity),
    );
    expect(result.clarification).toBeDefined();
    expect(result.response?.text).toMatch(/segurança|Esclareça/i);
    // Neither authoritative list was touched by the refused recovery.
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listCategories).not.toHaveBeenCalled();
    // Nothing was proposed and the draft was left untouched: a safe stop
    // never consumes the draft, never proposes and never advances its state.
    expect(request).not.toHaveBeenCalled();
    expect(result.mutation).toBeUndefined();
    const after = store.get(seeded.draftId);
    expect(after).toEqual(seeded);
    expect(after?.status).toBe('active');
    expect(store.listProposing({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, Date.now())).toHaveLength(0);

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget!.fields.stop).toBe('budget_exhausted');
    expect(budget!.fields.recoveriesUsed).toBe(2);
    // A refused recovery never became a propose attempt.
    expect(budget!.fields.proposeAttempts).toBe(0);
  });

  it('counts a propose attempt on the shared snapshot', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const store: MutationDraftStore = new InMemoryMutationDraftStore();
    const { api, proposePosts } = makeProposeApi();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      draftStore: store,
      plan: mutationPlan,
      entityReader: resolvingReader,
      events: (type, fields) => seen.push({ type, fields }),
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei R$ 12,34 no mercado', intentionId: 'intent-budget-propose' }, identity),
    );
    expect(result.mutation?.status).toBe('proposed');
    expect(proposePosts()).toBe(1);

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget!.fields.proposeAttempts).toBe(1);
    // The propose axis stays separate from the shared recovery cap.
    expect(budget!.fields.resolutionRecoveries).toBe(1);
    expect(budget!.fields.recoveriesUsed).toBe(1);
  });

  it('counts every propose attempt of a retried propose, never granting extra recovery budget', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const store: MutationDraftStore = new InMemoryMutationDraftStore();
    const { api, proposePosts } = makeProposeApi({ failFirstPropose: true });
    // The ≤2 propose attempts live in `executePropose`, reached by continuing
    // a draft that still owes its account.
    store.getOrCreate(buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'intent-budget-propose-retry-seed',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 1234, description: 'Mercado', date: '2026-10-03' },
      missingFields: ['accountId'],
      question: 'Em qual conta?',
    }));
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      draftStore: store,
      plan: mutationPlan,
      entityReader: resolvingReader,
      draftMaxProposeAttempts: 2,
      events: (type, fields) => seen.push({ type, fields }),
    });

    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Nubank', intentionId: 'intent-budget-propose-retry' }, identity),
    );
    // The transient failure was retried with the same key and converged.
    expect(proposePosts()).toBe(2);
    expect(result.mutation?.status).toBe('proposed');

    const budget = seen.find((event) => event.type === 'turn.budget');
    expect(budget!.fields.proposeAttempts).toBe(2);
    expect(budget!.fields.recoveriesUsed).toBe(1);
  });
});