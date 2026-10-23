/**
 * ROUND6 — veto de contribuição estrangeira em draft de conta ativo.
 *
 * Draft de conta (accounts.create) com nome pendente + follow-up de outro
 * domínio NUNCA preenche/apaga o draft: o draft segue intacto, zero
 * propose/execute, resposta de clarify/unsupported honesta; um follow-up
 * bancário legítimo depois ainda retoma o MESMO draft. Controles quoted/
 * chamada seguem contribuindo (não são foreign).
 *
 * RED antes do veto no bloco de contribuição do orchestrator; GREEN depois.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-foreign',
  workspaceId: 'workspace-foreign',
  role: 'member',
  deviceId: 'device-foreign',
};

const ctx = {
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
};

const harness = (nowMs: number) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      return {
        id: 'op-acct-1',
        existing: false,
        summary: 'Conta',
        operation: { id: 'op-acct-1', expiresAt: new Date(now + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { listAccounts: async () => [], listCategories: async () => [] },
    draftStore: store,
    draftNow: () => now,
    responseProvider: vi.fn(async () => 'invented by model'),
    evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
    events: () => undefined,
  });
  return { store, calls, orchestrator, advance: (ms: number) => { now += ms; } };
};

const T0 = Date.parse('2026-10-21T12:00:00Z');

const openNamelessDraft = async (h: ReturnType<typeof harness>, tag: string) => {
  const r = await h.orchestrator.runTurn(
    normalizeRestTurn({ text: 'quero', intentionId: `${tag}-open` }, identity),
  );
  expect(r.mutation).toBeUndefined();
  const actives = h.store.listActive(ctx, T0 + 1000);
  expect(actives).toHaveLength(1);
  expect(actives[0]!.tool).toBe('accounts.create');
  expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
  return actives[0]!.draftId;
};

const expectDraftIntact = (h: ReturnType<typeof harness>, draftId: string, nowMs: number) => {
  const actives = h.store.listActive(ctx, nowMs);
  expect(actives).toHaveLength(1);
  expect(actives[0]!.draftId).toBe(draftId);
  expect(actives[0]!.tool).toBe('accounts.create');
  expect(actives[0]!.status).toBe('active');
  expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
};

const expectNoTransport = (h: ReturnType<typeof harness>) => {
  expect(h.calls.filter((c) => c.path.includes('/propose'))).toHaveLength(0);
  expect(h.calls.filter((c) => c.path.includes('/execute'))).toHaveLength(0);
};

describe('ROUND6 — foreign follow-up preserva draft de conta', () => {
  it('F1: "Desative categoria QA Transporte" não vira accountName, draft intacto, zero transporte', async () => {
    const h = harness(T0);
    const draftId = await openNamelessDraft(h, 'f1');
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Desative categoria QA Transporte', intentionId: 'f1-foreign' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expectNoTransport(h);
    expectDraftIntact(h, draftId, T0 + 2000);
    expect(r.response?.text).toBeTruthy();
  });

  it('F2: "crie conta a pagar QA Luz de 100" não vira name+amount, draft intacto, zero transporte', async () => {
    const h = harness(T0);
    const draftId = await openNamelessDraft(h, 'f2');
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie conta a pagar QA Luz de 100', intentionId: 'f2-foreign' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    expectNoTransport(h);
    expectDraftIntact(h, draftId, T0 + 2000);
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBeUndefined();
    expect(r.response?.text).toBeTruthy();
  });

  it('F3: "crie parcelamento QA Teste 3x de 50 conta QA Aurora banco" não preenche nem apaga o draft', async () => {
    const h = harness(T0);
    const draftId = await openNamelessDraft(h, 'f3');
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'crie parcelamento QA Teste 3x de 50 conta QA Aurora banco', intentionId: 'f3-foreign' },
        identity,
      ),
    );
    expect(r.mutation).toBeUndefined();
    expectNoTransport(h);
    expectDraftIntact(h, draftId, T0 + 2000);
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBeUndefined();
    expect(r.response?.text).toBeTruthy();
  });

  it('F4: follow-up bancário legítimo depois do foreign ainda retoma o MESMO draft', async () => {
    const h = harness(T0);
    const draftId = await openNamelessDraft(h, 'f4');
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Desative categoria QA Transporte', intentionId: 'f4-foreign' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'nubank', intentionId: 'f4-bank' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    const actives = h.store.listActive(ctx, T0 + 3000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.draftId).toBe(draftId);
    expect(actives[0]!.resolvedArgs.accountName).toMatch(/nubank/i);
  });

  it('C1 (controle): nome quoted "Conta a Pagar" segue contribuindo (não é foreign)', async () => {
    const h = harness(T0);
    const draftId = await openNamelessDraft(h, 'c1');
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'criar conta "Conta a Pagar" de 100', intentionId: 'c1-quoted' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.draftId).toBe(draftId);
    expect(actives[0]!.resolvedArgs.accountName).toMatch(/conta a pagar/i);
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBe(10000);
  });

  it('C2 (controle): "conta chamada Mercado de 100" segue contribuindo (não é foreign)', async () => {
    const h = harness(T0);
    const draftId = await openNamelessDraft(h, 'c2');
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'conta chamada Mercado de 100', intentionId: 'c2-named' }, identity),
    );
    expect(r.mutation).toBeUndefined();
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.draftId).toBe(draftId);
    expect(actives[0]!.resolvedArgs.accountName).toMatch(/mercado/i);
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBe(10000);
  });
});
