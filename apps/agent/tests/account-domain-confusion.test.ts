/**
 * ted-local-account-domain-guards — RED: the creation/deactivation guards
 * must read the ACTION OBJECT, not just verb + "conta".
 *
 * Confirmed browser bugs (Explorer):
 * - "Desative categoria QA Transporte" raised deactivation for a bank account;
 * - "crie conta a pagar QA Luz ..." opened an account draft for a payable;
 * - "crie parcelamento QA Teste 3x de 50 conta QA Aurora banco" opened an
 *   account draft for an installment plan mentioning a funding account.
 *
 * Contract: a foreign entity as the governed object (categoria/cartão/
 * fatura/parcela/parcelamento/assinatura/boleto/compromisso/orçamento/meta,
 * or the "conta a pagar/vencida" idiom) vetoes the account signal — but a
 * bare keyword inside an explicitly named span never vetoes
 * ('"Conta a Pagar"', 'chamada Categoria ...' keep working). A negated verb
 * ("não/nunca crie/desative") is no signal; "negativo"/"-50" are balance
 * vocabulary, never verb negation. Unsupported turns must not write.
 */
import { describe, expect, it, vi } from 'vitest';
import { hasAccountCreationSignal } from '../src/mutations/account-creation.js';
import {
  hasAccountDeactivationSignal,
} from '../src/mutations/account-deactivation.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-dom',
  workspaceId: 'workspace-dom',
  role: 'member',
  deviceId: 'device-dom',
};

const ctx = {
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
};

const reader = () => ({
  listAccounts: async () => [],
  listCategories: async () => [],
});

const mockClient = () => {
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as { body?: Record<string, unknown> }).body ?? {};
      return {
        id: 'op-dom-1',
        existing: false,
        summary: body.summary ?? 'Dom',
        operation: { id: 'op-dom-1', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api: new MutationApiClient({ request }), request, calls };
};

const harness = (nowMs: number) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  const { api, request, calls } = mockClient();
  const responseProvider = vi.fn(async () => 'invented by model');
  const evidenceProvider = vi.fn(async () => ({
    version: '1' as const,
    items: [
      {
        ref: 'test',
        source: 'api.test',
        retrievedAt: new Date().toISOString(),
        status: 'empty' as const,
        data: [],
        reason: 'setup_incomplete' as const,
      },
    ],
  }) as never);
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: reader(),
    draftStore: store,
    draftNow: () => now,
    responseProvider,
    evidenceProvider,
    events: () => undefined,
  });
  return { store, request, calls, orchestrator };
};

const T0 = Date.parse('2026-10-21T12:00:00Z');

const accountDrafts = (store: InMemoryMutationDraftStore, at: number) =>
  store
    .listActive(ctx, at)
    .filter((d) => d.tool === 'accounts.create' || d.tool === 'accounts.deactivate');

const proposes = (calls: Array<{ method: string; path: string }>) =>
  calls.filter((c) => c.method === 'POST' && c.path === '/pending-operations/v2/propose');

describe('ted-local-account-domain-guards: creation signal reads the object', () => {
  it('(1) RED: payable idiom is not a bank account', () => {
    expect(hasAccountCreationSignal('crie conta a pagar QA Luz de 100 vencimento 25/10/2026')).toBe(false);
  });

  it('(2) RED: installment plan mentioning a funding account is not a creation', () => {
    expect(
      hasAccountCreationSignal('crie parcelamento QA Teste 3x de 50 conta QA Aurora banco'),
    ).toBe(false);
  });

  it('(3) control: plain bank creation still signals', () => {
    expect(hasAccountCreationSignal('crie conta QA Aurora banco saldo1000')).toBe(true);
    expect(hasAccountCreationSignal('criar conta Nubank com saldo 145')).toBe(true);
  });

  it('(4) control: quoted payable name is a name, not the idiom', () => {
    expect(hasAccountCreationSignal('crie conta "Conta a Pagar" com saldo100')).toBe(true);
  });

  it('(5) control: "chamada Categoria ..." names the account', () => {
    expect(hasAccountCreationSignal('crie conta chamada Categoria Mercado com saldo 100')).toBe(true);
  });

  it('(6) RED: negated verb is no signal', () => {
    expect(hasAccountCreationSignal('não crie conta QA Aurora')).toBe(false);
    expect(hasAccountCreationSignal('nunca crie conta QA Aurora')).toBe(false);
  });

  it('(7) control: balance negativity is not verb negation', () => {
    expect(hasAccountCreationSignal('crie conta Reserva com saldo negativo de 50')).toBe(true);
    expect(hasAccountCreationSignal('crie conta Reserva com saldo -50')).toBe(true);
  });
});

describe('ted-local-account-domain-guards: deactivation signal reads the object', () => {
  it('(8) RED: foreign object vetoes even an account-specific verb', () => {
    expect(hasAccountDeactivationSignal('Desative categoria QA Transporte')).toBe(false);
    expect(hasAccountCreationSignal('Desative categoria QA Transporte')).toBe(false);
  });

  it('(9) control: "desative conta chamada Categoria" names the account', () => {
    expect(hasAccountDeactivationSignal('desative conta chamada Categoria')).toBe(true);
  });

  it('(10) control: explicit bank deactivation keeps working', () => {
    expect(hasAccountDeactivationSignal('desative a conta nubank')).toBe(true);
  });

  it('(11) control: existing contract — explicit verb beats transactional noun', () => {
    expect(hasAccountDeactivationSignal('desative a despesa')).toBe(true);
  });

  it('(12) RED: negated verb is no signal', () => {
    expect(hasAccountDeactivationSignal('nunca desative minha conta')).toBe(false);
    expect(hasAccountDeactivationSignal('não desative a conta nubank')).toBe(false);
  });

  it('(13) control: card object is not an account object', () => {
    expect(hasAccountDeactivationSignal('desative cartão Nubank')).toBe(false);
  });

  it('(18) RED: quoted negation does not veto: `crie conta "Não crie" tipo bank`', () => {
    expect(hasAccountCreationSignal('crie conta "Não crie" tipo bank com saldo 0')).toBe(true);
  });

  it('(19) RED: named negation does not veto: `desative conta chamada Nunca Desative`', () => {
    expect(hasAccountDeactivationSignal('desative conta chamada Nunca Desative')).toBe(true);
  });

  it('(20) control: real negation outside spans still vetoes', () => {
    expect(hasAccountCreationSignal('não crie conta "Não crie"')).toBe(false);
  });

  it('(21) RED: generic verb + payable idiom is no deactivation', () => {
    expect(hasAccountDeactivationSignal('apague conta a pagar QA Luz')).toBe(false);
  });

  it('(22) RED: generic verb + foreign object with account anchor is no deactivation', () => {
    expect(hasAccountDeactivationSignal('exclua a categoria Mercado da conta Nubank')).toBe(false);
  });

  it('(23) modal negation is no signal: "não pode criar conta"', () => {
    expect(hasAccountCreationSignal('não pode criar conta QA Aurora')).toBe(false);
    expect(hasAccountDeactivationSignal('não pode excluir a conta Nubank')).toBe(false);
  });

  it('(24) control: legacy explicit verb still wins over transactional noun', () => {
    expect(hasAccountDeactivationSignal('desative a despesa')).toBe(true);
  });
});

describe('ted-local-account-domain-guards: unsupported turns write nothing', () => {
  it('(14) RED: payable turn opens no account draft and proposes nothing', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie conta a pagar QA Luz de 100 vencimento 25/10/2026', intentionId: 'dom-14' }, identity),
    );
    expect(accountDrafts(h.store, T0 + 1000)).toHaveLength(0);
    expect(proposes(h.calls)).toHaveLength(0);
  });

  it('(15) RED: installment turn opens no account draft and proposes nothing', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie parcelamento QA Teste 3x de 50 conta QA Aurora banco', intentionId: 'dom-15' }, identity),
    );
    expect(accountDrafts(h.store, T0 + 1000)).toHaveLength(0);
    expect(proposes(h.calls)).toHaveLength(0);
  });

  it('(16) RED: foreign deactivation opens no draft and proposes nothing', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Desative categoria QA Transporte', intentionId: 'dom-16' }, identity),
    );
    expect(accountDrafts(h.store, T0 + 1000)).toHaveLength(0);
    expect(proposes(h.calls)).toHaveLength(0);
  });

  it('(17) control: harness sanity — incomplete legit creation still drafts', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie conta QA Aurora com saldo 1000', intentionId: 'dom-17' }, identity),
    );
    expect(h.store.listActive(ctx, T0 + 1000).length).toBeGreaterThan(0);
  });
});
