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

export type DraftTool = TedApprovalTool;

export type MutationDraftResolvedArgs = Readonly<{
  kind: 'expense' | 'income';
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
   */
  accountName?: string;
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
    tool: draft.tool,
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

const CANCEL_RE = /\b(cancela|cancelar|desist)/i;
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
}

export class InMemoryMutationDraftStore implements MutationDraftStore {
  private readonly drafts = new Map<string, MutationDraftRecord>();
  private readonly byIntention = new Map<string, string>();

  getOrCreate(record: MutationDraftRecord): { record: MutationDraftRecord; created: boolean } {
    const existing = this.drafts.get(record.draftId);
    if (existing) return { record: existing, created: false };
    this.drafts.set(record.draftId, record);
    this.byIntention.set(`${record.workspaceId}:${record.lastIntentionId}`, record.draftId);
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
      this.byIntention.set(`${next.workspaceId}:${patch.lastIntentionId}`, draftId);
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
      this.byIntention.set(`${next.workspaceId}:${patch.lastIntentionId}`, draftId);
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
  // Idempotent compat for DOs created before these columns existed
  // (CREATE TABLE IF NOT EXISTS never backfills columns): add them when
  // missing. Duplicate-column races are swallowed, other errors propagate.
  for (const column of MUTATION_DRAFT_COMPAT_COLUMNS) ensureColumn(sql, column);
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
    if (existing) return { record: existing, created: false };
    try {
      this.persist(record);
    } catch {
      const raced = this.get(record.draftId);
      if (raced) return { record: raced, created: false };
      throw new Error('agent.draft_store_unavailable');
    }
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
    const rows = [
      ...this.sql.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_drafts WHERE workspace_id = ? AND actor_id = ? AND last_intention_id = ? ORDER BY updated_at DESC LIMIT 1`,
        ctx.workspaceId,
        ctx.actorId,
        intentionId,
      ),
    ];
    const found = rows.length > 0 && rows[0] ? rowToRecord(rows[0]) : undefined;
    return found && sameContext(found, ctx) ? found : undefined;
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
    return this.writeUpdate(draftId, next, options.expectedRevision, {
      ...(touchesResolution ? { activeOnly: true } : {}),
      returning: true,
    });
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
}

/** True when the context holds any draft that may still need a propose. */
export const hasRecoverableDraft = (store: MutationDraftStore, ctx: DraftContext, nowMs: number): boolean =>
  store.listActive(ctx, nowMs).length > 0 || store.listProposing(ctx, nowMs).length > 0;
