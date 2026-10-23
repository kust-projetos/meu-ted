import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationExecutor } from '../../src/mutations/mutation-executor.js';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { createAgentConnectionToken } from '../../../api/src/auth/agent-connection-token.js';

describe('MutationExecutor approval decision RPC', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });
  /** API execute response shaped like the authoritative record (mapV2): top-level
   * `id` is the pending-operation id; `execution.operationId` names the
   * persisted transaction — never the decision id. No top-level `operationId`. */
  const apiExecutionWithReceipt = {
    id: 'op-1',
    status: 'succeeded',
    mutationId: 'mut-1',
    execution: {
      status: 'succeeded',
      operationId: 'mut-1',
      receipt: {
        mutationId: 'mut-1',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-1',
        entity: { type: 'transaction', id: 'mut-1' },
      },
    },
  };
  const expectedReceipt = {
    mutationId: 'mut-1',
    mutationKind: 'transactions.expense.create',
    status: 'succeeded',
    affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
    operationId: 'op-1',
    entity: { type: 'transaction', id: 'mut-1' },
  };

  it('executes a confirmed operation with the per-request delegated approval token and returns only the safe DTO', async () => {
    const receiptForOp1 = {
      mutationId: 'mut-1',
      mutationKind: 'transactions.expense.create',
      status: 'succeeded',
      affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
      operationId: 'op-1',
      entity: { type: 'transaction', id: 'mut-1' },
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-1', attestation: 'a'.repeat(32) })
      .mockResolvedValueOnce({ id: 'op-1', status: 'succeeded', execution: { status: 'succeeded', operationId: 'mut-1', receipt: receiptForOp1 }, attestation: 'must-not-escape' });
    const executor = new MutationExecutor({ request });

    const result = await executor.decide({
      operationId: 'op-1',
      decision: 'confirm',
      requestId: 'req-1',
      delegatedToken: 'approval-token-1',
      identity: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
      intentionId: 'intent-rpc-1',
      expected: { tool: 'transactions.expense.create' },
    });

    expect(result).toEqual({ operationId: 'op-1', status: 'succeeded', receipt: receiptForOp1 });
    expect(result).not.toHaveProperty('attestation');
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/op-1/confirm', expect.objectContaining({
      delegatedToken: 'approval-token-1',
      body: { intentionId: 'intent-rpc-1' },
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/pending-operations/v2/op-1/execute', expect.objectContaining({
      delegatedToken: 'approval-token-1',
      body: { attestation: 'a'.repeat(32), intentionId: 'intent-rpc-1' },
    }));
  });

  it('propagates the API execution receipt and never any attestation material (executor path)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'op-1', attestation: 'a'.repeat(32) })
      .mockResolvedValueOnce({ ...apiExecutionWithReceipt, attestation: 'must-not-escape' });
    const executor = new MutationExecutor({ request });

    const result = await executor.decide({
      operationId: 'op-1',
      decision: 'confirm',
      requestId: 'req-receipt-1',
      delegatedToken: 'approval-token-1',
      identity: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
      intentionId: 'intent-rpc-receipt-1',
      expected: { tool: 'transactions.expense.create' },
    });

    expect(result).toEqual({ operationId: 'op-1', status: 'succeeded', receipt: expectedReceipt });
    // INV-05: the receipt relayed to the PWA carries zero authority material.
    expect(JSON.stringify(result)).not.toContain('attestation');
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
  });

  it('routes the authenticated Worker RPC and returns the receipt without attestation material', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'owner', deviceId: 'device-1' }, secret);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'op-4', status: 'proposed', tool: 'transactions.expense.create', createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'op-4', attestation: 'a'.repeat(32) }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'op-4', status: 'succeeded', mutationId: 'mut-4', attestation: 'must-not-escape', execution: { status: 'succeeded', operationId: 'mut-4', receipt: { ...expectedReceipt, mutationId: 'mut-4', operationId: 'op-4', entity: { type: 'transaction', id: 'mut-4' } } } }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await agent.fetch(new Request('https://agent.test.local/rpc/pending-operations/op-4/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ decision: 'confirm', requestId: 'req-4' }),
    }));

    expect(response.status).toBe(200);
    const json = (await response.json()) as { operationId?: string; status?: string; receipt?: unknown };
    expect(json.operationId).toBe('op-4');
    expect(json.status).toBe('succeeded');
    expect(json.receipt).toEqual({ ...expectedReceipt, mutationId: 'mut-4', operationId: 'op-4', entity: { type: 'transaction', id: 'mut-4' } });
    expect(JSON.stringify(json)).not.toContain('attestation');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pending-operations/v2/active');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/pending-operations/v2/op-4/confirm');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/pending-operations/v2/op-4/execute');
  });

  it('cancels without accepting browser-supplied identity or attestation fields', async () => {
    const request = vi.fn().mockResolvedValueOnce({ id: 'op-2', status: 'cancelled', executionStatus: 'cancelled' });
    const executor = new MutationExecutor({ request });

    await expect(executor.decide({
      operationId: 'op-2',
      decision: 'cancel',
      requestId: 'req-2',
      delegatedToken: 'approval-token-2',
      identity: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
    })).resolves.toEqual({ operationId: 'op-2', status: 'cancelled' });
    expect(request).toHaveBeenCalledWith('POST', '/pending-operations/v2/op-2/cancel', expect.objectContaining({ delegatedToken: 'approval-token-2' }));
  });

  it('routes the authenticated Worker RPC and never exposes approval internals to the browser', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'owner', deviceId: 'device-1' }, secret);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'op-3', status: 'proposed', tool: 'transactions.expense.create', createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'op-3', attestation: 'a'.repeat(32) }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'op-3', status: 'succeeded', execution: { status: 'succeeded', operationId: 'mut-3', receipt: { mutationId: 'mut-3', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId: 'op-3', entity: { type: 'transaction', id: 'mut-3' } } } }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await agent.fetch(new Request('https://agent.test.local/rpc/pending-operations/op-3/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ decision: 'confirm', requestId: 'req-3' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operationId: 'op-3', status: 'succeeded', receipt: { mutationId: 'mut-3', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId: 'op-3', entity: { type: 'transaction', id: 'mut-3' } } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pending-operations/v2/active');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/pending-operations/v2/op-3/confirm');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/pending-operations/v2/op-3/execute');
  });

  it('button confirm without the operation in the scoped listing fails closed with zero confirm/execute', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'owner', deviceId: 'device-1' }, secret);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await agent.fetch(new Request('https://agent.test.local/rpc/pending-operations/op-ghost/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ decision: 'confirm', requestId: 'req-ghost' }),
    }));

    expect(response.status).toBe(409);
    const json = (await response.json()) as { code?: string };
    expect(json.code).toBe('agent.context_unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pending-operations/v2/active');
  });

  it('reports category in_use only after a scoped authoritative failed reread', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'owner', deviceId: 'device-1' }, secret);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const presentation = { version: 1, title: 'Desativar categoria', tool: 'categories.deactivate', description: 'QA', category: { id: 'cat-1', label: 'QA' }, warnings: [] };
    const proposed = { id: 'op-cat', status: 'proposed', tool: 'categories.deactivate', categoryId: 'cat-1', presentation, createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z' };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ items: [proposed], total: 1 }))
      .mockResolvedValueOnce(Response.json({ id: 'op-cat', attestation: 'a'.repeat(32) }))
      .mockResolvedValueOnce(Response.json({ code: 'approval.in_use' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ items: [{ ...proposed, status: 'failed', failureCode: 'in_use' }], total: 1 }));
    const response = await agent.fetch(new Request('https://agent.test.local/rpc/pending-operations/op-cat/decision', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-connection-token': token, 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1', 'x-agent-device': 'device-1' },
      body: JSON.stringify({ decision: 'confirm', requestId: 'req-cat' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operationId: 'op-cat', status: 'failed', retryable: false, failureCode: 'in_use' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/pending-operations/v2/active');
  });

  it('button confirm on a sensitive operation without a resolvable target fails closed with zero confirm/execute', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'owner', deviceId: 'device-1' }, secret);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'op-rename-1', status: 'proposed', tool: 'accounts.update', createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await agent.fetch(new Request('https://agent.test.local/rpc/pending-operations/op-rename-1/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ decision: 'confirm', requestId: 'req-rename-1' }),
    }));

    expect(response.status).toBe(409);
    const json = (await response.json()) as { code?: string };
    expect(json.code).toBe('agent.context_unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pending-operations/v2/active');
  });

  it('button confirm for an absent operation never selects another pending (op-B untouched)', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'owner', deviceId: 'device-1' }, secret);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'op-live-B', status: 'proposed', tool: 'transactions.expense.create', createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await agent.fetch(new Request('https://agent.test.local/rpc/pending-operations/op-ghost-A/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ decision: 'confirm', requestId: 'req-ghost-A' }),
    }));

    expect(response.status).toBe(409);
    const json = (await response.json()) as { code?: string };
    expect(json.code).toBe('agent.context_unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pending-operations/v2/active');
  });

  it('fails closed when the connection token/device is absent or the browser adds fields to the strict body', async () => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
    const baseHeaders = { 'content-type': 'application/json', 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1' };
    const missingDevice = await agent.fetch(new Request('https://agent.test/rpc/pending-operations/op-1/decision', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ decision: 'cancel', requestId: 'req-1' }) }));
    expect(missingDevice.status).toBe(401);

    const invalidBody = await agent.fetch(new Request('https://agent.test/rpc/pending-operations/op-1/decision', {
      method: 'POST',
      headers: { ...baseHeaders, 'x-agent-device': 'device-1', 'x-agent-connection-token': 'token' },
      body: JSON.stringify({ decision: 'cancel', requestId: 'req-1', actorId: 'forged' }),
    }));
    expect(invalidBody.status).toBe(400);
  });
});
