import { scrubForPersistence } from '../privacy/dlp.js';
import {
  hasMutationIntentSignal,
  interpretMutationUtterance,
  ambiguityClarificationText,
  hasApproximateAmount,
  hasNegation,
  hasUnsupportedCurrency,
  type SemanticInterpretation,
} from '../mutations/semantic-interpretation.js';
import { parseFinancialMutation, parseMoneyToCents, resolveRelativeDateFragment } from '../mutations/financial-parser.js';
import { resolveMutationEntities, revalidateResolvedEntities, entityResolutionSignals, type EntityReader, type EntityResolutionTrace } from '../mutations/entity-resolver.js';
import type { MutationApiClient, MutationIdentity } from '../mutations/mutation-api-client.js';
import { deriveIdempotencyKey } from '../tools/intention-ledger.js';
import {
  CONFIRMATION_OPERATION_SKEW_MS,
  CONFIRMATION_UNBOUND_OPERATION_ID,
  DEFAULT_MAX_PROPOSE_ATTEMPTS,
  DEFAULT_DRAFT_TTL_MS,
  appendDraftRelation,
  appendOriginMessage,
  buildDraftRecord,
  isCancelText,
  isConfirmationExpired,
  isExpired,
  isDefinitiveProposeError,
  isResetText,
  toChannelMessage,
  validateCompleteArgs,
  validateConfirmationReceipt,
  type ConfirmationRecord,
  type ConfirmationSighting,
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
import { renderEmpty, renderInconclusive, renderMutationResult, renderReadAbsence, renderStatement, renderUnavailable, resolveDomainSubject, FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT } from '../responses/deterministic-responses.js';
import { routeIntent } from './intent-router.js';
import { TurnBudget, type RecoveryPermit, type ResolutionRecoveryRequest } from './turn-budget.js';
import { extractAccountsEvidence, renderAccountsAnswer, seeksAccountBalance } from './account-grounding.js';
import { makesUnverifiedFinancialClaim } from './financial-claim-guard.js';
import {
  resolveAttachmentContentQuery,
  type AttachmentContentQuery,
} from './attachment-content-query.js';
import {
  DRAFTS_DISCARDED_NO_OP_TEXT,
  NO_FAILED_OPERATION_TEXT,
  NO_PENDING_CANCEL_TEXT,
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
import type { MessageAudienceStamp } from '../privacy/conversation-visibility.js';
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

/**
 * T08 — deterministic fail-closed reply for an `unsupported` turn carrying
 * ADMITTED attachment data whose composed text trips the financial-claim
 * guard. It names the true cause (unverified attachment content, never
 * affirmed as a ledger record) instead of asserting a ledger-read failure —
 * one cause must never prove the other's. No figures, no instruction
 * surface, ends in guidance to TYPED input (voice as an authorization
 * command stays out of scope). Guard-safe by construction: no digits, no
 * finance noun, so the reply itself could never trip the guard above.
 */
export const ATTACHMENT_CONTENT_UNVERIFIED_TEXT =
  'Não consigo confirmar valores ou saldos só pelo conteúdo do anexo. Diga por texto o que você quer consultar.';

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
   * A19-READ-BYPASS: true ONLY when the turn carries accepted NON-EMPTY
   * attachment extraction (F8 `attachmentData` with real text). Set
   * EXCLUSIVELY by the server adapter via `NormalizeOptions`; `normalize`
   * never reads it from `body`, so a client-supplied same-named field is
   * ignored exactly like `decisionText`. Absent means "no attachment data"
   * — every channel without accepted extraction, unchanged behaviour. A
   * read turn with the flag skips the deterministic evidence render and
   * goes straight to the provider path with the composed text (which
   * already carries the carrier-marked block); all fail-closed paths are
   * untouched.
   */
  hasAttachmentData?: boolean;
  /**
   * A19-GROUND-EVIDENCE: the turn's accepted attachment-extracted texts,
   * admitted as support for grounded READ narration ONLY. Set EXCLUSIVELY
   * by the server adapter via `NormalizeOptions` (the accepted extraction
   * strings, never typed text); `normalize` never reads it from `body`, so
   * a client-supplied same-named field is ignored exactly like
   * `hasAttachmentData`. Absent/empty means "no admitted text" — unchanged
   * behaviour. It is NEVER consulted by mutation, approval, autoexecute or
   * memory paths: the sole consumer is the `createGroundedResponseWithRetry`
   * call in `runGroundedRead`.
   */
  attachmentTexts?: readonly string[];
  /**
   * FIX-AGENT-RELAY-FAILOVER-HARDENING (A): internal-only marker for the
   * structured grounding-correction retry. Set EXCLUSIVELY by the internal
   * `correctionProvider` (channel-evidence.ts); `normalize` always builds it
   * as `false` and ignores any client-supplied same-named field, so user
   * text that literally contains the correction marker can never confer
   * internal status (it persists as a normal user turn).
   */
  internalCorrection?: boolean;
  /**
   * FIX-WS-D3-R2 finding 2: a audiência/conversa do turno, capturada UMA vez
   * pelo adapter servidor ANTES do processamento e vinculada ao turno inteiro
   * (pergunta + resposta + redelivery com stable ids). Set EXCLUSIVAMENTE via
   * `NormalizeOptions` — `normalize` nunca lê do `body`, então um campo
   * `audience` enviado pelo cliente é ignorado como `decisionText`.
   * Ausente = o consumidor consulta o registry (comportamento anterior).
   */
  audience?: MessageAudienceStamp;
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
  // Non-possessive forms: these subjects complete "Não há ${subject}…" and
  // "Ainda não encontrei ${subject}…", where the possessive DOMAIN_SUBJECT_PT_BR
  // forms ("seus cartões") would break the grammar. Never reuse that map here.
  // `cards` names the READING (`OPERATION_TO_READ.list_cards` resolves to the
  // statements read `/cards/statements` = faturas — channel-evidence.ts), not
  // the requested domain: an empty statement list proves no faturas in scope,
  // never the absence of cards (listing cards is the separate `/cards/accounts`
  // read), so claiming "no cartões" here would be false when cards exist
  // without statements in the period.
  cards: 'faturas',
  payables: 'contas a pagar',
  budgets: 'orçamentos',
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
 * FIX-170 (d) — the stable impasse copy for a category answer that adds no
 * new information (identical repeat of the stored query) and still does not
 * resolve. It names the impasse, lists no invented row and promises no
 * creation; repeats converge HERE instead of re-asking the same question
 * forever. Any NEW answer ('mercado' after 'xyz') leaves this state at once.
 */
const CATEGORY_IMPASSE_TEXT =
  'Ainda não consegui definir a categoria. Escolha uma das categorias existentes do seu catálogo — não crio categorias novas.';

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

/**
 * P1-5.1 (DESFAZ) — deterministic copies for the desfaz/cancel-vs-undo
 * arbitration in `runUndoTurn`/`runCancelTurn`. Exported so the precedence
 * suite pins the exact wording; the routing itself owns when each fires.
 */
export const UNDO_CANCEL_TWO_TARGET_TEXT =
  'Você tem uma operação pendente aguardando confirmação e uma ação anterior que pode ser desfeita. Quer cancelar a operação pendente ou desfazer a ação anterior? Responda "cancela a pendente" ou "desfaz a anterior".';
export const NOTHING_TO_UNDO_OR_CANCEL_TEXT = 'Não há nada para desfazer ou cancelar.';
export const CANCEL_NEGATION_TEXT = 'Entendido — nada foi cancelado.';

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

/**
 * Review round 4 P1-B: detects the API's authoritative intention-conflict
 * refusal (`approval.intention_conflict`): THIS intentionId is already bound
 * API-side to a DIFFERENT operation. Matches the error code field, the
 * statusCode-tagged message, or the code inside the message — the transport
 * shapes it differently across the real client (thrown `Error` carrying
 * `code`/`statusCode`) and test doubles (plain `Error(message)`).
 */
const isIntentionConflictError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  if (record.code === 'approval.intention_conflict') return true;
  return (
    record.statusCode === 409 &&
    typeof record.message === 'string' &&
    record.message.includes('approval.intention_conflict')
  );
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

// FIX-170 — the BARE NAME. A short answer to the pending category question
// ("mercado", "supermercado", "alimentação > mercado") carries no amount, so
// it is never a candidate interpretation of its own (R03/A03 intact: the flag
// stays structurally unavailable on the fresh path). A leading negation
// ("não, transporte") names the REPLACEMENT, not a retraction — a bare "não"
// keeps its fail-closed clarification. Guards mirror the fragment's (no
// digits, bounded length/words, no sentence punctuation); separators (`>`,
// `/`, `:`) take the last segment. `fromFragment: false` on purpose: a bare
// answer keeps the pre-existing account-hint behavior (fix-5's exclusion
// stays exclusive to `de X` fragments), so an account answer to a
// both-pending draft still resolves the account.
const CATEGORY_NEGATION_PREFIX = /^\s*(?:n[aã]o|nunca|jamais)\s*,?\s+(.+?)\s*$/iu;
// FIX-169-170-R2 (P2-3): a vírgula separa a ALTERNATIVA ('não, transporte' =>
// a resposta é 'transporte') da INSTRUÇÃO negativa ('não use mercado' => o
// usuário recusa, não responde — nunca vira query). Sem a vírgula, despir o
// prefixo produzia 'use mercado' e o substring casava Mercado: a rejeição
// virava seleção.
const CATEGORY_NEGATION_REPLACEMENT = /^\s*(?:n[aã]o|nunca|jamais)\s*,\s*(.+?)\s*$/iu;
const CATEGORY_SEGMENT_SPLIT = /[>/:|\\]+/u;
const CATEGORY_BARE_MAX_WORDS = 4;
const CATEGORY_BARE_INNER_PUNCT = /[.?!,;:"“”'‘’]/u;

const categoryQueryFrom = (
  text: string,
  options: Readonly<{ allowBareFragment?: boolean }> = {},
): { query: string; fromFragment: boolean; bare?: boolean } | undefined => {
  // FIX-169-170-R2 (P2-3): 'não, X' responde X (alternativa); 'não <verbo> X'
  // sem vírgula é instrução negativa e NUNCA vira query — nem via o `de X`,
  // nem via o bare, nem via o explícito 'categoria X'. Retornar undefined
  // mantém o esclarecimento fail-closed com o draft ativo (sem proposta).
  const replacement = CATEGORY_NEGATION_REPLACEMENT.exec(text)?.[1]?.trim();
  if (replacement !== undefined) {
    if (!replacement) return undefined;
    // FIX-169-170-R3 (MEDIUM): 'não, NÃO QUERO mercado' despia só o primeiro
    // prefixo e o resto ('não quero mercado') casava Mercado por substring —
    // a rejeição virava seleção. Desempilha prefixos aninhados e RE-VALIDA o
    // resto: se ainda for negação/instrução negativa, nunca vira query.
    let rest = replacement;
    for (let depth = 0; depth < 3; depth++) {
      const inner = CATEGORY_NEGATION_REPLACEMENT.exec(rest)?.[1]?.trim();
      if (inner === undefined) break;
      if (!inner) return undefined;
      rest = inner;
    }
    if (!rest || CATEGORY_NEGATION_PREFIX.test(rest)) return undefined;
    // FIX-169-170-R4 (REVIEW-169-170-R3): negações repetidas sem espaço
    // pós-vírgula ('não,não,…não quero categoria mercado') esgotam o bound-3
    // do loop acima e o resto ('não,não quero categoria mercado') não casa
    // CATEGORY_NEGATION_PREFIX (exige espaço após a negação) — o CATEGORY_PHRASE
    // extraía 'mercado' e a rejeição virava seleção. Se o resto AINDA começa
    // com marcador de negação (com ou sem vírgula/espaço), fail-closed: sem
    // proposta, draft preservado. 'não, transporte' (resto limpo) segue
    // funcionando; 'não,não transporte' também retorna undefined (conservador).
    if (/^\s*(?:n[aã]o|nunca|jamais)\s*,?\s*/iu.test(rest)) return undefined;
    text = rest;
  } else if (CATEGORY_NEGATION_PREFIX.test(text)) {
    return undefined;
  }
  const explicit = CATEGORY_PHRASE.exec(text)?.[1]?.trim();
  if (explicit) return explicit ? { query: explicit, fromFragment: false } : undefined;
  if (!options.allowBareFragment) return undefined;
  const fragment = CATEGORY_FRAGMENT.exec(text)?.[1]?.trim();
  if (fragment && fragment.length <= CATEGORY_FRAGMENT_MAX && !/\d/.test(fragment)) {
    return { query: fragment, fromFragment: true };
  }
  const segment = text.split(CATEGORY_SEGMENT_SPLIT).map((part) => part.trim()).filter((part) => part.length > 0).pop() ?? '';
  const bare = segment.replace(/[.?!,;)\]}]+$/u, '').trim();
  if (!bare || bare.length > CATEGORY_FRAGMENT_MAX || /\d/.test(bare)) return undefined;
  // A lone negation ("não") answers nothing: it keeps the pre-existing
  // fail-closed path instead of becoming a category query.
  if (/^(?:n[aã]o|nunca|jamais)$/iu.test(bare)) return undefined;
  if (bare.split(/\s+/u).length > CATEGORY_BARE_MAX_WORDS) return undefined;
  if (CATEGORY_BARE_INNER_PUNCT.test(bare)) return undefined;
  return { query: bare, fromFragment: false, bare: true };
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

/**
 * Issue #255 review round 2 (P1) — a monetary alternative ("2500 ou 250")
 * is a question, never a value. Follow-up guard, checked BEFORE any write.
 *
 * Parity note (verified 2026-10-19): the FRESH path does NOT reject `ou` —
 * `parseFinancialMutation` only fails `e`/`mais`/`+` via
 * `secondAmountConnector`, so a fresh "comprei 2500 ou 250 …" takes the FIRST
 * value. The follow-up is intentionally stricter: filling the amount sentinel
 * with the first branch would invent the user's choice. A fresh-path change
 * is deliberately out of scope here.
 */
const MONETARY_ALTERNATIVE = /(\d[\d.,]*)\s+ou\s+(\d[\d.,]*)/iu;
const ALTERNATIVE_AMOUNT_TEXT =
  'Identifiquei dois valores na sua mensagem. Informe um único valor em reais para eu registrar.';
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

/**
 * P1-5.1 (DESFAZ) — a negated cancel/undo ("não cancela", "não desfaz",
 * "desfaz não", "nunca cancela") is a refusal, never a decision. It must
 * reach neither the cancel path nor the undo-proposal path. Checked against
 * the DECISION text only — attachment-derived data never decides.
 */
const isCancelNegation = (text: string): boolean =>
  NEGATION_MARKER.test(text ?? '') && (isCancelText(text ?? '') || hasUndoIntent(text ?? ''));

/**
 * P1-REVIEWFIX (P2) — the two explicit answers to the two-target
 * clarification (`UNDO_CANCEL_TWO_TARGET_TEXT`). Honored ONLY when both
 * targets are still present (pending + undo-eligible); anywhere else the
 * turn keeps its normal routing. Folded (case/diacritic/whitespace/trailing
 * punctuation) so "DESFAZ A ANTERIOR." answers exactly like
 * "desfaz a anterior". Full-string anchored: a longer sentence is not a
 * direct answer and re-clarifies instead of executing.
 */
const foldSelectorText = (text: string): string =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!…]+$/u, '');

const UNDO_PREVIOUS_SELECTOR_RE =
  /^(?:(?:desfaz(?:er)?|desfaca|undo)\s+(?:a\s+)?(?:acao\s+)?anterior|a\s+(?:acao\s+)?anterior|anterior)$/;
const UNDO_PENDING_SELECTOR_RE =
  /^(?:(?:cancela(?:r)?|cancele|desfaz(?:er)?|desfaca|undo)\s+(?:a\s+)?pendente|a\s+pendente|pendente)$/;
const isUndoPreviousSelector = (text: string): boolean =>
  UNDO_PREVIOUS_SELECTOR_RE.test(foldSelectorText(text));
const isUndoPendingSelector = (text: string): boolean =>
  UNDO_PENDING_SELECTOR_RE.test(foldSelectorText(text));

/**
 * CORREÇÃO 2 (P2-2) — the missing-amount gate's exclusion lists, tested
 * against the FOLDED text (case/diacritic/whitespace-normalized) in ANY
 * position: an interrogative word or a `?` marks a question (a read, never
 * a missing amount), and a read cue (`mostra`, `extrato`, …) marks an
 * explicit read request the evidence layer must answer.
 */
const MISSING_AMOUNT_INTERROGATIVE_RE =
  /\b(?:quanto|quantos|quantas|qual|quais|onde|quando|como|por\s*que|porque|quem)\b/;
const MISSING_AMOUNT_READ_CUE_RE =
  /\b(?:mostra|mostre|mostrar|lista|liste|listar|exibe|exibir|ver|veja|consulta|consultar|extrato|historico|resumo)\b/;

/**
 * Issue #255 (a) — partial draft helpers. A turn that carries a mutation
 * signal but no parseable value persists a PARTIAL draft (amount sentinel)
 * instead of answering statelessly, so a follow-up value can resume it.
 * R06/A06 intact: no value is ever invented — the sentinel (`0`) fails
 * `validateCompleteArgs`, and only a deterministically parsed follow-up
 * amount fills it.
 */
const PARTIAL_DRAFT_AMOUNT_SENTINEL = 0;
const PARTIAL_DRAFT_QUESTION =
  'Não identifiquei o valor a registrar. Informe o valor e a descrição.';

/**
 * Issue #255 review fix (HIGH) — a partial draft's missing `amount` survives
 * every continuation write while the sentinel (<= 0) persists. An entity
 * answer ("categoria mercado") must not drop it from `missingFields`, or the
 * later value ("2500") finds no pending field to fill and the draft becomes
 * unrecoverable.
 */
const withPartialAmountPending = (missing: readonly string[], current: MutationDraftRecord): string[] =>
  (!Number.isInteger(current.resolvedArgs.amountCents) || current.resolvedArgs.amountCents <= 0) &&
  current.missingFields.includes('amount') &&
  !missing.includes('amount')
    ? ['amount', ...missing]
    : [...missing];

/** A pure read never continues a draft — even a partial one (anti-hijack). */
const isPureReadForDraft = (text: string): boolean => {
  if (seeksAccountBalance(text)) return true;
  const folded = foldSelectorText(text);
  if (/\?/.test(text)) return true;
  if (MISSING_AMOUNT_INTERROGATIVE_RE.test(folded)) return true;
  if (MISSING_AMOUNT_READ_CUE_RE.test(folded)) return true;
  return false;
};

/**
 * A follow-up value WITHOUT a finite verb ("2500", "2500 sendo 10x 250 com
 * o cartão nubank"). The synthetic `comprei` prefix reuses the parser's own
 * installment guard, so "10x 250" never becomes R$10 — the amount sits after
 * "de" or leads the turn and is matched (or not) on its own. Bare tokens
 * ("2500", "R$ 2500") are accepted only as the WHOLE turn.
 */
const followUpAmountCents = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const bare = /^\s*(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:[.,]\d{1,2})?)\s*(?:reais?|rs\.?)?\s*$/iu.exec(trimmed)?.[1];
  if (bare !== undefined) {
    try {
      const cents = parseMoneyToCents(bare);
      if (Number.isInteger(cents) && cents > 0) return cents;
    } catch {
      // Fall through to the synthetic parse below.
    }
  }
  const synthetic = parseFinancialMutation(`comprei ${trimmed}`);
  if (synthetic.kind !== 'none' && Number.isInteger(synthetic.amountCents) && synthetic.amountCents > 0) {
    return synthetic.amountCents;
  }
  return undefined;
};

const inferPartialKind = (text: string): 'expense' | 'income' =>
  /\b(?:gastei|gasto|comprei|compra|despesa|paguei)\b/i.test(text)
    ? 'expense'
    : /\b(?:recebi|ganhei|entrou|renda|sal[aá]rio|receita)\b/i.test(text)
      ? 'income'
      : 'expense';

/** Keeps a human-readable fragment ("bicicleta"), never the whole sentence. */
const partialDescription = (text: string): string => {
  const stripped = text
    .trim()
    .replace(/^(?:comprei|gastei|gasto|paguei|recebi|ganhei|entrou|lancei|lan[cç]ar)\s+(?:uma?|o|a|os|as)?\s*/i, '')
    .replace(/\s*(?:parcela|parcelas|presta[cç](?:[aã]o(?:es)?|[oõ]es)?|vezes|\bx\b).*$/i, '')
    .trim();
  return (stripped || text.trim()).slice(0, 280);
};

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
export type NormalizeOptions = Readonly<{ typedText?: string; hasAttachmentData?: boolean; attachmentTexts?: readonly string[]; audience?: MessageAudienceStamp }>;

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
  // A19-READ-BYPASS: the attachment-data flag is server-side only — a
  // client-supplied `hasAttachmentData` field in `body` is deliberately NOT
  // read, so untrusted input can never route its own turn past the
  // deterministic render.
  const hasAttachmentData = options?.hasAttachmentData === true ? true as const : undefined;
  // A19-GROUND-EVIDENCE: admitted attachment texts are server-side only —
  // a client-supplied `attachmentTexts` field in `body` is deliberately NOT
  // read, so untrusted input can never ground its own figures. Only
  // non-empty strings travel; empties are dropped here, not downstream.
  const attachmentTexts = Array.isArray(options?.attachmentTexts)
    ? options.attachmentTexts.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
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
    ...(hasAttachmentData !== undefined ? { hasAttachmentData } : {}),
    ...(attachmentTexts.length > 0 ? { attachmentTexts: freeze(attachmentTexts) } : {}),
    // FIX-AGENT-RELAY-FAILOVER-HARDENING (A): the internal correction flag
    // is constructed here as `false` — any client-supplied `internalCorrection`
    // / `isInternalCorrectionRetry` field in `body` is deliberately NOT read,
    // so untrusted text can never mark its own turn as an internal retry.
    internalCorrection: false,
    // FIX-WS-D3-R2 finding 2: audiência do turno vem SÓ das opções
    // server-side — `body.audience` é deliberadamente ignorado.
    ...(options?.audience ? { audience: freeze({ ...options.audience }) } : {}),
    ...(pendingOperationIds ? { pendingOperationIds: freeze(pendingOperationIds) } : {}),
  });
};

export const normalizeRestTurn = (body: Body, identity: AuthenticatedIdentity, options?: NormalizeOptions): TurnInput => normalize(body, identity, 'pwa-rest', options);
export const normalizeSdkTurn = (body: Body, identity: AuthenticatedIdentity, options?: NormalizeOptions): TurnInput => normalize(body, identity, 'sdk', options);
export const normalizeBrokerTurn = (body: Body, identity: AuthenticatedIdentity, options?: NormalizeOptions): TurnInput => normalize(body, identity, 'broker', options);

/**
 * P0-ATTACHMENT-BYPASS: true when an `ok` envelope item carries usable rows.
 * An `ok` item with `null`/`undefined`, an empty array or an empty object is
 * an empty tool envelope — it never authorizes the attachment bypass.
 */
const hasEvidenceData = (data: unknown): boolean => {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') return Object.keys(data).length > 0;
  return true;
};

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
    /**
     * REVIEW-P1 (attachment-content-query): tool-free single-inference
     * provider for generative content queries, wired by the channel adapter
     * (`provideContentQueryResponse`: relay/broker single transports, SDK
     * `generateText` with NO tools). The terminal prefers it over
     * `responseProvider`, so a content query can never run the tool-carrying
     * SDK path (`streamText` + `stepCountIs`). Absent = the common provider
     * (tests/back-compat; production always wires it).
     */
    contentQueryProvider?: TurnResponseProvider;
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

  /**
   * R6 (PR137-FIX): ids this turn NEWLY presented (proposal card,
   * disambiguation set, pre-claim refresh) whose response may still fail to
   * reach the channel. Pre-existing rows are never ledgered (first-wins —
   * they predate this turn, typically an earlier PUBLISHED card). Reset at
   * every `runTurn` entry; consumed by
   * `revertUnpublishedTurnPresentations`. Production builds one orchestrator
   * per turn, so the ledger never outlives its turn there.
   */
  private unpublishedPresentationLedger: Array<{ ctx: DraftContext; operationIds: string[] }> = [];

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

  /**
   * CORREÇÃO 2 (P2-2) — deterministic missing-amount terminal, single
   * implementation. Fires on `read` AND `unsupported` turns whose text
   * carries a mutation signal yet parses to nothing for lack of a value
   * ("comprei uma bicicleta no cartão", "comprei uma bicicleta parcela em
   * 10 x"): neither an evidence read nor a model call can supply the absent
   * amount, and routing the turn on would let the model promise a
   * registration it cannot make. Returns null when the turn is not eligible.
   *
   * The gate is channel- and provider-independent: with no value, no
   * inference path — with or without tools — can execute the creation (a
   * creation tool only executes with a value), and a tool-less single-shot
   * path (relay, grounded, Codex broker) cannot clarify conversationally
   * either. The deterministic clarification is therefore the honest answer
   * on every channel. There is deliberately NO per-channel exception: the
   * SDK direct leg also reaches the tool-less Codex broker leg
   * (`provideUnifiedResponse` → `isCodexProviderId` → `runCodexBrokerText`),
   * where an amount-less turn would fall through to the model with no
   * evidence and no tools — exactly what this gate prevents.
   *
   * Eligibility: mutation signal + `unparsed`/`missing_amount`, and NOT an
   * interrogative (`?` or a question word anywhere — a question is a read)
   * and NOT an explicit read request (read cue anywhere — the evidence
   * layer owns it). Attachment turns are eligible too but answer with the
   * attachment fail-closed copy: admitted content is unverified, so the
   * missing-amount copy must not speak over it. Draft/mutation/
   * confirmation/cancel/retry turns return above this gate and never reach
   * it; the T08-F1 branch below keeps owning the non-eligible
   * unsupported+attachment turns.
   */
  private missingAmountGate(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
  ): TurnResult | null {
    if (plan.mode !== 'read' && plan.mode !== 'unsupported') return null;
    if (!hasMutationIntentSignal(input.text)) return null;
    const interpretation = interpretMutationUtterance(input.text);
    if (interpretation.status !== 'unparsed' || interpretation.reason !== 'missing_amount') return null;
    const folded = foldSelectorText(input.text);
    if (/\?/.test(input.text)) return null;
    if (MISSING_AMOUNT_INTERROGATIVE_RE.test(folded)) return null;
    if (MISSING_AMOUNT_READ_CUE_RE.test(folded)) return null;
    const attachment = input.hasAttachmentData === true;
    const text = attachment
      ? ATTACHMENT_CONTENT_UNVERIFIED_TEXT
      : PARTIAL_DRAFT_QUESTION;
    const blockedPlan = freeze({ ...plan, missingFields: freeze(['amount']) });
    // Issue #255 (a): persist the partial draft BEFORE answering, so a
    // follow-up value resumes THIS intention. No store (legacy/contract
    // paths) = stateless copy, byte-identical to before.
    const draft = attachment ? undefined : this.getOrCreatePartialDraft(input);
    const clarification = draft
      ? freeze({ missingFields: blockedPlan.missingFields, text, draft: toChannelMessage(draft, text) })
      : freeze({ missingFields: blockedPlan.missingFields, text });
    this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: false, latencyMs: Date.now() - startedAt });
    return freeze({
      ...base,
      plan: blockedPlan,
      ...(attachment ? { failClosed: true as const } : {}),
      clarification,
      response: freeze({ text }),
    });
  }

  /**
   * Issue #255 (a) — builds (or reuses by intention) the partial draft for
   * an amount-less mutation turn. Sentinel amount `0` fails
   * `validateCompleteArgs`, so nothing can propose or execute until a
   * follow-up supplies a real value. Never throws: a store failure falls
   * back to the stateless copy.
   */
  private getOrCreatePartialDraft(input: TurnInput): MutationDraftRecord | undefined {
    const store = this.dependencies.draftStore;
    if (!store) return undefined;
    try {
      const ctx = this.draftContext(input);
      const now = this.draftNowMs();
      const redelivered = store.findByIntention(ctx, input.intentionId);
      if (redelivered) return redelivered;
      if (store.listActive(ctx, now).length > 0 || store.listProposing(ctx, now).length > 0) return undefined;
      const nowDate = new Date(now);
      // Issue #255 review fix (MEDIUM) — the opening turn's relative date
      // fragment ("comprei uma bicicleta ontem") dates the partial through
      // the parser's own `dateFor` (same timezone as the fresh path), instead
      // of always stamping today. No fragment (or an ambiguous one) keeps the
      // previous today-fallback; an ambiguous fragment is not a guess.
      const fragment = resolveRelativeDateFragment(input.text, { now: nowDate });
      const fallback = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(nowDate) + 'T12:00:00Z');
      const fallbackDate = Number.isNaN(fallback.getTime()) ? new Date(now).toISOString().slice(0, 10) : fallback.toISOString().slice(0, 10);
      const date = fragment.status === 'date' ? fragment.date : fallbackDate;
      const kind = inferPartialKind(input.text);
      const dateRaw = fragment.status === 'date' ? (/\b(anteontem|ontem|hoje)\b/i.exec(input.text)?.[1] ?? '') : '';
      const candidate = buildDraftRecord({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        deviceId: ctx.deviceId,
        intentionId: input.intentionId,
        tool: kind === 'income' ? 'transactions.income.create' : 'transactions.expense.create',
        resolvedArgs: {
          kind,
          amountCents: PARTIAL_DRAFT_AMOUNT_SENTINEL,
          description: partialDescription(input.text),
          date,
        },
        missingFields: ['amount'],
        question: PARTIAL_DRAFT_QUESTION,
        ttlMs: this.dependencies.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS,
        nowMs: now,
        // The relative date came from the user's own token — provenance keeps
        // the fragment so a later correction has a baseline to point at.
        ...(fragment.status === 'date'
          ? { fieldProvenance: { date: { source: 'token' as const, raw: dateRaw, value: date } } }
          : {}),
      });
      return store.getOrCreate(candidate).record;
    } catch {
      return undefined;
    }
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
    // P0-ATTACHMENT-BYPASS: the deterministic render is skipped ONLY for a
    // turn carrying accepted attachment extraction AND a tool envelope with
    // usable rows. With an empty tool envelope the turn stays on the
    // deterministic path (absence render or figure-free unavailability) — a
    // block figure with no tool evidence never reaches the provider as
    // grounded narration. Every fail-closed path above (null/error
    // envelopes) and below (no provider, grounding rejection) is preserved.
    const hasAttachmentData = input.hasAttachmentData === true;
    const hasUsableToolData = (envelope?.items ?? []).some(
      (item) => item.status === 'ok' && hasEvidenceData(item.data),
    );
    if (!hasAttachmentData || !hasUsableToolData) {
      const deterministic = this.renderDeterministicFromEvidence(input, plan, envelope);
      if (deterministic !== null) {
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...base, response: freeze({ text: deterministic }) });
      }
    }
    if (!this.dependencies.responseProvider) {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
      return freeze({ ...base, response: freeze({ text: renderUnavailable(resolveDomainSubject(plan.domain)) }) });
    }
    // Provider failures are operational, never a fabricated success.
    const text = await this.dependencies.responseProvider(input, plan);
    // A19-GROUND-EVIDENCE: the admitted attachment texts (server-side
    // accepted extractions, absent without them) join grounded validation
    // as source-tagged support for READ narration — a block-cited figure
    // publishes instead of collapsing into a tool-failure excuse, while a
    // figure present in NEITHER still fails. Fail-closed paths above and
    // the no-provider path are untouched.
    const grounded = await createGroundedResponseWithRetry(text, envelope, {
      fallbackSubject: resolveDomainSubject(plan.domain),
      ...(input.attachmentTexts && input.attachmentTexts.length > 0 ? { attachmentTexts: input.attachmentTexts } : {}),
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

  /**
   * ATTACHMENT-CONTENT-QUERY terminal: answers the typed question from the
   * admitted attachment block only. Never calls the evidence provider (zero
   * financial reads), never proposes/executes, never touches the draft store
   * (a recoverable draft stays active and untouched — no INV-10 capture).
   *
   * - verbatim: deterministic repeat of the admitted texts, no provider call;
   * - generative: ONE tool-free inference (`contentQueryProvider`, wired by
   *   the channel adapter — never the tool-carrying common provider) whose
   *   reply is validated against the admitted texts as document provenance
   *   (audio / transcript attribution admitted — see `DOCUMENT_NOUN`), with
   *   an empty financial envelope: figures or names present in NEITHER still
   *   fail.
   */
  private async runAttachmentContentQuery(
    input: TurnInput,
    plan: TurnPlan,
    query: AttachmentContentQuery,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
  ): Promise<TurnResult> {
    if (query.verbatim) {
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: query.admitted.join('\n\n') }),
      });
    }
    const provider = this.dependencies.contentQueryProvider ?? this.dependencies.responseProvider;
    if (!provider) {
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: renderUnavailable('o conteúdo do anexo') }),
      });
    }
    const text = await provider(input, plan);
    const envelope: EvidenceEnvelope = freeze({ version: '1' as const, items: freeze([]) });
    const grounded = await createGroundedResponseWithRetry(text, envelope, {
      fallbackSubject: 'o conteúdo do anexo',
      attachmentTexts: query.admitted,
      sink: (eventType, fields) => this.emit(eventType, fields),
      intentionId: input.intentionId,
      traceId: input.traceId,
      // R10: the ONE correction retry spends a slot of the shared per-turn
      // recovery budget, mirroring the read path.
      onRecoveryAttempted: () => { this.budgetFor(base).noteGroundingRetry(); },
    });
    this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: grounded.grounded, latencyMs: Date.now() - startedAt });
    this.emitTurnBudget(base);
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

  /**
   * PR137-HARDEN (Bloco A): fail-closed terminal for the FINANCIAL
   * confirmation path only. Non-financial confirmations (forget-memory
   * two-step, undo RPC, reads) never reach this helper — they own their
   * stores and their own fail-closed copies.
   */
  private inconclusiveConfirmationTurn(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    reason: string,
  ): TurnResult {
    this.emit('mutation.blocked', {
      intentionId: input.intentionId,
      traceId: input.traceId,
      channel: input.channel,
      domain: plan.domain,
      mode: plan.mode,
      status: 'blocked',
      reason,
    });
    return this.completeTurn(input, plan, startedAt, base, {
      response: freeze({ text: renderInconclusive() }),
    });
  }

  /**
   * Review round 4 P1-A3: records WHAT was shown (single target or
   * disambiguation set) with WHEN, best-effort, for FUTURE turns. It runs
   * only where THIS turn EFFECTIVELY presents the target to the user —
   * proposal cards, the disambiguation listing (which renders the set), or
   * AFTER the admission checks passed (pre-claim refresh) — never on a
   * rejection path: a rejection answers only `renderInconclusive()` (no card
   * of B), so recording there would forge a testimony without exhibition
   * (ROUND5-1). It runs after the admission checks, never before them, where
   * a just-recorded row could self-authorize the current turn when the clock
   * does not advance between anchor and listing. This also self-heals
   * operations proposed before this hardening: the first "sim" presents
   * fail-closed, the next confirms.
   *
   * R6 (PR137-FIX): ledgers ONLY the ids this turn newly presents. A row
   * that already exists predates this turn (first-presentation-wins — the
   * earliest instant is kept, typically an earlier PUBLISHED card) and must
   * survive a compensation of this turn, so it is NOT ledgered. The
   * find+write below are synchronous with no await between, so no
   * interleaved turn can slip in. The ledger feeds
   * `revertUnpublishedTurnPresentations` when the response never reaches
   * the channel.
   */
  private recordPresentedOperations(
    store: MutationDraftStore,
    ctx: DraftContext,
    operationIds: readonly string[],
  ): void {
    let fresh: string[] = [];
    try {
      if (typeof store.findConfirmationPresentation === 'function') {
        fresh = operationIds.filter(
          (operationId) => !!operationId && !store.findConfirmationPresentation?.(ctx, operationId),
        );
      } else {
        fresh = operationIds.filter((operationId) => !!operationId);
      }
      store.noteConfirmationPresentation?.({ ctx, operationIds, nowMs: this.draftNowMs() });
    } catch {
      // Best-effort presentation bookkeeping only.
      fresh = [];
    }
    if (fresh.length > 0) {
      this.unpublishedPresentationLedger.push({ ctx, operationIds: fresh });
    }
  }

  /**
   * R6 (PR137-FIX): best-effort compensation for witnesses this turn wrote
   * but never published. The caller (channel adapter) invokes it when the
   * turn's response demonstrably never reached the channel — a send/persist
   * failure or a post-`runTurn` error before the send — so a later intention
   * cannot confirm an operation whose card was never exhibited. Deletes ONLY
   * the ledgered (this-turn, newly-presented) ids; pre-existing rows from
   * earlier published cards are kept. Never throws; clears the ledger either
   * way. Rejections write no witness (ROUND5-1), so there is nothing to
   * compensate on those paths.
   */
  revertUnpublishedTurnPresentations(): void {
    const ledger = this.unpublishedPresentationLedger;
    this.unpublishedPresentationLedger = [];
    if (ledger.length === 0) return;
    const store = this.dependencies.draftStore;
    if (!store || typeof store.forgetConfirmationPresentations !== 'function') return;
    try {
      for (const entry of ledger) {
        store.forgetConfirmationPresentations(entry.ctx, entry.operationIds);
      }
    } catch {
      // Compensation never breaks the caller.
    }
  }

  /**
   * PR137-HARDEN (Bloco A): resolves a durable identity→operationId binding
   * WITHOUT ever re-resolving the live listing for a new target — a
   * redelivery replays or preserves A, never confirms a later B.
   *
   * - `inconclusive` → inconclusive (terminal, claims nothing);
   * - unbound sentinel (`operationId === ''`) → inconclusive WITHOUT
   *   consulting the listing (P1-2/P1-4: never resolves a later B);
   * - `reserved` → the pre-execute crash window: reconcile by operationId.
   *   Still decidable — INCLUDING `executing` (P1-1: the API applies the
   *   effect under `executing`, so a mid-execution redelivery must NOT
   *   settle) ⇒ inconclusive WITHOUT executing and WITHOUT settling: only
   *   the claim winner drives, and the `reserved` row stays settleable to
   *   `succeeded` when the winner completes. Terminal ⇒ settle inconclusive
   *   + inconclusive (the effect may be ours or another device's cancel —
   *   indistinguishable, so no success claim). A fresh intentionId
   *   re-resolves and confirms the still-pending op normally. Never executes
   *   here, so concurrent losers can never double-effect even against a
   *   transport without dedup;
   * - `succeeded` + unexpired + valid/absent receipt → verbatim replay;
   * - `succeeded` + expired (tombstone) or invalid receipt → reconcile by
   *   operationId: terminal ⇒ replay (receipt when valid, else receipt-less
   *   — the binding, written strictly post-success, is the proof); still
   *   active or unreadable listing ⇒ inconclusive, original op preserved.
   */
  private async replayConfirmationBinding(args: {
    prior: ConfirmationRecord;
    coordinator: PendingOperationCoordinator;
    identity: MutationIdentity;
    input: TurnInput;
    plan: TurnPlan;
    startedAt: number;
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy };
  }): Promise<TurnResult> {
    const { prior, coordinator, identity, input, plan, startedAt, base } = args;
    const store = this.dependencies.draftStore;
    const nowMs = this.draftNowMs();
    // GW-023 convergence: a redelivery of an inconclusive-settled BOUND
    // intention reconciles against the authoritative listing instead of
    // blindly replaying inconclusive. Bound op terminal AND listing empty ⇒
    // nothing is pending (truthful, zero mutation, no success/failure claim).
    // Any active op or an unreadable listing stays inconclusive. The unbound
    // sentinel below never consults the listing (P1-2/P1-4).
    if (prior.status === 'inconclusive' && prior.operationId !== CONFIRMATION_UNBOUND_OPERATION_ID) {
      try {
        const current = await coordinator.listActive(identity);
        if (current.length === 0) {
          return this.completeTurn(input, plan, startedAt, base, {
            response: freeze({ text: 'Não há nenhuma operação pendente para confirmar.' }),
          });
        }
      } catch {
        // Unreadable listing: fall through to inconclusive below.
      }
      return this.inconclusiveConfirmationTurn(input, plan, startedAt, base, 'confirmation_binding_inconclusive');
    }
    if (prior.status === 'inconclusive') {
      return this.inconclusiveConfirmationTurn(input, plan, startedAt, base, 'confirmation_binding_inconclusive');
    }
    // Review fix P1-2/P1-4: unbound sighting sentinel — this intention was
    // seen before but never bound a target (no decidable op, ambiguous
    // listing, or failed claim). A redelivery reproduces inconclusive
    // WITHOUT consulting the listing, so a LATER operation B can never be
    // resolved-and-confirmed under this intention; only a fresh turn with a
    // new intentionId may confirm B.
    if (prior.operationId === CONFIRMATION_UNBOUND_OPERATION_ID) {
      return this.inconclusiveConfirmationTurn(input, plan, startedAt, base, 'confirmation_sentinel_replay');
    }
    const expired = isConfirmationExpired(prior, nowMs);
    const validated = validateConfirmationReceipt(prior.receiptJson, prior.operationId);
    if (prior.status === 'succeeded' && !expired && (validated.kind === 'valid' || validated.kind === 'absent')) {
      return this.completeTurn(input, plan, startedAt, base, {
        mutation: freeze({
          operationId: prior.operationId,
          status: 'succeeded' as const,
          ...(validated.kind === 'valid' ? { receipt: validated.receipt as unknown as MutationReceipt } : {}),
        }),
        response: freeze({ text: renderMutationResult('succeeded') }),
      });
    }
    // Tombstone, reservation, or untrusted receipt: reconcile by operationId.
    // Review fix P1-1: `executing` counts as ACTIVE. The API keeps an
    // operation `executing` while its effect is being applied
    // (`pending-v2.ts` active listing includes it); the agent-side
    // `decidable` scope (proposed/confirmed) does not. Treating `executing`
    // as terminal here settled the reservation `inconclusive` mid-execution,
    // so the winner's later `reserved → succeeded` settle CAS (which only
    // transitions `reserved` rows) returned false — ignored best-effort —
    // and the success replay was lost forever.
    let boundStillDecidable = false;
    let listingUnreadable = false;
    try {
      const current = await coordinator.listActive(identity);
      const bound = current.find((item) => item.id === prior.operationId);
      boundStillDecidable =
        !!bound && (bound.status === 'proposed' || bound.status === 'confirmed' || bound.status === 'executing');
    } catch {
      listingUnreadable = true;
    }
    if (listingUnreadable || boundStillDecidable) {
      // Still active: the claim owner may be live — leave the reservation
      // untouched (no settle under a possibly-running execution). Terminal
      // or unreadable: inconclusive, original op preserved, B never touched.
      return this.inconclusiveConfirmationTurn(
        input, plan, startedAt, base,
        listingUnreadable ? 'confirmation_reconcile_unreadable' : 'confirmation_binding_preserved',
      );
    }
    // Bound operation terminal: success is proven ONLY for a `succeeded`
    // marker (written strictly post-success). A `reserved` marker proves
    // nothing — inconclusive, never a success claim (criterion 6).
    if (prior.status !== 'succeeded') {
      try {
        store?.settleConfirmation?.({
          ctx: this.draftContext(input),
          intentionId: input.intentionId,
          operationId: prior.operationId,
          status: 'inconclusive',
          receiptJson: prior.receiptJson,
          nowMs,
        });
      } catch {
        // Best-effort only.
      }
      return this.inconclusiveConfirmationTurn(input, plan, startedAt, base, 'confirmation_reserved_terminal');
    }
    return this.completeTurn(input, plan, startedAt, base, {
      mutation: freeze({
        operationId: prior.operationId,
        status: 'succeeded' as const,
        ...(validated.kind === 'valid' ? { receipt: validated.receipt as unknown as MutationReceipt } : {}),
      }),
      response: freeze({ text: renderMutationResult('succeeded') }),
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

  /**
   * Issue #255 (a) — small-talk guard for partial-amount drafts. When EVERY
   * recoverable draft is a partial (amount sentinel missing), a turn that
   * contributes NOTHING (no mutation signal, no follow-up amount, no
   * category answer, no date fragment, no reset/cancel) is not a
   * continuation: it keeps the legacy unsupported/conversation flow so the
   * draft survives untouched. Drafts pending other fields keep the
   * pre-existing routing byte-identical.
   */
  private isNonContributingTurn(input: TurnInput): boolean {
    const store = this.dependencies.draftStore;
    if (!store) return false;
    if (isPureReadForDraft(input.text)) return true;
    const ctx = this.draftContext(input);
    const now = this.draftNowMs();
    const actives = [...store.listActive(ctx, now), ...store.listProposing(ctx, now)];
    if (actives.length === 0) return false;
    const allPartialAmount = actives.every(
      (draft) =>
        draft.missingFields.includes('amount') &&
        (!Number.isInteger(draft.resolvedArgs.amountCents) || draft.resolvedArgs.amountCents <= 0),
    );
    if (!allPartialAmount) return false;
    if (hasMutationIntentSignal(input.text)) return false;
    if (isCancelText(input.text) || isResetText(input.text)) return false;
    if (correctionOutcome(input.text).kind !== 'none') return false;
    if (followUpAmountCents(input.text) !== undefined) return false;
    if (categoryQueryFrom(input.text, { allowBareFragment: true }) !== undefined) return false;
    if (resolveRelativeDateFragment(input.text).status !== 'none') return false;
    return true;
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
        // Review round 4 P1-A3: the proposal card shows this operation to the
        // user — record the presentation so a later "sim" turn may confirm
        // it (presentationTime <= that turn's anchor). Best-effort only.
        // R6: ledgered — compensated if this turn's response never publishes.
        this.recordPresentedOperations(store, this.draftContext(input), [proposal.id]);
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
    let effectiveCorrectionCents = correctionCents;
    if (correctionCents !== undefined) {
      const applied = this.applyDraftCorrection(input, draft, correctionCents);
      if (!applied.ok) {
        // A concurrent write won: refuse to overwrite it and clarify.
        return this.stopDraftCorrection(input, plan, startedAt, base, applied.current ?? draft);
      }
      currentDraft = applied.record;
    } else if (
      draft.missingFields.includes('amount') &&
      (!Number.isInteger(draft.resolvedArgs.amountCents) || draft.resolvedArgs.amountCents <= 0) &&
      !isPureReadForDraft(input.text)
    ) {
      // Issue #255 (a) — a follow-up VALUE fills the partial draft's missing
      // amount even without a finite verb ("2500", "2500 sendo 10x 250 com o
      // cartão nubank"). Same guarded write as a correction; pure reads never
      // reach here (anti-hijack gate above).
      //
      // Issue #255 review fix (HIGH) — the follow-up goes through the SAME
      // semantic guards as a fresh utterance: a foreign currency ("2500
      // dólares") or an approximation ("uns 2500") is a clarification that
      // fills NOTHING, instead of a value silently booked in reais.
      // Issue #255 review round 2 (P1) — a monetary alternative ("2500 ou
      // 250 …") is a question, never a value: clarify BEFORE any write, so
      // neither branch fills the sentinel. The draft stays intact and nothing
      // is proposed. Checked before the currency/approximation guards because
      // it is the most specific refusal for this shape.
      if (MONETARY_ALTERNATIVE.test(input.text)) {
        return this.stopDraftCorrection(
          input,
          plan,
          startedAt,
          base,
          draft,
          ALTERNATIVE_AMOUNT_TEXT,
        );
      }
      if (hasUnsupportedCurrency(input.text)) {
        return this.stopDraftCorrection(
          input,
          plan,
          startedAt,
          base,
          draft,
          ambiguityClarificationText('unsupported_currency'),
        );
      }
      if (hasApproximateAmount(input.text)) {
        return this.stopDraftCorrection(
          input,
          plan,
          startedAt,
          base,
          draft,
          ambiguityClarificationText('approximate_amount'),
        );
      }
      const followUp = followUpAmountCents(input.text);
      if (followUp !== undefined) {
        const applied = this.applyDraftCorrection(input, draft, followUp);
        if (!applied.ok) {
          return this.stopDraftCorrection(input, plan, startedAt, base, applied.current ?? draft);
        }
        currentDraft = applied.record;
        effectiveCorrectionCents = followUp;
      }
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
    if (effectiveCorrectionCents === undefined) {
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
    // Issue #255 (a): a partial draft (amount sentinel) may receive the
    // category TOGETHER with the value ("2500 ... categoria mercado"), so
    // the explicit answer is extracted even though `categoryId` is not yet
    // listed as pending. Bare-name guard below still prevents silent
    // misattribution when the account is also pending.
    const partialAmountPending =
      draft.missingFields.includes('amount') &&
      (!Number.isInteger(draft.resolvedArgs.amountCents) || draft.resolvedArgs.amountCents <= 0);
    const turnCategory = draft.missingFields.includes('categoryId') || partialAmountPending
      ? categoryQueryFrom(input.text, { allowBareFragment })
      : undefined;
    // FIX-170: a BARE name is adopted as the category answer ONLY when the
    // category is the SOLE pending field. With the account still pending the
    // same word could name either field, so it stays out of `categoryQuery`
    // and the turn keeps the pre-existing hint behavior (account-first,
    // description-exact category) — never a silent misattribution. Explicit
    // (`categoria X`) and `de X` fragments keep their existing adoption.
    const adoptedCategory =
      turnCategory?.bare === true && draft.missingFields.includes('accountId') ? undefined : turnCategory;
    const turnCategoryQuery = adoptedCategory?.query;
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
          effectiveCorrectionCents !== undefined && base.resolvedArgs.amountCents === effectiveCorrectionCents
            ? effectiveCorrectionCents
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
      : adoptedCategory?.fromFragment
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
      // FIX-170 (d): an identical category answer that adds nothing new and
      // still does not resolve converges to a STABLE impasse instead of
      // re-asking the same question indefinitely. Finite by construction:
      // the first unproductive repeat gets the impasse copy, every further
      // identical repeat re-asks exactly that copy, and any NEW answer
      // resolves normally. Zero new schema: `lastQuestion` is the only
      // memory, and the draft stays active for a valid answer at any time.
      const repeatsStoredCategoryQuery =
        turnCategoryQuery !== undefined &&
        turnCategoryQuery === observedBefore.categoryQuery &&
        resolution.missingFields.includes('categoryId');
      if (
        repeatsStoredCategoryQuery &&
        (draft.lastQuestion === CATEGORY_IMPASSE_TEXT || resolution.clarification === draft.lastQuestion)
      ) {
        const settled = this.writeDraftContinuation(draft.draftId, (current) => ({
          missingFields: withPartialAmountPending(resolution.missingFields, current),
          updatedAt: stamp,
          lastIntentionId: input.intentionId,
          lastQuestion: CATEGORY_IMPASSE_TEXT,
          ...this.turnMetadata(input, current, relation),
        }));
        if (!settled.ok) {
          return this.refuseDraftWrite(input, plan, startedAt, base, settled.current, CATEGORY_IMPASSE_TEXT);
        }
        return this.clarifyDraft(input, plan, startedAt, base, settled.record, CATEGORY_IMPASSE_TEXT);
      }
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
          (effectiveCorrectionCents !== undefined && current.resolvedArgs.amountCents === effectiveCorrectionCents) ||
          (turnDate !== undefined && current.resolvedArgs.date === observedBefore.date) ||
          (turnCategoryQuery !== undefined && current.resolvedArgs.categoryQuery === observedBefore.categoryQuery);
        return {
          ...(adoptsTurnArgs ? { resolvedArgs: argsOver(current) } : {}),
          missingFields: withPartialAmountPending(resolution.missingFields, current),
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
      //
      // Issue #255 review fix (HIGH): a partial draft fails this gate BY
      // DESIGN (sentinel amount), so the failure is not a reason to drop
      // this turn's verified entities and contributions. They are stored and
      // only `amount` stays pending, with the value question kept until a
      // valid fill arrives. Non-partial drafts keep the previous fail-closed
      // shape (question only).
      const partialAmountPendingWrite = (current: MutationDraftRecord): boolean =>
        (!Number.isInteger(current.resolvedArgs.amountCents) || current.resolvedArgs.amountCents <= 0) &&
        current.missingFields.includes('amount');
      const question = 'Não foi possível validar os dados com segurança. Descreva novamente o lançamento.';
      const written = this.writeDraftContinuation(draft.draftId, (current) => {
        const partial = partialAmountPendingWrite(current);
        return {
          ...(partial ? { resolvedArgs: completeArgs(current, resolution) } : {}),
          missingFields: withPartialAmountPending(['accountId', 'categoryId'], current),
          updatedAt: stamp,
          lastIntentionId: input.intentionId,
          lastQuestion: partial ? PARTIAL_DRAFT_QUESTION : question,
          ...this.turnMetadata(input, current, relation),
        };
      });
      if (!written.ok) {
        const current = written.current;
        const partial = current !== undefined && partialAmountPendingWrite(current);
        const text = partial ? PARTIAL_DRAFT_QUESTION : question;
        return this.refuseDraftWrite(input, plan, startedAt, base, current, text);
      }
      const record = written.record;
      const text = partialAmountPendingWrite(record) ? PARTIAL_DRAFT_QUESTION : question;
      return this.clarifyDraft(input, plan, startedAt, base, record, text);
    }
    // A08/R08: existence, activity and scope are re-checked IMMEDIATELY before
    // the write (the CAS below is what arms the propose). This is the SAME
    // resolution attempt — no recovery slot, no second loop (A06×A10). The
    // redelivery/recovery paths keep re-emitting their proposal untouched.
    const verified = await revalidateResolvedEntities(resolution, this.entityReaderOrClosed());
    this.emitEntityResolution(input, plan, verified.trace);
    if (!verified.complete) {
      const written = this.writeDraftContinuation(draft.draftId, (current) => ({
        missingFields: withPartialAmountPending(verified.missingFields, current),
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
      // Issue #255 (a): an amount-less mutation turn persists a partial
      // draft (sentinel amount) instead of answering statelessly.
      const missing = interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount' ? ['amount'] : [...plan.missingFields];
      const blockedPlan = freeze({ ...plan, missingFields: freeze([...missing]) });
      const text =
        interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount'
          ? PARTIAL_DRAFT_QUESTION
          : 'Não foi possível preparar a mutação com segurança. Esclareça valor e descrição.';
      const draft =
        interpretation.status === 'unparsed' && interpretation.reason === 'missing_amount'
          ? this.getOrCreatePartialDraft(input)
          : undefined;
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
        clarification: draft
          ? freeze({ missingFields: blockedPlan.missingFields, text, draft: toChannelMessage(draft, text) })
          : freeze({ missingFields: blockedPlan.missingFields, text }),
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
    // Review round 4 P1-A3: the proposal card shows this operation to the
    // user — record the presentation (best-effort) so a later "sim" turn
    // may confirm it. `store`/`ctx` are the draft scope in this method.
    // R6: ledgered — compensated if this turn's response never publishes.
    this.recordPresentedOperations(store, ctx, [proposal.id]);
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
    // P1-REVIEWFIX (P2): the two explicit answers to the two-target
    // clarification. Bare "a anterior"/"a pendente" carry no undo stem, so
    // they enter the arbitration through here instead of falling through to
    // an unrelated path; selectors are only honored when both targets are
    // still present (checked inside the pending branch below).
    const previousSelector = isUndoPreviousSelector(text);
    const pendingSelector = isUndoPendingSelector(text);
    if (!hasUndoIntent(text) && !previousSelector && !pendingSelector) return null;
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
    // P1-5.1 (DESFAZ): a pending financial operation takes precedence over
    // proposing an undo of an older action — "desfaz" matches both the undo
    // matcher and the cancel matcher, and the pending target wins. Two
    // targets (pending AND an undo-eligible prior action) clarify instead of
    // executing anything; a pending target alone takes the cancel path with
    // the exact contract "cancela" has today (same coordinator, same client).
    if (await this.hasPendingFinancialTarget(input)) {
      // P1-REVIEWFIX (P1): the undo probe is tri-state — a preview FAILURE
      // (timeout/transport) is `unknown`, never "no target". Cancelling the
      // pending op on `unknown` could destroy it when a prior undo-eligible
      // action actually exists (the turn should have clarified instead).
      // `unknown` + pending fails closed with an inconclusive reply and ZERO
      // state change (no cancel call, no draft discard, no undo proposal);
      // `unknown` + no pending never reaches here and falls through to the
      // normal undo path below, which fails closed on its own.
      const undoProbe = await this.probeUndoEligibility(input);
      if (undoProbe === 'unknown') {
        this.emit('mutation.blocked', {
          intentionId: input.intentionId,
          traceId: input.traceId,
          channel: input.channel,
          domain: plan.domain,
          mode: plan.mode,
          status: 'blocked',
          reason: 'undo_probe_unknown',
        });
        return this.completeTurn(input, plan, startedAt, base, {
          response: freeze({ text: renderInconclusive() }),
        });
      }
      // P1-REVIEWFIX (P2): honor the direct answer when both targets are
      // still present — previous goes to the undo-PROPOSAL path only (the
      // button still owns execution, unchanged policy), pending goes to the
      // cancel path. Anything else re-clarifies, never executes. A previous-
      // selector with NO undo target falls through to the undo path below,
      // which answers nothing-to-undo honestly with the pending untouched
      // (the pending op was explicitly NOT selected, so it is never
      // cancelled on this turn).
      if (undoProbe === 'eligible' && !previousSelector && !pendingSelector) {
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
          clarification: freeze({ missingFields: ambiguousPlan.missingFields, text: UNDO_CANCEL_TWO_TARGET_TEXT }),
          response: freeze({ text: UNDO_CANCEL_TWO_TARGET_TEXT }),
        });
      }
      if (pendingSelector || (undoProbe === 'none' && !previousSelector)) {
        return this.runCancelTurn(input, plan, this.dependencies.mutationApiClient ?? null, startedAt, base, decisionText);
      }
    } else if (pendingSelector && !hasUndoIntent(text)) {
      // Bare "a pendente"/"cancela a pendente" with nothing pending: the
      // deterministic cancel-contract no-op (same reply "cancela" gets today).
      return this.runCancelTurn(input, plan, this.dependencies.mutationApiClient ?? null, startedAt, base, decisionText);
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
      return freeze({ ...base, response: freeze({ text: NOTHING_TO_UNDO_OR_CANCEL_TEXT }) });
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

  /**
   * P1-5.1 (DESFAZ) — read-only pending probe for the undo/cancel
   * arbitration. True when a financial target is still decidable: a
   * recoverable local draft (active/proposing) OR an authoritative pending
   * operation. Never writes, never proposes, never cancels; any probe
   * failure reads as "no pending" and the turn falls through to the
   * pre-existing undo flow, which fails closed on its own.
   */
  private async hasPendingFinancialTarget(input: TurnInput): Promise<boolean> {
    try {
      if (this.hasRecoverableDraft(input)) return true;
    } catch {
      // A store failure is not a pending target; the listing below decides.
    }
    const client = this.dependencies.mutationApiClient;
    if (!client || !input.deviceId) return false;
    try {
      const target = await this.coordinatorFor(client).resolveDecisionTarget(
        { workspaceId: input.workspaceId, actorId: input.actorId, deviceId: input.deviceId },
        'decidable',
        this.dependencies.draftStore ? this.draftContext(input) : undefined,
      );
      return target.kind !== 'none';
    } catch {
      return false;
    }
  }

  /**
   * P1-REVIEWFIX (P1) — read-only undo-eligibility probe, TRI-STATE.
   * `eligible` = the authoritative preview fixed a target; `none` = the
   * preview returned null (genuinely nothing to undo — the
   * finance-chat-agent.ts `previewUndoTarget` contract: "Null = genuinely
   * nothing to undo; throw = transport failure"). `unknown` = the preview
   * THREW. The old boolean folded `unknown` into "no target" and cancelled a
   * pending op on what may be a transient preview failure. Never persists:
   * the proposal itself (when the undo path owns the turn) still goes
   * through `UndoProposalService.propose`, which re-reads the preview and
   * owns the row.
   */
  private async probeUndoEligibility(input: TurnInput): Promise<'eligible' | 'none' | 'unknown'> {
    const undoDeps = this.dependencies.undoProposals;
    if (!undoDeps || !input.deviceId) return 'none';
    try {
      const target = await undoDeps.preview({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        deviceId: input.deviceId,
      });
      return target !== null ? 'eligible' : 'none';
    } catch {
      return 'unknown';
    }
  }

  private async runMutationTurn(
    input: TurnInput,
    plan: TurnPlan,
    client: MutationApiClient,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    decisionText: string,
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
    // P1-5.1/AC5: the DECISION text decides — attachment-derived data in the
    // composed turn text never authorizes a cancel on this fallback path.
    if (isCancelText(decisionText)) {
      return this.runCancelTurn(input, plan, client, startedAt, base, decisionText);
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
    decisionText?: string,
  ): Promise<TurnResult> {
    // P1-5.1/AC6: a negated cancel ("não cancela", "não desfaz", "desfaz não")
    // is a refusal, never a decision — nothing is read, discarded or
    // cancelled. Read from the DECISION text only.
    const decision = decisionText ?? input.decisionText ?? input.text;
    if (isCancelNegation(decision)) {
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: CANCEL_NEGATION_TEXT }),
      });
    }
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
    // P1-INTEGRATE (H3): no draft store is fail-closed, never "cancelada".
    // Evidence: no test relies on the legacy store-less claim (every cancel
    // test constructs the orchestrator WITH a draftStore; the golden runner
    // always injects one; the golden contract fails a cancel claim with no
    // cancellation evidence anywhere as fail-closed). In prod the only
    // store-less path is degraded (durableSql unavailable → draftStoreForRequest
    // undefined; the SDK path additionally carries no client), where the old
    // `cancelled()` claimed "Operação cancelada com segurança." without
    // reading the authoritative listing or cancelling anything — an INV-03
    // false-success. Unknown outcome ⇒ inconclusive (INV-10 consistent,
    // same terminal as the transport-failure catch below).
    if (!store) {
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: renderInconclusive() }),
      });
    }
    const ctx = this.draftContext(input);
    const now = this.draftNowMs();
    // Without a transport the proposing outcome cannot be resolved — reply
    // inconclusive when a handoff is in flight, never "cancelado" (INV-10).
    // Active drafts are still discarded locally: no structured intention
    // may survive to become a proposal afterwards.
    if (!client) {
      const stamp = new Date(now).toISOString();
      let discarded = 0;
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
        discarded += 1;
      }
      if (store.listProposing(ctx, now).length > 0) {
        return this.completeTurn(input, plan, startedAt, base, {
          response: freeze({ text: renderInconclusive() }),
        });
      }
      // P1-5.3 (H2): ONLY local active drafts were discarded and no
      // authoritative operation could exist (no transport) — the distinct
      // drafts-discarded no-op copy, never the 'cancelled' claim.
      if (discarded > 0) {
        this.emit('approval.rejected', {
          intentionId: input.intentionId,
          traceId: input.traceId,
          channel: input.channel,
          domain: plan.domain,
          mode: plan.mode,
          status: 'rejected',
        });
        return this.completeTurn(input, plan, startedAt, base, {
          response: freeze({ text: DRAFTS_DISCARDED_NO_OP_TEXT }),
        });
      }
      // Nothing discarded, nothing proposing: deterministic no-op, never a
      // "cancelada" claim (mirrors the 'empty' resolution below).
      this.emit('approval.rejected', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'rejected',
      });
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: NO_PENDING_CANCEL_TEXT }),
      });
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
    // Golden GW-027 (INV-03): 'empty' (nada pendente) responde o no-op
    // determinístico — nunca "cancelada" sem evidência. Espelha o ramo
    // 'none' do retry (emite approval.rejected + cópia sem claim).
    if (resolution.kind === 'empty') {
      this.emit('approval.rejected', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'rejected',
      });
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: NO_PENDING_CANCEL_TEXT }),
      });
    }
    // P1-5.3 (H1): 'drafts-discarded' (ONLY local active drafts were
    // discarded, no authoritative operation ever existed) answers the
    // distinct deterministic no-op copy — never the 'cancelled' claim.
    // Mirrors 'empty' (approval.rejected + claim-free copy) and composes
    // with the negation guard at function top (the guard stays first).
    if (resolution.kind === 'drafts-discarded') {
      this.emit('approval.rejected', {
        intentionId: input.intentionId,
        traceId: input.traceId,
        channel: input.channel,
        domain: plan.domain,
        mode: plan.mode,
        status: 'rejected',
      });
      return this.completeTurn(input, plan, startedAt, base, {
        response: freeze({ text: coordinator.renderDraftsDiscarded() }),
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
      // FIX-187: the retry execute leg carries the turn intention so the
      // durable API frontier (V060) verifies the binding; the retry POST
      // itself also carries it (uniform with executor.decide — the API
      // retry route ignores the body today and the execute leg enforces).
      const result = await coordinator.retry(target.operation.id, identity, input.intentionId);
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

  /**
   * R6 (PR137-FIX): the turn entry. Resets the unpublished-presentation
   * ledger, then runs the turn; if the turn itself throws AFTER writing
   * witnesses (an exception before any response exists — nothing was
   * published by construction), those witnesses are compensated before the
   * error propagates, so a later intention cannot confirm an operation whose
   * card never reached the channel. Errors the turn converts into a
   * responded (inconclusive/failed) turn need no compensation here — the
   * response IS the publication; only a caller-observed send failure after
   * the return compensates those, via
   * `revertUnpublishedTurnPresentations`.
   */
  async runTurn(input: TurnInput): Promise<TurnResult> {
    this.unpublishedPresentationLedger = [];
    try {
      return await this.runTurnInner(input);
    } catch (error) {
      this.revertUnpublishedTurnPresentations();
      throw error;
    }
  }

  private async runTurnInner(input: TurnInput): Promise<TurnResult> {
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
    // ATTACHMENT-CONTENT-QUERY: a TYPED question about server-side admitted
    // attachment data precedes financial routing and draft continuation — the
    // composed text may carry finance words ("conta", "gastei", "R$ 42,50")
    // that would otherwise route a read, trip INV-06, or be captured by a
    // recoverable draft (INV-10). Verbatim repeats the admitted block
    // deterministically (zero reads, zero provider calls); generative answers
    // validate against it as document provenance (zero financial reads).
    // `confirmation` / `cancel` plans are never intercepted (F1: a typed
    // decision owns the turn); without admitted data the legacy flow owns it.
    const contentQuery = resolveAttachmentContentQuery(input, plan.mode);
    if (contentQuery) {
      return this.runAttachmentContentQuery(input, plan, contentQuery, startedAt, result);
    }
    // Review round 4 P1-A1: the confirmation anchor is captured SYNCHRONOUSLY
    // at turn entry, before ANY await/I/O below (undo probe, forget sondagem,
    // listing). `draftNowMs()` is the turn clock (injected in tests); calling
    // it here pins tEntry even when later I/O stalls for seconds. The durable
    // sighting below is stamped with tEntry — never with a post-I/O instant —
    // so an operation born during the pre-sighting I/O window is newer than
    // the anchor and fenced by the temporal check, whatever its timestamp.
    const confirmationTEntry = this.draftNowMs();
    // ROUND5-2: the presentation present-set snapshot, frozen SYNCHRONOUSLY
    // here — same instant as tEntry, before the first await below. Admission
    // requires target ∈ snapshot (membership): an operation presented DURING
    // this turn's awaits — even in the same millisecond — is absent from the
    // snapshot and rejected, whatever its timestamp. The temporal check stays
    // as defense-in-depth. Narrow residual (documented): a concurrent
    // proposal that COMPLETED before this synchronous read legitimately
    // enters the snapshot (its card predates the turn); the window is ~zero
    // because this read is the first store I/O of the turn, and anything
    // newer than the anchor is still fenced by the temporal check.
    let confirmationPresentationSnapshot: ReadonlySet<string> | undefined;
    if (plan.mode === 'confirmation') {
      try {
        const listed = this.dependencies.draftStore?.listConfirmationPresentations?.(this.draftContext(input));
        if (listed) confirmationPresentationSnapshot = new Set(listed);
      } catch {
        confirmationPresentationSnapshot = undefined;
      }
    }
    // Review round 4 P1-A1/P1-B: the entry anchor + independent frontiers
    // are established below (after `client`, before `runForgetDecisionTurn`'s
    // precedence sondagem): API intention bind FIRST, then the durable local
    // sighting stamped with tEntry. Both precede ANY decision I/O, so an
    // operation born during the pre-sighting window is newer than the anchor
    // and fenced, whatever its timestamp.
    let earlyConfirmationSighting: ConfirmationSighting | undefined;
    let earlyConfirmationSightingError: unknown;
    let earlyConfirmationSightingAttempted = false;
    let earlyApiSighting: { firstSeenAt: string; fresh: boolean; operationId: string | null } | undefined;
    let earlyApiSightingError: unknown;
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
    // Review round 4 P1-A1/P1-B — frontiers BEFORE any decision I/O
    // (`runForgetDecisionTurn`'s precedence sondagem awaits the listing, so
    // anything born in that window must postdate the anchor). Order matters:
    // (1) API intention bind FIRST — the frontier independent of agent
    // storage: even a TOTAL outage of both local writes below still leaves
    // X@T_api durably, and the post-recovery redelivery fails closed via
    // the pre-existing-API-sighting rule instead of confirming B fresh;
    // (2) durable local sighting stamped with tEntry (never a post-I/O
    // instant). Both are sync except the bind round-trip, which is itself
    // the first await — nothing else interposes. Reused by the confirmation
    // branch (re-writing either would misroute the first attempt into a
    // replay path). A stray marker on a turn the financial path does not own
    // (forget/undo owns it) is harmless: those paths return before the
    // confirmation branch and own their own redelivery dedupe.
    if (plan.mode === 'confirmation' && client) {
      const entryStore = this.dependencies.draftStore;
      // Without a device the branch below throws `mutation.device_required`
      // (pre-existing posture) — never bind an empty-device row here.
      const entryDeviceId = input.deviceId ?? null;
      const entryIdentity: MutationIdentity = {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        deviceId: entryDeviceId ?? '',
      };
      if (
        entryStore &&
        entryDeviceId !== null &&
        typeof entryStore.findConfirmation === 'function' &&
        typeof entryStore.claimConfirmation === 'function' &&
        typeof entryStore.settleConfirmation === 'function' &&
        typeof entryStore.noteConfirmationSighted === 'function' &&
        typeof entryStore.noteConfirmationPresentation === 'function' &&
        typeof entryStore.findConfirmationPresentation === 'function' &&
        typeof entryStore.listConfirmationPresentations === 'function'
      ) {
        try {
          earlyApiSighting = await this.coordinatorFor(client).bindConfirmationIntention(entryIdentity, input.intentionId);
        } catch (error) {
          earlyApiSightingError = error;
        }
        if (earlyApiSightingError === undefined) {
          earlyConfirmationSightingAttempted = true;
          try {
            earlyConfirmationSighting = entryStore.noteConfirmationSighted(
              this.draftContext(input),
              input.intentionId,
              confirmationTEntry,
            );
          } catch (error) {
            earlyConfirmationSightingError = error;
          }
        }
      }
    }
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
      return this.runMutationTurn(input, plan, client, startedAt, result, decisionText);
    }
    // Draft continuation under a non-mutation plan: a bare answer ("Nubank")
    // routes `unsupported`, but with a recoverable draft and a client it is a
    // missing-field answer, not a new turn. Reads keep their normal flow — a
    // balance query never completes a draft. Issue #255 (a): a PURE read
    // never continues a draft, and small talk never consumes a partial-amount
    // draft that it cannot contribute to.
    if (
      this.dependencies.draftStore && client &&
      (plan.mode === 'unsupported' || plan.mode === 'conversation') &&
      this.hasDraftForTurn(input) &&
      !this.isNonContributingTurn(input)
    ) {
      return this.runMutationTurn(input, plan, client, startedAt, result, decisionText);
    }
    // GW-036 (Bloco C): an account-name answer ("conta corrente") routes
    // `read`, but with a recoverable draft awaiting the account it is a
    // missing-field answer, not a new read. A balance query still never
    // completes a draft (`seeksAccountBalance` keeps the read flow).
    // Issue #255 (a): pure reads (`isPureReadForDraft`) never continue —
    // even with a partial draft pending.
    if (
      this.dependencies.draftStore && client &&
      plan.mode === 'read' &&
      !seeksAccountBalance(input.text ?? '') &&
      !isPureReadForDraft(input.text ?? '') &&
      this.hasDraftForTurn(input)
    ) {
      return this.runMutationTurn(input, plan, client, startedAt, result, decisionText);
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
      // Bloco A fase 2 (issue #105): the id of the operation this turn tried
      // to confirm+execute. The catch below reconciles against it — it stays
      // empty when no single target was ever resolved.
      let confirmTargetId = '';
      // Review round 4 P1-B: operation already bound to THIS intention
      // API-side by a previous confirm (see the bind above). A resolution
      // for a different operation is refused before the transport.
      let apiBoundOperationId = '';
      try {
        // PR137-HARDEN (Bloco A): durable idempotent confirmation. The
        // identity→operationId binding lives in the draft store (durable in
        // prod: DO SQLite) because this orchestrator is constructed per turn.
        //
        // FAIL-CLOSED (criterion 1): this branch is EXCLUSIVELY the financial
        // mutation confirmation. Without a store, without the binding
        // methods, or when the marker read throws, the turn answers
        // inconclusive — it NEVER falls back to resolving the live listing
        // (which could confirm a different operation than the redelivered
        // turn intended). Non-financial confirmations (forget two-step, undo
        // RPC, reads) never reach this branch and are unaffected.
        const confirmationStore = this.dependencies.draftStore;
        const confirmationCtx = this.draftContext(input);
        const canBind =
          !!confirmationStore &&
          typeof confirmationStore.findConfirmation === 'function' &&
          typeof confirmationStore.claimConfirmation === 'function' &&
          typeof confirmationStore.settleConfirmation === 'function' &&
          typeof confirmationStore.noteConfirmationSighted === 'function' &&
          typeof confirmationStore.noteConfirmationPresentation === 'function' &&
          typeof confirmationStore.findConfirmationPresentation === 'function' &&
          typeof confirmationStore.listConfirmationPresentations === 'function';
        if (!canBind) {
          return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_store_unavailable');
        }
        // Review round 4 P1-A1: the sighting was written at turn entry
        // (`earlyConfirmationSighting`, stamped with tEntry BEFORE any
        // decision I/O). It is reused here — never re-written (a second
        // call would observe `fresh: false` and misroute the first attempt
        // into the replay path). The `record.createdAt` below IS tEntry, so
        // the temporal check fences anything born during the pre-sighting
        // I/O window (forget sondagem, undo probe).
        let sighting: ConfirmationSighting;
        if (earlyConfirmationSightingAttempted && earlyConfirmationSighting) {
          sighting = earlyConfirmationSighting;
        } else if (earlyConfirmationSightingAttempted && earlyConfirmationSightingError !== undefined) {
          // Review fix P1-B (round 3): the sighting write failed, so no
          // T0-anchored marker exists yet and a post-recovery redelivery
          // would resolve-and-confirm a later B with a FRESH (T2) sighting.
          // Best-effort an INDEPENDENT claim-path sentinel for the same
          // intention (unbound `operationId === ''`, same instant): it goes
          // through a different statement than the sighting, so a selective
          // sighting-write outage still leaves a durable T0 marker and the
          // redelivery replays inconclusive via the unbound-sentinel path
          // below — never touching the listing. A TOTAL outage of both local
          // writes (this throws too) is closed by the API frontier instead:
          // the entry bind already persisted X@T_api, so the post-recovery
          // redelivery fails closed via `confirmation_post_outage_redelivery`
          // (round 4 P1-B). Either way the turn fails closed here with zero
          // executes.
          try {
            confirmationStore.claimConfirmation!({
              ctx: confirmationCtx,
              intentionId: input.intentionId,
              operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
              receiptJson: null,
              status: 'reserved',
              nowMs: confirmationTEntry,
            });
          } catch {
            // Best-effort marker only.
          }
          return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_marker_unreadable');
        } else {
          // Defensive (unreachable when the entry write ran): stamp with
          // tEntry, never with a post-I/O instant.
          try {
            sighting = confirmationStore.noteConfirmationSighted!(confirmationCtx, input.intentionId, confirmationTEntry);
          } catch {
            try {
              confirmationStore.claimConfirmation!({
                ctx: confirmationCtx,
                intentionId: input.intentionId,
                operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
                receiptJson: null,
                status: 'reserved',
                nowMs: confirmationTEntry,
              });
            } catch {
              // Best-effort marker only.
            }
            return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_marker_unreadable');
          }
        }
        // Review round 4 P1-B (direction iii): the INDEPENDENT durable
        // frontier, bound at turn entry BEFORE any decision I/O (see
        // runTurn). Reused here — never re-bound (a second call would
        // observe `fresh: false` for THIS attempt's own bind and misroute
        // into the post-outage path). Rules:
        // - bind threw at entry ⇒ fail closed (zero executes);
        // - API knew X before (`fresh: false`) while the local sighting is
        //   fresh ⇒ post-outage redelivery whose local history is gone
        //   (total outage of both local writes on the first attempt, storage
        //   loss, ...): fail closed, NEVER confirm on a rebuilt anchor;
        // - otherwise the effective anchor is min(local, API): whichever
        //   frontier saw the intention first fences the target.
        // The same intentionId is propagated to confirm/execute below, where
        // the API enforces the operationId binding atomically (identical ⇒
        // idempotent proceed; divergent ⇒ 409 `approval.intention_conflict`
        // ⇒ fail closed here, B never touched).
        if (earlyApiSightingError !== undefined || !earlyApiSighting) {
          return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_intention_bind_failed');
        }
        const apiSighting = earlyApiSighting;
        let anchorMs = Date.parse(sighting.record.createdAt);
        {
          const apiFirstSeenMs = Date.parse(apiSighting.firstSeenAt);
          if (!Number.isFinite(apiFirstSeenMs)) {
            return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_intention_bind_failed');
          }
          if (!apiSighting.fresh && sighting.fresh) {
            try {
              confirmationStore.settleConfirmation!({
                ctx: confirmationCtx,
                intentionId: input.intentionId,
                operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
                status: 'inconclusive',
                receiptJson: null,
                nowMs: this.draftNowMs(),
              });
            } catch {
              // Best-effort terminal bookkeeping only.
            }
            return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_post_outage_redelivery');
          }
          if (Number.isFinite(anchorMs)) anchorMs = Math.min(anchorMs, apiFirstSeenMs);
          else anchorMs = apiFirstSeenMs;
          // A previous confirm under THIS intention already bound an
          // operation API-side: remember it so the resolution below can
          // refuse a different target before touching the transport.
          // (Kept apart from `confirmTargetId`, which names the operation
          // THIS turn attempted — the catch below settles exactly that.)
          apiBoundOperationId = apiSighting.operationId ?? '';
        }
        if (!sighting.fresh) {
          return await this.replayConfirmationBinding({
            prior: sighting.record,
            coordinator,
            identity,
            input,
            plan,
            startedAt,
            base: result,
          });
        }
        const target = await coordinator.resolveDecisionTarget(identity, 'decidable', this.draftContext(input));
        if (target.kind === 'none') {
          // P1-2: persist the no-target outcome as an unbound sentinel (the
          // sighting row settles `reserved → inconclusive`) so a redelivery
          // of THIS intention reproduces inconclusive even after a LATER
          // operation appears — it never confirms B. Best-effort: the
          // freshly written sighting already blocks by construction when the
          // settle itself fails.
          try {
            confirmationStore.settleConfirmation!({
              ctx: confirmationCtx,
              intentionId: input.intentionId,
              operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
              status: 'inconclusive',
              receiptJson: null,
              nowMs: this.draftNowMs(),
            });
          } catch {
            // Best-effort terminal bookkeeping only.
          }
          this.emit('approval.rejected', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'rejected' });
          return this.completeTurn(input, plan, startedAt, result, {
            response: freeze({ text: 'Não há nenhuma operação pendente para confirmar.' }),
          });
        }
        if (target.kind === 'multiple') {
          // P1-2: same sentinel as above — the ambiguity is terminal for
          // THIS intention; only a new turn/intention may confirm B.
          // The disambiguation SHOWS the set: record it for future turns.
          this.recordPresentedOperations(confirmationStore, confirmationCtx, target.operations.map((operation) => operation.id));
          try {
            confirmationStore.settleConfirmation!({
              ctx: confirmationCtx,
              intentionId: input.intentionId,
              operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
              status: 'inconclusive',
              receiptJson: null,
              nowMs: this.draftNowMs(),
            });
          } catch {
            // Best-effort terminal bookkeeping only.
          }
          const text = renderDisambiguation(target.operations, 'confirmar');
          const ambiguousPlan = freeze({ ...plan, missingFields: freeze(['intent']) });
          this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
          return this.completeTurn(input, ambiguousPlan, startedAt, result, {
            plan: ambiguousPlan,
            clarification: freeze({ missingFields: ambiguousPlan.missingFields, text }),
            response: freeze({ text }),
          });
        }
        confirmTargetId = target.operation.id;
        // Review round 4 P1-B: the API already bound THIS intention to a
        // different operation (a previous confirm reached the API while the
        // agent lost its local history). Refuse before the transport — a
        // redelivery replays A via the binding, it never confirms B.
        if (apiBoundOperationId !== '' && apiBoundOperationId !== target.operation.id) {
          try {
            confirmationStore.settleConfirmation!({
              ctx: confirmationCtx,
              intentionId: input.intentionId,
              operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
              status: 'inconclusive',
              receiptJson: null,
              nowMs: this.draftNowMs(),
            });
          } catch {
            // Best-effort terminal bookkeeping only.
          }
          return this.inconclusiveConfirmationTurn(
            input, plan, startedAt, result, 'confirmation_intention_conflict',
          );
        }
        // Review fix P1-4: TEMPORAL ADMISSIBILITY. The resolved operation
        // must already have existed when THIS intention was first seen
        // (effective anchor = min(local sighting tEntry, API first-seen) vs
        // the operation's authoritative `createdAt`, with skew tolerance).
        // An operation created AFTER the anchor (beyond clock-skew
        // tolerance) is rejected fail-closed (settle the sighting sentinel
        // best-effort) so only a fresh turn/intention may confirm the newer
        // operation. An unparseable timestamp proves nothing ⇒ fail closed
        // as well. Review round 4 P1-A2: the frontier REJECTS (`>=`): an
        // operation born exactly at anchor+skew is indistinguishable from a
        // race and must not execute — a fresh intention confirms it.
        {
          const opCreatedMs = Date.parse(target.operation.createdAt);
          if (
            !Number.isFinite(anchorMs) ||
            !Number.isFinite(opCreatedMs) ||
            opCreatedMs >= anchorMs + CONFIRMATION_OPERATION_SKEW_MS
          ) {
            // ROUND5-1: NO presentation witness here. This rejection answers
            // only `renderInconclusive()` — no card, no summary of B — so
            // recording a presentation would forge a testimony without
            // exhibition and let a later intention confirm an operation it
            // never saw. The sentinel settle above is the only durable mark.
            try {
              confirmationStore.settleConfirmation!({
                ctx: confirmationCtx,
                intentionId: input.intentionId,
                operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
                status: 'inconclusive',
                receiptJson: null,
                nowMs: this.draftNowMs(),
              });
            } catch {
              // Best-effort terminal bookkeeping only.
            }
            return this.inconclusiveConfirmationTurn(
              input, plan, startedAt, result, 'confirmation_operation_newer_than_intention',
            );
          }
        }
        // Review round 4 P1-A3 + round 5 ROUND5-2: PRESENTATION BINDING by
        // entry-snapshot membership. Time alone cannot prove identity
        // (skew-window birth, backdated `createdAt` from a negatively-skewed
        // API clock), so the target must belong to the present-set frozen at
        // turn entry (`confirmationPresentationSnapshot`): never presented —
        // or presented only DURING this turn's awaits (even in the same ms,
        // e.g. first seen in this very listing) — ⇒ fail closed; only a
        // fresh turn/intention whose entry snapshot already contains it may
        // confirm it. The `presentedAt <= anchor` read stays as
        // defense-in-depth below. Temporal stays as defense-in-depth above.
        // ROUND5-1: no witness on rejection (inconclusive publishes no card).
        {
          const inEntrySnapshot = confirmationPresentationSnapshot?.has(target.operation.id) ?? false;
          const presented = confirmationStore.findConfirmationPresentation?.(confirmationCtx, target.operation.id);
          const presentedMs = presented ? Date.parse(presented.presentedAt) : NaN;
          if (!inEntrySnapshot || !presented || !Number.isFinite(presentedMs) || presentedMs > anchorMs) {
            try {
              confirmationStore.settleConfirmation!({
                ctx: confirmationCtx,
                intentionId: input.intentionId,
                operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
                status: 'inconclusive',
                receiptJson: null,
                nowMs: this.draftNowMs(),
              });
            } catch {
              // Best-effort terminal bookkeeping only.
            }
            return this.inconclusiveConfirmationTurn(
              input, plan, startedAt, result, 'confirmation_operation_not_presented',
            );
          }
        }
        // PR137-HARDEN (Bloco A): RESERVE BEFORE EXECUTE (criterion 2). The
        // intention→operationId binding is written durably with CAS BEFORE
        // any remote confirm/execute — no distributed DO↔PG transaction is
        // presumed; the API stays the anti-double-effect authority for the
        // SAME operation. Only the `claimed` caller drives the execution:        // `identical` (concurrent loser / retry) and `divergent` (a binding
        // for another op already won) answer inconclusive without touching
        // the transport — the first durable writer wins (criterion 3). A
        // claim-write failure (SQLite error, uninitialized schema) leaves
        // the path unprotected ⇒ fail closed (criteria 1/7).
        // All admissibility checks passed: refresh the presentation witness
        // (post-check, so it can never self-authorize) and reserve.
        this.recordPresentedOperations(confirmationStore, confirmationCtx, [target.operation.id]);
        let claim: string | void;
        try {
          claim = confirmationStore.claimConfirmation!({
            ctx: confirmationCtx,
            intentionId: input.intentionId,
            operationId: target.operation.id,
            receiptJson: null,
            status: 'reserved',
            nowMs: this.draftNowMs(),
          });
        } catch {
          // Review fix P1-4: the claim write failed BEFORE persisting, so no
          // binding protects this intention yet. Attempt to leave an unbound
          // sentinel (best-effort — a fully-down store throws here too, the
          // documented residual) so a post-recovery redelivery reproduces
          // inconclusive instead of resolving-and-confirming a later B; the
          // sighting's first-seen instant additionally fences it via the
          // temporal check above.
          try {
            confirmationStore.settleConfirmation!({
              ctx: confirmationCtx,
              intentionId: input.intentionId,
              operationId: CONFIRMATION_UNBOUND_OPERATION_ID,
              status: 'inconclusive',
              receiptJson: null,
              nowMs: this.draftNowMs(),
            });
          } catch {
            // Best-effort terminal bookkeeping only.
          }
          return this.inconclusiveConfirmationTurn(input, plan, startedAt, result, 'confirmation_reserve_failed');
        }
        if (claim !== 'claimed') {
          return this.inconclusiveConfirmationTurn(
            input, plan, startedAt, result,
            claim === 'divergent' ? 'confirmation_binding_conflict' : 'confirmation_already_claimed',
          );
        }
        const confirmed = await coordinator.confirm(target.operation.id, identity, input.intentionId);
        this.emit('approval.confirmed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'confirmed' });
        this.emit('mutation.executed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'succeeded', latencyMs: Date.now() - startedAt });
        // PR137-HARDEN (Bloco A): settle the reservation to its terminal
        // state. Best-effort: a settle-write failure must NEVER break a
        // success the API already persisted (the API stays the
        // anti-double-effect authority for the SAME operation). An unsettled
        // `reserved` row still blocks B on redelivery (reconcile path).
        try {
          confirmationStore.settleConfirmation!({
            ctx: confirmationCtx,
            intentionId: input.intentionId,
            operationId: confirmed.operationId,
            status: 'succeeded',
            receiptJson: confirmed.receipt ? JSON.stringify(confirmed.receipt) : null,
            nowMs: this.draftNowMs(),
          });
        } catch {
          // Best-effort marker only.
        }
        return this.completeTurn(input, plan, startedAt, result, {
          mutation: freeze({
            operationId: confirmed.operationId,
            status: 'succeeded' as const,
            ...(confirmed.receipt ? { receipt: confirmed.receipt } : {}),
          }),
          response: freeze({ text: renderMutationResult('succeeded') }),
        });
      } catch (error) {
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        // Review round 4 P1-B: the API refused the confirm because THIS
        // intention is already bound to a DIFFERENT operation
        // (`approval.intention_conflict`): the redelivery must never confirm
        // B. Settle terminal (best-effort) and answer inconclusive — never
        // the `failed` copy (which would read as "nothing happened, retry",
        // inviting a re-confirm of B under a fresh intention without the
        // binding context).
        if (isIntentionConflictError(error)) {
          if (confirmTargetId !== '') {
            try {
              this.dependencies.draftStore?.settleConfirmation?.({
                ctx: this.draftContext(input),
                intentionId: input.intentionId,
                operationId: confirmTargetId,
                status: 'inconclusive',
                receiptJson: null,
                nowMs: this.draftNowMs(),
              });
            } catch {
              // Best-effort terminal bookkeeping only.
            }
          }
          return this.completeTurn(input, plan, startedAt, result, {
            response: freeze({ text: renderInconclusive() }),
          });
        }
        // Bloco A fase 2 (issue #105): the confirm+execute above may have
        // persisted BEFORE the error (lost execute response, receipt-less
        // reply). The authoritative listing decides: when the target left the
        // active set it is terminal (succeeded — this branch only confirms,
        // never cancels), so a definitive "failed" claim would be FALSE while
        // the money moved. Answer inconclusive; the user checks the
        // lançamentos. A still-active target, an unreconciled target, or an
        // unreadable listing keeps the existing failure copy.
        // PR137-HARDEN: the reservation won above stays terminal-bookkept:
        // settle it `inconclusive` best-effort so a redelivery of THIS
        // intention reconciles against A (never confirms B) instead of
        // re-driving a `reserved` row whose outcome is already unknown.
        // The immediate copy below is unchanged (terminal/unreadable →
        // inconclusive; still-active → failed).
        if (confirmTargetId !== '') {
          try {
            this.dependencies.draftStore?.settleConfirmation?.({
              ctx: this.draftContext(input),
              intentionId: input.intentionId,
              operationId: confirmTargetId,
              status: 'inconclusive',
              receiptJson: null,
              nowMs: this.draftNowMs(),
            });
          } catch {
            // Best-effort terminal bookkeeping only.
          }
        }
        let targetTerminal = false;
        // PR137-SEC-FIX Fase 1 (B): a resolved target with an UNREADABLE
        // listing is the same unknown as a terminal one — the effect may have
        // landed before the error, so a definitive `failed` would be a false
        // claim. Answer inconclusive.
        // Review fix P1-1: a target still present as `executing` is the same
        // unknown — the API is applying the effect right now, so `failed`
        // would be equally false. Only a target still `proposed`/`confirmed`
        // (nothing started) keeps the `failed` copy.
        let listingUnreadable = false;
        let targetExecuting = false;
        try {
          if (confirmTargetId !== '') {
            const current = await coordinator.listActive(identity);
            const found = current.find((item) => item.id === confirmTargetId);
            targetTerminal = !found;
            targetExecuting = !!found && found.status === 'executing';
          }
        } catch {
          listingUnreadable = confirmTargetId !== '';
          targetTerminal = false;
        }
        return this.completeTurn(input, plan, startedAt, result, {
          response: freeze({ text: targetTerminal || listingUnreadable || targetExecuting ? renderInconclusive() : renderMutationResult('failed') }),
        });
      }
    }
    if (plan.mode === 'cancel') {
      return this.runCancelTurn(input, plan, client ?? null, startedAt, result, decisionText);
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
    // CORREÇÃO 2 (P2-2): the missing-amount gate runs BEFORE the evidence
    // read — a read-mode purchase without a value ("comprei uma bicicleta no
    // cartão") must not be answered as a card statement query. Draft/
    // mutation/confirmation/cancel/retry turns returned above and never
    // reach it.
    const missingAmount = this.missingAmountGate(input, plan, startedAt, result);
    if (missingAmount) return missingAmount;
    if (plan.mode === 'read' && this.dependencies.evidenceProvider) {
      // Evidence-backed read: deterministic render or validated grounded text.
      const read = await this.runGroundedRead(input, plan, startedAt, result);
      // R10: the grounded read path terminates inside `runGroundedRead` (it
      // never reaches `completeTurn`), so the shared snapshot is emitted here.
      // A settled read is not a clarification: its stop stays `completed`.
      this.emitTurnBudget(result);
      return read;
    }
    // T08-F1 fail-closed incondicional: um turno `unsupported` com dado
    // admitido de anexo NUNCA alcança o provider com texto generativo. O
    // caminho suportado (resolveAttachmentContentQuery) já rodou na entrada
    // do turno e é dono das perguntas delimitadas sobre o anexo — chegar
    // aqui significa que o texto digitado NÃO é uma content-query
    // delimitada, logo o turno não tem resposta determinística com
    // evidência. O fato material é o mesmo nas duas sub-causas (conteúdo
    // não verificado do anexo dispara a ambiguidade
    // unsupported/leitura-financeira): responde fail-closed com
    // ATTACHMENT_CONTENT_UNVERIFIED_TEXT, tripando ou não o guard
    // makesUnverifiedFinancialClaim(input.text). Turnos SEM dado admitido
    // mantêm o fluxo legado byte-idêntico abaixo. Mutation/draft turns
    // retornam acima, então isto nunca os intercepta.
    if (plan.mode === 'unsupported' && input.hasAttachmentData === true) {
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: false, latencyMs: Date.now() - startedAt });
      return freeze({ ...result, failClosed: true as const, response: freeze({ text: ATTACHMENT_CONTENT_UNVERIFIED_TEXT }) });
    }
    // INV-06 fail-closed: an `unsupported` turn that still makes a financial
    // claim (amount pattern or finance noun + claim cue) would otherwise
    // reach the LLM with NO evidence, letting prompt injection fabricate
    // balances. Reply deterministically without calling the provider.
    // Mutation/draft turns return above, so this never intercepts them.
    // T08-F1: turns WITH admitted data returned above; this branch now owns
    // ONLY turns without admitted data (byte-identical legacy reply).
    if (plan.mode === 'unsupported' && makesUnverifiedFinancialClaim(input.text)) {
      // Turns WITH admitted data returned in the T08-F1 branch above, so
      // this owns ONLY turns without admitted data: the byte-identical
      // legacy READ-failure reply.
      const text = FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT;
      this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', grounded: false, latencyMs: Date.now() - startedAt });
      return freeze({ ...result, failClosed: true as const, response: freeze({ text }) });
    }
    const responseText = plan.mode === 'read'
      ? `Consulta preparada para ${resolveDomainSubject(plan.domain)}.`
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
