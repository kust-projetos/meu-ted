/**
 * A13 / R11 — fail-closed binary ingestion + mediated reference reads.
 *
 * Everything here is hand-rolled on purpose: magic-byte sniffing, header
 * dimension reads and sha256 via WebCrypto. NO new dependency, no decoder, no
 * network, no script execution — the validator only ever reads a bounded
 * prefix of the bytes and then forgets them.
 *
 * Defence order for an upload (fail-closed at every step):
 *   1. kind in the closed allowlist (image|pdf|audio);
 *   2. non-empty body within the per-kind byte ceiling;
 *   3. REAL mime from magic bytes, cross-checked against the declared kind;
 *   4. header dimensions for images (PNG IHDR / JPEG SOF) under the pixel and
 *      side caps — a decompression bomb is rejected on the header, never on
 *      the decoded size;
 *   5. PDF header version limit;
 *   6. sha256 + deterministic ref (idempotent per workspace+actor+sha256).
 *
 * Reads are ALWAYS mediated: (workspace, actor, expiry, kind) are re-validated
 * on every `resolveAttachmentRef`, and a cross-tenant ref is indistinguishable
 * from a non-existent one.
 */

import type { AttachmentCleanupCheckpoint, AttachmentStorage } from './storage.js';
import type { AttachmentObservabilityInput } from './observability.js';
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_NAME_MAX_CHARS,
  ATTACHMENT_TTL_MS,
  attachmentError,
  isAttachmentKind,
  isAttachmentRef,
  type AttachmentIdentity,
  type AttachmentKind,
  type AttachmentRecord,
  type AttachmentUploadResult,
  type ResolvedAttachment,
} from './types.js';
import { scrubForPersistence } from '../privacy/dlp.js';

const decoder = new TextDecoder('latin1');

const startsWithAscii = (bytes: Uint8Array, ascii: string, offset = 0): boolean => {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
};

const u16be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const u32be = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) >>> 0) +
  ((bytes[offset + 1] ?? 0) << 16) +
  ((bytes[offset + 2] ?? 0) << 8) +
  (bytes[offset + 3] ?? 0);

/** Little-endian uint32 — the byte order of the RIFF/WAV header. */
const u32le = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    ((bytes[offset + 3] ?? 0) << 24)) >>> 0;

/**
 * Only the first bytes of a payload are ever decoded as text — enough for
 * container magic and the PDF header, never enough to be a content read.
 */
const HEADER_PROBE_BYTES = 64;

export type SniffedMedia = {
  /** Real mime detected from magic bytes. */
  mime: string;
  /**
   * `image` | `pdf` | `audio` are the V1 ingestible families;
   * `media-container` means "real media, but not a permitted V1 kind"
   * (MP4/MPEG video) — recognised so it can be rejected with a typed error
   * instead of silently accepted.
   */
  family: 'image' | 'pdf' | 'audio' | 'media-container';
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (bytes: Uint8Array): boolean =>
  PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

const isJpeg = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** EBML header + the `webm` DocType (what MediaRecorder emits). */
const isWebm = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 &&
  decoder.decode(bytes.subarray(0, HEADER_PROBE_BYTES)).includes('webm');

/** ISO base media container (`ftyp` at offset 4): MP4/M4A/MOV. */
const isIsobmff = (bytes: Uint8Array): boolean => startsWithAscii(bytes, 'ftyp', 4);

/** Matroska-family without the webm DocType: still real media, still not V1. */
const isMatroska = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

const isOgg = (bytes: Uint8Array): boolean => startsWithAscii(bytes, 'OggS');

const isWav = (bytes: Uint8Array): boolean =>
  startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'WAVE', 8);

const isFlac = (bytes: Uint8Array): boolean => startsWithAscii(bytes, 'fLaC');

const isId3 = (bytes: Uint8Array): boolean => startsWithAscii(bytes, 'ID3');

/** MPEG audio frame sync: 11 set bits (0xFF + 0b111xxxxx). */
const isMpegAudioFrame = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;

/** MPEG video pack/system start codes — real media, NOT a permitted V1 kind. */
const isMpegVideo = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && (bytes[3] === 0xba || bytes[3] === 0xb3);

/** `RIFF....AVI ` — real media container, rejected like MP4. */
const isAvi = (bytes: Uint8Array): boolean =>
  startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'AVI ', 8);

/**
 * Real media type from magic bytes. Returns `null` for anything that is not
 * one of the allowlisted containers — a shell script, an HTML page or random
 * bytes never becomes an attachment.
 */
export const sniffAttachmentMediaType = (bytes: Uint8Array): SniffedMedia | null => {
  if (bytes.length === 0) return null;
  if (isPng(bytes)) return { mime: 'image/png', family: 'image' };
  if (isJpeg(bytes)) return { mime: 'image/jpeg', family: 'image' };
  if (startsWithAscii(bytes, '%PDF-')) return { mime: 'application/pdf', family: 'pdf' };
  if (isWebm(bytes)) return { mime: 'audio/webm', family: 'audio' };
  if (isId3(bytes)) return { mime: 'audio/mpeg', family: 'audio' };
  if (isMpegAudioFrame(bytes)) return { mime: 'audio/mpeg', family: 'audio' };
  if (isOgg(bytes)) return { mime: 'audio/ogg', family: 'audio' };
  if (isWav(bytes)) return { mime: 'audio/wav', family: 'audio' };
  if (isFlac(bytes)) return { mime: 'audio/flac', family: 'audio' };
  // Recognised but not ingestible in V1 — rejected with a typed error later.
  if (isIsobmff(bytes)) return { mime: 'video/mp4', family: 'media-container' };
  if (isMpegVideo(bytes)) return { mime: 'video/mpeg', family: 'media-container' };
  if (isMatroska(bytes)) return { mime: 'video/x-matroska', family: 'media-container' };
  if (isAvi(bytes)) return { mime: 'video/x-msvideo', family: 'media-container' };
  return null;
};

/**
 * Image dimensions read from the container header WITHOUT decoding pixels:
 * PNG `IHDR` (offset 16/20) and JPEG `SOFn` (segment walk, first SOF wins).
 * Returns `null` when the header cannot be read — the caller then rejects
 * (an unreadable header is never treated as "small enough").
 */
export const readImageDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  if (isPng(bytes)) {
    // 8 (signature) + 4 (length) + 4 ("IHDR") = 16, then width/height.
    if (bytes.length < 24) return null;
    if (!startsWithAscii(bytes, 'IHDR', 12)) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (isJpeg(bytes)) {
    // Walk the marker segments: no segment payload is decoded, only lengths.
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      // Standalone markers (no length payload).
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = u16be(bytes, offset + 2);
      // SOF0..SOF15 excluding DHT (c4), JPG (c8) and DAC (cc).
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = u16be(bytes, offset + 5);
        const width = u16be(bytes, offset + 7);
        return { width, height };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  return null;
};

/**
 * F10 — exact duration of an UNCOMPRESSED WAV, from the RIFF header alone.
 *
 * `durationSeconds = dataSize / byteRate`, both read from the header: no audio
 * is decoded, no demuxer is needed, and no value is estimated. Returns `null`
 * when the header cannot be read — the caller then treats the duration as
 * UNKNOWN rather than as zero (an unknown duration is not a short one).
 */
export const readWavDurationSeconds = (bytes: Uint8Array): number | null => {
  if (bytes.length < 44) return null;
  if (!startsWithAscii(bytes, 'RIFF') || !startsWithAscii(bytes, 'WAVE', 8)) return null;
  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  // Chunk walk: RIFF is a sequence of `id (u32 size) payload` chunks, padded to
  // an even boundary. Bounded by the buffer length, never by the declared size.
  while (offset + 8 <= bytes.length) {
    const id = decoder.decode(bytes.subarray(offset, offset + 4));
    const size = u32le(bytes, offset + 4);
    if (id === 'fmt ' && offset + 16 <= bytes.length) {
      byteRate = u32le(bytes, offset + 16);
    } else if (id === 'data') {
      // Clamp to what the buffer actually holds: a header claiming more audio
      // than was uploaded must not inflate the duration past reality.
      dataSize = Math.min(size, bytes.length - offset - 8);
      break;
    }
    // A chunk with an implausible size cannot be walked any further.
    if (size > bytes.length) break;
    offset += 8 + size + (size % 2);
  }
  if (byteRate === null || dataSize === null || byteRate <= 0) return null;
  const duration = dataSize / byteRate;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
};

/** Content hash via WebCrypto (the Workers primitive already used elsewhere). */
export const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i]!.toString(16).padStart(2, '0');
  return out;
};

/** base64url without padding — the opaque-token alphabet. */
const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * F11 - domain separation for the ref signature.
 *
 * The tag is part of the SIGNED INPUT on every path, keyed or not: a digest
 * produced for another purpose over the same (workspace, actor, content) tuple
 * can therefore never be replayed as an attachment ref. The field separator is
 * NUL, which appears in neither a UUID nor an actor id, so no identity part can
 * be shifted across a boundary to forge another tenant's tuple.
 */
export const ATTACHMENT_REF_DOMAIN = 'ted-attachments-v1';

/** NUL separator, written as an escape so the source stays pure text (F12). */
const REF_FIELD_SEPARATOR = '\u0000';

/**
 * Deterministic, opaque reference.
 *
 * The ref is derived from an HMAC over (ATTACHMENT_REF_DOMAIN, workspace, actor,
 * sha256) keyed by the agent's own connection-token secret, so it is NOT
 * guessable by another tenant even though it is stable for a given (workspace,
 * actor, content) triple — which is exactly the upload idempotency contract
 * (same triple inside the TTL ⇒ same ref, no duplicated object).
 *
 * It carries no URL, no local path and no reversible content encoding.
 */
const deriveRef = async (
  identity: AttachmentIdentity,
  sha256: string,
  secret: string | undefined,
): Promise<string> => {
  const payload = `${ATTACHMENT_REF_DOMAIN}${REF_FIELD_SEPARATOR}${identity.workspaceId}${REF_FIELD_SEPARATOR}${identity.actorId}${REF_FIELD_SEPARATOR}${sha256}`;
  const message = new TextEncoder().encode(payload);
  // F11: the domain tag is inside `message` on BOTH paths, so the unkeyed
  // fallback is domain-separated too (it is a plain digest, not an HMAC).
  if (secret) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    return `att_${base64Url(mac)}`;
  }
  // No secret configured (tests / dev): still opaque, still deterministic.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
  return `att_${base64Url(digest)}`;
};

const MIME_FOR_KIND: Record<AttachmentKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg'],
  pdf: ['application/pdf'],
  audio: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mpeg'],
};

export type IngestInput = {
  storage: AttachmentStorage;
  identity: AttachmentIdentity;
  kind: AttachmentKind;
  name: string;
  bytes: ArrayBuffer;
  /** Optional HMAC secret for the opaque ref (agent connection-token secret). */
  refSecret?: string;
  /**
   * REV-F1-PRB-SINK [P3]: internal outcome observer — called exactly once per
   * successful ingest with `{ deduped: true }` when an unexpired record
   * already existed (nothing written) or `{ deduped: false }` after a fresh
   * write. Best-effort and never throwing (a throwing observer must not fail
   * the upload). The public `AttachmentUploadResult` contract is unchanged.
   */
  onIngestOutcome?: (outcome: { deduped: boolean }) => void;
  /**
   * A19 — durable position of the piggybacked TTL sweep. When present, the
   * cleanup resumes from the last persisted cursor instead of always restarting
   * at the prefix (which starved expired objects living behind more than
   * `ATTACHMENT_CLEANUP_MAX_PAGES` pages of live ones). Best-effort on both
   * ends: checkpoint failures never fail the upload.
   */
  cleanupCheckpoint?: AttachmentCleanupCheckpoint;
  /**
   * F1 PR-B — sink de observabilidade do DO (best-effort). Quando presente, o
   * sweep piggyback emite `cleanup.succeeded/failed` por ele; a emissão nunca
   * quebra o upload (o sink já é non-throwing e a chamada é blindada aqui).
   */
  observability?: { emit: (input: AttachmentObservabilityInput) => void };
  now?: number;
};

/**
 * Validates and stores an upload. Throws a typed `AttachmentError` on every
 * rejection; nothing is written to storage before validation passes.
 */
export const ingestAttachment = async (input: IngestInput): Promise<AttachmentUploadResult> => {
  const { storage, identity, kind, bytes } = input;
  if (!isAttachmentKind(kind)) {
    throw attachmentError('attachment_unsupported_kind', 'Tipo de anexo não suportado.', 400);
  }
  if (!identity.workspaceId || !identity.actorId) {
    throw attachmentError('attachment_bad_request', 'Identidade do anexo ausente.', 400);
  }
  const size = bytes.byteLength;
  if (size <= 0) {
    throw attachmentError('attachment_bad_request', 'Anexo vazio.', 400);
  }
  const maxBytes = ATTACHMENT_LIMITS[kind].maxBytes;
  if (size > maxBytes) {
    throw attachmentError('attachment_too_large', `Anexo excede o limite de ${kind}.`, 413);
  }

  const view = new Uint8Array(bytes);
  const sniffed = sniffAttachmentMediaType(view);
  if (!sniffed || sniffed.family !== kind) {
    throw attachmentError(
      'attachment_mime_mismatch',
      'O conteúdo do anexo não corresponde ao tipo declarado.',
      400,
    );
  }
  if (!MIME_FOR_KIND[kind].includes(sniffed.mime)) {
    throw attachmentError('attachment_mime_mismatch', 'Formato de anexo não suportado.', 400);
  }

  // F10 — duration ceiling. WAV is the only allowlisted container whose header
  // carries an exact duration (`dataSize / byteRate`), so it is enforced here,
  // BEFORE anything is written. For the compressed formats the duration is not
  // determinable without a demuxer; the residual is the reduced `maxBytes`
  // ceiling (see ATTACHMENT_LIMITS.audio and apps/agent/AGENTS.md).
  if (kind === 'audio') {
    const maxDurationSeconds = ATTACHMENT_LIMITS.audio.maxDurationSeconds;
    const wavDuration = sniffed.mime === 'audio/wav' ? readWavDurationSeconds(view) : null;
    if (wavDuration !== null && wavDuration > maxDurationSeconds) {
      throw attachmentError(
        'attachment_audio_too_long',
        `O áudio dura ${Math.ceil(wavDuration)}s e o limite é ${maxDurationSeconds}s.`,
        413,
      );
    }
  }

  let width: number | undefined;
  let height: number | undefined;
  if (kind === 'image') {
    const dimensions = readImageDimensions(view);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
      throw attachmentError('attachment_dimensions_exceeded', 'Cabeçalho de imagem ilegível.', 400);
    }
    const { maxPixels, maxDimension } = ATTACHMENT_LIMITS.image;
    if (
      dimensions.width > maxDimension ||
      dimensions.height > maxDimension ||
      dimensions.width * dimensions.height > maxPixels
    ) {
      throw attachmentError(
        'attachment_dimensions_exceeded',
        'Dimensões do anexo acima do limite permitido.',
        400,
      );
    }
    width = dimensions.width;
    height = dimensions.height;
  }

  if (kind === 'pdf') {
    const version = decoder.decode(view.subarray(0, 8));
    const match = /^%PDF-(\d+)\.(\d+)/.exec(version);
    const major = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(major) || major < 1 || major > ATTACHMENT_LIMITS.pdf.maxHeaderVersion) {
      throw attachmentError(
        'attachment_pdf_version_unsupported',
        'Versão de PDF não suportada.',
        400,
      );
    }
  }

  const sha256 = await sha256Hex(bytes);
  const now = input.now ?? Date.now();
  const ref = await deriveRef(identity, sha256, input.refSecret);

  // Idempotency: the same (workspace, actor, sha256) inside the TTL resolves to
  // the same ref and rewrites nothing — never a duplicated object.
  const existing = await storage.get(ref).catch(() => null);
  if (existing && existing.record.expiresAt > now) {
    const record = existing.record;
    notifyIngestOutcome(input.onIngestOutcome, true);
    return {
      ref: record.ref,
      kind: record.kind,
      name: record.name,
      size: record.size,
      expiresAt: record.expiresAt,
    };
  }

  // The display name is user input: scrubbed by the existing DLP funnel and
  // capped. It is never used as a storage key and never logged raw.
  const name = scrubForPersistence(typeof input.name === 'string' ? input.name : '')
    .slice(0, ATTACHMENT_NAME_MAX_CHARS);

  const record: AttachmentRecord = {
    ref,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    kind,
    name,
    size,
    sha256,
    createdAt: now,
    expiresAt: now + ATTACHMENT_TTL_MS,
    mime: sniffed.mime,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
  await storage.put(record, bytes);
  // Cheap TTL sweep piggybacked on the upload: best-effort and silent, so an
  // unreachable bucket never fails an otherwise valid upload.
  await cleanupExpiredAttachments(
    storage,
    now,
    input.cleanupCheckpoint || input.observability
      ? {
          ...(input.cleanupCheckpoint ? { checkpoint: input.cleanupCheckpoint } : {}),
          ...(input.observability ? { observability: input.observability } : {}),
        }
      : undefined,
  );
  // REV-F1-PRB-SINK [P3]: fresh write — the internal outcome signal for the
  // DO handler's sink label (`written` vs `dedup_hit`).
  notifyIngestOutcome(input.onIngestOutcome, false);
  return {
    ref: record.ref,
    kind: record.kind,
    name: record.name,
    size: record.size,
    expiresAt: record.expiresAt,
  };
};

/**
 * REV-F1-PRB-SINK [P3]: delivers the internal ingest outcome to the optional
 * observer. Best-effort by construction — a throwing observer never fails
 * the upload it observes.
 */
const notifyIngestOutcome = (
  observer: IngestInput['onIngestOutcome'],
  deduped: boolean,
): void => {
  try {
    observer?.({ deduped });
  } catch {
    // The upload result stands regardless of observer failure.
  }
};

export type ResolveInput = {
  storage: AttachmentStorage;
  identity: AttachmentIdentity;
  ref: string;
  expectedKind?: AttachmentKind;
  now?: number;
  /**
   * F1 PR-A fix (finding REV-PRC-GOLDEN P2) — zero-mutação global com o gate
   * negado. Quando `false`, um objeto expirado é REPORTADO (`attachment_expired`)
   * mas NÃO é deletado: o delete é uma mutação R2 e, com a capability desligada,
   * nenhum `bucket.delete` pode executar. O objeto expirado aguarda a capability
   * ligada ou um janitor dedicado. Default (omitido) preserva o comportamento
   * atual byte a byte (deleta best-effort); o caminho de chat passa aqui o
   * mesmo gate do upload (`isAttachmentUploadAllowed`).
   */
  allowDelete?: boolean;
};

/**
 * Mediated read. Possession is `(workspace, actor)`; a ref that exists under a
 * different tenant is reported exactly like a ref that does not exist
 * (`attachment_not_found`) — no existence oracle across workspaces.
 */
export const resolveAttachmentRef = async (input: ResolveInput): Promise<ResolvedAttachment> => {
  const { storage, identity, ref } = input;
  if (!isAttachmentRef(ref)) {
    throw attachmentError('attachment_bad_request', 'Referência de anexo inválida.', 400);
  }
  if (!identity.workspaceId || !identity.actorId) {
    throw attachmentError('attachment_bad_request', 'Identidade do anexo ausente.', 400);
  }
  const found = await storage.get(ref);
  if (!found || found.record.workspaceId !== identity.workspaceId || found.record.actorId !== identity.actorId) {
    throw attachmentError('attachment_not_found', 'Anexo não encontrado.', 404);
  }
  if (found.record.expiresAt <= (input.now ?? Date.now())) {
    // F1 PR-A fix: com o gate negado (`allowDelete === false`) o objeto
    // expirado NÃO é deletado — zero-mutação R2 com a capability desligada.
    // A resposta tipada é inalterada (`attachment_expired`).
    if (input.allowDelete !== false) {
      // Best-effort delete of an expired object; never throws to the caller.
      await storage.delete(ref).catch(() => undefined);
    }
    throw attachmentError('attachment_expired', 'Anexo expirado.', 404);
  }
  if (input.expectedKind && found.record.kind !== input.expectedKind) {
    throw attachmentError('attachment_kind_mismatch', 'Tipo do anexo incompatível.', 400);
  }
  return { record: found.record, bytes: found.bytes };
};

export type CleanupReport = { scanned: number; deleted: number; failed: boolean };

/** Bounded sweep so a caller can never turn cleanup into an unbounded scan. */
export const CLEANUP_BATCH_LIMIT = 50;

/**
 * Idempotent TTL sweep. Every storage failure is swallowed and reported as
 * `failed: true` — cleanup never breaks the upload/turn that triggered it.
 *
 * A19 — when `checkpoint` is present the sweep RESUMES from the last persisted
 * cursor instead of always restarting at the prefix: with more than
 * `ATTACHMENT_CLEANUP_MAX_PAGES` pages of live objects ahead of the expired
 * ones, a restart-at-prefix sweep never reached them (deterministic
 * starvation). The cursor of the last page consumed is persisted after the
 * deletes; reaching the END of the listing clears the checkpoint (wrap-around),
 * which is what keeps the whole space convergent. Checkpoint I/O is best-effort
 * on both ends: a failing checkpoint degrades to the legacy restart behavior
 * and never fails the caller.
 */
export const cleanupExpiredAttachments = async (
  storage: AttachmentStorage,
  now: number = Date.now(),
  options?: {
    checkpoint?: AttachmentCleanupCheckpoint;
    /**
     * F1 PR-B — sink de observabilidade do DO (best-effort): recebe
     * `cleanup.succeeded` (com `count` = deletados) ou `cleanup.failed`.
     * A emissão nunca quebra o sweep.
     */
    observability?: { emit: (input: AttachmentObservabilityInput) => void };
    /**
     * F1 PR-A fix (finding REV-PRC-GOLDEN P2) — zero-mutação global com o gate
     * negado. Quando `false`, o sweep é PULADO sem nenhum I/O no storage
     * (nem list, nem deletes) e sem evento no sink: nada executou, então nada
     * há a reportar. Os expirados aguardam a capability ligada ou um janitor
     * dedicado. Default (omitido) preserva o comportamento atual byte a byte;
     * o chamador passa aqui o mesmo gate do upload (`isAttachmentUploadAllowed`).
     * O piggyback do `ingestAttachment` herda o gate da rota de upload (que
     * nega antes do ingest), então segue intocado.
     */
    allowDelete?: boolean;
  },
): Promise<CleanupReport> => {
  if (options?.allowDelete === false) {
    return { scanned: 0, deleted: 0, failed: false };
  }
  const notify = (input: AttachmentObservabilityInput): void => {
    try {
      options?.observability?.emit(input);
    } catch {
      // O sweep nunca quebra por causa do sink.
    }
  };
  try {
    const checkpoint = options?.checkpoint;
    let startCursor: string | undefined;
    if (checkpoint) {
      try {
        startCursor = await checkpoint.get();
      } catch {
        startCursor = undefined;
      }
    }
    const sweep = await storage.sweepByExpiry(now, CLEANUP_BATCH_LIMIT, startCursor);
    let deleted = 0;
    for (const record of sweep.records) {
      try {
        await storage.delete(record.ref);
        deleted += 1;
      } catch {
        // Keep sweeping: one undeletable object must not hide the others.
      }
    }
    if (checkpoint) {
      try {
        if (deleted < sweep.records.length) {
          // A19 — a delete failed inside this window: HOLD the previous
          // position so the next sweep re-reads the same pages (deletes are
          // idempotent, so the retry is free). Advancing past a failure would
          // strand the object until a full wrap-around cycle — a wasted cycle
          // at best, a leak at worst. Residual: an object that fails to delete
          // PERSISTENTLY pins its window until the failure clears (an R2
          // delete outage is transient by nature; a poisoned object degrades
          // cleanup throughput, never correctness of the objects behind it
          // once the failure clears).
          notify({ event: 'cleanup.succeeded', capability: 'cleanup', success: true, count: deleted, storageResult: 'sweep_partial' });
        } else if (sweep.nextCursor === undefined) {
          // Wrap (end of listing) ⇒ the next sweep starts at the prefix again.
          await checkpoint.clear();
          notify({ event: 'cleanup.succeeded', capability: 'cleanup', success: true, count: deleted, storageResult: 'swept' });
        } else {
          // Persist the resume point so the tail is eventually reached.
          await checkpoint.put(sweep.nextCursor);
          notify({ event: 'cleanup.succeeded', capability: 'cleanup', success: true, count: deleted, storageResult: 'swept' });
        }
      } catch {
        // Losing the position costs one revisited cycle; it must never throw.
      }
    } else {
      // F1 PR-B — sem checkpoint o sweep continua legado, mas o evento de
      // observabilidade ainda é emitido (o sink não depende do cursor).
      notify({ event: 'cleanup.succeeded', capability: 'cleanup', success: true, count: deleted, storageResult: 'swept' });
    }
    return { scanned: sweep.records.length, deleted, failed: false };
  } catch {
    notify({ event: 'cleanup.failed', capability: 'cleanup', success: false, providerFailure: 'storage' });
    return { scanned: 0, deleted: 0, failed: true };
  }
};
