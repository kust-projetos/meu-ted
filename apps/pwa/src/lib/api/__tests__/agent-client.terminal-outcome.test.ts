import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAgentHistory } from '../agent-client';
import * as agentAuth from '../agent-auth';

const OP1 = '00000000-0000-4000-8000-000000000001';
const OP2 = '00000000-0000-4000-8000-000000000002';

const receipt = (operationId: string, entityId: string) => ({
  mutationId: 'mutation-1', mutationKind: 'categories.deactivate', status: 'succeeded',
  affectedTargets: ['categories', 'transactions'], operationId,
  entity: { type: 'category', id: entityId },
});

describe('history terminal outcomes', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('accepts only a strict terminal receipt bound to that server proposal message', async () => {
    vi.stubEnv('NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL', '');
    vi.spyOn(agentAuth, 'fetchAgentConnectionToken').mockResolvedValue('connection');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [
      { id: 'assistant-1', role: 'assistant', actorId: 'ted', content: 'Proposta', isOwn: false,
        proposalOperationId: OP1, proposalTool: 'categories.deactivate',
        terminalOutcome: { operationId: OP1, tool: 'categories.deactivate', status: 'succeeded', receipt: receipt(OP1, 'cat-1'), expectedContext: { tool: 'categories.deactivate', entityId: 'cat-1' } } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const [message] = await fetchAgentHistory('ws-1');
    const outcome = message?.terminalOutcome;
    if (!outcome || outcome.status !== 'succeeded') {
      throw new Error('Expected a succeeded terminal outcome');
    }
    expect(outcome.tool).toBe('categories.deactivate');
    expect(outcome.receipt.operationId).toBe(OP1);
    expect(outcome.receipt.mutationKind).toBe('categories.deactivate');
    expect(outcome.receipt.entity).toEqual({ type: 'category', id: 'cat-1' });
  });

  it('drops outcome with a mismatched operation, tool, target, or unrecognized fields', async () => {
    vi.stubEnv('NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL', '');
    vi.spyOn(agentAuth, 'fetchAgentConnectionToken').mockResolvedValue('connection');
    const base = { id: 'assistant-1', role: 'assistant', actorId: 'ted', content: 'Proposta', isOwn: false, proposalOperationId: OP1, proposalTool: 'categories.deactivate' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [
      { ...base, terminalOutcome: { operationId: OP2, tool: 'categories.deactivate', status: 'succeeded', receipt: receipt(OP2, 'cat-1'), expectedContext: { tool: 'categories.deactivate', entityId: 'cat-1' } } },
      { ...base, id: 'assistant-wrong-tool', terminalOutcome: { operationId: OP1, tool: 'accounts.deactivate', status: 'succeeded', receipt: receipt(OP1, 'cat-1'), expectedContext: { tool: 'categories.deactivate', entityId: 'cat-1' } } },
      { ...base, id: 'assistant-2', terminalOutcome: { operationId: OP1, tool: 'categories.deactivate', status: 'succeeded', receipt: receipt(OP1, 'cat-2'), expectedContext: { tool: 'categories.deactivate', entityId: 'cat-1' }, attestation: 'must-not-pass' } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const messages = await fetchAgentHistory('ws-1');
    expect(messages.every((message) => message.terminalOutcome === undefined)).toBe(true);
  });

  it('accepts description-update history only when operation and exact target transaction are bound', async () => {
    vi.stubEnv('NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL', '');
    vi.spyOn(agentAuth, 'fetchAgentConnectionToken').mockResolvedValue('connection');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [
      { id:'assistant-update', role:'assistant', actorId:'ted', content:'Atualizada', isOwn:false, proposalOperationId:OP1, proposalTool:'transactions.update', terminalOutcome:{
        operationId:OP1, tool:'transactions.update', status:'succeeded',
        receipt:{ mutationId:'m-update', mutationKind:'transactions.update', status:'succeeded', affectedTargets:['transactions','accounts','dashboard-summary','budgets','quick-insights'], operationId:OP1, entity:{type:'transaction',id:'tx-1'} },
        expectedContext:{tool:'transactions.update',entityId:'tx-1'},
      } },
      { id:'assistant-wrong-target', role:'assistant', actorId:'ted', content:'Inválida', isOwn:false, proposalOperationId:OP2, proposalTool:'transactions.update', terminalOutcome:{
        operationId:OP2, tool:'transactions.update', status:'succeeded',
        receipt:{ mutationId:'m-update-2', mutationKind:'transactions.update', status:'succeeded', affectedTargets:['transactions'], operationId:OP2, entity:{type:'transaction',id:'tx-2'} },
        expectedContext:{tool:'transactions.update',entityId:'tx-1'},
      } },
      { id:'assistant-no-target-context', role:'assistant', actorId:'ted', content:'Sem alvo', isOwn:false, proposalOperationId:OP2, proposalTool:'transactions.update', terminalOutcome:{
        operationId:OP2, tool:'transactions.update', status:'succeeded',
        receipt:{ mutationId:'m-update-3', mutationKind:'transactions.update', status:'succeeded', affectedTargets:['transactions'], operationId:OP2, entity:{type:'transaction',id:'tx-1'} },
        expectedContext:{tool:'transactions.update'},
      } },
    ] }), {status:200,headers:{'content-type':'application/json'}}));
    const messages = await fetchAgentHistory('ws-1');
    expect(messages[0]?.terminalOutcome?.status).toBe('succeeded');
    expect(messages[1]?.terminalOutcome).toBeUndefined();
    expect(messages[2]?.terminalOutcome).toBeUndefined();
  });
});
