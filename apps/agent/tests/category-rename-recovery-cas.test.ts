import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import {
  initializeMutationDraftSchema,
  SqlMutationDraftStore,
} from '../src/mutations/mutation-draft.js';
import { buildDraftRecord } from '../src/mutations/mutation-draft.js';

const CAT_VIAGEM = '33333333-3333-4333-8333-333333333333';
const CAT_MERCADO = '55555555-5555-4555-8555-555555555555';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-cas',
  workspaceId: 'workspace-cas',
  role: 'member',
  deviceId: 'device-cas',
};

const T0 = Date.parse('2026-10-22T12:00:00Z');

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
  transactionSync?: <T>(fn: () => T) => T;
};

const createSql = (): { sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
    transactionSync: <T>(fn: () => T) => fn(),
  };
  initializeMutationDraftSchema(sql as never);
  return { sql };
};

type CategoryRow = { id: string; name: string; kind?: string; status?: string };

const ctxOf = (conversationId?: string) => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
  ...(conversationId ? { conversationId } : {}),
});

describe('recovery-cas (1) different intent does not claim A proposal', () => {
  it('B (Mercado->Feira) is not answered with A (Viagem->Esmeralda) proposal', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql as never);
    const catalog: CategoryRow[] = [
      { id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active' },
      { id: CAT_MERCADO, name: 'QA Viagem Mercado', kind: 'expense', status: 'active' },
    ];
    const committed = new Map<string, { id: string; payload: string }>();
    let attempt = 0;
    const request = vi.fn().mockImplementation(async (method: string, path: string, optionsArg: never) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = (optionsArg as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
        const key = (optionsArg as unknown as { idempotencyKey?: string }).idempotencyKey ?? '';
        const payload = JSON.stringify(body?.normalizedArgs ?? {});
        attempt += 1;
        if (attempt <= 2) {
          committed.set(key, { id: 'op-cat-committed', payload });
          throw new Error('transport lost after commit');
        }
        const saved = committed.get(key);
        if (!saved || saved.payload !== payload) throw new Error('keyed replay divergiu');
        return {
          id: saved.id,
          existing: true,
          summary: 'renomear a categoria',
          operation: { id: saved.id, expiresAt: new Date(T0 + 600_000).toISOString() },
        };
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
        return { firstSeenAt: new Date(T0).toISOString(), fresh: true, operationId: null };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const origImpl = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, path: string, optionsArg: never) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = (optionsArg as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
        const key = (optionsArg as unknown as { idempotencyKey?: string }).idempotencyKey ?? '';
        const args = body?.normalizedArgs as { categoryId?: string };
        if (args?.categoryId === CAT_MERCADO && !committed.has(key)) {
          const opId = 'op-cat-b';
          committed.set(key, { id: opId, payload: JSON.stringify(body?.normalizedArgs) });
          return {
            id: opId,
            existing: false,
            summary: 'renomear a categoria',
            operation: { id: opId, expiresAt: new Date(T0 + 600_000).toISOString() },
          };
        }
      }
      return origImpl(method, path, optionsArg);
    });

    const api = new MutationApiClient({ request: request as never });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { listAccounts: async () => [], listCategories: async () => catalog },
      draftStore: store,
      draftNow: () => T0,
      responseProvider: vi.fn(async () => 'invented by model'),
      evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
      events: () => undefined,
    });

    await orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cas-a' }, identity),
    );
    const aDraft = store.findByIntention(ctxOf(), 'cas-a');
    expect(aDraft?.status).toBe('proposing');

    const bResult = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Mercado para QA Viagem Feira', intentionId: 'cas-b' }, identity),
    );

    expect(bResult.mutation?.operationId).not.toBe('op-cat-committed');
    const aAfter = store.findByIntention(ctxOf(), 'cas-a');
    expect(aAfter?.status).toBe('consumed');
    expect(aAfter?.proposalId).toBe('op-cat-committed');
  });

  it('B new intent with SAME text as A gets own proposal (not A by name)', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql as never);
    const catalog: CategoryRow[] = [
      { id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active' },
    ];
    const committed = new Map<string, { id: string; payload: string }>();
    let attempt = 0;
    const request = vi.fn().mockImplementation(async (method: string, path: string, optionsArg: never) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = (optionsArg as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
        const key = (optionsArg as unknown as { idempotencyKey?: string }).idempotencyKey ?? '';
        const payload = JSON.stringify(body?.normalizedArgs ?? {});
        attempt += 1;
        if (attempt <= 2) {
          committed.set(key, { id: 'op-cat-a', payload });
          throw new Error('transport lost after commit');
        }
        const saved = committed.get(key);
        if (saved && saved.payload === payload) {
          return {
            id: saved.id,
            existing: true,
            summary: 'renomear a categoria',
            operation: { id: saved.id, expiresAt: new Date(T0 + 600_000).toISOString() },
          };
        }
        // new key (B) commits fresh
        const opId = 'op-cat-b';
        committed.set(key, { id: opId, payload });
        return {
          id: opId,
          existing: false,
          summary: 'renomear a categoria',
          operation: { id: opId, expiresAt: new Date(T0 + 600_000).toISOString() },
        };
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
        return { firstSeenAt: new Date(T0).toISOString(), fresh: true, operationId: null };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const api = new MutationApiClient({ request: request as never });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api,
      entityReader: { listAccounts: async () => [], listCategories: async () => catalog },
      draftStore: store,
      draftNow: () => T0,
      responseProvider: vi.fn(async () => 'invented by model'),
      evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
      events: () => undefined,
    });

    // A: proposes Viagem -> Esmeralda, transport lost -> proposing
    await orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cas-a2' }, identity),
    );
    const aDraft = store.findByIntention(ctxOf(), 'cas-a2');
    expect(aDraft?.status).toBe('proposing');

    // B: new intent, SAME text -> should get own proposal, not A's
    const bResult = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cas-b2' }, identity),
    );
    expect(bResult.mutation?.operationId).toBe('op-cat-b');
    expect(bResult.mutation?.operationId).not.toBe('op-cat-a');

    // A's binding unchanged
    const aAfter = store.findByIntention(ctxOf(), 'cas-a2');
    expect(aAfter?.status).toBe('consumed');
    expect(aAfter?.proposalId).toBe('op-cat-a');

    // Re-deliver B (same intention) returns same id, no extra propose
    const proposeCountBefore = (request.mock.calls.filter((c: unknown[]) => c[0] === 'POST' && c[1] === '/pending-operations/v2/propose').length);
    const replay = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cas-b2' }, identity),
    );
    expect(replay.mutation?.operationId).toBe('op-cat-b');
    const proposeCountAfter = (request.mock.calls.filter((c: unknown[]) => c[0] === 'POST' && c[1] === '/pending-operations/v2/propose').length);
    expect(proposeCountAfter).toBe(proposeCountBefore);
  });
});

describe('recovery-cas (2) stale target guard', () => {
  it('A (Mercado) deferred does not overwrite B (Viagem) active target', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql as never);
    const catalog: CategoryRow[] = [
      { id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active' },
      { id: CAT_MERCADO, name: 'QA Viagem Mercado', kind: 'expense', status: 'active' },
    ];

    let readCount = 0;
    let releaseFirst!: () => void;
    const firstReadGate = new Promise<void>((res) => { releaseFirst = res; });

    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({ request: vi.fn() as never }),
      entityReader: {
        listAccounts: async () => [],
        listCategories: async () => {
          readCount += 1;
          if (readCount === 1) await firstReadGate;
          return catalog;
        },
      },
      draftStore: store,
      draftNow: () => T0,
      responseProvider: vi.fn(async () => 'invented by model'),
      evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
      events: () => undefined,
    });

    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'cas-stale',
      tool: 'categories.update',
      resolvedArgs: {
        kind: 'category-rename',
        amountCents: 0,
        description: '',
        date: '',
        categoryName: '',
        expectedName: '',
      },
      missingFields: ['categoryId', 'name'],
      question: 'Qual categoria devo renomear?',
      ttlMs: 600_000,
      nowMs: T0,
    });
    store.getOrCreate(draft);

    const aPromise = orchestrator.runTurn(
      normalizeRestTurn({ text: 'Mercado', intentionId: 'cas-stale-a' }, identity),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    store.update(draft.draftId, {
      resolvedArgs: {
        kind: 'category-rename',
        amountCents: 0,
        description: '',
        date: '',
        categoryId: CAT_VIAGEM,
        expectedName: 'QA Viagem Safira',
        categoryName: '',
      },
      missingFields: ['name'],
      updatedAt: new Date(T0 + 1000).toISOString(),
      lastIntentionId: 'cas-stale-b',
    });

    releaseFirst();
    const aResult = await aPromise;

    const after = store.get(draft.draftId);
    expect(after?.resolvedArgs.categoryId).toBe(CAT_VIAGEM);
    expect(after?.resolvedArgs.expectedName).toBe('QA Viagem Safira');
    const text =
      (aResult.response as { text?: string } | undefined)?.text ??
      (aResult.clarification as { text?: string } | undefined)?.text ??
      '';
    expect(text).not.toContain('Mercado');
  });
});
