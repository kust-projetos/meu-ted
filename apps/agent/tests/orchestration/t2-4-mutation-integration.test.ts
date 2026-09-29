import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const plan = (mode: 'mutation-proposal' | 'confirmation') => ({
  version: '2' as const,
  mode,
  domain: 'transactions' as const,
  skillNames: ['transactions'],
  requestedOperations: [{ name: 'create_expense', kind: 'mutation' as const }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

describe('T2.4 mutation integration', () => {
  it('routes proposal and confirmation through V2 API and renders only an API success', async () => {
    const activeListing = {
      items: [{
        id: 'pending-1', status: 'proposed', tool: 'transactions.expense.create',
        createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z',
      }],
      total: 1,
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'pending-1' })
      .mockResolvedValueOnce(activeListing)
      .mockResolvedValueOnce({ id: 'pending-1', attestation: 'a'.repeat(32) })
      .mockResolvedValueOnce({ id: 'pending-1', status: 'succeeded', execution: { status: 'succeeded', operationId: 'mut-pending-1', receipt: { mutationId: 'mut-pending-1', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId: 'pending-1', entity: { type: 'transaction', id: 'mut-pending-1' } } } });
    const api = new MutationApiClient({ request });
    const planner = vi.fn()
      .mockReturnValueOnce(plan('mutation-proposal'))
      .mockReturnValueOnce(plan('confirmation'));
    // SPEC §7.2/§7.3: single account auto-resolves, UUID category verified.
    const entityReader = {
      listAccounts: async () => [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'Nubank' }],
      listCategories: async () => [{ id: '00000000-0000-4000-8000-000000000001', name: 'Mercado' }],
    };
    const orchestrator = new ConversationOrchestrator({ mutationApiClient: api, plan: planner, entityReader });

    const proposed = await orchestrator.runTurn(normalizeRestTurn({ text: 'gastei R$ 12,34 no mercado na categoria 00000000-0000-4000-8000-000000000001', intentionId: 'intent-1' }, identity));
    expect(proposed.mutation?.operationId).toBe('pending-1');
    expect(proposed.response?.text).toMatch(/confirma/i);

    const confirmed = await orchestrator.runTurn(normalizeRestTurn({ text: 'confirmo', intentionId: 'intent-1', pendingOperationIds: ['pending-1'] }, identity));
    expect(confirmed.response?.text).toMatch(/registrad|sucesso/i);
    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/pending-operations/v2/propose', expect.objectContaining({
      body: expect.not.objectContaining({ actorId: expect.anything(), workspaceId: expect.anything(), deviceId: expect.anything() }),
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'GET', '/pending-operations/v2/active', expect.anything());
    expect(request).toHaveBeenNthCalledWith(3, 'POST', '/pending-operations/v2/pending-1/confirm', expect.anything());
    expect(request).toHaveBeenNthCalledWith(4, 'POST', '/pending-operations/v2/pending-1/execute', expect.objectContaining({ body: { attestation: 'a'.repeat(32) } }));
    expect(planner).toHaveBeenCalledTimes(2);
  });

  it('does not use success wording when API execution is incomplete', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        items: [{
          id: 'pending-2', status: 'proposed', tool: 'transactions.expense.create',
          createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z',
        }],
        total: 1,
      })
      .mockResolvedValueOnce({ id: 'pending-2', attestation: 'b'.repeat(32) })
      .mockResolvedValueOnce({ id: 'pending-2', status: 'failed' });
    const api = new MutationApiClient({ request });
    const orchestrator = new ConversationOrchestrator({ mutationApiClient: api, plan: () => plan('confirmation') });

    const result = await orchestrator.runTurn(normalizeRestTurn({ text: 'confirmo', intentionId: 'intent-2', pendingOperationIds: ['pending-2'] }, identity));
    expect(result.response?.text).not.toMatch(/registrad|sucesso|concluíd/i);
    expect(result.response?.text).toMatch(/falha|não foi possível|erro/i);
  });
});
