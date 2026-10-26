import {
  compareF2A,
  type F2AComparison,
  type F2ACandidate,
  type F2AOracle,
} from '../../src/poc-structured/ab-compare.js';
import { parseStructuredLLMOutput, toCandidate } from '../../src/poc-structured/structured-interpretation.js';
import { F2A1_EVALUATED_JOURNEY_IDS, F2A1_JOURNEYS, F2A1_SCENARIOS } from './f2a1-oracles.js';
import { F2A1_LOCAL_CANDIDATES } from './f2a1-candidates.js';
import { F2A1_INPUTS, type F2A1InputContext } from './f2a1-inputs.js';
import { loadFrozenArtifact } from './frozen-artifacts.js';

export type F2A1CandidateOutputs = Readonly<{
  scenarios?: Readonly<Record<string, unknown>>;
  journeys?: Readonly<Record<string, readonly unknown[]>>;
  inputs?: Readonly<Record<string, F2A1InputContext>>;
}>;

export type F2A1ContextBinding = 'match' | 'mismatch' | 'not-comparable';

export type F2A1Row = F2AComparison &
  Readonly<{
    schemaError?: string;
    /** The exact supplied context used for this case/turn (never implied). */
    inputContext: F2A1InputContext | null;
    contextBinding: F2A1ContextBinding;
    contextReasons: readonly string[];
    /** Honest limitation message vs a missing-field question. */
    clarificationKind: 'question' | 'limitation' | null;
  }>;

type Parsed = Readonly<{ candidate: F2ACandidate | null; invalidCode?: string }>;

const parse = (raw: unknown): Parsed => {
  if (raw === undefined) return { candidate: null };
  try {
    return { candidate: toCandidate(parseStructuredLLMOutput(raw)) };
  } catch {
    return { candidate: null, invalidCode: 'agent.invalid_structured_interpretation' };
  }
};

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const argString = (candidate: F2ACandidate, key: string): string | null =>
  typeof candidate.args[key] === 'string' ? (candidate.args[key] as string) : null;

/**
 * Closed set of inherited free-text slots whose value must be traceable to the
 * supplied context. Machine values (IDs, enums, cents, exact dates) already have
 * their own checks; this is not a general rule engine.
 */
const INHERITED_ARG_KEYS = Object.freeze(['accountName', 'expectedName', 'description', 'yearMonth']);

/**
 * Evidence is only what the context DECLARES: prior values, the current text,
 * the allowed history and the frozen reference date. Nothing is inferred from
 * an absent default.
 */
const hasDeclaredEvidence = (context: F2A1InputContext, value: string): boolean => {
  const folded = fold(value);
  if (folded.length === 0) return false;
  if (Object.values(context.suppliedValues).some((entry) => fold(String(entry)) === folded)) return true;
  if (fold(context.currentText).includes(folded)) return true;
  if (context.history.some((entry) => fold(entry.text).includes(folded))) return true;
  return fold(context.referenceDate).includes(folded);
};

/**
 * Compare candidate entity/args IDs against the ACTUAL supplied synthetic
 * entities. A value that is not present in the supplied context cannot be
 * accepted as if it were known. Missing fields that the context already
 * answers are likewise rejected (no redundant question).
 */
const checkContextBinding = (
  candidate: F2ACandidate | null,
  context: F2A1InputContext | null,
): Readonly<{ verdict: F2A1ContextBinding; reasons: readonly string[] }> => {
  if (!context) return { verdict: 'not-comparable', reasons: Object.freeze(['input-context-missing']) };
  if (!candidate) return { verdict: 'not-comparable', reasons: Object.freeze(['no-candidate']) };
  const reasons: string[] = [];

  const accountId = argString(candidate, 'accountId');
  if (accountId && !context.accounts.some((account) => account.id === accountId)) {
    reasons.push(`context-unknown-account-id:${accountId}`);
  }
  const categoryId = argString(candidate, 'categoryId');
  if (categoryId && !context.categories.some((category) => category.id === categoryId)) {
    reasons.push(`context-unknown-category-id:${categoryId}`);
  }
  const transactionId = argString(candidate, 'transactionId');
  if (transactionId && !context.priorTransactions.some((entry) => entry.id === transactionId)) {
    reasons.push(`context-unknown-transaction-id:${transactionId}`);
  }
  const date = argString(candidate, 'date');
  if (date && date !== context.referenceDate) {
    reasons.push(`context-date-not-reference:${date}`);
  }
  // Inherited free text (e.g. an account name carried from a previous turn) is
  // only valid when the declared context actually contains it.
  for (const key of INHERITED_ARG_KEYS) {
    const value = argString(candidate, key);
    if (value !== null && !hasDeclaredEvidence(context, value)) {
      reasons.push(`context-unevidenced-arg:${key}`);
    }
  }
  for (const field of candidate.missingFields) {
    if (context.resolvableFields.includes(field)) reasons.push(`missing-despite-context:${field}`);
  }
  for (const entity of candidate.entities) {
    if (entity.provenance === 'utterance') continue;
    if (entity.kind === 'account') {
      const allowed = [
        ...context.accounts.flatMap((account) => [account.id, account.name]),
        ...context.displayedOptions.map((option) => option.name),
      ];
      if (!allowed.some((value) => fold(value) === fold(entity.value))) {
        reasons.push(`context-unknown-account-entity:${entity.value}`);
      }
    }
    if (entity.kind === 'category') {
      const allowed = context.categories.flatMap((category) => [category.id, category.name]);
      if (!allowed.some((value) => fold(value) === fold(entity.value))) {
        reasons.push(`context-unknown-category-entity:${entity.value}`);
      }
    }
  }
  // Ordered-option selection: when the context supplies the selected option,
  // a different displayed account is a real mismatch, never a free choice.
  const selectedAccountId = context.suppliedValues.selectedAccountId;
  if (
    typeof selectedAccountId === 'string' &&
    context.displayedOptions.some((option) => option.accountId === selectedAccountId) &&
    accountId !== null &&
    accountId !== selectedAccountId
  ) {
    reasons.push(`context-selection-mismatch:${accountId}`);
  }

  return Object.freeze({
    verdict: reasons.length > 0 ? 'mismatch' : 'match',
    reasons: Object.freeze(reasons),
  });
};

const buildRow = (input: {
  parsed: Parsed;
  base: F2AComparison;
  context: F2A1InputContext | null;
}): F2A1Row => {
  const binding = checkContextBinding(input.parsed.candidate, input.context);
  const clarificationKind: F2A1Row['clarificationKind'] =
    input.parsed.candidate === null || input.parsed.candidate.clarification === null
      ? null
      : input.parsed.candidate.intent === 'unsupported'
        ? 'limitation'
        : 'question';

  let verdict: F2AComparison['verdict'] = input.base.verdict;
  const reasons = [...input.base.reasons];
  if (input.parsed.invalidCode) {
    // A supplied but invalid payload is a FAILURE of the supplied candidate.
    // An absent candidate remains INCONCLUSIVE.
    verdict = 'FAIL';
    reasons.push('schema-invalid:agent.invalid_structured_interpretation');
  } else if (!input.context) {
    if (verdict !== 'FAIL') verdict = 'INCONCLUSIVE';
    reasons.push('input-context-missing');
  } else if (binding.verdict === 'mismatch') {
    verdict = 'FAIL';
    reasons.push(...binding.reasons);
  }

  return Object.freeze({
    ...input.base,
    verdict,
    reasons: Object.freeze([...new Set(reasons)]),
    ...(input.parsed.invalidCode ? { schemaError: input.parsed.invalidCode } : {}),
    inputContext: input.context,
    contextBinding: binding.verdict,
    contextReasons: binding.reasons,
    clarificationKind,
  });
};

const classifications = new Map<string, string>(
  loadFrozenArtifact<{ scenarios: { scenarioId: string; evidenceClassification: string }[] }>('baseline').scenarios.map(
    (item) => [item.scenarioId, item.evidenceClassification],
  ),
);
const journeyCatalog = loadFrozenArtifact<{ journeys: { id: string; completion: string }[] }>('journeys').journeys;
const completions = new Map<string, string>(journeyCatalog.map((item) => [item.id, item.completion]));

/** Eight explicit extension records: original F1 expectation and its limit. */
const EXTENSIONS = Object.freeze([
  {
    id: 'B013-catalog',
    originalExpectation: 'F1 selected fixture has no seeded account/category catalog',
    limitation: 'no catalog I/O',
    comparableCriterion: 'exact synthetic accountId + categoryId',
    justification: 'catalog is supplied explicitly in the input context',
  },
  {
    id: 'B015-colloquial',
    originalExpectation: 'F1 expects clarification ("valor") for "cinquenta reais"',
    limitation: 'no lexical confidence model; recorded as a distinct extension',
    comparableCriterion: 'amountCents 5000 without inventing cents',
    justification: 'colloquial number read is declared, not inherited from F1',
  },
  {
    id: 'B027-approx',
    originalExpectation: 'F1 expects approximateAmountCents null + clarification',
    limitation: 'approximateAmountCents is not POC vocabulary',
    comparableCriterion: 'clarify + exact amount missing',
    justification: 'conservative clarification instead of inventing cents',
  },
  {
    id: 'B006-reference',
    originalExpectation: 'F1 expects a prior-expense target reference',
    limitation: 'no ledger/history authority',
    comparableCriterion: 'clarify + no target ID',
    justification: 'prior context is not authority to select a transaction',
  },
  {
    id: 'B016-homonyms',
    originalExpectation: 'F1 expects candidateCount 2 and clarification',
    limitation: 'catalog cardinality supplied only synthetically',
    comparableCriterion: 'clarify + no accountId',
    justification: 'never select by position without displayed options',
  },
  {
    id: 'B021-correction',
    originalExpectation: 'F1 expects priorAmountCents 5000 / correctedAmountCents 7500',
    limitation: 'no history/execution',
    comparableCriterion: 'clarify + no mutation',
    justification: 'no retroactive mutation inference',
  },
  {
    id: 'B008-concept',
    originalExpectation: 'F1 expects a general concept answer',
    limitation: 'no product narration evaluation',
    comparableCriterion: 'conversation + operation none',
    justification: 'no financial operation is inferred from a concept question',
  },
  {
    id: 'J02-category',
    originalExpectation: 'F1 frozen stages are clarify -> propose',
    limitation: 'stage constraint recorded separately from semantic quality',
    comparableCriterion: 'proposal with catalog categoryId, no redundant question',
    justification: 'the supplied catalog makes the only category obvious',
  },
]);

export const runF2A1 = (
  outputs: F2A1CandidateOutputs = {},
): Readonly<{
  scenarios: readonly F2A1Row[];
  journeys: readonly Readonly<{
    comparison: {
      corpusId: string;
      verdict: 'INCONCLUSIVE';
      reasons: readonly string[];
      originalCompletion: string;
      financialCompletion: 'unobservable';
    };
    semanticVerdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    turns: readonly F2A1Row[];
  }>[];
  /** Other five frozen journeys, retained INCONCLUSIVE and NOT evaluated. */
  retainedJourneys: readonly Readonly<{
    corpusId: string;
    verdict: 'INCONCLUSIVE';
    reasons: readonly string[];
    originalCompletion: string;
    financialCompletion: 'unobservable';
  }>[];
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  extensions: typeof EXTENSIONS;
}> => {
  const inputs = outputs.inputs ?? F2A1_INPUTS;

  const scenarios = Object.entries(F2A1_SCENARIOS).map(([id, oracle]) => {
    const parsed = parse(outputs.scenarios?.[id]);
    const base = compareF2A({
      corpusId: id,
      oracle,
      candidate: parsed.candidate,
      originalF1Classification: classifications.get(id) ?? 'unknown',
    });
    return buildRow({ parsed, base, context: inputs[id] ?? null });
  });

  const journeys = Object.entries(F2A1_JOURNEYS).map(([id, oracles]) => {
    const supplied = outputs.journeys?.[id] ?? [];
    const turns = oracles.map((oracle, index) => {
      const parsed = parse(supplied[index]);
      const base = compareF2A({
        corpusId: `${id}:T${index + 1}`,
        oracle: oracle as F2AOracle,
        candidate: parsed.candidate,
        originalF1Classification: 'journey-completion-unobservable',
      });
      return buildRow({
        parsed,
        base,
        context: inputs[`${id}:T${index + 1}`] ?? null,
      });
    });
    const complete = supplied.length === oracles.length;
    const semanticVerdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = turns.some((item) => item.verdict === 'FAIL')
      ? 'FAIL'
      : !complete || turns.some((item) => item.verdict === 'INCONCLUSIVE')
        ? 'INCONCLUSIVE'
        : 'PASS';
    return Object.freeze({
      comparison: Object.freeze({
        corpusId: id,
        verdict: 'INCONCLUSIVE' as const,
        originalCompletion: completions.get(id) ?? 'unknown',
        financialCompletion: 'unobservable' as const,
        reasons: Object.freeze([
          'financial-completion-unobservable',
          ...(complete ? ['all-required-turns-observed'] : ['missing-required-turn']),
        ]),
      }),
      semanticVerdict,
      turns: Object.freeze(turns),
    });
  });

  const retainedJourneys = journeyCatalog
    .filter((journey) => !F2A1_EVALUATED_JOURNEY_IDS.includes(journey.id))
    .map((journey) =>
      Object.freeze({
        corpusId: journey.id,
        verdict: 'INCONCLUSIVE' as const,
        reasons: Object.freeze([
          'journey-retained-not-evaluated',
          'financial-completion-unobservable',
        ]),
        originalCompletion: journey.completion,
        financialCompletion: 'unobservable' as const,
      }),
    );

  const evaluated = [
    ...scenarios.map((row) => row.verdict),
    ...journeys.map((journey) => journey.semanticVerdict),
  ];
  const verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = evaluated.includes('FAIL')
    ? 'FAIL'
    : evaluated.every((value) => value === 'PASS')
      ? 'PASS'
      : 'INCONCLUSIVE';

  return Object.freeze({
    scenarios: Object.freeze(scenarios),
    journeys: Object.freeze(journeys),
    retainedJourneys: Object.freeze(retainedJourneys),
    verdict,
    extensions: EXTENSIONS,
  });
};

export const F2A1_COMPLETE_CANDIDATES = F2A1_LOCAL_CANDIDATES;
