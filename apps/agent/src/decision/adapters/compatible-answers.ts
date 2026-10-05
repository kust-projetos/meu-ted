/**
 * Reader for the Jev-compatible answer envelope shared by Clef and Strands.
 *
 * Both dialects answer with the same per-question record — `choice` (the label
 * with the highest probability) and `noul` (the probability itself). Clef's
 * Workers AI binding wraps it as `{ response: { answers } }`; the Strands HTTP
 * deployment answers with `{ answers }` at the root. Only these two documented
 * shapes are accepted: a body with neither is `malformed_response`, never a
 * silently empty answer (the same fail-closed rule the evidence layer uses for
 * payloads missing their container).
 *
 * The reader is where the answer allowlist is enforced. A provider that returns
 * a label the question never offered cannot reach the domain, and the confidence
 * it attached to that label dies with it.
 */
import { isDecisionConfidence, type DecisionAnswer, type DecisionQuestion } from '../contract.js';

type RawAnswer = Readonly<{ choice?: unknown; noul?: unknown; score?: unknown }>;

/** The fields this dialect uses to REPORT certainty. Both are probabilities. */
const PROBABILITY_KEYS = ['noul', 'score'] as const;

/**
 * Three distinct readings, never collapsed into two:
 * - `answer` — a usable typed answer;
 * - `malformed` — the provider REPORTED certainty that is not a probability
 *   (`noul: 2`, `-1`, `NaN`, `'high'`). It is evidence it misreports itself, so
 *   it must not degrade into "reported nothing" (`low_confidence`): that would
 *   silently forgive a broken provider instead of counting it as illness;
 * - `absent` — no certainty field at all, which IS "no confidence".
 */
type ReadOne =
  | Readonly<{ kind: 'answer'; answer: DecisionAnswer }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'absent' }>;

export type CompatibleAnswers = Readonly<{
  answers: Readonly<Record<string, DecisionAnswer>>;
  /** The question this payload actually answered — the one confidence describes. */
  primary: string;
}>;

export type CompatibleRead =
  | CompatibleAnswers
  | Readonly<{ reason: 'malformed_response' | 'value_outside_allowlist' }>;

/** Options the question declared. An absent criteria means "nothing to allow". */
const allowedOptions = (question: DecisionQuestion): readonly string[] | null => {
  const options = question.criteria?.options;
  return Array.isArray(options) ? options.filter((entry): entry is string => typeof entry === 'string') : null;
};

const readOne = (raw: unknown): ReadOne => {
  if (typeof raw !== 'object' || raw === null) return { kind: 'absent' };
  const record = raw as RawAnswer;
  // A certainty field that is PRESENT but not a finite probability in [0,1] is
  // a malformed answer, checked BEFORE anything else so a bad confidence can
  // never travel attached to an otherwise valid label.
  for (const key of PROBABILITY_KEYS) {
    const reported = record[key];
    if (reported !== undefined && !isDecisionConfidence(reported)) return { kind: 'malformed' };
  }
  const choice = typeof record.choice === 'string' ? record.choice : '';
  const probability = isDecisionConfidence(record.noul) ? record.noul : undefined;
  if (choice !== '') return { kind: 'answer', answer: { value: choice, ...(probability !== undefined ? { confidence: probability } : {}) } };
  // A `noul` question has no label: its answer IS the probability.
  if (probability !== undefined) return { kind: 'answer', answer: { value: String(probability), confidence: probability } };
  if (isDecisionConfidence(record.score)) {
    return { kind: 'answer', answer: { value: String(record.score), confidence: record.score } };
  }
  return { kind: 'absent' };
};

const answersOf = (payload: unknown): unknown => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const root = payload as { answers?: unknown; response?: { answers?: unknown } };
  if (root.answers !== undefined) return root.answers;
  return root.response?.answers;
};

/**
 * Reads every question the provider answered, in the order the request declared
 * them, and returns the FIRST usable one as the primary answer. Request order is
 * what makes this deterministic: a model returning two answers can never pick
 * which one the layer trusts.
 */
export const readCompatibleAnswers = (
  payload: unknown,
  questions: Readonly<Record<string, DecisionQuestion>>,
): CompatibleRead => {
  const raw = answersOf(payload);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { reason: 'malformed_response' };
  const records = raw as Record<string, unknown>;

  const answers: Record<string, DecisionAnswer> = {};
  let primary: string | null = null;
  for (const [name, question] of Object.entries(questions)) {
    if (!(name in records)) continue;
    const read = readOne(records[name]);
    if (read.kind === 'malformed') return { reason: 'malformed_response' };
    if (read.kind === 'absent') continue;
    const answer = read.answer;
    const options = allowedOptions(question);
    if (options !== null && !options.includes(answer.value)) return { reason: 'value_outside_allowlist' };
    answers[name] = answer;
    if (primary === null) primary = name;
  }
  if (primary === null) return { reason: 'malformed_response' };
  return { answers, primary };
};
