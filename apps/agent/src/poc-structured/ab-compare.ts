/**
 * F2-A POC — A/B comparison helper (pure, local-only).
 *
 * Compares an ACTUAL structured candidate (parsed from the interpretation
 * fixture JSON, never from a hand-written copy) against the frozen F1 oracle.
 * The F1 artifact is the expectation; the fixture is the candidate.
 *
 * Scored dimensions: intent, operation, args, clarification presence and
 * clarification needle content. `clarify` and undo-proposal are F1 taxonomies
 * this schema does not represent: they are classified `not-comparable` and can
 * only produce INCONCLUSIVE, never FAIL from taxonomy shape.
 *
 * Safety (`safetyHold`) is a STRUCTURAL invariant of the POC (no execution
 * surface at all) and is deliberately NOT a scored field. Financial
 * completion is unobservable: there is no ledger, writer or execution here.
 * Same rule for behavioral meta expectations: `confirmationMustBeSeparateTurn`
 * has no turn boundary to observe, so such a row is INCONCLUSIVE with partial
 * dimension evidence, never a global PASS.
 */

import { getArgSpec } from './registry.js';
import type { StructuredContextProvenance, StructuredEntity, StructuredIntent } from './structured-interpretation.js';

export type DimensionVerdict = 'match' | 'mismatch' | 'not-comparable';

export type F2ACandidate = Readonly<{
  intent: StructuredIntent;
  operation: string;
  args: Readonly<Record<string, string | number | boolean | null>>;
  ambiguities: readonly string[];
  clarification: string | null;
  missingFields: readonly string[];
  entities: readonly StructuredEntity[];
  contextProvenance: StructuredContextProvenance;
  requestedAction?: string;
}>;

export type F2AOracle = Readonly<{
  allowedModes: readonly string[];
  allowedOperations: readonly string[];
  expectedArgs: Readonly<Record<string, unknown>>;
  clarificationRequired: boolean;
  clarificationNeedles: readonly string[] | null;
  expectedMissingFields?: readonly string[];
  expectedAmbiguities?: readonly string[];
  expectedEntities?: readonly StructuredEntity[];
  expectedContextProvenance?: StructuredContextProvenance;
  expectedRequestedAction?: string;
}>;

export type F2AComparison = Readonly<{
  corpusId: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  reasons: readonly string[];
  intent: DimensionVerdict;
  operation: DimensionVerdict;
  args: DimensionVerdict;
  clarification: DimensionVerdict;
  clarificationNeedles: DimensionVerdict;
  clarificationNeedlesMatched: readonly string[];
  clarificationNeedlesMissing: readonly string[];
  argsMismatchedKeys: readonly string[];
  /** Frozen F1 evidence classification, carried through unchanged. */
  originalF1Classification: string;
  financialCompletion: 'unobservable';
  missingFields: DimensionVerdict;
  ambiguities: DimensionVerdict;
  entities: DimensionVerdict;
  contextProvenance: DimensionVerdict;
  requestedAction: DimensionVerdict;
  capabilityAvailability: 'unknown' | 'unsupported';
}>;

/** F1 route modes this schema can express. `clarify` is intentionally absent. */
export const F1_MODE_TO_POC_INTENT: Readonly<Record<string, StructuredIntent>> = Object.freeze({
  read: 'read',
  'mutation-proposal': 'mutation-proposal',
  conversation: 'conversation',
  cancel: 'cancel',
  unsupported: 'unsupported',
  clarify: 'clarify',
});

/**
 * `expectedArgs` in the frozen F1 artifact mixes real argument values with
 * oracle meta-expectations. Meta keys are NOT args and are never compared as
 * slots; they stay documented in the F1 artifact.
 */
export const F1_META_EXPECTATION_KEYS: ReadonlySet<string> = new Set([
  'clarificationRequired',
  'confirmationMustBeSeparateTurn',
  'ambiguousYear',
  'candidateCount',
]);

/**
 * Meta expectations that assert BEHAVIOR this POC cannot observe: there is no
 * turn boundary, no confirmation protocol and no execution/ledger surface. A
 * scenario carrying one of these may report its observable dimensions as
 * partial matches, but it can never become a global PASS.
 */
export const F1_UNOBSERVABLE_EXPECTATION_KEYS: ReadonlySet<string> = new Set([
  'confirmationMustBeSeparateTurn',
]);

const UNDO_TARGET_MARKER = 'latest-own-actor-operation-only';

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const hasOwn = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const notComparable = (): DimensionVerdict => 'not-comparable';

const equalSets = (expected: readonly string[], actual: readonly string[]): boolean =>
  expected.length === actual.length && new Set(expected).size === expected.length &&
  actual.length === new Set(actual).size && expected.every((value) => actual.includes(value));

const equalEntities = (expected: readonly StructuredEntity[], actual: readonly StructuredEntity[]): boolean => {
  // G2c (relaxação autorizada uso pessoal, operador 2026-10-29): equivalência
  // semântica de description usa fold (NFD+lowercase); IDs/UUIDs e demais
  // kinds continuam exatos. A API preserva casing original (prova em
  // apps/api/tests/routes/transactions-write.test.ts).
  const key = (entity: StructuredEntity): string => JSON.stringify([
    entity.kind,
    entity.kind === 'description' ? fold(entity.value) : entity.value,
    entity.provenance,
  ]);
  return equalSets(expected.map(key), actual.map(key));
};

const equalContextProvenance = (expected: StructuredContextProvenance, actual: StructuredContextProvenance): boolean =>
  expected.origin === actual.origin && expected.corpusId === actual.corpusId &&
  expected.turnIndex === actual.turnIndex;

const compareArgs = (
  candidate: F2ACandidate,
  oracle: F2AOracle,
): Readonly<{
  verdict: DimensionVerdict;
  mismatchedKeys: readonly string[];
  reasons: readonly string[];
}> => {
  const expectedKeys = Object.keys(oracle.expectedArgs).filter(
    (key) => !F1_META_EXPECTATION_KEYS.has(key),
  );
  const candidateKeys = Object.keys(candidate.args);
  // An expected slot outside the POC argument vocabulary is an UNSUPPORTED
  // comparison, not a mismatch: never FAIL from a vocabulary gap.
  const unsupportedExpected = expectedKeys.filter((key) => getArgSpec(key) === undefined);
  if (unsupportedExpected.length > 0) {
    return {
      verdict: notComparable(),
      mismatchedKeys: Object.freeze([]),
      reasons: Object.freeze([`args-vocabulary-unsupported:${unsupportedExpected.join(',')}`]),
    };
  }
  const mismatched: string[] = [];
  const expectedKeySet = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!hasOwn(candidate.args as Readonly<Record<string, unknown>>, key)) {
      mismatched.push(key);
      continue;
    }
    const want = oracle.expectedArgs[key];
    const got = candidate.args[key];
    if (want === null) {
      // null is a VALUE: absent and null are different claims.
      if (got !== null) mismatched.push(key);
      continue;
    }
    if (typeof want === 'object') {
      // Nested expectations have no POC flat-slot equivalent.
      return { verdict: notComparable(), mismatchedKeys: [], reasons: [`args-nested-expectation:${key}`] };
    }
    // G2c (relaxação autorizada uso pessoal, operador 2026-10-29): só o
    // campo description compara por fold; IDs/UUIDs e demais slots exatos.
    if (key === 'description' && typeof want === 'string' && typeof got === 'string') {
      if (fold(want) !== fold(got)) mismatched.push(key);
      continue;
    }
    if (got !== want) mismatched.push(key);
  }
  for (const key of candidateKeys) {
    if (!expectedKeySet.has(key)) mismatched.push(key);
  }
  if (mismatched.length > 0) {
    return {
      verdict: 'mismatch',
      mismatchedKeys: Object.freeze([...new Set(mismatched)]),
      reasons: Object.freeze(['args-mismatch']),
    };
  }
  return {
    verdict: 'match',
    mismatchedKeys: Object.freeze([]),
    reasons: Object.freeze([]),
  };
};

const compareClarification = (
  candidate: F2ACandidate,
  oracle: F2AOracle,
): Readonly<{
  clarification: DimensionVerdict;
  needles: DimensionVerdict;
  matched: readonly string[];
  missing: readonly string[];
  reasons: readonly string[];
}> => {
  const actualText = candidate.clarification;
  const expected = oracle.clarificationRequired;
  const present = actualText !== null;
  const presenceMatch = present === expected;
  const clarification: DimensionVerdict = presenceMatch ? 'match' : 'mismatch';
  const reasons: string[] = [];
  if (!expected || oracle.clarificationNeedles === null) {
    if (expected) reasons.push('clarification-presence-only');
    return {
      clarification,
      needles: expected ? notComparable() : 'match',
      matched: Object.freeze([]),
      missing: Object.freeze([]),
      reasons: Object.freeze(reasons),
    };
  }
  if (actualText === null) {
    return {
      clarification,
      needles: 'mismatch',
      matched: Object.freeze([]),
      missing: Object.freeze([...oracle.clarificationNeedles]),
      reasons: Object.freeze(['clarification-missing']),
    };
  }
  const folded = fold(actualText);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const needle of oracle.clarificationNeedles) {
    if (folded.includes(fold(needle))) matched.push(needle);
    else missing.push(needle);
  }
  return {
    clarification,
    needles: missing.length === 0 ? 'match' : 'mismatch',
    matched: Object.freeze(matched),
    missing: Object.freeze(missing),
    reasons: Object.freeze(missing.length === 0 ? [] : ['clarification-needles-missing']),
  };
};

export const compareF2A = (input: {
  readonly corpusId: string;
  readonly oracle: F2AOracle;
  readonly candidate: F2ACandidate | null;
  readonly originalF1Classification: string;
}): F2AComparison => {
  const base = {
    corpusId: input.corpusId,
    originalF1Classification: input.originalF1Classification,
    financialCompletion: 'unobservable' as const,
  };
  if (input.candidate === null) {
    return {
      ...base,
      verdict: 'INCONCLUSIVE',
      reasons: Object.freeze(['no-candidate']),
      intent: notComparable(),
      operation: notComparable(),
      args: notComparable(),
      clarification: notComparable(),
      clarificationNeedles: notComparable(),
      clarificationNeedlesMatched: Object.freeze([]),
      clarificationNeedlesMissing: Object.freeze([]),
      argsMismatchedKeys: Object.freeze([]),
      missingFields: notComparable(), ambiguities: notComparable(), entities: notComparable(),
      contextProvenance: notComparable(), requestedAction: notComparable(), capabilityAvailability: 'unknown',
    };
  }

  const reasons: string[] = [];
  const modes = input.oracle.allowedModes;
  const unmappable = modes.filter((mode) => !(mode in F1_MODE_TO_POC_INTENT));
  if (unmappable.length > 0) reasons.push(...unmappable.map((mode) => `f1-mode-not-representable:${mode}`));

  const undoProposal = input.oracle.expectedArgs.target === UNDO_TARGET_MARKER;
  if (undoProposal) {
    reasons.push('f1-taxonomy-unsupported:undo-proposal');
    return {
      ...base,
      verdict: 'INCONCLUSIVE',
      reasons: Object.freeze([...reasons, 'original-f1-classification-preserved']),
      intent: notComparable(),
      operation: notComparable(),
      args: notComparable(),
      clarification: notComparable(),
      clarificationNeedles: notComparable(),
      clarificationNeedlesMatched: Object.freeze([]),
      clarificationNeedlesMissing: Object.freeze([]),
      argsMismatchedKeys: Object.freeze([]),
      missingFields: notComparable(), ambiguities: notComparable(), entities: notComparable(),
      contextProvenance: notComparable(), requestedAction: notComparable(), capabilityAvailability: 'unknown',
    };
  }

  const intent = ((): DimensionVerdict => {
    if (unmappable.length > 0) return notComparable();
    const allowedIntents = modes.map((mode) => F1_MODE_TO_POC_INTENT[mode] as StructuredIntent);
    return allowedIntents.includes(input.candidate!.intent) ? 'match' : 'mismatch';
  })();

  const operation = ((): DimensionVerdict => {
    if (unmappable.length > 0) return notComparable();
    if (modes.includes('clarify')) return input.candidate!.intent === 'clarify' && input.candidate!.operation === 'none' ? 'match' : 'mismatch';
    const allowed = input.oracle.allowedOperations;
    if (allowed.length === 0) return input.candidate!.operation === 'none' ? 'match' : 'mismatch';
    return allowed.includes(input.candidate!.operation) ? 'match' : 'mismatch';
  })();

  // Taxonomy gaps block argument scoring too: `clarify`/undo turns carry
  // conceptual slots instead of executable ones, so args cannot be compared.
  const argsDetail =
    unmappable.length > 0
      ? { verdict: notComparable(), mismatchedKeys: Object.freeze([] as string[]), reasons: Object.freeze([] as string[]) }
      : compareArgs(input.candidate, input.oracle);
  const args = argsDetail.verdict;
  const clarificationDetail = compareClarification(input.candidate, input.oracle);
  const compareOptional = (expected: readonly string[] | undefined, actual: readonly string[]): DimensionVerdict =>
    expected === undefined ? notComparable() : equalSets(expected, actual) ? 'match' : 'mismatch';
  const missingFields = compareOptional(input.oracle.expectedMissingFields, input.candidate.missingFields);
  const ambiguities = compareOptional(input.oracle.expectedAmbiguities, input.candidate.ambiguities);
  const entities = input.oracle.expectedEntities === undefined ? notComparable() :
    equalEntities(input.oracle.expectedEntities, input.candidate.entities) ? 'match' : 'mismatch';
  const contextProvenance = input.oracle.expectedContextProvenance === undefined ? notComparable() :
    equalContextProvenance(input.oracle.expectedContextProvenance, input.candidate.contextProvenance) ? 'match' : 'mismatch';
  const requestedAction = input.oracle.expectedRequestedAction === undefined ? notComparable() :
    input.oracle.expectedRequestedAction === (input.candidate.requestedAction ?? '') ? 'match' : 'mismatch';
  const capabilityAvailability = input.candidate.requestedAction === 'budgets.create' ? 'unsupported' : 'unknown';
  reasons.push(...argsDetail.reasons, ...clarificationDetail.reasons);

  const dimensions: readonly DimensionVerdict[] = [
    intent,
    operation,
    args,
    clarificationDetail.clarification,
      clarificationDetail.needles,
      ...(input.oracle.expectedMissingFields === undefined ? [] : [missingFields]),
      ...(input.oracle.expectedAmbiguities === undefined ? [] : [ambiguities]),
      ...(input.oracle.expectedEntities === undefined ? [] : [entities]),
      ...(input.oracle.expectedContextProvenance === undefined ? [] : [contextProvenance]),
      ...(input.oracle.expectedRequestedAction === undefined ? [] : [requestedAction]),
  ];
  // Behavioral expectations with no observation surface in this POC: the row
  // keeps its partial dimension evidence but cannot be reported as PASS.
  const unobservable = Object.keys(input.oracle.expectedArgs).filter(
    (key) =>
      F1_UNOBSERVABLE_EXPECTATION_KEYS.has(key) && input.oracle.expectedArgs[key] === true,
  );
  if (unobservable.length > 0) {
    reasons.push(...unobservable.map((key) => `f1-expectation-unobservable:${key}`));
  }
  const verdict: F2AComparison['verdict'] =
    dimensions.includes('not-comparable') || unobservable.length > 0
      ? 'INCONCLUSIVE'
      : dimensions.includes('mismatch')
        ? 'FAIL'
        : 'PASS';
  if (verdict === 'PASS') reasons.push('observable-dimensions-match');
  if (verdict === 'FAIL') reasons.push('observable-mismatch-no-financial-claim');
  reasons.push('original-f1-classification-preserved');

  return {
    ...base,
    verdict,
    reasons: Object.freeze([...new Set(reasons)]),
    intent,
    operation,
    args,
    clarification: clarificationDetail.clarification,
    clarificationNeedles: clarificationDetail.needles,
    clarificationNeedlesMatched: clarificationDetail.matched,
    clarificationNeedlesMissing: clarificationDetail.missing,
    argsMismatchedKeys: argsDetail.mismatchedKeys,
    missingFields, ambiguities, entities, contextProvenance, requestedAction, capabilityAvailability,
  };
};

export type F2AJourneyComparison = Readonly<{
  corpusId: string;
  verdict: 'INCONCLUSIVE';
  reasons: readonly string[];
  originalCompletion: string;
  clarificationPresence: DimensionVerdict;
  financialCompletion: 'unobservable';
}>;

/**
 * Journeys have no global independent oracle for interpretation quality: the
 * frozen artifact records the F1 run's original completion, and the only
 * independently authored expectation is the first stage (`clarify`). A journey
 * can therefore never produce a global PASS; it stays INCONCLUSIVE and scores
 * at most clarification PRESENCE for a `clarify` stage.
 *
 * The F1 `actualPlan`/`isolatedRoute` fields are observations of system A, not
 * expectations for system B — this function does not accept them.
 */
export const compareF2AJourney = (input: {
  readonly corpusId: string;
  readonly originalCompletion: string;
  readonly expectedStage: string | undefined;
  readonly candidate: F2ACandidate | null;
}): F2AJourneyComparison => {
  const reasons: string[] = ['journey-no-global-oracle'];
  let clarificationPresence: DimensionVerdict = notComparable();
  if (input.expectedStage === 'clarify') {
    if (input.candidate === null) {
      reasons.push('no-candidate');
    } else {
      clarificationPresence = input.candidate.clarification !== null ? 'match' : 'mismatch';
      if (clarificationPresence === 'mismatch') reasons.push('journey-clarify-stage-not-satisfied');
    }
  } else if (input.expectedStage !== undefined) {
    reasons.push(`journey-stage-not-scored:${input.expectedStage}`);
  } else {
    reasons.push('journey-stage-unspecified');
  }
  reasons.push('original-f1-completion-preserved');
  return {
    corpusId: input.corpusId,
    verdict: 'INCONCLUSIVE',
    reasons: Object.freeze(reasons),
    originalCompletion: input.originalCompletion,
    clarificationPresence,
    financialCompletion: 'unobservable',
  };
};

/** Exported for tests: the exact F1 meta-key set used by `compareArgs`. */
export const isF1MetaExpectationKey = (key: string): boolean =>
  F1_META_EXPECTATION_KEYS.has(key);
