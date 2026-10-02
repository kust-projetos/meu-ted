// V4 observability contract (SPEC section 24).
//
// This module is contract + validation ONLY. It defines the canonical
// event_type catalog for the 8 V4 questions and a fail-closed
// builder/serializer that rejects privacy-violating payloads. It creates
// NO new platform: persistence reuses the existing audit_logs table
// (workspace_id, event_type indexed by workspace_id + created_at;
// write in writes/postgres.ts, read in audit/store.ts, query via the
// existing GET /audit-logs route with an event_type filter), adoption_events
// (V026), the Agent Durable Object access-log (schema.ts), and the Fastify
// structured logger (server/index.ts).
//
// FAIL-CLOSED PRIVACY MODEL (FIX-F0): every event type declares a strict
// field allowlist. buildObservabilityEvent returns ONLY the allowlisted
// dimensions — any unknown field throws, any non-plain object / toJSON /
// cycle throws, and only JSON primitives, arrays, and plain objects are
// accepted. Key matching is case-insensitive (PaSs_WoRd === password);
// financial amount+description is rejected globally across the whole
// payload tree (distinct nesting levels do NOT bypass it); raw session
// cookies are rejected with or without Set-Cookie attributes.
//
// Point emitters are born alongside their own flows, not here:
//   - mic.error .................... T1.1 (PWA client event)
//   - auth.request.legacy_bearer_used  T2.2 (API central auth resolution;
//       emitted ONLY when cookie/session did not authenticate the request
//       AND the legacy bearer was the effective authenticator of the
//       fallback; header presence, attempts, and logins do not count)
//   - device.tokens.legacy_active .... T2.4 (API rotation/job, periodic log)
//   - offline.locked ................. T2.6 (PWA authenticated client report;
//       dimensions are fail-closed: offlineSubjectId is a strict UUID bound
//       to the session householdId at POST /client-events, ageBand is the
//       closed enum '<1d|1-7d|7-30d|>30d' — no free text reaches the logs)
//   - audit-undo.replay + mutation.reconcile.enqueued .. T3.1 (API)
//   - csp.violation .................. T2.7 (same-origin POST /api/csp-report)
//   - agent.workspace.legacy_access .. T4.1 (derived from the DO access-log:
//       history_export / stream; consumed via GET /history/access-log)

export const OBSERVABILITY_EVENT_TYPES = [
  'auth.request.legacy_bearer_used',
  'device.tokens.legacy_active',
  'agent.workspace.legacy_access',
  'offline.locked',
  'audit-undo.replay',
  'mutation.reconcile.enqueued',
  'mutation.authorization.evaluated',
  'mutation.autoauthorized',
  'mutation.autoexecute.blocked',
  'mic.error',
  'csp.violation',
] as const;

export type ObservabilityEventType = (typeof OBSERVABILITY_EVENT_TYPES)[number];

export type ObservabilityEvent = {
  eventType: ObservabilityEventType;
  payload: Record<string, unknown>;
};

export class ObservabilityPrivacyError extends Error {
  constructor(message: string) {
    super(`observability privacy violation: ${message}`);
    this.name = 'ObservabilityPrivacyError';
  }
}

const JWT_PATTERN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const BEARER_SCHEME_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/i;
const COOKIE_VALUE_PATTERN = /^[^=\s][^=]*=[^;]+;\s*(Path|Expires|Max-Age|Domain|Secure|HttpOnly)/i;
// Raw session cookie without Set-Cookie attributes, e.g. { context: "session=abc" }.
const RAW_SESSION_COOKIE_PATTERN =
  /\b(session|sessionid|jsessionid|phpsessid|session_token)\s*=\s*[^\s;]+/i;

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const isForbiddenKey = (key: string): { forbidden: true; label: string } | { forbidden: false } => {
  const normalized = normalizeKey(key);
  if (normalized.includes('attestation')) return { forbidden: true, label: 'attestation' };
  if (normalized.includes('password') || normalized === 'passwd' || normalized === 'pwd') {
    return { forbidden: true, label: 'password' };
  }
  if (normalized === 'cookie' || normalized === 'cookies' || normalized === 'setcookie') {
    return { forbidden: true, label: 'cookie' };
  }
  if (normalized === 'authorization') return { forbidden: true, label: 'bearer/session credential' };
  if (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized === 'bearer' ||
    normalized === 'sessionid' ||
    normalized === 'apikey' ||
    normalized === 'privatekey'
  ) {
    return { forbidden: true, label: 'bearer/session/device token' };
  }
  return { forbidden: false };
};

const FINANCIAL_AMOUNT_KEYS = new Set(['amount', 'amountcents', 'valuecents']);
const FINANCIAL_DESCRIPTION_KEYS = new Set(['description']);

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

type PrivacyScan = {
  seen: WeakSet<object>;
  /** Every normalized key found anywhere in the payload tree. */
  keys: Set<string>;
};

const assertPrivacyValue = (value: unknown, path: string, scan: PrivacyScan): void => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (JWT_PATTERN.test(trimmed)) {
      throw new ObservabilityPrivacyError(`JWT-shaped bearer/session token string is forbidden at '${path}'`);
    }
    if (BEARER_SCHEME_PATTERN.test(value)) {
      throw new ObservabilityPrivacyError(`bearer credential string is forbidden at '${path}'`);
    }
    if (COOKIE_VALUE_PATTERN.test(trimmed) || RAW_SESSION_COOKIE_PATTERN.test(value)) {
      throw new ObservabilityPrivacyError(`raw cookie/session string is forbidden at '${path}'`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ObservabilityPrivacyError(`non-finite number is not JSON-serializable at '${path}'`);
    }
    return;
  }
  if (typeof value === 'boolean' || value === null) return;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new ObservabilityPrivacyError(`non-JSON value of type '${typeof value}' is forbidden at '${path}'`);
  }
  if (Array.isArray(value)) {
    if (scan.seen.has(value)) {
      throw new ObservabilityPrivacyError(`cyclic payload reference is forbidden at '${path}'`);
    }
    scan.seen.add(value);
    value.forEach((entry, index) => assertPrivacyValue(entry, `${path}[${index}]`, scan));
    return;
  }
  if (typeof value === 'object') {
    if (scan.seen.has(value)) {
      throw new ObservabilityPrivacyError(`cyclic payload reference is forbidden at '${path}'`);
    }
    scan.seen.add(value);
    if ((value as { toJSON?: unknown }).toJSON !== undefined) {
      throw new ObservabilityPrivacyError(
        `object with a toJSON serializer is not a plain JSON object at '${path}'`,
      );
    }
    if (!isPlainObject(value)) {
      throw new ObservabilityPrivacyError(
        `non-plain object (class instance, Date, Map, or exotic) is forbidden at '${path}'`,
      );
    }
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      const verdict = isForbiddenKey(key);
      if (verdict.forbidden) {
        throw new ObservabilityPrivacyError(
          `${verdict.label} field '${key}' is forbidden at '${path}'`,
        );
      }
      scan.keys.add(normalizeKey(key));
      assertPrivacyValue(entry, path === '$' ? `$.${key}` : `${path}.${key}`, scan);
    }
  }
};

/**
 * Deep fail-closed privacy scan: recursive key AND value validation
 * (case-insensitive keys), plus a GLOBAL amount+description check — the two
 * halves in distinct nesting levels are still a complete financial payload.
 */
const assertPrivacy = (value: Record<string, unknown>, path: string): void => {
  const scan: PrivacyScan = { seen: new WeakSet(), keys: new Set() };
  assertPrivacyValue(value, path, scan);
  const hasAmount = [...FINANCIAL_AMOUNT_KEYS].some((key) => scan.keys.has(key));
  const hasDescription = [...FINANCIAL_DESCRIPTION_KEYS].some((key) => scan.keys.has(key));
  if (hasAmount && hasDescription) {
    throw new ObservabilityPrivacyError(
      `complete financial payload (amount+description anywhere in the tree) is forbidden at '${path}'`,
    );
  }
};

/** Strict per-event allowlist: the ONLY top-level fields each event accepts. */
const EVENT_ALLOWLISTS: Record<ObservabilityEventType, readonly string[]> = {
  'auth.request.legacy_bearer_used': ['workspaceId'],
  'audit-undo.replay': ['workspaceId'],
  'agent.workspace.legacy_access': ['workspaceId'],
  'device.tokens.legacy_active': ['legacyCount', 'vintage'],
  'offline.locked': ['offlineSubjectId', 'ageBand'],
  'mutation.reconcile.enqueued': ['workspaceId', 'operationId', 'reason'],
  'mutation.authorization.evaluated': ['tool', 'risk', 'decision', 'reason'],
  'mutation.autoauthorized': ['tool', 'risk', 'decision', 'reason'],
  'mutation.autoexecute.blocked': ['tool', 'risk', 'decision', 'reason'],
  'mic.error': ['reason', 'capability'],
  'csp.violation': ['effectiveDirective', 'blockedURL', 'blockedUrl', 'blockedHost', 'disposition', 'statusCode'],
};

const assertAllowlist = (
  eventType: ObservabilityEventType,
  payload: Record<string, unknown>,
): void => {
  const allowed = new Set(EVENT_ALLOWLISTS[eventType]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new ObservabilityPrivacyError(
        `event '${eventType}' rejects unknown field '${key}' (strict allowlist: ${EVENT_ALLOWLISTS[eventType].join(', ')})`,
      );
    }
  }
};

const requireNonEmptyString = (
  payload: Record<string, unknown>,
  field: string,
  eventType: ObservabilityEventType,
): string => {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObservabilityPrivacyError(
      `event '${eventType}' requires dimension '${field}' (non-empty string)`,
    );
  }
  return value;
};

const requireNonNegativeInt = (
  payload: Record<string, unknown>,
  field: string,
  eventType: ObservabilityEventType,
): number => {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ObservabilityPrivacyError(
      `event '${eventType}' requires dimension '${field}' (non-negative integer)`,
    );
  }
  return value;
};

const MIC_REASONS = ['denied', 'notfound', 'busy'] as const;
const MIC_CAPABILITIES = ['on', 'off'] as const;

/**
 * FIX-F1 closed age-band enum for `offline.locked` (SPEC §24): the client
 * reports how stale the offline lock snapshot is, in coarse bands only —
 * never timestamps, durations, or free text (log-pollution fail-closed).
 */
export const OFFLINE_AGE_BANDS = ['<1d', '1-7d', '7-30d', '>30d'] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sanitizeCspPayload = (
  payload: Record<string, unknown>,
  eventType: ObservabilityEventType,
): Record<string, unknown> => {
  const effectiveDirective = requireNonEmptyString(payload, 'effectiveDirective', eventType);
  const rawBlocked = payload['blockedURL'] ?? payload['blockedUrl'];
  let blockedHost = payload['blockedHost'];
  if (typeof rawBlocked === 'string' && rawBlocked.length > 0) {
    try {
      blockedHost = new URL(rawBlocked).hostname;
    } catch {
      throw new ObservabilityPrivacyError(
        `event '${eventType}' field 'blockedURL' is not a valid absolute URL`,
      );
    }
  }
  if (typeof blockedHost !== 'string' || blockedHost.trim().length === 0) {
    throw new ObservabilityPrivacyError(
      `event '${eventType}' requires dimension 'blockedHost' (or a 'blockedURL' to derive it from)`,
    );
  }
  const sanitized: Record<string, unknown> = {
    effectiveDirective,
    blockedHost,
  };
  if (payload['disposition'] !== undefined) {
    if (typeof payload['disposition'] !== 'string' || payload['disposition'].trim().length === 0) {
      throw new ObservabilityPrivacyError(
        `event '${eventType}' field 'disposition' must be a non-empty string when present`,
      );
    }
    sanitized['disposition'] = payload['disposition'];
  }
  if (payload['statusCode'] !== undefined) {
    if (typeof payload['statusCode'] !== 'number' || !Number.isSafeInteger(payload['statusCode'])) {
      throw new ObservabilityPrivacyError(
        `event '${eventType}' field 'statusCode' must be an integer when present`,
      );
    }
    sanitized['statusCode'] = payload['statusCode'];
  }
  return sanitized;
};

const sanitizePayload = (
  eventType: ObservabilityEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  assertPrivacy(payload, '$');
  assertAllowlist(eventType, payload);
  switch (eventType) {
    case 'auth.request.legacy_bearer_used':
    case 'audit-undo.replay':
    case 'agent.workspace.legacy_access': {
      return { workspaceId: requireNonEmptyString(payload, 'workspaceId', eventType) };
    }
    case 'device.tokens.legacy_active': {
      const sanitized: Record<string, unknown> = {
        legacyCount: requireNonNegativeInt(payload, 'legacyCount', eventType),
      };
      if (payload['vintage'] !== undefined) {
        sanitized['vintage'] = requireNonEmptyString(payload, 'vintage', eventType);
      }
      return sanitized;
    }
    case 'offline.locked': {
      const offlineSubjectId = requireNonEmptyString(payload, 'offlineSubjectId', eventType);
      if (!UUID_PATTERN.test(offlineSubjectId.trim())) {
        throw new ObservabilityPrivacyError(
          `event '${eventType}' field 'offlineSubjectId' must be a strict UUID`,
        );
      }
      const ageBand = requireNonEmptyString(payload, 'ageBand', eventType);
      if (!(OFFLINE_AGE_BANDS as readonly string[]).includes(ageBand)) {
        throw new ObservabilityPrivacyError(
          `event '${eventType}' field 'ageBand' must be one of ${OFFLINE_AGE_BANDS.join('|')}`,
        );
      }
      return { offlineSubjectId, ageBand };
    }
    case 'mutation.reconcile.enqueued': {
      return {
        workspaceId: requireNonEmptyString(payload, 'workspaceId', eventType),
        operationId: requireNonEmptyString(payload, 'operationId', eventType),
        reason: requireNonEmptyString(payload, 'reason', eventType),
      };
    }
    case 'mutation.authorization.evaluated':
    case 'mutation.autoauthorized':
    case 'mutation.autoexecute.blocked':
      return {
        tool: requireNonEmptyString(payload, 'tool', eventType),
        risk: requireNonEmptyString(payload, 'risk', eventType),
        decision: requireNonEmptyString(payload, 'decision', eventType),
        reason: requireNonEmptyString(payload, 'reason', eventType),
      };
    case 'mic.error': {
      const reason = requireNonEmptyString(payload, 'reason', eventType);
      const capability = requireNonEmptyString(payload, 'capability', eventType);
      if (!(MIC_REASONS as readonly string[]).includes(reason)) {
        throw new ObservabilityPrivacyError(
          `event '${eventType}' field 'reason' must be one of ${MIC_REASONS.join('|')}`,
        );
      }
      if (!(MIC_CAPABILITIES as readonly string[]).includes(capability)) {
        throw new ObservabilityPrivacyError(
          `event '${eventType}' field 'capability' must be one of ${MIC_CAPABILITIES.join('|')}`,
        );
      }
      return { reason, capability };
    }
    case 'csp.violation': {
      return sanitizeCspPayload(payload, eventType);
    }
  }
};

export const buildObservabilityEvent = (
  eventType: ObservabilityEventType,
  payload: Record<string, unknown> = {},
): ObservabilityEvent => ({
  eventType,
  payload: sanitizePayload(eventType, payload),
});
