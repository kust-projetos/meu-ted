/**
 * Issue #86 (review R1 + R5) — the consult EVENT must tell the truth.
 *
 * `continuationRelation` short-circuits on `available === false`, which used to
 * make every unavailable provider invisible: an operator who selected `clef`
 * without deploying the `AI` binding, or who typo'd the provider name, produced
 * exactly the same telemetry as an operator who never turned the feature on. The
 * layer now reports WHY it is unavailable, and this suite pins the consequence:
 *
 *   - a CONFIGURATION error (`binding_missing`, `provider_not_supported`) is
 *     visible as `decision.consulted { status: 'unavailable', reason }`;
 *   - DEFAULT-OFF (`not_configured`, or no accessor at all) stays byte-for-byte
 *     silent, exactly as `decision-no-await-default-off.test.ts` requires;
 *   - a provider that THROWS — the accessor itself, or `evaluate` — degrades to
 *     the deterministic relation instead of failing the turn, and the event
 *     carries a bounded token with no message, no stack and no provider prose.
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
  type DecisionOutcome,
  type DecisionProvider,
} from '../../src/decision/provider.js';
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

const reader: EntityReader = {
  listAccounts: async () => [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' },
  ],
  listCategories: async () => [{ id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' }],
};

type Events = Array<{ eventType: string; fields: Record<string, unknown> }>;

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

/**
 * `accessor` is passed verbatim so a test can hand the orchestrator a provider
 * built from an env, or an accessor that throws.
 */
const runTurns = async (accessor?: () => DecisionProvider | undefined) => {
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
    ...(accessor ? { decisionProvider: accessor } : {}),
  });
  const run = (text: string, intentionId: string) =>
    orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  const first = await run('Gastei R$ 50 no mercado', 'mc-open-1');
  const second = await run('não', 'mc-neg-1');
  const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
  return { first, second, draft: store.listActive(ctx, NOW_MS)[0]!, events, writes: fake.writes };
};

const consultEvents = (events: Events) => events.filter((event) => event.eventType === 'decision.consulted');

const hostileProvider = (evaluate: () => Promise<DecisionOutcome>): DecisionProvider => ({
  provider: 'hostile',
  available: true,
  minConfidence: DECISION_DEFAULT_MIN_CONFIDENCE,
  evaluate: vi.fn(evaluate),
  stats: () => ({ calls: 0, decisions: 0, abstentions: 0, unavailables: 0, breakerOpens: 0 }),
});

describe('issue #86/R1 — a MISCONFIGURED provider is visible; default-off stays silent', () => {
  it('clef selected without the AI binding emits the event with binding_missing', async () => {
    const state = await runTurns(() => createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'clef' } }));

    const consult = consultEvents(state.events);
    expect(consult).toHaveLength(1);
    expect(consult[0]!.fields).toMatchObject({
      operation: 'continuation_relation',
      status: 'unavailable',
      source: 'deterministic',
      reason: 'binding_missing',
      deterministicRelation: 'negation',
    });
    // Sanitized: the event carries tokens and booleans only — no provider prose.
    expect(Object.keys(consult[0]!.fields).sort()).toEqual([
      'channel',
      'deterministicRelation',
      'operation',
      'reason',
      'source',
      'status',
      'intentionId',
      'traceId',
    ].sort());
    // The deterministic relation still wins and nothing was written.
    expect(state.draft!.relations).toContain('negation');
    expect(state.writes).toEqual([]);
  });

  it('an unsupported provider name emits the event with provider_not_supported', async () => {
    const state = await runTurns(() => createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'openai-judge' } }));

    expect(consultEvents(state.events)[0]!.fields).toMatchObject({
      status: 'unavailable',
      reason: 'provider_not_supported',
      source: 'deterministic',
    });
    expect(state.draft!.relations).toContain('negation');
  });

  it('a selected provider missing its own config (jev without endpoint) emits not_configured, not silence', async () => {
    const state = await runTurns(() => createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'jev' } }));

    // Same token as default-off — but the operator ASKED for a provider, so the
    // turn records that nothing was consulted instead of pretending nothing exists.
    expect(consultEvents(state.events)[0]!.fields).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    expect(state.draft!.relations).toContain('negation');
  });

  it('with NO selector env the turn is byte-for-byte the no-accessor turn, with ZERO events', async () => {
    const baseline = await runTurns();
    const defaultOff = await runTurns(() => createDecisionProvider({ env: {} }));

    expect(consultEvents(defaultOff.events)).toEqual([]);
    expect(JSON.stringify(defaultOff.first)).toBe(JSON.stringify(baseline.first));
    expect(JSON.stringify(defaultOff.second)).toBe(JSON.stringify(baseline.second));
    expect(defaultOff.events.map((event) => event.eventType)).toEqual(baseline.events.map((event) => event.eventType));
  });
});

describe('issue #86/R5 — a throwing provider degrades to the deterministic relation', () => {
  it('a provider ACCESSOR that throws does not fail the turn and emits a bounded reason', async () => {
    const state = await runTurns(() => {
      throw new Error('adapter bug: token=secret-should-never-be-logged');
    });

    expect(state.draft!.relations).toContain('negation');
    expect(state.writes).toEqual([]);
    const consult = consultEvents(state.events);
    expect(consult).toHaveLength(1);
    expect(consult[0]!.fields).toMatchObject({ status: 'unavailable', source: 'deterministic' });
    // Sanitized: a machine token, never the adapter's message or a stack.
    expect(consult[0]!.fields.reason).toBe('provider_error');
    expect(JSON.stringify(consult[0]!.fields)).not.toContain('secret-should-never-be-logged');
  });

  it('an evaluate() that REJECTS does not fail the turn either', async () => {
    const provider = hostileProvider(async () => {
      throw new Error('boom');
    });
    const state = await runTurns(() => provider);

    expect(state.draft!.relations).toContain('negation');
    expect(state.writes).toEqual([]);
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(consultEvents(state.events)[0]!.fields).toMatchObject({
      status: 'unavailable',
      reason: 'provider_error',
      source: 'deterministic',
    });
  });
});