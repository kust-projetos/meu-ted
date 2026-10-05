/**
 * A16/F6 — default-off must not add an AWAIT to the hot path.
 *
 * `continuationRelation` awaited `resolveContinuationRelation` even when the
 * judge was absent or default-off, so every negotiation turn gained a promise
 * (and a microtask hop) for a decision nobody could take. The deterministic
 * relation is now computed synchronously and the provider is consulted only when
 * it is actually available; when it is, `evaluate` is still awaited exactly once
 * and stays advisory.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { JudgmentProvider, JudgmentEnv } from '../../src/judgment/provider.js';
import { createJudgmentProvider } from '../../src/judgment/provider.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';

const NOW_MS = Date.parse('2026-09-14T18:00:00.000Z');

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

// Two accounts so the first turn stays a DRAFT awaiting an account choice and
// never reaches a propose write (this suite has no mutation path at all).
const reader: EntityReader = {
  listAccounts: async () => [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' },
  ],
  listCategories: async () => [{ id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' }],
};

const enabledEnv: JudgmentEnv = {
  TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
  TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
};

const okResponse = (choice: unknown) =>
  new Response(JSON.stringify({ choice, rationale: 'continuação', confidence: 0.9 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const readOnlyApi = () => {
  const writes: string[] = [];
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET') {
      if (path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(`unexpected read ${path}`);
    }
    writes.push(`${method} ${path}`);
    throw new Error('financial.mutation.must_not_happen');
  });
  return { api: new MutationApiClient({ request }), writes };
};

type Events = Array<{ eventType: string; fields: Record<string, unknown> }>;

const ctxOf = () => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
});

const runTurns = async (options: { provider?: JudgmentProvider; withAccessor?: boolean }) => {
  const store = new InMemoryMutationDraftStore();
  const fake = readOnlyApi();
  const events: Events = [];
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: fake.api,
    entityReader: reader,
    draftStore: store,
    draftNow: () => NOW_MS,
    events: (eventType, fields) => {
      events.push({ eventType, fields });
    },
    ...(options.withAccessor ? { judgmentProvider: () => options.provider } : {}),
  });
  const run = (text: string, intentionId: string) =>
    orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  const first = await run('Gastei R$ 50 no mercado', 'f6-open-1');
  const second = await run('não', 'f6-neg-1');
  return { first, second, draft: store.listActive(ctxOf(), NOW_MS)[0]!, events, writes: fake.writes };
};

const negativeSpyProvider = (available: boolean): JudgmentProvider => {
  const evaluate = vi.fn(async () => ({ status: 'unavailable' as const, reason: 'not_configured' as const }));
  return { available, evaluate, stats: () => ({ calls: 0, decisions: 0, abstentions: 0, unavailables: 0, breakerOpens: 0 }) };
};

describe('A16/F6 default-off adds no await and no provider call', () => {
  it('with NO accessor the negotiation turn never touches a provider promise', async () => {
    const baseline = await runTurns({});
    expect(baseline.draft!.relations).toContain('negation');
    expect(baseline.events.filter((event) => event.eventType === 'judgment.consulted')).toEqual([]);
    expect(baseline.writes).toEqual([]);
  });

  it('with an UNAVAILABLE provider the turn output is identical and evaluate is never called', async () => {
    const provider = negativeSpyProvider(false);
    const withoutAccessor = await runTurns({});
    const withUnavailable = await runTurns({ provider, withAccessor: true });
    expect(JSON.stringify(withUnavailable.first)).toBe(JSON.stringify(withoutAccessor.first));
    expect(JSON.stringify(withUnavailable.second)).toBe(JSON.stringify(withoutAccessor.second));
    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(withUnavailable.events.map((event) => event.eventType)).toEqual(
      withoutAccessor.events.map((event) => event.eventType),
    );
  });

  it('the deterministic relation is computed without awaiting when no provider exists', async () => {
    const { ConversationOrchestrator: Orchestrator } = await import('../../src/orchestration/conversation-orchestrator.js');
    const store = new InMemoryMutationDraftStore();
    const orchestrator = new Orchestrator({
      mutationApiClient: readOnlyApi().api,
      entityReader: reader,
      draftStore: store,
      draftNow: () => NOW_MS,
      events: () => undefined,
    });
    await orchestrator.runTurn(normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'f6-sync-1' }, identity));
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    const draft = store.get(draftId)!;
    const input = normalizeRestTurn({ text: 'não', intentionId: 'f6-sync-2' }, identity);
    // The private helper is synchronous by contract: it returns the relation,
    // not a promise, when there is no provider to await.
    const result = (orchestrator as unknown as {
      continuationRelation: (
        input: unknown,
        draft: unknown,
      ) => unknown;
    }).continuationRelation(input, draft);
    expect(result).toBe('negation');
    expect(typeof (result as Promise<unknown>).then).toBe('undefined');
  });

  it('an AVAILABLE provider is still consulted exactly once and stays advisory', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await runTurns({ provider, withAccessor: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const consult = state.events.find((event) => event.eventType === 'judgment.consulted');
    expect(consult?.fields).toMatchObject({
      status: 'decision',
      source: 'judgment_advisory',
      choice: 'continuation',
      deterministicRelation: 'negation',
    });
    // Deterministic value stays authoritative.
    expect(state.draft!.relations).toContain('negation');
    expect(state.writes).toEqual([]);
  });
});