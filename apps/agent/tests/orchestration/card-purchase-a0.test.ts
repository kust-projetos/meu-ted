import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity, type TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore, buildDraftRecord } from '../../src/mutations/mutation-draft.js';

const identity: AuthenticatedIdentity = { actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device' };
const cardId = '00000000-0000-4000-8000-000000000101';
const bankId = '00000000-0000-4000-8000-000000000102';
const categoryId = '00000000-0000-4000-8000-000000000107';
const plan = () => ({ version: '2' as const, mode: 'mutation-proposal' as const, domain: 'transactions' as const, skillNames: ['transactions'], requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' as const }], missingFields: ['accountId', 'categoryId'], ambiguity: null, confidence: 1 });
const accounts = (cards: { id: string; name: string; kind: string; status?: string; isActive?: boolean; scopeId?: string }[] = [{ id: cardId, name: 'Nubank', kind: 'credit_card' }]) => [...cards, { id: bankId, name: 'Conta corrente', kind: 'bank' }];

const run = async (text: string, accountRows = accounts(), options: { turnPlan?: TurnPlan; withDraft?: boolean; accountScope?: string; autoExecutionClient?: () => undefined } = {}) => {
  const request = vi.fn().mockResolvedValue({ id: 'pending-card' });
  const autoExecutionClient = options.autoExecutionClient ?? vi.fn(() => undefined);
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request }),
    plan: () => options.turnPlan ?? plan(),
    entityReader: { scope: { workspaceId: options.accountScope ?? 'workspace' }, listAccounts: async () => accountRows, listCategories: async () => [{ id: categoryId, name: 'Mercado' }] },
    ...(options.withDraft === false ? {} : { draftStore: new InMemoryMutationDraftStore() }),
    autoExecutionClient,
  });
  const result = await orchestrator.runTurn(normalizeRestTurn({ text, intentionId: 'intent-card' }, identity));
  return { result, request, autoExecutionClient };
};

describe('A0 card purchase proposals', () => {
  it('proposes one card purchase without category and keeps the full amount', async () => {
    const { result, request } = await run('Comprei R$ 120 no cartão Nubank');
    expect(result.mutation?.operationId).toBe('pending-card');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('POST', '/pending-operations/v2/propose', expect.objectContaining({ body: expect.objectContaining({ tool: 'cards.purchase.create', normalizedArgs: expect.objectContaining({ amountCents: 12000, accountId: cardId, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) }) }));
    expect(request.mock.calls[0]?.[2]?.body).toHaveProperty('normalizedArgs.description');
    expect(request.mock.calls[0]?.[2]?.body).not.toHaveProperty('normalizedArgs.categoryId');
  });

  it('allows a bank/card homonym when the card name is explicit (and ignores short-name substrings)', async () => {
    const bankAndCard = await run('Comprei R$ 120 no cartão Nubank', [...accounts(), { id: '00000000-0000-4000-8000-000000000104', name: 'Nubank', kind: 'bank' }]);
    expect(bankAndCard.request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'cards.purchase.create', normalizedArgs: { accountId: cardId } });
    const shortName = await run('Comprei R$ 120 no cartão Visa e abri o menu', [
      { id: '00000000-0000-4000-8000-000000000105', name: 'Visa', kind: 'credit_card' },
      { id: '00000000-0000-4000-8000-000000000106', name: 'Nu', kind: 'bank' },
    ]);
    expect(shortName.request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'cards.purchase.create' });
  });

  it.each([{ cards: [] as { id: string; name: string; kind: string }[] }, { cards: [{ id: cardId, name: 'Nubank', kind: 'credit_card' }, { id: '00000000-0000-4000-8000-000000000103', name: 'Visa', kind: 'credit_card' }] }])('clarifies without proposing unless exactly one card exists', async ({ cards }) => {
    const { result, request } = await run('Comprei R$ 120 no cartão Nubank', accounts(cards));
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/cart(?:ã|a)o|cartões de crédito/i);
    if (cards.length > 1) expect(result.response?.text).toContain('Visa');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not route debit or card-bill payment to card purchases', async () => {
    const debit = await run(`Comprei R$ 120 no débito na conta Conta corrente na categoria ${categoryId}`);
    expect(debit.request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'transactions.expense.create' });
    const bill = await run('paguei a fatura do cartão Nubank');
    expect(bill.request).not.toHaveBeenCalled();
    expect(bill.result.mutation).toBeUndefined();
  });

  it.each(['Comprei R$ 600 em 3 vezes no cartão Nubank', 'Comprei R$ 50 em 12 parcelas no cartão Nubank', 'parcelei 600 no cartão Nubank'])('clarifies installment wording without proposing: %s', async (text) => {
    const { result, request } = await run(text);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/parcelad/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('clarifies comma-terminated 3x installment intent without proposing', async () => {
    const { result, request } = await run('Comprei R$ 600 em 3x, no cartão Nubank');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/parcelad/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('clarifies an unspecified installment purchase without proposing', async () => {
    const { result, request } = await run('Comprei R$ 600 em parcelas no cartão Nubank');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/parcelad/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not select inactive or out-of-scope cards', async () => {
    for (const card of [
      { id: cardId, name: 'Nubank', kind: 'credit_card', status: 'inactive' },
      { id: cardId, name: 'Nubank', kind: 'credit_card', scopeId: 'another-workspace' },
    ]) {
      const { result, request } = await run('Comprei R$ 120 no cartão Nubank', [card]);
      expect(result.mutation).toBeUndefined();
      expect(result.response?.text).toMatch(/cartões de crédito disponíveis/i);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('clarifies when the named card is inactive or unknown instead of falling back to Nubank', async () => {
    const inactive = await run('Comprei R$ 120 no cartão Antigo', [
      { id: cardId, name: 'Nubank', kind: 'credit_card' },
      { id: '00000000-0000-4000-8000-000000000108', name: 'Antigo', kind: 'credit_card', status: 'inactive' },
      { id: bankId, name: 'Conta corrente', kind: 'bank' },
    ]);
    expect(inactive.result.mutation).toBeUndefined();
    expect(inactive.result.response?.text).toMatch(/Antigo.*indisponível|indisponível.*Nubank/is);
    expect(inactive.request).not.toHaveBeenCalled();

    const unknown = await run('Comprei R$ 120 no cartão Itaucard');
    expect(unknown.result.mutation).toBeUndefined();
    expect(unknown.result.response?.text).toMatch(/Itaucard.*disponível|cartão.*Nubank/is);
    expect(unknown.request).not.toHaveBeenCalled();

    const lowercaseUnknown = await run('Comprei R$ 120 no cartão itaucard');
    expect(lowercaseUnknown.result.mutation).toBeUndefined();
    expect(lowercaseUnknown.result.response?.text).toMatch(/indisponível|não foi encontrado/i);
    expect(lowercaseUnknown.request).not.toHaveBeenCalled();
  });

  it('allows generic credit-card wording when the workspace has exactly one active card', async () => {
    const { result, request } = await run('Comprei R$ 120 no cartão de crédito');
    expect(result.mutation?.status).toBe('proposed');
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'cards.purchase.create', normalizedArgs: { accountId: cardId } });
  });

  it.each([
    'Comprei R$ 120 no cartão à vista',
    'Comprei R$ 120 no cartão hoje',
    'Comprei R$ 120 no cartão Nubank hoje',
  ])('does not treat non-name wording as an unknown card: %s', async (text) => {
    const { result, request } = await run(text);
    expect(result.mutation?.status).toBe('proposed');
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'cards.purchase.create', normalizedArgs: { accountId: cardId } });
  });

  it('clarifies the generic market reference rather than guessing a card', async () => {
    const { result, request } = await run('Comprei R$ 120 no cartão do mercado');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/indisponível|não foi encontrado/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not classify a date after "cartão em" as an unavailable card', async () => {
    const { result, request } = await run('Comprei R$ 120 no cartão em 05/11');
    expect(result.response?.text).not.toMatch(/indisponível|não foi encontrado/i);
    expect(request.mock.calls.some((call) => (call[2]?.body as { tool?: string } | undefined)?.tool === 'cards.purchase.create')).toBe(false);
  });

  it('never proposes a card purchase for a card-bill payment with a date', async () => {
    const { request } = await run('Paguei R$ 800 a fatura do cartão em 05/11');
    expect(request.mock.calls.some((call) => (call[2]?.body as { tool?: string } | undefined)?.tool === 'cards.purchase.create')).toBe(false);
  });

  it('works without draft store and never invokes autoexecution', async () => {
    const { request, autoExecutionClient } = await run('Comprei R$ 120 no cartão Nubank', accounts(), { withDraft: false });
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'cards.purchase.create' });
    expect(autoExecutionClient).not.toHaveBeenCalled();
  });

  it.each(['categories.create', 'categories.update'])('does not intercept %s plans', async (operation) => {
    const categoryPlan: TurnPlan = { ...plan(), domain: 'categories', requestedOperations: [{ name: operation, kind: 'mutation' }] };
    const { request } = await run('crie a categoria Compra no cartão', accounts(), { turnPlan: categoryPlan });
    expect(request.mock.calls.some((call) => (call[2]?.body as { tool?: string } | undefined)?.tool === 'cards.purchase.create')).toBe(false);
  });

  it('processes an active draft through normal replacement handling before a new card purchase', async () => {
    const store = new InMemoryMutationDraftStore();
    store.getOrCreate(buildDraftRecord({
      workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null,
      intentionId: 'origin', tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'Mercado', date: '2026-10-01', accountId: '', categoryId: '' },
      missingFields: ['accountId', 'categoryId'], question: 'Qual conta devo usar para Mercado?',
    }));
    const request = vi.fn().mockResolvedValue({ id: 'pending-card' });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({ request }), plan,
      entityReader: { listAccounts: async () => accounts(), listCategories: async () => [] },
      draftStore: store,
    });
    const result = await orchestrator.runTurn(normalizeRestTurn({ text: 'Comprei R$ 120 no cartão Nubank', intentionId: 'new-intent' }, identity));
    expect(store.findByIntention({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, 'origin')?.status).toBe('replaced');
    expect(result.mutation?.status).toBe('proposed');
    expect(request.mock.calls[0]?.[2]?.body).toMatchObject({ tool: 'cards.purchase.create' });
  });

  it('returns inconclusive when the proposal request rejects', async () => {
    const request = vi.fn().mockRejectedValue(new Error('network failure'));
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({ request }), plan,
      entityReader: { listAccounts: async () => accounts(), listCategories: async () => [] },
      draftStore: new InMemoryMutationDraftStore(),
    });
    const result = await orchestrator.runTurn(normalizeRestTurn({ text: 'Comprei R$ 120 no cartão Nubank', intentionId: 'intent-card' }, identity));
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/resultado não pôde ser confirmado/i);
  });

  it('redelivery reuses the same intention-derived idempotency key', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'pending-card' });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({ request }), plan,
      entityReader: { listAccounts: async () => accounts(), listCategories: async () => [] },
      draftStore: new InMemoryMutationDraftStore(),
    });
    for (let i = 0; i < 2; i++) await orchestrator.runTurn(normalizeRestTurn({ text: 'Comprei R$ 120 no cartão Nubank', intentionId: 'intent-card' }, identity));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[2]?.idempotencyKey).toBe(request.mock.calls[1]?.[2]?.idempotencyKey);
  });

  it('fails closed on installments instead of silently proposing one installment', async () => {
    const { result, request } = await run('Comprei R$ 600 em 3x no cartão Nubank');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/parcelad/i);
    expect(request).not.toHaveBeenCalled();
  });
});
