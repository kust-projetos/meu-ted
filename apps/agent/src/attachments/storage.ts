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
 * read (never a throw for "absent"); `listByExpiry` is the cheap TTL sweep
 * cursor used by cleanup.
 */
export type AttachmentStorage = {
  put: (record: AttachmentRecord, bytes: ArrayBuffer) => Promise<void>;
  get: (ref: string) => Promise<{ record: AttachmentRecord; bytes: ArrayBuffer } | null>;
  delete: (ref: string) => Promise<void>;
  listByExpiry: (before: number, limit: number) => Promise<AttachmentRecord[]>;
};

/** Namespaced prefix so a bucket can host other object families. */
export const ATTACHMENT_KEY_PREFIX = 'ted/attachments/v1/';

/**
 * Page ceiling for ONE cleanup sweep.
 *
 * R2 lists 1000 keys per page. A sweep is triggered by an upload and must stay
 * cheap, so it walks at most this many pages and stops — the remaining pages
 * are picked up by the next sweep instead of one unbounded scan. Resumable by
 * construction: the sweep always restarts at the prefix, and deletions are
 * idempotent.
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
  async listByExpiry(before, limit) {
    const expired: AttachmentRecord[] = [];
    let cursor: string | undefined;
    // F3: TWO properties the real R2 API forces and a naive listing gets wrong.
    // 1. `include: ['customMetadata']` — a listing WITHOUT it carries no
    //    metadata, so every record decodes to null and NOTHING is ever swept.
    // 2. `cursor`/`truncated` — the listing is paginated, so a single call only
    //    ever sees the first page. The sweep follows the cursor up to the page
    //    ceiling and leaves the rest to the next sweep.
    for (let page = 0; page < ATTACHMENT_CLEANUP_MAX_PAGES; page += 1) {
      const listed = await bucket.list({
        prefix: ATTACHMENT_KEY_PREFIX,
        include: ['customMetadata'],
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const object of listed.objects) {
        if (expired.length >= limit) return expired;
        const record = decodeRecord(object.customMetadata);
        if (!record) continue;
        if (record.expiresAt > before) continue;
        expired.push(record);
      }
      if (!listed.truncated || typeof listed.cursor !== 'string') return expired;
      cursor = listed.cursor;
    }
    return expired;
  },
});

/** In-memory adapter for tests: same semantics, no bucket. */
export const createMemoryAttachmentStorage = (): AttachmentStorage => {
  const records = new Map<string, AttachmentRecord>();
  const blobs = new Map<string, ArrayBuffer>();
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
    async listByExpiry(before, limit) {
      const expired: AttachmentRecord[] = [];
      for (const record of records.values()) {
        if (record.expiresAt > before) continue;
        expired.push(record);
        if (expired.length >= limit) break;
      }
      return expired;
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
