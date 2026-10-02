import type { MutationPolicy, TurnPlan } from './conversation-orchestrator.js';

/** Raw shapes accepted from an upstream provider. They are untrusted data. */
export type ProviderOutput = Readonly<{
  text?: unknown;
  toolCalls?: readonly { name?: unknown; arguments?: unknown }[];
  broker?: { choices?: readonly { message?: { role?: unknown; content?: unknown }; finish_reason?: unknown }[] };
  [key: string]: unknown;
}>;

export type GroundedResponse = Readonly<{ text: string }>;
export type ValidatedProviderOutput = Readonly<{
  plan: TurnPlan;
  response: GroundedResponse;
  policy: MutationPolicy;
  source: 'text' | 'native-tool' | 'broker';
}>;

const forbiddenAuthorityFields = new Set([
  ['mutation', 'Approved'].join(''), 'capability', 'workspace', 'workspaceId', 'actor', 'actorId',
  'device', 'deviceId', 'idempotencyKey', 'attestation', 'writeAuthorized', 'approvalRequired',
  'authorizationMode', 'authorizationReason', 'risk', 'decision', 'autoExecute',
]);

const invalid = (): never => { throw new Error('agent.invalid_provider_output'); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const rejectAuthority = (value: unknown): void => {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) if (forbiddenAuthorityFields.has(key)) invalid();
};

const parseJson = (value: unknown): Record<string, unknown> => {
  const text = typeof value === 'string' ? value : invalid();
  if (text.trim() === '') invalid();
  try {
    const parsed: unknown = JSON.parse(text);
    const record = isRecord(parsed) ? parsed : invalid();
    return record;
  } catch { invalid(); }
  return invalid();
};

const validatePlan = (value: unknown): TurnPlan => {
  const plan = isRecord(value) ? value : invalid();
  rejectAuthority(plan);
  const modes = ['read', 'mutation-proposal', 'confirmation', 'cancel', 'advice', 'conversation', 'unsupported'];
  const domains = ['accounts', 'transactions', 'cards', 'payables', 'budgets', 'goals', 'categories', 'memory', 'web', 'general'];
  if (plan.version !== '2' || typeof plan.mode !== 'string' || !modes.includes(plan.mode) || typeof plan.domain !== 'string' || !domains.includes(plan.domain)) invalid();
  if (!Array.isArray(plan.skillNames) || plan.skillNames.length > 2 || plan.skillNames.some((x: unknown) => typeof x !== 'string')) invalid();
  const operations = Array.isArray(plan.requestedOperations) ? plan.requestedOperations : invalid();
  if (operations.length > 4) invalid();
  for (const operation of operations) {
    if (!isRecord(operation) || typeof operation.name !== 'string' || !['read', 'mutation'].includes(String(operation.kind))) invalid();
    rejectAuthority(operation);
    if (plan.mode === 'read' && operation.kind === 'mutation') invalid();
  }
  if (!Array.isArray(plan.missingFields) || plan.missingFields.some((x: unknown) => typeof x !== 'string')) invalid();
  if (plan.ambiguity !== null && typeof plan.ambiguity !== 'string') invalid();
  if (typeof plan.confidence !== 'number' || !Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) invalid();
  return plan as unknown as TurnPlan;
};

const extractPayload = (raw: ProviderOutput): { payload: Record<string, unknown>; source: ValidatedProviderOutput['source'] } => {
  rejectAuthority(raw);
  if (raw.broker !== undefined) {
    if (!isRecord(raw.broker) || !Array.isArray(raw.broker.choices) || raw.broker.choices.length !== 1) invalid();
    const choices = raw.broker.choices ?? [];
    const content = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message.content : undefined;
    return { payload: parseJson(content), source: 'broker' };
  }
  if (raw.toolCalls !== undefined) {
    if (!Array.isArray(raw.toolCalls) || raw.toolCalls.length !== 1 || raw.toolCalls[0]?.name !== 'plan') invalid();
    return { payload: parseJson(raw.toolCalls[0]?.arguments), source: 'native-tool' };
  }
  return { payload: parseJson(raw.text), source: 'text' };
};

export const validateProviderOutput = (raw: ProviderOutput): ValidatedProviderOutput => {
  const { payload, source } = extractPayload(raw);
  rejectAuthority(payload);
  const plan = validatePlan(payload.plan);
  const responseValue = payload.response;
  const text: unknown = responseValue === undefined ? '' : isRecord(responseValue) ? responseValue.text : responseValue;
  if (typeof text !== 'string' || text.length > 20_000) invalid();
  if (isRecord(responseValue)) rejectAuthority(responseValue);
  return Object.freeze({
    plan,
    response: Object.freeze({ text }),
    policy: Object.freeze({ capability: 'financial.read', writeAuthorized: false, approvalRequired: true, authorizationMode: 'none' }),
    source,
  }) as ValidatedProviderOutput;
};

export const adaptProviderOutput = validateProviderOutput;
export const normalizeProviderOutput = validateProviderOutput;
