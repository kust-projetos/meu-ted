/**
 * PendingOperationCoordinator — unified decision machine (SPEC §8, H-02).
 *
 * Button and natural language converge here: both resolve the decision
 * target from the AUTHORITATIVE listing (GET /v2/active, scoped by the
 * authenticated workspace + actor + device) and then confirm/cancel/retry
 * through the same paths. Client-declared pendingOperationIds are never
 * authority — at most a logging hint carried by the caller.
 *
 * Decision rules (§8.4): zero ops → deterministic reply; one op →
 * confirm/cancel/retry; two or more → disambiguation listing, NOTHING
 * executed or cancelled. Cancellation persists first (execution_status =
 * cancelled) and discards the active drafts of the same context (§8.5);
 * a cancel arriving during a `proposing` handoff resolves the propose
 * outcome by the SAME proposalIdempotencyKey before answering (INV-10).
 */

import type {
  ActiveOperationRecord,
  MutationApiClient,
  MutationIdentity,
} from '../mutations/mutation-api-client.js';
import {
  appendDraftRelation,
  appendOriginMessage,
  isDefinitiveProposeError,
  type DraftContext,
  type MutationDraftStore,
} from '../mutations/mutation-draft.js';
import type { MutationReceipt } from '@pi-finance/llm-contracts';
import { renderInconclusive } from '../responses/deterministic-responses.js';

export type DecisionScope = 'decidable' | 'retryable';

/** Operations the scope may act on: proposed/confirmed vs failed (§13). */
const scopeStatuses = (scope: DecisionScope): readonly string[] =>
  scope === 'retryable' ? ['failed'] : ['proposed', 'confirmed'];

export type DecisionTarget =
  | Readonly<{ kind: 'none'; operations: readonly ActiveOperationRecord[]; hasActiveDraft: boolean; hasProposingDraft: boolean }>
  | Readonly<{ kind: 'single'; operation: ActiveOperationRecord; operations: readonly ActiveOperationRecord[]; hasActiveDraft: boolean; hasProposingDraft: boolean }>
  | Readonly<{ kind: 'multiple'; operations: readonly ActiveOperationRecord[]; hasActiveDraft: boolean; hasProposingDraft: boolean }>;

export type CancelResolution =
  | Readonly<{ kind: 'cancelled'; operationId?: string }>
  | Readonly<{ kind: 'inconclusive' }>
  | Readonly<{ kind: 'ambiguous'; operations: readonly ActiveOperationRecord[] }>;

export type DecisionInput = Readonly<{
  operationId: string;
  decision: 'confirm' | 'cancel' | 'retry';
  identity: MutationIdentity;
  /** Button-path approval context (passed through to the transport). */
  requestId?: string;
  delegatedToken?: string;
}>;

export type DecisionResult = Readonly<{
  operationId: string;
  status: 'succeeded' | 'cancelled';
  /**
   * T3.3 (SPEC §15.1): the REAL execution receipt relayed from the API —
   * the PWA reconciles from it (mutationId dedup) instead of guessing.
   * Present only on succeeded decisions; carries no attestation material.
   */
  receipt?: MutationReceipt;
}>;

export const NO_PENDING_OPERATION_TEXT = 'Não há nenhuma operação pendente para confirmar.';
export const NO_FAILED_OPERATION_TEXT = 'Não há nenhuma operação com falha para tentar novamente.';

/** Conversational retry (§8.2): "tenta de novo" / "refaz" over a failed op. Kept tight — bare "tenta" never matches. */
const RETRY_RE = /\b(tenta? (de novo|novamente)|tentar (de novo|novamente)|tente (de novo|novamente)|refa[zç](a|er)?|repet(e|ir|a|indo))\b/i;
export const isRetryText = (text: string): boolean => RETRY_RE.test(text.trim());

const formatAmount = (cents: number): string =>
  `R$ ${(cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const describeOperation = (operation: ActiveOperationRecord, index: number): string => {
  const amount = typeof operation.amountCents === 'number' ? ` de ${formatAmount(operation.amountCents)}` : '';
  const description = typeof operation.description === 'string' && operation.description ? ` (${operation.description})` : '';
  const kind = operation.tool.includes('income') ? 'Receita' : 'Despesa';
  return `${index + 1}. ${kind}${amount}${description}`;
};

export const renderDisambiguation = (
  operations: readonly ActiveOperationRecord[],
  verb: 'confirmar' | 'cancelar' | 'tentar novamente',
): string => {
  const options = operations
    .slice(0, 5)
    .map((operation, index) => describeOperation(operation, index))
    .join('\n');
  return `Tenho ${operations.length} operações aguardando confirmação:\n\n${options}\n\nQual delas deseja ${verb}?`;
};

export class PendingOperationCoordinator {
  constructor(
    private readonly dependencies: {
      client: MutationApiClient;
      draftStore?: MutationDraftStore;
      now?: () => number;
    },
  ) {}

  private nowMs(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  /** Authoritative listing passthrough (SPEC §8.3). */
  async listActive(identity: MutationIdentity): Promise<ActiveOperationRecord[]> {
    const result = await this.dependencies.client.listActive(identity);
    return [...result.items];
  }

  /**
   * Resolve the decision target from the authoritative listing, never from
   * client-declared ids. Draft flags inform precedence (§7.8: decision turns
   * never complete drafts; cancel discards them) but never select a target.
   */
  async resolveDecisionTarget(
    identity: MutationIdentity,
    scope: DecisionScope = 'decidable',
    draftCtx?: DraftContext,
  ): Promise<DecisionTarget> {
    const store = this.dependencies.draftStore;
    const now = this.nowMs();
    const hasActiveDraft = store && draftCtx ? store.listActive(draftCtx, now).length > 0 : false;
    const hasProposingDraft = store && draftCtx ? store.listProposing(draftCtx, now).length > 0 : false;
    const flags = { hasActiveDraft: hasActiveDraft === true, hasProposingDraft: hasProposingDraft === true };
    const allowed = scopeStatuses(scope);
    const operations = (await this.listActive(identity)).filter((operation) => allowed.includes(operation.status));
    if (operations.length === 0) return { kind: 'none', operations, ...flags };
    const [single, ...rest] = operations;
    if (rest.length === 0 && single) return { kind: 'single', operation: single, operations, ...flags };
    return { kind: 'multiple', operations, ...flags };
  }

  /** Confirm + execute exactly once (T2.2 re-emission and T2.3 TX split live in the API). */
  async confirm(operationId: string, identity: MutationIdentity): Promise<DecisionResult> {
    const confirmation = await this.dependencies.client.confirm(operationId, identity);
    return this.executeAttested(confirmation, identity);
  }

  async authorizeAndExecute(operationId: string, identity: MutationIdentity): Promise<DecisionResult> {
    const authorization = await this.dependencies.client.authorize(operationId, identity);
    return this.executeAttested(authorization, identity);
  }

  async executeAuthorized(confirmation: { operationId: string; attestation: string }, identity: MutationIdentity): Promise<DecisionResult> {
    return this.executeAttested(confirmation, identity);
  }

  private async executeAttested(confirmation: { operationId: string; attestation: string }, identity: MutationIdentity): Promise<DecisionResult> {
    const execution = await this.dependencies.client.execute({
      operationId: confirmation.operationId,
      attestation: confirmation.attestation,
      identity,
    });
    return {
      operationId: execution.operationId,
      status: 'succeeded',
      ...(execution.receipt ? { receipt: execution.receipt } : {}),
    };
  }

  /**
   * Authoritative cancel: the API persists execution_status = cancelled
   * BEFORE this resolves, so callers may only reply "cancelado" after it.
   * Active drafts of the same context are discarded (§8.5) — no structured
   * intention may survive to become a proposal afterwards.
   */
  async cancel(operationId: string, identity: MutationIdentity, draftScope?: { store: MutationDraftStore; ctx: DraftContext; intentionId: string; nowMs?: number }): Promise<DecisionResult> {
    const result = await this.dependencies.client.cancel(operationId, identity);
    this.discardActiveDrafts(draftScope);
    return result;
  }

  /** Conversational retry (§8.2/§13): failed → confirmed (fresh attestation) → execute once. */
  async retry(operationId: string, identity: MutationIdentity): Promise<DecisionResult> {
    const confirmation = await this.dependencies.client.retry(operationId, identity);
    return this.executeAttested(confirmation, identity);
  }

  /**
   * Button path (and any explicit-id caller): the same machine, addressed
   * by the operation id the authoritative surface issued. No listing, no
   * disambiguation — the card already names its operation.
   */
  async decide(input: DecisionInput): Promise<DecisionResult> {
    if (input.decision === 'cancel') {
      return this.cancel(input.operationId, input.identity);
    }
    if (input.decision === 'retry') {
      return this.retry(input.operationId, input.identity);
    }
    return this.confirm(input.operationId, input.identity);
  }

  /**
   * Full cancel turn resolution (SPEC §8.5, case E §25.3.2): proposing
   * handoffs are settled by the SAME proposalIdempotencyKey first —
   * existing operation → authoritative cancel; definitive rejection →
   * discard; unknown → inconclusive (never "cancelado"). Then actives are
   * discarded and the authoritative listing decides: none → cancelled
   * without operation; one → cancelled; several → ambiguous (nothing
   * cancelled).
   */
  async resolveCancel(
    identity: MutationIdentity,
    draftScope?: { store: MutationDraftStore; ctx: DraftContext; intentionId: string; deviceId: string | null; nowMs?: number },
  ): Promise<CancelResolution> {
    if (!draftScope) {
      const target = await this.resolveDecisionTarget(identity, 'decidable');
      if (target.kind === 'none') return { kind: 'cancelled' };
      if (target.kind === 'multiple') return { kind: 'ambiguous', operations: target.operations };
      const result = await this.dependencies.client.cancel(target.operation.id, identity);
      return { kind: 'cancelled', operationId: result.operationId };
    }
    const { store, ctx, intentionId } = draftScope;
    const now = draftScope.nowMs ?? this.nowMs();
    const stamp = new Date(now).toISOString();
    store.expireStale(ctx, now);

    let outcomeUnknown = false;
    for (const draft of store.listProposing(ctx, now)) {
      const args = draft.resolvedArgs;
      try {
        const proposal = await this.dependencies.client.propose({
          tool: draft.tool,
          normalizedArgs: {
            amountCents: args.amountCents,
            description: args.description,
            date: args.date,
            accountId: args.accountId!,
            categoryId: args.categoryId!,
          },
          summary: args.description,
          identity: {
            workspaceId: draft.workspaceId,
            actorId: draft.actorId,
            deviceId: draft.deviceId ?? draftScope.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
          },
          idempotencyKey: draft.proposalIdempotencyKey,
        });
        store.update(draft.draftId, {
          status: 'consumed',
          proposalId: proposal.id,
          proposeOutcome: proposal.existing ? 'existing' : 'created',
          updatedAt: stamp,
          lastIntentionId: intentionId,
        });
      } catch (error) {
        if (isDefinitiveProposeError(error)) {
          store.update(draft.draftId, {
            status: 'discarded',
            discardReason: 'propose_rejected',
            proposeOutcome: 'rejected',
            updatedAt: stamp,
            lastIntentionId: intentionId,
          });
        } else {
          store.update(draft.draftId, {
            proposeOutcome: 'unknown',
            updatedAt: stamp,
            lastIntentionId: intentionId,
          });
          outcomeUnknown = true;
        }
      }
    }
    this.discardActiveDrafts({ store, ctx, intentionId, nowMs: now });
    if (outcomeUnknown) return { kind: 'inconclusive' };
    const target = await this.resolveDecisionTarget(identity, 'decidable');
    if (target.kind === 'none') return { kind: 'cancelled' };
    if (target.kind === 'multiple') return { kind: 'ambiguous', operations: target.operations };
    const result = await this.dependencies.client.cancel(target.operation.id, identity);
    return { kind: 'cancelled', operationId: result.operationId };
  }

  /** Inconclusive reply for unknown propose outcomes (INV-10; T1.3 wording reused). */
  renderInconclusive(): string {
    return renderInconclusive();
  }

  private discardActiveDrafts(scope?: { store: MutationDraftStore; ctx: DraftContext; intentionId: string; nowMs?: number }): void {
    if (!scope) return;
    const now = scope.nowMs ?? this.nowMs();
    const stamp = new Date(now).toISOString();
    for (const draft of scope.store.listActive(scope.ctx, now)) {
      scope.store.update(draft.draftId, {
        status: 'discarded',
        discardReason: 'user_cancel',
        updatedAt: stamp,
        lastIntentionId: scope.intentionId,
        // A07/R07: the cancel is recorded as a relation of the goal it
        // closed. Metadata only — the discard itself is unchanged.
        originMessages: appendOriginMessage(draft.originMessages, scope.intentionId),
        relations: appendDraftRelation(draft.relations, 'cancel_ref'),
      });
    }
  }
}
