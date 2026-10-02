import type { MutationReceipt, PendingOperationPresentation, PendingOperationV2 } from '@pi-finance/llm-contracts';
import { requestPiApiJson } from '../tools/api-client.js';
import { emitSanitizedEvent } from '../observability/events.js';
import { createMutationProposal, type MutationProposal } from './mutation-proposal.js';
import { MutationExecutor, type ApprovalDecisionInput, type ApprovalDecisionResult, type MutationExecution } from './mutation-executor.js';
import type { DuplicateCheckInput } from '../tools/duplicate-detector.js';

export type MutationIdentity = MutationExecution['identity'];
export type MutationRequest = typeof requestPiApiJson;
export type MutationEventSink = (eventType: string, fields: Record<string, unknown>) => void;

/**
 * T1.5 (SPEC §8.3): lean authoritative listing projection. Enough for
 * disambiguation (amount/description/date/account), never authority
 * material (no attestation, no full args).
 * FIX-P1: optional canonical `presentation` (SPEC §16) derived server-side
 * from the hash-bound record — display-only, strict-validated at the relay.
 */
export type ActiveOperationRecord = Readonly<{
  id: string;
  status: string;
  tool: string;
  createdAt: string;
  expiresAt: string;
  amountCents?: number;
  description?: string;
  date?: string;
  accountId?: string;
  categoryId?: string;
  presentation?: PendingOperationPresentation;
}>;

/** Single Agent-side transport facade for the authoritative V2 approval API. */
export class MutationApiClient {
  private readonly executor: MutationExecutor;
  private readonly request: MutationRequest;
  private readonly events: MutationEventSink;

  constructor(deps: { request?: MutationRequest; events?: MutationEventSink; strictDuplicateCheck?: (input: DuplicateCheckInput) => Promise<boolean> } = {}) {
    this.request = deps.request ?? requestPiApiJson;
    this.events = deps.events ?? emitSanitizedEvent;
    this.executor = new MutationExecutor({ request: this.request, events: this.events });
    this.strictDuplicateCheck = deps.strictDuplicateCheck;
  }

  private readonly strictDuplicateCheck?: (input: DuplicateCheckInput) => Promise<boolean>;

  duplicateSuspectedStrict(input: DuplicateCheckInput): Promise<boolean> {
    return this.strictDuplicateCheck ? this.strictDuplicateCheck(input) : Promise.resolve(true);
  }

  /** Tool-call lifecycle events carry allowlisted fields only (name, status, latency) — never args or payloads. */
  private async timed<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      this.events('tool.started', { tool, status: 'started' });
    } catch {
      // Observability must never break the mutation flow.
    }
    try {
      const result = await fn();
      try {
        this.events('tool.completed', { tool, status: 'completed', latencyMs: Date.now() - startedAt });
      } catch {
        // Best effort.
      }
      return result;
    } catch (error) {
      try {
        this.events('tool.completed', { tool, status: 'failed', latencyMs: Date.now() - startedAt, error });
      } catch {
        // Best effort.
      }
      throw error;
    }
  }

  private assertPendingOperationId(returnedId: unknown, requestedId: string): void {
    if (returnedId !== requestedId) throw new Error('approval.operation_id_mismatch');
  }

  propose(input: {
    tool: string;
    normalizedArgs: PendingOperationV2['normalizedArgs'];
    summary: string;
    identity: MutationIdentity;
    idempotencyKey: string;
  }): Promise<MutationProposal> {
    return this.timed('transactions.propose', () => createMutationProposal({ ...input, request: this.request }));
  }

  confirm(operationId: string, identity: MutationIdentity): Promise<{ operationId: string; attestation: string }> {
    return this.timed('transactions.confirm', () => this.executor.confirm(operationId, identity));
  }

  authorize(operationId: string, identity: MutationIdentity): Promise<{ operationId: string; attestation: string }> {
    return this.timed('transactions.authorize', async () => {
      const result = await this.request<{ id?: unknown; status?: unknown; attestation?: unknown }>(
        'POST', `/pending-operations/v2/${encodeURIComponent(operationId)}/authorize`,
        { headers: { 'x-workspace-id': identity.workspaceId, 'x-actor-id': identity.actorId, 'x-device-id': identity.deviceId } },
      );
      this.assertPendingOperationId(result.id, operationId);
      if (result.status !== 'confirmed') throw new Error('approval.authorize_not_confirmed');
      if (typeof result.attestation !== 'string' || result.attestation.length < 32) throw new Error('approval.missing_attestation');
      this.events('approval.confirmed', { status: 'confirmed' });
      return { operationId, attestation: result.attestation };
    });
  }

  /** T1.5 (SPEC §8.3): authoritative listing scoped by the turn identity. */
  listActive(identity: MutationIdentity): Promise<{ items: ActiveOperationRecord[]; total: number }> {
    return this.timed('transactions.listActive', () =>
      this.request<{ items: ActiveOperationRecord[]; total: number }>('GET', '/pending-operations/v2/active', {
        headers: { 'x-workspace-id': identity.workspaceId, 'x-actor-id': identity.actorId, 'x-device-id': identity.deviceId },
      }),
    );
  }

  /** T1.5 (SPEC §8.5): authoritative cancel — persisted before any reply. */
  cancel(operationId: string, identity: MutationIdentity): Promise<{ operationId: string; status: 'cancelled' }> {
    return this.timed('transactions.cancel', async () => {
      const result = await this.request<{ id?: unknown; status?: unknown }>(
        'POST', `/pending-operations/v2/${encodeURIComponent(operationId)}/cancel`,
        { headers: { 'x-workspace-id': identity.workspaceId, 'x-actor-id': identity.actorId, 'x-device-id': identity.deviceId } },
      );
      this.assertPendingOperationId(result.id, operationId);
      if (result.status !== 'cancelled') throw new Error('approval.cancel_not_confirmed');
      this.events('approval.rejected', { status: 'rejected' });
      return { operationId, status: 'cancelled' as const };
    });
  }

  /** T1.5 (SPEC §8.2/§13): failed → confirmed with a fresh attestation. */
  retry(operationId: string, identity: MutationIdentity): Promise<{ operationId: string; attestation: string }> {
    return this.timed('transactions.retry', async () => {
      const result = await this.request<{ id?: unknown; attestation?: unknown }>(
        'POST', `/pending-operations/v2/${encodeURIComponent(operationId)}/retry`,
        { headers: { 'x-workspace-id': identity.workspaceId, 'x-actor-id': identity.actorId, 'x-device-id': identity.deviceId } },
      );
      this.assertPendingOperationId(result.id, operationId);
      if (typeof result.attestation !== 'string' || result.attestation.length < 32) throw new Error('approval.missing_attestation');
      this.events('approval.confirmed', { status: 'confirmed' });
      return { operationId, attestation: result.attestation };
    });
  }

  /** T3.3: the successful execute relays the API-emitted receipt (schema-validated in MutationExecutor). */
  execute(input: MutationExecution): Promise<{ status: 'succeeded'; operationId: string; receipt?: MutationReceipt }> {
    return this.timed('transactions.execute', () => this.executor.execute(input));
  }

  decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    return this.timed('transactions.decide', () => this.executor.decide(input));
  }
}
