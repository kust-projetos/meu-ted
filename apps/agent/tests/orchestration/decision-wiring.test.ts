/**
 * Issue #86 — the decision layer WIRED into the hot path (moved from the A16 seam).
 *
 * Same behaviour as the A16 suite it replaces, proven through the NEUTRAL seam:
 * the orchestrator asks for a `DecisionProvider` and knows nothing about which one
 * it gets. Every case below used to be about "the judge" — the names changed, the
 * guarantees did not:
 *
 * - default-off (no `TED_DECISION_PROVIDER`) ⇒ turn BYTE A BYTE identical to the
 *   pre-issue turn, zero network, zero new event;
 * - the request carries STRUCTURAL facts only — never user text, amount, date,
 *   description, category or account id;
 * - timeout / 401 / malformed / value outside the allowlist / open circuit /
 *   turn budget ⇒ deterministic fallback, granting no success or permission;
 * - a decision CONTRARY to the deterministic heuristic changes nothing (AC25);
 * - a guarded financial write (value correction) never waits for the layer;
 * - the wiring is provider-agnostic: the same event shape arrives from Clef.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import {
  DECISION_DEFAULT_MIN_CONFIDENCE,
  createDecisionProvider,
  type DecisionEnv,
  type DecisionProvider,
} from '../../src/decision/provider.js';
import {
  CONTINUATION_RELATION_QUESTION,
  continuationRelationDecisionRequest,
} from '../../src/decision/wiring.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  type MutationDraftRecord,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';

const NOW_MS = Date.parse('2026-09-14T18:00:00.000Z');

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

const reader: EntityReader = {
  listAccounts: async () => [NUBANK, ITAU],
  listCategories: async () => [MERCADO],
};

/**
 * Strands is the transport used by most cases here ON PURPOSE: the domain suite
 * must pass with a provider the issue's authors did not build for it. A Jev case
 * lives in `tests/decision-provider.test.ts`, where the vendor mapping belongs.
 */
const enabledEnv: DecisionEnv = {
  TED_DECISION_PROVIDER: 'strands',
  TED_DECISION_STRANDS_URL: 'http://127.0.0.1:8000',
};

const okResponse = (relation: string, noul = 0.9) =>
  new Response(JSON.stringify({ response: { answers: { relation: { choice: relation, noul } } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const ctxOf = () => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
});

/**
 * API fake SOMENTE de leitura: nenhuma mutação financeira pode acontecer neste
 * arquivo, então qualquer escrita vira erro explícito (o teste falha no lugar
 * certo em vez de passar com um propose silencioso).
 */
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

type Harness = Readonly<{
  store: MutationDraftStore;
  draftId: string;
  draft: () => MutationDraftRecord;
  writes: string[];
  events: Array<{ eventType: string; fields: Record<string, unknown> }>;
  decisionEvents: () => Array<{ eventType: string; fields: Record<string, unknown> }>;
  first: Awaited<ReturnType<ConversationOrchestrator['runTurn']>>;
  second: Awaited<ReturnType<ConversationOrchestrator['runTurn']>>;
  run: (text: string, intentionId: string, traceId?: string) => Promise<unknown>;
}>;

const NEGATION_TEXT = 'não';

const harness = async (options: { provider?: DecisionProvider } = {}): Promise<Harness> => {
  const store = new InMemoryMutationDraftStore();
  const fake = readOnlyApi();
  const events: Array<{ eventType: string; fields: Record<string, unknown> }> = [];
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: fake.api,
    entityReader: reader,
    draftStore: store,
    draftNow: () => NOW_MS,
    events: (eventType, fields) => {
      events.push({ eventType, fields });
    },
    // Absent = no provider is consulted (accessor not installed).
    ...(options.provider
      ? { decisionProvider: () => options.provider }
      : {}),
  });
  const run = async (text: string, intentionId: string, traceId?: string) =>
    orchestrator.runTurn(normalizeRestTurn({ text, intentionId, ...(traceId ? { traceId } : {}) }, identity));
  const first = await run('Gastei R$ 50 no mercado', 'dw-open-1');
  const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
  const second = await run(NEGATION_TEXT, 'dw-neg-1');
  return {
    store,
    draftId,
    draft: () => store.get(draftId)!,
    writes: fake.writes,
    events,
    decisionEvents: () => events.filter((event) => event.eventType === 'decision.consulted'),
    first,
    second,
    run,
  };
};

/** The negotiation turn is the deterministic value under the layer in every case. */
const expectDeterministicNegation = (state: Harness): void => {
  const record = state.draft();
  expect(record.relations).toContain('negation');
  expect(record.relations).not.toContain('continuation');
  expect(record.relations).not.toContain('correction');
  expect(record.resolvedArgs.amountCents).toBe(5000);
  expect((state.second as { mutation?: unknown }).mutation).toBeUndefined();
  expect(state.second.clarification?.text).toBeTruthy();
  expect(state.writes).toEqual([]);
};

describe('issue #86 — DecisionProvider wired into the orchestrator hot path', () => {
  it('default-off: no selector env ⇒ turn BYTE A BYTE identical and zero network', async () => {
    const fetchImpl = vi.fn();
    const baseline = await harness();
    const wired = await harness({ provider: createDecisionProvider({ fetchImpl: fetchImpl as unknown as typeof fetch }) });

    expect(JSON.stringify(wired.first)).toBe(JSON.stringify(baseline.first));
    expect(JSON.stringify(wired.second)).toBe(JSON.stringify(baseline.second));
    expect(JSON.stringify(wired.draft())).toBe(JSON.stringify(baseline.draft()));
    // No new event: not even the consult record, because the consult never existed.
    expect(wired.events.map((event) => event.eventType)).toEqual(baseline.events.map((event) => event.eventType));
    expect(wired.decisionEvents()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consults the layer on the draft-relation tie-break', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.decisionEvents()).toHaveLength(1);
    expect(state.decisionEvents()[0]!.fields).toMatchObject({
      operation: 'continuation_relation',
      status: 'decision',
      source: 'decision_advisory',
      choice: 'continuation',
      deterministicRelation: 'negation',
    });
    // The domain event carries NO vendor vocabulary, whatever the provider is.
    expect(JSON.stringify(state.decisionEvents()[0]!.fields)).not.toMatch(/jev|clef|strands/i);
  });

  it('the same wiring works through a DIFFERENT provider, with the same event shape', async () => {
    const run = vi.fn().mockResolvedValue({ response: { answers: { relation: { choice: 'continuation', noul: 0.86 } } } });
    const clef = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'clef', AI: { run } } });
    const state = await harness({ provider: clef });

    expect(run).toHaveBeenCalledTimes(1);
    expect(state.decisionEvents()[0]!.fields).toMatchObject({
      operation: 'continuation_relation',
      status: 'decision',
      source: 'decision_advisory',
      choice: 'continuation',
    });
    expectDeterministicNegation(state);
  });

  it('a CONTRARY answer does not change the deterministic value (AC25)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expectDeterministicNegation(await harness({ provider }));
  });

  it('an answer BELOW the confidence threshold falls back to the deterministic path', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('correction', 0.2));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });

    expect(provider.minConfidence).toBe(DECISION_DEFAULT_MIN_CONFIDENCE);
    expect(state.decisionEvents()[0]!.fields).toMatchObject({
      status: 'abstained',
      reason: 'low_confidence',
      source: 'deterministic',
    });
    // The dropped answer is NOT in the event either — telemetry cannot launder it.
    expect(state.decisionEvents()[0]!.fields).not.toHaveProperty('choice');
    expectDeterministicNegation(state);
  });

  it('the request carries NO financial state', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('negation'));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });

    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    // Structural state: closed keys, no text, amount, date or entity.
    expect(Object.keys(JSON.parse(body.state as string) as Record<string, unknown>).sort()).toEqual([
      'activeDraft',
      'deterministicRelation',
      'draftStatus',
      'negationMarker',
      'pendingFieldCount',
    ]);
    const questions = body.questions as Record<string, { instructions: string }>;
    expect(questions.relation!.instructions).toBe(CONTINUATION_RELATION_QUESTION);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/nubank|ita[uú]|mercado|carne|5000|r\$/i);
    expect(serialized).not.toMatch(/amountCents|accountId|categoryId|description|date/i);
    // Neither the user text nor the draft/operation identifier.
    // The question is a wiring CONSTANT (it does not derive from the turn), and
    // the structural state carries no word of the user.
    const stateText = body.state as string;
    expect(stateText).not.toContain(NEGATION_TEXT);
    expect(stateText).not.toContain('Gastei');
    expect(stateText).not.toMatch(/mercado|nubank|5000/i);
    expect(state.writes).toEqual([]);
    // The TURN key (what the per-turn cap measures) is in the request but never
    // goes to the network: it is local turn identity, not content.
    expect(continuationRelationDecisionRequest({
      turnId: 'dw-neg-1',
      draftStatus: 'active',
      pendingFieldCount: 2,
      negationMarker: true,
      deterministicRelation: 'negation',
    })).toMatchObject({ turnId: 'dw-neg-1', op: 'continuation_relation' });
  });

  it('a guarded financial write (value correction) does not wait for the layer', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });
    // Correction turn: the deterministic relation is already `correction` and the
    // draft write is the revision-guarded path — the layer is not part of it.
    await state.run('não, 500', 'dw-neg-2');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.draft().resolvedArgs.amountCents).toBe(50000);
    expect(state.writes).toEqual([]);
  });

  const failureCases: readonly Readonly<{
    name: string;
    fetchImpl: () => Promise<Response>;
    timeoutMs?: number;
    reason: string;
  }>[] = [
    {
      name: '401 (credential refused)',
      fetchImpl: async () => new Response('{}', { status: 401 }),
      reason: 'unauthorized',
    },
    {
      name: 'malformed response',
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'application/json' } }),
      reason: 'malformed_response',
    },
    {
      name: 'value outside the allowlist',
      fetchImpl: async () => okResponse('aprovar_lancamento'),
      reason: 'value_outside_allowlist',
    },
    {
      name: 'transport error',
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
      reason: 'transport_error',
    },
    {
      name: 'timeout',
      fetchImpl: () => new Promise<Response>(() => undefined),
      timeoutMs: 25,
      reason: 'timeout',
    },
  ];

  for (const failure of failureCases) {
    it(`deterministic fallback on ${failure.name}`, async () => {
      const fetchImpl = vi.fn().mockImplementation(failure.fetchImpl);
      const provider = createDecisionProvider({
        env: enabledEnv,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...(failure.timeoutMs !== undefined ? { timeoutMs: failure.timeoutMs } : {}),
      });
      const state = await harness({ provider });
      expectDeterministicNegation(state);
      expect(state.decisionEvents()[0]!.fields).toMatchObject({
        status: 'abstained',
        reason: failure.reason,
        source: 'deterministic',
      });
    });
  }

  it('the one-call-per-turn cap is enforced BY the wiring (same turnId never buys twice)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Second turn with the SAME turn key: the provider refuses, the wiring does
    // not route around it.
    await state.run(NEGATION_TEXT, 'dw-neg-3', 'dw-neg-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const last = state.decisionEvents().at(-1)!;
    expect(last.fields).toMatchObject({ status: 'unavailable', reason: 'turn_budget_exhausted' });
    expectDeterministicNegation(state);
  });

  it('the breaker stops the consultation after 2 consecutive failures', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('{}', { status: 500 }));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = await harness({ provider });
    await state.run(NEGATION_TEXT, 'dw-neg-4');
    await state.run(NEGATION_TEXT, 'dw-neg-5');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Third turn of the SAME DO: open circuit, no new call.
    await state.run(NEGATION_TEXT, 'dw-neg-6');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.decisionEvents().at(-1)!.fields).toMatchObject({
      status: 'unavailable',
      reason: 'circuit_open',
    });
    expectDeterministicNegation(state);
  });

  it('an absent accessor is fail-closed: no provider, no deviation', async () => {
    const state = await harness();
    expect(state.decisionEvents()).toEqual([]);
    expectDeterministicNegation(state);
  });

  it('the DO accessor is called once per turn and the instance is reused', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('continuation'));
    const provider = createDecisionProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    const accessor = vi.fn(() => provider);
    const store = new InMemoryMutationDraftStore();
    const fake = readOnlyApi();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: fake.api,
      entityReader: reader,
      draftStore: store,
      draftNow: () => NOW_MS,
      events: () => undefined,
      decisionProvider: accessor,
    });
    const run = (text: string, intentionId: string) =>
      orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
    await run('Gastei R$ 50 no mercado', 'dw-do-1');
    await run(NEGATION_TEXT, 'dw-do-2');
    await run(NEGATION_TEXT, 'dw-do-3');
    // One accessor call per consultation and NO instantiation inside the wiring:
    // the provider that counts is always the DO's instance (cap and breaker per
    // workspace).
    expect(accessor).toHaveBeenCalledTimes(2);
    expect(accessor.mock.results.every((result) => result.value === provider)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
