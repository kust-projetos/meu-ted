/**
 * Permanent tests: subcategory creation flow (QA Mercado Azul).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';
import { normalizeEntities } from '../src/mutations/entity-resolver.js';
import { parseCategorySlotContribution } from '../src/mutations/category-creation.js';

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

const twoRoots = () => ({
  items: [
    { id: 'cat-alim', householdId: 'w2', name: 'Alimentação', kind: 'expense', status: 'active' },
    { id: 'cat-transp', householdId: 'w2', name: 'Transporte', kind: 'expense', status: 'active' },
  ],
  total: 2,
});

const harness = (itemsFactory: () => { items: any[]; total: number }) => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql);
  const proposeCalls: any[] = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = options?.body ?? {};
      proposeCalls.push({ tool: body.tool, normalizedArgs: body.normalizedArgs });
      return { id: 'op1', existing: false, summary: 'Categoria QA Mercado Azul', operation: { id: 'op1', expiresAt: new Date(T0 + 10 * 60000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(method + ' ' + path);
  });
  const api = new MutationApiClient({ request });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { scope: { workspaceId: identity.workspaceId }, listAccounts: async () => [], listCategories: async () => itemsFactory() } as any,
    draftStore: store, draftNow: () => T0, responseProvider: async () => 'model', evidenceProvider: (async () => { throw new Error('no'); }) as never, events: () => undefined,
  });
  const run = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  const drafts = () => store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0);
  return { store, proposeCalls, orchestrator, run, drafts };
};

describe('subcategory QA Mercado Azul - missing kind clarify then proposal', () => {
  it('fresh without de despesa asks kind and preserves name/parent', async () => {
    const h = harness(twoRoots);
    const r = await h.run('crie subcategoria QA Mercado Azul da categoria Alimentação', 'a');
    expect(r.response?.text).toMatch(/despesa ou de receita/i);
    const d = h.drafts();
    expect(d).toHaveLength(1);
    expect(d[0].resolvedArgs.categoryName).toBe('QA Mercado Azul');
    expect(d[0].resolvedArgs.parentCategoryId).toBe('cat-alim');
    expect(d[0].resolvedArgs.parentCategoryName).toBe('Alimentação');
    expect(h.proposeCalls).toHaveLength(0);
  });

  it('de despesa then sim proposes strict name/kind/parentId', async () => {
    const h = harness(twoRoots);
    await h.run('crie subcategoria QA Mercado Azul da categoria Alimentação', 'a');
    const r2 = await h.run('de despesa', 'b');
    expect(r2.response?.text).toMatch(/Confirme/i);
    expect(h.proposeCalls).toHaveLength(0);
    const r3 = await h.run('sim', 'c');
    expect(r3.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0].tool).toBe('categories.create');
    expect(h.proposeCalls[0].normalizedArgs).toEqual({ name: 'QA Mercado Azul', kind: 'expense', parentId: 'cat-alim' });
  });

  it('pai clause variant proposes strict immediately', async () => {
    const h = harness(twoRoots);
    const r = await h.run('crie subcategoria QA Mercado Azul de despesa pai Alimentação', 'a');
    expect(r.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0].normalizedArgs).toEqual({ name: 'QA Mercado Azul', kind: 'expense', parentId: 'cat-alim' });
  });

  it('de despesa before parent clause variant proposes strict', async () => {
    const h = harness(twoRoots);
    const r = await h.run('crie subcategoria QA Mercado Azul de despesa da categoria Alimentação', 'a');
    expect(r.mutation?.status).toBe('proposed');
    expect(h.proposeCalls[0].normalizedArgs).toEqual({ name: 'QA Mercado Azul', kind: 'expense', parentId: 'cat-alim' });
  });
});

describe('subcategory QA Mercado Azul - mixed kind rejection', () => {
  it('fresh mixed kind (receita) with expense parent clarifies mismatch, no propose', async () => {
    const h = harness(twoRoots);
    const r = await h.run('crie subcategoria QA Mercado Azul de receita da categoria Alimentação', 'a');
    expect(r.response?.text).toMatch(/encontrei|diferente/i);
    expect(h.proposeCalls).toHaveLength(0);
  });
});

describe('subcategory QA Mercado Azul - scope and ambiguity safety', () => {
  it('child inactive foreign does not resolve as parent', async () => {
    const foreignChildCatalog = () => ({
      items: [
        { id: 'cat-alim', householdId: 'w2', name: 'Alimentação', kind: 'expense', status: 'active' },
        { id: 'child-foreign', householdId: 'foreign', name: 'Mercado', kind: 'expense', status: 'inactive', parentId: 'cat-alim' },
      ],
      total: 2,
    });
    const h = harness(foreignChildCatalog);
    const r = await h.run('crie subcategoria QA Mercado Azul de despesa em Mercado', 'a');
    expect(r.response?.text).toMatch(/Não encontrei/i);
    expect(h.proposeCalls).toHaveLength(0);
    const r2 = await h.run('sim', 'b');
    expect(r2.mutation?.status).not.toBe('proposed');
    expect(h.proposeCalls).toHaveLength(0);
  });

  it('homonym roots produce ambiguity clarification, no propose', async () => {
    const homonymCatalog = () => ({
      items: [
        { id: 'cat-alim-1', householdId: 'w2', name: 'Alimentação', kind: 'expense', status: 'active' },
        { id: 'cat-alim-2', householdId: 'w2', name: 'Alimentação', kind: 'expense', status: 'active' },
      ],
      total: 2,
    });
    const h = harness(homonymCatalog);
    const r = await h.run('crie subcategoria QA Mercado Azul de despesa em Alimentação', 'a');
    expect(r.response?.text).toMatch(/mais de uma categoria parecida/i);
    expect(h.proposeCalls).toHaveLength(0);
  });
});

describe('entity summary preserves parentId', () => {
  it('normalizeEntities keeps parentId and scopeId', () => {
    const out = normalizeEntities({ items: [{ id: 'c1', name: 'Sub', parentId: 'p1', householdId: 'w2' }], total: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('c1');
    expect(out[0].parentId).toBe('p1');
    expect(out[0].scopeId).toBe('w2');
  });
});

describe('slot safety: foreign command and confirmed tokens', () => {
  it('parseCategorySlotContribution returns empty for confirmation token', () => {
    expect(parseCategorySlotContribution('sim')).toEqual({});
    expect(parseCategorySlotContribution('confirmo')).toEqual({});
  });

  it('foreign command does not overwrite child name', async () => {
    const h = harness(twoRoots);
    await h.run('crie subcategoria QA Mercado Azul da categoria Alimentação', 'a');
    await h.run('obrigado', 'b');
    const d = h.drafts();
    expect(d[0].resolvedArgs.categoryName).toBe('QA Mercado Azul');
    expect(h.proposeCalls).toHaveLength(0);
  });
});
