import {
  compareF2A,
  F1_META_EXPECTATION_KEYS,
  F1_MODE_TO_POC_INTENT,
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
    /** The exact parsed candidate that produced this row (frozen); null when absent/invalid. */
    candidate: F2ACandidate | null;
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
    if (entity.kind === 'period' && !hasDeclaredEvidence(context, entity.value)) {
      reasons.push(`context-unevidenced-period-entity:${entity.value}`);
    }
    const yearMonth = argString(candidate, 'yearMonth');
    // G2b (relaxação autorizada uso pessoal, operador 2026-10-29): adapter
    // period YYYY-MM → yearMonth. Fold exato idêntico NÃO emite mismatch;
    // só divergente emite (continua FAIL). A API continua 400 para period
    // sem yearMonth (prova em apps/api/tests/routes/month-summary.test.ts).
    if (
      entity.kind === 'period' &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(entity.value) &&
      yearMonth !== null &&
      fold(entity.value) !== fold(yearMonth)
    ) {
      reasons.push('context-period-yearmonth-mismatch');
    }
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
    candidate: input.parsed.candidate,
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

/** Thirteen explicit extension records: original F1 expectation and its limit. */
const EXTENSIONS = Object.freeze([
  {
    id: 'B017-annual',
    originalExpectation: 'F1 expects clarification ("mês"/"período") for bare year "2020"',
    limitation: 'annual custom read is a valid alternative; oráculo histórico intacto',
    comparableCriterion: 'read via analytics custom from=2020-01-01 to=2020-12-31 + explicit basis OR clarify + missing period',
    justification: 'revisão autorizada uso pessoal operador 2026-10-29: resposta anual via analytics custom é resolução válida; FAIL histórico do B0 preservado',
  },
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
  {
    id: 'B036-period-resolution',
    originalExpectation: 'F1 expects period entity "2026-10" (utterance) for "mês atual"',
    limitation: 'resolver output "mês atual" is not the normalized period; oráculo histórico intacto',
    comparableCriterion:
      'read get_month_summary + args yearMonth == currentYearMonth == referenceDate YYYY-MM + single period entity fold "mes atual"',
    justification:
      'B2-root-cause O 2026-10-29: operação+yearMonth corretos; entidade resolve ao período esperado via referenceDate; FAIL base preservado',
  },
  {
    id: 'J09-provenance-evidence',
    originalExpectation: 'F1 expects period entity with provenance utterance for a derived yearMonth',
    limitation: 'utterance label for values derived from suppliedValues is undefined; oráculo intacto',
    comparableCriterion:
      'args yearMonth == expected + single period entity with expected value + declared evidence + binding match (provenance label excused)',
    justification:
      'B2-root-cause O 2026-10-29: J09:T1 (local-fixture) e T2 (corpus-context) com valor evidenciado e args corretos; equivalência documentada, sem reinterpretar rótulo',
  },
  {
    id: 'J01T2-J02T2-redundant-evidence',
    originalExpectation: 'journey follow-up expects minimal/empty entities with utterance provenance',
    limitation: 'restated evidenced follow-up values are not oracle-minimal; oráculo intacto',
    comparableCriterion:
      'intent+operation+args match + binding match + every entity evidenced-or-numerically-equal (amount text identical to evidenced cents)',
    justification:
      'B2-root-cause O 2026-10-29: J01:T2 e J02:T2 com args corretos e valores evidenciados; redundância + proveniência aceitas por equivalência documentada',
  },
  {
    id: 'J05T1-homonym-clarification',
    originalExpectation: 'journey oracle scores only clarification presence; ambiguities expects ["account"]',
    limitation: 'journey turn has no semantic quality dimension; oráculo intacto',
    comparableCriterion:
      'clarify + entities/missing/clarification match + every ambiguity names the homonym (fold "aurora")',
    justification:
      'B2-root-cause O 2026-10-29: J05:T1 esclarece homônimos corretamente; critério de journey pontua turno semanticamente correto sem conclusão financeira',
  },
]);

/**
 * O-category explicit extension acceptance (debugger B2-root-cause, 2026-10-29).
 *
 * Narrow, allowlisted, per-case equivalence checks. They NEVER rewrite the
 * oracle, the candidate, the evidence or the base verdict: `runF2A1` rows keep
 * their FAIL. A returned id means the strictly-failing dimension is accepted
 * under the documented comparableCriterion of that EXTENSIONS entry.
 *
 * No universal rule is created: every branch is gated by an explicit corpusId
 * allowlist plus the base dimension guards (intent/operation/args already
 * match, binding already match). Fail-closed is untouched: a missing value
 * (no declared evidence, no numeric identity) never accepts.
 */
const amountTextToCents = (value: string): number | null => {
  const cleaned = value.replace(/[^0-9.,]/g, '');
  if (cleaned.length === 0) return null;
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number.parseFloat(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
};

const evidencedNumberArgs = (context: F2A1InputContext): readonly number[] =>
  Object.values(context.suppliedValues).filter((value): value is number => typeof value === 'number');

const entityEvidencedOrNumeric = (context: F2A1InputContext, kind: string, value: string): boolean => {
  if (hasDeclaredEvidence(context, value)) return true;
  if (kind !== 'amount') return false;
  const cents = amountTextToCents(value);
  return cents !== null && evidencedNumberArgs(context).includes(cents);
};

/**
 * Canonical JSON with sorted object keys (arrays keep order): the
 * representation used to bind a re-parsed candidate to the row. Any
 * difference in any field — including `missingFields`, `ambiguities`,
 * `clarification`, `requestedAction` or `contextProvenance` — diverges.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
};

/**
 * P1 (reviewer O, 2026-10-29): verify the REPARSED candidate itself against
 * the frozen oracle — intent, operation and args — never trust `row` alone.
 * A tampered `rawOutput` with a valid `row` from another interpretation must
 * be rejected. Mirrors `compareF2A` intent/operation/args semantics (fold for
 * `description`, exact otherwise, no extra keys, meta keys excluded).
 */
const candidateMatchesOracleIdentity = (
  candidate: F2ACandidate,
  oracle: F2AOracle,
): boolean => {
  const allowedIntents = oracle.allowedModes.map(
    (mode) => (F1_MODE_TO_POC_INTENT as Readonly<Record<string, string>>)[mode],
  );
  if (!allowedIntents.includes(candidate.intent)) return false;
  if (oracle.allowedModes.includes('clarify')) {
    if (!(candidate.intent === 'clarify' && candidate.operation === 'none')) return false;
  } else if (oracle.allowedOperations.length === 0) {
    if (candidate.operation !== 'none') return false;
  } else if (!(oracle.allowedOperations as readonly string[]).includes(candidate.operation)) {
    return false;
  }
  const expectedKeys = Object.keys(oracle.expectedArgs).filter(
    (key) => !F1_META_EXPECTATION_KEYS.has(key),
  );
  const candidateKeys = Object.keys(candidate.args);
  if (candidateKeys.length !== expectedKeys.length) return false;
  const expectedSet = new Set(expectedKeys);
  for (const key of candidateKeys) {
    if (!expectedSet.has(key)) return false;
  }
  for (const key of expectedKeys) {
    const want = (oracle.expectedArgs as Readonly<Record<string, unknown>>)[key];
    const got = (candidate.args as Readonly<Record<string, unknown>>)[key];
    if (want === null) {
      if (got !== null) return false;
      continue;
    }
    if (typeof want === 'object') return false;
    if (key === 'description' && typeof want === 'string' && typeof got === 'string') {
      if (fold(want) !== fold(got)) return false;
      continue;
    }
    if (got !== want) return false;
  }
  return true;
};

export const extensionAcceptance = (input: {
  corpusId: string;
  rawOutput: unknown;
  row: F2A1Row;
}): string | null => {
  const { corpusId, rawOutput, row } = input;
  // Extensions only excuse a strictly FAILing row; they never promote
  // INCONCLUSIVE/PASS rows and never touch the oracle.
  if (row.verdict !== 'FAIL') return null;
  const context = row.inputContext;
  if (context === null) return null;
  const candidate = parse(rawOutput).candidate;
  if (candidate === null) return null;
  // P1-round2 (reviewer O): bind EVERY candidate field to the row. The row
  // carries the exact parsed candidate that produced it; acceptance requires
  // deep equality (canonical JSON, sorted keys) between the re-parsed
  // `rawOutput` and that stored candidate. Tamper in any field —
  // `missingFields`, `ambiguities`, `clarification`, `requestedAction`,
  // `contextProvenance`, entities or args — diverges and the acceptance is
  // `null`. A row without a stored candidate never accepts (fail-closed).
  const stored = row.candidate ?? null;
  if (stored === null) return null;
  if (canonicalJson(candidate) !== canonicalJson(stored)) return null;

  if (corpusId === 'F1-B036') {
    if (row.intent !== 'match' || row.operation !== 'match' || row.args !== 'match') return null;
    if (row.entities !== 'mismatch' || row.contextBinding !== 'match') return null;
    const oracle = F2A1_SCENARIOS['F1-B036'];
    if (!oracle || !candidateMatchesOracleIdentity(candidate, oracle)) return null;
    if (checkContextBinding(candidate, context).verdict !== 'match') return null;
    const want = oracle.expectedArgs['yearMonth'];
    if (typeof want !== 'string') return null;
    if (candidate.args['yearMonth'] !== want) return null;
    if (context.suppliedValues['currentYearMonth'] !== want) return null;
    if (context.referenceDate.slice(0, 7) !== want) return null;
    if (candidate.entities.length !== 1) return null;
    const only = candidate.entities[0];
    if (only === undefined) return null;
    if (only.kind !== 'period' || fold(only.value) !== 'mes atual') return null;
    return 'B036-period-resolution';
  }

  if (corpusId === 'J09:T1' || corpusId === 'J09:T2') {
    if (row.intent !== 'match' || row.operation !== 'match' || row.args !== 'match') return null;
    if (row.entities !== 'mismatch' || row.contextBinding !== 'match') return null;
    const turnIndex = corpusId === 'J09:T1' ? 0 : 1;
    const oracle = F2A1_JOURNEYS['J09']?.[turnIndex];
    if (!oracle || !candidateMatchesOracleIdentity(candidate, oracle)) return null;
    if (checkContextBinding(candidate, context).verdict !== 'match') return null;
    const want = oracle.expectedArgs['yearMonth'];
    if (typeof want !== 'string') return null;
    if (candidate.args['yearMonth'] !== want) return null;
    if (candidate.entities.length !== 1) return null;
    const only = candidate.entities[0];
    if (only === undefined) return null;
    if (only.kind !== 'period' || only.value !== want) return null;
    if (only.provenance === 'utterance') return null;
    if (!hasDeclaredEvidence(context, only.value)) return null;
    if (!Object.values(context.suppliedValues).some((entry) => fold(String(entry)) === fold(want)))
      return null;
    return 'J09-provenance-evidence';
  }

  if (corpusId === 'J01:T2' || corpusId === 'J02:T2') {
    if (row.intent !== 'match' || row.operation !== 'match' || row.args !== 'match') return null;
    if (row.entities !== 'mismatch' || row.contextBinding !== 'match') return null;
    const journeyId = corpusId === 'J01:T2' ? 'J01' : 'J02';
    const oracle = F2A1_JOURNEYS[journeyId]?.[1];
    if (!oracle || !candidateMatchesOracleIdentity(candidate, oracle)) return null;
    if (checkContextBinding(candidate, context).verdict !== 'match') return null;
    if (candidate.entities.length === 0) return null;
    if (!candidate.entities.every((entity) => entityEvidencedOrNumeric(context, entity.kind, entity.value)))
      return null;
    return 'J01T2-J02T2-redundant-evidence';
  }

  if (corpusId === 'J05:T1') {
    if (row.intent !== 'match' || row.operation !== 'match' || row.args !== 'match') return null;
    if (row.entities !== 'match' || row.missingFields !== 'match') return null;
    if (row.clarification !== 'match' || row.clarificationNeedles !== 'match') return null;
    if (row.ambiguities !== 'mismatch' || row.contextBinding !== 'match') return null;
    const oracle = F2A1_JOURNEYS['J05']?.[0];
    if (!oracle || !candidateMatchesOracleIdentity(candidate, oracle)) return null;
    if (checkContextBinding(candidate, context).verdict !== 'match') return null;
    if (candidate.missingFields.length !== 0) return null;
    if (candidate.entities.length !== 1) return null;
    const only = candidate.entities[0];
    if (only === undefined) return null;
    if (only.kind !== 'account' || fold(only.value) !== 'aurora' || only.provenance !== 'utterance')
      return null;
    if (candidate.ambiguities.length === 0) return null;
    if (!candidate.ambiguities.every((ambiguity) => fold(ambiguity).includes('aurora'))) return null;
    if (candidate.clarification === null || !fold(candidate.clarification).includes('aurora')) return null;
    return 'J05T1-homonym-clarification';
  }

  return null;
};

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
