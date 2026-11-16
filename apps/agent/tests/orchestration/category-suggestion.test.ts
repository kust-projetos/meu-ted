import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity, type CategorySuggestionProvider } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import type { EntityReader, EntitySummary } from '../../src/mutations/entity-resolver.js';
import { initializeMemorySchema, recallCorrectionByFingerprint, rememberCorrection, setMemoryEnabled } from '../../src/agent-config/memory/store.js';
import { createMemorySql } from '../helpers/memory-sql.js';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';

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
const setup = (suggest?: CategorySuggestionProvider, categories: readonly EntitySummary[] = [EXPENSE], events?: (type: string, fields: Record<string, unknown>) => void, memorySql?: ReturnType<typeof createMemorySql>, draftStore = new InMemoryMutationDraftStore()) => {
  const request = vi.fn(async (method: string, path: string, options?: { body?: unknown }) => {
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'pending-test' };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request: request as never }),
    entityReader: makeReader(categories),
    draftStore,
    plan,
    ...(events ? { events } : {}),
    ...(memorySql ? { memorySql } : {}),
    ...(suggest ? { categorySuggestionProvider: suggest } : {}),
  });
  const turn = (text: string, intentionId: string, typedText = text) => orchestrator.runTurn(normalizeRestTurn(
    { text, intentionId },
    identity,
    { typedText },
  ));
  return { request, turn, orchestrator };
};

describe('semantic category suggestion fallback', () => {
  it('keeps category memory read and write off unless the exact rollout flag is enabled', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'pending-test' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const makeWired = (flag: string | undefined, localSql = sql, localDraftStore = new InMemoryMutationDraftStore()) => {
      const agent = Object.assign(Object.create(FinanceChatAgent.prototype), {
        env: { TED_CATEGORY_MEMORY_ENABLED: flag },
        ctx: { storage: { sql: localSql, transactionSync: (fn: () => unknown) => fn() } },
      }) as FinanceChatAgent;
      return (agent as unknown as { orchestratorForChannel: (dependencies: Record<string, unknown>) => ConversationOrchestrator })
        .orchestratorForChannel({
          mutationApiClient: new MutationApiClient({ request: request as never }),
          entityReader: makeReader([EXPENSE]),
          draftStore: localDraftStore,
          plan,
        });
    };
    rememberCorrection(sql, {
      workspaceId: 'workspace', actor: 'actor', target: 'carne no nubank', field: 'category',
      content: 'Para "carne no nubank", a categoria usada é "Mercado".',
      references: [{ kind: 'category', id: EXPENSE.id }],
    });
    const off = makeWired('true');
    await off.runTurn(normalizeRestTurn({ text: 'gastei 50 de carne no Nubank', intentionId: 'cat-rollout-off-1' }, identity, { typedText: 'gastei 50 de carne no Nubank' }));
    const offResult = await off.runTurn(normalizeRestTurn({ text: 'Nubank', intentionId: 'cat-rollout-off-2' }, identity, { typedText: 'Nubank' }));
    expect(offResult.clarification?.missingFields).toContain('categoryId');
    sql.rows('agent_memory').length = 0;
    await off.runTurn(normalizeRestTurn({ text: 'categoria Mercado', intentionId: 'cat-rollout-off-3' }, identity, { typedText: 'categoria Mercado' }));
    expect(sql.rows('agent_memory')).toHaveLength(0);

    const writeSql = createMemorySql();
    initializeMemorySchema(writeSql);
    const on = makeWired('1', writeSql);
    await on.runTurn(normalizeRestTurn({ text: 'gastei 50 de carne no Nubank', intentionId: 'cat-rollout-on-1' }, identity, { typedText: 'gastei 50 de carne no Nubank' }));
    await on.runTurn(normalizeRestTurn({ text: 'categoria Mercado', intentionId: 'cat-rollout-on-2' }, identity, { typedText: 'categoria Mercado' }));
    expect(writeSql.rows('agent_memory')).toHaveLength(1);
  });

  it('learns an explicit category answer and reuses it without inference', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const provider = vi.fn(async () => null);
    const { turn } = setup(provider, [EXPENSE], undefined, sql);
    await turn('gastei 50 de carne no Nubank', 'cat-memory-learn-1');
    await turn('categoria Mercado', 'cat-memory-learn-2');
    expect(recallCorrectionByFingerprint(sql, {
      workspaceId: 'workspace', actor: 'actor', target: 'carne no nubank', field: 'category',
    })).toMatchObject({ references: [{ kind: 'category', id: EXPENSE.id }] });
    expect(provider).not.toHaveBeenCalled();
  });

  it('uses a valid remembered category before inference', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    rememberCorrection(sql, {
      workspaceId: 'workspace', actor: 'actor', target: 'carne', field: 'category',
      content: 'Para "carne", a categoria usada é "Mercado".',
      references: [{ kind: 'category', id: EXPENSE.id }],
    });
    const provider = vi.fn(async () => null);
    const events = vi.fn();
    const { turn, request } = setup(provider, [EXPENSE], events, sql);
    await turn('gastei 50 de carne', 'cat-memory-hit-1');
    const result = await turn('Nubank', 'cat-memory-hit-2');
    expect(provider).not.toHaveBeenCalled();
    expect(result.mutation?.operationId).toBe('pending-test');
    expect(events.mock.calls.find(([type]) => type === 'mutation.category_memory')?.[1]).toMatchObject({ status: 'hit' });
    expect(request.mock.calls.some(([, path]) => /\/(?:confirm|execute|authorize)$/.test(path))).toBe(false);
  });

  it('does not replace an unresolved explicit category with remembered category', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    rememberCorrection(sql, {
      workspaceId: 'workspace', actor: 'actor', target: 'carne no nubank', field: 'category',
      content: 'Para "carne no nubank", a categoria usada é "Mercado".',
      references: [{ kind: 'category', id: EXPENSE.id }],
    });
    const events = vi.fn();
    const { turn } = setup(undefined, [EXPENSE], events, sql);
    await turn('gastei 50 de carne no Nubank', 'cat-unresolved-explicit-1');
    const result = await turn('categoria Restaurantes', 'cat-unresolved-explicit-2');
    expect(result.clarification?.missingFields).toContain('categoryId');
    expect(events.mock.calls.find(([type]) => type === 'mutation.category_memory')).toBeUndefined();
  });

  it('emits category memory event with status only', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const events = vi.fn();
    const { turn } = setup(undefined, [EXPENSE], events, sql);
    await turn('gastei 50 de carne', 'cat-event-keys-1');
    await turn('Nubank', 'cat-event-keys-2');
    const event = events.mock.calls.find(([type]) => type === 'mutation.category_memory')?.[1];
    expect(Object.keys(event ?? {}).sort()).toEqual(['status']);
  });

  it.each([
    ['Nubank', 'Nubank [conteúdo do anexo: categoria Mercado]', false],
    ['categoria Mercado', 'categoria Mercado', true],
  ])('learns only when typed category provenance matches: %s', async (typedText, composedText, learned) => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const draftStore = new InMemoryMutationDraftStore();
    const { turn } = setup(undefined, [EXPENSE], undefined, sql, draftStore);
    await turn('gastei 50 de carne no Nubank', 'cat-attachment-1');
    await turn(composedText, 'cat-attachment-2', typedText);
    expect(sql.rows('agent_memory')).toHaveLength(learned ? 1 : 0);
  });

  it('keeps an explicit category choice ahead of memory and never learns an LLM suggestion', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    rememberCorrection(sql, {
      workspaceId: 'workspace', actor: 'actor', target: 'carne no nubank', field: 'category',
      content: 'Para "carne no nubank", a categoria usada é "Salário".',
      references: [{ kind: 'category', id: INCOME.id }],
    });
    const provider = vi.fn(async () => ({ categoryId: EXPENSE.id }));
    const { turn, request } = setup(provider, [EXPENSE, INCOME], undefined, sql);
    await turn('gastei 50 de carne no Nubank', 'cat-memory-explicit-1');
    const result = await turn('categoria Mercado', 'cat-memory-explicit-2');
    expect(provider).not.toHaveBeenCalled();
    expect(result.mutation?.operationId).toBe('pending-test');
    const payload = request.mock.calls.find(([method, path]) => method === 'POST' && path.endsWith('/propose'))?.[2];
    expect((payload?.body as { normalizedArgs?: Record<string, unknown> } | undefined)?.normalizedArgs?.categoryId).toBe(EXPENSE.id);
    expect(sql.rows('agent_memory')).toHaveLength(1);
  });

  it('does not persist a category inferred by the suggestion provider', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const provider = vi.fn(async () => ({ categoryId: EXPENSE.id }));
    const { turn } = setup(provider, [EXPENSE], undefined, sql);
    await turn('gastei 50 de carne', 'cat-memory-model-1');
    await turn('Nubank', 'cat-memory-model-2');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sql.rows('agent_memory')).toHaveLength(0);
  });

  it('does not learn while memory is disabled, and does not recall it after re-enabling', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    setMemoryEnabled(sql, 'workspace', false);
    const events = vi.fn();
    const { turn } = setup(undefined, [EXPENSE], events, sql);
    await turn('gastei 50 de carne no Nubank', 'cat-memory-disabled-1');
    sql.rows('agent_memory').length = 0;
    await turn('categoria Mercado', 'cat-memory-disabled-2');
    expect(sql.rows('agent_memory')).toHaveLength(0);
    expect(events.mock.calls.find(([type]) => type === 'mutation.category_memory')?.[1]).toEqual({ status: 'skipped' });
    setMemoryEnabled(sql, 'workspace', true);
    await turn('gastei 50 de carne', 'cat-memory-disabled-3');
    const afterReenable = await turn('Nubank', 'cat-memory-disabled-4');
    expect(afterReenable.clarification?.missingFields).toContain('categoryId');
  });

  it.each([
    ['missing', []],
    ['changed kind', [{ ...EXPENSE, kind: 'income' }]],
    ['inactive', [{ ...EXPENSE, isActive: false }]],
    ['other scope', [{ ...EXPENSE, scopeId: 'workspace-other' }]],
  ])('ignores learned category when catalog state is %s', async (_label, catalog) => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    rememberCorrection(sql, {
      workspaceId: 'workspace', actor: 'actor', target: 'carne', field: 'category',
      content: 'Para "carne", a categoria usada é "Mercado".',
      references: [{ kind: 'category', id: EXPENSE.id }],
    });
    const provider = vi.fn(async () => null);
    const events = vi.fn();
    const { turn } = setup(provider, catalog as EntitySummary[], events, sql);
    await turn('gastei 50 de carne', 'cat-memory-invalid-1');
    await turn('Nubank', 'cat-memory-invalid-2');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(events.mock.calls.find(([type]) => type === 'mutation.category_memory')?.[1]).toMatchObject({ status: 'invalidated' });
    expect(sql.rows('agent_memory')).toHaveLength(1);
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
