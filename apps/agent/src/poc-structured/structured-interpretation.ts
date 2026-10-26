/**
 * F2-A POC — strict structured interpretation (experimental, isolated).
 *
 * Pure adapter over ALREADY-RETURNED LLM JSON. No provider client, no fetch,
 * no credentials, no tools, no execution, no receipts, no permission fields.
 * Every violation throws a typed `StructuredInterpretationError`
 * (`code: 'agent.invalid_structured_interpretation'`).
 *
 * Contract shape: exactly `{ "interpretation": { intent, operation, args,
 * contextProvenance, entities, ambiguities, clarification } }`. A bare record
 * or a bare JSON string is NOT accepted: the wrapper is the only envelope, and
 * the wrapper may carry no sibling keys.
 *
 * Operation/argument vocabulary lives in `./registry.ts`, which imports the
 * canonical `TED_APPROVAL_TOOLS` and compile-time-binds draft argument names.
 */

import type { TurnPlan } from '../orchestration/conversation-orchestrator.js';
import {
  ACCOUNT_KINDS,
  ALLOWED_OPERATIONS,
  CATEGORY_KINDS,
  OPERATION_ARG_KEYS,
  getArgSpec,
  hasOperationArgSchema,
  isMutationOperation,
  isReadOperation,
} from './registry.js';

export type StructuredIntent = TurnPlan['mode'];

export const STRUCTURED_INTENTS: readonly StructuredIntent[] = [
  'read',
  'mutation-proposal',
  'confirmation',
  'cancel',
  'advice',
  'conversation',
  'unsupported',
] as const;

/** Bounded, closed reason codes. Never free-form text in the error. */
export type StructuredInterpretationReason =
  | 'malformed-payload'
  | 'max-depth'
  | 'max-size'
  | 'wrapper-shape'
  | 'forbidden-authority-key'
  | 'unknown-field'
  | 'invalid-intent'
  | 'invalid-operation'
  | 'intent-operation-mismatch'
  | 'args-not-object'
  | 'args-unknown-key'
  | 'args-not-allowed-for-operation'
  | 'args-value-shape'
  | 'operation-args-inappropriate'
  | 'invalid-provenance'
  | 'invalid-entities'
  | 'invalid-ambiguities'
  | 'invalid-clarification';

export class StructuredInterpretationError extends Error {
  readonly code = 'agent.invalid_structured_interpretation' as const;
  readonly reason: StructuredInterpretationReason;

  constructor(reason: StructuredInterpretationReason) {
    super('agent.invalid_structured_interpretation');
    this.name = 'StructuredInterpretationError';
    this.reason = reason;
  }
}

const invalid: (reason: StructuredInterpretationReason) => never = (reason) => {
  throw new StructuredInterpretationError(reason);
};

export const STRUCTURED_LIMITS = Object.freeze({
  maxSerializedBytes: 8_192,
  maxDepth: 8,
  maxArgs: 12,
  maxEntities: 8,
  maxAmbiguities: 8,
  maxString: 200,
  maxClarification: 500,
} as const);

const WRAPPER_KEY = 'interpretation';

const ENTITY_KINDS: ReadonlySet<string> = new Set([
  'account',
  'category',
  'amount',
  'date',
  'period',
  'description',
  'card',
  'counterparty',
]);

const ENTITY_PROVENANCE: ReadonlySet<string> = new Set([
  'utterance',
  'local-fixture',
  'corpus-context',
]);

const CONTEXT_ORIGIN: ReadonlySet<string> = new Set([
  'local-fixture',
  'f1-corpus-text',
  'f1-journey-turn',
]);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'intent',
  'operation',
  'args',
  'contextProvenance',
  'entities',
  'ambiguities',
  'clarification',
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Authority / receipt / credential vocabulary. Comparison normalizes the key
 * (lowercase, non-alphanumerics removed), so `write_authorized`,
 * `Write-Authorized` and `WRITEAUTHORIZED` are the same violation. Never
 * accepted at ANY depth — including inside `args`, `entities` and
 * `contextProvenance`.
 */
const FORBIDDEN_NORMALIZED_KEYS: ReadonlySet<string> = new Set(
  [
    'mutationApproved',
    'capability',
    'workspace',
    'workspaceId',
    'actor',
    'actorId',
    'device',
    'deviceId',
    'idempotencyKey',
    'attestation',
    'writeAuthorized',
    'approvalRequired',
    'authorizationMode',
    'authorizationReason',
    'risk',
    'decision',
    'autoExecute',
    'autoexecute',
    'receipt',
    'operationId',
    'pendingId',
    'execution',
    'execute',
    'grant',
    'grants',
    'permission',
    'permissions',
    'token',
    'secret',
    'credential',
    'credentials',
    'authorization',
    'approval',
    'signature',
    'apiKey',
  ].map((key) => normalizeKey(key)),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const assertDepth = (value: unknown, depth = 0): void => {
  if (depth > STRUCTURED_LIMITS.maxDepth) invalid('max-depth');
  if (Array.isArray(value)) {
    for (const item of value) assertDepth(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) assertDepth(value[key], depth + 1);
  }
};

const assertSerializedSize = (value: unknown): void => {
  let size: number;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof serialized !== 'string') invalid('malformed-payload');
    size = new TextEncoder().encode(serialized).length;
  } catch {
    return invalid('malformed-payload');
  }
  if (size > STRUCTURED_LIMITS.maxSerializedBytes) invalid('max-size');
};

const rejectForbiddenDeep = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenDeep(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_NORMALIZED_KEYS.has(normalizeKey(key))) invalid('forbidden-authority-key');
    rejectForbiddenDeep(value[key]);
  }
};

const parseWrapper = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    if (raw.trim() === '') invalid('malformed-payload');
    // Bound the bytes actually received, before parsing can allocate a tree.
    assertSerializedSize(raw);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) invalid('wrapper-shape');
      assertDepth(parsed);
      return wrapperRecord(parsed);
    } catch (error) {
      if (error instanceof StructuredInterpretationError) throw error;
      return invalid('malformed-payload');
    }
  }
  if (!isRecord(raw)) invalid('wrapper-shape');
  assertDepth(raw);
  assertSerializedSize(raw);
  return wrapperRecord(raw);
};

const wrapperRecord = (payload: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== WRAPPER_KEY) invalid('wrapper-shape');
  const interpretation = payload[WRAPPER_KEY];
  if (!isRecord(interpretation)) invalid('wrapper-shape');
  return interpretation;
};

const isCalendarDate = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
};

const checkIntent = (value: unknown): StructuredIntent => {
  if (typeof value !== 'string') invalid('invalid-intent');
  const allowed: readonly string[] = STRUCTURED_INTENTS;
  if (!allowed.includes(value)) invalid('invalid-intent');
  return value as StructuredIntent;
};

const checkOperation = (value: unknown, intent: StructuredIntent): string => {
  if (typeof value !== 'string') invalid('invalid-operation');
  if (!(ALLOWED_OPERATIONS as readonly string[]).includes(value)) invalid('invalid-operation');
  const operation = value;
  if (intent === 'read' && !isReadOperation(operation)) invalid('intent-operation-mismatch');
  if (intent === 'mutation-proposal' && !isMutationOperation(operation)) {
    invalid('intent-operation-mismatch');
  }
  if (
    intent === 'confirmation' ||
    intent === 'cancel' ||
    intent === 'conversation' ||
    intent === 'unsupported' ||
    intent === 'advice'
  ) {
    if (operation !== 'none') invalid('intent-operation-mismatch');
  }
  return operation;
};

const checkArgValue = (key: string, value: unknown): string | number | boolean | null => {
  if (value === null) return null;
  const argSpec = getArgSpec(key);
  if (!argSpec) invalid('args-unknown-key');
  switch (argSpec.kind) {
    case 'string': {
      if (typeof value !== 'string') invalid('args-value-shape');
      if (value.trim() === '' || value.length > STRUCTURED_LIMITS.maxString) {
        invalid('args-value-shape');
      }
      return value;
    }
    case 'cents': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        invalid('args-value-shape');
      }
      return value;
    }
    case 'signed-cents': {
      if (typeof value !== 'number' || !Number.isInteger(value)) invalid('args-value-shape');
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') invalid('args-value-shape');
      return value;
    }
    case 'account-kind': {
      if (typeof value !== 'string' || !(ACCOUNT_KINDS as readonly string[]).includes(value)) {
        invalid('args-value-shape');
      }
      return value;
    }
    case 'category-kind': {
      if (typeof value !== 'string' || !(CATEGORY_KINDS as readonly string[]).includes(value)) {
        invalid('args-value-shape');
      }
      return value;
    }
  }
};

const checkArgs = (value: unknown, operation: string): Readonly<Record<string, string | number | boolean | null>> => {
  if (!isRecord(value)) invalid('args-not-object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > STRUCTURED_LIMITS.maxArgs) invalid('args-value-shape');
  const allowedForOperation = hasOperationArgSchema(operation)
    ? OPERATION_ARG_KEYS[operation]
    : undefined;
  if (!allowedForOperation) invalid('invalid-operation');
  if (operation === 'none' && keys.length > 0) invalid('operation-args-inappropriate');
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    if (!getArgSpec(key)) invalid('args-unknown-key');
    if (!allowedForOperation.has(key)) invalid('args-not-allowed-for-operation');
    out[key] = checkArgValue(key, record[key]);
  }
  if (typeof out.yearMonth === 'string' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(out.yearMonth)) {
    invalid('args-value-shape');
  }
  for (const dateKey of ['date', 'startDate', 'endDate'] as const) {
    const date = out[dateKey];
    if (typeof date === 'string' && !isCalendarDate(date)) invalid('args-value-shape');
  }
  return Object.freeze(out);
};

const checkProvenance = (value: unknown): Readonly<{
  origin: string;
  corpusId: string;
  turnIndex?: number;
}> => {
  if (!isRecord(value)) invalid('invalid-provenance');
  const record = value as Record<string, unknown>;
  if (typeof record.origin !== 'string' || !CONTEXT_ORIGIN.has(record.origin)) {
    invalid('invalid-provenance');
  }
  if (
    typeof record.corpusId !== 'string' ||
    !/^(F1-B\d{3}|J\d{2}|LOCAL-[A-Z0-9-]+)$/.test(record.corpusId)
  ) {
    invalid('invalid-provenance');
  }
  if (record.turnIndex !== undefined) {
    if (
      typeof record.turnIndex !== 'number' ||
      !Number.isInteger(record.turnIndex) ||
      record.turnIndex < 0
    ) {
      invalid('invalid-provenance');
    }
  }
  const allowed = new Set(['origin', 'corpusId', 'turnIndex']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid('invalid-provenance');
  return Object.freeze({
    origin: record.origin as string,
    corpusId: record.corpusId as string,
    ...(record.turnIndex === undefined ? {} : { turnIndex: record.turnIndex as number }),
  });
};

const checkEntities = (value: unknown): readonly StructuredEntity[] => {
  if (!Array.isArray(value) || value.length > STRUCTURED_LIMITS.maxEntities) {
    invalid('invalid-entities');
  }
  const out = (value as unknown[]).map((item) => {
    if (!isRecord(item)) invalid('invalid-entities');
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== 'string' || !ENTITY_KINDS.has(record.kind)) {
      invalid('invalid-entities');
    }
    if (
      typeof record.value !== 'string' ||
      record.value.trim() === '' ||
      record.value.length > STRUCTURED_LIMITS.maxString
    ) {
      invalid('invalid-entities');
    }
    if (typeof record.provenance !== 'string' || !ENTITY_PROVENANCE.has(record.provenance)) {
      invalid('invalid-entities');
    }
    if (Object.keys(record).some((key) => !['kind', 'value', 'provenance'].includes(key))) {
      invalid('invalid-entities');
    }
    return Object.freeze({
      kind: record.kind as string,
      value: record.value as string,
      provenance: record.provenance as string,
    });
  });
  return Object.freeze(out);
};

const checkAmbiguities = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > STRUCTURED_LIMITS.maxAmbiguities) {
    invalid('invalid-ambiguities');
  }
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.trim() === '' ||
      item.length > STRUCTURED_LIMITS.maxString
    ) {
      invalid('invalid-ambiguities');
    }
  }
  return Object.freeze([...(value as string[])]);
};

const checkClarification = (
  value: unknown,
  ambiguities: readonly string[],
): string | null => {
  if (value === null) {
    if (ambiguities.length > 0) invalid('invalid-clarification');
    return null;
  }
  if (typeof value !== 'string') invalid('invalid-clarification');
  if (value.trim() === '' || value.length > STRUCTURED_LIMITS.maxClarification) {
    invalid('invalid-clarification');
  }
  // A clarification must be explaining a declared ambiguity. `null` with
  // ambiguities and text without ambiguities are both incoherent.
  if (ambiguities.length === 0) invalid('invalid-clarification');
  return value;
};

export type StructuredEntity = Readonly<{
  kind: string;
  value: string;
  provenance: string;
}>;

export type StructuredContextProvenance = Readonly<{
  origin: string;
  corpusId: string;
  turnIndex?: number;
}>;

export type StructuredInterpretation = Readonly<{
  intent: StructuredIntent;
  operation: string;
  args: Readonly<Record<string, string | number | boolean | null>>;
  contextProvenance: StructuredContextProvenance;
  entities: readonly StructuredEntity[];
  ambiguities: readonly string[];
  clarification: string | null;
}>;

/**
 * Parse an ALREADY-RETURNED LLM JSON payload into a strict structured
 * interpretation. Accepts a JSON string or an object, both ONLY in the
 * `{ interpretation: {...} }` envelope. Pure: no I/O, no network, no execution.
 */
export const parseStructuredLLMOutput = (raw: unknown): StructuredInterpretation => {
  const payload = parseWrapper(raw);
  rejectForbiddenDeep(payload);
  const intent = checkIntent(payload.intent);
  const operation = checkOperation(payload.operation, intent);
  const args = checkArgs(payload.args, operation);
  const contextProvenance = checkProvenance(payload.contextProvenance);
  const entities = checkEntities(payload.entities);
  const ambiguities = checkAmbiguities(payload.ambiguities);
  const clarification = checkClarification(payload.clarification, ambiguities);
  for (const key of Object.keys(payload)) if (!TOP_LEVEL_KEYS.has(key)) invalid('unknown-field');
  return Object.freeze({
    intent,
    operation,
    args,
    contextProvenance,
    entities,
    ambiguities,
    clarification,
  });
};

/** Explicit conversion to the A/B candidate view. No inference beyond shape. */
export const toCandidate = (
  parsed: StructuredInterpretation,
): Readonly<{
  intent: StructuredIntent;
  operation: string;
  args: Readonly<Record<string, string | number | boolean | null>>;
  ambiguities: readonly string[];
  clarification: string | null;
}> =>
  Object.freeze({
    intent: parsed.intent,
    operation: parsed.operation,
    args: parsed.args,
    ambiguities: parsed.ambiguities,
    clarification: parsed.clarification,
  });
