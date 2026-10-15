import { describe, expect, it, vi } from 'vitest';
import { MutationExecutor } from '../../src/mutations/mutation-executor.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { PendingOperationCoordinator } from '../../src/orchestration/pending-operation-coordinator.js';

/**
 * FIX-187 (RED): the V060 durable intention frontier is bypassed on the
 * decide() paths — neither `MutationExecutor.decide` nor
 * `PendingOperationCoordinator.decide` propagates intentionId, so
 * confirm/execute run unbound and the only replay guard is the
 * per-instance `consumed` Set (lost on restart/re-instantiation).
 *
 * Required shape after the fix:
 * - decide(confirm|retry) without intentionId fails closed with ZERO transport;
 * - decide(confirm|retry) with intentionId carries it on the confirm/retry
 *   POST body AND on the execute POST body (API binds + enforces 409);
 * - decide(cancel) needs no binding and is unchanged;
 * - a replayed attestation after re-instantiation (restart) is refused by the
 *   API (403), never replayed locally into success;
 * - a redelivery of the same intentionId against another operation surfaces
 *   the API 409 intention_conflict with zero execute effect;
 * - the success receipt keeps its linkage (operationId = pending id,
 *   entity = persisted transaction).
 */
describe('FIX-187 decide() propagates the durable intention binding (RED)', () => {
  const identity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };
  const faithfulReceipt = (pendingId: string, txId: string) => ({
    mutationId: txId,
    mutationKind: 'transactions.expense.create',
    status: 'succeeded',
    affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
    operationId: pendingId,
    entity: { type: 'transaction', id: txId },
  });
  const faithfulExecute = (pendingId: string, txId: string) => ({
    id: pendingId,
    status: 'succeeded',
    execution: { status: 'succeeded', operationId: txId, receipt: faithfulReceipt(pendingId, txId) },
  });

  it('executor decide(confirm) without intentionId fails closed with zero transport', async () => {
    const request = vi.fn();
    const executor = new MutationExecutor({ request });
    await expect(
      executor.decide({
        operationId: 'op-1',
        decision: 'confirm',
        requestId: 'req-1',
        delegatedToken: 'tok-1',
        identity,
      }),
    ).rejects.toThrow('approval.intention_required');
    expect(request).not.toHaveBeenCalled();
  });

  it('executor decide(retry) without intentionId fails closed with zero transport', async () => {
    const request = vi.fn();
    const executor = new MutationExecutor({ request });
    await expect(
      executor.decide({
        operationId: 'op-1',
        decision: 'retry',
        requestId: 'req-1',
        delegatedToken: 'tok-1',
        identity,
      }),
    ).rejects.toThrow('approval.intention_required');
    expect(request).not.toHaveBeenCalled();
  });

  it('executor decide(cancel) needs no binding and is unchanged', async () => {
    const request = vi.fn().mockResolvedValueOnce({ id: 'op-2', status: 'cancelled' });
    const executor = new MutationExecutor({ request });
    await expect(
      executor.decide({
        operationId: 'op-2',
        decision: 'cancel',
        requestId: 'req-2',
        delegatedToken: 'tok-2',
        identity,
      }),
    ).resolves.toEqual({ operationId: 'op-2', status: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('executor decide(confirm) carries intentionId on confirm AND execute with linked receipt', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-1', attestation: 'a'.repeat(32) })
      .mockResolvedValueOnce(faithfulExecute('op-1', 'mut-1'));
    const executor = new MutationExecutor({ request });

    const result = await executor.decide({
      operationId: 'op-1',
      decision: 'confirm',
      requestId: 'req-1',
      delegatedToken: 'tok-1',
      identity,
      intentionId: 'intent-187-1',
    });

    expect(result).toEqual({ operationId: 'op-1', status: 'succeeded', receipt: faithfulReceipt('op-1', 'mut-1') });
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/op-1/confirm', expect.objectContaining({
      body: { intentionId: 'intent-187-1' },
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/pending-operations/v2/op-1/execute', expect.objectContaining({
      body: { attestation: 'a'.repeat(32), intentionId: 'intent-187-1' },
    }));
  });

  it('executor decide(retry) carries intentionId on the execute leg', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-9', attestation: 'b'.repeat(32) })
      .mockResolvedValueOnce(faithfulExecute('op-9', 'mut-9'));
    const executor = new MutationExecutor({ request });

    const result = await executor.decide({
      operationId: 'op-9',
      decision: 'retry',
      requestId: 'req-9',
      delegatedToken: 'tok-9',
      identity,
      intentionId: 'intent-187-9',
    });

    expect(result.operationId).toBe('op-9');
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/op-9/retry', expect.objectContaining({
      body: { intentionId: 'intent-187-9' },
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/pending-operations/v2/op-9/execute', expect.objectContaining({
      body: { attestation: 'b'.repeat(32), intentionId: 'intent-187-9' },
    }));
  });

  it('replayed attestation after re-instantiation (restart) is refused by the API, never a local success', async () => {
    const attestation = 'c'.repeat(32);
    // First instance consumes and succeeds.
    const first = vi.fn()
      .mockResolvedValueOnce({ id: 'op-1', attestation })
      .mockResolvedValueOnce(faithfulExecute('op-1', 'mut-1'));
    const ok = await new MutationExecutor({ request: first }).decide({
      operationId: 'op-1',
      decision: 'confirm',
      requestId: 'req-1',
      delegatedToken: 'tok-1',
      identity,
      intentionId: 'intent-187-restart',
    });
    expect(ok.status).toBe('succeeded');
    // Restart: brand-new instance (empty `consumed` set) replays the SAME
    // attestation directly. The durable API frontier refuses 403.
    const replay = vi.fn().mockRejectedValueOnce(Object.assign(new Error('approval.attestation_replayed'), { statusCode: 403 }));
    await expect(
      new MutationExecutor({ request: replay }).execute({
        operationId: 'op-1',
        attestation,
        identity,
        intentionId: 'intent-187-restart',
      }),
    ).rejects.toThrow('approval.attestation_replayed');
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('redelivery of the same intentionId against another operation surfaces 409 with zero execute effect', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('approval.intention_conflict'), { statusCode: 409, code: 'approval.intention_conflict' }),
    );
    const executor = new MutationExecutor({ request });
    await expect(
      executor.decide({
        operationId: 'op-B',
        decision: 'confirm',
        requestId: 'req-redelivery',
        delegatedToken: 'tok-1',
        identity,
        intentionId: 'intent-bound-to-A',
      }),
    ).rejects.toThrow('approval.intention_conflict');
    // Confirm refused => execute never attempted.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('coordinator decide(confirm) without intentionId fails closed with zero transport', async () => {
    const request = vi.fn();
    const coordinator = new PendingOperationCoordinator({ client: new MutationApiClient({ request }) });
    await expect(
      coordinator.decide({ operationId: 'op-1', decision: 'confirm', identity }),
    ).rejects.toThrow('approval.intention_required');
    expect(request).not.toHaveBeenCalled();
  });

  it('coordinator decide(confirm) propagates intentionId through confirm+execute', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-1', attestation: 'a'.repeat(40) })
      .mockResolvedValueOnce(faithfulExecute('op-1', 'mut-op-1'));
    const coordinator = new PendingOperationCoordinator({ client: new MutationApiClient({ request }) });
    const result = await coordinator.decide({
      operationId: 'op-1',
      decision: 'confirm',
      identity,
      intentionId: 'intent-coord-1',
    });
    expect(result.status).toBe('succeeded');
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/op-1/confirm', expect.objectContaining({
      body: { intentionId: 'intent-coord-1' },
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/pending-operations/v2/op-1/execute', expect.objectContaining({
      body: { attestation: 'a'.repeat(40), intentionId: 'intent-coord-1' },
    }));
  });

  it('coordinator decide(retry) propagates intentionId to the execute leg', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-9', attestation: 'b'.repeat(40) })
      .mockResolvedValueOnce(faithfulExecute('op-9', 'mut-op-9'));
    const coordinator = new PendingOperationCoordinator({ client: new MutationApiClient({ request }) });
    const result = await coordinator.decide({
      operationId: 'op-9',
      decision: 'retry',
      identity,
      intentionId: 'intent-coord-9',
    });
    expect(result.status).toBe('succeeded');
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/pending-operations/v2/op-9/execute', expect.objectContaining({
      body: { attestation: 'b'.repeat(40), intentionId: 'intent-coord-9' },
    }));
  });

  it('coordinator retry carries intentionId on the retry POST too (uniform with executor.decide)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-9', attestation: 'b'.repeat(40) })
      .mockResolvedValueOnce(faithfulExecute('op-9', 'mut-op-9'));
    const coordinator = new PendingOperationCoordinator({ client: new MutationApiClient({ request }) });
    const result = await coordinator.retry('op-9', identity, 'intent-coord-retry-9');
    expect(result.status).toBe('succeeded');
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/op-9/retry', expect.objectContaining({
      body: { intentionId: 'intent-coord-retry-9' },
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/pending-operations/v2/op-9/execute', expect.objectContaining({
      body: { attestation: 'b'.repeat(40), intentionId: 'intent-coord-retry-9' },
    }));
  });

  it('client.retry without intentionId sends no body (authorize-era callers unaffected)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-9', attestation: 'b'.repeat(40) })
      .mockResolvedValueOnce(faithfulExecute('op-9', 'mut-op-9'));
    const coordinator = new PendingOperationCoordinator({ client: new MutationApiClient({ request }) });
    const result = await coordinator.retry('op-9', identity);
    expect(result.status).toBe('succeeded');
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/op-9/retry', expect.not.objectContaining({
      body: expect.anything(),
    }));
  });
});
