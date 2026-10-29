import { ARG_SPECS, ALLOWED_OPERATIONS, CATEGORY_KINDS, OPERATION_ARG_KEYS, ACCOUNT_KINDS } from '../../src/poc-structured/registry.js';
import { parseStructuredLLMOutput, STRUCTURED_INTENTS, STRUCTURED_LIMITS } from '../../src/poc-structured/structured-interpretation.js';
import { F2A1_INPUTS } from './f2a1-inputs.js';
import { F2A1_JOURNEYS, F2A1_SCENARIOS } from './f2a1-oracles.js';
import { runF2A1 } from './evaluation-runner.js';

export const F2B0_CASE_IDS = Object.freeze([
  ...Object.keys(F2A1_SCENARIOS),
  ...Object.entries(F2A1_JOURNEYS).flatMap(([journey, turns]) => turns.map((_, index) => `${journey}:T${index + 1}`)),
]);

const responseFields = Object.freeze({
  intent: { type: 'string', allowed: [...STRUCTURED_INTENTS] },
  operation: { type: 'string', allowed: [...ALLOWED_OPERATIONS], note: 'must pair with intent: read needs a read operation, mutation-proposal needs a mutation operation, clarify/confirmation/cancel/advice/conversation/unsupported need none' },
  args: { type: 'object', maxKeys: STRUCTURED_LIMITS.maxArgs, note: `keys must be allowed for the operation; operation none requires empty args; values follow ARG_SPECS (string non-empty max ${STRUCTURED_LIMITS.maxString} chars, cents non-negative integer, signed-cents integer, boolean, account-kind, category-kind; null allowed); yearMonth YYYY-MM; date/startDate/endDate YYYY-MM-DD calendar date` },
  contextProvenance: { type: 'object', closedKeys: ['origin', 'corpusId', 'turnIndex'], origin: 'string; one of [local-fixture, f1-corpus-text, f1-journey-turn]', corpusId: 'string; case ID matching ^(F1-B\\d{3}|J\\d{2}|F2A1-[A-Za-z0-9-]+|LOCAL-[A-Z0-9-]+)$', turnIndex: 'optional non-negative integer' },
  entities: { type: 'array', maxItems: STRUCTURED_LIMITS.maxEntities, closedItemKeys: ['kind', 'value', 'provenance'], item: { kind: 'string; one of [account, category, amount, date, period, description, card, counterparty]', value: `non-empty string, max ${STRUCTURED_LIMITS.maxString}`, provenance: 'string; one of [utterance, local-fixture, corpus-context, displayed-option]' } },
  ambiguities: `string[], max ${STRUCTURED_LIMITS.maxAmbiguities}; each non-empty, max ${STRUCTURED_LIMITS.maxString}`,
  missingFields: { type: 'string[]', allowed: ['amount', 'description', 'account', 'category', 'date', 'period', 'entity', 'accountKind', 'initialBalance'], maxItems: STRUCTURED_LIMITS.maxAmbiguities },
  clarification: `null or non-empty string, max ${STRUCTURED_LIMITS.maxClarification}`,
  requestedAction: { type: 'string', optional: true, allowed: [...ALLOWED_OPERATIONS, 'budgets.create'], meaning: 'semantic action only; never execution or authorization' },
});

const contractDescriptor = Object.freeze({
  allowedResponseKeys: ['intent', 'operation', 'args', 'contextProvenance', 'entities', 'ambiguities', 'clarification', 'missingFields', 'requestedAction'],
  requiredResponseKeys: ['intent', 'operation', 'args', 'contextProvenance', 'entities', 'ambiguities', 'clarification', 'missingFields'],
  argSpecs: ARG_SPECS,
  operationArgs: Object.fromEntries(Object.entries(OPERATION_ARG_KEYS).map(([key, values]) => [key, [...values]])),
  limits: STRUCTURED_LIMITS,
  enumValues: { accountKind: ACCOUNT_KINDS, categoryKind: CATEGORY_KINDS },
  semantics: [
    'This is a contract descriptor, NOT a JSON response example; return only allowedResponseKeys inside the interpretation envelope.',
    'operation none requires empty args; read intent requires a read operation; mutation-proposal requires a mutation operation.',
    'clarify requires operation none; confirmation, cancel, advice, conversation, unsupported require operation none.',
    'missingFields are required values unavailable from supplied context; ambiguities are unresolved alternatives, not missing values.',
    'Known unsupported capabilities are not ambiguities. requestedAction describes intent only and never executes or authorizes an action.',
    `Hard bounds: serialized payload <=${STRUCTURED_LIMITS.maxSerializedBytes} bytes, depth <=${STRUCTURED_LIMITS.maxDepth}; args <=${STRUCTURED_LIMITS.maxArgs} keys; entities <=${STRUCTURED_LIMITS.maxEntities} items; ambiguities and missingFields <=${STRUCTURED_LIMITS.maxAmbiguities} items each; arg string values, entity values and ambiguity texts <=${STRUCTURED_LIMITS.maxString} chars; clarification <=${STRUCTURED_LIMITS.maxClarification}. Unknown top-level keys and authority/credential keys at any depth are rejected.`,
  ],
});

export const F2B0_PROMPT = [
  'Interpret the supplied synthetic user input and contextual history/catalogs.',
  'Return exactly one JSON object and no prose, in the supplied closed contract.',
  'The top-level object must have exactly one key: "interpretation".',
  'Its value must be an object. allowedResponseKeys and requiredResponseKeys apply inside interpretation, not at the top level.',
  'Do not execute, authorize, or claim a mutation. Use only supplied input context; do not invent IDs or facts.',
  `Response contract descriptor (not a response example): ${JSON.stringify({ responseFields, descriptor: contractDescriptor })}`,
].join('\n');

export type F2B0PromptCase = Readonly<{ id: string; prompt: string; input: unknown }>;

export const getF2B0Cases = (): readonly F2B0PromptCase[] => Object.freeze(F2B0_CASE_IDS.map((id) => {
  const input = F2A1_INPUTS[id];
  if (!input) throw new Error(`missing synthetic input: ${id}`);
  return Object.freeze({
    id,
    prompt: `${F2B0_PROMPT}\nManifest case ID: ${id}\nSynthetic input ID (corpusId): ${input.caseId}\nInput turn index: ${input.turnIndex === undefined ? 'not a journey turn' : input.turnIndex}\nSynthetic input context: ${JSON.stringify(input)}`,
    input,
  });
}));

export type F2B0Attempt = Readonly<{ id: string; raw: string }>;

export const evaluateF2B0Attempts = (attempts: readonly F2B0Attempt[], options: { requireComplete?: boolean } = {}) => {
  const ids = attempts.map(({ id }) => id);
  if (ids.some((id) => !F2B0_CASE_IDS.includes(id))) throw new Error('unknown case ID');
  if (new Set(ids).size !== ids.length) throw new Error('duplicate case ID');
  const missingIds = F2B0_CASE_IDS.filter((id) => !ids.includes(id));
  if (options.requireComplete && missingIds.length > 0) throw new Error('incomplete case batch');
  const scenarios: Record<string, unknown> = {};
  const journeys: Record<string, unknown[]> = {};
  const results: Record<string, Readonly<{ jsonValid: boolean; schemaValid: boolean; sanitizedReason: string | null; raw: string }>> = {};
  for (const attempt of attempts) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(attempt.raw);
      results[attempt.id] = { jsonValid: true, schemaValid: false, sanitizedReason: null, raw: attempt.raw };
    } catch {
      results[attempt.id] = { jsonValid: false, schemaValid: false, sanitizedReason: 'invalid-json', raw: attempt.raw };
      parsedJson = { malformedRawOutput: true };
    }
    if (results[attempt.id]!.jsonValid) {
      try {
        parseStructuredLLMOutput(parsedJson);
        results[attempt.id] = { ...results[attempt.id]!, schemaValid: true };
      } catch (error) {
        const reason = error instanceof Error && 'reason' in error && typeof error.reason === 'string' ? error.reason : 'invalid-schema';
        results[attempt.id] = { ...results[attempt.id]!, sanitizedReason: reason };
      }
    }
    if (attempt.id.includes(':T')) {
      const [journey, turn] = attempt.id.split(':T');
      const rows = journeys[journey!] ?? (journeys[journey!] = []);
      rows[Number(turn) - 1] = parsedJson;
    } else scenarios[attempt.id] = parsedJson;
  }
  const baseEvaluation = runF2A1({ scenarios, journeys });
  const scenariosWithMissing = baseEvaluation.scenarios.map((row) => missingIds.includes(row.corpusId)
    ? Object.freeze({ ...row, verdict: 'INCONCLUSIVE' as const, reasons: Object.freeze([...row.reasons, 'attempt-missing']) })
    : row);
  const journeysWithMissing = baseEvaluation.journeys.map((journey) => {
    const turns = journey.turns.map((row) => missingIds.includes(row.corpusId)
      ? Object.freeze({ ...row, verdict: 'INCONCLUSIVE' as const, reasons: Object.freeze([...row.reasons, 'attempt-missing']) })
      : row);
    const semanticVerdict = turns.some((row) => row.verdict === 'FAIL') ? 'FAIL' as const
      : turns.some((row) => row.verdict === 'INCONCLUSIVE') ? 'INCONCLUSIVE' as const : 'PASS' as const;
    return Object.freeze({ ...journey, turns: Object.freeze(turns), semanticVerdict });
  });
  const evaluated = [...scenariosWithMissing.map((row) => row.verdict), ...journeysWithMissing.map((row) => row.semanticVerdict)];
  const evaluation = Object.freeze({ ...baseEvaluation, scenarios: Object.freeze(scenariosWithMissing), journeys: Object.freeze(journeysWithMissing), verdict: evaluated.includes('FAIL') ? 'FAIL' as const : evaluated.every((value) => value === 'PASS') ? 'PASS' as const : 'INCONCLUSIVE' as const });
  return Object.freeze({ evaluation, results: Object.freeze(results), attempted: attempts.length, complete: missingIds.length === 0, missingIds: Object.freeze(missingIds) });
};
