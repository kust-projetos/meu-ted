/**
 * F2-A A/B runner — frozen F1 artifacts are READ-ONLY inputs.
 *
 * The candidate is the ACTUAL output of `parseStructuredLLMOutput` over each
 * fixture's `llmJson`. The expectation is the frozen F1 oracle; the fixture no
 * longer carries a redundant expected copy.
 *
 * Honesty rules (hard):
 *  - every one of the 60 scenario IDs + 10 journey IDs is covered; IDs without
 *    an independent candidate are INCONCLUSIVE (never invented, never PASS);
 *  - original F1 classifications/completions are carried through unchanged;
 *  - `clarify` and undo-proposal taxonomies are not represented by this schema:
 *    they are INCONCLUSIVE, never FAIL;
 *  - safety is a structural invariant (asserted in the adapter tests), not a
 *    scored dimension; financial completion is always `unobservable`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareF2A,
  compareF2AJourney,
  type F2ACandidate,
  type F2AComparison,
  type F2AOracle,
} from '../../src/poc-structured/ab-compare.js';
import {
  parseStructuredLLMOutput,
  toCandidate,
} from '../../src/poc-structured/structured-interpretation.js';
import { CANDIDATE_FIXTURES } from './fixtures.js';
import {
  FROZEN_ARTIFACT_COMMIT,
  FROZEN_ARTIFACT_SHA256,
  loadFrozenArtifact,
  readFrozenArtifactBytes,
  type FrozenArtifactName,
} from './frozen-artifacts.js';

const runnerSourcePath = resolve(import.meta.dirname, 'f2a-ab-runner.test.ts');
const loaderSourcePath = resolve(import.meta.dirname, 'frozen-artifacts.ts');

type ScenarioOracle = {
  allowedRoutePlans: { mode: string; operations: string[] }[];
  completion: string;
  expectedArgs: Record<string, unknown>;
  clarificationRequired: boolean;
  clarificationNeedles: string[] | null;
};
type Scenario = { id: string; text: string; oracle: ScenarioOracle };
type JourneyTurn = { index: number; text: string };
type Journey = {
  id: string;
  expectedStages: string[];
  completion: string;
  turns: JourneyTurn[];
};
type BaselineScenario = { scenarioId: string; evidenceClassification: string };

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const loadScenarios = (): Scenario[] => {
  const raw = loadFrozenArtifact<{ baseline: string; scenarios: Scenario[] }>('scenarios');
  expect(raw.baseline).toBe('2b8a478fcc3d5df1ddbb52674795b57722a51799');
  return raw.scenarios;
};

const loadJourneys = (): Journey[] =>
  loadFrozenArtifact<{ journeys: Journey[] }>('journeys').journeys;

const loadBaseline = (): Map<string, string> => {
  const raw = loadFrozenArtifact<{ scenarios: BaselineScenario[] }>('baseline');
  return new Map(raw.scenarios.map((item) => [item.scenarioId, item.evidenceClassification]));
};

const scenarioOracle = (scenario: Scenario): F2AOracle => ({
  allowedModes: scenario.oracle.allowedRoutePlans.map((plan) => plan.mode),
  allowedOperations: scenario.oracle.allowedRoutePlans.flatMap((plan) => plan.operations),
  expectedArgs: scenario.oracle.expectedArgs,
  clarificationRequired: scenario.oracle.clarificationRequired,
  clarificationNeedles: scenario.oracle.clarificationNeedles,
});

const fixtureJson = (corpusId: string): Record<string, unknown> => {
  const fixture = CANDIDATE_FIXTURES.find((item) => item.corpusId === corpusId);
  if (!fixture) throw new Error(`missing fixture ${corpusId}`);
  return JSON.parse(fixture.llmJson) as Record<string, unknown>;
};

const candidate = (llmJson: string): F2ACandidate => toCandidate(parseStructuredLLMOutput(llmJson));

const candidateFor = (corpusId: string): F2ACandidate => candidate(JSON.stringify(fixtureJson(corpusId)));

const comparisonFor = (
  corpusId: string,
  candidateValue: F2ACandidate | null,
  scenario: Scenario,
  classification: string,
): F2AComparison =>
  compareF2A({
    corpusId,
    oracle: scenarioOracle(scenario),
    candidate: candidateValue,
    originalF1Classification: classification,
  });

const scenarioById = (scenarios: Scenario[], id: string): Scenario => {
  const scenario = scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`missing scenario ${id}`);
  return scenario;
};

describe('F2-A frozen artifacts (packaged byte-exact copies, pinned digests)', () => {
  it('keeps the full baseline provenance SHA and verifies every packaged copy hash', () => {
    // Provenance is a full commit SHA. Runtime never resolves it in Git: CI
    // checks out shallow, so the pinned commit is not reachable there.
    expect(FROZEN_ARTIFACT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    const names: readonly FrozenArtifactName[] = ['scenarios', 'journeys', 'baseline'];
    for (const name of names) {
      expect(sha256(readFrozenArtifactBytes(name)), name).toBe(FROZEN_ARTIFACT_SHA256[name]);
    }
  });

  it('loads packaged report bodies, never regenerated worktree files', () => {
    // The F1 generators rewrite these fields on every run: pinned values prove
    // A consumes the packaged copy, not a mutable regenerated report.
    expect(loadFrozenArtifact<{ generatedAt: string }>('baseline').generatedAt).toBe(
      '2026-10-24T17:16:20.203Z',
    );
    expect(loadFrozenArtifact<{ generatedAt: string }>('journeys').generatedAt).toBe(
      '2026-10-24T17:16:25.399Z',
    );
  });

  it('has no Git runtime dependency (shallow CI safe)', () => {
    const source = readFileSync(loaderSourcePath, 'utf8');
    // The previous loader shelled out to Git, which fails when the pinned
    // commit is absent from a shallow clone. Integrity now comes from the
    // pinned SHA-256 of the packaged bytes, not from Git ancestry.
    for (const token of [
      ['child', 'process'].join('_'),
      ['execFile', 'Sync'].join(''),
      ['rev-', 'parse'].join(''),
    ]) {
      expect(source, token).not.toContain(token);
    }
    expect(source).toContain('frozen');
  });
});

describe('F2-A A/B runner (actual parse, independent F1 oracle)', () => {
  it('covers all 60 scenario IDs; mapped fixtures PASS exactly, rest INCONCLUSIVE', () => {
    const scenarios = loadScenarios();
    const baseline = loadBaseline();
    expect(scenarios).toHaveLength(60);
    const fixtureIds = new Set(CANDIDATE_FIXTURES.map((fixture) => fixture.corpusId));

    const comparisons = scenarios.map((scenario) => {
      const classification = baseline.get(scenario.id);
      expect(classification, scenario.id).toBeDefined();
      const fixture = CANDIDATE_FIXTURES.find((item) => item.corpusId === scenario.id);
      return comparisonFor(
        scenario.id,
        fixture ? candidate(fixture.llmJson) : null,
        scenario,
        classification as string,
      );
    });

    const byId = new Map(comparisons.map((item) => [item.corpusId, item]));
    expect(byId.size).toBe(60);
    // Exact expected verdicts — never "PASS or FAIL".
    const expectedPass = [
      'F1-B001',
      'F1-B002',
      'F1-B008',
      'F1-B012',
      'F1-B013',
      'F1-B014',
      'F1-B030',
      'F1-B059',
    ];
    for (const id of expectedPass) {
      expect(byId.get(id)?.verdict, id).toBe('PASS');
      expect(byId.get(id)?.reasons, id).toContain('observable-dimensions-match');
    }
    const expectedInconclusive = scenarios
      .map((scenario) => scenario.id)
      .filter((id) => !expectedPass.includes(id));
    expect(expectedInconclusive).toHaveLength(52);
    for (const id of expectedInconclusive) {
      const item = byId.get(id);
      if (fixtureIds.has(id)) {
        // A fixture without a representable oracle is still not a PASS.
        expect(item?.verdict, id).toBe('INCONCLUSIVE');
      } else {
        expect(item?.verdict, id).toBe('INCONCLUSIVE');
        expect(item?.reasons, id).toEqual(['no-candidate']);
      }
    }
    // F1-B055 carries a BEHAVIORAL oracle (`confirmationMustBeSeparateTurn`)
    // this schema cannot observe: no turn boundary, no confirmation protocol,
    // no ledger. Observable dimensions can still be reported as partial match,
    // but the row must never become a global PASS.
    const b055 = byId.get('F1-B055');
    expect(b055?.verdict).toBe('INCONCLUSIVE');
    expect(b055?.reasons).toContain(
      'f1-expectation-unobservable:confirmationMustBeSeparateTurn',
    );
    expect(b055?.intent).toBe('match');
    expect(b055?.operation).toBe('match');
    expect(b055?.args).toBe('match');
    expect(b055?.clarification).toBe('match');
    expect(b055?.clarificationNeedles).toBe('match');
    // Original F1 classification travels unchanged on every row.
    for (const item of comparisons) {
      expect(item.originalF1Classification).toBe(baseline.get(item.corpusId));
      expect(item.financialCompletion).toBe('unobservable');
      // Safety is structural, never a scored field.
      expect(Object.prototype.hasOwnProperty.call(item, 'safetyHold')).toBe(false);
    }
    // The frozen baseline aggregate is preserved by construction (read-only).
    const counts = new Map<string, number>();
    for (const value of baseline.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
    expect(counts.get('PASS')).toBe(12);
    expect(counts.get('FAIL')).toBe(41);
    expect(counts.get('BLOCKED')).toBe(1);
    expect(counts.get('INCONCLUSIVE')).toBe(6);
  });

  it('corrupted candidate fails for the RIGHT reason (args, null-vs-absent, needles, intent)', () => {
    const scenarios = loadScenarios();
    const baseline = loadBaseline();
    const b001 = scenarioById(scenarios, 'F1-B001');
    const classification = baseline.get('F1-B001') as string;

    const missingNullSlot = fixtureJson('F1-B001');
    const args = (missingNullSlot.interpretation as Record<string, unknown>).args as Record<string, unknown>;
    delete args.accountId;
    const missing = comparisonFor('F1-B001', candidate(JSON.stringify(missingNullSlot)), b001, classification);
    expect(missing.verdict).toBe('FAIL');
    expect(missing.args).toBe('mismatch');
    // null != absent: the null slot was declared and is missing entirely.
    expect(missing.argsMismatchedKeys).toEqual(['accountId']);
    expect(missing.reasons).toContain('args-mismatch');

    const wrongNeedle = fixtureJson('F1-B001');
    (wrongNeedle.interpretation as Record<string, unknown>).clarification = 'Qual conta devo usar?';
    const needles = comparisonFor('F1-B001', candidate(JSON.stringify(wrongNeedle)), b001, classification);
    expect(needles.verdict).toBe('FAIL');
    expect(needles.clarification).toBe('match');
    expect(needles.clarificationNeedles).toBe('mismatch');
    expect(needles.clarificationNeedlesMissing).toEqual(['categoria']);
    expect(needles.reasons).toContain('clarification-needles-missing');

    const extraArg = fixtureJson('F1-B001');
    const extraArgs = (extraArg.interpretation as Record<string, unknown>).args as Record<string, unknown>;
    extraArgs.accountName = 'Conta principal';
    const spurious = comparisonFor('F1-B001', candidate(JSON.stringify(extraArg)), b001, classification);
    expect(spurious.verdict).toBe('FAIL');
    expect(spurious.argsMismatchedKeys).toEqual(['accountName']);

    const wrongIntent = fixtureJson('F1-B001');
    const record = wrongIntent.interpretation as Record<string, unknown>;
    record.intent = 'conversation';
    record.operation = 'none';
    record.args = {};
    record.ambiguities = ['scope'];
    record.clarification = 'Não entendi.';
    const intentMismatch = comparisonFor('F1-B001', candidate(JSON.stringify(wrongIntent)), b001, classification);
    expect(intentMismatch.verdict).toBe('FAIL');
    expect(intentMismatch.intent).toBe('mismatch');
    expect(intentMismatch.operation).toBe('mismatch');
    expect(intentMismatch.args).toBe('mismatch');
  });

  it('taxonomy gaps are INCONCLUSIVE, never structural FAIL', () => {
    const scenarios = loadScenarios();
    const baseline = loadBaseline();
    const clarifyCandidate = candidate(
      JSON.stringify({
        interpretation: {
          intent: 'unsupported',
          operation: 'none',
          args: {},
          contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B006' },
          entities: [],
          ambiguities: ['target'],
          clarification: 'Qual lançamento devo corrigir?',
        },
      }),
    );
    // F1 mode `clarify` is not expressible as a TurnPlan mode.
    for (const id of ['F1-B006', 'F1-B021', 'F1-B027']) {
      const item = comparisonFor(
        id,
        clarifyCandidate,
        scenarioById(scenarios, id),
        baseline.get(id) as string,
      );
      expect(item.verdict, id).toBe('INCONCLUSIVE');
      expect(item.reasons, id).toContain('f1-mode-not-representable:clarify');
      expect(item.intent, id).toBe('not-comparable');
    }
    // Authenticated undo-proposal is a capability this schema does not model.
    const undo = scenarioById(scenarios, 'F1-B007');
    const undoItem = comparisonFor(
      'F1-B007',
      candidate(
        JSON.stringify({
          interpretation: {
            intent: 'unsupported',
            operation: 'none',
            args: {},
            contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B007' },
            entities: [],
            ambiguities: ['capability'],
            clarification: 'Desfazer ainda não é suportado.',
          },
        }),
      ),
      undo,
      baseline.get('F1-B007') as string,
    );
    expect(undoItem.verdict).toBe('INCONCLUSIVE');
    expect(undoItem.reasons).toContain('f1-taxonomy-unsupported:undo-proposal');
    // Vocabulary this POC does not own is unsupported, not a mismatch.
    const b004 = scenarioById(scenarios, 'F1-B004');
    const b004Item = comparisonFor(
      'F1-B004',
      candidate(
        JSON.stringify({
          interpretation: {
            intent: 'mutation-proposal',
            operation: 'accounts.update',
            args: { accountId: 'a-1', expectedName: 'Aurora', accountName: 'Reserva' },
            contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B004' },
            entities: [],
            ambiguities: [],
            clarification: null,
          },
        }),
      ),
      b004,
      baseline.get('F1-B004') as string,
    );
    expect(b004Item.verdict).toBe('INCONCLUSIVE');
    expect(b004Item.reasons).toContain('args-vocabulary-unsupported:name');
  });

  it('covers all 10 journey IDs: no global PASS, original completion retained', () => {
    const journeys = loadJourneys();
    expect(journeys).toHaveLength(10);
    const fixture = CANDIDATE_FIXTURES.find((item) => item.corpusId === 'J01');
    const j01Candidate = fixture ? candidate(fixture.llmJson) : null;
    const comparisons = journeys.map((journey) =>
      compareF2AJourney({
        corpusId: journey.id,
        originalCompletion: journey.completion,
        expectedStage: journey.expectedStages[0],
        candidate: journey.id === 'J01' ? j01Candidate : null,
      }),
    );
    expect(comparisons).toHaveLength(10);
    for (const item of comparisons) {
      expect(item.verdict, item.corpusId).toBe('INCONCLUSIVE');
      expect(item.reasons, item.corpusId).toContain('journey-no-global-oracle');
      expect(item.financialCompletion).toBe('unobservable');
      const journey = journeys.find((entry) => entry.id === item.corpusId);
      expect(item.originalCompletion, item.corpusId).toBe(journey?.completion);
    }
    const j01 = comparisons.find((item) => item.corpusId === 'J01');
    expect(j01?.clarificationPresence).toBe('match');
    expect(j01?.reasons).not.toContain('journey-no-global-oracle:pass');
    for (const item of comparisons.filter((entry) => entry.corpusId !== 'J01')) {
      expect(item.clarificationPresence).toBe('not-comparable');
      expect(
        item.reasons.some(
          (reason) => reason.startsWith('journey-stage-not-scored:') || reason === 'no-candidate',
        ),
        item.corpusId,
      ).toBe(true);
    }
  });

  it('runner never compares a fixture to itself nor reads F1 system-A observations', () => {
    const source = readFileSync(runnerSourcePath, 'utf8');
    const forbidden = [
      ['fixture', 'expected'].join('.'),
      ['actual', 'Plan'].join(''),
      ['isolated', 'Route'].join(''),
    ];
    for (const token of forbidden) {
      expect(source, token).not.toContain(token);
    }
    // Fixtures carry candidate data only — no expected mirror to self-compare.
    for (const fixture of CANDIDATE_FIXTURES) {
      expect(Object.keys(fixture).sort()).toEqual(['corpusId', 'fixtureId', 'llmJson', 'text']);
    }
    expect(source).toContain('parseStructuredLLMOutput');
    expect(source).toContain('compareF2A');
  });
});
