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
const setup = (suggest?: CategorySuggestionProvider, categories: readonly EntitySummary[] = [EXPENSE], events?: (type: string, fields: Record<string, unknown>) => void) => {
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
    ...(events ? { events } : {}),
    ...(suggest ? { categorySuggestionProvider: suggest } : {}),
  });
  const turn = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { request, turn };
};

const CATEGORY_ID = '00000000-0000-4000-8000-000000000021';
const AUTOCREATE_ID = '00000000-0000-4000-8000-000000000022';
const autoCreateSetup = (
  suggest: CategorySuggestionProvider,
  initialCategories: readonly EntitySummary[],
  options: { enabled?: boolean; refuse?: boolean; missingReceipt?: boolean; emptyCategoryId?: boolean; exposeCreated?: boolean } = {},
) => {
  let categories = [...initialCategories];
  const request = vi.fn(async (method: string, path: string, requestOptions?: { body?: unknown }) => {
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = requestOptions?.body as { tool?: string; normalizedArgs?: unknown } | undefined;
      return body?.tool === 'categories.create' ? { id: 'pending-category' } : { id: 'pending-transaction' };
    }
    if (method === 'POST' && path === '/pending-operations/v2/pending-category/authorize') {
      if (options.refuse) throw Object.assign(new Error('not eligible'), { statusCode: 409, code: 'approval.autoexecute_not_eligible' });
      return { id: 'pending-category', status: 'confirmed', attestation: 'a'.repeat(32) };
    }
    if (method === 'POST' && path === '/pending-operations/v2/pending-category/execute') {
      if (options.exposeCreated !== false && !options.missingReceipt) {
        categories = [...categories, { id: CATEGORY_ID, name: 'Streaming', kind: 'expense' }];
      }
      return {
        id: 'pending-category',
        status: 'succeeded',
        execution: {
          status: 'succeeded',
          operationId: CATEGORY_ID,
          ...(options.missingReceipt ? {} : { receipt: {
            mutationKind: 'categories.create', status: 'succeeded', mutationId: 'mutation-category',
            operationId: 'pending-category',
            entity: { type: 'category', id: options.emptyCategoryId ? '' : CATEGORY_ID },
          } }),
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const baseClient = new MutationApiClient({ request: request as never, strictDuplicateCheck: async () => false });
  const elevatedClient = new MutationApiClient({ request: request as never, strictDuplicateCheck: async () => false });
  const events = vi.fn();
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: baseClient,
    autoExecutionClient: () => elevatedClient,
    entityReader: {
      listAccounts: async () => [ACCOUNT_A, ACCOUNT_B],
      listCategories: async () => categories,
    },
    draftStore: new InMemoryMutationDraftStore(),
    plan,
    categorySuggestionProvider: suggest,
    categoryAutoCreateEnabled: options.enabled ?? true,
    events,
  });
  const turn = (text: string, intentionId: string) =>
    orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { request, turn, events };
};

describe('semantic category suggestion fallback', () => {
  it('creates a missing category once and resolves the transaction with the receipt id', async () => {
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), []);
    await h.turn('gastei 50 de carne', 'cat-create-1');
    const result = await h.turn('Nubank', 'cat-create-2');
    const proposals = h.request.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/propose'));
    const category = proposals.find(([, , req]) => (req?.body as { tool?: string })?.tool === 'categories.create');
    expect(category?.[2]?.body).toEqual({ tool: 'categories.create', normalizedArgs: { name: 'Streaming', kind: 'expense' }, expiresAt: expect.any(String) });
    expect(proposals.filter(([, , req]) => (req?.body as { tool?: string })?.tool === 'categories.create')).toHaveLength(1);
    const transaction = proposals.find(([, , req]) => (req?.body as { tool?: string })?.tool !== 'categories.create');
    expect((transaction?.[2]?.body as { normalizedArgs?: { categoryId?: string } })?.normalizedArgs?.categoryId).toBe(CATEGORY_ID);
    expect(result.clarification).toBeUndefined();
    expect(result.mutation?.operationId).toBe('pending-transaction');
  });

  it('reuses a same-kind category with equivalent case-insensitive name', async () => {
    const lower = { id: CATEGORY_ID, name: 'streaming', kind: 'expense' };
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), [lower]);
    await h.turn('gastei 50 de carne', 'cat-reuse-1');
    const result = await h.turn('Nubank', 'cat-reuse-2');
    const proposals = h.request.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/propose'));
    expect(proposals.some(([, , req]) => (req?.body as { tool?: string })?.tool === 'categories.create')).toBe(false);
    const transaction = proposals.find(([, , req]) => (req?.body as { tool?: string })?.tool !== 'categories.create');
    expect((transaction?.[2]?.body as { normalizedArgs?: { categoryId?: string } })?.normalizedArgs?.categoryId).toBe(CATEGORY_ID);
    expect(result.clarification).toBeUndefined();
  });

  it('does not create a same-name category of another kind and resolver refuses the wrong-kind id', async () => {
    const wrongKind = { id: INCOME.id, name: 'Streaming', kind: 'income' };
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), [EXPENSE, wrongKind]);
    await h.turn('gastei 50 de carne', 'cat-other-kind-1');
    const result = await h.turn('Nubank', 'cat-other-kind-2');
    const proposals = h.request.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/propose'));
    expect(proposals.some(([, , req]) => (req?.body as { tool?: string })?.tool === 'categories.create')).toBe(false);
    expect(result.clarification?.missingFields).toContain('categoryId');
    expect(proposals.some(([, , req]) => (req?.body as { tool?: string })?.tool !== 'categories.create')).toBe(false);
    expect(h.events.mock.calls.find(([type]) => type === 'mutation.category_suggestion')?.[1]).toMatchObject({ status: 'rejected' });
  });

  it('flag off never creates and retains the existing clarification behavior', async () => {
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), [], { enabled: false });
    await h.turn('gastei 50 de carne', 'cat-disabled-1');
    const result = await h.turn('Nubank', 'cat-disabled-2');
    expect(h.request.mock.calls.some(([, path]) => path.endsWith('/authorize'))).toBe(false);
    expect(result.clarification?.missingFields).toContain('categoryId');
  });

  it('authorization refusal is absorbed and returns clarification without execution', async () => {
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), [], { refuse: true });
    await h.turn('gastei 50 de carne', 'cat-refused-1');
    const result = await h.turn('Nubank', 'cat-refused-2');
    expect(result.clarification?.missingFields).toContain('categoryId');
    expect(h.request.mock.calls.some(([, path]) => path.endsWith('/execute'))).toBe(false);
    expect(h.request.mock.calls.some(([, path]) => path.endsWith('/propose'))).toBe(true);
  });

  it.each([
    ['receipt absent', { missingReceipt: true }],
    ['entity id empty', { emptyCategoryId: true }],
  ])('%s fails closed without proposing a transaction', async (_label, resultShape) => {
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), [], resultShape);
    await h.turn('gastei 50 de carne', 'cat-no-id-1');
    const result = await h.turn('Nubank', 'cat-no-id-2');
    expect(result.clarification?.missingFields).toContain('categoryId');
    const proposals = h.request.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/propose'));
    expect(proposals).toHaveLength(1);
    expect((proposals[0]?.[2]?.body as { tool?: string })?.tool).toBe('categories.create');
  });

  it('reports a created category when it cannot complete transaction resolution', async () => {
    const h = autoCreateSetup(async () => ({ newCategory: { name: 'Streaming' } }), [], { exposeCreated: false });
    await h.turn('gastei 50 de carne', 'cat-orphan-1');
    const result = await h.turn('Nubank', 'cat-orphan-2');
    expect(result.clarification?.missingFields).toContain('categoryId');
    expect(result.clarification?.text).toContain('Criei a categoria “Streaming”');
  });

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
    ['other category kind', async () => ({ categoryId: INCOME.id }), [EXPENSE, INCOME], 'rejected'],
    ['nonexistent category', async () => ({ categoryId: '00000000-0000-4000-8000-000000000099' }), [EXPENSE], 'rejected'],
    ['provider error', async () => { throw new Error('provider failure'); }, [EXPENSE], 'error'],
    ['null result', async () => null, [EXPENSE], 'unavailable'],
  ])('%s falls back to clarification and emits telemetry', async (_label, provider, cats, status) => {
    const suggestion = vi.fn(async () => await (provider as () => Promise<{ categoryId: string } | null>)());
    const events = vi.fn();
    const { turn } = setup(suggestion, cats as EntitySummary[], events);
    await turn('gastei 50 de carne', `cat-fallback-1-${String(_label)}`);
    const result = await turn('Nubank', `cat-fallback-2-${String(_label)}`);
    expect(result.clarification?.missingFields).toContain('categoryId');
    const emitted = events.mock.calls.filter(([type]) => type === 'mutation.category_suggestion');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.[1]).toMatchObject({ status, source: 'model' });
    expect(JSON.stringify(emitted[0]?.[1])).not.toContain('carne');
  });

  it('emits accepted and timeout outcomes', async () => {
    const accepted = vi.fn();
    const ok = setup(vi.fn(async () => ({ categoryId: EXPENSE.id })), [EXPENSE], accepted);
    await ok.turn('gastei 50 de carne', 'cat-ev-ok-1');
    await ok.turn('Nubank', 'cat-ev-ok-2');
    expect(accepted.mock.calls.find(([t]) => t === 'mutation.category_suggestion')?.[1]).toMatchObject({ status: 'accepted' });

    vi.useFakeTimers();
    try {
      const slowEvents = vi.fn();
      const slow = setup(vi.fn(() => new Promise<null>(() => {})), [EXPENSE], slowEvents);
      await slow.turn('gastei 50 de carne', 'cat-ev-slow-1');
      const pending = slow.turn('Nubank', 'cat-ev-slow-2');
      await vi.advanceTimersByTimeAsync(3100);
      await pending;
      expect(slowEvents.mock.calls.find(([t]) => t === 'mutation.category_suggestion')?.[1]).toMatchObject({ status: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
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
