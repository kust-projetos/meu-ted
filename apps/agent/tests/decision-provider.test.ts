/**
 * Issue #86 — the PROVIDER-NEUTRAL decision layer (blocks 2-5).
 *
 * Jev (TypeSafe), Cloudflare Clef and Strands Decider 2B all speak the same
 * `{ state, questions }` dialect, so the agent should not have to know which one
 * it is talking to. This file pins the four things that must stay true no matter
 * which adapter is selected:
 *
 *   1. DEFAULT-OFF. With no `TED_DECISION_PROVIDER` the layer is a function that
 *      never touches the network or a binding — byte-for-byte the pre-issue turn.
 *   2. GENERAL CEILINGS. 1 consultation per turn, a deadline that covers the WHOLE
 *      attempt (headers included), and a breaker keyed per provider/config.
 *   3. CONFIDENCE POLICY. Below `TED_DECISION_MIN_CONFIDENCE` (default 0.7) the
 *      answer is DROPPED, not downgraded: the typed value never leaves the layer,
 *      so a low-confidence answer cannot escalate anywhere.
 *   4. DETERMINISTIC WINS. `resolveWithDecision` returns the deterministic value
 *      on every path, including a hostile provider that claims to have approved
 *      something. That is the issue's "no write can be authorized" proven at the
 *      only place where a decision becomes a value.
 *
 * Adapters are covered here too, driven by env + injected `fetchImpl`/AI stub —
 * there is no real network in this suite and no credential anywhere in the repo.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DECISION_ABSTAINED_REASONS,
  DECISION_BREAKER_COOLDOWN_MS,
  DECISION_BREAKER_FAILURE_THRESHOLD,
  DECISION_DEFAULT_MIN_CONFIDENCE,
  DECISION_MAX_CALLS_PER_TURN,
  DECISION_PROVIDERS,
  DECISION_TIMEOUT_MS,
  DECISION_UNAVAILABLE_REASONS,
  createDecisionProvider,
  decisionProviderForDo,
  resolveWithDecision,
  type DecisionOutcome,
  type DecisionProvider,
  type DecisionRequest,
} from '../src/decision/provider.js';
import { createJudgmentProvider, type JudgmentOutcome, type JudgmentRequest } from '../src/judgment/provider.js';

const CONTINUATION_REQUEST: DecisionRequest = {
  op: 'continuation_relation',
  state: { activeDraft: true, draftStatus: 'proposing', pendingFieldCount: 1, negationMarker: false },
  questions: {
    relation: {
      type: 'choice',
      instructions: 'Classifique a relação deste turno.',
      criteria: { options: ['correction', 'negation', 'continuation'] },
    },
  },
  turnId: 'turn-1',
};

const request = (turnId: string): DecisionRequest => ({ ...CONTINUATION_REQUEST, turnId });

const JEV_ENV = {
  TED_DECISION_PROVIDER: 'jev',
  TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
  TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
} as const;

const STRANDS_ENV = {
  TED_DECISION_PROVIDER: 'strands',
  TED_DECISION_STRANDS_URL: 'http://127.0.0.1:8000',
} as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Clef/Strands answer envelope: `answers.<name>` with `choice` and `noul`. */
const compatibleAnswers = (relation: string, noul: number) => ({
  response: { answers: { relation: { choice: relation, noul } } },
});

/** Workers AI binding stub — the only seam the Clef adapter is allowed to use. */
const aiStub = (result: unknown) => {
  const run = vi.fn().mockResolvedValue(result);
  return { binding: { run }, run };
};

const neverResolvingFetch = (): typeof fetch => vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

describe('issue #86 — provider selection is closed and default-off', () => {
  it('with NO env the layer is unavailable and touches neither fetch nor the AI binding', async () => {
    const fetchImpl = vi.fn();
    const ai = aiStub(compatibleAnswers('continuation', 0.9));
    const provider = createDecisionProvider({ env: { AI: ai.binding }, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(provider.available).toBe(false);
    expect(provider.provider).toBe('none');
    const outcome = await provider.evaluate(request('turn-default-off'));
    expect(outcome).toEqual({ provider: 'none', status: 'unavailable', reason: 'not_configured', advisory: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'none', 'NONE'])('TED_DECISION_PROVIDER=%j is default-off, not an error', async (value) => {
    const provider = createDecisionProvider({ env: { TED_DECISION_PROVIDER: value } });
    expect(provider.available).toBe(false);
    expect((await provider.evaluate(request('turn-off'))).reason).toBe('not_configured');
  });

  it('an UNSUPPORTED provider name fails closed with provider_not_supported and zero egress', async () => {
    const fetchImpl = vi.fn();
    const provider = createDecisionProvider({
      env: { TED_DECISION_PROVIDER: 'openai-judge' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(provider.available).toBe(false);
    expect((await provider.evaluate(request('turn-unsupported'))).reason).toBe('provider_not_supported');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('selects each supported provider by env, and reports its own name', async () => {
    const jev = createDecisionProvider({ env: { ...JEV_ENV }, fetchImpl: (async () => json({ choice: 'continuation', confidence: 0.9 })) as unknown as typeof fetch });
    const clef = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'clef', AI: aiStub(compatibleAnswers('continuation', 0.9)).binding } });
    const strands = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: (async () => json(compatibleAnswers('continuation', 0.9))) as unknown as typeof fetch });

    expect([jev.available, jev.provider]).toEqual([true, 'jev']);
    expect([clef.available, clef.provider]).toEqual([true, 'clef']);
    expect([strands.available, strands.provider]).toEqual([true, 'strands']);
    expect(DECISION_PROVIDERS).toEqual(['jev', 'clef', 'strands']);
  });

  it('every declared reason is a declared token (telemetry cannot carry free prose)', () => {
    expect(DECISION_UNAVAILABLE_REASONS).toContain('not_configured');
    expect(DECISION_ABSTAINED_REASONS).toContain('low_confidence');
  });
});

describe('issue #86 — general ceilings: one consultation per turn, one deadline, breaker per config', () => {
  it(`allows at most ${DECISION_MAX_CALLS_PER_TURN} consultation per turn and never re-buys it for the same turn`, async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(compatibleAnswers('continuation', 0.9)));
    const provider = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await provider.evaluate(request('turn-budget'));
    expect(first.status).toBe('decision');
    const second = await provider.evaluate(request('turn-budget'));
    expect(second).toEqual({ provider: 'strands', status: 'unavailable', reason: 'turn_budget_exhausted', advisory: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A DIFFERENT turn buys its own consultation: the cap is per turn, not global.
    expect((await provider.evaluate(request('turn-budget-2'))).status).toBe('decision');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty turnId and an operation outside the closed enum, without egress', async () => {
    const fetchImpl = vi.fn();
    const provider = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect((await provider.evaluate(request(''))).reason).toBe('turn_id_required');
    const foreign = await provider.evaluate({ ...CONTINUATION_REQUEST, op: 'approve_write', turnId: 'turn-op' });
    expect(foreign).toEqual({ provider: 'strands', status: 'unavailable', reason: 'operation_not_allowed', advisory: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it(`bounds the WHOLE attempt by the deadline (default ${DECISION_TIMEOUT_MS} ms)`, async () => {
    const provider = createDecisionProvider({
      env: { ...STRANDS_ENV },
      fetchImpl: neverResolvingFetch(),
      timeoutMs: 25,
    });
    const outcome = await provider.evaluate(request('turn-timeout'));
    expect(outcome).toMatchObject({ status: 'abstained', reason: 'timeout', advisory: true });
  });

  it('opens the breaker after two consecutive failures and re-probes once per cooldown', async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));
    const provider = createDecisionProvider({
      env: { ...STRANDS_ENV },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    expect((await provider.evaluate(request('turn-b1'))).reason).toBe('transport_error');
    expect((await provider.evaluate(request('turn-b2'))).reason).toBe('transport_error');
    const callsBeforeOpen = fetchImpl.mock.calls.length;
    expect((await provider.evaluate(request('turn-b3'))).reason).toBe('circuit_open');
    expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeOpen);

    // Cooldown elapsed: half-open allows exactly ONE probe.
    clock += DECISION_BREAKER_COOLDOWN_MS + 1;
    expect((await provider.evaluate(request('turn-b4'))).reason).toBe('transport_error');
    const callsAfterProbe = fetchImpl.mock.calls.length;
    expect((await provider.evaluate(request('turn-b5'))).reason).toBe('circuit_open');
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterProbe);
  });

  it('a REJECTED CONTENT (4xx) does not open the breaker — one tenant cannot disable the layer', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ error: 'content refused' }, 422));
    const provider = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch });

    for (const turn of ['turn-c1', 'turn-c2', 'turn-c3', 'turn-c4']) {
      expect((await provider.evaluate(request(turn))).reason).toBe('rejected_request');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('issue #86 — confidence policy drops the answer instead of downgrading it', () => {
  const withConfidence = (confidence: number) => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(compatibleAnswers('continuation', confidence)));
    return { fetchImpl, provider: createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch }) };
  };

  it(`keeps an answer at or above the default threshold (${DECISION_DEFAULT_MIN_CONFIDENCE})`, async () => {
    const { provider } = withConfidence(0.9);
    const outcome = await provider.evaluate(request('turn-conf-high'));
    expect(outcome).toMatchObject({ status: 'decision', confidence: 0.9, advisory: true });
    expect(outcome.answers?.relation?.value).toBe('continuation');
  });

  it('drops an answer below the threshold: no status, no answers, no confidence', async () => {
    const { provider } = withConfidence(0.69);
    const outcome = await provider.evaluate(request('turn-conf-low'));
    expect(outcome).toEqual({ provider: 'strands', status: 'abstained', reason: 'low_confidence', advisory: true });
    expect(outcome.answers).toBeUndefined();
    expect(outcome.confidence).toBeUndefined();
  });

  it('treats a MISSING confidence as no confidence (never as certainty)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ response: { answers: { relation: { choice: 'continuation' } } } }));
    const provider = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await provider.evaluate(request('turn-conf-none'))).reason).toBe('low_confidence');
  });

  it('honours TED_DECISION_MIN_CONFIDENCE and falls back to the default when it is nonsense', async () => {
    const relaxed = createDecisionProvider({
      env: { ...STRANDS_ENV, TED_DECISION_MIN_CONFIDENCE: '0.3' },
      fetchImpl: (async () => json(compatibleAnswers('continuation', 0.5))) as unknown as typeof fetch,
    });
    expect(relaxed.minConfidence).toBe(0.3);
    expect((await relaxed.evaluate(request('turn-conf-relaxed'))).status).toBe('decision');

    for (const raw of ['abc', '5', '-1', '']) {
      const fallback = createDecisionProvider({
        env: { ...STRANDS_ENV, TED_DECISION_MIN_CONFIDENCE: raw },
        fetchImpl: (async () => json(compatibleAnswers('continuation', 0.5))) as unknown as typeof fetch,
      });
      expect(fallback.minConfidence).toBe(DECISION_DEFAULT_MIN_CONFIDENCE);
      expect((await fallback.evaluate(request(`turn-conf-bad-${raw || 'empty'}`))).reason).toBe('low_confidence');
    }
  });
});

describe('issue #86 — the Jev adapter reuses the A16 boundary (no HTTP rewritten)', () => {
  it('is unavailable when the REUSED TED_JUDGMENT_* envs are absent, even with the selector on', async () => {
    const fetchImpl = vi.fn();
    const provider = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'jev' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(provider.available).toBe(false);
    expect((await provider.evaluate(request('turn-jev-off'))).reason).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates the neutral request into the A16 payload and the reply back', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ choice: 'negation', rationale: 'parece negação', confidence: 0.93 }));
    const provider = createDecisionProvider({ env: { ...JEV_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await provider.evaluate(request('turn-jev-on'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENV.TED_JUDGMENT_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      // The neutral `op` is mapped to the vendor operation INSIDE the adapter.
      operation: 'jev_decide',
      model: 'judgment-model-v1',
      question: CONTINUATION_REQUEST.questions.relation.instructions,
      state: JSON.stringify(CONTINUATION_REQUEST.state),
      options: ['correction', 'negation', 'continuation'],
    });
    expect(outcome).toMatchObject({ provider: 'jev', status: 'decision', confidence: 0.93, advisory: true });
    expect(outcome.answers?.relation?.value).toBe('negation');
  });

  it('rejects a value outside the question criteria and a 401 without inventing confidence', async () => {
    const outside = createDecisionProvider({
      env: { ...JEV_ENV },
      fetchImpl: (async () => json({ choice: 'approve_write', confidence: 0.99 })) as unknown as typeof fetch,
    });
    expect((await outside.evaluate(request('turn-jev-outside'))).reason).toBe('value_outside_allowlist');

    const unauthorized = createDecisionProvider({
      env: { ...JEV_ENV },
      fetchImpl: (async () => json({ error: 'nope' }, 401)) as unknown as typeof fetch,
    });
    expect((await unauthorized.evaluate(request('turn-jev-401'))).reason).toBe('unauthorized');
  });
});

describe('issue #86 — the Clef adapter uses the native Workers AI binding', () => {
  it('is fail-closed when the AI binding is ABSENT (binding is a rollout step, not code)', async () => {
    const fetchImpl = vi.fn();
    const provider = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'clef' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(provider.available).toBe(false);
    expect((await provider.evaluate(request('turn-clef-nobinding'))).reason).toBe('binding_missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the default model with the Jev-compatible { state, questions } body', async () => {
    const ai = aiStub(compatibleAnswers('negation', 0.88));
    const provider = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'clef', AI: ai.binding } });
    const outcome = await provider.evaluate(request('turn-clef-on'));

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run.mock.calls[0]?.[0]).toBe('@cf/cloudflare/clef');
    expect(ai.run.mock.calls[0]?.[1]).toEqual({
      state: JSON.stringify(CONTINUATION_REQUEST.state),
      questions: CONTINUATION_REQUEST.questions,
    });
    expect(outcome).toMatchObject({ provider: 'clef', status: 'decision', confidence: 0.88, advisory: true });
    expect(outcome.answers?.relation?.value).toBe('negation');
  });

  it('honours TED_DECISION_CLEF_MODEL and abstains on a malformed or out-of-list answer', async () => {
    const flash = aiStub(compatibleAnswers('continuation', 0.91));
    const overridden = createDecisionProvider({
      env: { TED_DECISION_PROVIDER: 'clef', TED_DECISION_CLEF_MODEL: '@cf/cloudflare/clef-flash', AI: flash.binding },
    });
    await overridden.evaluate(request('turn-clef-model'));
    expect(flash.run.mock.calls[0]?.[0]).toBe('@cf/cloudflare/clef-flash');

    const malformed = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'clef', AI: aiStub({ response: {} }).binding } });
    expect((await malformed.evaluate(request('turn-clef-malformed'))).reason).toBe('malformed_response');

    const outside = createDecisionProvider({
      env: { TED_DECISION_PROVIDER: 'clef', AI: aiStub(compatibleAnswers('approve_write', 0.99)).binding },
    });
    expect((await outside.evaluate(request('turn-clef-outside'))).reason).toBe('value_outside_allowlist');

    const thrown = createDecisionProvider({
      env: { TED_DECISION_PROVIDER: 'clef', AI: { run: async () => { throw new Error('binding unavailable'); } } },
    });
    expect((await thrown.evaluate(request('turn-clef-throw'))).reason).toBe('transport_error');
  });
});

describe('issue #86 — the Strands adapter posts to the operator-controlled URL', () => {
  it('is unavailable without TED_DECISION_STRANDS_URL', async () => {
    const provider = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'strands' } });
    expect(provider.available).toBe(false);
    expect((await provider.evaluate(request('turn-strands-off'))).reason).toBe('not_configured');
  });

  it('POSTs to <url>/v1/systemone without following redirects and without any credential', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(compatibleAnswers('continuation', 0.84)));
    const provider = createDecisionProvider({
      env: { ...STRANDS_ENV, TED_DECISION_STRANDS_URL: 'http://127.0.0.1:8000/' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await provider.evaluate(request('turn-strands-on'));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(String(init.body))).toEqual({
      state: JSON.stringify(CONTINUATION_REQUEST.state),
      questions: CONTINUATION_REQUEST.questions,
    });
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).toEqual(['content-type', 'accept']);
    expect(outcome).toMatchObject({ provider: 'strands', status: 'decision', confidence: 0.84, advisory: true });
  });

  it('maps 401 and a malformed body to typed abstentions, never to a fabricated answer', async () => {
    const unauthorized = createDecisionProvider({
      env: { ...STRANDS_ENV },
      fetchImpl: (async () => json({ error: 'no' }, 403)) as unknown as typeof fetch,
    });
    expect((await unauthorized.evaluate(request('turn-strands-403'))).reason).toBe('unauthorized');

    const malformed = createDecisionProvider({
      env: { ...STRANDS_ENV },
      fetchImpl: (async () => new Response('<html>gateway</html>', { status: 200 })) as unknown as typeof fetch,
    });
    expect((await malformed.evaluate(request('turn-strands-html'))).reason).toBe('malformed_response');
  });
});

describe('issue #86 — one instance per Durable Object keeps the state meaningful', () => {
  it('reuses the SAME instance per scope, isolates scopes, and keeps the turn budget across turns', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(compatibleAnswers('continuation', 0.9)));
    const deps = { env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch };
    const doA = {};
    const doB = {};

    const a1 = decisionProviderForDo(doA, deps);
    const a2 = decisionProviderForDo(doA, deps);
    const b1 = decisionProviderForDo(doB, deps);

    expect(a1).toBe(a2);
    expect(b1).not.toBe(a1);

    // The budget lives in the INSTANCE: a second turn through the same accessor
    // with the same turn id cannot re-buy a consultation.
    expect((await a1.evaluate(request('turn-per-do'))).status).toBe('decision');
    expect((await decisionProviderForDo(doA, deps).evaluate(request('turn-per-do'))).reason).toBe('turn_budget_exhausted');
    // A different DO has its own budget.
    expect((await b1.evaluate(request('turn-per-do'))).status).toBe('decision');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('issue #86 — the deterministic value is authoritative on every path', () => {
  const hostileProvider = (outcome: DecisionOutcome): DecisionProvider => ({
    provider: 'hostile',
    available: true,
    minConfidence: DECISION_DEFAULT_MIN_CONFIDENCE,
    evaluate: async () => outcome,
    stats: () => ({ calls: 1, decisions: 1, abstentions: 0, unavailables: 0, breakerOpens: 0 }),
  });

  it('returns the deterministic value even when the outcome claims to have approved a write', async () => {
    const outcome = {
      provider: 'hostile',
      status: 'decision',
      // A provider cannot widen the contract, but it CAN return extra runtime
      // keys; nothing downstream reads them, and `value` stays deterministic.
      answers: { relation: { value: 'correction', confidence: 0.99 } },
      confidence: 0.99,
      approved: true,
      capability: 'financial.write',
      advisory: true,
    } as unknown as DecisionOutcome;

    const resolution = await resolveWithDecision('negation', { provider: hostileProvider(outcome), request: CONTINUATION_REQUEST });

    expect(resolution.value).toBe('negation');
    expect(resolution.source).toBe('decision_advisory');
    expect(Object.keys(resolution)).toEqual(['value', 'source', 'decision']);
    // The advisory answer is preserved as telemetry, revalidated by the domain.
    expect(resolution.decision.answers?.relation?.value).toBe('correction');
  });

  it('abstains when the outcome carries no valid confidence, even if it claims `decision`', async () => {
    const lying = {
      provider: 'hostile',
      status: 'decision',
      answers: { relation: { value: 'correction' } },
      advisory: true,
    } as DecisionOutcome;

    const resolution = await resolveWithDecision('negation', { provider: hostileProvider(lying), request: CONTINUATION_REQUEST });

    expect(resolution.value).toBe('negation');
    expect(resolution.source).toBe('deterministic');
    expect(resolution.decision).toMatchObject({ status: 'abstained', reason: 'low_confidence', advisory: true });
    expect(resolution.decision.answers).toBeUndefined();
  });

  it('is deterministic when the provider is unavailable or abstains, and survives a throwing provider', async () => {
    const off = createDecisionProvider({ env: {} });
    expect(await resolveWithDecision('continuation', { provider: off, request: CONTINUATION_REQUEST })).toMatchObject({
      value: 'continuation',
      source: 'deterministic',
      decision: { status: 'unavailable', reason: 'not_configured' },
    });

    const abstainedOutcome = await resolveWithDecision('continuation', {
      provider: hostileProvider({ provider: 'hostile', status: 'abstained', reason: 'timeout', advisory: true }),
      request: CONTINUATION_REQUEST,
    });
    expect(abstainedOutcome).toMatchObject({ value: 'continuation', source: 'deterministic' });

    const thrower: DecisionProvider = { ...hostileProvider({ provider: 'hostile', status: 'decision', confidence: 1, advisory: true }), evaluate: async () => { throw new Error('boom'); } };
    await expect(resolveWithDecision('negation', { provider: thrower, request: CONTINUATION_REQUEST })).rejects.toThrow('boom');
  });
});

/**
 * R1 — a provider the operator CONFIGURED but that cannot work is a rollout
 * mistake, not a default-off posture. Both used to be invisible: the short
 * circuit on `available === false` emitted nothing and the resolver collapsed
 * every unavailability into `not_configured`, so a typo'd provider name or a
 * Clef without its binding looked exactly like an operator who never turned the
 * feature on. The reason must be readable SYNCHRONOUSLY (no await, no fetch) so
 * the caller can decide to be loud — and default-off stays byte-for-byte silent.
 */
describe('issue #86/R1 — a MISCONFIGURED provider exposes its reason synchronously', () => {
  it('reads the reason from the provider itself, with zero network and zero promise', () => {
    const fetchImpl = vi.fn();
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };

    // Selected, but the Workers AI binding was never deployed.
    const clef = createDecisionProvider({ ...deps, env: { TED_DECISION_PROVIDER: 'clef' } });
    // Selected, but the name does not exist in the closed enum (a typo).
    const typo = createDecisionProvider({ ...deps, env: { TED_DECISION_PROVIDER: 'openai-judge' } });

    expect([clef.available, clef.unavailableReason]).toEqual([false, 'binding_missing']);
    expect([typo.available, typo.unavailableReason]).toEqual([false, 'provider_not_supported']);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The reason is a plain property: reading it never creates a promise, so the
    // hot path can stay synchronous exactly as it is today.
    expect(typeof clef.unavailableReason).toBe('string');
  });

  it('default-off stays `not_configured`, and an AVAILABLE provider carries no reason at all', () => {
    const off = createDecisionProvider({ env: {} });
    expect([off.available, off.unavailableReason]).toEqual([false, 'not_configured']);

    const on = createDecisionProvider({
      env: { ...STRANDS_ENV },
      fetchImpl: (async () => json(compatibleAnswers('continuation', 0.9))) as unknown as typeof fetch,
    });
    expect(on.available).toBe(true);
    expect(on.unavailableReason).toBeUndefined();
  });

  /**
   * R6 — the outcome's `provider` is a plain assignment, not a no-op ternary:
   * `providerName` is DERIVED from `transport.name` (or `none` when no
   * transport exists), so the layer's name is authoritative by construction and
   * a transport's self-reported label can never reach telemetry. Pinned here so
   * the comment at the assignment cannot drift away from the code.
   */
  it('the layer name is derived from the SELECTION, and it is what every outcome carries', async () => {
    // Case and surrounding space are normalized, so the derived name is canonical.
    for (const raw of ['JEV', ' jev ', 'JEV']) {
      const provider = createDecisionProvider({
        env: { ...JEV_ENV, TED_DECISION_PROVIDER: raw },
        fetchImpl: (async () => json({ choice: 'continuation', confidence: 0.9 })) as unknown as typeof fetch,
      });
      expect(provider.available).toBe(true);
      expect(provider.provider).toBe('jev');
      // The outcome carries the LAYER's name, never the raw env value.
      expect((await provider.evaluate(request(`r6-${raw.trim()}`))).provider).toBe('jev');
    }

    // An unsupported name still reports the canonical `none`, never the raw typo.
    const typo = createDecisionProvider({ env: { TED_DECISION_PROVIDER: 'OpenAI-Judge' } });
    expect(typo.provider).toBe('none');
    expect((await typo.evaluate(request('r6-typo'))).provider).toBe('none');
  });

  it('the RESOLVER preserves the reason instead of collapsing it into not_configured', async () => {
    for (const [env, reason] of [
      [{ TED_DECISION_PROVIDER: 'clef' }, 'binding_missing'],
      [{ TED_DECISION_PROVIDER: 'openai-judge' }, 'provider_not_supported'],
      [{}, 'not_configured'],
    ] as const) {
      const provider = createDecisionProvider({ env });
      const resolution = await resolveWithDecision('continuation', { provider, request: CONTINUATION_REQUEST });
      expect(resolution).toMatchObject({
        value: 'continuation',
        source: 'deterministic',
        decision: { status: 'unavailable', reason },
      });
    }
  });
});

/**
 * R2 — the breaker must mean ONE thing. A16's boundary counts an answer outside
 * the allowlist as provider health; the general layer did not, so the Jev path
 * opened a circuit internally while the general counters kept reporting a closed
 * breaker. Alignment chosen: (a) the GENERAL layer counts an invalid answer as a
 * health failure too. Rejected alternative: (b) telling the adapter to stop
 * counting — that would weaken the reused A16 boundary's own, already-shipped
 * policy (and its suite) to accommodate the newer abstraction.
 */
describe('issue #86/R2 — the breaker agrees across the general layer and the reused A16 boundary', () => {
  const A16_REQUEST: JudgmentRequest = {
    turnId: 'a16-turn',
    operation: 'jev_decide',
    state: '{}',
    question: 'Classifique a relação deste turno.',
    options: ['correction', 'negation', 'continuation'],
  };

  it('the reused A16 boundary counts an outside-allowlist answer as health (its own rule, kept)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ choice: 'aprovar_lancamento' }));
    const boundary = createJudgmentProvider({
      env: {
        TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
        TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await boundary.evaluate({ ...A16_REQUEST, turnId: 'a16-1' });
    const second = await boundary.evaluate({ ...A16_REQUEST, turnId: 'a16-2' });
    const third = await boundary.evaluate({ ...A16_REQUEST, turnId: 'a16-3' });

    // `reason` only exists off the `decision` variant, and the sequence under
    // test is entirely refusals: reading it through a narrowing helper keeps the
    // assertion honest instead of casting the union away.
    const reasonOf = (outcome: JudgmentOutcome): string => (outcome.status === 'decision' ? 'decision' : outcome.reason);
    expect([reasonOf(first), reasonOf(second), reasonOf(third)]).toEqual([
      'choice_outside_allowlist',
      'choice_outside_allowlist',
      'circuit_open',
    ]);
    expect(boundary.stats().breakerOpens).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('the GENERAL layer does the same, for EVERY adapter — no adapter may disagree', async () => {
    const cases = [
      {
        name: 'strands',
        fetchImpl: vi.fn().mockImplementation(async () => json(compatibleAnswers('aprovar_lancamento', 0.99))),
        env: { ...STRANDS_ENV },
      },
      {
        name: 'jev',
        fetchImpl: vi.fn().mockImplementation(async () => json({ choice: 'aprovar_lancamento', confidence: 0.99 })),
        env: { ...JEV_ENV },
      },
    ] as const;

    for (const testCase of cases) {
      const provider = createDecisionProvider({ env: testCase.env, fetchImpl: testCase.fetchImpl as unknown as typeof fetch });

      const outcomes = [
        await provider.evaluate(request(`${testCase.name}-a1`)),
        await provider.evaluate(request(`${testCase.name}-a2`)),
        await provider.evaluate(request(`${testCase.name}-a3`)),
      ];
      // Two refusals, then the circuit: the same sequence as the A16 boundary.
      // `value_outside_allowlist` is still a CONTENT refusal (never an answer),
      // but an unusable answer is also evidence the provider is not healthy.
      expect(outcomes.map((outcome) => outcome.reason), testCase.name).toEqual([
        'value_outside_allowlist',
        'value_outside_allowlist',
        'circuit_open',
      ]);
      expect(testCase.fetchImpl, testCase.name).toHaveBeenCalledTimes(DECISION_BREAKER_FAILURE_THRESHOLD);
      expect(provider.stats(), testCase.name).toMatchObject({ breakerOpens: 1, abstentions: 2, unavailables: 1 });
    }
  });
});

/**
 * R3 — a confidence outside [0,1] is not a low confidence, it is a MALFORMED
 * answer: `noul: 2` used to pass the gate, CLEAR the breaker as a success and
 * travel through telemetry as a probability. Policy chosen (documented): a
 * present-but-unusable probability is `malformed_response`, which is NOT a
 * content rejection and therefore DOES count against provider health; an ABSENT
 * or below-threshold confidence stays `low_confidence`.
 */
describe('issue #86/R3 — confidence outside [0,1] is malformed, never usable', () => {
  it.each([1.5, 100, -1])('the CLEF reader abstains as malformed on noul=%s', async (noul) => {
    const provider = createDecisionProvider({
      env: { TED_DECISION_PROVIDER: 'clef', AI: aiStub(compatibleAnswers('continuation', noul)).binding },
    });
    expect(await provider.evaluate(request(`r3-clef-${noul}`))).toEqual({
      provider: 'clef',
      status: 'abstained',
      reason: 'malformed_response',
      advisory: true,
    });
  });

  it.each([1.5, 100, -1])('the STRANDS reader abstains as malformed on noul=%s', async (noul) => {
    const provider = createDecisionProvider({
      env: { ...STRANDS_ENV },
      fetchImpl: (async () => json(compatibleAnswers('continuation', noul))) as unknown as typeof fetch,
    });
    expect((await provider.evaluate(request(`r3-strands-${noul}`))).reason).toBe('malformed_response');
  });

  it('the JEV adapter does not launder an out-of-range confidence reported by the boundary', async () => {
    const provider = createDecisionProvider({
      env: { ...JEV_ENV },
      fetchImpl: (async () => json({ choice: 'continuation', confidence: 100 })) as unknown as typeof fetch,
    });
    expect((await provider.evaluate(request('r3-jev'))).reason).toBe('malformed_response');
  });

  it('NaN is rejected too (a real NaN reaches the reader through the AI binding)', async () => {
    const provider = createDecisionProvider({
      env: { TED_DECISION_PROVIDER: 'clef', AI: aiStub(compatibleAnswers('continuation', Number.NaN)).binding },
    });
    expect((await provider.evaluate(request('r3-clef-nan'))).reason).toBe('malformed_response');
  });

  it('a malformed answer is NOT a breaker success: it counts as a health failure', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(compatibleAnswers('continuation', 2)));
    const provider = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect((await provider.evaluate(request('r3-b1'))).reason).toBe('malformed_response');
    // Two malformed answers open the circuit, exactly like any other illness.
    expect((await provider.evaluate(request('r3-b2'))).reason).toBe('malformed_response');
    expect((await provider.evaluate(request('r3-b3'))).reason).toBe('circuit_open');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(provider.stats().breakerOpens).toBe(1);
  });

  it('the RESOLVER refuses it too, even from a provider the layer did not build', async () => {
    for (const confidence of [1.5, 100, -1, Number.NaN]) {
      const lying = {
        provider: 'hostile',
        status: 'decision',
        answers: { relation: { value: 'correction', confidence } },
        confidence,
        advisory: true,
      } as DecisionOutcome;
      const hostile: DecisionProvider = {
        provider: 'hostile',
        available: true,
        minConfidence: DECISION_DEFAULT_MIN_CONFIDENCE,
        evaluate: async () => lying,
        stats: () => ({ calls: 1, decisions: 1, abstentions: 0, unavailables: 0, breakerOpens: 0 }),
      };

      const resolution = await resolveWithDecision('negation', { provider: hostile, request: CONTINUATION_REQUEST });
      expect(resolution.value, `confidence=${confidence}`).toBe('negation');
      expect(resolution.source, `confidence=${confidence}`).toBe('deterministic');
      expect(resolution.decision, `confidence=${confidence}`).toMatchObject({ status: 'abstained', reason: 'malformed_response' });
      expect(resolution.decision.answers).toBeUndefined();
    }
  });
});

/**
 * R4 — the two numeric ceilings were decorative to the suite: changing
 * `DECISION_TIMEOUT_MS` to 2 kept every test green. They are now asserted as
 * values AND exercised as behaviour, with the REAL default deadline and no
 * injected `timeoutMs`.
 */
describe('issue #86/R4 — the numeric ceilings are pinned and really enforced', () => {
  it('pins the two constants (changing either must now fail this suite)', () => {
    expect(DECISION_TIMEOUT_MS).toBe(2_000);
    expect(DECISION_MAX_CALLS_PER_TURN).toBe(1);
  });

  it('fires the DEFAULT 2 s deadline for real, with a fetch stub that honours the signal', async () => {
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      // A real fetch rejects on abort; the stub reproduces that contract, so the
      // test proves the DEADLINE is what ended the attempt, not the stub.
      const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push('aborted');
            reject(new Error('The operation was aborted.'));
          });
        }),
      ) as unknown as typeof fetch;

      const provider = createDecisionProvider({ env: { ...STRANDS_ENV }, fetchImpl });
      const pending = provider.evaluate(request('turn-default-deadline'));

      // One millisecond short of the deadline the attempt is still in flight.
      await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS - 1);
      expect(await Promise.race([pending, Promise.resolve('in-flight')])).toBe('in-flight');

      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ status: 'abstained', reason: 'timeout', advisory: true });
      expect(aborted).toEqual(['aborted']);
    } finally {
      vi.useRealTimers();
    }
  });
});
