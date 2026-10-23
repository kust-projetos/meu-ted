/**
 * ROUND5-RED Agent — replay sem prova + settle InMemory (HEAD 914928f).
 * DEVEM FALHAR antes da correção e PASSAR depois.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';

const ENT = '11111111-1111-4111-8111-111111111111';
const identity: AuthenticatedIdentity = {
  actorId: 'actor-r5',
  workspaceId: 'workspace-r5',
  role: 'member',
  deviceId: 'device-r5',
};
const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
const T0 = Date.parse('2026-10-21T12:00:00Z');

const harness = (nowMs: number) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  let activeOp: Record<string, unknown> | null = null;
  const request = vi.fn().mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      return activeOp ? { items: [activeOp], total: 1 } : { items: [], total: 0 };
    }
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
  return {
    store,
    orchestrator,
    setActiveOp: (op: Record<string, unknown> | null) => {
      activeOp = op;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('ROUND5 RED — replay/settle', () => {
  it('R5-5 replay: legado succeeded SEM tool e SEM recibo = inconclusivo (nunca sucesso)', async () => {
    const h = harness(T0);
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'r5-legacy-1',
      operationId: 'op-legacy-1',
      receiptJson: null,
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'r5-legacy-1' }, identity),
    );
    expect(replayed.mutation).toBeUndefined();
    expect(replayed.response?.text).toMatch(/não pôde ser confirmado/i);
  });

  it('R5-6 fallback: succeeded EXPIRADO sensível sem recibo + listing vazio = inconclusivo', async () => {
    const h = harness(T0);
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'r5-exp-1',
      operationId: 'op-exp-1',
      receiptJson: null,
      tool: 'accounts.update',
      entityId: ENT,
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    // Expira o binding (TTL 30d) e esvazia o listing.
    h.advance(31 * 24 * 60 * 60 * 1000);
    h.setActiveOp(null);
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'r5-exp-1' }, identity),
    );
    expect(replayed.mutation).toBeUndefined();
    expect(replayed.response?.text).toMatch(/não pôde ser confirmado/i);
  });

  it('R5-7 settle InMemory: first-write tool/entity imutável (paridade SQL COALESCE)', () => {
    const store = new InMemoryMutationDraftStore();
    const intentionId = 'r5-settle-1';
    const claimed = store.claimConfirmation({
      ctx,
      intentionId,
      operationId: 'op-r5-7',
      receiptJson: null,
      tool: 'accounts.update',
      entityId: ENT,
      status: 'reserved',
      nowMs: T0,
    });
    expect(claimed).toBe('claimed');
    const ok = store.settleConfirmation!({
      ctx,
      intentionId,
      operationId: 'op-r5-7',
      status: 'succeeded',
      receiptJson: null,
      tool: 'transactions.expense.create',
      entityId: 'tx-outra',
      nowMs: T0 + 1000,
    });
    expect(ok).toBe(true);
    const record = store.findConfirmation(ctx, intentionId, T0 + 1000);
    expect(record?.tool).toBe('accounts.update');
    expect(record?.entityId).toBe(ENT);
  });

  it('R5-8 RED: legado EXPIRADO sem tool/sem recibo + listing vazio = inconclusivo (nunca sucesso)', async () => {
    const h = harness(T0);
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'r5-legacy-exp',
      operationId: 'op-legacy-exp',
      receiptJson: null,
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    h.advance(25 * 60 * 60_000);
    h.setActiveOp(null);
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'r5-legacy-exp' }, identity),
    );
    expect(replayed.mutation).toBeUndefined();
    expect(replayed.response?.text).toMatch(/não pôde ser confirmado/i);
  });

  it('R5-9 RED: recibo corrompido/divergente antes do TTL sem tool + listing vazio = inconclusivo', async () => {
    for (const [name, receiptJson] of [
      ['corrupt', '{not-json'],
      ['divergent', JSON.stringify({ operationId: 'op-EVIL', mutationId: 'm', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions'], entity: { type: 'transaction', id: 'tx-x' } })],
      ['not-succeeded', JSON.stringify({ operationId: 'op-r5-9', mutationId: 'm', mutationKind: 'transactions.expense.create', status: 'failed', affectedTargets: ['transactions'], entity: { type: 'transaction', id: 'tx-x' } })],
    ] as const) {
      const h = harness(T0);
      const seeded = h.store.rememberConfirmation?.({
        ctx,
        intentionId: `r5-bad-${name}`,
        operationId: 'op-r5-9',
        receiptJson,
        nowMs: T0,
      });
      expect(seeded, name).toBe('claimed');
      h.setActiveOp(null);
      const replayed = await h.orchestrator.runTurn(
        normalizeRestTurn({ text: 'sim', intentionId: `r5-bad-${name}` }, identity),
      );
      expect(replayed.mutation, name).toBeUndefined();
      expect(replayed.response?.text, name).toMatch(/não pôde ser confirmado/i);
    }
  });

  it('R5-10 CONTRAPROVA: recibo válido expirado + listing vazio = replay sucedido preservado', async () => {
    const h = harness(T0);
    const receiptJson = JSON.stringify({
      operationId: 'op-r5-10',
      mutationId: 'mut-op-r5-10',
      mutationKind: 'transactions.expense.create',
      status: 'succeeded',
      affectedTargets: ['transactions'],
      entity: { type: 'transaction', id: 'tx-op-r5-10' },
    });
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'r5-valid-exp',
      operationId: 'op-r5-10',
      receiptJson,
      tool: 'transactions.expense.create',
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    h.advance(25 * 60 * 60_000);
    h.setActiveOp(null);
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'r5-valid-exp' }, identity),
    );
    expect(replayed.mutation?.status).toBe('succeeded');
    expect(replayed.mutation?.operationId).toBe('op-r5-10');
  });

  it('R5-11 RED: unexpired + storedTool + SEM recibo = inconclusivo (nunca replay cego)', async () => {
    // Path 1613: `succeeded` não-expirado com tool persistida mas recibo
    // ausente alegava sucesso sem prova (o marcador original não prova o
    // QUE teve efeito). Vale para todo kind — create (entidade gerada, sem
    // id pré-exec), expense/income, update/deactivate — e para tool
    // desconhecida: sem recibo válido e coerente, nunca sucesso.
    const tools = [
      'accounts.create',
      'transactions.expense.create',
      'transactions.income.create',
      'accounts.update',
      'accounts.deactivate',
      'bogus.tool',
    ] as const;
    for (const tool of tools) {
      const h = harness(T0);
      const seeded = h.store.rememberConfirmation?.({
        ctx,
        intentionId: `r5-blind-${tool}`,
        operationId: `op-blind-${tool}`,
        receiptJson: null,
        tool,
        entityId: ENT,
        nowMs: T0,
      });
      expect(seeded, tool).toBe('claimed');
      // B posterior pendente: o redelivery não pode tocá-la; qualquer POST
      // de execute/confirm no harness lança (prova de zero execute).
      h.setActiveOp({ id: 'op-B', status: 'proposed' });
      const replayed = await h.orchestrator.runTurn(
        normalizeRestTurn({ text: 'sim', intentionId: `r5-blind-${tool}` }, identity),
      );
      expect(replayed.mutation, tool).toBeUndefined();
      expect(replayed.response?.text, tool).toMatch(/não pôde ser confirmado/i);
    }
  });

  it('R5-12 CONTRAPROVA: recibo válido NÃO expirado + tool de origem = replay sucedido preservado', async () => {
    const h = harness(T0);
    const receiptJson = JSON.stringify({
      operationId: 'op-r5-12',
      mutationId: 'mut-op-r5-12',
      mutationKind: 'transactions.expense.create',
      status: 'succeeded',
      affectedTargets: ['transactions'],
      entity: { type: 'transaction', id: 'tx-op-r5-12' },
    });
    const seeded = h.store.rememberConfirmation?.({
      ctx,
      intentionId: 'r5-valid-fresh',
      operationId: 'op-r5-12',
      receiptJson,
      tool: 'transactions.expense.create',
      nowMs: T0,
    });
    expect(seeded).toBe('claimed');
    h.setActiveOp({ id: 'op-B', status: 'proposed' });
    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'r5-valid-fresh' }, identity),
    );
    expect(replayed.mutation?.status).toBe('succeeded');
    expect(replayed.mutation?.operationId).toBe('op-r5-12');
    expect(replayed.mutation?.receipt).toEqual(JSON.parse(receiptJson));
  });
});
