/**
 * RED-first: API execute must normalize TED receipt identity.
 * Contract (real shape):
 * - execution.operationId = transaction id (executor result.operationId)
 * - execution.receipt.operationId = origin pending operation id (claimed.id)
 * - execution.receipt.entity = { type:'transaction', id: transaction id }
 * Never confuse pending ID with transaction ID.
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
      description: 'Normalization probe',
      amountCents: 700,
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

describe('TED receipt identity normalization (RED)', () => {
  it('plain executor result builds receipt with pending ID as operationId and tx ID as entity.id', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const id = newIdentity();
    const saved = await proposeCanonical(store, id);
    const confirmed = await store.confirm(saved.id, id);
    const transactionId = randomUUID();
    const done = await store.execute(confirmed.attestation!, id, async () => ({
      status: 'succeeded' as const,
      operationId: transactionId,
    }));

    expect(done.status).toBe('succeeded');
    const execution = done.execution as { status: string; operationId: string; receipt: Record<string, unknown> };
    expect(execution.status).toBe('succeeded');
    expect(execution.operationId).toBe(transactionId);
    expect(execution.receipt).toBeTruthy();
    // Pending ID wins in receipt.operationId; tx ID lives in entity.id.
    expect(execution.receipt.operationId).toBe(saved.id);
    expect(execution.receipt.operationId).not.toBe(transactionId);
    expect(execution.receipt.entity).toEqual({ type: 'transaction', id: transactionId });
    expect(mutationReceiptSchema.safeParse(execution.receipt).success).toBe(true);
    expect(done.mutationId).toBe(execution.receipt.mutationId);
  });

  it('executor-provided receipt with tx ID as operationId is normalized to the pending ID', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const id = newIdentity();
    const saved = await proposeCanonical(store, id);
    const confirmed = await store.confirm(saved.id, id);
    const transactionId = randomUUID();
    const mutationId = randomUUID();
    const done = await store.execute(confirmed.attestation!, id, async () => ({
      status: 'succeeded' as const,
      operationId: transactionId,
      receipt: {
        mutationId,
        mutationKind: 'transactions.expense.create' as const,
        status: 'succeeded' as const,
        affectedTargets: [...MUTATION_EFFECTS_REGISTRY['transactions.expense.create'].affectedTargets],
        // Executor (tool-registry) currently stamps the tx ID here — store must normalize.
        operationId: transactionId,
        entity: { type: 'transaction', id: transactionId },
      },
    }));

    const execution = done.execution as { operationId: string; receipt: Record<string, unknown> };
    expect(execution.operationId).toBe(transactionId);
    expect(execution.receipt.operationId).toBe(saved.id);
    expect(execution.receipt.entity).toEqual({ type: 'transaction', id: transactionId });
    expect(execution.receipt.mutationId).toBe(mutationId);
    expect(mutationReceiptSchema.safeParse(execution.receipt).success).toBe(true);
    expect(done.mutationId).toBe(mutationId);
  });

  it('missing transaction id is an uncertain post-write outcome, kept executing for lease recovery', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const id = newIdentity();
    const saved = await proposeCanonical(store, id);
    const confirmed = await store.confirm(saved.id, id);
    await expect(
      store.execute(confirmed.attestation!, id, async () => ({ status: 'succeeded' as const })),
    ).rejects.toMatchObject({ code: 'approval.execution_uncertain' });
    const uncertain = await store.get(saved.id, id);
    expect(uncertain.status).toBe('executing');
    expect(uncertain.failureCode).toBeUndefined();
    await expect(store.retry(saved.id, id)).rejects.toMatchObject({ code: 'approval.retry_not_allowed' });
  });

  it('semantically mismatched executor receipt is replaced by the canonical registry receipt', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const id = newIdentity();
    const saved = await proposeCanonical(store, id);
    const confirmed = await store.confirm(saved.id, id);
    const transactionId = randomUUID();
    const mutationId = randomUUID();
    let calls = 0;
    const done = await store.execute(confirmed.attestation!, id, async () => {
      calls += 1;
      return {
        status: 'succeeded' as const,
        operationId: transactionId,
        receipt: {
          mutationId,
          // Wrong kind/targets/entity for the expense tool — canonical wins.
          mutationKind: 'transactions.income.create' as const,
          status: 'succeeded' as const,
          affectedTargets: [...MUTATION_EFFECTS_REGISTRY['transactions.income.create'].affectedTargets],
          operationId: transactionId,
          entity: { type: 'account', id: transactionId },
        },
      };
    });

    // One executor run, no failure.
    expect(calls).toBe(1);
    expect(done.status).toBe('succeeded');
    const execution = done.execution as { operationId: string; receipt: Record<string, unknown> };
    expect(execution.operationId).toBe(transactionId);
    // Canonical identity: pending id + transaction entity, registry kind/targets.
    expect(execution.receipt.operationId).toBe(saved.id);
    expect(execution.receipt.entity).toEqual({ type: 'transaction', id: transactionId });
    expect(execution.receipt.mutationKind).toBe('transactions.expense.create');
    expect(execution.receipt.affectedTargets).toEqual(
      MUTATION_EFFECTS_REGISTRY['transactions.expense.create'].affectedTargets,
    );
    // Executor mutationId identity is preserved.
    expect(execution.receipt.mutationId).toBe(mutationId);
    expect(mutationReceiptSchema.safeParse(execution.receipt).success).toBe(true);
    expect(done.mutationId).toBe(mutationId);
  });
});
