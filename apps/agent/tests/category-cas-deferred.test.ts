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
const identity: AuthenticatedIdentity = { actorId: 'a2', workspaceId: 'w2', role: 'member', deviceId: 'd2' };
const T0 = Date.parse('2026-10-21T12:00:00Z');
describe('category CAS deferred contribution', () => {
  it('turn A parent resolves after turn B fills kind; both preserved', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    // seed draft
    const candidate = buildDraftRecord({
      workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null,
      intentionId: 'seed', tool: 'categories.create', resolvedArgs: { kind: 'category-create', amountCents: 0, description: 'Viagem', date: '', categoryName: 'Viagem' },
      missingFields: ['kind', 'parentId'], question: 'q', ttlMs: 60000, nowMs: T0,
    });
    store.getOrCreate(candidate);
    let resolveCatalog: (v: any) => void;
    const catalogPromise = new Promise((res) => { resolveCatalog = res; });
    const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(method+' '+path);
    });
    const api = new MutationApiClient({ request });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => catalogPromise as any },
      draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
    });
    // Turn A: parent query, will await catalog
    const pA = orchestrator.runTurn(normalizeRestTurn({ text: 'em Alimentação', intentionId: 'a' }, identity));
    // Turn B: fills kind while A paused
    await orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
    // release catalog
    resolveCatalog!([{ id: '1', name: 'Alimentação', kind: 'expense', status: 'active', scopeId: identity.workspaceId }]);
    const result = await pA;
    expect(result.response?.text ?? '').not.toMatch(/despesa ou de receita/i);
    expect(result.response?.text ?? '').not.toMatch(/Qual o nome/i);
    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    const finals = store.listActive(ctx, T0 + 1000);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.resolvedArgs.categoryKind).toBe('expense');
    expect(finals[0]!.resolvedArgs.parentCategoryId).toBe('1');
    expect(finals[0]!.resolvedArgs.categoryName).toBe('Viagem');
    expect(finals[0]!.missingFields).not.toContain('kind');
    expect(finals[0]!.missingFields).not.toContain('parentId');
  });
});