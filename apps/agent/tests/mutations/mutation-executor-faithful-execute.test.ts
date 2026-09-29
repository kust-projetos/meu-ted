import { describe, expect, it, vi } from 'vitest';
import { MutationExecutor } from '../../src/mutations/mutation-executor.js';

/**
 * Safety-critical regression: the authoritative API
 * `POST /pending-operations/v2/:id/execute` returns the store record
 * `{ id: <pending-op UUID>, status, execution: { operationId: <tx id>, receipt } }`
 * with NO top-level `operationId`. The Agent adapter must treat `id` as the
 * pending-operation id and must not confuse execution.operationId /
 * mutationId / entity.id with it. Missing `id` stays fail-closed.
 */
describe('MutationExecutor faithful execute shape (RED)', () => {
  const pendingId = 'op-pending-1';
  const transactionId = 'mut-tx-1';
  const faithfulReceipt = {
    mutationId: transactionId,
    mutationKind: 'transactions.expense.create',
    status: 'succeeded',
    affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
    operationId: pendingId,
    entity: { type: 'transaction', id: transactionId },
  };
  const faithfulExecuteResponse = {
    id: pendingId,
    status: 'succeeded',
    execution: {
      status: 'succeeded',
      operationId: transactionId,
      receipt: faithfulReceipt,
    },
  };

  it('decide(confirm) succeeds on the faithful record without top-level operationId', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: pendingId, attestation: 'a'.repeat(32) })
      .mockResolvedValueOnce(faithfulExecuteResponse);
    const executor = new MutationExecutor({ request });

    const result = await executor.decide({
      operationId: pendingId,
      decision: 'confirm',
      requestId: 'req-faithful-1',
      delegatedToken: 'approval-token-1',
      identity: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
    });

    expect(result).toEqual({ operationId: pendingId, status: 'succeeded', receipt: faithfulReceipt });
    // Pending-operation id wins — never the transaction/mutation id.
    expect(result.operationId).toBe(pendingId);
    expect(result.operationId).not.toBe(transactionId);
  });

  it('fails closed when the faithful record has no id', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: transactionId, receipt: faithfulReceipt },
    });
    const executor = new MutationExecutor({ request });

    await expect(
      executor.execute({
        operationId: pendingId,
        attestation: 'a'.repeat(32),
        identity: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
      }),
    ).rejects.toThrow('approval.incomplete_result');
  });
});
