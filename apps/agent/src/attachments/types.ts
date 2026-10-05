/**
 * A13 / R11 — binary ingestion with identity (G05 resolved: private R2 via an
 * OPTIONAL `TED_ATTACHMENTS_BUCKET` binding).
 *
 * Contract decisions already taken (docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md §2):
 * the upload answer is an OPAQUE server-side reference — no public URL, no
 * base64 through the DLP, no local path — and reading bytes is ALWAYS mediated
 * by the Worker after validating (workspace, actor, expiry, kind).
 *
 * This module holds ONLY the vocabulary shared by the storage adapter, the
 * ingestion validator and the RPC surface: the allowlisted kinds, the
 * conservative per-kind ceilings, the TTL, and the typed error codes. Bytes
 * never appear in a type here except as the transient `bytes` the validator
 * reads and immediately forgets.
 */

export const ATTACHMENT_KINDS = ['image', 'pdf', 'audio'] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** V1 ceilings. Conservative on purpose; the value is the ingest-side bound. */
export const ATTACHMENT_LIMITS = {
  /** 10 MB. */
  image: { maxBytes: 10 * 1024 * 1024, maxPixels: 25_000_000, maxDimension: 8_192 },
  /** 15 MB. */
  pdf: { maxBytes: 15 * 1024 * 1024, maxHeaderVersion: 2 },
  /**
   * F10 — audio. `maxBytes` DROPPED from 20 MB to 10 MB (~10 min at 128 kbps).
   *
   * A byte ceiling is not a time ceiling: without a demuxer the duration of a
   * compressed container (ogg/webm/flac/mp3 carry a variable bitrate) cannot be
   * determined honestly. Rather than invent one, the byte bound is tightened so
   * the worst case at a typical voice bitrate stays near the intended ceiling,
   * and `maxDurationSeconds` is enforced EXACTLY for WAV, the one container
   * whose header carries `dataSize / byteRate`. Residual: for non-WAV formats
   * the duration is still not enforced — documented in apps/agent/AGENTS.md.
   */
  audio: { maxBytes: 10 * 1024 * 1024, maxDurationSeconds: 120 },
} as const;

/** Hard TTL: 24 h. Cleanup is idempotent and best-effort. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Opaque reference format. A ref is NEVER a path, a URL or a base64 blob. */
export const ATTACHMENT_REF_PATTERN = /^att_[A-Za-z0-9_-]{16,64}$/;

/** Sanity bounds on the display name (never used as a storage key). */
export const ATTACHMENT_NAME_MAX_CHARS = 200;

export type AttachmentErrorCode =
  | 'attachment_bad_request'
  | 'attachment_unsupported_kind'
  | 'attachment_too_large'
  | 'attachment_audio_too_long'
  | 'attachment_mime_mismatch'
  | 'attachment_dimensions_exceeded'
  | 'attachment_pdf_version_unsupported'
  | 'attachment_storage_unavailable'
  | 'attachment_not_found'
  | 'attachment_kind_mismatch'
  | 'attachment_expired';

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  readonly status: number;

  constructor(code: AttachmentErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    this.status = status;
  }
}

export const isAttachmentError = (value: unknown): value is AttachmentError =>
  value instanceof AttachmentError || (typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string' && typeof (value as { status?: unknown }).status === 'number' && value instanceof Error);

/** The single fail-closed error factory: every rejection carries a typed code. */
export const attachmentError = (
  code: AttachmentErrorCode,
  message: string,
  status: number,
): AttachmentError => new AttachmentError(code, message, status);

export const attachmentStatusFor = (code: AttachmentErrorCode): number => {
  switch (code) {
    case 'attachment_bad_request':
    case 'attachment_unsupported_kind':
    case 'attachment_mime_mismatch':
    case 'attachment_dimensions_exceeded':
    case 'attachment_pdf_version_unsupported':
    case 'attachment_kind_mismatch':
      return 400;
    case 'attachment_too_large':
      return 413;
    case 'attachment_audio_too_long':
      return 413;
    case 'attachment_storage_unavailable':
      return 503;
    case 'attachment_not_found':
    case 'attachment_expired':
      return 404;
  }
};

export const isAttachmentKind = (value: unknown): value is AttachmentKind =>
  typeof value === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(value);

export const isAttachmentRef = (value: unknown): value is string =>
  typeof value === 'string' && ATTACHMENT_REF_PATTERN.test(value);

/**
 * Server-side record. Carries metadata ONLY (no bytes, no URL) and the two
 * ownership keys every read re-validates. The storage adapter persists this as
 * object customMetadata, so it must stay JSON-serialisable and small.
 */
export type AttachmentRecord = {
  /** Opaque reference handed to the client; also the storage identity. */
  ref: string;
  workspaceId: string;
  actorId: string;
  kind: AttachmentKind;
  /** Already DLP-scrubbed display name. */
  name: string;
  size: number;
  /** sha256 hex of the content — dedup key and integrity anchor. */
  sha256: string;
  createdAt: number;
  expiresAt: number;
  /** Detected from magic bytes, never from a client-declared header. */
  mime: string;
  /** Image-only: header dimensions read without decoding (bomb defense). */
  width?: number;
  height?: number;
};

/** The upload answer. Exactly the five documented fields. */
export type AttachmentUploadResult = {
  ref: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  expiresAt: number;
};

/** A resolved read: metadata + the transient bytes the processor consumes. */
export type ResolvedAttachment = {
  record: AttachmentRecord;
  bytes: ArrayBuffer;
};

/** Attachment identity for every read/write (the multitenant boundary). */
export type AttachmentIdentity = {
  workspaceId: string;
  actorId: string;
};
