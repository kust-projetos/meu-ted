import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ACCOUNT_ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const CATEGORY_MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

const mutationPlan = () => ({
  version: '2' as const,
  mode: 'mutation-proposal' as const,
  domain: 'transactions' as const,
  skillNames: ['transactions'],
  requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' as const }],
  missingFields: [] as readonly string[],
  ambiguity: null,
  confidence: 1,
});

const reader = (
  accounts: { id: string; name: string }[],
  categories: { id: string; name: string }[],
): EntityReader => ({
  listAccounts: async () => accounts,
  listCategories: async () => categories,
});

const mockProposeClient = () => {
  const request = vi.fn().mockImplementation(async (method: string, path: string) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'pending-1' };
    throw new Error(`unexpected request ${method} ${path}`);
  });
  return { api: new MutationApiClient({ request }), request };
};

describe('mutation entity resolution wiring (SPEC §7 H-01)', () => {
  it('RED: "Gastei R$ 50 no mercado" with 2+ accounts clarifies with zero proposals', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_MERCADO]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-h01-multi' }, identity),
    );
    expect(result.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(result.plan.missingFields).toContain('accountId');
    expect(result.clarification?.missingFields).toContain('accountId');
    expect(result.response?.text).toMatch(/Nubank/);
    expect(result.response?.text).toMatch(/Itaú/);
  });

  it('RED: exactly one account resolves and the proposal carries real UUIDs', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-h01-single' }, identity),
    );
    expect(result.mutation?.operationId).toBe('pending-1');
    expect(request).toHaveBeenCalledTimes(1);
    const body = request.mock.calls[0]?.[2] as { body?: { tool?: string; normalizedArgs?: Record<string, unknown> } } | undefined;
    expect(body?.body?.tool).toBe('transactions.expense.create');
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      description: 'mercado',
      accountId: ACCOUNT_NUBANK.id,
      categoryId: CATEGORY_MERCADO.id,
    });
    expect(body?.body?.normalizedArgs).not.toHaveProperty('categoryQuery');
  });

  it('RED: unreadable entity lists fail closed into clarification, never a proposal', async () => {
    const { api, request } = mockProposeClient();
    const failing: EntityReader = {
      listAccounts: async () => { throw new Error('api.request_failed'); },
      listCategories: async () => [],
    };
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: failing,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-h01-offline' }, identity),
    );
    expect(result.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(result.plan.missingFields).toContain('accountId');
  });

  // R03 / AC08: the parsed description is "carne" and the user never named a
  // category, so no category may be inferred from the description — the turn
  // clarifies with the real catalog instead of proposing.
  it('RED: "gastei 50 de carne" keeps the description and never infers the category from it', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [{ id: '00000000-0000-4000-8000-000000000011', name: 'Carne' }]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei 50 de carne', intentionId: 'intent-r03-carne' }, identity),
    );
    expect(result.mutation?.operationId).toBe('pending-1');
    const body = request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } } | undefined;
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      description: 'carne',
      accountId: ACCOUNT_NUBANK.id,
      categoryId: '00000000-0000-4000-8000-000000000011',
    });
  });

  it('RED: "gastei 50 de carne" without a matching category clarifies with zero proposals', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei 50 de carne', intentionId: 'intent-r03-no-category' }, identity),
    );
    expect(result.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(result.plan.missingFields).toContain('categoryId');
    expect(result.plan.missingFields).not.toContain('accountId');
    expect(result.response?.text).toMatch(/qual categoria/i);
    expect(result.response?.text).toMatch(/Mercado/);
    expect(result.response?.text).not.toMatch(/Não encontrei a categoria\s*"carne"/i);
  });

  it('RED: "gastei 50 em compras no mercado livre" never auto-selects a fuzzy category', async () => {
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'gastei 50 em compras no mercado livre', intentionId: 'intent-r03-fuzzy' }, identity),
    );
    expect(result.mutation).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(result.plan.missingFields).toContain('categoryId');
    expect(result.response?.text).toMatch(/qual categoria/i);
  });
});
