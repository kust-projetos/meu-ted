/**
 * Idempotency store and validation contract.
 *
 * Implements G2.2.4 (HTTP boundary validation) and G0.4.2 (composed SHA-256 identity).
 *
 * Lifecycle:
 * - Replay window: 7 days. Same key + same payload replays recorded response.
 * - Conflict window: 7 to 90 days. Same key raises idempotency.conflict.
 * - Eviction / Retention: > 90 days. Key expires and is removed.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { domainErrors } from './errors.js';

export const IDEMPOTENCY_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type IdempotencyRequest = {
  workspaceId: string;
  actorType: 'device' | 'user';
  actorId: string;
  operation: string;
  key: string;
};

/**
 * FIX-UNDO (F3, SPEC §12 F3 opção 1): producers MAY accept the claim
 * transaction client. Postgres-backed stores pass their open `PoolClient`
 * so the financial effect joins the claim transaction (single atomic
 * commit); stores without a transaction (in-memory) pass nothing.
 * The parameter is optional, so every existing `() => Promise<T>`
 * producer keeps compiling and behaving exactly as before.
 */
export type IdempotencyProducer<T> = (tx?: unknown) => Promise<T>;

/**
 * T3.2 (SPEC §12 F1 Opção A): claim lifecycle in parity with the Postgres
 * claim→complete lifecycle (writes/postgres.ts `processing` INSERT … upgrade
 * to `completed`). The claim is written SYNCHRONOUSLY as `processing` BEFORE
 * the producer runs; success upgrades it to `completed`, a producer throw
 * retains it as `failed`. A same-key/same-payload retry over a
 * `processing` (orphan — the synchronous producer already settled) or
 * `failed` claim TAKES OVER and re-executes the producer; a divergent
 * payload raises `idempotency.conflict` (same rule as the Postgres
 * payload_hash check). Torn intra-producer state is NOT representable in
 * heap — a real process crash loses heap effect + heap claim together, and
 * the in-memory producer is one synchronous atomic step — so there is no
 * mid-point to roll back to; the store guarantees observable replay
 * semantics, and the production atomicity proof stays on Postgres.
 */
export type IdempotencyClaimStatus = 'processing' | 'completed' | 'failed';

export type IdempotencyEntry<T> = {
  payloadHash: string;
  response: T;
  createdAt: number;
  status: IdempotencyClaimStatus;
};

export type IdempotencyStore = {
  lookupOrRecord<T>(
    householdId: string,
    key: string,
    payload: unknown,
    producer: IdempotencyProducer<T>,
  ): Promise<{ response: T; replayed: boolean }>;
  lookupOrRecord<T>(
    request: IdempotencyRequest,
    payload: unknown,
    producer: IdempotencyProducer<T>,
  ): Promise<{ response: T; replayed: boolean }>;
  clear(): void;
};

export const buildIdempotencyKey = (req: IdempotencyRequest): string => {
  const canonical = `${req.workspaceId}:${req.actorId}:${req.operation}:${req.key}`;
  return createHash('sha256').update(canonical).digest('hex');
};

export const hashIdempotencyPayload = (payload: unknown, version = 1): string => {
  const json = typeof payload === 'object' && payload !== null
    ? JSON.stringify(payload, Object.keys(payload as object).sort())
    : JSON.stringify(payload);
  const raw = `v${version}:${json}`;
  return createHash('sha256').update(raw).digest('hex');
};

/**
 * V4.1 Phase 3 Task 3.6 — SHA-256 V2: `sha256("v2:" + canonicalJson(input))`.
 * All NEW idempotency claims (in-memory, Postgres `operation_records`,
 * pending-V2 `idempotency_keys`) record this hash. The legacy v1-sha256
 * (`hashIdempotencyPayload`, top-level keys only) and the unversioned 32-bit
 * `h*31` hash (Postgres claim path) stay readable via `matchesPayloadHash`.
 */
export const hashPayloadV2 = (payload: unknown): string => {
  const raw = `v2:${canonicalJson(payload)}`;
  return createHash('sha256').update(raw).digest('hex');
};

/**
 * V4.1 Phase 3 Task 3.6 — the pre-V2 Postgres claim hash (writes/postgres.ts):
 * unversioned 32-bit `h*31` over the top-level-sorted JSON, `'0'` for
 * null/undefined. Kept byte-identical so old rows keep matching.
 */
export const legacyHashPayload = (payload: unknown): string => {
  if (payload === undefined || payload === null) return '0';
  const json = typeof payload === 'object'
    ? JSON.stringify(payload, Object.keys(payload as object).sort())
    : JSON.stringify(payload);
  let h = 0;
  for (let i = 0; i < json.length; i++) h = (h * 31 + json.charCodeAt(i)) | 0;
  return String(h);
};

/**
 * HTTP idempotency envelope (v3).
 *
 * HTTP callsites wrap their body with `httpIdempotencyPayload` so the hash
 * consumed by the existing `lookupOrRecord` covers a versioned canonical
 * route/method/resource/origin identity plus the body. The raw
 * Idempotency-Key keeps its workspace uniqueness (`buildIdempotencyKey` is
 * untouched); only the hashed payload gains operation identity.
 *
 * Non-HTTP callers keep passing raw payloads and behave exactly as before.
 */
export const HTTP_IDEMPOTENCY_ENVELOPE_VERSION = 3 as const;

export type HttpIdempotencyOperationIdentity = {
  /** Route template identity: `METHOD /path-template`, e.g. `POST /cards/purchases`. */
  route: string;
  /** Route resource id (e.g. `:id` param) when the route addresses one resource. */
  resourceId?: string;
  /** Caller origin (e.g. `pwa`, `agent`) when the same route serves several origins. */
  origin?: string;
};

export type HttpIdempotencyEnvelope = {
  version: typeof HTTP_IDEMPOTENCY_ENVELOPE_VERSION;
  route: string;
  resourceId?: string;
  origin?: string;
  payload: unknown;
};

export const isHttpIdempotencyEnvelope = (value: unknown): value is HttpIdempotencyEnvelope => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === HTTP_IDEMPOTENCY_ENVELOPE_VERSION &&
    typeof record['route'] === 'string' &&
    'payload' in record
  );
};

const HTTP_ROUTE_PATTERN = /^[A-Z]{3,7} \/.+/;

/**
 * Builds a JSON-safe v3 envelope for HTTP callsites.
 *
 * Stability: the envelope is hashed with `hashPayloadV2` (canonical JSON),
 * so key order never changes the hash. A distinct `route`, `resourceId` or
 * `origin` produces a different hash (cross-route/cross-origin reuse
 * conflicts instead of replaying).
 */
export const httpIdempotencyPayload = (
  operationIdentity: HttpIdempotencyOperationIdentity,
  payload: unknown,
): HttpIdempotencyEnvelope => {
  const route = operationIdentity?.route;
  if (typeof route !== 'string' || !HTTP_ROUTE_PATTERN.test(route)) {
    throw domainErrors.invalid('route', 'route must look like "POST /cards/purchases"');
  }
  const resourceId = operationIdentity?.resourceId;
  if (resourceId !== undefined && (typeof resourceId !== 'string' || !resourceId)) {
    throw domainErrors.invalid('resourceId', 'resourceId must be a non-empty string when provided');
  }
  const origin = operationIdentity?.origin;
  if (origin !== undefined && (typeof origin !== 'string' || !origin)) {
    throw domainErrors.invalid('origin', 'origin must be a non-empty string when provided');
  }
  return {
    ...( { version: HTTP_IDEMPOTENCY_ENVELOPE_VERSION } as const ),
    route,
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(origin !== undefined ? { origin } : {}),
    payload,
  };
};

/**
 * V4.1 Phase 3 Task 3.7 — tolerant replay comparison. A stored hash replays
 * when it matches the V2 recomputation OR either legacy algorithm; anything
 * else is a payload mismatch (caller raises `idempotency.conflict`).
 *
 * Strictness for HTTP envelopes (v3): an envelope payload replays ONLY on a
 * V2 match over that exact envelope. Legacy v1-sha256 / 32-bit hashes never
 * match an envelope — including legacy hashes of the raw body — so a claim
 * recorded over a raw payload can never replay as an enveloped claim.
 */
export const matchesPayloadHash = (storedHash: string, payload: unknown): boolean => {
  if (isHttpIdempotencyEnvelope(payload)) {
    return storedHash === hashPayloadV2(payload);
  }
  return (
    storedHash === hashPayloadV2(payload) ||
    storedHash === hashIdempotencyPayload(payload) ||
    storedHash === legacyHashPayload(payload)
  );
};

export const createIdempotencyRequest = (
  identity: { householdId: string; deviceId?: string },
  operation: string,
  key: string,
): IdempotencyRequest => ({
  workspaceId: identity.householdId,
  actorType: 'device',
  actorId: identity.deviceId ?? 'device',
  operation,
  key,
});

export const createInMemoryIdempotencyStore = (): IdempotencyStore => {
  const store = new Map<string, IdempotencyEntry<unknown>>();
  const inFlight = new Map<string, { payloadHash: string; promise: Promise<unknown> }>();

  const evictExpired = (now: number): void => {
    for (const [k, v] of store.entries()) {
      if (now - v.createdAt > IDEMPOTENCY_RETENTION_WINDOW_MS) {
        store.delete(k);
      }
    }
  };

  return {
    async lookupOrRecord(scopeOrHouseholdId: any, keyOrPayload: any, payloadOrProducer: any, maybeProducer?: any) {
      let composite: string;
      let payload: unknown;
      // In-memory has no transaction: the producer always runs with no tx.
      let producer: IdempotencyProducer<any>;

      if (typeof scopeOrHouseholdId === 'object' && scopeOrHouseholdId !== null) {
        composite = buildIdempotencyKey(scopeOrHouseholdId);
        payload = keyOrPayload;
        producer = payloadOrProducer;
      } else {
        composite = `${scopeOrHouseholdId}::${keyOrPayload}`;
        payload = payloadOrProducer;
        producer = maybeProducer;
      }

      const now = Date.now();
      evictExpired(now);
      const existing = store.get(composite);
      // V4.1 Phase 3 Tasks 3.6/3.7: new claims record V2; reads stay
      // tolerant so rows written by older builds still replay.
      const payloadHash = hashPayloadV2(payload);
      // Takeover target: a retained non-completed claim reuses its original
      // creation time (retention still applies from the first claim).
      let claimedAt = now;

      if (existing) {
        const age = now - existing.createdAt;
        if (age > IDEMPOTENCY_RETENTION_WINDOW_MS) {
          store.delete(composite);
        } else if (existing.status === 'completed') {
          if (age > IDEMPOTENCY_RETRY_WINDOW_MS) {
            throw domainErrors.idempotencyConflict();
          } else {
            if (!matchesPayloadHash(existing.payloadHash, payload)) {
              throw domainErrors.idempotencyConflict();
            }
            return { response: existing.response as never, replayed: true };
          }
        } else {
          // Retained processing (orphan — no in-flight execution owns it
          // anymore) or failed claim: same payload takes over below and
          // re-executes the producer; divergent payload conflicts, mirroring
          // the Postgres payload_hash rule.
          if (!matchesPayloadHash(existing.payloadHash, payload)) {
            throw domainErrors.idempotencyConflict();
          }
          claimedAt = existing.createdAt;
        }
      }

      const flight = inFlight.get(composite);
      if (flight) {
        if (!matchesPayloadHash(flight.payloadHash, payload)) {
          throw domainErrors.idempotencyConflict();
        }
        const response = await flight.promise;
        return { response: response as never, replayed: true };
      }

      let resolveFlight!: (val: unknown) => void;
      let rejectFlight!: (err: unknown) => void;
      const flightPromise = new Promise<unknown>((res, rej) => {
        resolveFlight = res;
        rejectFlight = rej;
      });
      flightPromise.catch(() => undefined);

      inFlight.set(composite, { payloadHash, promise: flightPromise });
      // Claim BEFORE the producer (synchronous, mirrors the Postgres
      // `processing` INSERT): a throw anywhere below leaves the claim
      // retained as processing/failed for a same-payload takeover.
      store.set(composite, {
        payloadHash,
        response: undefined as never,
        createdAt: claimedAt,
        status: 'processing',
      });

      try {
        const response = await producer();
        store.set(composite, { payloadHash, response, createdAt: claimedAt, status: 'completed' });
        resolveFlight(response);
        return { response, replayed: false };
      } catch (err) {
        const claim = store.get(composite);
        if (claim && claim.payloadHash === payloadHash && claim.status === 'processing') {
          store.set(composite, { ...claim, status: 'failed' });
        }
        rejectFlight(err);
        throw err;
      } finally {
        inFlight.delete(composite);
      }
    },
    clear() {
      store.clear();
      inFlight.clear();
    },
  };
};

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Validates the Idempotency-Key header.
 * Throws validation.required when missing/blank.
 * Throws validation.invalid when array/ambiguous or oversized (>255 chars).
 */
export const requireIdempotencyKey = (headers: Record<string, unknown>): string => {
  const raw = headers[IDEMPOTENCY_KEY_HEADER] ?? headers['Idempotency-Key'];
  if (raw === undefined || raw === null) {
    throw domainErrors.required('Idempotency-Key');
  }
  if (Array.isArray(raw)) {
    throw domainErrors.invalid('Idempotency-Key', 'Multiple Idempotency-Key headers are ambiguous');
  }
  const key = String(raw).trim();
  if (!key) {
    throw domainErrors.invalid('Idempotency-Key', 'Idempotency-Key cannot be empty');
  }
  if (key.length > 255) {
    throw domainErrors.invalid('Idempotency-Key', 'Idempotency-Key is too long (max 255 chars)');
  }
  return key;
};
