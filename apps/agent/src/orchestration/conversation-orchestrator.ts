import { scrubForPersistence } from '../privacy/dlp.js';
import {
  hasMutationIntentSignal,
  interpretMutationUtterance,
  ambiguityClarificationText,
  hasNegation,
  hasUnsupportedCurrency,
  type SemanticInterpretation,
} from '../mutations/semantic-interpretation.js';
import { parseMoneyToCents, resolveRelativeDateFragment } from '../mutations/financial-parser.js';
import { resolveMutationEntities, revalidateResolvedEntities, entityResolutionSignals, type EntityReader, type EntityResolutionTrace } from '../mutations/entity-resolver.js';
import type { MutationApiClient, MutationIdentity } from '../mutations/mutation-api-client.js';
import { deriveIdempotencyKey } from '../tools/intention-ledger.js';
import {
  DEFAULT_MAX_PROPOSE_ATTEMPTS,
  DEFAULT_DRAFT_TTL_MS,
  appendDraftRelation,
  appendOriginMessage,
  buildDraftRecord,
  isCancelText,
  isExpired,
  isDefinitiveProposeError,
  isResetText,
  toChannelMessage,
  validateCompleteArgs,
  type DraftContext,
  type DraftFieldProvenance,
  type DraftRecordPatch,
  type DraftRelation,
  type MutationDraftRecord,
  type MutationDraftResolvedArgs,
  type MutationDraftStore,
} from '../mutations/mutation-draft.js';
import type { MutationDraftChannelMessage, MutationReceipt, PendingOperationPresentation } from '@pi-finance/llm-contracts';
import { buildApprovalPresentation } from '../mutations/approval-presentation.js';
import { emitSanitizedEvent } from '../observability/events.js';
import type { EvidenceEnvelope } from '../evidence/evidence-envelope.js';
import { createGroundedResponseWithRetry } from '../responses/grounded-response.js';
import { stripToolCallMarkup } from '../responses/tool-call-sanitizer.js';
import { renderEmpty, renderInconclusive, renderMutationResult, renderReadAbsence, renderStatement, renderUnavailable, FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT } from '../responses/deterministic-responses.js';
import { routeIntent } from './intent-router.js';
import { TurnBudget, type RecoveryPermit, type ResolutionRecoveryRequest } from './turn-budget.js';
import { extractAccountsEvidence, renderAccountsAnswer, seeksAccountBalance } from './account-grounding.js';
import { makesUnverifiedFinancialClaim } from './financial-claim-guard.js';
import {
  NO_FAILED_OPERATION_TEXT,
  PendingOperationCoordinator,
  isRetryText,
  renderDisambiguation,
} from './pending-operation-coordinator.js';
import { hasUndoIntent, isExplicitConfirmation } from '../agent-config/tools.js';
import {
  cancelForgetMemory,
  confirmForgetMemory,
  isForgetCancellationText,
  isForgetConfirmationText,
  isForgetRequestText,
  proposeForgetMemory,
} from '../agent-config/memory/forget-proposals.js';
import type { MemorySql } from '../agent-config/memory/store.js';
import { UndoProposalService } from '../mutations/undo-proposal.js';
import { isUndoNegation } from '../mutations/undo-proposal.js';
import { isAutoExecutionEligible } from '../safety/auto-execution.js';
import { unavailableResolution, type DecisionProvider, type DecisionResolution } from '../decision/provider.js';
import {
  isDecisionDefaultOff,
  isDecisionMisconfigured,
  decisionConsultFields,
  decisionProviderErrorResolution,
  resolveContinuationRelation,
  type ContinuationRelationChoice,
} from '../decision/wiring.js';

export type ConversationChannel = 'pwa-rest' | 'sdk' | 'broker';

export type SafeAttachmentMetadata = Readonly<{
  name: string;
  type?: string;
  size?: number;
}>;

export type TurnInput = Readonly<{
  intentionId: string;
  traceId: string;
  text: string;
  actorId: string;
  workspaceId: string;
  role: 'owner' | 'member';
  deviceId: string | null;
  attachments: readonly SafeAttachmentMetadata[];
  channel: ConversationChannel;
  pendingOperationIds?: readonly string[];
  /**
   * F1 (BLOCKER): the text the HUMAN TYPED, before any attachment-derived data
   * was composed into `text`.
   *
   * The DECISION modes (`confirmation`, `cancel`) and the conversational retry
   * read THIS field only — a PDF/statement that says "sim confirmo" is DATA and
   * can never decide. It is constructed by `normalize` from an explicit
   * server-side argument and NEVER from the request body, so a client-supplied
   * same-named field is ignored exactly like `internalCorrection`. Absent means
   * "the turn text IS the typed text", i.e. every channel without attachment
   * data — unchanged behaviour.
   */
  decisionText?: string;
  /**
   * FIX-AGENT-RELAY-FAILOVER-HARDENING (A): internal-only marker for the
   * structured grounding-correction retry. Set EXCLUSIVELY by the internal
   * `correctionProvider` (channel-evidence.ts); `normalize` always builds it
   * as `false` and ignores any client-supplied same-named field, so user
   * text that literally contains the correction marker can never confer
   * internal status (it persists as a normal user turn).
   */
  internalCorrection?: boolean;
}>;

export type PlannedOperation = Readonly<{ name: string; kind: 'read' | 'mutation' }>;
export type TurnPlan = Readonly<{
  version: '2';
  mode: 'read' | 'mutation-proposal' | 'confirmation' | 'cancel' | 'advice' | 'conversation' | 'unsupported';
  domain: 'accounts' | 'transactions' | 'cards' | 'payables' | 'budgets' | 'goals' | 'categories' | 'memory' | 'web' | 'general';
  skillNames: readonly string[];
  requestedOperations: readonly PlannedOperation[];
  missingFields: readonly string[];
  ambiguity: string | null;
  confidence: number;
}>;

export type MutationPolicy = Readonly<{
  capability: 'financial.read';
  writeAuthorized: false;
  approvalRequired: true;
  authorizationMode: 'none' | 'clarify' | 'auto' | 'manual';
  authorizationReason?: string;
  risk?: 'low' | 'medium' | 'high' | 'destructive';
}>;

/**
 * A04/R04 — subject used by the deterministic read-absence copy, scoped to the
 * turn's own domain. The read that proved the absence is never widened to
 * another scope, and a global "workspace vazio" is never asserted (A09).
 */
const READ_ABSENCE_SUBJECT: Readonly<Record<string, string>> = {
  accounts: 'contas',
  transactions: 'lançamentos',
  categories: 'categorias',
};

/**
 * R10/AC20 — the honest reply when the shared per-turn recovery budget refuses
 * another entity-resolution attempt. Same shape as
 * `INVALID_PLAN_CLARIFICATION` (turn-plan.ts): it names the limit, never
 * claims success, and asks the user instead of re-reading the same lists.
 */
const RESOLUTION_BUDGET_CLARIFICATION =
  'Não consegui concluir a resolução com segurança dentro do limite do turno. Esclareça os dados, por favor.';

/**
 * A07/RR — the honest copy for a turn whose value cannot become a correction
 * deterministically (an alternative, or a write that lost its race). It names
 * the missing field and asks for it; it never claims a value was applied.
 */
const CORRECTION_REFUSAL_TEXT = 'Não consegui aplicar o valor novo com segurança. Informe o valor correto.';

/**
 * A07/RR (review fix 4) — a date fragment that names more than one relative
 * date reuses the A06 copy verbatim (one wording per ambiguity). A NEGATED
 * date fragment gets its own sentence: "não foi ontem" is not a conflicting
 * date, it is a denied one, and the A06 negation copy (which cancels the whole
 * intention) would be a stronger claim than the turn supports.
 */
const DENIED_DATE_TEXT = 'Não identifiquei a data com segurança. Informe a data do lançamento.';

/**
 * A07/RR (review fix 1) — the honest copy when the draft could not be written
 * even after the single deterministic retry. The intention survives; only this
 * turn's write is refused.
 */
const DRAFT_WRITE_CONTENTION_TEXT =
  'Não consegui atualizar o lançamento com segurança. Confirme os dados para eu tentar de novo.';

export type TurnResult = Readonly<{
  input: TurnInput;
  plan: TurnPlan;
  policy: MutationPolicy;
  mutation?: Readonly<{
    operationId: string;
    status: 'proposed' | 'succeeded';
    /**
     * T3.4 (SPEC §16): safe card projection derived from the canonical
     * args that were proposed. Optional so legacy/draft paths without
     * resolved labels still produce a valid turn (PWA degrades gracefully).
     */
    presentation?: PendingOperationPresentation;
    /**
     * T3.3 (SPEC §15.1): the REAL execution receipt emitted by the API on
     * TX2 success. Present only on `succeeded` — the PWA reconciles from
     * it instead of the documented mutationKind fallback. Never derived
     * from the LLM, never carries attestation material.
     */
    receipt?: MutationReceipt;
  }>;
  /**
   * T3.1 (SPEC §14): set on the deterministic fail-closed read reply
   * (evidence null/timeout/all-error). The LLM was never consulted for this
   * turn — adapters use this to persist the user message, which otherwise
   * only happens inside the response provider.
   */
  failClosed?: boolean;
  /** Explicit clarification outcome (SPEC §7.8-ready): no proposal exists. */
  clarification?: Readonly<{
    missingFields: readonly string[];
    text: string;
    /** Browser-safe draft payload (ADR-014): never authority/attestation. */
    draft?: MutationDraftChannelMessage;
  }>;
  response?: Readonly<{ text: string }>;
  /**
   * debt-undo-confirmation-protocol: separate undo proposal relayed to the
   * PWA (requestId for the authenticated decision RPC). Never a V2
   * mutation, never authority material — the fixed target stays server-side.
   */
  undoProposal?: Readonly<{
    requestId: string;
    status: 'proposed';
    expiresAt: string;
  }>;
}>;
export type TurnResponseProvider = (input: TurnInput, plan: TurnPlan) => Promise<string>;
export type AuthenticatedIdentity = Readonly<{
  actorId: string;
  workspaceId: string;
  role: 'owner' | 'member';
  deviceId?: string | null;
}>;

type Body = { text?: unknown; content?: unknown; intentionId?: unknown; messageId?: unknown; traceId?: unknown; attachments?: unknown; pendingOperationIds?: unknown; [key: string]: unknown };

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
};

// SPEC R03: a bare answer to the category clarification ("categoria Carne
// Bovina") states a category explicitly but carries no amount, so it is not a
// parsable mutation and `parseFinancialMutation` returns `kind: 'none'`.
// Mirrors the parser's category phrasing (the trailing "?" is a question mark,
// not part of the name) so the answer can complete a draft that is pending
// only the category.
const CATEGORY_PHRASE = /\b(?:categoria|categoria de)\s+([^,.;?]+)/i;

// A07/AC14 — the CONTINUATION FRAGMENT. "de carne" answers a pending
// category, because the phrase ("de carne") is the tail of the original
// utterance and the draft already carries the rest. It is only ever consulted
// through `categoryQueryFrom(text, { allowBareFragment })`, which the caller
// enables EXCLUSIVELY for an active draft whose turn is not a candidate
// interpretation. A description therefore still never becomes a category on
// its own (R03/A03): the flag is structurally unavailable on the fresh path.
const CATEGORY_FRAGMENT = /^\s*(?:e\s+)?de\s+([^,.;?]+?)\s*$/iu;
// A fragment is a name, not a sentence: no digits, bounded length. Anything
// else is not a category name and must fall back to the ordinary question.
const CATEGORY_FRAGMENT_MAX = 40;

const categoryQueryFrom = (
  text: string,
  options: Readonly<{ allowBareFragment?: boolean }> = {},
): { query: string; fromFragment: boolean } | undefined => {
  const explicit = CATEGORY_PHRASE.exec(text)?.[1]?.trim();
  if (explicit) return explicit ? { query: explicit, fromFragment: false } : undefined;
  if (!options.allowBareFragment) return undefined;
  const fragment = CATEGORY_FRAGMENT.exec(text)?.[1]?.trim();
  if (!fragment || fragment.length > CATEGORY_FRAGMENT_MAX || /\d/.test(fragment)) return undefined;
  return { query: fragment, fromFragment: true };
};

/**
 * A07/AC15 — a VALUE CORRECTION against an active draft. Only two shapes are
 * accepted, both anchored at the start of the turn so a full utterance can
 * never be mistaken for a correction:
 *   "não, 500" / "não é 500" / "não, foi 500"  (negation + value)
 *   "500 em vez de 50"                         (value + "em vez")
 * A negation WITHOUT a value keeps its existing fail-closed clarification
 * (R06/AC13): the user may be retracting the whole intention.
 *
 * A07/RR (review fix 2) — the shape is no longer enough to be a correction.
 * The value must be read as ONE whole token and must be unambiguous, otherwise
 * the turn is an honest clarification and the draft keeps its stored amount:
 *   - the token must consume the WHOLE number the user wrote. `50,123` is
 *     matched by the literal as `50,12`; a pt-BR thousand (`50.123`) is not a
 *     truncated decimal, so the two can never be told apart by guessing
 *     (`ambiguous_separator` — the A06 copy, reused verbatim);
 *   - a non-BRL currency is never converted (`unsupported_currency`);
 *   - "500 ou 50" offers two values and never picks one silently.
 */
const CORRECTION_VALUE = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:[.,]\d{1,2})?)`;
/**
 * The two shapes, each with what may follow the value token: the negation
 * shape is closed (a correction IS the value — anything else qualifies it),
 * while the "em vez" shape already consumed its own tail and is followed by
 * the SUPERSEDED value ("500 em vez de 50"), which is not a qualifier.
 */
const CORRECTION_PATTERNS: readonly Readonly<{ pattern: RegExp; openTail: boolean }>[] = [
  {
    pattern: new RegExp(
      String.raw`^\s*((?:n[aã]o|nunca)\s*,?\s*(?:(?:e|é|era)\s+)?(?:foi\s+)?(?:r\$\s*)?)(${CORRECTION_VALUE})`,
      'iu',
    ),
    openTail: false,
  },
  {
    pattern: new RegExp(
      String.raw`^\s*((?:r\$\s*)?)(${CORRECTION_VALUE})\s*(?:reais|reals?|rs\.?)?\s+em\s+vez\b`,
      'iu',
    ),
    openTail: true,
  },
];
/** The numeric run exactly as typed; a trailing `.`/`,` is punctuation, not part of it. */
const TYPED_NUMBER_RUN = /^\d[\d.,]*/;
const DISJUNCTIVE_ALTERNATIVE = /\bou\b/iu;
/** The ONLY unit a pt-BR correction may carry; anything else is a foreign currency. */
const BRL_UNIT = /^(?:reais?|rs\.?)\b/iu;
const LETTER = /\p{L}/u;

/**
 * A07/R07 — the negation MARKER (not the negation decision): it classifies a
 * turn that did not become a value correction as a relation label. A16/R15 also
 * reports it to the optional judge as a structural FACT (`negationMarker`), so
 * the heuristic's own signal is visible to it without the text ever leaving.
 */
const NEGATION_MARKER = /\b(?:n[aã]o|nunca|jamais)\b/iu;

type CorrectionOutcome =
  | Readonly<{ kind: 'amount'; amountCents: number }>
  | Readonly<{ kind: 'ambiguous'; clarification: string }>
  | Readonly<{ kind: 'none' }>;

const correctionOutcome = (text: string): CorrectionOutcome => {
  for (const { pattern, openTail } of CORRECTION_PATTERNS) {
    const match = pattern.exec(text);
    const token = match?.[2];
    if (!match || token === undefined) continue;
    const tail = text.slice(match.index + match[0].length);
    const currencyRefusal = ambiguityClarificationText('unsupported_currency');
    // The A06 currency detector decides this, never a private currency list:
    // "500 dólares" is 500 UNKNOWN reais, which is not a correction.
    if (hasUnsupportedCurrency(text)) return { kind: 'ambiguous', clarification: currencyRefusal };
    // The literal must consume the whole number: a truncated match means the
    // user wrote a shape this parser cannot read with certainty.
    const typed = (TYPED_NUMBER_RUN.exec(text.slice(match[1]!.length))?.[0] ?? '').replace(/[.,]+$/, '');
    if (typed !== token) {
      return { kind: 'ambiguous', clarification: ambiguityClarificationText('ambiguous_separator') };
    }
    // An alternative ("500 ou 50") is a question, not a value.
    if (DISJUNCTIVE_ALTERNATIVE.test(tail)) {
      return { kind: 'ambiguous', clarification: CORRECTION_REFUSAL_TEXT };
    }
    // Any other unit qualifies the value and is never converted or assumed to
    // be BRL — including spellings A06's table does not carry (`dollars`).
    const qualifier = tail.trimStart();
    if (!openTail && LETTER.test(qualifier) && !BRL_UNIT.test(qualifier)) {
      return { kind: 'ambiguous', clarification: currencyRefusal };
    }
    try {
      const cents = parseMoneyToCents(token);
      if (Number.isInteger(cents) && cents > 0) return { kind: 'amount', amountCents: cents };
    } catch {
      // Not a parseable literal for this parser; try the next shape.
    }
  }
  return { kind: 'none' };
};

/**
 * Internal-only construction options. They are passed by the SERVER adapter, not
 * read from `body`: a client-supplied `decisionText`/`typedText` is ignored.
 */
export type NormalizeOptions = Readonly<{ typedText?: string }>;

const normalize = (
  body: Body,
  identity: AuthenticatedIdentity,
  channel: ConversationChannel,
  options?: NormalizeOptions,
): TurnInput => {
  const textValue = typeof body.text === 'string' ? body.text : typeof body.content === 'string' ? body.content : '';
  const text = scrubForPersistence(textValue.trim());
  if (!text) throw new Error('agent.invalid_message');
  // SPEC §7.7/§7.7.1: the intentionId derives deterministically from the
  // PWA messageId (sent as intentionId, or as messageId alias). No
  // Date.now()/random fallback: a lost response is redelivered with the same
  // id, so retry can only ever dedup to the same proposal.
  const rawIntention = typeof body.intentionId === 'string' && body.intentionId.trim()
    ? body.intentionId.trim()
    : typeof body.messageId === 'string' && body.messageId.trim() ? body.messageId.trim() : '';
  if (!rawIntention) throw new Error('agent.invalid_message');
  const intentionId = rawIntention;
  const traceId = typeof body.traceId === 'string' && body.traceId.trim() ? body.traceId.trim() : intentionId;
  if (intentionId.length > 128 || traceId.length > 128) throw new Error('agent.invalid_message');
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((item): item is SafeAttachmentMetadata => !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')
      .map((item) => freeze({ name: item.name, ...(typeof item.type === 'string' ? { type: item.type } : {}), ...(typeof item.size === 'number' ? { size: item.size } : {}) }))
    : [];
  const pendingOperationIds = Array.isArray(body.pendingOperationIds)
    ? body.pendingOperationIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
    : undefined;
  // F1: the DECISION text is the text the human typed. It comes from the
  // server-side `typedText` option and is NEVER read from `body`, so a client
  // that sends its own `decisionText`/`typedText` changes nothing.
  const typedText = typeof options?.typedText === 'string' ? scrubForPersistence(options.typedText.trim()) : text;
  const decisionText = typedText === text ? undefined : typedText;
  return freeze({
    intentionId,
    traceId,
    text,
    actorId: identity.actorId,
    workspaceId: identity.workspaceId,
    role: identity.role,
    deviceId: identity.deviceId ?? null,
    attachments: freeze(attachments),
    channel,
    ...(decisionText !== undefined ? { decisionText } : {}),
    // FIX-AGENT-RELAY-FAILOVER-HARDENING (A): the internal correction flag
    // is constructed here as `false` — any client-supplied `internalCorrection`
    // / `isInternalCorrectionRetry` field in `body` is deliberately NOT read,
    // so untrusted text can never mark its own turn as an internal retry.
    internalCorrection: false,
    ...(pendingOperationIds ? { pendingOperationIds: freeze(pendingOperationIds) } : {}),
  });
};

export const normalizeRestTurn = (body: Body, identity: AuthenticatedIdentity, options?: NormalizeOptions): TurnInput => normalize(body, identity, 'pwa-rest', options);
export const normalizeSdkTurn = (body: Body, identity: AuthenticatedIdentity, options?: NormalizeOptions): TurnInput => normalize(body, identity, 'sdk', options);
export const normalizeBrokerTurn = (body: Body, identity: AuthenticatedIdentity, options?: NormalizeOptions): TurnInput => normalize(body, identity, 'broker', options);

export class ConversationOrchestrator {
  constructor(private readonly dependencies: {
    plan?: (input: TurnInput) => TurnPlan;
    mutationApiClient?: MutationApiClient;
    autoExecutionClient?: () => MutationApiClient | undefined;
    /**
     * T1.5 unified decision machine (SPEC §8). Injected by tests or the
     * channel adapter; otherwise built per turn from the mutation client
     * (+ draft store when configured).
     */
    coordinator?: PendingOperationCoordinator;
    /** Authoritative entity lists (accounts/categories). Absent = fail closed. */
    entityReader?: EntityReader;
    /**
     * Issue #86 — the DO-scoped `DecisionProvider` accessor (default-off).
     * Absent = no provider is consulted at all. The injected accessor must return
     * the SAME instance per Durable Object (breaker and the 1-call-per-turn cap
     * live in it); the wiring never instantiates a provider of its own and
     * never creates one per turn. The orchestrator does not know WHICH provider
     * it gets — Jev, Clef or a local one are interchangeable here.
     */
    decisionProvider?: () => DecisionProvider | undefined;
    responseProvider?: TurnResponseProvider;
    /** Read-path evidence source (EvidenceCollector). Absent = legacy pass-through. */
    evidenceProvider?: (input: TurnInput, plan: TurnPlan) => Promise<EvidenceEnvelope | null>;
    /** ONE structured correction retry for unsupported grounded claims. */
    correctionProvider?: (input: TurnInput, plan: TurnPlan, unsupportedClaims: readonly string[]) => Promise<string | null>;
    /** Sanitized lifecycle event sink (defaults to emitSanitizedEvent). */
    events?: (eventType: string, fields: Record<string, unknown>) => void;
    /**
     * R10 (AC20): per-turn shared recovery budget. Absent = a fresh TurnBudget
     * per turn; injected so tests can pre-spend or observe the shared ceiling.
     */
    turnBudgetFactory?: () => TurnBudget;
    /**
     * Multi-turn draft persistence (SPEC §7.8, ADR-014). Absent = legacy
     * single-turn behavior (incomplete args clarify without persistence).
     * Lives in DO storage of the conversation — never PWA, never API.
     */
    draftStore?: MutationDraftStore;
    /** Draft TTL override (default ~15 min). */
    draftTtlMs?: number;
    /** Clock override (tests). */
    draftNow?: () => number;
    /** Bounded propose attempts per handoff (default 2, same key always). */
    draftMaxProposeAttempts?: number;
    /**
     * debt-undo-confirmation-protocol: separate undo proposal service deps.
     * Absent = undo requests degrade to a deterministic no-proposal reply
     * (never execution). The preview fixes the target at proposal time;
     * the api is only used by the RPC decision path (tests may inject a
     * spy to prove free text never executes).
     */
    undoProposals?: {
      store: import('../mutations/undo-proposal.js').SqlUndoProposalStore;
      preview: import('../mutations/undo-proposal.js').UndoPreview;
      api?: import('../mutations/undo-proposal.js').UndoApi;
      now?: () => number;
      ttlMs?: number;
    };
    /**
     * Issue #99 — two-step forget determinístico. Superfície SQL da memória
     * (SQLite do DO). Ausente = turnos de forget caem no caminho do tool LLM
     * (propose-only, ainda seguro). Presente = pedido/confirmação/
     * cancelamento decididos aqui, do texto DIGITADO com veto de anexo.
     */
    forgetMemory?: {
      sql: MemorySql;
      now?: () => number;
    };
  } = {}) {}

  private emit(eventType: string, fields: Record<string, unknown>): void {
    try {
      (this.dependencies.events ?? emitSanitizedEvent)(eventType, fields);
    } catch {
      // Observability must never break the turn.
    }
  }

  /**
   * A08/R08: makes the resolution trace OBSERVABLE without leaking it. The
   * trace says which references were invalidated and which confirmed preference
   * this turn overrode; only those reference-KIND names are emitted (never ids,
   * UUIDs or labels), namespaced to this turn so a dead alias is diagnosable
   * from telemetry alone. Silent (no event) when nothing was dropped.
   */
  private emitEntityResolution(
    input: TurnInput,
    plan: TurnPlan,
    trace: EntityResolutionTrace,
  ): void {
    const signals = entityResolutionSignals(trace);
    if (signals.length === 0) return;
    this.emit('mutation.entity_resolution', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      status: 'signalled',
      signals,
    });
  }

  /**
   * R10: the turn's shared recovery budget, keyed by the per-turn result
   * object that every private step already threads through as `base`. This
   * keeps concurrent turns on one orchestrator instance isolated (no shared
   * mutable field) without widening the ~30 `completeTurn` call sites.
   */
  private readonly turnBudgets = new WeakMap<object, TurnBudget>();

  private budgetFor(base: object): TurnBudget {
    const existing = this.turnBudgets.get(base);
    if (existing) return existing;
    const created = this.dependencies.turnBudgetFactory?.() ?? new TurnBudget();
    this.turnBudgets.set(base, created);
    return created;
  }

  /**
   * Numeric-only accounting for the turn (SPEC R10/AC30), emitted ONCE per
   * turn at its terminal point. Counters only: no args, no user text, no
   * technical ids. `clarification` records the deterministic stop of a turn
   * that ended by asking the user, keeping `completed` for a settled read.
   */
  private emitTurnBudget(base: object, clarification = false): void {
    const budget = this.budgetFor(base);
    if (this.emittedBudgets.has(base)) return;
    this.emittedBudgets.add(base);
    if (clarification && budget.snapshot().stop === 'completed') budget.stopWith('clarification_needed');
    this.emit('turn.budget', budget.snapshot() as unknown as Record<string, unknown>);
  }

  /** Idempotency guard so a terminal reached twice never double-counts. */
  private readonly emittedBudgets = new WeakSet<object>();

  /**
   * R10/AC20 — gate for a READ-ONLY entity-resolution attempt. A refusal is a
   * safe stop: the caller must not touch the authoritative lists again, must
   * not throw, and must not fabricate a proposal. Returns the permit so the
   * caller can hand the refusal straight to `stopResolutionRecovery`.
   */
  private permitResolutionRecovery(
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    request: ResolutionRecoveryRequest,
  ): RecoveryPermit {
    return this.budgetFor(base).tryResolutionRecovery(request);
  }

  /**
   * R10/AC20 — the terminal for a refused resolution recovery. Records the
   * refusal reason on the snapshot and asks the user; no re-read, no draft
   * mutation, no proposal, no throw.
   */
  private stopResolutionRecovery(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    refusal: Extract<RecoveryPermit, { allowed: false }>,
    missingFields: readonly string[],
  ): TurnResult {
    this.budgetFor(base).stopWith(refusal.stop);
    // Only `accountId`/`categoryId` can ever be left unresolved by an entity
    // resolution, so this never asserts a field the pipeline does not need.
    const blockedPlan = freeze({ ...plan, missingFields: freeze([...missingFields]) });
    this.emit('mutation.blocked', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'blocked',
      reason: refusal.stop,
    });
    return this.completeTurn(input, blockedPlan, startedAt, base, {
      plan: blockedPlan,
      clarification: freeze({ missingFields: blockedPlan.missingFields, text: RESOLUTION_BUDGET_CLARIFICATION }),
      response: freeze({ text: RESOLUTION_BUDGET_CLARIFICATION }),
    });
  }

  private async authorizeAutoExecution(
    client: MutationApiClient,
    operationId: string,
    identity: MutationIdentity,
  ): Promise<{ kind: 'authorized'; attestation: string } | { kind: 'refused' } | { kind: 'uncertain' }> {
    try {
      const authorization = await client.authorize(operationId, identity);
      return { kind: 'authorized', attestation: authorization.attestation };
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode;
      const code = (error as { code?: unknown })?.code;
      this.emit('approval.autoexecute_blocked', {
        operationId,
        code: typeof code === 'string' ? code : 'authorization_failed',
      });
      if (statusCode === 403 || (
        statusCode === 409 &&
        (code === 'approval.autoexecute_disabled' || code === 'approval.autoexecute_not_eligible')
      )) return { kind: 'refused' };

      try {
        const current = await client.listActive(identity);
        const operation = current.items.find((item) => item.id === operationId);
        return operation?.status === 'proposed' ? { kind: 'refused' } : { kind: 'uncertain' };
      } catch {
        return { kind: 'uncertain' };
      }
    }
  }

  private renderDeterministicFromEvidence(input: TurnInput, plan: TurnPlan, envelope: EvidenceEnvelope): string | null {
    // W1-TED-ACCOUNT-GROUNDING: account balances render through the
    // kind-aware grounding (nominal selection, no heterogeneous sums, no
    // name-inferred types, explicit partiality). It returns null for
    // non-balance queries, which stay with the legacy renderers below.
    const accountsAnswer = renderAccountsAnswer(input.text, extractAccountsEvidence(envelope));
    if (accountsAnswer !== null) return accountsAnswer;
    const ok = envelope.items.filter((item) => item.status === 'ok').map((item) => item.data);
    if (ok.length === 0) {
      // A04/R04: a typed read absence is answered deterministically and names
      // the reason — an empty query is not a failure and not a zero. Gated on a
      // typed reason (and on NO failed read, see `runGroundedRead`), so a read
      // without a proven reason keeps its previous grounded path.
      const absence = envelope.items.find((item) => item.status === 'empty' && item.reason !== undefined);
      if (absence && absence.status === 'empty' && absence.reason !== undefined) {
        return renderReadAbsence(absence.reason, READ_ABSENCE_SUBJECT[plan.domain] ?? 'dados');
      }
      return null;
    }
    const lists = ok.filter(Array.isArray);
    if (plan.domain === 'transactions' || lists.length > 0) {
      for (const list of lists) {
        const rendered = renderStatement(list as readonly unknown[], 'extrato');
        if (rendered !== renderEmpty('extrato')) return rendered;
      }
      // A04/R04: "sem dados" is only honest when every usable item is an EMPTY
      // list. An `ok` record (e.g. a month summary with `totalCents = 0` but
      // `transactionCount > 0`) carries data: claiming absence here is exactly
      // the "zero ≠ sem lançamentos" confound, so it goes to the grounded path.
      const hasInformativeRecord = ok.some((data) => !Array.isArray(data));
      if (plan.domain === 'transactions' && !hasInformativeRecord) return renderEmpty('extrato');
    }
    // A balance-seeking turn with no usable account evidence must never
    // fall through to the generative provider (which could invent a
    // figure): fail closed with a figure-free reply.
    if (seeksAccountBalance(input.text)) return renderUnavailable('os saldos');
    return null;
  }

  /** Read path: deterministic render when evidence allows, else grounded provider text with ONE retry. */
  private async runGroundedRead(input: TurnInput, plan: TurnPlan, startedAt: number, base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy }): Promise<TurnResult> {
    // T3.1 fail-closed (SPEC §14 H-06): a finance-seeking turn with no
    // evidence (null, provider throw/timeout) or all-error evidence gets the
    // deterministic failure WITHOUT calling the LLM. Empty ≠ Error: `empty`
    // items still flow to the grounded path below.
    let envelope: EvidenceEnvelope | null;
    try {
      envelope = await this.dependencies.evidenceProvider!(input, plan);
    } catch {
      envelope = null;
    }
    // A04/R04 (AC10): a FAILED read blocks any conclusive "nothing there"
    // reading, so an envelope with a failure and NO usable evidence also fails
    // closed — a forbidden/unavailable read must never be narrated as zero.
    const usable = envelope?.items.some((item) => item.status === 'ok') ?? false;
    const failed = envelope?.items.some((item) => item.status === 'error') ?? false;
    if (!envelope || envelope.items.length === 0 || (!usable && failed)) {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: false, latencyMs: Date.now() - startedAt });
      return freeze({ ...base, failClosed: true as const, response: freeze({ text: FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT }) });
    }
    const deterministic = this.renderDeterministicFromEvidence(input, plan, envelope);
    if (deterministic !== null) {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: deterministic }) });
    }
    if (!this.dependencies.responseProvider) {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: renderUnavailable(plan.domain) }) });
    }
    // Provider failures are operational, never a fabricated success.
    const text = await this.dependencies.responseProvider(input, plan);
    const grounded = await createGroundedResponseWithRetry(text, envelope, {
      fallbackSubject: plan.domain,
      ...(this.dependencies.correctionProvider ? { retry: (claims) => this.dependencies.correctionProvider!(input, plan, claims) } : {}),
      sink: (eventType, fields) => this.emit(eventType, fields),
      intentionId: input.intentionId,
      traceId: input.traceId,
      // R10: the ONE correction retry spends a slot of the shared per-turn
      // recovery budget. The hook fires only when the retry actually runs.
      onRecoveryAttempted: () => { this.budgetFor(base).noteGroundingRetry(); },
    });
    this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: grounded.grounded, latencyMs: Date.now() - startedAt });
    return freeze({ ...base, response: freeze({ text: grounded.text }) });
  }

  // --- MutationDraft multi-turno (SPEC §7.8, ADR-014) ---

  private draftContext(input: TurnInput): DraftContext {
    return {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      deviceId: input.deviceId ?? null,
    };
  }

  /** T1.5: the single decision machine for this turn (injected or derived). */
  private coordinatorFor(client: MutationApiClient): PendingOperationCoordinator {
    const injected = this.dependencies.coordinator;
    if (injected) return injected;
    const store = this.dependencies.draftStore;
    return new PendingOperationCoordinator({
      client,
      ...(store ? { draftStore: store } : {}),
      ...(this.dependencies.draftNow ? { now: this.dependencies.draftNow } : {}),
    });
  }

  private draftNowMs(): number {
    return this.dependencies.draftNow?.() ?? Date.now();
  }

  /**
   * A07/AC14 — interprets a mutation utterance against THIS turn's clock, so
   * "hoje"/"ontem" resolve from the same instant in the fresh path and in a
   * continuation. Without it the fresh path would read the wall clock while a
   * continuation read the injected one, and the same turn could date a draft
   * two different ways. In production `draftNowMs()` IS `Date.now()`, so the
   * resolved dates are unchanged.
   */
  private interpretTurn(text: string): SemanticInterpretation {
    return interpretMutationUtterance(text, { now: new Date(this.draftNowMs()) });
  }

  private hasRecoverableDraft(input: TurnInput): boolean {
    const store = this.dependencies.draftStore;
    if (!store) return false;
    const ctx = this.draftContext(input);
    const now = this.draftNowMs();
    return (
      store.listActive(ctx, now).length > 0 || store.listProposing(ctx, now).length > 0
    );
  }

  /**
   * Any draft state this turn must converge instead of taking the legacy
   * path: active/proposing drafts, or a redelivered turn (§7.7 resend after
   * consumption must reuse the existing proposal, never fall through).
   */
  private hasDraftForTurn(input: TurnInput): boolean {
    const store = this.dependencies.draftStore;
    if (!store) return false;
    if (this.hasRecoverableDraft(input)) return true;
    return store.findByIntention(this.draftContext(input), input.intentionId) !== undefined;
  }

  private entityReaderOrClosed(): EntityReader {
    return (
      this.dependencies.entityReader ?? {
        listAccounts: async (): Promise<never> => {
          throw new Error('agent.entity_reader_missing');
        },
        listCategories: async (): Promise<never> => {
          throw new Error('agent.entity_reader_missing');
        },
      }
    );
  }

  private completeTurn(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    extra: Partial<TurnResult> & { plan?: TurnPlan },
  ): TurnResult {
    this.emit('turn.completed', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'completed',
      latencyMs: Date.now() - startedAt,
    });
    // R10: `completeTurn` is the terminal every private step converges on, so
    // the shared per-turn recovery snapshot is emitted exactly once here.
    this.emitTurnBudget(base, 'clarification' in extra && !!extra.clarification);
    return freeze({ ...base, ...(extra.plan ? { plan: freeze(extra.plan) } : {}), ...(extra.policy ? { policy: freeze(extra.policy) } : {}), ...('mutation' in extra && extra.mutation ? { mutation: freeze(extra.mutation) } : {}), ...('clarification' in extra && extra.clarification ? { clarification: freeze(extra.clarification) } : {}), ...('response' in extra && extra.response ? { response: freeze(extra.response) } : {}) });
  }

  private clarifyDraft(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    draft: MutationDraftRecord,
    question: string,
  ): TurnResult {
    const incompletePlan = freeze({ ...plan, missingFields: freeze([...draft.missingFields]) });
    const clarification = freeze({
      missingFields: incompletePlan.missingFields,
      text: question,
      draft: toChannelMessage(draft, question),
    });
    this.emit('mutation.blocked', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'blocked',
    });
    return this.completeTurn(input, incompletePlan, startedAt, base, {
      plan: incompletePlan,
      clarification,
      response: freeze({ text: question }),
    });
  }

  /** New intention that must never inherit draft fields (SPEC §7.8). */
  private isReplacement(
    text: string,
    draft: MutationDraftRecord,
  ): boolean {
    if (isResetText(text)) return true;
    // R06/A06: an ambiguous or clipped-but-unparsable utterance is not a new
    // intention; it never inherits fields from the active draft.
    const interpretation = this.interpretTurn(text);
    if (interpretation.status !== 'candidate') return false;
    const parsed = interpretation.parsed;
    return (
      parsed.kind !== draft.resolvedArgs.kind || parsed.amountCents !== draft.resolvedArgs.amountCents
    );
  }

  /**
   * R06/A06: the deterministic stop for an ambiguous mutation utterance
   * (AC13). Never proposes, never rounds, never registers: it only names the
   * fields that make the request answerable.
   */
  private ambiguousClarification(
    interpretation: Readonly<{ missingFields: readonly string[]; clarification: string }>,
  ): Readonly<{ missingFields: readonly string[]; text: string }> {
    return freeze({ missingFields: freeze([...interpretation.missingFields]), text: interpretation.clarification });
  }

  /**
   * R06/A06 (AC13), review fix 1/2: an ambiguous utterance that carries a
   * MUTATION INTENT signal is never answerable as anything else — not a read,
   * not a draft continuation, not a proposal. Returns the clarification to
   * answer with, or null when the turn is not ambiguous.
   *
   * The intent signal is required on purpose: "uns 80" alone is not a mutation
   * (inventing the intent is exactly what R06 forbids), while "gastei uns 80 no
   * mercado" is one and must therefore be asked about.
   */
  private ambiguousMutationClarification(text: string): Readonly<{ missingFields: readonly string[]; text: string }> | null {
    if (!hasMutationIntentSignal(text)) return null;
    const interpretation = this.interpretTurn(text);
    return interpretation.status === 'clarify' ? this.ambiguousClarification(interpretation) : null;
  }

  /**
   * The single terminal every ambiguous mutation turn converges on: no
   * authoritative read, no provider, no proposal, no draft write. It runs
   * BEFORE the draft continuation/recovery, so an active draft survives the
   * turn untouched and no recovery slot is spent.
   */
  private stopAmbiguousMutation(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    clarification: Readonly<{ missingFields: readonly string[]; text: string }>,
  ): TurnResult {
    const blockedPlan = freeze({ ...plan, missingFields: freeze([...clarification.missingFields]) });
    this.emit('mutation.blocked', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'blocked',
      reason: 'ambiguous_mutation_intent',
    });
    return this.completeTurn(input, blockedPlan, startedAt, base, {
      plan: blockedPlan,
      clarification: freeze({ missingFields: blockedPlan.missingFields, text: clarification.text }),
      response: freeze({ text: clarification.text }),
    });
  }

  private toolForKind(kind: 'expense' | 'income'): 'transactions.expense.create' | 'transactions.income.create' {
    return kind === 'income' ? 'transactions.income.create' : 'transactions.expense.create';
  }

  /**
   * T3.4 (SPEC §16, INV-02): builds the turn's proposed-mutation payload
   * with the safe card presentation derived from the canonical args that
   * were just proposed (labels from the entity-resolver output — zero new
   * reads, zero new transport). `expiresAt` comes from the created
   * operation; when unavailable (redelivery convergence paths) the payload
   * stays in the legacy summary shape and the PWA degrades gracefully.
   */
  private proposedMutation(input: {
    operationId: string;
    tool: string;
    normalizedArgs: { amountCents: number; description: string; date: string; accountId: string; categoryId: string };
    accountName?: string;
    categoryName?: string;
    expiresAt?: string;
  }): NonNullable<TurnResult['mutation']> {
    const base = { operationId: input.operationId, status: 'proposed' as const };
    if (!input.expiresAt) return freeze(base);
    const presentation = buildApprovalPresentation({
      operationId: input.operationId,
      status: 'proposed',
      tool: input.tool,
      normalizedArgs: input.normalizedArgs,
      expiresAt: input.expiresAt,
      ...(input.accountName ? { accountLabel: input.accountName } : {}),
      ...(input.categoryName ? { categoryLabel: input.categoryName } : {}),
    });
    if (!presentation) return freeze(base);
    return freeze({ ...base, presentation });
  }

  /**
   * Single propose attempt + outcome handling (handoff protocol §7.8):
   * created/existing → consumed; definitive 4xx → discarded; anything else
   * → stays proposing with an inconclusive reply (never success/cancelled).
   */
  private async executePropose(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    draft: MutationDraftRecord,
    client: MutationApiClient,
  ): Promise<TurnResult> {
    const store = this.dependencies.draftStore!;
    const maxAttempts = this.dependencies.draftMaxProposeAttempts ?? DEFAULT_MAX_PROPOSE_ATTEMPTS;
    const args = draft.resolvedArgs;
    const identity: MutationIdentity = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
    };
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
      try {
        const normalizedArgs = {
          amountCents: args.amountCents,
          description: args.description,
          date: args.date,
          accountId: args.accountId!,
          categoryId: args.categoryId!,
        };
        // R10 (AC30): account the attempt the moment it leaves — every
        // iteration of the ≤2 propose attempts counts, and this axis never
        // spends the shared recovery budget (ADR-014 owns its own ceiling).
        this.budgetFor(base).noteProposeAttempt();
        const proposal = await client.propose({
          tool: draft.tool,
          normalizedArgs,
          summary: args.description,
          identity,
          idempotencyKey: draft.proposalIdempotencyKey,
        });
        store.update(draft.draftId, {
          status: 'consumed',
          proposalId: proposal.id,
          proposeOutcome: proposal.existing ? 'existing' : 'created',
          updatedAt: new Date(this.draftNowMs()).toISOString(),
          lastIntentionId: input.intentionId,
        });
        return this.completeTurn(input, plan, startedAt, base, {
          mutation: this.proposedMutation({
            operationId: proposal.id,
            tool: draft.tool,
            normalizedArgs,
            ...(args.accountName ? { accountName: args.accountName } : {}),
            ...(args.categoryName ? { categoryName: args.categoryName } : {}),
            expiresAt: proposal.operation.expiresAt,
          }),
          response: freeze({ text: renderMutationResult('proposed', proposal.summary) }),
        });
      } catch (error) {
        if (isDefinitiveProposeError(error)) {
          // Case C: definitive rejection — no operation was created.
          store.update(draft.draftId, {
            status: 'discarded',
            discardReason: 'propose_rejected',
            proposeOutcome: 'rejected',
            updatedAt: new Date(this.draftNowMs()).toISOString(),
            lastIntentionId: input.intentionId,
          });
          this.emit('mutation.blocked', {
            intentionId: input.intentionId,
            traceId: input.traceId,
            channel: input.channel,
            domain: plan.domain,
            mode: plan.mode,
            status: 'blocked',
          });
          return this.completeTurn(input, plan, startedAt, base, {
            response: freeze({ text: renderMutationResult('failed') }),
          });
        }
        if (attempt >= Math.max(1, maxAttempts)) {
          // Outcome unknown: stays proposing, retry later with the SAME key.
          store.update(draft.draftId, {
            proposeOutcome: 'unknown',
            updatedAt: new Date(this.draftNowMs()).toISOString(),
            lastIntentionId: input.intentionId,
          });
          this.emit('mutation.blocked', {
            intentionId: input.intentionId,
            traceId: input.traceId,
            channel: input.channel,
            domain: plan.domain,
            mode: plan.mode,
            status: 'blocked',
          });
          return this.completeTurn(input, plan, startedAt, base, {
            response: freeze({ text: renderInconclusive() }),
          });
        }
      }
    }
    return this.completeTurn(input, plan, startedAt, base, {
      response: freeze({ text: renderInconclusive() }),
    });
  }

  /**
   * CAS loser path (deterministic, never proposes): consumed → reuse the
   * existing proposal; proposing → inconclusive; otherwise the intention is
   * over and the user is told to describe it again.
   */
  private handleCasLoss(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    current: MutationDraftRecord | undefined,
  ): TurnResult {
    if (current?.status === 'consumed' && current.proposalId) {
      return this.completeTurn(input, plan, startedAt, base, {
        mutation: freeze({ operationId: current.proposalId, status: 'proposed' }),
        response: freeze({ text: renderMutationResult('proposed', current.resolvedArgs.description) }),
      });
    }
    if (current?.status === 'proposing') {
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: renderInconclusive() }),
      });
    }
    const text = 'A intenção anterior foi encerrada. Descreva novamente o lançamento.';
    const closedPlan = freeze({ ...plan, missingFields: freeze(['intent']) });
    return this.completeTurn(input, closedPlan, startedAt, base, {
      plan: closedPlan,
      clarification: freeze({ missingFields: closedPlan.missingFields, text }),
      response: freeze({ text }),
    });
  }

  /**
   * A07/R07 — the per-field provenance snapshot carried by a draft. Reuses the
   * A06 `FieldProvenance` objects verbatim (no second provenance shape) and
   * drops `accountHint`, which is a resolver hint rather than a draft field.
   */
  private draftProvenance(interpretation: SemanticInterpretation): DraftFieldProvenance | undefined {
    if (interpretation.status !== 'candidate') return undefined;
    const { kind, amountCents, description, date, categoryQuery } = interpretation.provenance;
    return {
      kind,
      amountCents,
      description,
      date,
      ...(categoryQuery ? { categoryQuery } : {}),
    };
  }

  /**
   * A07/AC16 — the additive goal metadata every continuation write carries:
   * the turn is recorded as an origin of the SAME goal (bounded), and the
   * derived `draft_relation` is appended (bounded, at most once per kind).
   * Pure metadata: it changes no identity, no propose key and no eligibility.
   */
  private turnMetadata(
    input: TurnInput,
    draft: MutationDraftRecord,
    relation: DraftRelation,
  ): Pick<import('../mutations/mutation-draft.js').DraftRecordPatch, 'originMessages' | 'relations'> {
    return {
      originMessages: appendOriginMessage(draft.originMessages, input.intentionId),
      relations: appendDraftRelation(draft.relations, relation),
    };
  }

  /**
   * A07/R07 — the relation derived for a turn that neither corrected nor
   * completed the draft. A negation that did NOT become a value correction
   * keeps its R06/AC13 fail-closed behaviour untouched; the relation only
   * records that the draft survived it.
   *
   * A16/R15 — THIS is the bounded ambiguity wired to the optional judge
   * (default-off): "negação" vs "continuação" is a BEHAVIOURAL classification,
   * so the request to the judge carries only structural facts — never the user
   * text, amount, date, description, category or account id. The deterministic
   * relation stays authoritative in EVERY path, including when the judge answers
   * the opposite: a decision only changes the reported `source`.
   *
   * It runs AFTER the guarded value-correction write on purpose: that write is
   * revision-guarded, and no optional consultation may open a window before a
   * financial field is written. A correction turn never reaches this method —
   * its relation is already determined (`correction`).
   */
  private continuationRelation(
    input: TurnInput,
    draft: MutationDraftRecord,
  ): DraftRelation | Promise<DraftRelation> {
    const negationMarker = NEGATION_MARKER.test(input.text);
    const deterministic: ContinuationRelationChoice = negationMarker ? 'negation' : 'continuation';
    // F6: the heuristic relation is SYNCHRONOUS. The layer is consulted only
    // when a provider exists AND is available; default-off (no accessor, no
    // selector env) creates no promise and adds no await to the turn, keeping
    // the output byte for byte identical to the pre-wiring path.
    let provider: DecisionProvider | undefined;
    try {
      provider = this.dependencies.decisionProvider?.();
    } catch (_error) {
      // A throwing accessor is an adapter bug, not a turn failure: the
      // consultation is advisory, so it degrades to the deterministic relation.
      this.emitDecisionConsult(input, decisionProviderErrorResolution(deterministic));
      return deterministic;
    }
    if (!provider) return deterministic;
    if (!provider.available) {
      // Nothing was consulted, but WHY matters: a provider the operator selected
      // and that cannot work (a typo'd name, a binding never deployed, a config
      // it did not get) is a rollout mistake, and an invisible rollout mistake is
      // indistinguishable from a feature that was never turned on. Default-off
      // stays silent, so this turn keeps the pre-wiring shape byte for byte.
      if (isDecisionMisconfigured(provider)) {
        this.emitDecisionConsult(input, unavailableResolution(deterministic, provider));
      }
      return deterministic;
    }
    return this.consultContinuationRelation(deterministic, input, draft, negationMarker, provider);
  }

  /**
   * `decision.consulted`, fields built by the wiring's own sanitizer: enums and
   * booleans only, so no turn content and no provider prose can ride along.
   */
  private emitDecisionConsult(
    input: TurnInput,
    resolution: DecisionResolution<ContinuationRelationChoice>,
  ): void {
    this.emit('decision.consulted', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      ...decisionConsultFields(resolution),
    });
  }

  private async consultContinuationRelation(
    deterministic: ContinuationRelationChoice,
    input: TurnInput,
    draft: MutationDraftRecord,
    negationMarker: boolean,
    provider: DecisionProvider,
  ): Promise<DraftRelation> {
    let resolution: DecisionResolution<ContinuationRelationChoice>;
    try {
      resolution = await resolveContinuationRelation(deterministic, {
        provider,
        facts: {
          // The per-TURN key is what `DECISION_MAX_CALLS_PER_TURN` measures, so a
          // redelivered turn reuses its own budget instead of buying a new call.
          turnId: input.traceId,
          draftStatus: draft.status,
          pendingFieldCount: draft.missingFields.length,
          negationMarker,
          deterministicRelation: deterministic,
        },
      });
    } catch (_error) {
      // Same posture as a throwing accessor: the heuristic stays authoritative and
      // the turn never learns that the optional layer misbehaved.
      this.emitDecisionConsult(input, decisionProviderErrorResolution(deterministic));
      return deterministic;
    }
    // Default-off must be invisible: with no selector the turn emits exactly the
    // same events it emitted before the wiring existed.
    if (!isDecisionDefaultOff(resolution.decision)) {
      this.emitDecisionConsult(input, resolution);
    }
    return resolution.value;
  }

  /**
   * A07/AC15 — applies a value correction to an ACTIVE draft, guarded by the
   * `revision` read immediately before the write.
   /**
   * A07/RR (review fix 1) — the ONLY way a continuation writes the draft it
   * resolved against. Every such write happens AFTER an awaited authoritative
   * read, so the args it carries were built from a revision that may already be
   * stale by the time it lands.
   *
   * Two guarantees, both structural:
   * 1. `expectedRevision` is ALWAYS the revision read immediately before the
   *    statement, so the store (not a later re-read) decides the write;
   * 2. the patch is a FUNCTION of the record just read, so the deterministic
   *    retry re-reads and REBUILDS instead of replaying values captured before
   *    the await. A correction that landed while this turn was resolving is
   *    therefore kept: the retry applies only THIS turn's contributions over
   *    the fresh base.
   *
   * Two attempts, then a refusal: a lost race can neither loop nor clobber.
   */
  private writeDraftContinuation(
    draftId: string,
    build: (current: MutationDraftRecord) => DraftRecordPatch,
  ): { ok: true; record: MutationDraftRecord } | { ok: false; current: MutationDraftRecord | undefined } {
    const store = this.dependencies.draftStore!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = store.get(draftId);
      // Only an ACTIVE draft accepts a continuation write; a draft that moved
      // on (frozen `proposing`, consumed, discarded) is answered from its own
      // state by the caller, never patched.
      if (!current || current.status !== 'active') return { ok: false, current };
      const written = store.update(draftId, build(current), { expectedRevision: current.revision });
      if (written) return { ok: true, record: written };
    }
    return { ok: false, current: store.get(draftId) };
  }

  /**
   * A07/AC15 — applies a value correction to an ACTIVE draft, guarded by the
   * `revision` read immediately before the write.
   *
   * Nothing is inherited: the correction REPLACES `amountCents` and leaves
   * every other field exactly as it was, and the provenance records where the
   * new value came from (A06 `FieldProvenance`, reused verbatim).
   */
  private applyDraftCorrection(
    input: TurnInput,
    draft: MutationDraftRecord,
    amountCents: number,
  ): { ok: true; record: MutationDraftRecord } | { ok: false; current: MutationDraftRecord | undefined } {
    const stamp = new Date(this.draftNowMs()).toISOString();
    return this.writeDraftContinuation(draft.draftId, (current) => ({
      resolvedArgs: { ...current.resolvedArgs, amountCents },
      updatedAt: stamp,
      lastIntentionId: input.intentionId,
      originMessages: appendOriginMessage(current.originMessages, input.intentionId),
      relations: appendDraftRelation(current.relations, 'correction'),
      fieldProvenance: {
        ...(current.fieldProvenance ?? {}),
        amountCents: {
          source: 'token',
          raw: input.text,
          value: amountCents,
        },
      },
    }));
  }

  /**
   * A07/RR (review fix 1) — a continuation write that lost its race (twice, or
   * to a draft that moved on). The refusal converges by the draft's CURRENT
   * state: a frozen/closed draft is answered by {@link handleCasLoss}, and a
   * still-ACTIVE draft is asked again, never written over.
   */
  private refuseDraftWrite(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    current: MutationDraftRecord | undefined,
    question: string,
  ): TurnResult {
    if (!current || current.status !== 'active') {
      return this.handleCasLoss(input, plan, startedAt, base, current);
    }
    return this.clarifyDraft(input, plan, startedAt, base, current, question);
  }

  /**
   * A07/AC15 — the correction could not be applied without racing another
   * write, or the turn's value was not a deterministic correction at all.
   * Fail closed: nothing is proposed, the draft keeps what it had, and the
   * user is asked to restate the amount.
   */
  private stopDraftCorrection(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    draft: MutationDraftRecord,
    text: string = CORRECTION_REFUSAL_TEXT,
  ): TurnResult {
    this.emit('mutation.blocked', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'blocked',
    });
    const blockedPlan = freeze({ ...plan, missingFields: freeze(['amount']) });
    return this.completeTurn(input, blockedPlan, startedAt, base, {
      plan: blockedPlan,
      clarification: freeze({ missingFields: blockedPlan.missingFields, text, draft: toChannelMessage(draft, text) }),
      response: freeze({ text }),
    });
  }

  /**
   * A07/RR (review fix 4) — the date fragment of this turn, or an honest
   * ambiguity. Applied ONLY when the turn names exactly one relative date and
   * does not negate it (A06 `hasNegation`, reused); "ontem ou hoje" and "não foi
   * ontem" are questions, never a date.
   */
  private dateFragmentOf(
    text: string,
  ): { date?: string; ambiguous: boolean; clarification?: string } {
    const fragment = resolveRelativeDateFragment(text, { now: new Date(this.draftNowMs()) });
    if (fragment.status === 'ambiguous') {
      return { ambiguous: true, clarification: ambiguityClarificationText('contradictory_dates') };
    }
    if (fragment.status === 'none') return { ambiguous: false };
    if (hasNegation(text)) return { ambiguous: true, clarification: DENIED_DATE_TEXT };
    return { date: fragment.date, ambiguous: false };
  }

  /**
   * A07/RR (review fix 4) — an ambiguous or DENIED date fragment is a question,
   * never a date. Nothing is written: the draft keeps its stored date and its
   * pending fields, so the next unambiguous fragment ("ontem") still applies.
   */
  private stopDraftDate(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    draft: MutationDraftRecord,
    text: string,
  ): TurnResult {
    this.emit('mutation.blocked', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'blocked',
      reason: 'ambiguous_relative_date',
    });
    const datePlan = freeze({ ...plan, missingFields: freeze(['date']) });
    return this.completeTurn(input, datePlan, startedAt, base, {
      plan: datePlan,
      clarification: freeze({
        missingFields: datePlan.missingFields,
        text,
        draft: toChannelMessage(draft, text),
      }),
      response: freeze({ text }),
    });
  }

  private async continueDraft(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    draft: MutationDraftRecord,
    client: MutationApiClient,
  ): Promise<TurnResult> {
    const store = this.dependencies.draftStore!;
    // A07/AC15 — a value correction ("não, 500") against an ACTIVE draft
    // replaces the stored amount instead of asking the pending question again.
    // Applied through `update` + `revision` (never in place), with a
    // deterministic single retry on a concurrent write, and nothing else in
    // the turn inherits from the correction. Textual confirmation never
    // executes: only this field substitution is reachable here.
    //
    // A07/RR (review fix 2): a turn whose value is NOT a deterministic
    // correction (truncated thousand, foreign currency, alternative) is an
    // honest amount clarification — the stored amount is left exactly as it was.
    const correction = correctionOutcome(input.text);
    if (correction.kind === 'ambiguous') {
      return this.stopDraftCorrection(
        input,
        plan,
        startedAt,
        base,
        store.get(draft.draftId) ?? draft,
        correction.clarification,
      );
    }
    const correctionCents = correction.kind === 'amount' ? correction.amountCents : undefined;
    /**
     * A07/FIX A — what this turn OBSERVED before any await, per contributed
     * field. It is the guard that decides whether a contribution may still be
     * written at the moment of the post-await write (see {@link argsOver}).
     */
    const observedBefore = {
      amountCents: draft.resolvedArgs.amountCents,
      date: draft.resolvedArgs.date,
      categoryQuery: draft.resolvedArgs.categoryQuery,
    };
    let currentDraft = draft;
    if (correctionCents !== undefined) {
      const applied = this.applyDraftCorrection(input, draft, correctionCents);
      if (!applied.ok) {
        // A concurrent write won: refuse to overwrite it and clarify.
        return this.stopDraftCorrection(input, plan, startedAt, base, applied.current ?? draft);
      }
      currentDraft = applied.record;
    }
    /**
     * A16/R15 — the ONLY optional consultation in the turn, and it sits AFTER
     * the guarded write above: a value correction IS the relation (`correction`)
     * and never waits for a judge, so no consultation window can open before a
     * financial field is written. Every other turn classifies itself between
     * "negação" and "continuação" and may ask the judge, default-off, for a
     * second opinion that stays advisory.
     */
    // F6: a value correction IS the relation and never consults the judge; every
    // other turn resolves the heuristic relation synchronously (default-off:
    // no promise, no await) and only awaits when a provider is available.
    let relation: DraftRelation = 'correction';
    if (correctionCents === undefined) {
      const resolved = this.continuationRelation(input, draft);
      relation = typeof resolved === 'string' ? resolved : await resolved;
    }
    // Resolve ONLY the missing field, then revalidate ALL args: the stored
    // financial fields are authoritative for this draft, the new text only
    // supplies entity hints (e.g. "Nubank" → account).
    //
    // SPEC R03: a draft pending only the category is completed by the category
    // the user just named — without this the clarification asked for something
    // the draft could never consume, since the stored description is not a
    // category query. The turn's explicit statement wins over the stored one
    // (a correction of the category is exactly what this turn is for).
    //
    // A07/AC14: the bare FRAGMENT "de carne" answers the same question, and is
    // admitted ONLY when the turn carries no candidate interpretation of its
    // own — a real utterance is still routed as a new/replacement intention.
    const turnInterpretation = this.interpretTurn(input.text);
    const allowBareFragment = turnInterpretation.status !== 'candidate';
    const turnCategory = draft.missingFields.includes('categoryId')
      ? categoryQueryFrom(input.text, { allowBareFragment })
      : undefined;
    const turnCategoryQuery = turnCategory?.query;
    const categoryQuery = turnCategoryQuery ?? draft.resolvedArgs.categoryQuery;
    // A07/AC14: "ontem"/"hoje" CORRECTS the stored date. Resolved through the
    // parser's own `dateFor` against the injected clock — the same timezone
    // the fresh path uses — instead of copying the stored date verbatim.
    // A07/RR fix 4: only an UNAMBIGUOUS, unnegated fragment is applied; an
    // ambiguous or denied date is a question and writes NOTHING to the draft.
    const dateFragment = this.dateFragmentOf(input.text);
    if (dateFragment.ambiguous) {
      return this.stopDraftDate(input, plan, startedAt, base, currentDraft, dateFragment.clarification!);
    }
    const turnDate = dateFragment.date;
    const merged = {
      kind: draft.resolvedArgs.kind,
      amountCents: currentDraft.resolvedArgs.amountCents,
      description: draft.resolvedArgs.description,
      date: turnDate ?? draft.resolvedArgs.date,
      ...(categoryQuery ? { categoryQuery } : {}),
    };
    /**
     * A07/RR (review fix 1) — the args this turn WRITES are this turn's
     * contributions applied over WHATEVER the draft holds at write time. A
     * value read before the await (or a correction that landed during it) is
     * never replayed, so the deterministic retry keeps the fresher record.
     *
     * A07/FIX A — the FRESH base is authoritative for every field it already
     * carries. A contribution captured before the await (value correction,
     * date fragment, category query) is re-applied ONLY where that base still
     * holds exactly what THIS turn left behind — i.e. where nobody else wrote
     * the field while this turn was resolving. Without this guard two
     * corrections interleave (A corrects to R$500 and parks, B corrects to
     * R$700) and A's older contribution would silently overwrite B's fresher
     * one on the way out.
     */
    const argsOver = (base: MutationDraftRecord): MutationDraftResolvedArgs => {
        const amountCents =
          correctionCents !== undefined && base.resolvedArgs.amountCents === correctionCents
            ? correctionCents
            : base.resolvedArgs.amountCents;
        const date = turnDate !== undefined && base.resolvedArgs.date === observedBefore.date ? turnDate : base.resolvedArgs.date;
        const query =
          turnCategoryQuery !== undefined && base.resolvedArgs.categoryQuery === observedBefore.categoryQuery
            ? turnCategoryQuery
            : base.resolvedArgs.categoryQuery;
        return {
          kind: base.resolvedArgs.kind,
          amountCents,
          description: base.resolvedArgs.description,
          date,
          ...(query ? { categoryQuery: query } : {}),
        };
      };
    // R10 (AC20): resolving the draft's missing entities IS a recovery —
    // charge it to the shared per-turn budget BEFORE touching the
    // authoritative lists, so a refusal never re-reads them. The fingerprint
    // carries the SAME hint text the resolver matches accounts against, so a
    // bare answer naming another account is a new strategy, not a repeat.
    // A06xA10: when the turn carries its own interpretation, the hint is that
    // SAME resolution base `freshMutationFlow` uses, so one logical attempt
    // has one fingerprint whichever path it arrives by. Only a bare answer
    // (which has no interpretation of its own) keeps the draft description
    // in front, exactly as before.
    //
    // A07/RR fix 5: a CATEGORIAL FRAGMENT ("de carne") answers the category
    // question ONLY. Its text never enters the account haystack: with an
    // account named "Carne" it would silently select it and propose without
    // ever asking. The account therefore stays pending (and its homonyms stay
    // visible) while the fragment only feeds `categoryQuery`.
    const resolutionHint = turnInterpretation.status === 'candidate'
      ? turnInterpretation.resolutionText
      : turnCategory?.fromFragment
        ? draft.resolvedArgs.description
        : `${draft.resolvedArgs.description} ${input.text}`;
    const permit = this.permitResolutionRecovery(base, {
      kind: merged.kind,
      args: {
        amountCents: merged.amountCents,
        description: merged.description,
        date: merged.date,
        ...(categoryQuery ? { categoryQuery } : {}),
      },
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      resolutionHint,
    });
    if (!permit.allowed) {
      return this.stopResolutionRecovery(
        input,
        plan,
        startedAt,
        base,
        permit,
        draft.missingFields.length > 0 ? draft.missingFields : ['accountId', 'categoryId'],
      );
    }
    const resolution = await resolveMutationEntities(
      merged,
      resolutionHint,
      this.entityReaderOrClosed(),
      // A08/R08 tier 2: the ids this draft already had confirmed inside the
      // scope. The turn's own explicit choice still outranks them, and an id
      // that no longer verifies is invalidated by the resolver, never used.
      {
        confirmed: {
          ...(draft.resolvedArgs.accountId ? { accountId: draft.resolvedArgs.accountId } : {}),
          ...(draft.resolvedArgs.categoryId ? { categoryId: draft.resolvedArgs.categoryId } : {}),
        },
      },
    );
    const stamp = new Date(this.draftNowMs()).toISOString();
    this.emitEntityResolution(input, plan, resolution.trace);
    if (!resolution.complete) {
      // SPEC R03: an explicit category accepted in this turn must survive the
      // draft while another field stays pending. Dropping it would make the
      // next bare answer ("Nubank") re-ask the category the user just named,
      // because the stored description is not a category query.
      //
      // A07/AC14/AC15: the same rule covers EVERY field this turn contributed
      // — the category fragment, the corrected date and the corrected amount.
      // A value that only fed the resolution would be lost, and the next turn
      // would silently resolve against the stale one.
      const written = this.writeDraftContinuation(draft.draftId, (current) => {
        // A07/FIX A: the SAME guard `argsOver` applies — the payload is written
        // only when some contribution of this turn still has a field the fresh
        // base left untouched.
        const adoptsTurnArgs =
          (correctionCents !== undefined && current.resolvedArgs.amountCents === correctionCents) ||
          (turnDate !== undefined && current.resolvedArgs.date === observedBefore.date) ||
          (turnCategoryQuery !== undefined && current.resolvedArgs.categoryQuery === observedBefore.categoryQuery);
        return {
          ...(adoptsTurnArgs ? { resolvedArgs: argsOver(current) } : {}),
          missingFields: [...resolution.missingFields],
          updatedAt: stamp,
          lastIntentionId: input.intentionId,
          lastQuestion: resolution.clarification,
          ...this.turnMetadata(input, current, relation),
        };
      });
      if (!written.ok) {
        return this.refuseDraftWrite(input, plan, startedAt, base, written.current, resolution.clarification);
      }
      return this.clarifyDraft(input, plan, startedAt, base, written.record, resolution.clarification);
    }
    // A07/RR fix 1: the args the resolver validated are the ones written, built
    // over the record read at write time (never over a pre-await snapshot).
    const completeArgs = (
      base: MutationDraftRecord,
      verified: { accountId: string; categoryId: string; accountName: string | null; categoryName: string | null },
    ): MutationDraftResolvedArgs => ({
      ...base.resolvedArgs,
      ...argsOver(base),
      accountId: verified.accountId,
      categoryId: verified.categoryId,
      ...(verified.accountName ? { accountName: verified.accountName } : {}),
      ...(verified.categoryName ? { categoryName: verified.categoryName } : {}),
    });
    if (!validateCompleteArgs(completeArgs(currentDraft, resolution))) {
      // Canonical gate failed agent-side: never propose, clarify again.
      const question = 'Não foi possível validar os dados com segurança. Descreva novamente o lançamento.';
      const written = this.writeDraftContinuation(draft.draftId, (current) => ({
        missingFields: ['accountId', 'categoryId'],
        updatedAt: stamp,
        lastIntentionId: input.intentionId,
        lastQuestion: question,
        ...this.turnMetadata(input, current, relation),
      }));
      if (!written.ok) return this.refuseDraftWrite(input, plan, startedAt, base, written.current, question);
      return this.clarifyDraft(input, plan, startedAt, base, written.record, question);
    }
    // A08/R08: existence, activity and scope are re-checked IMMEDIATELY before
    // the write (the CAS below is what arms the propose). This is the SAME
    // resolution attempt — no recovery slot, no second loop (A06×A10). The
    // redelivery/recovery paths keep re-emitting their proposal untouched.
    const verified = await revalidateResolvedEntities(resolution, this.entityReaderOrClosed());
    this.emitEntityResolution(input, plan, verified.trace);
    if (!verified.complete) {
      const written = this.writeDraftContinuation(draft.draftId, (current) => ({
        missingFields: [...verified.missingFields],
        updatedAt: stamp,
        lastIntentionId: input.intentionId,
        lastQuestion: verified.clarification,
        ...this.turnMetadata(input, current, relation),
      }));
      if (!written.ok) {
        return this.refuseDraftWrite(input, plan, startedAt, base, written.current, verified.clarification);
      }
      return this.clarifyDraft(input, plan, startedAt, base, written.record, verified.clarification);
    }
    const written = this.writeDraftContinuation(draft.draftId, (current) => ({
      resolvedArgs: completeArgs(current, verified),
      missingFields: [],
      updatedAt: stamp,
      lastIntentionId: input.intentionId,
      ...this.turnMetadata(input, current, relation),
    }));
    if (!written.ok) {
      // The resolution is lost: converge by the draft's CURRENT state instead
      // of proposing args this turn could not prove are still stored.
      return this.refuseDraftWrite(input, plan, startedAt, base, written.current, DRAFT_WRITE_CONTENTION_TEXT);
    }
    // Atomic consumption: exactly one continuation wins; losers converge.
    const cas = store.cas(draft.draftId, 'active', 'proposing', {
      updatedAt: stamp,
      lastIntentionId: input.intentionId,
    });
    if (!cas.ok) return this.handleCasLoss(input, plan, startedAt, base, cas.current);
    return this.executePropose(input, plan, startedAt, base, cas.record, client);
  }

  private async freshMutationFlow(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    client: MutationApiClient,
  ): Promise<TurnResult> {
    const store = this.dependencies.draftStore!;
    const ctx = this.draftContext(input);
    // R06/A06: interpret once, then keep the historical flow. An ambiguous
    // utterance (AC13) stops before entity resolution: no read, no draft, no
    // proposal, and no invented value.
    const interpretation = this.interpretTurn(input.text);
    if (interpretation.status === 'clarify') {
      const clarification = this.ambiguousClarification(interpretation);
      const blockedPlan = freeze({ ...plan, missingFields: freeze([...clarification.missingFields]) });
      this.emit('mutation.blocked', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'blocked',
      });
      return this.completeTurn(input, blockedPlan, startedAt, base, {
        plan: blockedPlan,
        clarification,
        response: freeze({ text: clarification.text }),
      });
    }
    if (interpretation.status !== 'candidate') {
      // SPEC §7.6: missing amount/date is a real missing field, never [].
      const missing = interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount' ? ['amount'] : [...plan.missingFields];
      const blockedPlan = freeze({ ...plan, missingFields: freeze([...missing]) });
      const text =
        interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount'
          ? 'Não identifiquei o valor a registrar. Informe o valor e a descrição.'
          : 'Não foi possível preparar a mutação com segurança. Esclareça valor e descrição.';
      this.emit('mutation.blocked', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'blocked',
      });
      return this.completeTurn(input, blockedPlan, startedAt, base, {
        plan: blockedPlan,
        clarification: freeze({ missingFields: blockedPlan.missingFields, text }),
        response: freeze({ text }),
      });
    }
    const parsed = interpretation.parsed;
    // R10 (AC20): the single resolution of this turn is a RECOVERY attempt —
    // charge it to the shared budget BEFORE reading accounts/categories, so a
    // refusal stops the turn safely instead of re-deriving the same answer.
    // The fingerprint carries the SAME text the resolver matches accounts
    // against, so naming another account is a new strategy, not a repeat.
    const permit = this.permitResolutionRecovery(base, {
      kind: parsed.kind,
      args: {
        amountCents: parsed.amountCents,
        description: parsed.description,
        date: parsed.date,
        ...(parsed.categoryQuery ? { categoryQuery: parsed.categoryQuery } : {}),
      },
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      resolutionHint: interpretation.resolutionText,
    });
    if (!permit.allowed) {
      return this.stopResolutionRecovery(input, plan, startedAt, base, permit, ['accountId', 'categoryId']);
    }
    // R08/A08: the account hint is TEXT — the deterministic match still happens
    // here, against the authoritative account list.
    const resolution = await resolveMutationEntities(parsed, interpretation.resolutionText, this.entityReaderOrClosed());
    // A08/R08: re-check existence/activity/scope IMMEDIATELY before the write.
    // Same resolution attempt — no recovery slot, no second loop (A06×A10).
    const verified = resolution.complete
      ? await revalidateResolvedEntities(resolution, this.entityReaderOrClosed())
      : resolution;
    this.emitEntityResolution(input, plan, verified.trace);
    if (!verified.complete) {
      // Idempotent per turn (§7.7): same intentionId reuses the draft.
      const tool = this.toolForKind(parsed.kind);
      const now = this.draftNowMs();
      const candidate = buildDraftRecord({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        deviceId: ctx.deviceId,
        intentionId: input.intentionId,
        tool,
        resolvedArgs: {
          kind: parsed.kind,
          amountCents: parsed.amountCents,
          description: parsed.description,
          date: parsed.date,
          ...(parsed.categoryQuery ? { categoryQuery: parsed.categoryQuery } : {}),
        },
        missingFields: [...verified.missingFields],
        question: verified.clarification,
        ttlMs: this.dependencies.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS,
        nowMs: now,
        // A07/R07: snapshot the A06 provenance of the utterance that opened
        // the goal, so a later correction has a baseline to point at.
        fieldProvenance: this.draftProvenance(interpretation),
      });
      const { record } = store.getOrCreate(candidate);
      return this.clarifyDraft(input, plan, startedAt, base, record, record.lastQuestion);
    }
    // Complete on the first turn: no draft involved; the no-draft proposal
    // key derives deterministically from the intentionId (T1.2, unchanged).
    const identity: MutationIdentity = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
    };
    const tool = parsed.kind === 'income' ? 'transactions.income.create' : 'transactions.expense.create';
    const normalizedArgs = {
      amountCents: parsed.amountCents,
      description: parsed.description,
      date: parsed.date,
      accountId: verified.accountId,
      categoryId: verified.categoryId,
    };
    // R10 (AC30): same accounting as the draft path — counted before it goes.
    this.budgetFor(base).noteProposeAttempt();
    const proposal = await client.propose({
      tool,
      normalizedArgs,
      summary: parsed.description,
      identity,
      idempotencyKey: deriveIdempotencyKey(input.workspaceId, input.intentionId, tool),
    });
    // A19 (F1): the turn's attachments are passed as an INPUT. Presence alone
    // vetoes eligibility — no state, type, provider or text is consulted, so an
    // attachment whose extraction came back empty (capability off, provider
    // down, `skipped_budget`) can never reach the fast path on a bare typed
    // imperative. The no-attachment path is byte-for-byte unchanged.
    const eligible = isAutoExecutionEligible({ tool, missingFields: [], ambiguity: plan.ambiguity, latestActorText: input.text, attachments: input.attachments });
    if (eligible && !proposal.existing) {
      const duplicateSuspected = await client.duplicateSuspectedStrict({
        kind: parsed.kind, description: parsed.description, amountCents: parsed.amountCents,
        date: parsed.date, accountId: verified.accountId,
      });
      if (!duplicateSuspected) {
        const elevated = this.dependencies.autoExecutionClient?.();
        if (elevated) {
          const authorization = await this.authorizeAutoExecution(elevated, proposal.id, identity);
          if (authorization.kind === 'uncertain') {
            return this.completeTurn(input, plan, startedAt, base, { response: freeze({ text: renderInconclusive() }) });
          }
          if (authorization.kind === 'authorized') {
            try {
              const executed = await new PendingOperationCoordinator({ client: elevated }).executeAuthorized({ operationId: proposal.id, attestation: authorization.attestation }, identity);
              return this.completeTurn(input, plan, startedAt, base, {
                policy: freeze({ ...base.policy, authorizationMode: 'auto' }),
                mutation: freeze({ operationId: executed.operationId, status: 'succeeded', ...(executed.receipt ? { receipt: executed.receipt } : {}) }),
                response: freeze({ text: `${parsed.kind === 'income' ? 'Receita' : 'Despesa'} de R$ ${(parsed.amountCents / 100).toFixed(2).replace('.', ',')} (${parsed.description}) registrada${verified.accountName ? ` na conta ${verified.accountName}` : ''}. Se quiser, posso desfazer.` }),
              });
            } catch {
              try {
                const current = await elevated.listActive(identity);
                if (current.items.some((item) => item.id === proposal.id && item.status === 'failed')) {
                  return this.completeTurn(input, plan, startedAt, base, { response: freeze({ text: renderMutationResult('failed') }) });
                }
              } catch { /* State remains uncertain; keep the inconclusive response. */ }
              return this.completeTurn(input, plan, startedAt, base, { response: freeze({ text: renderInconclusive() }) });
            }
          }
        }
      }
    }
    return this.completeTurn(input, plan, startedAt, base, {
      policy: freeze({ ...base.policy, authorizationMode: 'manual' }),
      mutation: this.proposedMutation({
        operationId: proposal.id,
        tool,
        normalizedArgs,
        accountName: verified.accountName,
        categoryName: verified.categoryName,
        expiresAt: proposal.operation.expiresAt,
      }),
      response: freeze({ text: renderMutationResult('proposed', proposal.summary) }),
    });
  }

  /**
   * debt-undo-confirmation-protocol: free text only proposes. Returns null
   * when this turn is not an undo turn (normal flow continues). Every
   * returned path is terminal for the turn: proposal, deterministic
   * negation/confirmation-fail-closed, or device-missing fail-closed. The
   * undo API is NEVER called here — only the RPC decision path executes.
   */
  private async runUndoTurn(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    decisionText?: string,
  ): Promise<TurnResult | null> {
    // F1: undo intent/negation/confirmation are read from the TYPED text only —
    // attachment-derived data never proposes, negates or confirms an undo.
    const text = decisionText ?? input.text ?? '';
    if (!hasUndoIntent(text)) return null;
    // Natural-language negation fails closed: no proposal, no execution.
    if (isUndoNegation(text)) {
      const reply = 'Entendido — nada será desfeito.';
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: reply }) });
    }
    // Textual confirmation of an undo (with or without a pending proposal)
    // NEVER executes: the authenticated PWA button owns the decision.
    if (isExplicitConfirmation(text)) {
      const reply = 'Para desfazer, confirme no botão da proposta. A confirmação por texto não desfaz.';
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: reply }) });
    }
    const undoDeps = this.dependencies.undoProposals;
    if (!input.deviceId) {
      return freeze({ ...base, response: freeze({ text: 'Não foi possível preparar o desfazer com segurança. A sessão precisa de um dispositivo autenticado.' }) });
    }
    if (!undoDeps) {
      return freeze({ ...base, response: freeze({ text: 'Não foi possível preparar o desfazer agora. Tente novamente.' }) });
    }
    const service = new UndoProposalService({
      store: undoDeps.store,
      preview: undoDeps.preview,
      api: undoDeps.api ?? { undo: async () => { throw new Error('undo.rpc_required'); } },
      ...(undoDeps.now ? { now: undoDeps.now } : {}),
      ...(undoDeps.ttlMs !== undefined ? { ttlMs: undoDeps.ttlMs } : {}),
    });
    let outcome: Awaited<ReturnType<UndoProposalService['propose']>>;
    try {
      outcome = await service.propose({
        requestId: input.intentionId,
        identity: { workspaceId: input.workspaceId, actorId: input.actorId, deviceId: input.deviceId },
      });
    } catch {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: 'Não foi possível preparar o desfazer agora. Tente novamente.' }) });
    }
    if (outcome.kind === 'unavailable') {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: 'Não há ação para desfazer.' }) });
    }
    const record = outcome.record;
    const reply = 'Encontrei a última ação para desfazer. Confirme no botão para desfazer.';
    this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
    return freeze({
      ...base,
      undoProposal: freeze({ requestId: record.requestId, status: 'proposed' as const, expiresAt: record.expiresAt }),
      response: freeze({ text: reply }),
    });
  }

  private async runMutationTurn(
    input: TurnInput,
    plan: TurnPlan,
    client: MutationApiClient,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
  ): Promise<TurnResult> {
    const store = this.dependencies.draftStore!;
    const ctx = this.draftContext(input);
    const now = this.draftNowMs();
    store.expireStale(ctx, now);

    // §7.7 resend: the same turn redelivered converges without new state.
    const redelivered = store.findByIntention(ctx, input.intentionId);
    if (redelivered?.status === 'consumed' && redelivered.proposalId) {
      return this.completeTurn(input, plan, startedAt, base, {
        mutation: freeze({ operationId: redelivered.proposalId, status: 'proposed' }),
        response: freeze({ text: renderMutationResult('proposed', redelivered.resolvedArgs.description) }),
      });
    }
    if (redelivered?.status === 'active' && !isExpired(redelivered, now)) {
      return this.clarifyDraft(input, plan, startedAt, base, redelivered, redelivered.lastQuestion);
    }
    if (redelivered?.status === 'proposing' && !isExpired(redelivered, now)) {
      // Case A: the continuation was redelivered — re-emit with the SAME key.
      return this.executePropose(input, plan, startedAt, base, redelivered, client);
    }

    // Restart recovery (cases A/B): drafts left `proposing` by a crash are
    // re-emitted with the same key before the current turn proceeds — the
    // API dedup converges both paths to the same operation.
    for (const proposing of store.listProposing(ctx, now)) {
      if (validateCompleteArgs({ ...proposing.resolvedArgs, accountId: proposing.resolvedArgs.accountId ?? '', categoryId: proposing.resolvedArgs.categoryId ?? '' })) {
        try {
          await this.executeProposeSilent(proposing, client, input);
        } catch {
          // Best effort: the current turn still proceeds; the draft stays
          // proposing with outcome unknown for the next reconciliation.
        }
      }
    }

    // "cancela" routed here under a forced mutation plan still cancels.
    if (isCancelText(input.text)) {
      return this.runCancelTurn(input, plan, client, startedAt, base);
    }

    const actives = store.listActive(ctx, now);
    if (actives.length >= 2) {
      const replacement = this.interpretTurn(input.text);
      if (replacement.status === 'candidate' && actives.every((draft) => this.isReplacement(input.text, draft))) {
        const stamp = new Date(now).toISOString();
        for (const draft of actives) {
          store.update(draft.draftId, { status: 'replaced', updatedAt: stamp, lastIntentionId: input.intentionId });
        }
        return this.freshMutationFlow(input, plan, startedAt, base, client);
      }
      // Ambiguity: never choose silently, propose nothing.
      const options = actives
        .slice(0, 5)
        .map((draft, index) => `${index + 1}. ${draft.resolvedArgs.description}`)
        .join('\n');
      const text = `Encontrei mais de uma intenção pendente. Qual delas você quer continuar?\n${options}`;
      const ambiguousPlan = freeze({ ...plan, missingFields: freeze(['intent']) });
      this.emit('mutation.blocked', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'blocked',
      });
      return this.completeTurn(input, ambiguousPlan, startedAt, base, {
        plan: ambiguousPlan,
        clarification: freeze({ missingFields: ambiguousPlan.missingFields, text }),
        response: freeze({ text }),
      });
    }
    if (actives.length === 1 && actives[0]) {
      const draft = actives[0];
      if (this.isReplacement(input.text, draft)) {
        store.update(draft.draftId, {
          status: 'replaced',
          updatedAt: new Date(now).toISOString(),
          lastIntentionId: input.intentionId,
        });
        return this.freshMutationFlow(input, plan, startedAt, base, client);
      }
      return this.continueDraft(input, plan, startedAt, base, draft, client);
    }
    return this.freshMutationFlow(input, plan, startedAt, base, client);
  }

  /** Recovery re-emission without a turn response (result converges in store). */
  private async executeProposeSilent(
    draft: MutationDraftRecord,
    client: MutationApiClient,
    input: TurnInput,
  ): Promise<void> {
    const store = this.dependencies.draftStore!;
    const identity: MutationIdentity = {
      workspaceId: draft.workspaceId,
      actorId: draft.actorId,
      deviceId: draft.deviceId ?? input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
    };
    const args = draft.resolvedArgs;
    try {
      // Restart recovery re-emits ANOTHER intention's proposal (the current
      // turn's own `proposing` draft is handled above with a response), so it
      // is deliberately NOT charged to this turn's propose axis: the snapshot
      // reports what THIS turn proposed.
      const proposal = await client.propose({
        tool: draft.tool,
        normalizedArgs: {
          amountCents: args.amountCents,
          description: args.description,
          date: args.date,
          accountId: args.accountId!,
          categoryId: args.categoryId!,
        },
        summary: args.description,
        identity,
        idempotencyKey: draft.proposalIdempotencyKey,
      });
      store.update(draft.draftId, {
        status: 'consumed',
        proposalId: proposal.id,
        proposeOutcome: proposal.existing ? 'existing' : 'created',
        updatedAt: new Date(this.draftNowMs()).toISOString(),
      });
    } catch (error) {
      if (isDefinitiveProposeError(error)) {
        store.update(draft.draftId, {
          status: 'discarded',
          discardReason: 'propose_rejected',
          proposeOutcome: 'rejected',
          updatedAt: new Date(this.draftNowMs()).toISOString(),
        });
        return;
      }
      store.update(draft.draftId, {
        proposeOutcome: 'unknown',
        updatedAt: new Date(this.draftNowMs()).toISOString(),
      });
      throw error;
    }
  }

  /**
   * Issue #99 — forget em duas etapas, turno de decisão determinístico.
   *
   * NENHUMA heurística lexical autoriza exclusão: o pedido só PROPÕE
   * (persiste pending + pergunta), e SÓ a confirmação explícita em turno
   * posterior executa — após revalidação completa. Retorna null quando este
   * turno não é do fluxo forget (o pipeline legado/financeiro é dono).
   *
   * Precedências (todas fail-closed):
   * - sem dep injetada ⇒ null (comportamento anterior intacto);
   * - turno COM anexo ⇒ null (attachment turn != confirmação; veto por
   *   presença, antes de tipo/estado/texto — §9 + imunidade A19-F1);
   * - decisão lida SÓ de `decisionText` (texto digitado server-side);
   * - rascunho financeiro recuperável ⇒ null (não rouba "sim" de outro fluxo);
   * - `mutation-proposal` ⇒ null (o financeiro é dono do texto);
   * - confirmação/cancelamento com alvo financeiro decidível ⇒ null
   *   (financeiro primeiro; só o `none` cai no forget);
   * - cancel/confirmação SEM pending forget ⇒ null (o legado responde).
   *
   * Estado durável ↔ publicado (§40): todo caminho que persiste pending
   * responde na MESMA decisão com a pergunta publicada; caminhos sem
   * escrita nunca criam confirmação invisível.
   */
  private async runForgetDecisionTurn(
    input: TurnInput,
    plan: TurnPlan,
    client: MutationApiClient | undefined,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    decisionText: string,
  ): Promise<TurnResult | null> {
    const dep = this.dependencies.forgetMemory;
    if (!dep) return null;
    if (input.attachments.length > 0) return null;
    // Cancelamento primeiro: negação/cancelamento nunca autoriza exclusão —
    // em caso de sobreposição textual, a direção segura (não apagar) vence.
    const wantsCancel = isForgetCancellationText(decisionText);
    const wantsConfirm = !wantsCancel && isForgetConfirmationText(decisionText);
    const wantsPropose = !wantsCancel && !wantsConfirm && isForgetRequestText(decisionText);
    if (!wantsConfirm && !wantsCancel && !wantsPropose) return null;
    if (plan.mode === 'mutation-proposal') return null;
    if ((wantsConfirm || wantsCancel) && this.hasDraftForTurn(input)) return null;
    if (client && (wantsConfirm || wantsCancel)) {
      try {
        const identity: MutationIdentity = {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
        };
        const target = await this.coordinatorFor(client).resolveDecisionTarget(identity, 'decidable', this.draftContext(input));
        if (target.kind !== 'none') return null;
      } catch (err) {
        // Sem dispositivo o financeiro é impossível (SDK): o forget prossegue.
        // Qualquer outra falha de sondagem falha fechado para o legado.
        if ((err as Error)?.message !== 'mutation.device_required') return null;
      }
    }
    const emit = (eventType: string, fields: Record<string, unknown>): void => this.emit(eventType, fields);
    const sql = dep.sql;
    const nowMs = dep.now?.() ?? this.draftNowMs();
    const identity = { workspaceId: input.workspaceId, actorId: input.actorId };
    if (wantsPropose) {
      const outcome = proposeForgetMemory(sql, {
        ...identity,
        query: decisionText,
        intentionId: input.intentionId,
        nowMs,
        emit,
      });
      const text = outcome.message;
      const extra =
        outcome.outcome === 'ambiguous'
          ? { clarification: freeze({ missingFields: freeze(['intent']), text }) }
          : {};
      return this.completeTurn(input, plan, startedAt, base, { ...extra, response: freeze({ text }) });
    }
    if (wantsCancel) {
      const outcome = cancelForgetMemory(sql, { ...identity, intentionId: input.intentionId, nowMs, emit });
      if (outcome.outcome === 'none') return null;
      return this.completeTurn(input, plan, startedAt, base, { response: freeze({ text: outcome.message }) });
    }
    const outcome = confirmForgetMemory(sql, { ...identity, intentionId: input.intentionId, nowMs, emit });
    if (outcome.outcome === 'none') return null;
    return this.completeTurn(input, plan, startedAt, base, { response: freeze({ text: outcome.message }) });
  }

  /**
   * T1.5 (SPEC §8.5, INV-10): every cancel resolves through the coordinator.
   * Proposing handoffs settle by the SAME key, actives are discarded, and
   * "cancelado" is only answered after the API persisted the cancel — or
   * after verifying no operation was ever created.
   */
  private async runCancelTurn(
    input: TurnInput,
    plan: TurnPlan,
    client: MutationApiClient | null,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
  ): Promise<TurnResult> {
    const store = this.dependencies.draftStore;
    const cancelled = (): TurnResult => {
      this.emit('approval.rejected', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'rejected',
      });
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: renderMutationResult('cancelled') }),
      });
    };
    // Legacy contract preserved when no draft store is configured.
    if (!store) return cancelled();
    const ctx = this.draftContext(input);
    const now = this.draftNowMs();
    // Without a transport the proposing outcome cannot be resolved — reply
    // inconclusive when a handoff is in flight, never "cancelado" (INV-10).
    // Active drafts are still discarded locally: no structured intention
    // may survive to become a proposal afterwards.
    if (!client) {
      const stamp = new Date(now).toISOString();
      for (const draft of store.listActive(ctx, now)) {
        store.update(draft.draftId, {
          status: 'discarded',
          discardReason: 'user_cancel',
          updatedAt: stamp,
          lastIntentionId: input.intentionId,
          // A07/R07: the cancel is recorded as a relation of the goal it
          // closed. Metadata only — the discard itself is unchanged.
          ...this.turnMetadata(input, draft, 'cancel_ref'),
        });
      }
      if (store.listProposing(ctx, now).length > 0) {
        return this.completeTurn(input, plan, startedAt, base, {
          response: freeze({ text: renderInconclusive() }),
        });
      }
      return cancelled();
    }
    const coordinator = this.coordinatorFor(client);
    let resolution: Awaited<ReturnType<PendingOperationCoordinator['resolveCancel']>>;
    try {
      resolution = await coordinator.resolveCancel(
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
        },
        { store, ctx, intentionId: input.intentionId, deviceId: input.deviceId, nowMs: now },
      );
    } catch {
      // Unknown outcome (transport failure, missing device): never claim
      // "cancelado" with a possibly-active operation (INV-10).
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: renderInconclusive() }),
      });
    }
    if (resolution.kind === 'inconclusive') {
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: coordinator.renderInconclusive() }),
      });
    }
    if (resolution.kind === 'ambiguous') {
      const text = renderDisambiguation(resolution.operations, 'cancelar');
      const ambiguousPlan = freeze({ ...plan, missingFields: freeze(['intent']) });
      this.emit('mutation.blocked', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'blocked',
      });
      return this.completeTurn(input, ambiguousPlan, startedAt, base, {
        plan: ambiguousPlan,
        clarification: freeze({ missingFields: ambiguousPlan.missingFields, text }),
        response: freeze({ text }),
      });
    }
    return cancelled();
  }

  /**
   * T1.5 conversational retry (SPEC §8.2/§13): "tenta de novo" over a
   * `failed` operation routes through the coordinator → API retry
   * (failed → confirmed, fresh attestation) → execute once.
   */
  private async runRetryTurn(
    input: TurnInput,
    plan: TurnPlan,
    client: MutationApiClient,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
  ): Promise<TurnResult> {
    const coordinator = this.coordinatorFor(client);
    const identity: MutationIdentity = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
    };
    try {
      const target = await coordinator.resolveDecisionTarget(identity, 'retryable', this.draftContext(input));
      if (target.kind === 'none') {
        this.emit('approval.rejected', {
          intentionId: input.intentionId,
          traceId: input.traceId,
          channel: input.channel,
          domain: plan.domain,
          mode: plan.mode,
          status: 'rejected',
        });
        return this.completeTurn(input, plan, startedAt, base, {
          response: freeze({ text: NO_FAILED_OPERATION_TEXT }),
        });
      }
      if (target.kind === 'multiple') {
        const text = renderDisambiguation(target.operations, 'tentar novamente');
        const ambiguousPlan = freeze({ ...plan, missingFields: freeze(['intent']) });
        this.emit('mutation.blocked', {
          intentionId: input.intentionId,
          traceId: input.traceId,
          channel: input.channel,
          domain: plan.domain,
          mode: plan.mode,
          status: 'blocked',
        });
        return this.completeTurn(input, ambiguousPlan, startedAt, base, {
          plan: ambiguousPlan,
          clarification: freeze({ missingFields: ambiguousPlan.missingFields, text }),
          response: freeze({ text }),
        });
      }
      const result = await coordinator.retry(target.operation.id, identity);
      this.emit('approval.confirmed', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'confirmed',
      });
      this.emit('mutation.executed', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'succeeded',
        latencyMs: Date.now() - startedAt,
      });
      return this.completeTurn(input, plan, startedAt, base, {
        mutation: freeze({
          operationId: result.operationId,
          status: 'succeeded' as const,
          ...(result.receipt ? { receipt: result.receipt } : {}),
        }),
        response: freeze({ text: renderMutationResult('succeeded') }),
      });
    } catch {
      this.emit('mutation.blocked', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'blocked',
      });
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: renderMutationResult('failed') }),
      });
    }
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const startedAt = Date.now();
    this.emit('turn.started', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel });
    // F1 (BLOCKER): the DECISION surface of the turn is the text the human
    // typed. `decisionText` is never attachment-derived data, so a document (or
    // a transcription) that says "sim confirmo" cannot reach `confirmation`.
    const decisionText = input.decisionText ?? input.text;
    const plan = this.dependencies.plan?.(input) ?? routeIntent(input.text, decisionText);
    if (plan.version !== '2' || plan.skillNames.length > 2 || plan.requestedOperations.length > 4 || plan.requestedOperations.some((operation) => plan.mode === 'read' && operation.kind === 'mutation')) {
      this.emit('plan.rejected', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, status: 'rejected' });
      this.emit('turn.failed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, status: 'failed', error: 'agent.invalid_turn_plan' });
      throw new Error('agent.invalid_turn_plan');
    }
    this.emit('plan.validated', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode });
    const policy = freeze({ capability: 'financial.read' as const, writeAuthorized: false as const, approvalRequired: true as const, authorizationMode: 'none' as const });
    const result: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy; mutation?: { operationId: string; status: 'proposed' | 'succeeded'; receipt?: MutationReceipt }; response?: { text: string } } = { input, plan: freeze(plan), policy };
    // debt-undo-confirmation-protocol: free text only ever requests an undo
    // proposal (or fails closed). Textual confirmation NEVER executes undo —
    // only the authenticated PWA RPC decides. This check runs before every
    // V2 path so an undo turn can never fall through to a generative or
    // V2-confirmation path.
    const undoTurn = await this.runUndoTurn(input, plan, startedAt, result, decisionText);
    if (undoTurn) return undoTurn;
    // R06/A06 (AC13), review fix 1/2: an ambiguous mutation intent is answered
    // here, BEFORE the draft continuation, before any authoritative read and
    // before the provider. It runs after the undo turn (an explicit undo stays
    // an undo) and after the decision modes below are reached only for their
    // own texts. An active draft is preserved untouched: no CAS, no write.
    const ambiguous = this.ambiguousMutationClarification(input.text);
    if (ambiguous) return this.stopAmbiguousMutation(input, plan, startedAt, result, ambiguous);
    const client = this.dependencies.mutationApiClient;
    // Issue #99 — forget em duas etapas: pedido/confirmação/cancelamento de
    // esquecimento decididos deterministicamente (texto digitado + veto de
    // anexo), com precedência do financeiro quando houver alvo decidível.
    // Null = o pipeline legado/financeiro abaixo é dono do turno.
    const forgetTurn = await this.runForgetDecisionTurn(input, plan, client, startedAt, result, decisionText);
    if (forgetTurn) return forgetTurn;
    // A proposal may never fall through to a generative response when the
    // channel was unable to construct its narrowly-scoped API client (for
    // example, a missing device binding). This keeps every mutation intent on
    // the same pipeline and fails closed without reviving a V1 relay path.
    if (plan.mode === 'mutation-proposal' && !client) {
      return freeze({ ...result, response: freeze({ text: 'Não foi possível preparar a operação com segurança. A sessão precisa de um dispositivo autenticado.' }) });
    }
    if (plan.mode === 'mutation-proposal' && client && !this.dependencies.draftStore) {
      const interpretation = interpretMutationUtterance(input.text);
      if (interpretation.status === 'clarify') {
        // R06/A06 (AC13): ambiguous input stops before any authoritative read.
        const clarification = this.ambiguousClarification(interpretation);
        const blockedPlan = freeze({ ...plan, missingFields: clarification.missingFields });
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...result, plan: blockedPlan, clarification, response: freeze({ text: clarification.text }) });
      }
      if (interpretation.status !== 'candidate') {
        // SPEC §7.6: missing amount/date is a real missing field, never [].
        const missing = interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount' ? ['amount'] : [...plan.missingFields];
        const blockedPlan = freeze({ ...plan, missingFields: freeze([...missing]) });
        const text = interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount'
          ? 'Não identifiquei o valor a registrar. Informe o valor e a descrição.'
          : 'Não foi possível preparar a mutação com segurança. Esclareça valor e descrição.';
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...result, plan: blockedPlan, clarification: freeze({ missingFields: blockedPlan.missingFields, text }), response: freeze({ text }) });
      }
      // SPEC §7.1/§7.2/§7.3 (H-01): resolve accountId/categoryId against
      // authoritative reads BEFORE any proposal. Incomplete args clarify;
      // no pending operation is created on this path (T1.3 persists drafts).
      const parsed = interpretation.parsed;
      const reader = this.dependencies.entityReader ?? {
        listAccounts: async (): Promise<never> => { throw new Error('agent.entity_reader_missing'); },
        listCategories: async (): Promise<never> => { throw new Error('agent.entity_reader_missing'); },
      };
      const resolution = await resolveMutationEntities(parsed, interpretation.resolutionText, reader);
      // A08/R08: re-check existence/activity/scope IMMEDIATELY before the write.
      // Same resolution attempt — no recovery slot, no second loop (A06×A10).
      const verified = resolution.complete ? await revalidateResolvedEntities(resolution, reader) : resolution;
      this.emitEntityResolution(input, plan, verified.trace);
      if (!verified.complete) {
        const incompletePlan = freeze({ ...plan, missingFields: freeze([...verified.missingFields]) });
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...result, plan: incompletePlan, clarification: freeze({ missingFields: incompletePlan.missingFields, text: verified.clarification }), response: freeze({ text: verified.clarification }) });
      }
      const identity: MutationIdentity = { workspaceId: input.workspaceId, actorId: input.actorId, deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })() };
      // SPEC §7.7.1: the no-draft proposal key derives deterministically
      // from the intentionId (same turn → same key, even after a lost
      // response). The API dedups by (workspaceId, key) + payload
      // fingerprint: same key + same payload returns the existing operation
      // (treated as success below); same key + divergent payload is a
      // definitive idempotency.conflict, which propagates — never success.
      const tool = parsed.kind === 'income' ? 'transactions.income.create' : 'transactions.expense.create';
      const normalizedArgs = {
        amountCents: parsed.amountCents,
        description: parsed.description,
        date: parsed.date,
        accountId: verified.accountId,
        categoryId: verified.categoryId,
      };
      // R10 (AC30): the legacy no-draft path has no `completeTurn` terminal,
      // so the attempt is charged here and the snapshot is emitted explicitly
      // on every propose terminal below (`result` is this turn's `base`).
      this.budgetFor(result).noteProposeAttempt();
      const proposal = await client.propose({
        tool,
        normalizedArgs,
        summary: parsed.description,
        identity,
        idempotencyKey: deriveIdempotencyKey(input.workspaceId, input.intentionId, tool),
      });
      // A19 (F1): same attachment veto as the draft path — the two autoexecute entry
      // points must not disagree about what counts as an ineligible turn.
      if (!proposal.existing && isAutoExecutionEligible({ tool, missingFields: [], ambiguity: plan.ambiguity, latestActorText: input.text, attachments: input.attachments }) &&
        !(await client.duplicateSuspectedStrict({ kind: parsed.kind, description: parsed.description, amountCents: parsed.amountCents, date: parsed.date, accountId: verified.accountId }))) {
        const elevated = this.dependencies.autoExecutionClient?.();
        if (elevated) {
          const authorization = await this.authorizeAutoExecution(elevated, proposal.id, identity);
          if (authorization.kind === 'uncertain') { this.emitTurnBudget(result); return freeze({ ...result, response: freeze({ text: renderInconclusive() }) }); }
          if (authorization.kind === 'authorized') {
            try {
              const executed = await new PendingOperationCoordinator({ client: elevated }).executeAuthorized({ operationId: proposal.id, attestation: authorization.attestation }, identity);
              this.emitTurnBudget(result);
              return freeze({ ...result, policy: freeze({ ...policy, authorizationMode: 'auto' }), mutation: freeze({ operationId: executed.operationId, status: 'succeeded', ...(executed.receipt ? { receipt: executed.receipt } : {}) }), response: freeze({ text: `${parsed.kind === 'income' ? 'Receita' : 'Despesa'} de R$ ${(parsed.amountCents / 100).toFixed(2).replace('.', ',')} (${parsed.description}) registrada${verified.accountName ? ` na conta ${verified.accountName}` : ''}. Se quiser, posso desfazer.` }) });
            } catch {
              try {
                const current = await elevated.listActive(identity);
                if (current.items.some((item) => item.id === proposal.id && item.status === 'failed')) {
                  this.emitTurnBudget(result);
                  return freeze({ ...result, response: freeze({ text: renderMutationResult('failed') }) });
                }
              } catch { /* State remains uncertain; keep the inconclusive response. */ }
              this.emitTurnBudget(result);
              return freeze({ ...result, response: freeze({ text: renderInconclusive() }) });
            }
          }
        }
      }
      this.emitTurnBudget(result);
      return freeze({ ...result, policy: freeze({ ...policy, authorizationMode: 'manual' }), mutation: this.proposedMutation({ operationId: proposal.id, tool, normalizedArgs, accountName: verified.accountName, categoryName: verified.categoryName, expiresAt: proposal.operation.expiresAt }), response: freeze({ text: renderMutationResult('proposed', proposal.summary) }) });
    }
    // SPEC §7.8 (ADR-014) with a draft store: the full multi-turn flow
    // (draft persistence, continuation, atomic consumption, recoverable
    // handoff). Without a store the legacy single-turn block above applies.
    if (plan.mode === 'mutation-proposal' && client && this.dependencies.draftStore) {
      return this.runMutationTurn(input, plan, client, startedAt, result);
    }
    // Draft continuation under a non-mutation plan: a bare answer ("Nubank")
    // routes `unsupported`, but with a recoverable draft and a client it is a
    // missing-field answer, not a new turn. Reads keep their normal flow — a
    // balance query never completes a draft.
    if (
      this.dependencies.draftStore && client &&
      (plan.mode === 'unsupported' || plan.mode === 'conversation') &&
      this.hasDraftForTurn(input)
    ) {
      return this.runMutationTurn(input, plan, client, startedAt, result);
    }
    // T1.5 (SPEC §8): confirmation resolves from the AUTHORITATIVE listing
    // (GET /v2/active, authenticated identity) — never from
    // client-declared pendingOperationIds, which are parsed for logging
    // only. Zero → deterministic reply; one → confirm + execute once;
    // several → disambiguation, nothing executed.
    if (plan.mode === 'confirmation' && client) {
      const coordinator = this.coordinatorFor(client);
      const declared = input.pendingOperationIds ?? [];
      const identity: MutationIdentity = { workspaceId: input.workspaceId, actorId: input.actorId, deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })() };
      this.emit('approval.requested', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'requested', declaredOperationCount: declared.length });
      try {
        const target = await coordinator.resolveDecisionTarget(identity, 'decidable', this.draftContext(input));
        if (target.kind === 'none') {
          this.emit('approval.rejected', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'rejected' });
          return this.completeTurn(input, plan, startedAt, result, {
            response: freeze({ text: 'Não há nenhuma operação pendente para confirmar.' }),
          });
        }
        if (target.kind === 'multiple') {
          const text = renderDisambiguation(target.operations, 'confirmar');
          const ambiguousPlan = freeze({ ...plan, missingFields: freeze(['intent']) });
          this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
          return this.completeTurn(input, ambiguousPlan, startedAt, result, {
            plan: ambiguousPlan,
            clarification: freeze({ missingFields: ambiguousPlan.missingFields, text }),
            response: freeze({ text }),
          });
        }
        const confirmed = await coordinator.confirm(target.operation.id, identity);
        this.emit('approval.confirmed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'confirmed' });
        this.emit('mutation.executed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'succeeded', latencyMs: Date.now() - startedAt });
        return this.completeTurn(input, plan, startedAt, result, {
          mutation: freeze({
            operationId: confirmed.operationId,
            status: 'succeeded' as const,
            ...(confirmed.receipt ? { receipt: confirmed.receipt } : {}),
          }),
          response: freeze({ text: renderMutationResult('succeeded') }),
        });
      } catch {
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        return this.completeTurn(input, plan, startedAt, result, {
          response: freeze({ text: renderMutationResult('failed') }),
        });
      }
    }
    if (plan.mode === 'cancel') {
      return this.runCancelTurn(input, plan, client ?? null, startedAt, result);
    }
    // T1.5 conversational retry (§8.2/§13): only when no draft owns the
    // turn — recoverable drafts keep their own re-emission path above.
    if (
      client &&
      isRetryText(decisionText) &&
      (plan.mode === 'unsupported' || plan.mode === 'conversation' || plan.mode === 'confirmation') &&
      !this.hasDraftForTurn(input)
    ) {
      return this.runRetryTurn(input, plan, client, startedAt, result);
    }
    if (plan.mode === 'read' && this.dependencies.evidenceProvider) {
      // Evidence-backed read: deterministic render or validated grounded text.
      const read = await this.runGroundedRead(input, plan, startedAt, result);
      // R10: the grounded read path terminates inside `runGroundedRead` (it
      // never reaches `completeTurn`), so the shared snapshot is emitted here.
      // A settled read is not a clarification: its stop stays `completed`.
      this.emitTurnBudget(result);
      return read;
    }
    // INV-06 fail-closed: an `unsupported` turn that still makes a financial
    // claim (amount pattern or finance noun + claim cue) would otherwise
    // reach the LLM with NO evidence, letting prompt injection fabricate
    // balances. Reply deterministically without calling the provider.
    // Mutation/draft turns return above, so this never intercepts them.
    if (plan.mode === 'unsupported' && makesUnverifiedFinancialClaim(input.text)) {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: false, latencyMs: Date.now() - startedAt });
      return freeze({ ...result, failClosed: true as const, response: freeze({ text: FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT }) });
    }
    const responseText = plan.mode === 'read'
      ? `Consulta preparada para ${plan.domain}.`
      : plan.mode === 'advice' || plan.mode === 'conversation'
        ? 'Posso ajudar com consultas e orientações financeiras. Descreva o que você precisa.'
        : plan.mode === 'unsupported'
          ? 'Não consegui identificar a solicitação com segurança. Explique a consulta ou operação desejada.'
          : 'Não foi possível concluir a solicitação com segurança.';
    if (this.dependencies.responseProvider) {
      // A provider failure is operational, not a successful deterministic
      // response. Adapters map the typed error to their channel contract;
      // swallowing it here would publish a fabricated success after an
      // authority, revocation, or inference failure.
      try {
        // TEDV3-003 defense #2 on the ungrounded publish path too: model
        // text never reaches the user with tool-call markup, and a reply
        // that was ONLY markup degrades to the deterministic fallback for
        // this mode (never empty, never raw markup).
        const raw = await this.dependencies.responseProvider(input, plan);
        const sanitized = stripToolCallMarkup(raw);
        if (sanitized.removedBlocks > 0) {
          this.emit('agent.response.tool_call_sanitized', { intentionId: input.intentionId, traceId: input.traceId, removedBlocks: sanitized.removedBlocks });
        }
        const text = sanitized.changed && sanitized.text === '' ? responseText : sanitized.text;
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...result, response: freeze({ text }) });
      } catch (error) {
        this.emit('turn.failed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'failed', error });
        throw error;
      }
    }
    this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
    return freeze(result);
  }
}
