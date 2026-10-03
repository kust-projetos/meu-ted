export type EvidenceStatus = 'ok' | 'empty' | 'error';

/**
 * A04/R04 — SEPARATE typed axes, never one enumeration.
 *
 * - `ReadAbsenceReason`: the query SUCCEEDED and the requested scope has no
 *   data (`empty` items only).
 * - `ReadFailureReason`: the query did NOT produce a conclusion (`error` items
 *   only). A failure item can never carry an absence reason, so "the read broke"
 *   can never be narrated as "there is nothing there" (R04).
 * - `EntityResolutionOutcome`: entity resolution (`found` / `ambiguous`), a
 *   different axis from read absence and from the mutation cycle.
 *
 * `workspace_empty` is part of the vocabulary but has NO producer yet: proving
 * a globally empty workspace needs the consistent multi-read snapshot of A09
 * (A04 block b). Until then a channel can only state its own scope.
 */
export const READ_ABSENCE_REASONS = [
  'workspace_empty',
  'setup_incomplete',
  'period_empty',
  'category_empty',
  'filter_empty',
  'entity_not_found',
] as const;
export type ReadAbsenceReason = (typeof READ_ABSENCE_REASONS)[number];

export const READ_FAILURE_REASONS = ['retryable_error', 'permanent_error', 'forbidden', 'unavailable'] as const;
export type ReadFailureReason = (typeof READ_FAILURE_REASONS)[number];

export const ENTITY_RESOLUTION_OUTCOMES = ['found', 'ambiguous'] as const;
export type EntityResolutionOutcome = (typeof ENTITY_RESOLUTION_OUTCOMES)[number];

/** Union accepted by the envelope, narrowed per status by `EvidenceItem`. */
export type EvidenceReason = ReadAbsenceReason | ReadFailureReason;

/**
 * Discriminated by `status`, so the two axes cannot be crossed: `ok` carries no
 * reason, `empty` only an absence reason, `error` only a failure reason.
 */
export type EvidenceItem =
  | Readonly<{ ref: string; source: string; retrievedAt: string; status: 'ok'; data: unknown; reason?: undefined }>
  | Readonly<{ ref: string; source: string; retrievedAt: string; status: 'empty'; data: unknown; reason?: ReadAbsenceReason }>
  | Readonly<{ ref: string; source: string; retrievedAt: string; status: 'error'; data: unknown; reason?: ReadFailureReason }>;

export type EvidenceEnvelope = Readonly<{
  version: '1';
  items: readonly EvidenceItem[];
}>;

const MAX_PAYLOAD_BYTES = 10_000;
/** Upper bound for the absence/failure states added to the prompt payload. */
export const MAX_PROMPT_ABSENCES = 4;
const technicalFields = new Set(['workspaceId', 'actorId', 'deviceId', 'token', 'accessToken', 'authorization', 'headers', 'internalId', 'id']);

const project = (value: unknown, allowed?: readonly string[]): unknown => {
  if (Array.isArray(value)) return value.map((item) => project(item, allowed));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (technicalFields.has(key) || (allowed && !allowed.includes(key))) continue;
    output[key] = project(child, allowed);
  }
  return output;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

type EvidenceInputBase = Readonly<{
  ref: string;
  source: string;
  retrievedAt: string;
  data: unknown;
}>;

/**
 * Producer-side face, discriminated by `status` exactly like `EvidenceItem`:
 * each variant only accepts a reason from ITS OWN axis, and the inference
 * variant carries no reason at all (status is then derived from `data`).
 *
 * Crossing the axes — `{status: 'error', reason: 'period_empty'}` — is a
 * COMPILE error, not a runtime surprise. `createEvidenceEnvelope` still
 * validates at runtime, because untyped callers and projected payloads cannot
 * be trusted to have gone through this type.
 */
export type EvidenceInput =
  | (EvidenceInputBase & { status: 'ok'; reason?: undefined })
  | (EvidenceInputBase & { status: 'empty'; reason?: ReadAbsenceReason })
  | (EvidenceInputBase & { status: 'error'; reason?: ReadFailureReason })
  | (EvidenceInputBase & { status?: undefined; reason?: undefined });

const isAbsenceReason = (value: unknown): value is ReadAbsenceReason =>
  typeof value === 'string' && (READ_ABSENCE_REASONS as readonly string[]).includes(value);
const isFailureReason = (value: unknown): value is ReadFailureReason =>
  typeof value === 'string' && (READ_FAILURE_REASONS as readonly string[]).includes(value);

/**
 * Sanitized classification of a FAILED read, derived from the transport signal
 * ONLY (`statusCode` / timeout marker). The thrown message can carry API/HTTP
 * text and is never part of the result, so evidence cannot leak it.
 */
export const classifyReadFailure = (error: unknown): ReadFailureReason => {
  const status = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (error instanceof Error && error.message.includes('agent.evidence_timeout:')) return 'retryable_error';
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'forbidden';
    if (status === 429 || status >= 500) return 'retryable_error';
    if (status >= 400) return 'permanent_error';
  }
  return 'unavailable';
};

export const createEvidenceEnvelope = (items: readonly EvidenceInput[], options: { allowedFields?: readonly string[] } = {}): EvidenceEnvelope => {
  const projected = items.map((item) => {
    if (!item.ref || !item.source || Number.isNaN(Date.parse(item.retrievedAt))) throw new Error('evidence.invalid');
    const status = item.status ?? (item.data == null ? 'empty' : 'ok');
    const base = { ref: item.ref, source: item.source, retrievedAt: item.retrievedAt, data: project(item.data, options.allowedFields) };
    // Whitelist validation per axis: an unknown/off-axis reason (raw text
    // included) invalidates the item instead of reaching the prompt.
    if (status === 'ok') {
      if (item.reason !== undefined) throw new Error('evidence.invalid');
      return { ...base, status } satisfies EvidenceItem;
    }
    if (status === 'empty') {
      if (!isAbsenceReason(item.reason) && item.reason !== undefined) throw new Error('evidence.invalid');
      return { ...base, status, ...(item.reason === undefined ? {} : { reason: item.reason }) } satisfies EvidenceItem;
    }
    if (status !== 'error' || (!isFailureReason(item.reason) && item.reason !== undefined)) throw new Error('evidence.invalid');
    return { ...base, status, ...(item.reason === undefined ? {} : { reason: item.reason }) } satisfies EvidenceItem;
  });
  const envelope = { version: '1', items: projected } satisfies EvidenceEnvelope;
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > MAX_PAYLOAD_BYTES) throw new Error('evidence.payload_too_large');
  return deepFreeze(envelope);
};

export const isCurrentEvidence = (item: EvidenceItem, now = Date.now(), maxAgeMs = 5 * 60_000): boolean => {
  const timestamp = Date.parse(item.retrievedAt);
  return item.status === 'ok' && Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAgeMs;
};

/**
 * Safe, minimal representation for a provider prompt; technical metadata is not
 * forwarded.
 *
 * A04/R04 decision: absences and failures ARE serialized, but only as the
 * closed typed axis (`{status, reason}`, deduped, capped at
 * `MAX_PROMPT_ABSENCES`, failures given priority over absences when the cap
 * fills) plus an explicit `noEvidence` flag. Rationale: the
 * previous `{"items":[]}` shape is precisely the ambiguous state R04 forbids —
 * a model could read a forbidden/failed read as "no transactions" (AC10). The
 * payload stays bounded (closed vocabulary, no raw text, cap), the technical
 * field filter and the `ok` item shape are unchanged, and non-`ok` items still
 * never support a grounding claim (`validateGroundedClaims` reads `ok` only).
 */
export const serializeEvidenceForPrompt = (envelope: EvidenceEnvelope): string => {
  const usable = envelope.items.filter((item) => item.status === 'ok');
  const render = (item: EvidenceItem): { status: 'empty' | 'error'; reason?: ReadAbsenceReason | ReadFailureReason } => ({
    status: item.status as 'empty' | 'error',
    ...(item.reason === undefined ? {} : { reason: item.reason }),
  });
  // Cap fill order: FAILURES FIRST. A first-come cap would spend every slot on
  // absences and could drop an `error` (e.g. `forbidden`), leaving the model a
  // state it could read as "no data" — the AC10 regression. Absences give way
  // instead; emission below still follows envelope order, so the serialized
  // shape of an uncapped envelope is unchanged.
  const selected = new Set<string>();
  const seen = new Set<string>();
  const keyOf = (item: EvidenceItem): string => `${item.status}:${item.reason ?? ''}`;
  for (const pass of ['error', 'empty'] as const) {
    for (const item of envelope.items) {
      if (item.status !== pass || selected.size >= MAX_PROMPT_ABSENCES) continue;
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.add(key);
    }
  }
  const emitted = new Set<string>();
  const absences = envelope.items
    .filter((item) => {
      if (item.status === 'ok') return false;
      const key = keyOf(item);
      // Dedupe again on emission: several items may share one key, and only the
      // first occurrence travels.
      if (!selected.has(key) || emitted.has(key)) return false;
      emitted.add(key);
      return true;
    })
    .map(render);
  return JSON.stringify({
    items: usable.map((item) => ({ retrievedAt: item.retrievedAt, data: item.data })),
    ...(absences.length > 0 ? { absences } : {}),
    ...(usable.length === 0 ? { noEvidence: true } : {}),
  });
};
