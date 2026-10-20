/**
 * MutationDraft multi-turno (SPEC §7.8, §25.3.1, §25.3.2 — ADR-014).
 *
 * A MutationDraft preserves an INCOMPLETE financial intention across
 * clarification turns with ZERO financial authority: it is not a
 * PendingOperation, cannot execute, cannot generate attestation, and never
 * bypasses canonical validation (the API re-validates on propose).
 *
 * CAS SOUNDNESS RATIONALE: the Durable Object processes one input event at a
 * time (`FinanceChatAgent.messageConcurrency = "queue"` — single-event
 * serialization). The in-memory CAS below is a synchronous check-and-set, so
 * it cannot interleave inside one turn handler: exactly one concurrent
 * continuation wins `active → proposing`, losers observe the terminal state
 * and get deterministic `draft.already_consumed`. The SQL implementation
 * uses a single `UPDATE ... WHERE status = 'active'` statement (atomic at
 * the storage engine), so the same guarantee holds across DO restarts and
 * evictions. The CAS elects a single proposer; it does NOT make
 * draft + propose one transaction — the DO ↔ API boundary is closed by the
 * recoverable idempotent handoff (stable `proposalIdempotencyKey` + API
 * dedup), never by distributed atomicity.
 */

import type { MutationDraftChannelMessage, TedApprovalTool } from '@pi-finance/llm-contracts';
import { mutationReceiptSchema } from '@pi-finance/llm-contracts';
import { deriveIdempotencyKey } from '../tools/intention-ledger.js';
import type { FieldProvenance } from './semantic-interpretation.js';

export const DRAFT_ALREADY_CONSUMED = 'draft.already_consumed';

export type MutationDraftStatus =
  | 'active'
  | 'proposing'
  | 'consumed'
  | 'discarded'
  | 'expired'
  | 'replaced';

/**
 * A07/R07 — `draft_relation`: how one user message related to the draft it
 * was applied to. DERIVED IN THE ORCHESTRATOR (the intent router is
 * stateless and must stay so), recorded as draft metadata, never used as an
 * execution threshold.
 *
 * - `new_intent` — the message created the draft;
 * - `continuation` — the message contributed a missing field (fragment,
 *   entity name or date) to an existing draft;
 * - `correction` — the message corrected a stored financial field;
 * - `negation` — the message was a negation that did NOT become a correction;
 * - `cancel_ref` — the message cancelled/closed the draft.
 *
 * `confirmation_ref`, `goal_ref` and `historic_ref` are reserved members of
 * the vocabulary: they exist so the enumeration is stable, but NO turn
 * registers them until a real call site derives them (there is no textual
 * confirmation for mutations, no user-facing goal syntax and no historic
 * back-reference today). Inventing a write to populate a value would be a
 * fabricated derivation.
 */
export const DRAFT_RELATIONS = [
  'new_intent',
  'continuation',
  'correction',
  'confirmation_ref',
  'negation',
  'cancel_ref',
  'goal_ref',
  'historic_ref',
] as const;

export type DraftRelation = (typeof DRAFT_RELATIONS)[number];

/** Per-field origin snapshot (A06 `FieldProvenance`), carried by the draft. */
export type DraftFieldProvenance = Readonly<
  Partial<
    Record<
      'kind' | 'amountCents' | 'description' | 'date' | 'categoryQuery',
      FieldProvenance<unknown>
    >
  >
>;

/**
 * A07/R07 — bounds for the additive goal metadata. The lists are evidence of
 * WHICH messages touched the draft, not an unbounded transcript: a draft lives
 * at most 15 minutes, and a bounded list cannot grow into a log.
 */
export const MAX_DRAFT_ORIGIN_MESSAGES = 8;
export const MAX_DRAFT_RELATIONS = 16;

/** Appends a relation at most once, keeping the newest entries within the cap. */
export const appendDraftRelation = (
  relations: readonly DraftRelation[],
  relation: DraftRelation,
): readonly DraftRelation[] => {
  const next = relations.includes(relation) ? [...relations] : [...relations, relation];
  return next.length > MAX_DRAFT_RELATIONS ? next.slice(next.length - MAX_DRAFT_RELATIONS) : next;
};

/** Appends an origin message at most once, keeping the newest within the cap. */
export const appendOriginMessage = (
  origins: readonly string[],
  intentionId: string,
): readonly string[] => {
  if (!intentionId || origins.includes(intentionId)) return [...origins];
  const next = [...origins, intentionId];
  return next.length > MAX_DRAFT_ORIGIN_MESSAGES ? next.slice(next.length - MAX_DRAFT_ORIGIN_MESSAGES) : next;
};

/** Definitive propose outcome once the API answered authoritatively. */
export type DraftProposeOutcome = 'created' | 'existing' | 'rejected' | 'unknown';

export type DraftTool = TedApprovalTool | 'accounts.create';

export type MutationDraftResolvedArgs = Readonly<{
  kind: 'expense' | 'income' | 'account';
  amountCents: number;
  description: string;
  date: string;
  categoryQuery?: string;
  accountId?: string;
  categoryId?: string;
  /**
   * T3.4 (SPEC §16): display-only entity labels resolved from the
   * authoritative lists at propose time. Never executed, never authority —
   * the API re-validates the canonical IDs. Optional so pre-existing
   * in-flight drafts keep working (card degrades to IDs/legacy shape).
   *
   * accounts.create reuses `accountName` as the human account name, plus the
   * NEVER-inferred kind (`bank`|`cash`) and the signed opening balance
   * (zero/negative legitimate, ADR-018). `description` mirrors the account
   * name so draft listings stay human-readable on every path.
   */
  accountName?: string;
  accountKind?: 'bank' | 'cash';
  initialBalanceCents?: number;
  categoryName?: string;
}>;

export type MutationDraftRecord = Readonly<{
  draftId: string;
  workspaceId: string;
  actorId: string;
  deviceId: string | null;
  conversationId?: string;
  tool: DraftTool;
  resolvedArgs: MutationDraftResolvedArgs;
  missingFields: readonly string[];
  proposalIdempotencyKey: string;
  proposalId?: string;
  proposeOutcome?: DraftProposeOutcome;
  status: MutationDraftStatus;
  discardReason?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Last turn that touched the draft — same-turn resend dedups on this. */
  lastIntentionId: string;
  /** Last clarification question — resent verbatim on same-turn redelivery. */
  lastQuestion: string;
  /**
   * A07/R07: goal identity, DERIVED BY READING the draft identity
   * (`goalId === draftId`). It is deliberately NOT a second identity: it can
   * never diverge from `draftId` and it never participates in the propose
   * key, which keeps deriving from `draftId` alone (SPEC §7.7.1).
   */
  goalId: string;
  /**
   * A07/R07: monotonic revision, incremented by every store write (update,
   * CAS and expiry). Owned by the store, never by a caller patch, so a
   * concurrent write can be detected instead of silently overwritten.
   */
  revision: number;
  /** A07/R07: intentionIds that contributed to this draft (bounded). */
  originMessages: readonly string[];
  /** A07/R07: derived `draft_relation` history (bounded). */
  relations: readonly DraftRelation[];
  /**
   * A07/R07: per-field provenance snapshot of the utterance that created or
   * corrected this draft. Optional: a draft created without an interpretation
   * (or by a legacy DO before the column existed) carries none, and that must
   * never be an error.
   */
  fieldProvenance?: DraftFieldProvenance;
}>;

export type DraftContext = Readonly<{
  workspaceId: string;
  actorId: string;
  deviceId: string | null;
  conversationId?: string;
}>;

/**
 * A07/R07 — closed Pick, deliberately NOT extended with `draftId`,
 * `goalId`, `proposalIdempotencyKey` or `revision`:
 * - the first three are identity/derived identity and must survive every
 *   continuation untouched;
 * - `revision` is store-owned (incremented on each write) so a patch can never
 *   claim a revision the store did not produce.
 */
export type DraftRecordPatch = Partial<
  Pick<
    MutationDraftRecord,
    | 'resolvedArgs'
    | 'missingFields'
    | 'proposalId'
    | 'proposeOutcome'
    | 'status'
    | 'discardReason'
    | 'updatedAt'
    | 'lastIntentionId'
    | 'lastQuestion'
    | 'originMessages'
    | 'relations'
    | 'fieldProvenance'
  >
>;

/**
 * A07/R07 — optimistic guard for {@link MutationDraftStore.update}. A caller
 * that read `revision` before composing its write passes it here: when the
 * stored revision moved in between, the update does NOT write (returns
 * `undefined`) so a stale correction can never overwrite a fresher one.
 */
export type DraftUpdateOptions = Readonly<{ expectedRevision?: number }>;

export const DEFAULT_DRAFT_TTL_MS = 15 * 60_000;
export const DEFAULT_MAX_PROPOSE_ATTEMPTS = 2;

/**
 * PR137-SEC-FIX Fase 1 (A) — idempotent confirmation binding (SPEC §7.7
 * redelivery, issue #105). Records that THIS identity context already
 * confirmed+executed an operation under THIS intentionId, with the success
 * receipt to replay verbatim.
 *
 * Durability is load-bearing: the orchestrator is constructed PER TURN in
 * production (`orchestratorForChannel`), so instance memory would never
 * survive a redelivery. The marker lives in the same durable store as the
 * drafts (DO SQLite in prod, InMemory in tests) — never in orchestrator
 * instance state.
 *
 * Scope is the authenticated identity (workspace + actor + device), like
 * `sameContext` minus `conversationId` (a conversation is not an auth leg:
 * the listing the marker guards is device-bound). A marker NEVER crosses an
 * identity leg. Receipt validity is TTL 24h; an expired marker is a TOMBSTONE
 * (see `CONFIRMATION_TOMBSTONE_RETENTION_MS`): it no longer replays success
 * blindly, but the binding still blocks any divergent confirmation until
 * pruned well beyond the redelivery window.
 */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60_000;

/**
 * PR137-HARDEN (Bloco A): tombstone retention. An expired receipt stops
 * proving success, but the identity→operationId BINDING must keep blocking a
 * divergent confirmation (criterion 5): a redelivery that arrives after the
 * 24h receipt TTL must never confirm a LATER operation B. Rows are pruned
 * opportunistically ONLY when expired well beyond any plausible redelivery
 * window (30 days) — never at TTL expiry — so the table stays bounded
 * without ever reopening the A→B substitution it exists to close.
 */
export const CONFIRMATION_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Review fix P1-3 (policy a) + P1-4 (temporal admissibility): the
 * identity→operationId BINDING is never deleted — retention hygiene only
 * strips the bulky `receipt_json` cell (the binding row itself is the proof
 * that blocks a divergent confirmation, and it is minimal: one row per
 * confirmation intention, bounded by business volume, never by redelivery
 * traffic). A pruned-then-redelivered intention still finds its binding and
 * reconciles against the ORIGINAL operation; it can never resolve-and-confirm
 * a LATER operation B.
 *
 * Review fix P1-4 (round 3, narrowed): an intention may only confirm an
 * operation that already existed when the intention was FIRST seen. The
 * durable first-sighting row (`noteConfirmationSighted` `createdAt`) IS the
 * message-instant anchor: `TurnInput` carries no trusted edge timestamp
 * (investigated — `normalize` builds the turn from body + server-side
 * options only, `finance-chat-agent` stamps nothing, and a client-supplied
 * timestamp would be untrusted input), and `Date.now()` at turn start is
 * NOT redelivery-stable (a redelivery would re-stamp T2 and admit anything
 * born before T2). The sighting row, written once and reused via the
 * `fresh: false` replay path, preserves the original T0 across redeliveries
 * and restarts. An operation created AFTER the anchor (beyond clock-skew
 * tolerance) is rejected fail-closed: a fresh turn/intention is required to
 * confirm it. The 5 s tolerance covers agent↔API clock skew ONLY — a
 * legitimately confirmable operation is proposed turns earlier, never newer
 * than the utterance that confirms it. Documented residual: an operation
 * born within ≤5 s after the message instant is indistinguishable from
 * skew and admitted (deliberate trade-off: false rejection of a legitimate
 * confirm is the worse failure here, and proposals always pre-exist).
 */
export const CONFIRMATION_OPERATION_SKEW_MS = 5_000;

/** Empty `operation_id` standing for "seen, no target bound yet" (P1-2/P1-4 sentinel). */
export const CONFIRMATION_UNBOUND_OPERATION_ID = '';

/**
 * Review round 4 P1-A3 — presentation binding. Time alone cannot prove
 * identity (an operation born inside the clock-skew window, or with a
 * backdated/forged `createdAt` from a negatively-skewed API clock, passes
 * the temporal check). The target must additionally belong to the SET that
 * was PRESENTED to this identity at or before the intention's anchor
 * (`presentationTime <= tEntry`): an operation never shown (no proposal
 * card, no disambiguation listing) is rejected even inside the skew.
 *
 * Recorded at every point the agent shows operations to the user (proposal
 * turns, confirmation/cancel disambiguations, confirmation listings — the
 * latter self-heals in-flight operations proposed before this hardening:
 * the first post-deploy "sim" presents fail-closed, the next confirms).
 * First presentation wins (earliest instant preserved); rows are minimal
 * (one per identity+operation) and pruned past the tombstone horizon.
 */
export const CONFIRMATION_PRESENTATION_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type ConfirmationPresentation = Readonly<{
  workspaceId: string;
  actorId: string;
  deviceId: string | null;
  operationId: string;
  presentedAt: string;
  expiresAt: string;
}>;

export type NoteConfirmationPresentationInput = Readonly<{
  ctx: DraftContext;
  operationIds: readonly string[];
  nowMs: number;
}>;

/**
 * PR137-HARDEN (Bloco A): durability states of the identity→operationId
 * binding. Minimal set, deliberately not over-engineered:
 * - `reserved` — claimed BEFORE any remote confirm/execute (crash window);
 *   proves nothing about money, only who may drive this intention;
 * - `succeeded` — the bound operation confirmed+executed (receipt or not);
 * - `inconclusive` — terminal without proof of success (transport failure,
 *   conflict, unreadable reconcile). Blocks B forever for this intention,
 *   claims nothing.
 */
export type ConfirmationStatus = 'reserved' | 'succeeded' | 'inconclusive';

export type ConfirmationRecord = Readonly<{
  workspaceId: string;
  actorId: string;
  deviceId: string | null;
  intentionId: string;
  operationId: string;
  /** JSON-serialized success receipt (`null` for reservations and receipt-less successes). */
  receiptJson: string | null;
  createdAt: string;
  expiresAt: string;
  status: ConfirmationStatus;
}>;

export type RememberConfirmationInput = Readonly<{
  ctx: DraftContext;
  intentionId: string;
  operationId: string;
  receiptJson: string | null;
  nowMs: number;
  ttlMs?: number;
}>;

/**
 * PR137-HARDEN (Bloco A): reserve-before-execute claim. The orchestrator
 * claims the binding BEFORE any remote confirm/execute with `status:
 * 'reserved'`; `rememberConfirmation` keeps the post-success path with
 * `status: 'succeeded'`. Both are the same immutable CAS: first durable
 * writer wins, divergent rewrites are rejected, never applied.
 */
export type ClaimConfirmationInput = RememberConfirmationInput &
  Readonly<{ status: ConfirmationStatus }>;

export type ClaimOutcome = 'claimed' | 'identical' | 'divergent';

/**
 * Review fix P1-2/P1-4: durable first-sighting of a confirmation intention.
 * `record` is the sighting row (or the pre-existing binding when this
 * intention was seen before); `fresh` is true only when THIS call created
 * it. An unbound sighting (`operationId === ''`) is a SENTINEL: a redelivery
 * that finds one must reproduce inconclusive, never resolve-and-confirm a
 * later operation. `record.createdAt` is the first-seen instant used by the
 * temporal-admissibility check (P1-4).
 */
export type ConfirmationSighting = Readonly<{
  record: ConfirmationRecord;
  fresh: boolean;
}>;

export type SettleConfirmationInput = Readonly<{
  ctx: DraftContext;
  intentionId: string;
  operationId: string;
  status: Extract<ConfirmationStatus, 'succeeded' | 'inconclusive'>;
  receiptJson: string | null;
  nowMs: number;
}>;

/**
 * PR137-HARDEN (Bloco A): receipt validation for a replay (criterion 6),
 * hardened by review (P2-6): the receipt MUST satisfy the canonical
 * `mutationReceiptSchema` (SPEC §15.1 — the same schema the executor enforces
 * at write time in `receiptFromExecution`, including the approval-tool
 * identity rule that pins the origin `operationId`).
 * - `absent` — no receipt cell. The BINDING stays the authority for
 *   blocking B; replay without receipt is allowed only for an unexpired
 *   `succeeded` marker (written strictly post-success). Expired markers
 *   always reconcile first.
 * - `valid` — schema-valid AND `operationId` equals the bound one. An absent
 *   `status` is NO LONGER accepted: pre-hardening doubles/rows without a
 *   status field are legacy shapes, not proof — they reconcile, never replay
 *   success verbatim.
 * - `invalid` — `corrupt` (unparseable/non-object), `divergent`
 *   (`operationId` missing or different from the bound one), or `incomplete`
 *   (parseable object that fails the canonical schema: missing/invalid
 *   mutationId, mutationKind, status, affectedTargets, or entity linkage).
 *   Never a false success: the caller must reconcile via the API listing,
 *   and answer inconclusive when reconciliation is impossible.
 *
 * Entity linkage (`entity.type/id`) is enforced at WRITE time by the
 * executor; the replay re-validates shape + bound operationId + succeeded
 * status, which is all the binding row can prove on its own.
 */
export type ValidatedReceipt =
  | Readonly<{ kind: 'valid'; receipt: Record<string, unknown> }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'invalid'; reason: 'corrupt' | 'divergent' | 'incomplete' }>;

export const validateConfirmationReceipt = (
  receiptJson: string | null,
  operationId: string,
): ValidatedReceipt => {
  if (receiptJson === null) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptJson);
  } catch {
    return { kind: 'invalid', reason: 'corrupt' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'corrupt' };
  }
  const receipt = parsed as Record<string, unknown>;
  if (receipt.operationId !== operationId) return { kind: 'invalid', reason: 'divergent' };
  if (!mutationReceiptSchema.safeParse(parsed).success) {
    return { kind: 'invalid', reason: 'incomplete' };
  }
  return { kind: 'valid', receipt };
};

export const buildConfirmationRecord = (input: RememberConfirmationInput): ConfirmationRecord => {
  const now = input.nowMs;
  const stamp = new Date(now).toISOString();
  return Object.freeze({
    workspaceId: input.ctx.workspaceId,
    actorId: input.ctx.actorId,
    deviceId: input.ctx.deviceId,
    intentionId: input.intentionId,
    operationId: input.operationId,
    receiptJson: input.receiptJson,
    createdAt: stamp,
    expiresAt: new Date(now + (input.ttlMs ?? CONFIRMATION_TTL_MS)).toISOString(),
    status: 'succeeded' as ConfirmationStatus,
  });
};

export const buildClaimRecord = (input: ClaimConfirmationInput): ConfirmationRecord => {
  const now = input.nowMs;
  const stamp = new Date(now).toISOString();
  return Object.freeze({
    workspaceId: input.ctx.workspaceId,
    actorId: input.ctx.actorId,
    deviceId: input.ctx.deviceId,
    intentionId: input.intentionId,
    operationId: input.operationId,
    receiptJson: input.receiptJson,
    createdAt: stamp,
    expiresAt: new Date(now + (input.ttlMs ?? CONFIRMATION_TTL_MS)).toISOString(),
    status: input.status,
  });
};

export const isConfirmationExpired = (record: ConfirmationRecord, nowMs: number): boolean =>
  Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) <= nowMs;

const sameContext = (draft: MutationDraftRecord, ctx: DraftContext): boolean =>
  draft.workspaceId === ctx.workspaceId &&
  draft.actorId === ctx.actorId &&
  (draft.deviceId ?? null) === (ctx.deviceId ?? null) &&
  (draft.conversationId ?? undefined) === (ctx.conversationId ?? undefined);

/** Stable draft identity: same turn redelivered → same draft, never a duplicate. */
export const deriveDraftId = (workspaceId: string, intentionId: string): string =>
  deriveIdempotencyKey(workspaceId, intentionId, 'mutation-draft');

/** Stable propose key: reused on EVERY re-emission (retry, restart, recovery). */
export const deriveProposalKey = (workspaceId: string, draftId: string, tool: DraftTool): string =>
  deriveIdempotencyKey(workspaceId, draftId, tool);

export const isExpired = (draft: MutationDraftRecord, nowMs: number): boolean =>
  Number.isFinite(Date.parse(draft.expiresAt)) && Date.parse(draft.expiresAt) <= nowMs;

export const buildDraftRecord = (input: {
  workspaceId: string;
  actorId: string;
  deviceId: string | null;
  conversationId?: string;
  intentionId: string;
  tool: DraftTool;
  resolvedArgs: MutationDraftResolvedArgs;
  missingFields: readonly string[];
  question: string;
  ttlMs?: number;
  nowMs?: number;
  /** A07/R07: provenance snapshot of the utterance that created the draft. */
  fieldProvenance?: DraftFieldProvenance;
}): MutationDraftRecord => {
  const now = input.nowMs ?? Date.now();
  const draftId = deriveDraftId(input.workspaceId, input.intentionId);
  const stamp = new Date(now).toISOString();
  return Object.freeze({
    draftId,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    deviceId: input.deviceId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    tool: input.tool,
    resolvedArgs: Object.freeze({ ...input.resolvedArgs }),
    missingFields: Object.freeze([...input.missingFields]),
    proposalIdempotencyKey: deriveProposalKey(input.workspaceId, draftId, input.tool),
    status: 'active' as const,
    createdAt: stamp,
    updatedAt: stamp,
    expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_DRAFT_TTL_MS)).toISOString(),
    lastIntentionId: input.intentionId,
    lastQuestion: input.question,
    // A07/R07: the goal IS the draft, read from the same derivation. No
    // second identity, no change to `draftId`/`proposalIdempotencyKey`.
    goalId: draftId,
    revision: 0,
    originMessages: Object.freeze([input.intentionId]),
    relations: Object.freeze<DraftRelation[]>(['new_intent']),
    ...(input.fieldProvenance ? { fieldProvenance: Object.freeze({ ...input.fieldProvenance }) } : {}),
  });
};

/**
 * Channel-facing clarification payload (ADR-014): identity-free, no
 * authority/attestation, no executable args — only what is missing and the
 * objective question.
 */
export const toChannelMessage = (
  draft: MutationDraftRecord,
  question?: string,
): MutationDraftChannelMessage =>
  Object.freeze({
    draftId: draft.draftId,
    // `accounts.create` is an agent-local draft tool until the shared
    // channel contract (`tedApprovalToolSchema`) admits it: the string rides
    // through unchanged so the PWA can route it, never remapped to another
    // tool. Follow-up: admit `accounts.create` in `@pi-finance/llm-contracts`
    // (packages/ — owned outside this scope).
    tool: draft.tool as TedApprovalTool,
    missingFields: [...draft.missingFields],
    question: question ?? draft.lastQuestion,
    expiresAt: draft.expiresAt,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A07/RR (review fix 1b) — a patch that touches the RESOLVED PAYLOAD
 * (`resolvedArgs`/`missingFields`) is only ever applied to an `active` draft.
 *
 * `proposing` carries the frozen payload the propose was armed with, and
 * `consumed`/`discarded`/`expired`/`replaced` are terminal: patching them
 * would rewrite history a later turn already observed. Such a write is
 * REFUSED without touching the row (`undefined`), never applied to the
 * closest state. The propose transition itself keeps its own path — `cas`
 * writes `proposing` and is deliberately not this guard's business.
 *
 * Terminal bookkeeping (status, question, provenance, discard reason) stays
 * allowed on every state: only the financial payload is protected.
 */
export const patchTouchesResolution = (patch: DraftRecordPatch): boolean =>
  patch.resolvedArgs !== undefined || patch.missingFields !== undefined;

/**
 * Agent-side canonical gate before propose (SPEC §7.4): registry semantics
 * checked locally, the API re-validates authoritatively. Never throws —
 * false means "clarify, never propose".
 */
export const validateCompleteArgs = (args: MutationDraftResolvedArgs): boolean => {
  // accounts.create gate (contrato fixado accounts-draft-agent): the human
  // name, an EXPLICIT kind (`bank`|`cash` — never defaulted, never inferred
  // from the name) and a signed integer opening balance (zero/negative OK).
  // Canonical IDs (`accountId`/`categoryId`) belong to transactions and are
  // not required here.
  if (args.kind === 'account') {
    if (typeof args.accountName !== 'string' || !args.accountName.trim()) return false;
    if (args.accountKind !== 'bank' && args.accountKind !== 'cash') return false;
    if (!Number.isInteger(args.initialBalanceCents)) return false;
    return true;
  }
  if (args.kind !== 'expense' && args.kind !== 'income') return false;
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) return false;
  if (!args.description || !args.description.trim()) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) return false;
  if (!args.accountId || !UUID.test(args.accountId)) return false;
  if (!args.categoryId || !UUID.test(args.categoryId)) return false;
  return true;
};

/**
 * Classifies propose failures: 4xx validation/business rejections are
 * DEFINITIVE (no operation was created → discard); transport errors,
 * timeouts, 5xx, 408/425/429 are UNKNOWN (operation may exist → stay
 * `proposing`, inconclusive reply, retry with the same key).
 */
export const isDefinitiveProposeError = (error: unknown): boolean => {
  const status =
    (error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
};

/**
 * "desfaz" cancela (decisão do operador): mesmo stem set do undo
 * (`desfaz|desfazer|desfaç`, sem o "z" das formas com ç) comporta-se como
 * "cancela" aqui. Sem guarda de "não" — igual a "cancela": a proteção contra
 * texto não-ditado vive no roteamento (decisionText), não neste matcher.
 * O vocabulário de cancel do forget two-step é propositalmente outro
 * (ambiguidade com undo) e NÃO muda aqui.
 */
const CANCEL_RE = /\b(cancela|cancelar|desist|desfaz|desfazer|desfaç)/i;
const RESET_RE = /esquece|deixa (pra l[aá]|quieto|isso)|na verdade|come[cç]a|recome[cç]a|nova inten/i;

export const isCancelText = (text: string): boolean => CANCEL_RE.test(text);
export const isResetText = (text: string): boolean => RESET_RE.test(text);

export interface MutationDraftStore {
  getOrCreate(record: MutationDraftRecord): { record: MutationDraftRecord; created: boolean };
  get(draftId: string): MutationDraftRecord | undefined;
  listActive(ctx: DraftContext, nowMs: number): MutationDraftRecord[];
  listProposing(ctx: DraftContext, nowMs: number): MutationDraftRecord[];
  findByIntention(ctx: DraftContext, intentionId: string): MutationDraftRecord | undefined;
  /** Atomic `from → to`; losers get `{ ok: false, current }` (deterministic). */
  cas(
    draftId: string,
    from: 'active',
    to: 'proposing',
    patch?: DraftRecordPatch,
  ): { ok: true; record: MutationDraftRecord } | { ok: false; current: MutationDraftRecord | undefined };
  /**
   * Patch write. Returns `undefined` when the draft is gone or when
   * `options.expectedRevision` no longer matches the stored revision (A07/R07
   * anti-corruption guard — no write at all in that case).
   */
  update(
    draftId: string,
    patch: DraftRecordPatch,
    options?: DraftUpdateOptions,
  ): MutationDraftRecord | undefined;
  /** Marks stale `active` drafts `expired`; returns how many were closed. */
  expireStale(ctx: DraftContext, nowMs: number): number;
  /**
   * PR137-HARDEN (Bloco A) — idempotent confirmation binding. Optional so
   * pre-existing store doubles keep compiling; the orchestrator treats an
   * absent method like an absent store: the financial confirmation path is
   * FAIL-CLOSED (inconclusive), never falls back to the live listing.
   *
   * IMMUTABLE contract: first durable writer wins. Re-claiming the SAME
   * operationId is idempotent (`identical`); claiming a DIFFERENT
   * operationId for the same identity+intentionId is rejected
   * (`divergent`) — never overwritten (the pre-hardening
   * `ON CONFLICT DO UPDATE` that silently rebound A→B is removed).
   */
  rememberConfirmation?(input: RememberConfirmationInput): ClaimOutcome | void;
  /**
   * PR137-HARDEN (Bloco A) — reserve-before-execute CAS. Called BEFORE any
   * remote confirm/execute with `status: 'reserved'`. Same immutable
   * contract as `rememberConfirmation`. Only the `claimed` caller may
   * drive the execution; `identical`/`divergent` callers must answer
   * inconclusive without touching the transport.
   */
  claimConfirmation?(input: ClaimConfirmationInput): ClaimOutcome | void;
  /**
   * PR137-HARDEN (Bloco A) — settles a `reserved` binding to its terminal
   * state (`succeeded` with the receipt, or `inconclusive`). CAS on
   * `status = 'reserved'`: `succeeded`/`inconclusive` rows are immutable
   * and never transition again. Returns true when this call settled.
   */
  settleConfirmation?(input: SettleConfirmationInput): boolean | void;
  findConfirmation?(ctx: DraftContext, intentionId: string, nowMs: number): ConfirmationRecord | undefined;
  /**
   * Review fix P1-2/P1-4 — durable first-sighting, written BEFORE the live
   * listing is ever resolved for a new intention. INSERT-with-adoption: the
   * first call creates an unbound sentinel row (`operationId === ''`); a
   * later `claimConfirmation` for the resolved target ADOPTS the sentinel
   * (CAS on `operationId === ''`) instead of conflicting with it, so the
   * sighting never blocks the legitimate first-attempt claim. Optional like
   * the other binding methods; the orchestrator treats an absent method like
   * an absent store (fail-closed).
   *
   * RESIDUAL (documented, P1-4 round 3; CLOSED round 4 P1-B): when THIS write
   * itself throws, the orchestrator best-efforts an independent claim-path
   * sentinel for the same intention (same instant, unbound `operationId ===
   * ''`), so a selective sighting-write outage still leaves a T0-anchored
   * marker and the post-recovery redelivery replays inconclusive. A TOTAL
   * outage (every binding-write path down for the whole turn) is closed by
   * the API frontier instead (direction iii): the entry bind persists
   * X@T_api BEFORE any local write, and the redelivery fails closed via the
   * pre-existing-API-sighting rule — see the confirmation branch.
   */
  noteConfirmationSighted?(ctx: DraftContext, intentionId: string, nowMs: number): ConfirmationSighting;
  /**
   * Review round 4 P1-A3 — presentation binding (see
   * `CONFIRMATION_PRESENTATION_RETENTION_MS`). Records that THESE operation
   * ids were presented to this identity at `nowMs` (proposal card,
   * disambiguation, authoritative listing). First presentation wins: a
   * repeat call for an already-presented operation keeps the earliest
   * instant. Optional like the other binding methods; the orchestrator
   * treats an absent method like an absent store (fail-closed on the
   * financial confirmation path). Best-effort hygiene prunes rows past the
   * retention horizon; a prune failure never breaks the write.
   */
  noteConfirmationPresentation?(input: NoteConfirmationPresentationInput): void;
  /** Reads back one presentation record for this identity, if any. */
  findConfirmationPresentation?(ctx: DraftContext, operationId: string): ConfirmationPresentation | undefined;
  /**
   * PR137-HARDEN round 5 — entry snapshot of the present-set. Lists the
   * operation ids ever presented to this identity, read SYNCHRONOUSLY at
   * turn entry (before the first await) and frozen for the turn. Admission
   * requires target ∈ snapshot (membership): an operation presented DURING
   * this turn's awaits — even in the same millisecond — is absent from the
   * snapshot and rejected, whatever its timestamp. Optional like the other
   * binding methods; absent ⇒ the confirmation path fails closed.
   */
  listConfirmationPresentations?(ctx: DraftContext): readonly string[];
  /**
   * R6 (PR137-FIX): best-effort compensation for presentations THIS turn
   * wrote but never published (the card never reached the user, so the
   * testimony must not authorize a later confirmation). Deletes ONLY the
   * listed operation ids for this identity — pre-existing rows (an earlier
   * turn whose card WAS published) are never touched by the orchestrator's
   * ledgered revert. Optional like the other binding methods; absent ⇒ the
   * orchestrator's revert is a no-op. Never throws past the caller.
   */
  forgetConfirmationPresentations?(ctx: DraftContext, operationIds: readonly string[]): void;
}

export class InMemoryMutationDraftStore implements MutationDraftStore {
  private readonly drafts = new Map<string, MutationDraftRecord>();
  private readonly byIntention = new Map<string, string>();
  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly presentations = new Map<string, ConfirmationPresentation>();

  private static confirmationKey(ctx: DraftContext, intentionId: string): string {
    return `${ctx.workspaceId}\u0000${ctx.actorId}\u0000${ctx.deviceId ?? ''}\u0000${intentionId}`;
  }

  private static presentationKey(ctx: DraftContext, operationId: string): string {
    return `${ctx.workspaceId}\u0000${ctx.actorId}\u0000${ctx.deviceId ?? ''}\u0000${operationId}`;
  }

  getOrCreate(record: MutationDraftRecord): { record: MutationDraftRecord; created: boolean } {
    const existing = this.drafts.get(record.draftId);
    if (existing) return { record: existing, created: false };
    this.drafts.set(record.draftId, record);
    // FIX-DUP-PROPOSAL-R2: first writer wins (parity with the durable SQL
    // index): a later draft must never steal an earlier intention's link.
    const createdKey = `${record.workspaceId}:${record.lastIntentionId}`;
    if (!this.byIntention.has(createdKey)) this.byIntention.set(createdKey, record.draftId);
    return { record, created: true };
  }

  get(draftId: string): MutationDraftRecord | undefined {
    return this.drafts.get(draftId);
  }

  listActive(ctx: DraftContext, nowMs: number): MutationDraftRecord[] {
    return [...this.drafts.values()].filter(
      (draft) => draft.status === 'active' && sameContext(draft, ctx) && !isExpired(draft, nowMs),
    );
  }

  listProposing(ctx: DraftContext, nowMs: number): MutationDraftRecord[] {
    return [...this.drafts.values()].filter(
      (draft) => draft.status === 'proposing' && sameContext(draft, ctx) && !isExpired(draft, nowMs),
    );
  }

  findByIntention(ctx: DraftContext, intentionId: string): MutationDraftRecord | undefined {
    const draftId = this.byIntention.get(`${ctx.workspaceId}:${intentionId}`);
    if (!draftId) return undefined;
    const draft = this.drafts.get(draftId);
    return draft && sameContext(draft, ctx) ? draft : undefined;
  }

  cas(
    draftId: string,
    from: 'active',
    to: 'proposing',
    patch: DraftRecordPatch = {},
  ): { ok: true; record: MutationDraftRecord } | { ok: false; current: MutationDraftRecord | undefined } {
    // Synchronous check-and-set: inside one DO turn handler this cannot
    // interleave (single-event serialization), so exactly one continuation
    // wins; every loser observes the post-CAS state deterministically.
    const current = this.drafts.get(draftId);
    if (!current || current.status !== from) return { ok: false, current };
    const next = Object.freeze({ ...current, ...patch, status: to, revision: current.revision + 1 });
    this.drafts.set(draftId, next);
    if (patch.lastIntentionId && patch.lastIntentionId !== current.lastIntentionId) {
      // FIX-DUP-PROPOSAL-R2: first writer wins (see getOrCreate).
      const casKey = `${next.workspaceId}:${patch.lastIntentionId}`;
      if (!this.byIntention.has(casKey)) this.byIntention.set(casKey, draftId);
    }
    return { ok: true, record: next };
  }

  update(
    draftId: string,
    patch: DraftRecordPatch,
    options: DraftUpdateOptions = {},
  ): MutationDraftRecord | undefined {
    const current = this.drafts.get(draftId);
    if (!current) return undefined;
    // A07/RR fix 1b: the resolved payload of a non-active draft is frozen.
    if (patchTouchesResolution(patch) && current.status !== 'active') return undefined;
    // A07/R07 anti-corruption: a stale writer never overwrites a fresher one.
    // Compared BEFORE writing, in the same synchronous turn, so the check and
    // the write cannot interleave.
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      return undefined;
    }
    const next = Object.freeze({ ...current, ...patch, revision: current.revision + 1 });
    this.drafts.set(draftId, next);
    if (patch.lastIntentionId && patch.lastIntentionId !== current.lastIntentionId) {
      // FIX-DUP-PROPOSAL-R2: first writer wins (see getOrCreate).
      const updateKey = `${next.workspaceId}:${patch.lastIntentionId}`;
      if (!this.byIntention.has(updateKey)) this.byIntention.set(updateKey, draftId);
    }
    return next;
  }

  expireStale(ctx: DraftContext, nowMs: number): number {
    let closed = 0;
    for (const draft of this.drafts.values()) {
      if (draft.status === 'active' && sameContext(draft, ctx) && isExpired(draft, nowMs)) {
        this.drafts.set(
          draft.draftId,
          Object.freeze({ ...draft, status: 'expired' as const, revision: draft.revision + 1 }),
        );
        closed += 1;
      }
    }
    return closed;
  }

  rememberConfirmation(input: RememberConfirmationInput): ClaimOutcome {
    return this.claimConfirmation({ ...input, status: 'succeeded' as ConfirmationStatus });
  }

  claimConfirmation(input: ClaimConfirmationInput): ClaimOutcome {
    // Synchronous check-and-set: inside one DO turn handler this cannot
    // interleave (single-event serialization), and the method performs NO
    // await between the check and the write, so exactly one concurrent
    // continuation wins. Immutability: a divergent re-claim is rejected,
    // never applied (criterion 4).
    const key = InMemoryMutationDraftStore.confirmationKey(input.ctx, input.intentionId);
    const existing = this.confirmations.get(key);
    if (existing) {
      // Review fix P1-2/P1-4: an unbound RESERVED sighting sentinel
      // (`operationId === ''`) is ADOPTED by the first real claim — the
      // sighting records first-seen, it never blocks the legitimate
      // first-attempt binding. A terminal (`inconclusive`) sentinel is never
      // adopted (falls through to divergent below).
      // The adoption preserves the sighting's `createdAt` (first-seen) so
      // the temporal-admissibility check keeps the original instant.
      if (existing.operationId === CONFIRMATION_UNBOUND_OPERATION_ID && existing.status === 'reserved') {
        this.confirmations.set(
          key,
          Object.freeze({
            ...buildClaimRecord(input),
            createdAt: existing.createdAt,
          }),
        );
        return 'claimed';
      }
      return existing.operationId === input.operationId ? 'identical' : 'divergent';
    }
    // Opportunistic hygiene: review fix P1-3 (policy a) — the binding is
    // NEVER deleted. Only the bulky `receipt_json` cell of tombstones far
    // beyond the redelivery window is stripped; the minimal binding row
    // keeps blocking divergent confirmations forever (bounded: one minimal
    // row per confirmation intention).
    this.stripAncientConfirmationReceipts(input.nowMs);
    this.confirmations.set(key, buildClaimRecord(input));
    return 'claimed';
  }

  noteConfirmationSighted(ctx: DraftContext, intentionId: string, nowMs: number): ConfirmationSighting {
    const key = InMemoryMutationDraftStore.confirmationKey(ctx, intentionId);
    const existing = this.confirmations.get(key);
    // The key encodes the identity legs, so a hit is always this
    // identity's own marker (per-identity sightings, like the binding).
    if (existing) return { record: existing, fresh: false };
    this.stripAncientConfirmationReceipts(nowMs);
    const stamp = new Date(nowMs).toISOString();
    const record = Object.freeze({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      intentionId,
      operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
      receiptJson: null,
      createdAt: stamp,
      expiresAt: new Date(nowMs + CONFIRMATION_TTL_MS).toISOString(),
      status: 'reserved' as ConfirmationStatus,
    });
    this.confirmations.set(key, record);
    return { record, fresh: true };
  }

  noteConfirmationPresentation(input: NoteConfirmationPresentationInput): void {
    // First presentation wins (earliest instant is the proof); repeats keep
    // it. Opportunistic prune of rows past the retention horizon keeps the
    // table bounded by business volume, never by redelivery traffic.
    // ROUND5-3: the horizon compares `expiresAt <= now` (a row presented at
    // P expires at P+30d, pruned once now >= P+30d). Comparing against
    // `now - 30d` doubled the horizon to an effective 60d.
    for (const [storedKey, record] of this.presentations) {
      if (Date.parse(record.expiresAt) <= input.nowMs) this.presentations.delete(storedKey);
    }
    const stamp = new Date(input.nowMs).toISOString();
    for (const operationId of input.operationIds) {
      if (!operationId) continue;
      const key = InMemoryMutationDraftStore.presentationKey(input.ctx, operationId);
      if (this.presentations.has(key)) continue;
      this.presentations.set(
        key,
        Object.freeze({
          workspaceId: input.ctx.workspaceId,
          actorId: input.ctx.actorId,
          deviceId: input.ctx.deviceId,
          operationId,
          presentedAt: stamp,
          expiresAt: new Date(input.nowMs + CONFIRMATION_PRESENTATION_RETENTION_MS).toISOString(),
        }),
      );
    }
  }

  findConfirmationPresentation(ctx: DraftContext, operationId: string): ConfirmationPresentation | undefined {
    const record = this.presentations.get(InMemoryMutationDraftStore.presentationKey(ctx, operationId));
    // Defense in depth: the key already encodes the legs, but a record is
    // only ever valid for its own identity — never trust the key alone.
    if (!record) return undefined;
    if (record.workspaceId !== ctx.workspaceId || record.actorId !== ctx.actorId || (record.deviceId ?? null) !== (ctx.deviceId ?? null)) {
      return undefined;
    }
    return record;
  }

  listConfirmationPresentations(ctx: DraftContext): readonly string[] {
    const ids: string[] = [];
    for (const record of this.presentations.values()) {
      if (
        record.workspaceId === ctx.workspaceId &&
        record.actorId === ctx.actorId &&
        (record.deviceId ?? null) === (ctx.deviceId ?? null) &&
        record.operationId
      ) {
        ids.push(record.operationId);
      }
    }
    return ids;
  }

  forgetConfirmationPresentations(ctx: DraftContext, operationIds: readonly string[]): void {
    for (const operationId of operationIds) {
      if (!operationId) continue;
      this.presentations.delete(InMemoryMutationDraftStore.presentationKey(ctx, operationId));
    }
  }

  private stripAncientConfirmationReceipts(nowMs: number): void {
    const pruneBefore = nowMs - CONFIRMATION_TOMBSTONE_RETENTION_MS;
    for (const [storedKey, record] of this.confirmations) {
      if (record.receiptJson !== null && Date.parse(record.expiresAt) <= pruneBefore) {
        this.confirmations.set(storedKey, Object.freeze({ ...record, receiptJson: null }));
      }
    }
  }

  settleConfirmation(input: SettleConfirmationInput): boolean {
    // Synchronous CAS on `status = 'reserved'`: terminal rows are immutable.
    const key = InMemoryMutationDraftStore.confirmationKey(input.ctx, input.intentionId);
    const existing = this.confirmations.get(key);
    if (
      !existing ||
      existing.operationId !== input.operationId ||
      existing.status !== 'reserved' ||
      existing.workspaceId !== input.ctx.workspaceId ||
      existing.actorId !== input.ctx.actorId ||
      (existing.deviceId ?? null) !== (input.ctx.deviceId ?? null)
    ) {
      return false;
    }
    this.confirmations.set(
      key,
      Object.freeze({ ...existing, status: input.status, receiptJson: input.receiptJson }),
    );
    return true;
  }

  findConfirmation(ctx: DraftContext, intentionId: string, _nowMs: number): ConfirmationRecord | undefined {
    const record = this.confirmations.get(InMemoryMutationDraftStore.confirmationKey(ctx, intentionId));
    // Defense in depth: the key already encodes the legs, but a marker is
    // only ever valid for its own identity — never trust the key alone.
    // Tombstones included: an expired binding still blocks a divergent
    // confirmation (the caller discriminates via `isConfirmationExpired`).
    if (!record) return undefined;
    if (record.workspaceId !== ctx.workspaceId || record.actorId !== ctx.actorId || (record.deviceId ?? null) !== (ctx.deviceId ?? null)) {
      return undefined;
    }
    return record;
  }
}

type SqlExec = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const rowToRecord = (row: Record<string, unknown>): MutationDraftRecord => {
  const record = {
    draftId: String(row.draft_id ?? ''),
    workspaceId: String(row.workspace_id ?? ''),
    actorId: String(row.actor_id ?? ''),
    deviceId: (row.device_id as string | null) ?? null,
    ...(typeof row.conversation_id === 'string' && row.conversation_id ? { conversationId: row.conversation_id } : {}),
    tool: String(row.tool ?? 'transactions.expense.create'),
    resolvedArgs: JSON.parse(String(row.resolved_args_json ?? '{}')),
    missingFields: JSON.parse(String(row.missing_fields_json ?? '[]')),
    proposalIdempotencyKey: String(row.proposal_idempotency_key ?? ''),
    ...(typeof row.proposal_id === 'string' && row.proposal_id ? { proposalId: row.proposal_id } : {}),
    ...(typeof row.propose_outcome === 'string' && row.propose_outcome ? { proposeOutcome: row.propose_outcome } : {}),
    status: String(row.status ?? 'active'),
    ...(typeof row.discard_reason === 'string' && row.discard_reason ? { discardReason: row.discard_reason } : {}),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    lastIntentionId: String(row.last_intention_id ?? ''),
    lastQuestion: String(row.last_question ?? ''),
    // A07/R07: `goal_id` is read back when the column exists, and always
    // derived from `draft_id` otherwise (legacy rows written before the
    // migration). The two can never diverge into two identities.
    goalId: String(row.goal_id ?? '') || String(row.draft_id ?? ''),
    revision: Number(row.revision) || 0,
    originMessages: parseJsonArray<string>(row.origin_messages_json),
    relations: parseJsonArray<DraftRelation>(row.relations_json).filter(isDraftRelation),
    ...(parseJsonObject<DraftFieldProvenance>(row.field_provenance_json)
      ? { fieldProvenance: parseJsonObject<DraftFieldProvenance>(row.field_provenance_json)! }
      : {}),
  } as MutationDraftRecord;
  return Object.freeze(record);
};

const parseJsonArray = <T>(raw: unknown): readonly T[] => {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as readonly T[]) : [];
  } catch {
    // A corrupt metadata cell degrades to "no record", never to a crash or a
    // fabricated entry.
    return [];
  }
};

/**
 * A07/RR (review fix 6) — object-shaped metadata cell with the SAME hardened
 * parse as its array sibling: an absent, empty or corrupt
 * `field_provenance_json` degrades to ABSENCE (provenance is optional by
 * contract), never to a throw and never to a fabricated snapshot.
 */
const parseJsonObject = <T>(raw: unknown): T | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
};

const isDraftRelation = (value: unknown): value is DraftRelation =>
  typeof value === 'string' && (DRAFT_RELATIONS as readonly string[]).includes(value);

export const initializeMutationDraftSchema = (sql: SqlExec): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mutation_drafts (
      draft_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT,
      conversation_id TEXT,
      tool TEXT NOT NULL,
      resolved_args_json TEXT NOT NULL,
      missing_fields_json TEXT NOT NULL,
      proposal_idempotency_key TEXT NOT NULL,
      proposal_id TEXT,
      propose_outcome TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      discard_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_intention_id TEXT NOT NULL,
      last_question TEXT NOT NULL DEFAULT '',
      goal_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      origin_messages_json TEXT NOT NULL DEFAULT '[]',
      relations_json TEXT NOT NULL DEFAULT '[]',
      field_provenance_json TEXT
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_drafts_context
    ON mutation_drafts (workspace_id, actor_id, status);
  `);
  // PR137-SEC-FIX Fase 1 (A) — durable idempotent confirmation binding (see
  // `ConfirmationRecord`). `device_id` is NOT NULL with `''` standing for
  // "no device" so the PRIMARY KEY legs are never NULL (SQLite treats NULL
  // PK legs as distinct, which would fork one identity into many markers).
  // PR137-HARDEN: `status` carries the reserve→terminal lifecycle
  // (`reserved`/`succeeded`/`inconclusive`); pre-hardening rows default to
  // `succeeded` (they were written strictly post-success).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mutation_confirmations (
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      intention_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'succeeded',
      PRIMARY KEY (workspace_id, actor_id, device_id, intention_id)
    );
  `);
  // Review round 4 P1-A3 — presentation binding (see
  // `CONFIRMATION_PRESENTATION_RETENTION_MS`). One minimal row per
  // identity+operation: WHEN this operation was shown to this identity.
  // First presentation wins (`ON CONFLICT DO NOTHING` below); `device_id`
  // is NOT NULL with `''` for "no device" so PK legs are never NULL.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mutation_confirmation_presentations (
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL,
      presented_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, actor_id, device_id, operation_id)
    );
  `);
  // FIX-DUP-PROPOSAL — durable intention→draft index. `findByIntention`
  // below used to match ONLY `last_intention_id`, which every continuation
  // overwrites: after intention J completed/consumed a draft created by
  // intention I, a redelivery of I missed the lookup and the fresh flow
  // proposed anew under a different idempotency key (1 turno → 2
  // pending_operations). Every intention that touches a draft is linked
  // immutably (first writer wins, `ON CONFLICT DO NOTHING`); the lookup
  // consults the index FIRST (a hijacked `last_intention_id` never shadows
  // the original link) and falls back to the fast path only when no durable
  // link exists, so a redelivery recovers
  // its draft/proposal — including consumed ones — before any flow choice.
  // `device_id` is NOT NULL with `''` for "no device" so PK legs are never
  // NULL (same mold as `mutation_confirmations`); the fetched draft still
  // passes the `sameContext` check, so the index can never cross an
  // identity leg (workspace/actor/device/conversation).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mutation_draft_intentions (
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      intention_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, actor_id, device_id, intention_id)
    );
  `);
  // Idempotent compat for DOs created before these columns existed
  // (CREATE TABLE IF NOT EXISTS never backfills columns): add them when
  // missing. Duplicate-column races are swallowed, other errors propagate.
  for (const column of MUTATION_DRAFT_COMPAT_COLUMNS) ensureColumn(sql, column);
  for (const column of MUTATION_CONFIRMATION_COMPAT_COLUMNS) ensureConfirmationColumn(sql, column);
};

/**
 * A07/R07 — additive goal metadata declared once as the migration list and
 * read back by name. A literal table (never user input) is interpolated into
 * the ALTER statement.
 */
const MUTATION_DRAFT_COMPAT_COLUMNS: readonly Readonly<{ name: string; ddl: string }>[] = [
  { name: 'last_question', ddl: `last_question TEXT NOT NULL DEFAULT ''` },
  { name: 'goal_id', ddl: `goal_id TEXT` },
  { name: 'revision', ddl: `revision INTEGER NOT NULL DEFAULT 0` },
  { name: 'origin_messages_json', ddl: `origin_messages_json TEXT NOT NULL DEFAULT '[]'` },
  { name: 'relations_json', ddl: `relations_json TEXT NOT NULL DEFAULT '[]'` },
  { name: 'field_provenance_json', ddl: `field_provenance_json TEXT` },
];

const ensureColumn = (sql: SqlExec, column: Readonly<{ name: string; ddl: string }>): void => {
  try {
    const rows = [
      ...sql.exec<Record<string, unknown>>(`PRAGMA table_info(mutation_drafts)`),
    ];
    if (rows.some((row) => String(row.name ?? '') === column.name)) return;
  } catch {
    // PRAGMA unavailable on this storage shim — fall through to the
    // ALTER attempt below, which is itself idempotency-guarded.
  }
  try {
    sql.exec(`ALTER TABLE mutation_drafts ADD COLUMN ${column.ddl}`);
  } catch (error) {
    if (!/duplicate/i.test(String((error as Error)?.message ?? error))) throw error;
  }
};

/**
 * PR137-HARDEN: additive `status` lifecycle on the confirmation binding.
 * Same `ensureColumn` mold as the drafts table: idempotent, preservative
 * (existing rows take `'succeeded'` — their only possible pre-hardening
 * state), rollback-compatible (old code ignores the column; new code
 * defaults it when absent).
 */
const MUTATION_CONFIRMATION_COMPAT_COLUMNS: readonly Readonly<{ name: string; ddl: string }>[] = [
  { name: 'status', ddl: `status TEXT NOT NULL DEFAULT 'succeeded'` },
];

const ensureConfirmationColumn = (sql: SqlExec, column: Readonly<{ name: string; ddl: string }>): void => {
  try {
    const rows = [
      ...sql.exec<Record<string, unknown>>(`PRAGMA table_info(mutation_confirmations)`),
    ];
    if (rows.some((row) => String(row.name ?? '') === column.name)) return;
  } catch {
    // PRAGMA unavailable — fall through to the guarded ALTER below. When
    // the table itself is missing (schema never initialized), the ALTER
    // throws a non-duplicate error that propagates: financial paths stay
    // fail-closed instead of confirming unprotected.
  }
  try {
    sql.exec(`ALTER TABLE mutation_confirmations ADD COLUMN ${column.ddl}`);
  } catch (error) {
    if (!/duplicate/i.test(String((error as Error)?.message ?? error))) throw error;
  }
};

const rowToConfirmation = (row: Record<string, unknown>): ConfirmationRecord => {
  const status = String(row.status ?? 'succeeded');
  return Object.freeze({
    workspaceId: String(row.workspace_id ?? ''),
    actorId: String(row.actor_id ?? ''),
    deviceId: (typeof row.device_id === 'string' && row.device_id ? row.device_id : null) as string | null,
    intentionId: String(row.intention_id ?? ''),
    operationId: String(row.operation_id ?? ''),
    receiptJson: (typeof row.receipt_json === 'string' ? row.receipt_json : null) as string | null,
    createdAt: String(row.created_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    status: (status === 'reserved' || status === 'inconclusive' ? status : 'succeeded') as ConfirmationStatus,
  });
};

/** DO-storage-backed draft store (SQLite in the conversation DO). */
export class SqlMutationDraftStore implements MutationDraftStore {
  constructor(private readonly sql: SqlExec) {}

  private persist(record: MutationDraftRecord): void {
    this.sql.exec(
      `INSERT INTO mutation_drafts (draft_id, workspace_id, actor_id, device_id, conversation_id, tool, resolved_args_json, missing_fields_json, proposal_idempotency_key, proposal_id, propose_outcome, status, discard_reason, created_at, updated_at, expires_at, last_intention_id, last_question, goal_id, revision, origin_messages_json, relations_json, field_provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (draft_id) DO NOTHING`,
      record.draftId,
      record.workspaceId,
      record.actorId,
      record.deviceId,
      record.conversationId ?? null,
      record.tool,
      JSON.stringify(record.resolvedArgs),
      JSON.stringify([...record.missingFields]),
      record.proposalIdempotencyKey,
      record.proposalId ?? null,
      record.proposeOutcome ?? null,
      record.status,
      record.discardReason ?? null,
      record.createdAt,
      record.updatedAt,
      record.expiresAt,
      record.lastIntentionId,
      record.lastQuestion,
      record.goalId,
      record.revision,
      JSON.stringify([...record.originMessages]),
      JSON.stringify([...record.relations]),
      record.fieldProvenance ? JSON.stringify(record.fieldProvenance) : null,
    );
  }

  private writeUpdate(
    draftId: string,
    record: MutationDraftRecord,
    expectedRevision?: number,
    options: Readonly<{ activeOnly?: boolean; returning?: boolean }> = {},
  ): MutationDraftRecord | undefined {
    // A07/R07: when the caller guards on a revision, the predicate lives INSIDE
    // the statement, so the storage engine itself rejects a stale write.
    // A07/RR fix 1b: `activeOnly` moves the same protection into the predicate
    // for a resolution patch (frozen `proposing` payload, terminal states).
    // A07/RR fix 3: with `returning`, `RETURNING *` makes the STATEMENT the sole
    // definition of success — a matched row is the proof, so a concurrent write
    // between the UPDATE and any later read can never fake one.
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `UPDATE mutation_drafts SET resolved_args_json = ?, missing_fields_json = ?, proposal_id = ?, propose_outcome = ?, status = ?, discard_reason = ?, updated_at = ?, last_intention_id = ?, last_question = ?, goal_id = ?, revision = ?, origin_messages_json = ?, relations_json = ?, field_provenance_json = ? WHERE draft_id = ?` +
          (expectedRevision === undefined ? '' : ' AND revision = ?') +
          (options.activeOnly ? " AND status = 'active'" : '') +
          (options.returning ? ' RETURNING *' : ''),
        JSON.stringify(record.resolvedArgs),
        JSON.stringify([...record.missingFields]),
        record.proposalId ?? null,
        record.proposeOutcome ?? null,
        record.status,
        record.discardReason ?? null,
        record.updatedAt,
        record.lastIntentionId,
        record.lastQuestion,
        record.goalId,
        record.revision,
        JSON.stringify([...record.originMessages]),
        JSON.stringify([...record.relations]),
        record.fieldProvenance ? JSON.stringify(record.fieldProvenance) : null,
        draftId,
        ...(expectedRevision === undefined ? [] : [expectedRevision]),
      ),
    ];
    if (!options.returning) return undefined;
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  getOrCreate(record: MutationDraftRecord): { record: MutationDraftRecord; created: boolean } {
    const existing = this.get(record.draftId);
    if (existing) {
      // Self-heal for rows written before the intention index existed: a
      // getOrCreate hit means the caller derives this draftId, so the
      // caller's intention is a contributor by construction.
      this.linkIntention(existing, record.lastIntentionId);
      return { record: existing, created: false };
    }
    try {
      this.persist(record);
    } catch {
      const raced = this.get(record.draftId);
      if (raced) {
        this.linkIntention(raced, record.lastIntentionId);
        return { record: raced, created: false };
      }
      throw new Error('agent.draft_store_unavailable');
    }
    this.linkIntention(record, record.lastIntentionId);
    return { record, created: true };
  }

  get(draftId: string): MutationDraftRecord | undefined {
    const rows = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM mutation_drafts WHERE draft_id = ?`, draftId)];
    return rows.length > 0 && rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  private listByStatus(ctx: DraftContext, nowMs: number, status: 'active' | 'proposing'): MutationDraftRecord[] {
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_drafts WHERE workspace_id = ? AND actor_id = ? AND status = ?`,
        ctx.workspaceId,
        ctx.actorId,
        status,
      ),
    ];
    return rows
      .map(rowToRecord)
      .filter((draft) => sameContext(draft, ctx) && !isExpired(draft, nowMs));
  }

  listActive(ctx: DraftContext, nowMs: number): MutationDraftRecord[] {
    return this.listByStatus(ctx, nowMs, 'active');
  }

  listProposing(ctx: DraftContext, nowMs: number): MutationDraftRecord[] {
    return this.listByStatus(ctx, nowMs, 'proposing');
  }

  findByIntention(ctx: DraftContext, intentionId: string): MutationDraftRecord | undefined {
    // FIX-DUP-PROPOSAL-R2: the durable contributor index (immutable,
    // first-writer-wins) is consulted BEFORE the mutable `last_intention_id`
    // fast path. A hijacked fast-path column (a later touch overwriting it
    // with an earlier intention id) must never shadow the original link.
    let draftId: string | undefined;
    try {
      const linked = [
        ...this.sql.exec<Record<string, unknown>>(
          `SELECT draft_id FROM mutation_draft_intentions WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND intention_id = ?`,
          ctx.workspaceId,
          ctx.actorId,
          ctx.deviceId ?? '',
          intentionId,
        ),
      ];
      const first = linked[0];
      draftId = first ? String(first.draft_id ?? '') || undefined : undefined;
    } catch {
      // A missing index/table degrades to the pre-fix miss (undefined) —
      // never to a throw inside the lookup.
      return undefined;
    }
    if (draftId) {
      let draft: MutationDraftRecord | undefined;
      try {
        draft = this.get(draftId);
      } catch {
        // FIX-DUP-PROPOSAL-R2: a selective read failure on the linked draft
        // is a miss, never a turn error.
        return undefined;
      }
      return draft && sameContext(draft, ctx) ? draft : undefined;
    }
    // No durable link: fall back to the last-toucher fast path.
    // FIX-DUP-PROPOSAL-R3: the WHOLE fallback branch (query, iteration,
    // rowToRecord) is miss-on-failure — never a throw inside the lookup.
    try {
      const rows = [
        ...this.sql.exec<Record<string, unknown>>(
          `SELECT * FROM mutation_drafts WHERE workspace_id = ? AND actor_id = ? AND last_intention_id = ? ORDER BY updated_at DESC LIMIT 1`,
          ctx.workspaceId,
          ctx.actorId,
          intentionId,
        ),
      ];
      const found = rows.length > 0 && rows[0] ? rowToRecord(rows[0]) : undefined;
      if (found && sameContext(found, ctx)) return found;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * FIX-DUP-PROPOSAL — immutable intention→draft link (first writer wins).
   * Best-effort: a link failure degrades the lookup to the pre-fix
   * last-intention behavior instead of breaking the turn that just wrote.
   */
  private linkIntention(
    record: MutationDraftRecord,
    intentionId: string | undefined,
  ): void {
    if (!intentionId) return;
    try {
      this.sql.exec(
        `INSERT INTO mutation_draft_intentions (workspace_id, actor_id, device_id, intention_id, draft_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, actor_id, device_id, intention_id) DO NOTHING`,
        record.workspaceId,
        record.actorId,
        record.deviceId ?? '',
        intentionId,
        record.draftId,
        new Date().toISOString(),
      );
    } catch {
      // Best-effort index only.
    }
  }

  cas(
    draftId: string,
    from: 'active',
    to: 'proposing',
    patch: DraftRecordPatch = {},
  ): { ok: true; record: MutationDraftRecord } | { ok: false; current: MutationDraftRecord | undefined } {
    // Single-statement atomicity at the storage engine: the status predicate
    // is evaluated inside the UPDATE, so concurrent continuations (across
    // restarts/evictions, where the in-memory guarantee no longer applies)
    // still elect exactly one winner.
    const current = this.get(draftId);
    if (!current) return { ok: false, current: undefined };
    const next = Object.freeze({ ...current, ...patch, status: to, revision: current.revision + 1 });
    this.writeUpdateWithStatusGuard(draftId, next, from);
    const verified = this.get(draftId);
    if (verified && verified.status === to && verified.lastIntentionId === next.lastIntentionId) {
      this.linkIntention(verified, patch.lastIntentionId);
      return { ok: true, record: verified };
    }
    return { ok: false, current: verified };
  }

  private writeUpdateWithStatusGuard(draftId: string, next: MutationDraftRecord, from: string): void {
    this.sql.exec(
      `UPDATE mutation_drafts SET resolved_args_json = ?, missing_fields_json = ?, proposal_id = ?, propose_outcome = ?, status = ?, discard_reason = ?, updated_at = ?, last_intention_id = ?, last_question = ?, goal_id = ?, revision = ?, origin_messages_json = ?, relations_json = ?, field_provenance_json = ? WHERE draft_id = ? AND status = ?`,
      JSON.stringify(next.resolvedArgs),
      JSON.stringify([...next.missingFields]),
      next.proposalId ?? null,
      next.proposeOutcome ?? null,
      next.status,
      next.discardReason ?? null,
      next.updatedAt,
      next.lastIntentionId,
      next.lastQuestion,
      next.goalId,
      next.revision,
      JSON.stringify([...next.originMessages]),
      JSON.stringify([...next.relations]),
      next.fieldProvenance ? JSON.stringify(next.fieldProvenance) : null,
      draftId,
      from,
    );
  }

  update(
    draftId: string,
    patch: DraftRecordPatch,
    options: DraftUpdateOptions = {},
  ): MutationDraftRecord | undefined {
    const current = this.get(draftId);
    if (!current) return undefined;
    // A07/RR fix 1b: a resolution patch never lands on a non-active draft.
    const touchesResolution = patchTouchesResolution(patch);
    if (touchesResolution && current.status !== 'active') return undefined;
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      return undefined;
    }
    const next = Object.freeze({ ...current, ...patch, revision: current.revision + 1 });
    // A07/RR fix 3: success is the STATEMENT's own verdict (a row comes back
    // only for the writer whose predicates matched) — never a re-read, which a
    // concurrent write landing on the next revision could impersonate. The
    // returned record is what the engine persisted.
    const written = this.writeUpdate(draftId, next, options.expectedRevision, {
      ...(touchesResolution ? { activeOnly: true } : {}),
      returning: true,
    });
    if (written && patch.lastIntentionId) this.linkIntention(written, patch.lastIntentionId);
    return written;
  }

  expireStale(ctx: DraftContext, nowMs: number): number {
    const stale = this.listByStatusRaw(ctx, 'active').filter((draft) => isExpired(draft, nowMs));
    for (const draft of stale) {
      this.writeUpdate(
        draft.draftId,
        Object.freeze({ ...draft, status: 'expired' as const, revision: draft.revision + 1 }),
      );
    }
    return stale.length;
  }

  private listByStatusRaw(ctx: DraftContext, status: string): MutationDraftRecord[] {
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_drafts WHERE workspace_id = ? AND actor_id = ? AND status = ?`,
        ctx.workspaceId,
        ctx.actorId,
        status,
      ),
    ];
    return rows.map(rowToRecord).filter((draft) => sameContext(draft, ctx));
  }

  rememberConfirmation(input: RememberConfirmationInput): ClaimOutcome {
    return this.claimConfirmation({ ...input, status: 'succeeded' as ConfirmationStatus });
  }

  claimConfirmation(input: ClaimConfirmationInput): ClaimOutcome {
    const record = buildClaimRecord(input);
    const device = record.deviceId ?? '';
    // Opportunistic hygiene, review fix P1-3 (policy a): the binding is
    // NEVER deleted — only the bulky `receipt_json` of tombstones past
    // `CONFIRMATION_TOMBSTONE_RETENTION_MS` is stripped (the minimal row
    // keeps blocking divergent confirmations; bounded by business volume).
    // Strip-hygiene is never authority: a failure must not break the
    // binding write below.
    try {
      const pruneBefore = new Date(input.nowMs - CONFIRMATION_TOMBSTONE_RETENTION_MS).toISOString();
      this.sql.exec(`UPDATE mutation_confirmations SET receipt_json = NULL WHERE receipt_json IS NOT NULL AND expires_at <= ?`, pruneBefore);
    } catch {
      // Best-effort hygiene only.
    }
    // IMMUTABLE CAS: `DO NOTHING` on conflict — the first durable writer
    // wins at the storage engine, so concurrent claims for the same
    // identity+intentionId elect exactly one winner with no TOCTOU window.
    // `RETURNING *` is the STATEMENT's own verdict (a row comes back only
    // for the writer that actually inserted — the same mold as
    // `writeUpdate`): the winner reports `claimed`, losers fall through to
    // the read below and report `identical`/`divergent`. The pre-hardening
    // `DO UPDATE` (silent A→B rebinding) is removed.
    const inserted = [
      ...this.sql.exec<Record<string, unknown>>(
        `INSERT INTO mutation_confirmations (workspace_id, actor_id, device_id, intention_id, operation_id, receipt_json, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, actor_id, device_id, intention_id) DO NOTHING
         RETURNING *`,
        record.workspaceId,
        record.actorId,
        device,
        record.intentionId,
        record.operationId,
        record.receiptJson,
        record.createdAt,
        record.expiresAt,
        record.status,
      ),
    ];
    if (inserted.length > 0) return 'claimed';
    const stored = this.findConfirmation(input.ctx, input.intentionId, input.nowMs);
    if (!stored) throw new Error('agent.confirmation_store_unavailable');
    // Review fix P1-2/P1-4: adopt an unbound RESERVED sighting sentinel
    // (`operationId === ''`, written by `noteConfirmationSighted` before
    // any listing resolution). A terminal (`inconclusive`) sentinel is NEVER
    // adopted — the no-target outcome is final for this intention. The
    // sentinel records first-seen; it never blocks the legitimate
    // first-attempt claim. CAS on `operation_id = '' AND status =
    // 'reserved'` so exactly one concurrent adopter wins; losers re-read
    // below. The sighting's `createdAt` (first-seen) is preserved for the
    // temporal-admissibility check.
    if (stored.operationId === CONFIRMATION_UNBOUND_OPERATION_ID && stored.status === 'reserved') {
      const adopted = [
        ...this.sql.exec<Record<string, unknown>>(
          `UPDATE mutation_confirmations SET operation_id = ?, receipt_json = ?, expires_at = ?, status = ? WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND intention_id = ? AND operation_id = ? AND status = 'reserved' RETURNING *`,
          record.operationId,
          record.receiptJson,
          record.expiresAt,
          record.status,
          record.workspaceId,
          record.actorId,
          device,
          record.intentionId,
          CONFIRMATION_UNBOUND_OPERATION_ID,
        ),
      ];
      if (adopted.length > 0) return 'claimed';
      const reread = this.findConfirmation(input.ctx, input.intentionId, input.nowMs);
      if (!reread) throw new Error('agent.confirmation_store_unavailable');
      return reread.operationId === input.operationId ? 'identical' : 'divergent';
    }
    return stored.operationId === input.operationId ? 'identical' : 'divergent';
  }

  noteConfirmationSighted(ctx: DraftContext, intentionId: string, nowMs: number): ConfirmationSighting {
    const stamp = new Date(nowMs).toISOString();
    const device = ctx.deviceId ?? '';
    const inserted = [
      ...this.sql.exec<Record<string, unknown>>(
        `INSERT INTO mutation_confirmations (workspace_id, actor_id, device_id, intention_id, operation_id, receipt_json, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'reserved')
         ON CONFLICT (workspace_id, actor_id, device_id, intention_id) DO NOTHING
         RETURNING *`,
        ctx.workspaceId,
        ctx.actorId,
        device,
        intentionId,
        CONFIRMATION_UNBOUND_OPERATION_ID,
        stamp,
        new Date(nowMs + CONFIRMATION_TTL_MS).toISOString(),
      ),
    ];
    if (inserted.length > 0) {
      const row = inserted[0];
      if (row) return { record: rowToConfirmation(row), fresh: true };
    }
    const stored = this.findConfirmation(ctx, intentionId, nowMs);
    if (!stored) throw new Error('agent.confirmation_store_unavailable');
    return { record: stored, fresh: false };
  }

  settleConfirmation(input: SettleConfirmationInput): boolean {
    // Terminal CAS: only a `reserved` row for THIS operation transitions.
    // `succeeded`/`inconclusive` rows are immutable — this statement can
    // never move them, and a missing/foreign row settles nothing.
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `UPDATE mutation_confirmations SET receipt_json = ?, status = ? WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND intention_id = ? AND operation_id = ? AND status = 'reserved' RETURNING *`,
        input.receiptJson,
        input.status,
        input.ctx.workspaceId,
        input.ctx.actorId,
        input.ctx.deviceId ?? '',
        input.intentionId,
        input.operationId,
      ),
    ];
    return rows.length > 0;
  }

  findConfirmation(ctx: DraftContext, intentionId: string, _nowMs: number): ConfirmationRecord | undefined {
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_confirmations WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND intention_id = ?`,
        ctx.workspaceId,
        ctx.actorId,
        ctx.deviceId ?? '',
        intentionId,
      ),
    ];
    const row = rows[0];
    if (!row) return undefined;
    const record = rowToConfirmation(row);
    // Identity legs re-checked (defense in depth). Tombstones included: an
    // expired binding still blocks a divergent confirmation — the caller
    // discriminates via `isConfirmationExpired` (blind replay is allowed
    // only for unexpired `succeeded` markers with a valid/absent receipt).
    if (record.workspaceId !== ctx.workspaceId || record.actorId !== ctx.actorId || (record.deviceId ?? null) !== (ctx.deviceId ?? null)) {
      return undefined;
    }
    return record;
  }

  noteConfirmationPresentation(input: NoteConfirmationPresentationInput): void {
    // Opportunistic hygiene (best-effort, never authority): prune rows past
    // the retention horizon; a prune failure never breaks the writes below.
    // ROUND5-3: compare `expires_at <= now` (a row presented at P expires at
    // P+30d). The previous `now - 30d` bound doubled the horizon to 60d.
    try {
      const pruneBefore = new Date(input.nowMs).toISOString();
      this.sql.exec(`DELETE FROM mutation_confirmation_presentations WHERE expires_at <= ?`, pruneBefore);
    } catch {
      // Best-effort hygiene only.
    }
    const stamp = new Date(input.nowMs).toISOString();
    const expiresAt = new Date(input.nowMs + CONFIRMATION_PRESENTATION_RETENTION_MS).toISOString();
    for (const operationId of input.operationIds) {
      if (!operationId) continue;
      // First presentation wins at the storage engine: a repeat for an
      // already-presented operation keeps the earliest instant (the proof
      // that it was shown at or before the intention's anchor).
      this.sql.exec(
        `INSERT INTO mutation_confirmation_presentations (workspace_id, actor_id, device_id, operation_id, presented_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, actor_id, device_id, operation_id) DO NOTHING`,
        input.ctx.workspaceId,
        input.ctx.actorId,
        input.ctx.deviceId ?? '',
        operationId,
        stamp,
        expiresAt,
      );
    }
  }

  findConfirmationPresentation(ctx: DraftContext, operationId: string): ConfirmationPresentation | undefined {
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_confirmation_presentations WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND operation_id = ?`,
        ctx.workspaceId,
        ctx.actorId,
        ctx.deviceId ?? '',
        operationId,
      ),
    ];
    const row = rows[0];
    if (!row) return undefined;
    const record = Object.freeze({
      workspaceId: String(row.workspace_id ?? ''),
      actorId: String(row.actor_id ?? ''),
      deviceId: (typeof row.device_id === 'string' && row.device_id ? row.device_id : null) as string | null,
      operationId: String(row.operation_id ?? ''),
      presentedAt: String(row.presented_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
    });
    if (record.workspaceId !== ctx.workspaceId || record.actorId !== ctx.actorId || (record.deviceId ?? null) !== (ctx.deviceId ?? null)) {
      return undefined;
    }
    return record;
  }

  listConfirmationPresentations(ctx: DraftContext): readonly string[] {
    // `SELECT *` shape (not a projection): the test shims model exactly this
    // statement family, and the legs are re-checked per row below.
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_confirmation_presentations WHERE workspace_id = ? AND actor_id = ? AND device_id = ?`,
        ctx.workspaceId,
        ctx.actorId,
        ctx.deviceId ?? '',
      ),
    ];
    const ids: string[] = [];
    for (const row of rows) {
      if (
        String(row.workspace_id ?? '') !== ctx.workspaceId ||
        String(row.actor_id ?? '') !== ctx.actorId ||
        (typeof row.device_id === 'string' && row.device_id ? row.device_id : null) !== (ctx.deviceId ?? null)
      ) {
        continue;
      }
      const operationId = String(row.operation_id ?? '');
      if (operationId) ids.push(operationId);
    }
    return ids;
  }

  forgetConfirmationPresentations(ctx: DraftContext, operationIds: readonly string[]): void {
    const ids = operationIds.filter((operationId) => !!operationId);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    try {
      this.sql.exec(
        `DELETE FROM mutation_confirmation_presentations WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND operation_id IN (${placeholders})`,
        ctx.workspaceId,
        ctx.actorId,
        ctx.deviceId ?? '',
        ...ids,
      );
    } catch {
      // Best-effort compensation only — never breaks the turn.
    }
  }
}

/** True when the context holds any draft that may still need a propose. */
export const hasRecoverableDraft = (store: MutationDraftStore, ctx: DraftContext, nowMs: number): boolean =>
  store.listActive(ctx, nowMs).length > 0 || store.listProposing(ctx, nowMs).length > 0;
