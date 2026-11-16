import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity, type CategorySuggestionProvider } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import type { EntityReader, EntitySummary } from '../../src/mutations/entity-resolver.js';

const identity: AuthenticatedIdentity = { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' };
const ACCOUNT_A = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ACCOUNT_B = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const EXPENSE = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado', kind: 'expense' };
const INCOME = { id: '00000000-0000-4000-8000-000000000012', name: 'Salário', kind: 'income' };
const plan = () => ({
  version: '2' as const, mode: 'mutation-proposal' as const, domain: 'transactions' as const,
  skillNames: ['transactions'], requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' as const }],
  missingFields: [] as readonly string[], ambiguity: null, confidence: 1,
});
const makeReader = (categories: readonly EntitySummary[] = [EXPENSE]): EntityReader => ({
  listAccounts: async () => [ACCOUNT_A, ACCOUNT_B],
  listCategories: async () => categories,
});
const setup = (suggest?: CategorySuggestionProvider, categories: readonly EntitySummary[] = [EXPENSE]) => {
  const request = vi.fn(async (method: string, path: string, options?: { body?: unknown }) => {
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'pending-test' };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request: request as never }),
    entityReader: makeReader(categories),
    draftStore: new InMemoryMutationDraftStore(),
    plan,
    ...(suggest ? { categorySuggestionProvider: suggest } : {}),
  });
  const turn = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { request, turn };
};

describe('semantic category suggestion fallback', () => {
  it('without provider keeps the clarification and makes no inference call', async () => {
    const { turn } = setup();
    const first = await turn('gastei 50 de carne', 'cat-no-provider-1');
    const result = await turn('Nubank', 'cat-no-provider-2');
    expect(first.clarification).toBeTruthy();
    expect(result.clarification?.missingFields).toContain('categoryId');
  });

  it('accepts a valid category id through deterministic resolution and proposes', async () => {
    const provider = vi.fn(async () => ({ categoryId: EXPENSE.id }));
    const { turn, request } = setup(provider);
    await turn('gastei 50 de carne', 'cat-valid-1');
    const result = await turn('Nubank', 'cat-valid-2');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.clarification).toBeUndefined();
    expect(result.mutation?.operationId).toBe('pending-test');
    const payload = request.mock.calls.find(([method, path]) => method === 'POST' && path.endsWith('/propose'))?.[2];
    expect((payload?.body as { normalizedArgs?: Record<string, unknown> } | undefined)?.normalizedArgs?.categoryId).toBe(EXPENSE.id);
  });

  it.each([
    ['other category kind', async () => ({ categoryId: INCOME.id }), [EXPENSE, INCOME]],
    ['nonexistent category', async () => ({ categoryId: '00000000-0000-4000-8000-000000000099' }), [EXPENSE]],
    ['provider error', async () => { throw new Error('provider failure'); }, [EXPENSE]],
    ['null result', async () => null, [EXPENSE]],
  ])('%s falls back to clarification', async (_label, provider, cats) => {
    const suggestion = vi.fn(async () => await (provider as () => Promise<{ categoryId: string } | null>)());
    const { turn } = setup(suggestion, cats as EntitySummary[]);
    await turn('gastei 50 de carne', `cat-fallback-1-${String(_label)}`);
    const result = await turn('Nubank', `cat-fallback-2-${String(_label)}`);
    expect(result.clarification?.missingFields).toContain('categoryId');
  });

  it('does not spend inference when explicit category resolves the draft', async () => {
    const provider = vi.fn(async () => ({ categoryId: EXPENSE.id }));
    const { turn } = setup(provider);
    await turn('gastei 50 de carne', 'cat-explicit-1');
    await turn('categoria Mercado', 'cat-explicit-2');
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not call inference when only the account is missing', async () => {
    const provider = vi.fn(async () => ({ categoryId: EXPENSE.id }));
    const { turn } = setup(provider);
    await turn('gastei 50 no mercado', 'cat-account-only-1');
    await turn('Nubank', 'cat-account-only-2');
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('invariant: a draft completed by model suggestion is never auto-executed', () => {
  const build = (suggest?: CategorySuggestionProvider) => {
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'pending-test' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const client = new MutationApiClient({ request: request as never, strictDuplicateCheck: async () => false });
    const elevated = vi.fn(() => undefined);
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: client,
      autoExecutionClient: elevated,
      entityReader: makeReader(),
      draftStore: new InMemoryMutationDraftStore(),
      plan,
      ...(suggest ? { categorySuggestionProvider: suggest } : {}),
    });
    const turn = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
    return { elevated, turn };
  };

  it('proposes for manual confirmation and never requests the elevated client', async () => {
    const provider = vi.fn(async () => ({ categoryId: EXPENSE.id }));
    const { elevated, turn } = build(provider);
    await turn('registre gasto de 50 de carne no Nubank', 'veto-model-1');
    const result = await turn('registre gasto de 50 de carne no Nubank', 'veto-model-2');
    expect(provider).toHaveBeenCalled();
    expect(result.mutation?.operationId).toBe('pending-test');
    expect(elevated).not.toHaveBeenCalled();
  });
});
