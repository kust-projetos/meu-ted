import { describe, expect, it, vi } from 'vitest';
import { MutationExecutor } from '../../src/mutations/mutation-executor.js';

/**
 * RED-first: MutationExecutor.execute must validate the complete faithful shape.
 * - result.status === 'succeeded'
 * - result.id === input.operationId (trimmed, non-empty)
 * - execution object with status === 'succeeded' + transaction operationId
 * - receipt mandatory, schema-valid, receipt.operationId === input.operationId
 * - receipt.entity.id === execution.operationId (transaction linkage)
 */
describe('MutationExecutor strict execute validation (RED)', () => {
  const pendingId = 'op-pending-strict-1';
  const transactionId = 'mut-tx-strict-1';
  const faithfulReceipt = {
    mutationId: 'mut-id-1',
    mutationKind: 'transactions.expense.create',
    status: 'succeeded',
    affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
    operationId: pendingId,
    entity: { type: 'transaction', id: transactionId },
  };
  const faithfulResponse = {
    id: pendingId,
    status: 'succeeded',
    execution: { status: 'succeeded', operationId: transactionId, receipt: faithfulReceipt },
  };
  const input = {
    operationId: pendingId,
    attestation: 'a'.repeat(32),
    identity: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
  };
  const decisionInput = {
    operationId: pendingId,
    decision: 'confirm' as const,
    requestId: 'request-1',
    delegatedToken: 'delegated-token',
    identity: input.identity,
  };

  it('succeeds on the faithful shape with linked receipt', async () => {
    const request = vi.fn().mockResolvedValueOnce(faithfulResponse);
    const executor = new MutationExecutor({ request });
    const result = await executor.execute(input);
    expect(result).toEqual({ status: 'succeeded', operationId: pendingId, receipt: faithfulReceipt });
  });

  it('fails closed on partial {id,status} without execution/receipt', async () => {
    const request = vi.fn().mockResolvedValueOnce({ id: pendingId, status: 'succeeded' });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when id mismatches the input operationId', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      id: 'op-other',
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, receipt: faithfulReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when receipt.operationId is the tx id instead of the pending id', async () => {
    const badReceipt = { ...faithfulReceipt, operationId: transactionId };
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, receipt: badReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when receipt.entity.id does not link the execution transaction', async () => {
    const badReceipt = { ...faithfulReceipt, entity: { type: 'transaction', id: 'mut-other' } };
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, receipt: badReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when receipt.entity.type is not transaction', async () => {
    const badReceipt = { ...faithfulReceipt, entity: { type: 'account', id: transactionId } };
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, receipt: badReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when execution.status is not succeeded', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'failed', operationId: transactionId, receipt: faithfulReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when execution.operationId is empty', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: '   ', receipt: faithfulReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('fails closed when execution.mutationId disagrees with receipt.mutationId', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, mutationId: 'mut-other', receipt: faithfulReceipt },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('succeeds when execution.mutationId agrees with receipt.mutationId', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, mutationId: 'mut-id-1', receipt: faithfulReceipt },
    });
    const executor = new MutationExecutor({ request });
    const result = await executor.execute(input);
    expect(result).toEqual({ status: 'succeeded', operationId: pendingId, receipt: faithfulReceipt });
  });

  it('fails closed when receipt is missing', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      id: pendingId,
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId },
    });
    const executor = new MutationExecutor({ request });
    await expect(executor.execute(input)).rejects.toThrow('approval.incomplete_result');
  });

  it('confirm refuses a response bound to a different pending operation', async () => {
    const request = vi.fn().mockResolvedValueOnce({ id: 'op-other', attestation: 'a'.repeat(32) });
    const executor = new MutationExecutor({ request });

    await expect(executor.confirm(pendingId, input.identity, 'delegated-token'))
      .rejects.toThrow('approval.operation_id_mismatch');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['confirm', 'confirm'],
    ['retry', 'retry'],
    ['cancel', 'cancel'],
  ] as const)('%s refuses a response bound to a different pending operation before execution', async (decision, path) => {
    const request = vi.fn().mockResolvedValueOnce({
      id: 'op-other',
      attestation: 'a'.repeat(32),
      executionStatus: 'cancelled',
    });
    const executor = new MutationExecutor({ request });

    await expect(executor.decide({ ...decisionInput, decision }))
      .rejects.toThrow('approval.operation_id_mismatch');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toContain(`/pending-operations/v2/${pendingId}/${path}`);
  });

  it('cancel does not report success unless the API confirms the cancelled state', async () => {
    const request = vi.fn().mockResolvedValueOnce({ id: pendingId, status: 'proposed' });
    const executor = new MutationExecutor({ request });

    await expect(executor.decide({ ...decisionInput, decision: 'cancel' }))
      .rejects.toThrow('approval.cancel_not_confirmed');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
