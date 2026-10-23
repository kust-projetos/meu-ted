import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore, buildDraftRecord } from '../src/mutations/mutation-draft.js';

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

const identity = (ws: string): AuthenticatedIdentity => ({ actorId: 'a', workspaceId: ws, role: 'member', deviceId: 'd' });
const T0 = Date.parse('2026-10-21T12:00:00Z');

describe('category parent scope & concurrency', () => {
  it('foreign reader scope fails closed (no match, no options, no propose)', async () => {
    const ws = 'w2';
    const id = identity(ws);
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const proposeCalls: any[] = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(method + ' ' + path);
    });
    const api = new MutationApiClient({ request });
    const foreignItem = { id: 'foreign-root', householdId: 'foreign', name: 'Alimentação', kind: 'expense', status: 'active' };
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: 'foreign' }, listAccounts: async () => [], listCategories: async () => [foreignItem] } as any,
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });
    const r = await orchestrator.runTurn(normalizeRestTurn({ text: 'crie subcategoria QA de despesa em Alimentação', intentionId: 'a' }, id));
    expect(r.response?.text).toMatch(/encontrei/i);
    expect(proposeCalls).toHaveLength(0);
  });

  it('active+false root is rejected as parent', async () => {
    const ws = 'w2';
    const id = identity(ws);
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const proposeCalls: any[] = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(method + ' ' + path);
    });
    const api = new MutationApiClient({ request });
    const item = { id: 'root', householdId: ws, name: 'Alimentação', kind: 'expense', status: 'active', isActive: false };
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: ws }, listAccounts: async () => [], listCategories: async () => [item] } as any,
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });
    const r = await orchestrator.runTurn(normalizeRestTurn({ text: 'crie subcategoria QA de despesa em Alimentação', intentionId: 'a' }, id));
    expect(r.response?.text).toMatch(/encontrei/i);
    expect(proposeCalls).toHaveLength(0);
  });

  it('deferred: parent expense read must not propose income parent expense', async () => {
    const ws = 'w2';
    const id = identity(ws);
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const candidate = buildDraftRecord({
      workspaceId: id.workspaceId, actorId: id.actorId, deviceId: id.deviceId ?? null,
      intentionId: 'seed', tool: 'categories.create', resolvedArgs: { kind: 'category-create', amountCents: 0, description: 'Viagem', date: '', categoryName: 'Viagem' },
      missingFields: ['kind', 'parentId'], question: 'q', ttlMs: 60000, nowMs: T0,
    });
    store.getOrCreate(candidate);

    let resolveCatalog!: (v: any) => void;
    const catalogPromise = new Promise<any>((res) => { resolveCatalog = res; });
    let callCount = 0;
    const listCategories = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return catalogPromise;
      return Promise.resolve([{ id: '1', name: 'Alimentação', kind: 'expense', status: 'active', scopeId: ws }]);
    });
    const proposeCalls: any[] = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (String(path).includes('/propose')) proposeCalls.push([method, path]);
      throw new Error(method + ' ' + path);
    });
    const api = new MutationApiClient({ request });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: ws }, listAccounts: async () => [], listCategories } as any,
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });

    const pA = orchestrator.runTurn(normalizeRestTurn({ text: 'em Alimentação', intentionId: 'a' }, id));
    await new Promise((r) => setTimeout(r, 50));
    await orchestrator.runTurn(normalizeRestTurn({ text: 'de receita', intentionId: 'b' }, id));
    resolveCatalog([{ id: '1', name: 'Alimentação', kind: 'expense', status: 'active', scopeId: ws }]);
    await pA;
    await orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId: 'c' }, id));

    const ctx = { workspaceId: ws, actorId: id.actorId, deviceId: id.deviceId ?? null };
    const finals = store.listActive(ctx, T0 + 1000);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.resolvedArgs.categoryKind).toBe('income');
    expect(finals[0]!.resolvedArgs.parentCategoryId).toBeUndefined();
    expect(finals[0]!.missingFields).toContain('parentId');
    expect(proposeCalls).toHaveLength(0);
  });

  it.each([
    ['status', { status: 'inactive' }],
    ['parentId', { parentId: 'child-x' }],
    ['scopeId', { scopeId: 'foreign' }],
  ])('late-kind revalidation invalidates parent when %s changes', async (_label, patch) => {
    const ws = 'w2';
    const id = identity(ws);
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const candidate = buildDraftRecord({
      workspaceId: id.workspaceId, actorId: id.actorId, deviceId: id.deviceId ?? null,
      intentionId: 'seed', tool: 'categories.create', resolvedArgs: { kind: 'category-create', amountCents: 0, description: 'Viagem', date: '', categoryName: 'Viagem', parentCategoryId: '1', parentCategoryName: 'Alimentação' },
      missingFields: ['kind'], question: 'q', ttlMs: 60000, nowMs: T0,
    });
    store.getOrCreate(candidate);

    const baseParent = { id: '1', name: 'Alimentação', kind: 'expense', status: 'active', scopeId: ws };
    const badParent = { ...baseParent, ...patch };
    const listCategories = vi.fn().mockResolvedValue([badParent]);
    const proposeCalls: any[] = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (String(path).includes('/propose')) proposeCalls.push([method, path]);
      throw new Error(method + ' ' + path);
    });
    const api = new MutationApiClient({ request });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: ws }, listAccounts: async () => [], listCategories } as any,
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });

    await orchestrator.runTurn(normalizeRestTurn({ text: 'de receita', intentionId: 'b' }, id));

    const ctx = { workspaceId: ws, actorId: id.actorId, deviceId: id.deviceId ?? null };
    const finals = store.listActive(ctx, T0 + 1000);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.resolvedArgs.categoryKind).toBe('income');
    expect(finals[0]!.resolvedArgs.parentCategoryId).toBeUndefined();
    expect(finals[0]!.missingFields).toContain('parentId');
    expect(proposeCalls).toHaveLength(0);
  });

  it('late kind mismatch with foreign parent does not leak foreign name', async () => {
    const ws = 'w2';
    const id = identity(ws);
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const proposeCalls: any[] = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(method + ' ' + path);
    });
    const api = new MutationApiClient({ request });
    // seed draft with own parent resolved
    const { buildDraftRecord } = await import('../src/mutations/mutation-draft.js');
    const candidate = buildDraftRecord({
      workspaceId: ws, actorId: id.actorId, deviceId: id.deviceId ?? null,
      intentionId: 'seed', tool: 'categories.create', resolvedArgs: { kind: 'category-create', amountCents: 0, description: 'QA', date: '', categoryName: 'QA', parentQuery: 'Alimentação', parentCategoryId: 'own-parent', parentCategoryName: 'Alimentação' },
      missingFields: ['kind'], question: 'q', ttlMs: 60000, nowMs: T0,
    });
    store.getOrCreate(candidate);
    let resolveCatalog: (v: any) => void;
    const catalogPromise = new Promise((res) => { resolveCatalog = res; });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: ws }, listAccounts: async () => [], listCategories: async () => catalogPromise as any } as any,
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });
    const ctx = { workspaceId: ws, actorId: id.actorId, deviceId: id.deviceId ?? null };
    const p = orchestrator.runTurn(normalizeRestTurn({ text: 'de receita', intentionId: 'a' }, id));
    // foreign parent in late catalog
    resolveCatalog!([{ id: 'own-parent', householdId: 'foreign', name: 'Segredo Estrangeiro', kind: 'expense', status: 'active' }]);
    const r = await p;
    console.log('LEAK RESULT:', r.response?.text);
    const finals = store.listActive(ctx, T0 + 1000);
    console.log('LEAK DRAFT:', JSON.stringify(finals));
    expect(r.response?.text ?? '').not.toMatch(/Segredo Estrangeiro/i);
    expect(finals[0]!.missingFields).toContain('parentId');
    expect(proposeCalls).toHaveLength(0);
  }, 20000);
});
