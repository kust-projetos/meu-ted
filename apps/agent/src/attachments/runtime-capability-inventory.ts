/**
 * A19 — RUNTIME capability inventory builder (issue #107 wiring).
 *
 * This is the runtime COMPOSER the pure model (`capability-state.ts`)
 * deliberately left out of scope: it derives each of the seven evidence
 * dimensions for the four A19 capabilities from the ACTUAL gate functions of
 * this build — no env VALUE, binding name, secret, workspace/actor id or free
 * text ever enters an entry (the projection in `buildCapabilityInventory`
 * stays the leak boundary), and nothing here writes, enables or mutates.
 *
 * What each dimension means AT RUNTIME, and why it is composed the way it is
 * (reviewer corrections applied — the rules below are load-bearing):
 *
 * - `codeImplemented` — `true` for all four: the capability code exists in
 *   this build (the upload RPC, the STT/vision processor paths and the
 *   preserved PDF parser are all compiled in). A missing implementation is a
 *   build-time fact, not a runtime observation, so the runtime never reports
 *   it.
 * - `configurationPresent` — OBSERVED, NEVER FABRICATED. The observable
 *   configuration surface of each capability: the R2 binding for upload
 *   (`getAttachmentStorage`), and the capability's flag variable being
 *   DECLARED in the env for stt/vision/pdf-text. Declaration is a KEY
 *   PRESENCE fact (`flagEnvName in env`) — no flag VALUE is parsed here, so
 *   this dimension cannot drift from the gates. A capability absent from the
 *   env is UNCONFIGURED (nothing names it), NOT a fabricated "configured
 *   off": only a declared-but-not-enabled flag reads CONFIGURED_DISABLED.
 * - `serverFlagEnabled` — THE FLAG, NEVER THE LOCK. Where the gate module
 *   exports the exact flag-only parser it is reused verbatim for ALL FOUR
 *   capabilities: `isUploadFlagEnabled` (strict `=== '1'`, no trim — the
 *   A19 §4.1 contract), `isPdfTextEnabled`/`isAudioSttFlagEnabled`/
 *   `isVisionFlagEnabled` (trim `=== '1'`; the vision one is SHARED by groq
 *   and gemini). The credential and the cohort are never read as the flag:
 *   flag variable ABSENT ⇒ `false` (the gates are default-off — a missing
 *   flag is a PROVEN off, not an unanswered question), `'0'` ⇒ `false` and
 *   `'1'` ⇒ `true` REGARDLESS of credential or cohort, and any other declared
 *   value ⇒ `false` (only `1` is ON). The availability lock
 *   (`isGroqSttAvailable`/`isGroqVisionAvailable`/`isGeminiVisionAvailable`) is
 *   NOT consulted here: whether the provider path is reachable is a different
 *   dimension, and conflating it with the flag is exactly how a cohort-less (or
 *   credential-less) rollout is misreported as "flag off".
 * - `providerAvailable` / `canaryEvidence` — THE SINK NEVER PROMOTES. A
 *   SECRET, BINDING OR FLAG PRESENCE NEVER MEANS A PROVIDER IS FUNCTIONING,
 *   and the durable observability sink carries NO build/deployment
 *   provenance: a `succeeded` row proves at most that SOME deployment once
 *   ingested for this (workspace, actor) — never that the CURRENT generation
 *   works, whether the row is fresh, FUTURE-dated (clock skew or a hostile
 *   write — never accepted as current) or a stale survivor of the 90-day TTL
 *   left by a PREVIOUS deployment. stt/vision have no provider-health signal
 *   at all. Until a sink (or another boundary) can prove the current
 *   generation's functioning, all four capabilities report the honest
 *   `'unknown'` for both dimensions — and `'unknown'` fails closed to a
 *   non-active state in the pure model (it can never derive ACTIVE).
 * - `operationalBlock` — `true` for pdf-text whenever
 *   `pdfTextProcessorOverride()` returns `undefined`, which it does
 *   UNCONDITIONALLY today (P1, bounded execution pending): the parse is
 *   refusable per-page, so extraction is blocked and the flag cannot
 *   re-enable it. For upload/stt/vision no operational block is recorded in
 *   the current code (their fail-closed gates are already covered by the
 *   flag/cohort/config dimensions), so the block is the explicit `false`.
 *
 * The PDF cohort is intentionally `'unknown'`: PDF is a local parse with no
 * rollout cohort, so no cohort decision exists — that is an unanswered
 * question, never a guessed `true`/`false`.
 */

import {
  isVisionCohortMember as isVisionCohortMemberValue,
  isVisionFlagEnabled,
} from '../multimodal/groq-vision.js';
import { isAudioSttCohortMember, isAudioSttFlagEnabled } from '../multimodal/groq-stt.js';
import { isPdfTextEnabled, pdfTextProcessorOverride } from '../multimodal/pdf-text.js';
import { getAttachmentStorage } from './storage.js';
import { isAttachmentUploadCohortMember, isUploadFlagEnabled } from './upload-gate.js';
import { type AttachmentObservabilitySql } from './observability.js';
import {
  buildCapabilityInventory,
  type CapabilityEvidence,
  type CapabilityInventoryEntry,
} from './capability-state.js';

/**
 * Flag variable NAMES. They are configuration KEYS, never values: presence
 * of the key is the observable "the deployment configuration names this
 * capability"; the VALUES stay owned by the gate parsers above and are never
 * read here. The names match the env each gate module already documents.
 */
const STT_FLAG_ENV = 'TED_AUDIO_STT_ENABLED';
const VISION_FLAG_ENV = 'TED_VISION_ENABLED';
const PDF_TEXT_FLAG_ENV = 'TED_PDF_TEXT_ENABLED';

/**
 * Key presence in the env. Total: a missing/!object env is "not declared",
 * never a throw and never a fabricated presence. `in` is a structural check
 * on the key only — no value is inspected, coerced or persisted.
 */
const configurationNamesCapability = (env: unknown, flagEnvName: string): boolean => {
  if (typeof env !== 'object' || env === null) return false;
  return flagEnvName in (env as Record<string, unknown>);
};

/**
 * `serverFlagEnabled` is the FLAG, read from the gate module's canonical
 * flag-only parser — never from the availability lock and never re-parsed here:
 *
 * - flag variable ABSENT ⇒ `false` — the gates are default-off, so a missing
 *   flag is a proven OFF, not an unanswered question;
 * - `'0'` (or any other declared value) ⇒ `false` — only `1` is ON;
 * - `'1'` ⇒ `true` REGARDLESS of credential or cohort. The provider
 *   availability lock (the triples behind `isGroqSttAvailable`/
 *   `isGroqVisionAvailable`/`isGeminiVisionAvailable`) is deliberately NOT read
 *   here: whether the provider path is reachable is a DIFFERENT dimension
 *   (`providerAvailable`), and reading the lock as the flag is exactly how a
 *   cohort-less (or key-less) rollout gets misreported as "flag off".
 *
 * `configurationPresent` stays an INDEPENDENT key-presence observation, so a
 * declared-but-off flag reads CONFIGURED_DISABLED, never UNCONFIGURED.
 */

export type RuntimeCapabilityInventoryInput = {
  /** The DO env (`this.env`) read by the existing gates — never an env value. */
  readonly env: unknown;
  /** Authenticated identity (gateway-verified headers at the call site). */
  readonly workspaceId: string;
  readonly actorId: string;
  /**
   * Injectable clock for tests; defaults to `Date.now()`. Accepted for
   * call-site compatibility and DELIBERATELY UNUSED: no dimension is derived
   * from the clock anymore (see the sink-provenance rule below).
   */
  readonly now?: number;
  /**
   * The current durable sink handle. Accepted for call-site compatibility
   * (the existing GET passes the same handle it reads the baseline from) and
   * DELIBERATELY UNUSED: the sink carries NO build/deployment provenance, so
   * NO sink content may promote `providerAvailable`/`canaryEvidence` — a
   * `succeeded` row (fresh, future-dated or a stale TTL survivor of a
   * previous deployment) proves at most that SOME deployment ingested for
   * this scope, never that the CURRENT generation works. Both dimensions
   * stay `'unknown'` until a sink can prove generation provenance.
   */
  readonly canarySql?: AttachmentObservabilitySql | null;
  /** Freshness window override for tests. UNUSED with `canarySql` (same rule). */
  readonly canaryWindowMs?: number;
};

const uploadEvidence = (
  env: unknown,
  workspaceId: string,
  actorId: string,
): CapabilityEvidence => ({
  codeImplemented: true,
  // The binding is the observable configuration surface of the upload path.
  configurationPresent: getAttachmentStorage(env) !== null,
  // The canonical strict flag parser — the flag, never the cohort/binding.
  serverFlagEnabled: isUploadFlagEnabled(env),
  // A binding presence is NOT a functioning proof, and the ingest sink has
  // no generation provenance: only a boundary that proves the CURRENT build
  // may say `true`, so this stays the honest `'unknown'`.
  providerAvailable: 'unknown',
  cohortAuthorized: isAttachmentUploadCohortMember(env, workspaceId, actorId),
  // The sink never promotes (no build/deployment provenance): a scoped
  // `succeeded` row — fresh, future-dated or a previous deployment's TTL
  // survivor — is never proof about the current generation.
  canaryEvidence: 'unknown',
  // No operational block is recorded against upload in the current code: its
  // fail-closed gate is already expressed by the dimensions above.
  operationalBlock: false,
});

const sttEvidence = (env: unknown, workspaceId: string, actorId: string): CapabilityEvidence => ({
  codeImplemented: true,
  // Declared flag variable — presence, never a parsed value.
  configurationPresent: configurationNamesCapability(env, STT_FLAG_ENV),
  // The canonical FLAG-ONLY parser: `'1'` ⇒ true, `'0'`/other/absent ⇒ false,
  // regardless of key or cohort. The triple lock is NOT read as the flag.
  serverFlagEnabled: isAudioSttFlagEnabled(env),
  // No provider-health sink exists: a present GROQ_API_KEY never proves the
  // service answers, so this stays the honest `'unknown'`.
  providerAvailable: 'unknown',
  cohortAuthorized: isAudioSttCohortMember(env, workspaceId, actorId),
  canaryEvidence: 'unknown',
  operationalBlock: false,
});

const visionEvidence = (env: unknown, workspaceId: string, actorId: string): CapabilityEvidence => ({
  codeImplemented: true,
  // Declared flag variable — presence, never a parsed value.
  configurationPresent: configurationNamesCapability(env, VISION_FLAG_ENV),
  // The canonical FLAG-ONLY parser, SHARED by the groq default and the gemini
  // opt-in: the flag is the same variable and the same parser for both.
  serverFlagEnabled: isVisionFlagEnabled(env),
  // No provider-health sink exists for either vision provider.
  providerAvailable: 'unknown',
  // Shared cohort parser (groq + gemini) — the closed A19-VISION gate.
  cohortAuthorized: isVisionCohortMemberValue(env, workspaceId, actorId),
  canaryEvidence: 'unknown',
  operationalBlock: false,
});

const pdfTextEvidence = (env: unknown): CapabilityEvidence => ({
  codeImplemented: true,
  // Declared flag variable — presence, never a parsed value.
  configurationPresent: configurationNamesCapability(env, PDF_TEXT_FLAG_ENV),
  // The canonical flag parser: the DECLARED config may say ON; the OBSERVED
  // runtime says blocked — that divergence is the honest report.
  serverFlagEnabled: isPdfTextEnabled(env as { TED_PDF_TEXT_ENABLED?: string } | undefined),
  // A local parser is not a functioning proof either: no signal is claimed.
  providerAvailable: 'unknown',
  // PDF has no rollout cohort (local parse, no egress, no double lock): an
  // unanswered question, never a guessed default.
  cohortAuthorized: 'unknown',
  canaryEvidence: 'unknown',
  // Wired to the ACTUAL override: it returns `undefined` unconditionally
  // today, so this is `true` — and a future bounded re-enable that returns a
  // processor would remove the block by construction.
  operationalBlock: pdfTextProcessorOverride(env as { TED_PDF_TEXT_ENABLED?: string } | undefined) === undefined,
});

/**
 * Builds the four-entry runtime inventory for the authenticated identity.
 *
 * Total: it always returns one entry per closed A19 capability (never throws
 * for missing env/sink — those are honest `'unknown'` dimensions, not
 * errors), and the closed-union enforcement in `buildCapabilityInventory`
 * still applies to every row. The sink handle (`canarySql`) is accepted for
 * the existing call-site contract and is intentionally not read: no sink
 * content can prove the current generation (see the module doc).
 */
export const buildRuntimeCapabilityInventory = (
  input: RuntimeCapabilityInventoryInput,
): readonly CapabilityInventoryEntry[] =>
  buildCapabilityInventory([
    {
      capability: 'attachments-upload',
      evidence: uploadEvidence(input.env, input.workspaceId, input.actorId),
    },
    { capability: 'stt', evidence: sttEvidence(input.env, input.workspaceId, input.actorId) },
    { capability: 'vision', evidence: visionEvidence(input.env, input.workspaceId, input.actorId) },
    { capability: 'pdf-text', evidence: pdfTextEvidence(input.env) },
  ]);
