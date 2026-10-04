import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore, buildDraftRecord } from '../../src/mutations/mutation-draft.js';
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

/**
 * A08 / R08 at the orchestrator level: revalidation happens IMMEDIATELY before
 * the propose write, it is part of the SAME resolution attempt (A06×A10: one
 * recovery slot, fingerprint stable over `resolutionText`), and it never
 * silently redirects the user to another entity.
 */
describe('A08 entity revalidation before propose (R08)', () => {
  const listing = (
    accounts: () => { id: string; name: string; status?: string }[],
    categories: () => { id: string; name: string; status?: string }[],
  ): EntityReader => ({
    listAccounts: async () => accounts(),
    listCategories: async () => categories(),
  });

  it('RED: an account that disappears between resolution and propose never reaches the proposal', async () => {
    const { api, request } = mockProposeClient();
    let reads = 0;
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      // The authoritative list answers the resolution read and is empty by the
      // time the revalidation runs (deactivation/removal in between).
      entityReader: listing(
        () => (reads++ === 0 ? [ACCOUNT_NUBANK] : []),
        () => [CATEGORY_MERCADO],
      ),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-a08-gone' }, identity),
    );
    expect(request).not.toHaveBeenCalled();
    expect(result.mutation).toBeUndefined();
    expect(result.plan.missingFields).toContain('accountId');
    expect(result.response?.text).toMatch(/conta/i);
    expect(result.response?.text).not.toMatch(ACCOUNT_NUBANK.id);
  });

  it('RED: a category deactivated between resolution and propose never reaches the proposal', async () => {
    const { api, request } = mockProposeClient();
    let reads = 0;
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: listing(
        () => [ACCOUNT_NUBANK],
        () => (reads++ === 0 ? [CATEGORY_MERCADO] : [{ ...CATEGORY_MERCADO, status: 'inactive' }]),
      ),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-a08-inactive' }, identity),
    );
    expect(request).not.toHaveBeenCalled();
    expect(result.mutation).toBeUndefined();
    expect(result.plan.missingFields).toContain('categoryId');
    expect(result.response?.text).toMatch(/categoria/i);
  });

  it('RED: a revalidated turn is never dead-ended as a repeated attempt (no-draft path)', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: listing(() => [ACCOUNT_NUBANK], () => [CATEGORY_MERCADO]),
      events: (type, fields) => seen.push({ type, fields }),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-a08-one-attempt' }, identity),
    );
    expect(result.mutation?.operationId).toBe('pending-1');
    expect(request).toHaveBeenCalledTimes(1);
    const budget = seen.find((event) => event.type === 'turn.budget')?.fields as
      | { resolutionRecoveries: number; proposeAttempts: number; blockedRepeats: number }
      | undefined;
    expect(budget).toBeDefined();
    // The revalidation is the SAME attempt: no repeat refusal, no extra propose.
    expect(budget?.blockedRepeats).toBe(0);
    expect(budget?.proposeAttempts).toBe(1);
  });

  it('RED: with the A10 gate armed, resolve + revalidate spend exactly ONE recovery slot', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const { api, request } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      // The draft path is the one A10 guards with the shared recovery budget.
      draftStore: new InMemoryMutationDraftStore(),
      entityReader: listing(() => [ACCOUNT_NUBANK], () => [CATEGORY_MERCADO]),
      events: (type, fields) => seen.push({ type, fields }),
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-a08-budget-slot' }, identity),
    );
    expect(result.mutation?.operationId).toBe('pending-1');
    expect(request).toHaveBeenCalledTimes(1);
    const budget = seen.find((event) => event.type === 'turn.budget')?.fields as
      | { resolutionRecoveries: number; proposeAttempts: number; blockedRepeats: number; stop: string }
      | undefined;
    expect(budget).toBeDefined();
    expect(budget?.resolutionRecoveries).toBe(1);
    expect(budget?.blockedRepeats).toBe(0);
    expect(budget?.proposeAttempts).toBe(1);
    expect(budget?.stop).toBe('completed');
  });

  it('RED: an unreadable list at revalidation time fails closed instead of proposing', async () => {
    const { api, request } = mockProposeClient();
    let reads = 0;
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: {
        listAccounts: async () => {
          reads += 1;
          if (reads > 1) throw new Error('api.request_failed');
          return [ACCOUNT_NUBANK];
        },
        listCategories: async () => [CATEGORY_MERCADO],
      },
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-a08-unreadable' }, identity),
    );
    expect(request).not.toHaveBeenCalled();
    expect(result.mutation).toBeUndefined();
    expect(result.plan.missingFields).toContain('accountId');
  });
});

/**
 * A08 / R08 observability (tester #2): o trace deixa de ser um dado morto e
 * passa a ser VISÍVEL num evento sanitizado. Só SINAIS (nomes do tipo de
 * referência descartada) — nunca valor, UUID ou rótulo de conta/categoria.
 */
describe('A08 entity resolution signals in a sanitized event (R08)', () => {
  it('RED: alias morto emite o sinal da referência invalidada sem nenhum valor técnico', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const { api } = mockProposeClient();
    // Turno 1 pendura um draft com conta válida e categoria faltando; o
    // alias da conta fica CONFIRMADO no draft. No turno 2 essa conta some do
    // catálogo → a referência confirmada é invalidada e sinalizada.
    const store = new InMemoryMutationDraftStore();
    // Draft ativo cuja conta JÁ ESTÁ CONFIRMADA no escopo (tier 2) mas que
    // não existe mais no catálogo autoritativo: o alias morreu.
    const deadAlias = ACCOUNT_NUBANK.id;
    store.getOrCreate(
      buildDraftRecord({
        workspaceId: identity.workspaceId,
        actorId: identity.actorId,
        deviceId: identity.deviceId ?? null,
        intentionId: 'intent-a08-signal',
        tool: 'transactions.expense.create',
        resolvedArgs: {
          kind: 'expense',
          amountCents: 5000,
          description: 'mercado',
          date: '2026-09-14',
          accountId: deadAlias,
        },
        missingFields: ['categoryId'],
        question: 'Qual categoria devo usar?',
      }),
    );
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      draftStore: store,
      // O alias guardado não existe mais; o catálogo atual tem outra conta.
      entityReader: reader([ACCOUNT_ITAU], [CATEGORY_MERCADO]),
      events: (type, fields) => seen.push({ type, fields }),
    });
    await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Mercado', intentionId: 'intent-a08-signal-2' }, identity),
    );
    const signal = seen.filter((event) => event.type === 'mutation.entity_resolution');
    expect(signal.length).toBeGreaterThan(0);
    const signals = signal[0]!.fields.signals as string[];
    expect(signals).toContain('confirmed_account_id');
    // Nenhum valor técnico: nem UUID, nem rótulo de conta/categoria.
    const blob = JSON.stringify(signal);
    expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(blob).not.toMatch(/Nubank|Itaú|Mercado/);
  });

  it('RED: um turno sem nenhuma referência descartada não emite sinal nenhum', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const { api } = mockProposeClient();
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      plan: () => mutationPlan(),
      entityReader: reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]),
      events: (type, fields) => seen.push({ type, fields }),
    });
    await orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 50 no mercado', intentionId: 'intent-a08-no-signal' }, identity),
    );
    // Nada foi invalidado: o evento é omitido em vez de poluir a telemetria.
    expect(seen.filter((event) => event.type === 'mutation.entity_resolution')).toHaveLength(0);
  });
});
