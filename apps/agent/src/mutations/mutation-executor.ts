import { requestPiApiJson } from '../tools/api-client.js';
import { emitSanitizedEvent } from '../observability/events.js';
import { mutationReceiptSchema, type MutationReceipt } from '@pi-finance/llm-contracts';
export type MutationExecution = { operationId: string; attestation: string; identity: { workspaceId: string; actorId: string; deviceId: string } };
export type ApprovalDecision = 'confirm' | 'cancel' | 'retry';
export type ApprovalDecisionInput = {
  operationId: string;
  decision: ApprovalDecision;
  requestId: string;
  delegatedToken: string;
  identity: { workspaceId: string; actorId: string; deviceId: string };
};
export type ApprovalDecisionResult = {
  operationId: string;
  status: 'succeeded' | 'cancelled' | 'failed' | 'expired' | 'proposed' | 'confirmed';
  retryable?: boolean;
  /**
   * T3.3 (SPEC §15.1): the REAL receipt emitted by the API on TX2 success,
   * schema-validated here and relayed to the PWA for reconciliation.
   * Never synthesized from LLM output; never carries attestation material
   * (the strict contract schema rejects unknown keys wholesale).
   */
  receipt?: MutationReceipt;
};

/**
 * T3.3: projects the browser-safe receipt out of an authoritative execute
 * response (`execution.receipt`, persisted in the same TX2 as `mutation_id`).
 * Strict linkage (safety-critical): the receipt must be schema-valid, carry
 * the origin pending-operation id in `receipt.operationId`, and link the
 * persisted transaction in `receipt.entity = { type: 'transaction',
 * id: execution.operationId }`. Anything else is undefined — the caller
 * fails closed with `approval.incomplete_result` and never returns a
 * partial success.
 */
const receiptFromExecution = (
  execution: unknown,
  pendingOperationId: string,
  transactionId: string,
): MutationReceipt | undefined => {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return undefined;
  const receipt = (execution as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined;
  const parsed = mutationReceiptSchema.safeParse(receipt);
  if (!parsed.success) return undefined;
  const data = parsed.data as MutationReceipt;
  if (data.operationId !== pendingOperationId) return undefined;
  const entity = (data as { entity?: unknown }).entity as { type?: unknown; id?: unknown } | undefined;
  if (!entity || typeof entity !== 'object') return undefined;
  // Semantic linkage: a transaction execution always carries a transaction
  // entity naming the persisted transaction id — never another type/id.
  if (entity.type !== 'transaction') return undefined;
  if (entity.id !== transactionId) return undefined;
  // Identity linkage: when the execution names a mutationId it must agree
  // with the receipt identity — a disagreement is a mismatched result.
  const executionMutationId = (execution as { mutationId?: unknown }).mutationId;
  if (
    typeof executionMutationId === 'string' &&
    executionMutationId.trim().length > 0 &&
    data.mutationId !== executionMutationId
  ) {
    return undefined;
  }
  return data;
};

export class MutationExecutor {
  private readonly consumed = new Set<string>();
  private readonly events: (eventType: string, fields: Record<string, unknown>) => void;
  constructor(private readonly deps: { request?: typeof requestPiApiJson; events?: (eventType: string, fields: Record<string, unknown>) => void } = {}) {
    this.events = deps.events ?? emitSanitizedEvent;
  }
  private emit(eventType: string, fields: Record<string, unknown>): void {
    try {
      this.events(eventType, fields);
    } catch {
      // Observability must never break the approval flow.
    }
  }
  private assertOperationId(returnedId: unknown, requestedId: string): void {
    if (returnedId === requestedId) return;
    this.emit('mutation.blocked', { status: 'blocked', error: 'approval.operation_id_mismatch' });
    throw new Error('approval.operation_id_mismatch');
  }
  async confirm(operationId: string, identity: MutationExecution['identity'], delegatedToken?: string): Promise<{ operationId: string; attestation: string }> {
    const request = this.deps.request ?? requestPiApiJson;
    const result = await request<{ id?: unknown; attestation?: unknown }>('POST', `/pending-operations/v2/${encodeURIComponent(operationId)}/confirm`, { delegatedToken, headers: { 'x-workspace-id': identity.workspaceId, 'x-actor-id': identity.actorId, 'x-device-id': identity.deviceId } });
    this.assertOperationId(result.id, operationId);
    if (typeof result.attestation !== 'string' || result.attestation.length < 32) throw new Error('approval.missing_attestation');
    return { operationId, attestation: result.attestation };
  }
  async execute(input: MutationExecution, delegatedToken?: string): Promise<{ status: 'succeeded'; operationId: string; receipt?: MutationReceipt }> {
    if (typeof input.attestation !== 'string' || input.attestation.length < 32) {
      this.emit('mutation.blocked', { status: 'blocked', error: 'approval.invalid_attestation' });
      throw new Error('approval.invalid_attestation');
    }
    if (this.consumed.has(input.attestation)) {
      this.emit('mutation.blocked', { status: 'blocked', error: 'approval.attestation_replayed' });
      throw new Error('approval.attestation_replayed');
    }
    this.consumed.add(input.attestation);
    const request = this.deps.request ?? requestPiApiJson;
    // Authoritative execute returns the store record
    // `{ id: <pending-op id>, status, execution: { operationId: <tx id>, receipt } }`
    // with NO top-level `operationId`. `id` is the pending-operation id;
    // `execution.operationId` / `entity.id` name the persisted transaction
    // and must never become the DecisionResult.operationId. Every link is
    // validated below — a partial `{id,status}` without a linked
    // execution/receipt fails closed with `approval.incomplete_result`
    // and never returns success. No IDs are synthesized.
    const result = await request<{ id?: unknown; status?: unknown; execution?: unknown }>('POST', `/pending-operations/v2/${encodeURIComponent(input.operationId)}/execute`, { delegatedToken, body: { attestation: input.attestation }, headers: { 'x-workspace-id': input.identity.workspaceId, 'x-actor-id': input.identity.actorId, 'x-device-id': input.identity.deviceId } });
    const failClosed = (): never => {
      this.emit('mutation.blocked', { status: 'blocked', error: 'approval.incomplete_result' });
      throw new Error('approval.incomplete_result');
    };
    const pendingId = typeof input.operationId === 'string' ? input.operationId.trim() : '';
    if (!pendingId) failClosed();
    if (result.status !== 'succeeded') failClosed();
    if (typeof result.id !== 'string' || result.id.trim() !== pendingId) failClosed();
    const execution = result.execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) failClosed();
    const execRecord = execution as { status?: unknown; operationId?: unknown };
    if (execRecord.status !== 'succeeded') failClosed();
    if (typeof execRecord.operationId !== 'string' || execRecord.operationId.trim().length === 0) failClosed();
    const transactionId = (execRecord.operationId as string).trim();
    const receipt = receiptFromExecution(execution, pendingId, transactionId);
    if (!receipt) failClosed();
    this.emit('mutation.executed', { status: 'succeeded' });
    return { status: 'succeeded', operationId: input.operationId, receipt };
  }

  async decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    if (!input.operationId || !input.requestId || !input.delegatedToken) throw new Error('approval.decision_context_required');
    if (!input.identity.deviceId) throw new Error('mutation.device_required');
    const request = this.deps.request ?? requestPiApiJson;
    const headers = { 'x-workspace-id': input.identity.workspaceId, 'x-actor-id': input.identity.actorId, 'x-device-id': input.identity.deviceId };
    if (input.decision === 'cancel') {
      const result = await request<{ id?: unknown; status?: unknown }>('POST', `/pending-operations/v2/${encodeURIComponent(input.operationId)}/cancel`, { delegatedToken: input.delegatedToken, headers });
      this.assertOperationId(result.id, input.operationId);
      if (result.status !== 'cancelled') throw new Error('approval.cancel_not_confirmed');
      this.emit('approval.rejected', { status: 'rejected' });
      return { operationId: input.operationId, status: 'cancelled' };
    }
    const path = input.decision === 'retry' ? 'retry' : 'confirm';
    const confirmation = await request<{ id?: unknown; attestation?: unknown }>('POST', `/pending-operations/v2/${encodeURIComponent(input.operationId)}/${path}`, { delegatedToken: input.delegatedToken, headers });
    this.assertOperationId(confirmation.id, input.operationId);
    if (typeof confirmation.attestation !== 'string' || confirmation.attestation.length < 32) {
      this.emit('approval.expired', { status: 'expired', error: 'approval.missing_attestation' });
      throw new Error('approval.missing_attestation');
    }
    this.emit('approval.confirmed', { status: 'confirmed' });
    return this.execute({ operationId: input.operationId, attestation: confirmation.attestation, identity: input.identity }, input.delegatedToken);
  }
}
