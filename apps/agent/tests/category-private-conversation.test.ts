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
const audience = (conv: string) => ({ visibility: 'private' as const, ownerActorId: identity.actorId, conversationId: conv });
const harness = () => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql);
  const proposeCalls: any[] = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = options?.body ?? {};
      proposeCalls.push({ tool: body.tool, normalizedArgs: body.normalizedArgs });
      return { id: 'op1', existing: false, summary: 'Categoria Terapia', operation: { id: 'op1', expiresAt: new Date(T0 + 10*60000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(method+' '+path);
  });
  const api = new MutationApiClient({ request });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => [{ id: '1', name: 'Alimentação', kind: 'expense' }] },
    draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
  });
  return { store, proposeCalls, orchestrator };
};
describe('category private conversation isolation', () => {
  it('collective followup does not leak private draft name', async () => {
    const h = harness();
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Terapia', intentionId: 'a' }, identity, { audience: audience('convA') }));
    const before = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null, conversationId: 'convA' }, T0);
    const revBefore = before[0]?.revision;
    // collective followup
    const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity));
    const after = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null, conversationId: 'convA' }, T0);
    expect(r.response?.text ?? '').not.toContain('Terapia');
    expect(h.proposeCalls).toHaveLength(0);
    expect(after[0]?.revision).toBe(revBefore);
    // draft still missing kind
    expect(after[0]?.missingFields).toContain('kind');
  });
  it('same private conversation allows kind fill', async () => {
    const h = harness();
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Terapia', intentionId: 'a' }, identity, { audience: audience('convA') }));
    const r = await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity, { audience: audience('convA') }));
    expect(r.response?.text ?? '').not.toMatch(/despesa ou de receita/i);
    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null, conversationId: 'convA' };
    const finals = h.store.listActive(ctx, T0 + 1000);
    expect(finals[0]?.resolvedArgs.categoryKind).toBe('expense');
  });
  it('different private conversation blocked', async () => {
    const h = harness();
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Terapia', intentionId: 'a' }, identity, { audience: audience('convA') }));
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'de despesa', intentionId: 'b' }, identity, { audience: audience('convB') }));
    expect(h.proposeCalls).toHaveLength(0);
    const ctxA = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null, conversationId: 'convA' };
    const finals = h.store.listActive(ctxA, T0 + 1000);
    expect(finals[0]?.resolvedArgs.categoryKind).toBeUndefined();
  });
});
