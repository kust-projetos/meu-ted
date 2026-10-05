/**
 * A13 — processing registry per attachment kind (the A14/A15 base).
 *
 * V1 registers an explicit `unsupported` processor for every allowed kind:
 * the bytes are ingested and referenced, but NOTHING pretends to have read
 * them. That is the fail-closed base A14 (audio) and A15 (image/PDF) extend —
 * a new kind implementation replaces its entry, and no other kind changes.
 *
 * A14 (R12) extended this vocabulary WITHOUT changing A13's semantics:
 *  - `mime` (server-sniffed, never client-declared) travels to the processor,
 *    which needs it to build a correct upload part without ever seeing the
 *    user's file name;
 *  - `transcript` (optional) carries provider output to the turn; when absent
 *    the outcome is byte-identical to the A13 shape `{state, detail, ref}`;
 *  - the STT-specific states are explicit typed outcomes, never a raw throw.
 *
 * Idempotency guard: processing is memoised per
 * `(workspace, actor, attachmentId, turnId)`, so re-entering the same attachment
 * in the same turn (retry, redelivery, reconciliation) never runs the processor
 * twice — and neither does a concurrent call, which joins the SAME in-flight
 * promise (F5). A different turn, or a different actor, is a different unit of
 * work and DOES reprocess. A memo hit re-validates the reference first, so an
 * attachment that expired mid-turn is never served from the cache (F2).
 *
 * The processor receives bytes (that is its job); the TURN only ever receives
 * the `{state, detail, ref}` projection below — bytes never leave this module.
 */

import { resolveAttachmentRef } from './ingest.js';
import type { AttachmentStorage } from './storage.js';
import type { AttachmentIdentity, AttachmentKind } from './types.js';

/**
 * Explicit processing outcome. Never `undefined`, never silently empty.
 *
 * A14 adds the STT-typed states: a provider failure is a NAMED state, so the
 * turn can say WHY it did not transcribe instead of collapsing every failure
 * into a generic `failed` (or, worse, into silence).
 */
export type AttachmentProcessingState =
  | 'processed'
  | 'unsupported'
  | 'failed'
  | 'unavailable'
  /** A14: the single-transcription budget for this turn was already spent. */
  | 'skipped_budget'
  /** A14: 401/403 from the STT provider (credential/authorization problem). */
  | 'stt_unauthorized'
  /** A14: 429 from the STT provider (throttled). */
  | 'stt_rate_limited'
  /** A14: any other provider 4xx/5xx or transport failure. */
  | 'stt_provider_error'
  /** A14: 2xx whose body is not a usable transcript. */
  | 'stt_bad_response'
  /** A15: the vision read exceeded its own deadline. */
  | 'vision_timeout'
  /** A15: 401/403 from the vision provider. */
  | 'vision_unauthorized'
  /** A15: 429 from the vision provider. */
  | 'vision_rate_limited'
  /** A15: any other vision provider 4xx/5xx or transport failure. */
  | 'vision_provider_error'
  /** A15: 2xx whose body is not a usable structured extraction. */
  | 'vision_bad_response'
  /** A15: PDF protected by a password (parser `PasswordException`). */
  | 'pdf_encrypted'
  /** A15: PDF corrupt or not a PDF at all (parser `InvalidPDFException`). */
  | 'pdf_invalid'
  /** A15: PDF with no text layer — a scanned/OCR document has no provider here. */
  | 'pdf_no_text_layer'
  /** A15: PDF above the per-document page ceiling; refused whole. */
  | 'pdf_too_many_pages'
  /** A15: the PDF parse exceeded its deadline; no partial text escapes. */
  | 'pdf_timeout';

export type AttachmentProcessingOutcome = {
  state: AttachmentProcessingState;
  detail: string;
  ref: string;
  /**
   * F9: the kind of the SERVER RECORD that was read — never the kind the
   * client declared. The declared `type` is a claim checked against this value;
   * provenance and the transcript carrier are derived from here, so a PDF can
   * never be labelled as an audio transcription.
   */
  kind?: AttachmentKind;
  /**
   * A14: provider transcription, when the turn produced one. It is DATA from
   * an external provider (never an instruction) and it is carried as a
   * separate field so it never pollutes `detail` (log/telemetry surface).
   */
  transcript?: string;
  /**
   * A15: provenance of the structured extraction (attachment ref, provider,
   * model, timestamp) when the vision provider produced one. It is metadata —
   * never bytes, never base64, never provider payload.
   */
  provenance?: {
    attachmentId: string;
    provider: string;
    model: string;
    retrievedAt: number;
  };
  /** A15: how many PDF pages were actually read (the page ceiling is 10). */
  pagesRead?: number;
};

export type AttachmentProcessorInput = {
  /** `mime` is the SERVER-SNIFFED media type, never the client-declared one. */
  record: { ref: string; kind: AttachmentKind; name: string; size: number; sha256: string; mime: string };
  bytes: ArrayBuffer;
  identity: AttachmentIdentity;
};

export type AttachmentProcessorResult = {
  state: Exclude<AttachmentProcessingState, 'unavailable'>;
  detail: string;
  /** A14/A15: transcription or extracted data, when the turn produced one. */
  transcript?: string;
  /** A15: provenance of the structured extraction, when there was one. */
  provenance?: AttachmentProcessingOutcome['provenance'];
  /** A15: PDF pages actually read. */
  pagesRead?: number;
};

export type AttachmentProcessor = (
  input: AttachmentProcessorInput,
) => Promise<AttachmentProcessorResult>;

/** Shared by the A13 registry and the A14 audio processor (one wording). */
export const UNSUPPORTED_DETAIL = 'Este tipo de anexo ainda não é processado pelo TED.';

const unsupportedProcessor: AttachmentProcessor = async () => ({
  state: 'unsupported',
  detail: UNSUPPORTED_DETAIL,
});

export type AttachmentProcessorRegistry = {
  /** Closed: only the V1 kinds ever resolve to a processor. */
  supports: (kind: AttachmentKind) => boolean;
  /** A registered-but-`unsupported` processor is not "ready" (A14/A15 flip it). */
  isReady: (kind: AttachmentKind) => boolean;
  run: (kind: AttachmentKind, input: AttachmentProcessorInput) => Promise<AttachmentProcessorResult>;
};

const V1_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'audio'];

/**
 * Builds the registry. `overrides` are the A14/A15 entry points; anything not
 * overridden stays explicitly `unsupported`.
 */
export const createAttachmentProcessorRegistry = (
  overrides: Partial<Record<AttachmentKind, AttachmentProcessor>> = {},
): AttachmentProcessorRegistry => {
  const entries = new Map<AttachmentKind, AttachmentProcessor>(
    V1_KINDS.map((kind) => [kind, overrides[kind] ?? unsupportedProcessor]),
  );
  return {
    supports: (kind) => entries.has(kind),
    isReady: (kind) => {
      const processor = entries.get(kind);
      return processor !== undefined && processor !== unsupportedProcessor;
    },
    run: async (kind, input) => {
      const processor = entries.get(kind);
      if (!processor) return { state: 'unsupported', detail: UNSUPPORTED_DETAIL };
      return processor(input);
    },
  };
};

/**
 * Per-instance memo of `(workspace, actor, turnId, ref)` → IN-FLIGHT PROMISE.
 *
 * It is an INSTANCE (not a module global) so each Durable Object — and each
 * test — owns its own guard state.
 *
 * F2: the key carries the FULL identity, not just `(turnId, ref)`. A Durable
 * Object is per-workspace but holds several actors, so a `(turnId, ref)`-only
 * key let one actor read another's memoized transcription. The identity parts
 * are joined with NUL so no field can be shifted across a boundary.
 *
 * F5: the stored value is the PROMISE, reserved before the first `await`, so
 * concurrent callers of the same unit of work share one provider call instead
 * of each opening its own budget and provider request.
 */
export type AttachmentProcessingMemo = Map<string, Promise<AttachmentProcessingOutcome>>;

export const createAttachmentProcessingMemo = (): AttachmentProcessingMemo => new Map();

/** Bounded so a long-lived DO cannot grow the memo without limit. */
export const PROCESSING_MEMO_LIMIT = 500;

/** NUL separator, written as an escape so the source stays pure text. */
const MEMO_FIELD_SEPARATOR = '\u0000';

const memoKey = (identity: AttachmentIdentity, ref: string, turnId: string): string =>
  [
    identity.workspaceId,
    identity.actorId,
    turnId,
    ref,
  ].join(MEMO_FIELD_SEPARATOR);

const memoSet = (
  memo: AttachmentProcessingMemo,
  key: string,
  pending: Promise<AttachmentProcessingOutcome>,
): void => {
  if (memo.size >= PROCESSING_MEMO_LIMIT) memo.clear();
  memo.set(key, pending);
};

export type ProcessAttachmentInput = {
  storage: AttachmentStorage;
  registry: AttachmentProcessorRegistry;
  identity: AttachmentIdentity;
  ref: string;
  turnId: string;
  /** Per-DO / per-test guard state. Required: the guard is never global. */
  memo: AttachmentProcessingMemo;
  /**
   * F9: the kind the CLIENT declared. It is a claim, checked against the server
   * record (`attachment_kind_mismatch` when it lies) — never a source of truth
   * for state, provenance or the transcript carrier.
   */
  expectedKind?: AttachmentKind;
  /** Injectable clock, so expiry is testable without waiting for the TTL. */
  now?: number;
};

/**
 * Resolves the reference through the mediated read (workspace + actor +
 * expiry + kind), then runs the kind processor at most once per
 * `(workspace, actor, attachmentId, turnId)`.
 *
 * F2: a memo HIT re-validates the reference first (possession + expiry + kind)
 * and only then returns the stored outcome, so an attachment that expired or
 * was swept between two reads of the same turn never serves stale content.
 */
export const processAttachmentOnce = async (
  input: ProcessAttachmentInput,
): Promise<AttachmentProcessingOutcome> => {
  const { storage, identity, ref, turnId, memo, expectedKind, now } = input;
  const key = memoKey(identity, ref, turnId);
  const inFlight = memo.get(key);

  if (inFlight) {
    // Revalidate BEFORE serving the memoized outcome. The ref is metadata, so
    // this is a cheap metadata read — never the bytes.
    try {
      await resolveAttachmentRef({
        storage,
        identity,
        ref,
        ...(expectedKind !== undefined ? { expectedKind } : {}),
        ...(now !== undefined ? { now } : {}),
      });
    } catch {
      return unavailableOutcome(ref);
    }
    return inFlight;
  }

  // F5: the promise is registered BEFORE the first `await`, so a concurrent
  // caller joining the same key gets THIS promise rather than starting a
  // second resolve + provider call.
  const pending = runOnce(input);
  memoSet(memo, key, pending);
  return pending;
};

const unavailableOutcome = (ref: string): AttachmentProcessingOutcome => ({
  state: 'unavailable',
  detail: 'Não foi possível ler o anexo enviado.',
  ref,
});

const runOnce = async (input: ProcessAttachmentInput): Promise<AttachmentProcessingOutcome> => {
  const { storage, registry, identity, ref, expectedKind, now } = input;

  let resolved: Awaited<ReturnType<typeof resolveAttachmentRef>>;
  try {
    resolved = await resolveAttachmentRef({
      storage,
      identity,
      ref,
      ...(expectedKind !== undefined ? { expectedKind } : {}),
      ...(now !== undefined ? { now } : {}),
    });
  } catch {
    // A reference that cannot be read is a real, explicit state. It is not
    // memoised as a success, so a later turn re-probes storage.
    return unavailableOutcome(ref);
  }

  let result: AttachmentProcessorResult;
  try {
    result = await registry.run(resolved.record.kind, {
      record: {
        ref: resolved.record.ref,
        kind: resolved.record.kind,
        name: resolved.record.name,
        size: resolved.record.size,
        sha256: resolved.record.sha256,
        mime: resolved.record.mime,
      },
      bytes: resolved.bytes,
      identity,
    });
  } catch {
    result = { state: 'failed', detail: 'Falha ao processar o anexo.' };
  }

  return {
    state: result.state,
    // The processor detail is sanitised text (never bytes, never a raw name).
    detail: String(result.detail ?? '').slice(0, 300),
    ref,
    // F9: the kind comes from the resolved SERVER RECORD.
    kind: resolved.record.kind,
    // A14: the transcript is bounded here too — a provider answer is data
    // entering the turn, not an unbounded blob.
    ...(typeof result.transcript === 'string' && result.transcript.length > 0
      ? { transcript: result.transcript }
      : {}),
    // A15: provenance is metadata only (no payload, no bytes). It is rebuilt
    // field by field so a processor cannot smuggle anything else through it.
    ...(result.provenance
      ? {
          provenance: {
            attachmentId: String(result.provenance.attachmentId ?? '').slice(0, 80),
            provider: String(result.provenance.provider ?? '').slice(0, 32),
            model: String(result.provenance.model ?? '').slice(0, 80),
            retrievedAt: Number.isFinite(result.provenance.retrievedAt)
              ? Number(result.provenance.retrievedAt)
              : 0,
          },
        }
      : {}),
    ...(typeof result.pagesRead === 'number' && Number.isFinite(result.pagesRead)
      ? { pagesRead: result.pagesRead }
      : {}),
  };
};
