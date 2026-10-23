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
const harness = (nowMs: number, parentName = 'Alimentação') => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql);
  const proposeCalls: any[] = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = options?.body ?? {};
      proposeCalls.push({ tool: body.tool, normalizedArgs: body.normalizedArgs });
      return { id: 'op1', existing: false, summary: 'Categoria Viagem', operation: { id: 'op1', expiresAt: new Date(nowMs + 10*60000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(method+' '+path);
  });
  const api = new MutationApiClient({ request });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => [{ id: '1', name: parentName, kind: 'expense', status: 'active', scopeId: identity.workspaceId }] },
    draftStore: store, draftNow: () => nowMs, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
  });
  return { store, proposeCalls, orchestrator };
};
describe('group1 confirm tokens', () => {
  for (const token of ['sim', 'confirmo', 'confirmado', 'confirma', 'confirmar', 'autorizo', 'pode criar', 'sim confirmo', 'confirmo!', 'autorizo.']) {
    it(`token ${token} proposes exact`, async () => {
      const h = harness(T0);
      await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem em Alimentação', intentionId: 'a' }, identity));
      // slot kind
      await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
      const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: token, intentionId: 'c' }, identity));
      expect(r.mutation?.status).toBe('proposed');
      expect(h.proposeCalls).toHaveLength(1);
      expect(h.proposeCalls[0].tool).toBe('categories.create');
      expect(h.proposeCalls[0].normalizedArgs).toMatchObject({ name: 'Viagem', kind: 'expense', parentId: '1' });
    });
  }
});