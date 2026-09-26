import { describe, expect, it } from 'vitest';
import { createInMemoryPendingOperationStore } from '../../src/approvals/pending.js';

describe('pending operations', () => {
  it('persists requester and approval metadata', async () => {
    const store = createInMemoryPendingOperationStore();
    const pending = await store.create({
      householdId: 'workspace-1', requesterId: 'user-1', operation: 'transactions.expense.create',
      payload: { amountCents: 50_000 }, reason: 'high_value', idempotencyKey: 'intent-1',
    });

    expect(pending).toMatchObject({ householdId: 'workspace-1', requesterId: 'user-1', status: 'pending', reason: 'high_value' });
  });

  it('allows only requester to approve', async () => {
    const store = createInMemoryPendingOperationStore();
    const pending = await store.create({
      householdId: 'workspace-1', requesterId: 'user-1', operation: 'transactions.expense.create',
      payload: {}, reason: 'high_value', idempotencyKey: 'intent-1',
    });

    await expect(store.approve(pending.id, 'workspace-1', 'user-2')).rejects.toMatchObject({ code: 'approval.requester_only' });
  });

  it('approves and executes a pending operation exactly once', async () => {
    const store = createInMemoryPendingOperationStore();
    const pending = await store.create({
      householdId: 'workspace-1', requesterId: 'user-1', operation: 'transactions.expense.create',
      payload: {}, reason: 'high_value', idempotencyKey: 'intent-1',
    });
    let executions = 0;

const approved = await store.approve(pending.id, 'workspace-1', 'user-1', async () => {
      executions += 1;
      return { transactionId: 'tx-1' };
    });
    expect(approved).toMatchObject({ status: 'approved', execution: { transactionId: 'tx-1' } });
    const retried = await store.approve(pending.id, 'workspace-1', 'user-1', async () => {
      executions += 1;
      return { transactionId: 'tx-1' };
    });
    expect(retried).toMatchObject({ status: 'approved', execution: { transactionId: 'tx-1' } });
    expect(executions).toBe(1);
  });

  describe('idempotency identity (Security P2)', () => {
    const baseInput = {
      householdId: 'workspace-1', requesterId: 'user-1', operation: 'transactions.expense.create',
      payload: { amountCents: 50_000 }, reason: 'high_value' as const, idempotencyKey: 'intent-idem',
    };

    it('identical retry returns the same pending id', async () => {
      const store = createInMemoryPendingOperationStore();
      const first = await store.create(baseInput);
      const second = await store.create({ ...baseInput });
      expect(second.id).toBe(first.id);
    });

    it('divergent payload conflicts with idempotency.conflict 409', async () => {
      const store = createInMemoryPendingOperationStore();
      await store.create(baseInput);
      await expect(
        store.create({ ...baseInput, payload: { amountCents: 99_999 } }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict', statusCode: 409 });
    });

    it('divergent operation conflicts with idempotency.conflict 409', async () => {
      const store = createInMemoryPendingOperationStore();
      await store.create(baseInput);
      await expect(
        store.create({ ...baseInput, operation: 'transactions.income.create' }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict', statusCode: 409 });
    });

    it('divergent requester (actor) conflicts with idempotency.conflict 409', async () => {
      const store = createInMemoryPendingOperationStore();
      await store.create(baseInput);
      await expect(
        store.create({ ...baseInput, requesterId: 'user-2' }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict', statusCode: 409 });
    });

    it('concurrent racing identical inserts resolve to the same pending id', async () => {
      const store = createInMemoryPendingOperationStore();
      const [a, b] = await Promise.all([store.create({ ...baseInput }), store.create({ ...baseInput })]);
      expect(a.id).toBe(b.id);
    });

    it('different workspace scopes do not conflict', async () => {
      const store = createInMemoryPendingOperationStore();
      const first = await store.create(baseInput);
      const second = await store.create({ ...baseInput, householdId: 'workspace-2' });
      expect(second.id).not.toBe(first.id);
    });
  });
});
