import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  type PendingIdentity,
} from '../../src/approvals/pending-v2.js';
import { createApprovalExecutionUncertainError } from '../../src/approvals/tool-registry.js';

const identity: PendingIdentity = {
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  deviceId: randomUUID(),
};

describe('F5 crash recovery', () => {
  it('reconciles a claimed operation with the same key and links one effect receipt to its pending and entity ids', async () => {
    const leaseMs = 25;
    const store = createInMemoryPendingOperationV2Store({ leaseMs });
    const key = randomUUID();
    const base = {
      version: 2 as const,
      ...identity,
      tool: 'transactions.expense.create',
      normalizedArgs: {
        description: 'F5 recovery probe',
        amountCents: 1234,
        date: '2026-10-30',
        accountId: randomUUID(),
        categoryId: randomUUID(),
      },
      proposalHash: '',
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bindings: identity,
    };
    const saved = await store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
    const confirmed = await store.confirm(saved.id, identity);

    const effects = new Map<string, string>();
    const seenKeys: string[] = [];
    const first = store.execute(confirmed.attestation!, identity, async (operation) => {
      const idempotencyKey = operation.idempotencyKey;
      seenKeys.push(idempotencyKey);
      if (!effects.has(idempotencyKey)) {
        effects.set(idempotencyKey, `entity-${idempotencyKey}`);
      }
      throw createApprovalExecutionUncertainError();
    });
    await expect(first).rejects.toMatchObject({ code: 'approval.execution_uncertain' });
    expect(effects.size).toBe(1);
    const claimed = await store.get(saved.id, identity);
    expect(claimed.status).toBe('executing');
    expect(claimed.executionAttemptCount).toBe(1);

    const recovered = await (async () => {
      const deadline = Date.now() + 2_000;
      while (Date.parse((await store.get(saved.id, identity)).executionLeaseExpiresAt!) > Date.now()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for execution lease');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return store.reconcileExpiredExecuting(saved.id, identity, async (operation) => {
        seenKeys.push(operation.idempotencyKey);
        let entityId = effects.get(operation.idempotencyKey);
        if (!entityId) {
          entityId = `entity-${operation.idempotencyKey}`;
          effects.set(operation.idempotencyKey, entityId);
        }
        return { status: 'succeeded', operationId: entityId };
      });
    })();

    expect(recovered.status).toBe('succeeded');
    expect(seenKeys).toEqual([key, key]);
    expect(effects.size).toBe(1);
    const execution = recovered.execution as { receipt: { operationId: string; entity: { type: string; id: string } } };
    expect(execution.receipt.operationId).toBe(saved.id);
    expect(execution.receipt.entity).toEqual({ type: 'transaction', id: `entity-${key}` });
    expect((await store.get(saved.id, identity)).execution).toEqual(recovered.execution);
  });
});
