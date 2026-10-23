import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';
type SqlShim = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };
const createSql = (): { sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) return statement.all(...(bindings as any)) as T[];
    statement.run(...(bindings as any)); return [] as T[];
  } };
  initializeMutationDraftSchema(sql); return { sql };
};
const identity: AuthenticatedIdentity = { actorId: 'a2', workspaceId: 'w2', role: 'member', deviceId: 'd2' };
const T0 = Date.parse('2026-10-21T12:00:00Z');
const harness = (listActiveImpl: any) => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql);
  const proposeCalls: any[] = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = options?.body ?? {};
      proposeCalls.push({ tool: body.tool, normalizedArgs: body.normalizedArgs });
      return { id: 'op1', existing: false, summary: 'Categoria Viagem', operation: { id: 'op1', expiresAt: new Date(T0 + 10*60000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(method+' '+path);
  });
  const api = new MutationApiClient({ request });
  (api as any).listActive = listActiveImpl;
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => [{ id: '1', name: 'Alimentação', kind: 'expense' }] },
    draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
  });
  // seed a complete category draft
  return { store, proposeCalls, orchestrator, api };
};
describe('category pending guard', () => {
  it('existing pending -> no propose', async () => {
    const h = harness(async () => ({ items: [{ id: 'opx', status: 'proposed' }], total: 1 }));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem em Alimentação', intentionId: 'a' }, identity));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
    const before = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
    const revBefore = before[0]?.revision;
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'c' }, identity));
    const after = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
    expect(h.proposeCalls).toHaveLength(0);
    expect(after[0]?.revision).toBe(revBefore);
  });
  it('throw -> inconclusive, no propose, draft unchanged', async () => {
    const h = harness(async () => { throw new Error('boom'); });
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem em Alimentação', intentionId: 'a' }, identity));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
    const before = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
    const revBefore = before[0]?.revision;
    const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'c' }, identity));
    const after = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
    expect(r.response?.text).toMatch(/processamento/i);
    expect(h.proposeCalls).toHaveLength(0);
    expect(after[0]?.revision).toBe(revBefore);
  });
  it('invalid payload {} -> inconclusive', async () => {
    const h = harness(async () => ({}));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem em Alimentação', intentionId: 'a' }, identity));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
    const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'c' }, identity));
    expect(r.response?.text).toMatch(/processamento/i);
    expect(h.proposeCalls).toHaveLength(0);
  });
  it('items null -> inconclusive', async () => {
    const h = harness(async () => ({ items: null }));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem em Alimentação', intentionId: 'a' }, identity));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
    const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'c' }, identity));
    expect(r.response?.text).toMatch(/processamento/i);
    expect(h.proposeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ported from TEMP diagnostic (category-failed-guard-diagnostic.test.ts) with
// relative imports. Real SQLite store (SqlMutationDraftStore) + fake API
// boundary (listActive mocked). Permanent coverage.
// ---------------------------------------------------------------------------

const twoRootsDiag = () => ({
  items: [
    { id: 'cat-alim', householdId: 'w2', name: 'Alimentação', kind: 'expense', status: 'active' },
    { id: 'cat-transp', householdId: 'w2', name: 'Transporte', kind: 'expense', status: 'active' },
  ],
  total: 2,
});

const harnessDiag = (itemsFactory: () => { items: any[]; total: number }, active: any = { items: [], total: 0 }) => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql);
  const proposeCalls: any[] = [];
  const requestCalls: any[] = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
    requestCalls.push({ method, path });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = options?.body ?? {};
      proposeCalls.push({ tool: body.tool, normalizedArgs: body.normalizedArgs });
      return { id: 'op1', existing: false, summary: 'Categoria QA Mercado Azul', operation: { id: 'op1', expiresAt: new Date(T0 + 10 * 60000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return active;
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') return { firstSeenAt: new Date(T0).toISOString(), fresh: true, operationId: null };
    throw new Error(method + ' ' + path);
  });
  const api = new MutationApiClient({ request, events: () => undefined });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => itemsFactory() } as any,
    draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
  });
  const run = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  const drafts = () => store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
  return { store, proposeCalls, requestCalls, orchestrator, run, drafts, api };
};

describe('subcategory QA Mercado Azul - pending guard ported (real SQLite)', () => {
  const op = (status: string) => ({ id: 'old-op', status, tool: 'categories.create', presentation: { version: 1, operationId: 'old-op', status, tool: 'categories.create', operation: 'category-create', name: 'Viagem Safira', categoryKind: 'expense', warnings: [] }, createdAt: new Date(T0-60000).toISOString(), expiresAt: new Date(T0+600000).toISOString(), failureCode: status === 'failed' ? 'idempotency.conflict' : undefined });

  for (const status of ['empty', 'failed', 'executing', 'succeeded', 'cancelled', 'expired']) {
    it('known non-decidable status ' + status + ' allows draft PROPOSE (not execute old)', async () => {
      const h = harnessDiag(twoRootsDiag, { items: status === 'empty' ? [] : [op(status)], total: status === 'empty' ? 0 : 1 });
      await h.run('crie subcategoria QA Mercado Azul de despesa', 'start');
      await h.run('Alimentação', 'parent');
      const r3 = await h.run('confirmo!', 'confirm');
      // after unused
      expect(r3.mutation?.status).toBe('proposed');
      expect(h.proposeCalls).toHaveLength(1);
      expect(h.proposeCalls[0].tool).toBe('categories.create');
      expect(h.proposeCalls[0].normalizedArgs).toEqual({ name: 'QA Mercado Azul', kind: 'expense', parentId: 'cat-alim' });
      // no execute of old op
      expect(r3.mutation?.operationId).toBe('op1');
    });
  }

  for (const status of ['proposed', 'confirmed']) {
    it('decidable status ' + status + ' blocks propose, draft unchanged', async () => {
      const h = harnessDiag(twoRootsDiag, { items: [op(status)], total: 1 });
      await h.run('crie subcategoria QA Mercado Azul de despesa', 'start');
      await h.run('Alimentação', 'parent');
      const before = h.drafts()[0];
      expect(before).toBeDefined();
      expect(before?.revision).not.toBeUndefined();
      await h.run('confirmo!', 'confirm');
      const after = h.drafts()[0];
      expect(after).toBeDefined();
      expect(after).toEqual(before);
      expect(after?.revision).toBe(before?.revision);
      expect(h.proposeCalls).toHaveLength(0);
      const mutating = h.requestCalls.filter((c: any) => /\/(propose|execute|confirm|retry|cancel)(\/|$)/.test(c.path));
      expect(mutating).toHaveLength(0);
    });
  }
});

describe('subcategory QA Mercado Azul - mixed kind rejection ported', () => {
  it('fresh mixed kind (receita) with expense parent clarifies mismatch, no propose', async () => {
    const h = harnessDiag(twoRootsDiag);
    await h.run('crie subcategoria QA Mercado Azul de receita da categoria Alimentação', 'a');
    expect(h.proposeCalls).toHaveLength(0);
  });
});

describe('canonical decision scope - mixed failed + proposed precedence', () => {
  it('mixed failed + proposed resolves proposed for confirmation and failed only for retry', async () => {
    const api = new MutationApiClient({ events: () => undefined, request: async () => ({ items: [{ id: 'old-failed', status: 'failed', tool: 'categories.create' }, { id: 'real-pending', status: 'proposed', tool: 'categories.create' }], total: 2 }) as any });
    const coordinator = new (await import('../src/orchestration/pending-operation-coordinator.js')).PendingOperationCoordinator({ client: api });
    const confirm = await coordinator.resolveDecisionTarget(identity as any, 'decidable');
    const retry = await coordinator.resolveDecisionTarget(identity as any, 'retryable');
    expect(confirm.kind).toBe('single');
    expect(confirm.kind === 'single' && confirm.operation.id).toBe('real-pending');
    expect(retry.kind).toBe('single');
    expect(retry.kind === 'single' && retry.operation.id).toBe('old-failed');
  });
});

describe('pending guard - unknown/malformed mixed with proposed (both orders) => inconclusive', () => {
  const mkHarness = (listActiveImpl: any) => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const proposeCalls: any[] = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = options?.body ?? {};
        proposeCalls.push({ tool: body.tool, normalizedArgs: body.normalizedArgs });
        return { id: 'op1', existing: false, summary: 'Categoria Viagem', operation: { id: 'op1', expiresAt: new Date(T0 + 10*60000).toISOString() } };
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(method+' '+path);
    });
    const api = new MutationApiClient({ request });
    (api as any).listActive = listActiveImpl;
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => [{ id: '1', name: 'Alimentação', kind: 'expense' }] },
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });
    return { store, proposeCalls, orchestrator, api };
  };

  const seed = async (h: any) => {
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem em Alimentação', intentionId: 'a' }, identity));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
  };

  const cases: { name: string; items: any[] }[] = [
    { name: 'proposed then malformed (missing id)', items: [{ id: 'opx', status: 'proposed' }, { status: 'proposed' /* no id */ }] },
    { name: 'malformed (no id) then proposed', items: [{ status: 'proposed' /* no id */ }, { id: 'opx', status: 'proposed' }] },
    { name: 'proposed then unknown status', items: [{ id: 'opx', status: 'proposed' }, { id: 'opy', status: 'weird' }] },
    { name: 'unknown status then proposed', items: [{ id: 'opy', status: 'weird' }, { id: 'opx', status: 'proposed' }] },
    { name: 'null item mixed', items: [null, { id: 'opx', status: 'proposed' }] },
    { name: 'missing status mixed', items: [{ id: 'opx' }, { id: 'opy', status: 'proposed' }] },
  ];

  for (const c of cases) {
    it(c.name + ' => inconclusive, no writes', async () => {
      const listActiveImpl = async () => ({ items: c.items, total: c.items.length });
      const h = mkHarness(listActiveImpl);
      await seed(h);
      const beforeDrafts = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
      const revBefore = beforeDrafts[0]?.revision;
      const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'c' }, identity));
      const afterDrafts = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
      expect(r.response?.text).toMatch(/processamento/i);
      expect(h.proposeCalls).toHaveLength(0);
      expect(afterDrafts[0]?.revision).toBe(revBefore);
    });
  }
});

describe('old failed retry intent selects failed only (coordinator)', () => {
  it('retryable scope returns only failed even with proposed present', async () => {
    const { PendingOperationCoordinator } = await import('../src/orchestration/pending-operation-coordinator.js');
    const api = new MutationApiClient({ events: () => undefined, request: async () => ({ items: [{ id: 'old-failed', status: 'failed', tool: 'categories.create' }, { id: 'real-pending', status: 'proposed', tool: 'categories.create' }], total: 2 }) as any });
    const coordinator = new PendingOperationCoordinator({ client: api });
    const retry = await coordinator.resolveDecisionTarget(identity as any, 'retryable');
    expect(retry.kind).toBe('single');
    expect(retry.kind === 'single' && retry.operation.id).toBe('old-failed');
  });
});
