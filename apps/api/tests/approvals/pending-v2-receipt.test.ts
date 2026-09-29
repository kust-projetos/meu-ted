/**
 * T3.2 — TED-path MutationReceipt (SPEC §15.1): every successful approval
 * execution returns a receipt with an API-generated mutationId, registry
 * derived affectedTargets and the origin operationId; the mutationId is
 * persisted into the mutation_id column.
 *
 * RED-first: TX2 currently persists the entity operationId as mutation_id
 * and the execution result carries no receipt.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  computePendingOperationV2Hash,
  MUTATION_EFFECTS_REGISTRY,
  mutationReceiptSchema,
} from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  type PendingIdentity,
  type PendingOperationV2Store,
} from '../../src/approvals/pending-v2.js';

const newIdentity = (): PendingIdentity => ({
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  deviceId: randomUUID(),
});

const proposeCanonical = async (store: PendingOperationV2Store, identity: PendingIdentity) => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'Receipt probe',
      amountCents: 500,
      date: '2026-09-14',
      accountId: randomUUID(),
      categoryId: randomUUID(),
    },
    proposalHash: '',
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    bindings: {
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    },
  };
  const proposalHash = await computePendingOperationV2Hash(base);
  return store.propose({ ...base, proposalHash });
};

describe('TED execute success emits a MutationReceipt', () => {
  it('plain executor result gains a receipt; mutation_id persists the receipt identity', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const id = newIdentity();
    const saved = await proposeCanonical(store, id);
    const confirmed = await store.confirm(saved.id, id);
    const entityId = randomUUID();
    const done = await store.execute(confirmed.attestation!, id, async () => ({
      status: 'succeeded' as const,
      operationId: entityId,
    }));

    expect(done.status).toBe('succeeded');
    const execution = done.execution as {
      status: string;
      operationId: string;
      receipt: Record<string, unknown>;
    };
    // Existing envelope preserved (additive).
    expect(execution.status).toBe('succeeded');
    expect(execution.operationId).toBe(entityId);
    // Receipt present with origin pending-operation id + registry-derived targets.
    expect(execution.receipt).toBeTruthy();
    expect(execution.receipt.operationId).toBe(saved.id);
    expect(execution.receipt.operationId).not.toBe(entityId);
    expect(execution.receipt.entity).toEqual({ type: 'transaction', id: entityId });
    expect(execution.receipt.mutationKind).toBe('transactions.expense.create');
    expect(execution.receipt.affectedTargets).toEqual(
      MUTATION_EFFECTS_REGISTRY['transactions.expense.create'].affectedTargets,
    );
    expect(mutationReceiptSchema.safeParse(execution.receipt).success).toBe(true);
    // mutation_id persists the RECEIPT identity, not the entity id.
    expect(done.mutationId).toBe(execution.receipt.mutationId);
    expect(typeof done.mutationId).toBe('string');
  });

  it('executor-provided receipt mutationId is honored, not replaced', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const id = newIdentity();
    const saved = await proposeCanonical(store, id);
    const confirmed = await store.confirm(saved.id, id);
    const entityId = randomUUID();
    const mutationId = randomUUID();
    const done = await store.execute(confirmed.attestation!, id, async () => ({
      status: 'succeeded' as const,
      operationId: entityId,
      receipt: {
        mutationId,
        mutationKind: 'transactions.expense.create' as const,
        status: 'succeeded' as const,
        affectedTargets: [
          ...MUTATION_EFFECTS_REGISTRY['transactions.expense.create'].affectedTargets,
        ],
        operationId: entityId,
        entity: { type: 'transaction', id: entityId },
      },
    }));
    const execution = done.execution as { operationId: string; receipt: Record<string, unknown> };
    expect(execution.operationId).toBe(entityId);
    // Executor-stamped tx id is normalized to the origin pending-operation id.
    expect(execution.receipt.operationId).toBe(saved.id);
    expect(execution.receipt.entity).toEqual({ type: 'transaction', id: entityId });
    expect(done.mutationId).toBe(mutationId);
  });

  it('two executions yield distinct mutationIds', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const runOnce = async () => {
      const id = newIdentity();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      return store.execute(confirmed.attestation!, id, async () => ({
        status: 'succeeded' as const,
        operationId: randomUUID(),
      }));
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(first.mutationId).not.toBe(second.mutationId);
  });
});
