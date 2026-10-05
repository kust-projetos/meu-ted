/**
 * A13 / R11 — attachment storage boundary.
 *
 * G05 was resolved as private R2 through an OPTIONAL binding
 * (`TED_ATTACHMENTS_BUCKET`). Without that binding the byte pipeline is
 * UNAVAILABLE and fail-closed: `getAttachmentStorage` returns `null` and every
 * caller degrades to "no upload", never to a local/ephemeral fallback.
 *
 * `wrangler.jsonc` is deliberately NOT changed here — creating the bucket and
 * wiring the binding is a rollout step (A19), documented in the slice report.
 *
 * The R2 surface is declared as the minimal local interface `R2BucketLike`
 * instead of the platform `R2Bucket` so the agent program typechecks without
 * pulling `@cloudflare/workers-types` into the tsconfig `types` (which today is
 * `["node"]` only). Only the four members the adapter uses are declared.
 */

import type { AttachmentRecord } from './types.js';

/** Minimal R2 surface used by this adapter (no platform type dependency). */
export type R2BucketLike = {
  put: (
    key: string,
    value: ArrayBuffer,
    options?: { customMetadata?: Record<string, string> },
  ) => Promise<unknown>;
  get: (
    key: string,
  ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; customMetadata?: Record<string, string> } | null>;
  delete: (key: string) => Promise<unknown>;
  /**
   * `include` and `cursor` mirror the real R2 API: WITHOUT
   * `include: ['customMetadata']` a listing carries no metadata at all, and
   * `truncated`/`cursor` paginate the result. Both matter to the TTL sweep —
   * see `ATTACHMENT_CLEANUP_MAX_PAGES`.
   */
  list: (options?: { prefix?: string; cursor?: string; include?: string[] }) => Promise<{
    objects: Array<{ key: string; customMetadata?: Record<string, string> }>;
    truncated?: boolean;
    cursor?: string;
  }>;
};

/**
 * The storage contract. `put` stores metadata + bytes; `get` is a miss-or-hit
 * read (never a throw for "absent"); `sweepByExpiry` is the cheap TTL sweep
 * cursor used by cleanup, and `listByExpiry` is its records-only projection
 * (kept for callers that never care where the sweep stopped).
 */
export type AttachmentStorage = {
  put: (record: AttachmentRecord, bytes: ArrayBuffer) => Promise<void>;
  get: (ref: string) => Promise<{ record: AttachmentRecord; bytes: ArrayBuffer } | null>;
  delete: (ref: string) => Promise<void>;
  listByExpiry: (before: number, limit: number, startCursor?: string) => Promise<AttachmentRecord[]>;
  sweepByExpiry: (before: number, limit: number, startCursor?: string) => Promise<ExpirySweep>;
};

/**
 * A19 — durable position of the TTL sweep.
 *
 * The position is durable state, but it must NOT be owned by the storage
 * adapter: `ingest` and the DO know nothing about each other's storage. These
 * three methods are the whole contract — the DO backs them with its KV storage
 * and tests back them with a Map. Every call is best-effort at the caller.
 */
export interface AttachmentCleanupCheckpoint {
  get(): Promise<string | undefined>;
  put(cursor: string): Promise<void>;
  clear(): Promise<void>;
}

/** Key the DO persists the cleanup cursor under. */
export const ATTACHMENT_CLEANUP_CURSOR_KEY = 'ted.attachments.cleanup.cursor';

/**
 * Result of ONE bounded sweep.
 *
 * `nextCursor` is the continuation of the LAST PAGE CONSUMED, so the next sweep
 * resumes exactly where this one stopped. `undefined` means the listing was
 * read to its end (the sweep wrapped) and any persisted checkpoint must be
 * cleared — that wrap is what keeps the sweep convergent, since an object is
 * never skipped for good: the worst case is that a page is revisited once per
 * full cycle.
 */
export type ExpirySweep = {
  records: AttachmentRecord[];
  nextCursor?: string;
};

/** Namespaced prefix so a bucket can host other object families. */
export const ATTACHMENT_KEY_PREFIX = 'ted/attachments/v1/';

/**
 * Page ceiling for ONE cleanup sweep.
 *
 * R2 lists 1000 keys per page. A sweep is triggered by an upload and must stay
 * cheap, so it walks at most this many pages and stops.
 *
 * A19 — stopping early is only safe BECAUSE the sweep is resumable: the caller
 * persists the cursor of the last page consumed (`ExpirySweep.nextCursor`) and
 * the next sweep continues from there. A sweep that simply restarted at the
 * prefix would starve forever: with more than this many pages of LIVE objects
 * ahead of the expired ones, the expired objects are never reached. The wrap
 * (reaching the end of the listing) clears the checkpoint so the cycle restarts
 * at the prefix, and deletions stay idempotent, so nothing is lost either way.
 */
export const ATTACHMENT_CLEANUP_MAX_PAGES = 10;

const keyFor = (ref: string): string => `${ATTACHMENT_KEY_PREFIX}${ref}`;

/**
 * F11 — equality of an HMAC-derived token, without an early exit.
 *
 * `===` returns as soon as the first byte differs, so the time it takes leaks
 * how many leading characters matched. The attachment ref IS a MAC over
 * (domain, workspace, actor, content), so every comparison of it is compared
 * here instead: the loop always walks the full length and folds the result.
 * Length is folded into the accumulator rather than short-circuited, so a
 * length mismatch is not distinguishable from a content mismatch either.
 */
export const constantTimeEquals = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length;
  const length = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** CustomMetadata is string->string; the record is serialised defensively. */
const encodeRecord = (record: AttachmentRecord): Record<string, string> => ({
  ref: record.ref,
  workspaceId: record.workspaceId,
  actorId: record.actorId,
  kind: record.kind,
  name: record.name,
  size: String(record.size),
  sha256: record.sha256,
  createdAt: String(record.createdAt),
  expiresAt: String(record.expiresAt),
  mime: record.mime,
  ...(record.width !== undefined ? { width: String(record.width) } : {}),
  ...(record.height !== undefined ? { height: String(record.height) } : {}),
});

const decodeRecord = (raw: Record<string, string> | undefined): AttachmentRecord | null => {
  if (!raw || typeof raw.ref !== 'string' || raw.ref.length === 0) return null;
  const size = Number(raw.size);
  const createdAt = Number(raw.createdAt);
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(size) || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  if (typeof raw.workspaceId !== 'string' || typeof raw.actorId !== 'string') return null;
  if (raw.kind !== 'image' && raw.kind !== 'pdf' && raw.kind !== 'audio') return null;
  const width = raw.width === undefined ? undefined : Number(raw.width);
  const height = raw.height === undefined ? undefined : Number(raw.height);
  return {
    ref: raw.ref,
    workspaceId: raw.workspaceId,
    actorId: raw.actorId,
    kind: raw.kind,
    name: typeof raw.name === 'string' ? raw.name : '',
    size,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
    createdAt,
    expiresAt,
    mime: typeof raw.mime === 'string' ? raw.mime : 'application/octet-stream',
    ...(width !== undefined && Number.isFinite(width) ? { width } : {}),
    ...(height !== undefined && Number.isFinite(height) ? { height } : {}),
  };
};

/**
 * A19 — the bounded, RESUMABLE TTL sweep over the R2 listing.
 *
 * F3: TWO properties the real R2 API forces and a naive listing gets wrong.
 * 1. `include: ['customMetadata']` — a listing WITHOUT it carries no metadata,
 *    so every record decodes to null and NOTHING is ever swept.
 * 2. `cursor`/`truncated` — the listing is paginated, so a single call only ever
 *    sees the first page. The sweep follows the cursor up to the page ceiling
 *    and REPORTS where it stopped, so the next sweep resumes there instead of
 *    re-reading the same first pages (which is what starved the tail forever).
 *
 * Fail-safe on a stale cursor: R2 may reject a continuation token that aged out,
 * so a first page fetch that throws with `startCursor` is retried ONCE from the
 * prefix. Losing the position costs one sweep; failing the upload costs the
 * user's attachment.
 */
const sweepR2ByExpiry = async (
  bucket: R2BucketLike,
  before: number,
  limit: number,
  startCursor?: string,
): Promise<ExpirySweep> => {
  const expired: AttachmentRecord[] = [];
  let cursor: string | undefined = startCursor;
  // Continuation of the last page fully consumed — the resume point.
  let nextCursor: string | undefined;
  for (let page = 0; page < ATTACHMENT_CLEANUP_MAX_PAGES; page += 1) {
    let listed: { objects: Array<{ key: string; customMetadata?: Record<string, string> }>; truncated?: boolean; cursor?: string };
    try {
      listed = await bucket.list({
        prefix: ATTACHMENT_KEY_PREFIX,
        include: ['customMetadata'],
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch (error) {
      // Only the FIRST page can carry a cursor persisted by a previous sweep.
      // If it is rejected the sweep restarts from the prefix; anything else is
      // a real listing failure and propagates to the caller's best-effort catch.
      if (page !== 0 || startCursor === undefined) throw error;
      listed = await bucket.list({
        prefix: ATTACHMENT_KEY_PREFIX,
        include: ['customMetadata'],
      });
    }
    for (const object of listed.objects) {
      if (expired.length >= limit) {
        // The record budget is spent mid-page: the page's own continuation is
        // the pending resume point (its tail is revisited on the next cycle).
        return { records: expired, ...(typeof listed.cursor === 'string' ? { nextCursor: listed.cursor } : {}) };
      }
      const record = decodeRecord(object.customMetadata);
      if (!record) continue;
      if (record.expiresAt > before) continue;
      expired.push(record);
    }
    // End of the listing (or no usable continuation) ⇒ the sweep wrapped.
    if (!listed.truncated || typeof listed.cursor !== 'string') return { records: expired };
    nextCursor = listed.cursor;
    cursor = listed.cursor;
  }
  // Page ceiling reached: `nextCursor` resumes right after the last page read.
  return { records: expired, ...(nextCursor !== undefined ? { nextCursor } : {}) };
};

/**
 * Production adapter. Keys are opaque refs (never workspace/actor/raw), so a
 * bucket listing leaks no tenant structure beyond the random ref itself, and
 * the ownership keys live in the object metadata where every read re-checks.
 */
export const createR2AttachmentStorage = (bucket: R2BucketLike): AttachmentStorage => ({
  async put(record, bytes) {
    await bucket.put(keyFor(record.ref), bytes, { customMetadata: encodeRecord(record) });
  },
  async get(ref) {
    const object = await bucket.get(keyFor(ref));
    if (!object) return null;
    const record = decodeRecord(object.customMetadata);
    if (!record) return null;
    // Defensive: a key/metadata mismatch is a miss, never a cross-identity
    // hit. F11: the ref is a MAC-derived token, so the comparison never
    // short-circuits on the first differing character.
    if (!constantTimeEquals(record.ref, ref)) return null;
    return { record, bytes: await object.arrayBuffer() };
  },
  async delete(ref) {
    await bucket.delete(keyFor(ref));
  },
  async sweepByExpiry(before, limit, startCursor) {
    return sweepR2ByExpiry(bucket, before, limit, startCursor);
  },
  async listByExpiry(before, limit, startCursor) {
    return (await sweepR2ByExpiry(bucket, before, limit, startCursor)).records;
  },
});

/** In-memory adapter for tests: same semantics, no bucket. */
export const createMemoryAttachmentStorage = (): AttachmentStorage => {
  const records = new Map<string, AttachmentRecord>();
  const blobs = new Map<string, ArrayBuffer>();
  const sweepByExpiry = async (before: number, limit: number): Promise<ExpirySweep> => {
    const expired: AttachmentRecord[] = [];
    for (const record of records.values()) {
      if (record.expiresAt > before) continue;
      expired.push(record);
      if (expired.length >= limit) break;
    }
    // A full in-memory scan always reaches the end, so it always wraps: there
    // is no pagination to resume from and never a cursor to persist.
    return { records: expired };
  };
  return {
    async put(record, bytes) {
      records.set(record.ref, record);
      blobs.set(record.ref, bytes);
    },
    async get(ref) {
      const record = records.get(ref);
      if (!record) return null;
      const bytes = blobs.get(ref);
      if (!bytes) return null;
      return { record, bytes };
    },
    async delete(ref) {
      records.delete(ref);
      blobs.delete(ref);
    },
    sweepByExpiry,
    async listByExpiry(before, limit) {
      return (await sweepByExpiry(before, limit)).records;
    },
  };
};

const isR2BucketLike = (value: unknown): value is R2BucketLike => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['put'] === 'function' &&
    typeof candidate['get'] === 'function' &&
    typeof candidate['delete'] === 'function' &&
    typeof candidate['list'] === 'function'
  );
};

/**
 * The capability switch. Absent/!R2 binding ⇒ `null` ⇒ the upload RPC answers
 * `attachment_storage_unavailable` and the chat reference path treats every
 * `ref` as unavailable. Default-off, fail-closed, no fallback storage.
 */
export const getAttachmentStorage = (env: unknown): AttachmentStorage | null => {
  const bucket = (env as { TED_ATTACHMENTS_BUCKET?: unknown } | undefined)?.TED_ATTACHMENTS_BUCKET;
  if (!isR2BucketLike(bucket)) return null;
  return createR2AttachmentStorage(bucket);
};
