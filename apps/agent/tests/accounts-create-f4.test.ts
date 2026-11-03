import { describe, expect, it, vi } from 'vitest';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { MutationExecutor } from '../src/mutations/mutation-executor.js';

describe('F4 accounts.create manual V2 flow', () => {
  it('proposes, requires confirmation, returns a linked receipt, and accepts an identical replay receipt', async () => {
    const identity = { workspaceId: 'ws-f4', actorId: 'actor-f4', deviceId: 'device-f4' };
    const pendingId = 'pending-f4';
    const accountId = 'account-f4';
    const attestation = 'a'.repeat(40);
    let proposalKey: string | undefined;
    let executed = false;
    let execution: Record<string, unknown> | undefined;

    const request = vi.fn(async (method: string, path: string, options: { body?: Record<string, unknown>; idempotencyKey?: string }) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const key = options.idempotencyKey;
        const existing = proposalKey === key;
        if (proposalKey && key !== proposalKey) throw new Error('idempotency.conflict');
        proposalKey = key;
        expect(options.body).toMatchObject({
          tool: 'accounts.create',
          normalizedArgs: { name: 'Reserva', kind: 'cash', initialBalanceCents: 0 },
        });
        return { id: pendingId, existing };
      }
      if (method === 'POST' && path === `/pending-operations/v2/${pendingId}/confirm`) {
        return { id: pendingId, attestation };
      }
      if (method === 'POST' && path === `/pending-operations/v2/${pendingId}/execute`) {
        // This mock simulates the API boundary and returns its persisted result;
        // it does NOT prove durable backend idempotency or count backend effects.
        if (!executed) {
          executed = true;
          execution = {
            status: 'succeeded',
            operationId: accountId,
            receipt: {
              mutationId: 'mutation-f4',
              mutationKind: 'accounts.create',
              status: 'succeeded',
              affectedTargets: ['accounts'],
              operationId: pendingId,
              entity: { type: 'account', id: accountId },
            },
          };
        }
        return { id: pendingId, status: 'succeeded', execution };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const firstClient = new MutationApiClient({ request: request as never, events: () => undefined });
    const proposal = await firstClient.propose({
      tool: 'accounts.create',
      normalizedArgs: { name: 'Reserva', kind: 'cash', initialBalanceCents: 0 },
      summary: 'Conta Reserva',
      identity,
      idempotencyKey: 'intent-f4-proposal',
    });
    expect(proposal.id).toBe(pendingId);
    expect(proposal.operation.tool).toBe('accounts.create');
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/execute'))).toHaveLength(0);
    expect(request.mock.calls.every(([, , options]) =>
      (options as { headers?: Record<string, string> }).headers?.['x-workspace-id'] === identity.workspaceId,
    )).toBe(true);

    const first = await firstClient.decide({
      operationId: pendingId,
      decision: 'confirm',
      requestId: 'request-f4',
      delegatedToken: 'delegated-f4',
      identity,
      intentionId: 'intent-f4-confirm',
      expected: { tool: 'accounts.create' },
    });
    expect(first.status).toBe('succeeded');
    expect(first.receipt).toMatchObject({
      mutationKind: 'accounts.create',
      operationId: pendingId,
      entity: { type: 'account', id: accountId },
    });

    // Simulate redelivery after process restart: the API's durable idempotency
    // boundary, not the executor's in-memory consumed-attestation set, wins.
    const replayClient = new MutationApiClient({ request: request as never, events: () => undefined });
    const replayProposal = await replayClient.propose({
      tool: 'accounts.create',
      normalizedArgs: { name: 'Reserva', kind: 'cash', initialBalanceCents: 0 },
      summary: 'Conta Reserva',
      identity,
      idempotencyKey: 'intent-f4-proposal',
    });
    expect(replayProposal.id).toBe(pendingId);
    expect(replayProposal.existing).toBe(true);
    const replay = await replayClient.decide({
      operationId: pendingId,
      decision: 'confirm',
      requestId: 'request-f4-replay',
      delegatedToken: 'delegated-f4',
      identity,
      intentionId: 'intent-f4-confirm',
      expected: { tool: 'accounts.create' },
    });
    expect(replay.receipt).toEqual(first.receipt);
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/execute'))).toHaveLength(2);
  });

  it('accepts a replay response with the identical receipt without exposing another mutation result', async () => {
    const identity = { workspaceId: 'ws-f4', actorId: 'actor-f4', deviceId: 'device-f4' };
    const receipt = {
      mutationId: 'mutation-f4',
      mutationKind: 'accounts.create',
      status: 'succeeded',
      affectedTargets: ['accounts'],
      operationId: 'pending-f4',
      entity: { type: 'account', id: 'account-f4' },
    };
    const response = {
      id: 'pending-f4',
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: 'account-f4', receipt },
    };
    const request = vi.fn(async () => response);
    const replayClient = new MutationApiClient({ request: request as never, events: () => undefined });

    const first = await replayClient.execute({
      operationId: 'pending-f4', attestation: 'a'.repeat(40), identity,
      expected: { tool: 'accounts.create' },
    });
    const replay = await replayClient.execute({
      operationId: 'pending-f4', attestation: 'b'.repeat(40), identity,
      expected: { tool: 'accounts.create' },
    });

    expect(first).toEqual(replay);
    expect(first.receipt).toEqual(receipt);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['entity.id', { entity: { type: 'account', id: 'another-account' } }],
    ['operationId', { operationId: 'another-pending' }],
  ])('fails closed when replay receipt has a divergent %s', async (_field, receiptOverride) => {
    const request = vi.fn(async () => ({
      id: 'pending-f4',
      status: 'succeeded',
      execution: {
        status: 'succeeded',
        operationId: 'account-f4',
        receipt: {
          mutationId: 'mutation-f4',
          mutationKind: 'accounts.create',
          status: 'succeeded',
          affectedTargets: ['accounts'],
          operationId: 'pending-f4',
          entity: { type: 'account', id: 'account-f4' },
          ...receiptOverride,
        },
      },
    }));
    const executor = new MutationExecutor({ request: request as never, events: () => undefined });

    await expect(executor.execute({
      operationId: 'pending-f4', attestation: 'c'.repeat(40),
      identity: { workspaceId: 'ws-f4', actorId: 'actor-f4', deviceId: 'device-f4' },
      expected: { tool: 'accounts.create' },
    })).rejects.toThrow('approval.incomplete_result');
  });
});
