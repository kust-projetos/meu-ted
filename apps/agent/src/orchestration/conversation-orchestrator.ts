import { scrubForPersistence } from '../privacy/dlp.js';
import { parseFinancialMutation } from '../mutations/financial-parser.js';
import { resolveMutationEntities, type EntityReader } from '../mutations/entity-resolver.js';
import type { MutationApiClient, MutationIdentity } from '../mutations/mutation-api-client.js';
import { deriveIdempotencyKey } from '../tools/intention-ledger.js';
import {
  DEFAULT_MAX_PROPOSE_ATTEMPTS,
  DEFAULT_DRAFT_TTL_MS,
  buildDraftRecord,
  isCancelText,
  isExpired,
  isDefinitiveProposeError,
  isResetText,
  toChannelMessage,
  validateCompleteArgs,
  type DraftContext,
  type MutationDraftRecord,
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
import { extractAccountsEvidence, renderAccountsAnswer, seeksAccountBalance } from './account-grounding.js';
import { makesUnverifiedFinancialClaim } from './financial-claim-guard.js';
import {
  NO_FAILED_OPERATION_TEXT,
  PendingOperationCoordinator,
  isRetryText,
  renderDisambiguation,
} from './pending-operation-coordinator.js';
import { hasUndoIntent, isExplicitConfirmation } from '../agent-config/tools.js';
import { UndoProposalService } from '../mutations/undo-proposal.js';
import { isUndoNegation } from '../mutations/undo-proposal.js';
import { isAutoExecutionEligible } from '../safety/auto-execution.js';

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
const categoryQueryFrom = (text: string): string | undefined =>
  CATEGORY_PHRASE.exec(text)?.[1]?.trim() || undefined;

const normalize = (body: Body, identity: AuthenticatedIdentity, channel: ConversationChannel): TurnInput => {
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
    // FIX-AGENT-RELAY-FAILOVER-HARDENING (A): the internal correction flag
    // is constructed here as `false` — any client-supplied `internalCorrection`
    // / `isInternalCorrectionRetry` field in `body` is deliberately NOT read,
    // so untrusted text can never mark its own turn as an internal retry.
    internalCorrection: false,
    ...(pendingOperationIds ? { pendingOperationIds: freeze(pendingOperationIds) } : {}),
  });
};

export const normalizeRestTurn = (body: Body, identity: AuthenticatedIdentity): TurnInput => normalize(body, identity, 'pwa-rest');
export const normalizeSdkTurn = (body: Body, identity: AuthenticatedIdentity): TurnInput => normalize(body, identity, 'sdk');
export const normalizeBrokerTurn = (body: Body, identity: AuthenticatedIdentity): TurnInput => normalize(body, identity, 'broker');

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
    responseProvider?: TurnResponseProvider;
    /** Read-path evidence source (EvidenceCollector). Absent = legacy pass-through. */
    evidenceProvider?: (input: TurnInput, plan: TurnPlan) => Promise<EvidenceEnvelope | null>;
    /** ONE structured correction retry for unsupported grounded claims. */
    correctionProvider?: (input: TurnInput, plan: TurnPlan, unsupportedClaims: readonly string[]) => Promise<string | null>;
    /** Sanitized lifecycle event sink (defaults to emitSanitizedEvent). */
    events?: (eventType: string, fields: Record<string, unknown>) => void;
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
  } = {}) {}

  private emit(eventType: string, fields: Record<string, unknown>): void {
    try {
      (this.dependencies.events ?? emitSanitizedEvent)(eventType, fields);
    } catch {
      // Observability must never break the turn.
    }
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
    const parsed = parseFinancialMutation(text);
    if (parsed.kind === 'none') return false;
    return (
      parsed.kind !== draft.resolvedArgs.kind || parsed.amountCents !== draft.resolvedArgs.amountCents
    );
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

  private async continueDraft(
    input: TurnInput,
    plan: TurnPlan,
    startedAt: number,
    base: { input: TurnInput; plan: TurnPlan; policy: MutationPolicy },
    draft: MutationDraftRecord,
    client: MutationApiClient,
  ): Promise<TurnResult> {
    const store = this.dependencies.draftStore!;
    // Resolve ONLY the missing field, then revalidate ALL args: the stored
    // financial fields are authoritative for this draft, the new text only
    // supplies entity hints (e.g. "Nubank" → account).
    //
    // SPEC R03: a draft pending only the category is completed by the category
    // the user just named — without this the clarification asked for something
    // the draft could never consume, since the stored description is not a
    // category query. The turn's explicit statement wins over the stored one
    // (a correction of the category is exactly what this turn is for).
    const turnCategoryQuery = draft.missingFields.includes('categoryId')
      ? categoryQueryFrom(input.text)
      : undefined;
    const categoryQuery = turnCategoryQuery ?? draft.resolvedArgs.categoryQuery;
    const merged = {
      kind: draft.resolvedArgs.kind,
      amountCents: draft.resolvedArgs.amountCents,
      description: draft.resolvedArgs.description,
      date: draft.resolvedArgs.date,
      ...(categoryQuery ? { categoryQuery } : {}),
    };
    const resolution = await resolveMutationEntities(
      merged,
      `${draft.resolvedArgs.description} ${input.text}`,
      this.entityReaderOrClosed(),
    );
    const stamp = new Date(this.draftNowMs()).toISOString();
    if (!resolution.complete) {
      // SPEC R03: an explicit category accepted in this turn must survive the
      // draft while another field stays pending. Dropping it would make the
      // next bare answer ("Nubank") re-ask the category the user just named,
      // because the stored description is not a category query.
      const adoptsCategory = !!categoryQuery && categoryQuery !== draft.resolvedArgs.categoryQuery;
      store.update(draft.draftId, {
        ...(adoptsCategory ? { resolvedArgs: { ...draft.resolvedArgs, categoryQuery } } : {}),
        missingFields: [...resolution.missingFields],
        updatedAt: stamp,
        lastIntentionId: input.intentionId,
        lastQuestion: resolution.clarification,
      });
      const updated = store.get(draft.draftId) ?? draft;
      return this.clarifyDraft(input, plan, startedAt, base, updated, resolution.clarification);
    }
    const completeArgs = {
      ...draft.resolvedArgs,
      accountId: resolution.accountId,
      categoryId: resolution.categoryId,
      accountName: resolution.accountName,
      categoryName: resolution.categoryName,
    };
    if (!validateCompleteArgs(completeArgs)) {
      // Canonical gate failed agent-side: never propose, clarify again.
      const question = 'Não foi possível validar os dados com segurança. Descreva novamente o lançamento.';
      store.update(draft.draftId, {
        missingFields: ['accountId', 'categoryId'],
        updatedAt: stamp,
        lastIntentionId: input.intentionId,
        lastQuestion: question,
      });
      const updated = store.get(draft.draftId) ?? draft;
      return this.clarifyDraft(input, plan, startedAt, base, updated, question);
    }
    store.update(draft.draftId, {
      resolvedArgs: completeArgs,
      missingFields: [],
      updatedAt: stamp,
      lastIntentionId: input.intentionId,
    });
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
    const parsed = parseFinancialMutation(input.text);
    if (parsed.kind === 'none') {
      // SPEC §7.6: missing amount/date is a real missing field, never [].
      const missing = parsed.reason === 'missing_amount' ? ['amount'] : [...plan.missingFields];
      const blockedPlan = freeze({ ...plan, missingFields: freeze([...missing]) });
      const text =
        parsed.reason === 'missing_amount'
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
    const resolution = await resolveMutationEntities(parsed, input.text, this.entityReaderOrClosed());
    if (!resolution.complete) {
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
        missingFields: [...resolution.missingFields],
        question: resolution.clarification,
        ttlMs: this.dependencies.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS,
        nowMs: now,
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
      accountId: resolution.accountId,
      categoryId: resolution.categoryId,
    };
    const proposal = await client.propose({
      tool,
      normalizedArgs,
      summary: parsed.description,
      identity,
      idempotencyKey: deriveIdempotencyKey(input.workspaceId, input.intentionId, tool),
    });
    const eligible = isAutoExecutionEligible({ tool, missingFields: [], ambiguity: plan.ambiguity, latestActorText: input.text });
    if (eligible && !proposal.existing) {
      const duplicateSuspected = await client.duplicateSuspectedStrict({
        kind: parsed.kind, description: parsed.description, amountCents: parsed.amountCents,
        date: parsed.date, accountId: resolution.accountId,
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
                response: freeze({ text: `${parsed.kind === 'income' ? 'Receita' : 'Despesa'} de R$ ${(parsed.amountCents / 100).toFixed(2).replace('.', ',')} (${parsed.description}) registrada${resolution.accountName ? ` na conta ${resolution.accountName}` : ''}. Se quiser, posso desfazer.` }),
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
        accountName: resolution.accountName,
        categoryName: resolution.categoryName,
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
  ): Promise<TurnResult | null> {
    const text = input.text ?? '';
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
      const replacement = parseFinancialMutation(input.text);
      if (replacement.kind !== 'none' && actives.every((draft) => this.isReplacement(input.text, draft))) {
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
    const plan = this.dependencies.plan?.(input) ?? routeIntent(input.text);
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
    const undoTurn = await this.runUndoTurn(input, plan, startedAt, result);
    if (undoTurn) return undoTurn;
    const client = this.dependencies.mutationApiClient;
    // A proposal may never fall through to a generative response when the
    // channel was unable to construct its narrowly-scoped API client (for
    // example, a missing device binding). This keeps every mutation intent on
    // the same pipeline and fails closed without reviving a V1 relay path.
    if (plan.mode === 'mutation-proposal' && !client) {
      return freeze({ ...result, response: freeze({ text: 'Não foi possível preparar a operação com segurança. A sessão precisa de um dispositivo autenticado.' }) });
    }
    if (plan.mode === 'mutation-proposal' && client && !this.dependencies.draftStore) {
      const parsed = parseFinancialMutation(input.text);
      if (parsed.kind === 'none') {
        // SPEC §7.6: missing amount/date is a real missing field, never [].
        const missing = parsed.reason === 'missing_amount' ? ['amount'] : [...plan.missingFields];
        const blockedPlan = freeze({ ...plan, missingFields: freeze([...missing]) });
        const text = parsed.reason === 'missing_amount'
          ? 'Não identifiquei o valor a registrar. Informe o valor e a descrição.'
          : 'Não foi possível preparar a mutação com segurança. Esclareça valor e descrição.';
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...result, plan: blockedPlan, clarification: freeze({ missingFields: blockedPlan.missingFields, text }), response: freeze({ text }) });
      }
      // SPEC §7.1/§7.2/§7.3 (H-01): resolve accountId/categoryId against
      // authoritative reads BEFORE any proposal. Incomplete args clarify;
      // no pending operation is created on this path (T1.3 persists drafts).
      const reader = this.dependencies.entityReader ?? {
        listAccounts: async (): Promise<never> => { throw new Error('agent.entity_reader_missing'); },
        listCategories: async (): Promise<never> => { throw new Error('agent.entity_reader_missing'); },
      };
      const resolution = await resolveMutationEntities(parsed, input.text, reader);
      if (!resolution.complete) {
        const incompletePlan = freeze({ ...plan, missingFields: freeze([...resolution.missingFields]) });
        this.emit('mutation.blocked', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'blocked' });
        this.emit('turn.completed', { intentionId: input.intentionId, traceId: input.traceId, channel: input.channel, domain: plan.domain, mode: plan.mode, status: 'completed', latencyMs: Date.now() - startedAt });
        return freeze({ ...result, plan: incompletePlan, clarification: freeze({ missingFields: incompletePlan.missingFields, text: resolution.clarification }), response: freeze({ text: resolution.clarification }) });
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
        accountId: resolution.accountId,
        categoryId: resolution.categoryId,
      };
      const proposal = await client.propose({
        tool,
        normalizedArgs,
        summary: parsed.description,
        identity,
        idempotencyKey: deriveIdempotencyKey(input.workspaceId, input.intentionId, tool),
      });
      if (!proposal.existing && isAutoExecutionEligible({ tool, missingFields: [], ambiguity: plan.ambiguity, latestActorText: input.text }) &&
        !(await client.duplicateSuspectedStrict({ kind: parsed.kind, description: parsed.description, amountCents: parsed.amountCents, date: parsed.date, accountId: resolution.accountId }))) {
        const elevated = this.dependencies.autoExecutionClient?.();
        if (elevated) {
          const authorization = await this.authorizeAutoExecution(elevated, proposal.id, identity);
          if (authorization.kind === 'uncertain') return freeze({ ...result, response: freeze({ text: renderInconclusive() }) });
          if (authorization.kind === 'authorized') {
            try {
              const executed = await new PendingOperationCoordinator({ client: elevated }).executeAuthorized({ operationId: proposal.id, attestation: authorization.attestation }, identity);
              return freeze({ ...result, policy: freeze({ ...policy, authorizationMode: 'auto' }), mutation: freeze({ operationId: executed.operationId, status: 'succeeded', ...(executed.receipt ? { receipt: executed.receipt } : {}) }), response: freeze({ text: `${parsed.kind === 'income' ? 'Receita' : 'Despesa'} de R$ ${(parsed.amountCents / 100).toFixed(2).replace('.', ',')} (${parsed.description}) registrada${resolution.accountName ? ` na conta ${resolution.accountName}` : ''}. Se quiser, posso desfazer.` }) });
            } catch {
              try {
                const current = await elevated.listActive(identity);
                if (current.items.some((item) => item.id === proposal.id && item.status === 'failed')) {
                  return freeze({ ...result, response: freeze({ text: renderMutationResult('failed') }) });
                }
              } catch { /* State remains uncertain; keep the inconclusive response. */ }
              return freeze({ ...result, response: freeze({ text: renderInconclusive() }) });
            }
          }
        }
      }
      return freeze({ ...result, policy: freeze({ ...policy, authorizationMode: 'manual' }), mutation: this.proposedMutation({ operationId: proposal.id, tool, normalizedArgs, accountName: resolution.accountName, categoryName: resolution.categoryName, expiresAt: proposal.operation.expiresAt }), response: freeze({ text: renderMutationResult('proposed', proposal.summary) }) });
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
      isRetryText(input.text) &&
      (plan.mode === 'unsupported' || plan.mode === 'conversation' || plan.mode === 'confirmation') &&
      !this.hasDraftForTurn(input)
    ) {
      return this.runRetryTurn(input, plan, client, startedAt, result);
    }
    if (plan.mode === 'read' && this.dependencies.evidenceProvider) {
      // Evidence-backed read: deterministic render or validated grounded text.
      return this.runGroundedRead(input, plan, startedAt, result);
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
