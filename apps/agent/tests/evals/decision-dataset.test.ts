/**
 * Issue #86 — replayable eval harness for the decision layer.
 *
 * `evals/decision-dataset.json` holds realistic pt-BR turns (typos, fragments,
 * incomplete and ambiguous messages, clarification-required cases) mapped to the
 * ONE operation this repo implements: `continuation_relation`.
 *
 * WHAT THIS HARNESS MEASURES, STATED HONESTLY:
 *
 * - **Replay vs the deterministic oracle: 100% BY CONSTRUCTION.** The resolver
 *   returns the deterministic value on every path, so accuracy here is 100% by
 *   definition and proves only that the layer cannot change an outcome. It is
 *   NOT a measure of model quality, and the dataset says so in its `honesty`
 *   field so nobody later reads 100% as a quality claim.
 * - **Advisory agreement and fallback rates** are the real signal here: how often
 *   the provider AGREES with the heuristic, how often it DISAGREES (and the
 *   outcome still does not move), and how often the confidence policy or a
 *   failure sends the turn back to the deterministic path.
 * - **Accuracy, calibration, latency and cost against a REAL provider stay
 *   PENDING.** The layer is default-off, the repo holds no credential and the
 *   `AI` binding is not deployed. No such number is invented here; the dataset
 *   records what a real run would require.
 *
 * The replay uses a stub transport, so the suite has no network and no binding.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DECISION_DEFAULT_MIN_CONFIDENCE,
  createDecisionProvider,
  type DecisionOutcome,
} from '../../src/decision/provider.js';
import {
  CONTINUATION_RELATION_CHOICES,
  CONTINUATION_RELATION_QUESTION,
  continuationRelationDecisionRequest,
  resolveContinuationRelation,
  type ContinuationRelationFacts,
} from '../../src/decision/wiring.js';

type EvalCase = Readonly<{
  id: string;
  dimension: string;
  text: string;
  note: string;
  draftStatus: string;
  pendingFieldCount: number;
  negationMarker: boolean;
  deterministicRelation: (typeof CONTINUATION_RELATION_CHOICES)[number];
  advisoryProbe: (typeof CONTINUATION_RELATION_CHOICES)[number];
  advisoryConfidence: number;
}>;

type Dataset = Readonly<{
  version: string;
  operation: string;
  oracle: string;
  honesty: string;
  dimensions: Readonly<{
    covered: readonly string[];
    pendingNewOperation: readonly string[];
    note: string;
  }>;
  realProvider: Readonly<{ status: string; requires: readonly string[]; blockedBy: string; command: string }>;
  cases: readonly EvalCase[];
}>;

const DATASET = JSON.parse(
  readFileSync(new URL('../../evals/decision-dataset.json', import.meta.url), 'utf8'),
) as Dataset;

/** Replays one case through a provider stub that answers `advisoryProbe`. */
const replayWithProvider = async (
  testCase: EvalCase,
): Promise<{ decision: DecisionOutcome; value: string; source: string }> => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ response: { answers: { relation: { choice: testCase.advisoryProbe, noul: testCase.advisoryConfidence } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  const provider = createDecisionProvider({
    env: { TED_DECISION_PROVIDER: 'strands', TED_DECISION_STRANDS_URL: 'http://127.0.0.1:8000' },
    fetchImpl,
  });
  const facts: ContinuationRelationFacts = {
    turnId: `eval-${testCase.id}`,
    draftStatus: testCase.draftStatus,
    pendingFieldCount: testCase.pendingFieldCount,
    negationMarker: testCase.negationMarker,
    deterministicRelation: testCase.deterministicRelation,
  };
  const resolution = await resolveContinuationRelation(testCase.deterministicRelation, { provider, facts });
  // The value is what the TURN would do with. Everything else is telemetry.
  expect(resolution.value, testCase.id).toBe(testCase.deterministicRelation);
  return { decision: resolution.decision, value: resolution.value, source: resolution.source };
};

describe('issue #86 — decision eval dataset is well formed', () => {
  it('declares its oracle, its honesty note and a PENDING real-provider status', () => {
    expect(DATASET.operation).toBe('continuation_relation');
    expect(DATASET.oracle).toMatch(/deterministic heuristic/i);
    expect(DATASET.honesty).toMatch(/100% BY CONSTRUCTION/);
    expect(DATASET.honesty).toMatch(/PENDING/i);
    expect(DATASET.realProvider.status).toBe('pending');
    expect(DATASET.realProvider.requires.length).toBeGreaterThan(0);
  });

  it('covers every declared dimension with at least one realistic pt-BR case', () => {
    expect(DATASET.cases.length).toBeGreaterThanOrEqual(12);
    for (const dimension of DATASET.dimensions.covered) {
      expect(DATASET.cases.filter((entry) => entry.dimension === dimension).length, dimension).toBeGreaterThan(0);
    }
    // Uses the issue lists that no operation implements yet are declared, not
    // silently missing and not faked with a case that measures nothing.
    expect(DATASET.dimensions.pendingNewOperation).toContain('category_ranking');
    const measuredDimensions = new Set(DATASET.cases.map((entry) => entry.dimension));
    for (const pending of DATASET.dimensions.pendingNewOperation) {
      expect(measuredDimensions.has(pending)).toBe(false);
    }
  });

  it('every case is closed-typed, uniquely identified and carries a realistic turn', () => {
    const ids = new Set<string>();
    for (const testCase of DATASET.cases) {
      expect(ids.has(testCase.id), testCase.id).toBe(false);
      ids.add(testCase.id);
      expect(CONTINUATION_RELATION_CHOICES).toContain(testCase.deterministicRelation);
      expect(CONTINUATION_RELATION_CHOICES).toContain(testCase.advisoryProbe);
      expect(testCase.advisoryConfidence).toBeGreaterThanOrEqual(0);
      expect(testCase.advisoryConfidence).toBeLessThanOrEqual(1);
      expect(typeof testCase.pendingFieldCount).toBe('number');
      // pt-BR turns, not placeholders.
      expect(testCase.text.trim().length).toBeGreaterThan(0);
      expect(testCase.note.length).toBeGreaterThan(0);
    }
  });
});

describe('issue #86 — replay vs the deterministic oracle (100% by construction)', () => {
  it('with no provider the resolution IS the oracle on every case, zero network', async () => {
    for (const testCase of DATASET.cases) {
      const facts: ContinuationRelationFacts = {
        turnId: `eval-baseline-${testCase.id}`,
        draftStatus: testCase.draftStatus,
        pendingFieldCount: testCase.pendingFieldCount,
        negationMarker: testCase.negationMarker,
        deterministicRelation: testCase.deterministicRelation,
      };
      const resolution = await resolveContinuationRelation(testCase.deterministicRelation, { facts });
      expect(resolution.value, testCase.id).toBe(testCase.deterministicRelation);
      expect(resolution.source, testCase.id).toBe('deterministic');
      expect(resolution.decision.status, testCase.id).toBe('unavailable');
    }
  });

  it('the request built from a case carries NO user content — text, amount or merchant', () => {
    // The question is a wiring CONSTANT, so the payload is compared with it
    // removed: what must not appear is any word the USER typed.
    for (const testCase of DATASET.cases) {
      const request = continuationRelationDecisionRequest({
        turnId: `eval-request-${testCase.id}`,
        draftStatus: testCase.draftStatus,
        pendingFieldCount: testCase.pendingFieldCount,
        negationMarker: testCase.negationMarker,
        deterministicRelation: testCase.deterministicRelation,
      });
      const serialized = JSON.stringify(request);
      const questionless = serialized.split(CONTINUATION_RELATION_QUESTION).join('');
      // The question is a wiring CONSTANT and the turn key is local identity, so
      // both are excluded before looking for CONTENT: what must not appear is any
      // word, amount or merchant the USER typed.
      const contentFree = questionless.split(request.turnId).join('');
      const words = testCase.text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3);
      for (const word of words) {
        expect(contentFree.toLowerCase(), `${testCase.id} leaked "${word}"`).not.toContain(word);
      }
      // No merchant, amount or account vocabulary anywhere in the payload.
      expect(contentFree).not.toMatch(/padaria|mercado|carne|lugar|categoria|r\$|\d{2,}/i);
      expect(Object.keys(request.state).sort()).toEqual([
        'activeDraft',
        'deterministicRelation',
        'draftStatus',
        'negationMarker',
        'pendingFieldCount',
      ]);
    }
  });
});

describe('issue #86 — replay vs a provider stub proves the harness itself', () => {
  it('the dataset contains BOTH agreeing and disagreeing probes, so disagreement is exercised', () => {
    const agreeing = DATASET.cases.filter((entry) => entry.advisoryProbe === entry.deterministicRelation);
    const disagreeing = DATASET.cases.filter((entry) => entry.advisoryProbe !== entry.deterministicRelation);
    // Without a disagreeing case this suite would only ever prove the happy path.
    expect(agreeing.length).toBeGreaterThan(0);
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('above the threshold the advisory answer is kept — and still changes no outcome', async () => {
    const above = DATASET.cases.filter((entry) => entry.advisoryConfidence >= DECISION_DEFAULT_MIN_CONFIDENCE);
    expect(above.length).toBeGreaterThan(0);
    for (const testCase of above) {
      const { decision } = await replayWithProvider(testCase);
      expect(decision.status, testCase.id).toBe('decision');
      expect(decision.answers?.relation?.value, testCase.id).toBe(testCase.advisoryProbe);
    }
  });

  it('below the threshold the answer is DROPPED and the turn takes the deterministic path', async () => {
    const below = DATASET.cases.filter((entry) => entry.advisoryConfidence < DECISION_DEFAULT_MIN_CONFIDENCE);
    expect(below.length).toBeGreaterThan(0);
    for (const testCase of below) {
      const { decision } = await replayWithProvider(testCase);
      expect(decision, testCase.id).toEqual({
        provider: 'strands',
        status: 'abstained',
        reason: 'low_confidence',
        advisory: true,
      });
    }
  });

  it('an unavailable provider falls back on every case, with no fabricated answer', async () => {
    const provider = createDecisionProvider({ env: {} });
    for (const testCase of DATASET.cases) {
      const resolution = await resolveContinuationRelation(testCase.deterministicRelation, {
        provider,
        facts: {
          turnId: `eval-off-${testCase.id}`,
          draftStatus: testCase.draftStatus,
          pendingFieldCount: testCase.pendingFieldCount,
          negationMarker: testCase.negationMarker,
          deterministicRelation: testCase.deterministicRelation,
        },
      });
      expect(resolution.value, testCase.id).toBe(testCase.deterministicRelation);
      expect(resolution.source, testCase.id).toBe('deterministic');
      expect(resolution.decision.answers, testCase.id).toBeUndefined();
    }
  });

  it('summarizes the replay so the numbers come from the data, not from prose', async () => {
    const stats = {
      cases: DATASET.cases.length,
      advisoryAgrees: 0,
      advisoryDisagrees: 0,
      aboveThreshold: 0,
      fellBackToDeterministic: 0,
      outcomeChanges: 0,
    };
    for (const testCase of DATASET.cases) {
      if (testCase.advisoryProbe === testCase.deterministicRelation) stats.advisoryAgrees += 1;
      else stats.advisoryDisagrees += 1;
      const { decision, value } = await replayWithProvider(testCase);
      if (decision.status === 'decision') stats.aboveThreshold += 1;
      else stats.fellBackToDeterministic += 1;
      // The invariant behind "replay vs oracle = 100%": nothing a provider says
      // can move the value the turn acts on. Advisory disagreement is a
      // TELEMETRY fact, not an outcome change.
      if (value !== testCase.deterministicRelation) stats.outcomeChanges += 1;
    }
    expect(stats.aboveThreshold + stats.fellBackToDeterministic).toBe(stats.cases);
    expect(stats.outcomeChanges).toBe(0);
    expect(stats.advisoryDisagrees).toBeGreaterThan(0);
    console.log('decision-eval replay', JSON.stringify(stats));
  });
});
