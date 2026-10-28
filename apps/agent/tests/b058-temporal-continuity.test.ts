/**
 * B058 temporal continuity — main-compatible (no F1 journey harness).
 *
 * Adapted to run on main without `tests/helpers/ted-f1-journey-harness.js`:
 * drives `ConversationOrchestrator` directly with `InMemoryMutationDraftStore`
 * (same lightweight pattern as `issue-255-partial-draft.test.ts`).
 *
 * Preserved real assertions: draft persistence (amount/date/description +
 * missing `date`), redelivery convergence (same intentionId, no second draft,
 * no propose), pure-read anti-hijack (`Quanto gastei em 2020?` keeps the
 * active draft), and date continuity (`15 de março de 2020` fills the SAME
 * draftId). No F1 import, no production change.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore, SqlMutationDraftStore, initializeMutationDraftSchema } from '../src/mutations/mutation-draft.js';
import type { EntityReader } from '../src/mutations/entity-resolver.js';
import { parseFinancialMutation } from '../src/mutations/financial-parser.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-b058',
  workspaceId: 'workspace-b058',
  role: 'member',
  deviceId: 'device-b058',
};

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const CATEGORY_MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

const reader = (): EntityReader => ({
  listAccounts: async () => [ACCOUNT_NUBANK],
  listCategories: async () => [CATEGORY_MERCADO],
});

const mockClient = () => {
  const request = vi.fn().mockImplementation(async (method: string, path: string, _options?: unknown) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'op-b058-1' };
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api: new MutationApiClient({ request }), request };
};

const harness = (nowMs: number) => {
  const store = new InMemoryMutationDraftStore();
  const { api, request } = mockClient();
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
    draftNow: () => nowMs,
    responseProvider,
    evidenceProvider,
    events: () => undefined,
  });
  return { store, request, responseProvider, orchestrator };
};

const draftCtx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };

const openDraftDatabase = (path: string) => {
  const db = new DatabaseSync(path);
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  initializeMutationDraftSchema(sql);
  return { db, store: new SqlMutationDraftStore(sql) };
};

describe('b058 SQLite persistence', () => {
  it.each([
    ['Gastei R$ 20 com mercado em 15 de março de 2020', 'com mercado'],
    ['Gastei R$ 20 em 15 de março de 2020', 'despesa'],
  ])('stores the description without a date: %s', async (text, description) => {
    const directory = mkdtempSync(join(tmpdir(), 'b058-description-'));
    const { db, store } = openDraftDatabase(join(directory, 'draft.sqlite'));
    const now = Date.parse('2026-10-24T12:00:00Z');
    const { api, request } = mockClient();
    try {
      const orchestrator = new ConversationOrchestrator({ mutationApiClient: api, entityReader: { listAccounts: async () => [], listCategories: async () => [CATEGORY_MERCADO] }, draftStore: store, draftNow: () => now });
      await orchestrator.runTurn(normalizeRestTurn({ text, intentionId: 'description-test' }, identity));
      const drafts = store.listActive(draftCtx, now + 1000);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.resolvedArgs).toMatchObject({ amountCents: 2000, date: '2020-03-15', description });
      expect(drafts[0]!.missingFields).toContain('accountId');
      expect(request).not.toHaveBeenCalled();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers and completes the same draft after two SQLite reopenings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'b058-reopen-'));
    const path = join(directory, 'draft.sqlite');
    const now = Date.parse('2026-10-24T12:00:00Z');
    const { api, request } = mockClient();
    let connection = openDraftDatabase(path);
    const makeOrchestrator = (store: SqlMutationDraftStore) => new ConversationOrchestrator({ mutationApiClient: api, entityReader: reader(), draftStore: store, draftNow: () => now });
    const turn = (orchestrator: ConversationOrchestrator, text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId, conversationId: 'conversation-b058' }, identity));
    try {
      await turn(makeOrchestrator(connection.store), 'Gastei R$ 20 em 2020', 'persist-first');
      const initial = connection.store.listActive(draftCtx, now + 1000);
      expect(initial).toHaveLength(1);
      expect(initial[0]!.status).toBe('active');
      expect(initial[0]!.resolvedArgs).toMatchObject({ amountCents: 2000, date: '', description: 'despesa' });
      expect(initial[0]!.missingFields).toContain('date');
      expect(request).not.toHaveBeenCalled();
      const { draftId, revision } = initial[0]!;
      connection.db.close();
      connection = openDraftDatabase(path);
      const restored = connection.store.listActive(draftCtx, now + 1000);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ draftId, revision, workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId, resolvedArgs: { amountCents: 2000, date: '', description: 'despesa' } });
      const second = makeOrchestrator(connection.store);
      await turn(second, '15 de março de 2020', 'persist-second');
      await turn(second, '15 de março de 2020', 'persist-second');
      const dated = connection.store.listActive(draftCtx, now + 1000);
      expect(dated).toHaveLength(1);
      expect(dated[0]).toMatchObject({ draftId, resolvedArgs: { amountCents: 2000, date: '2020-03-15', description: 'despesa' } });
      expect(dated[0]!.missingFields).not.toContain('date');
      expect(request).not.toHaveBeenCalled();
      connection.db.close();
      connection = openDraftDatabase(path);
      expect(connection.store.listActive(draftCtx, now + 1000)).toHaveLength(1);
      const third = makeOrchestrator(connection.store);
      await turn(third, 'Nubank categoria Mercado', 'persist-third');
      const proposals = () => request.mock.calls.filter((call) => call[0] === 'POST' && call[1] === '/pending-operations/v2/propose');
      expect(proposals()).toHaveLength(1);
      const options = proposals()[0]![2] as { idempotencyKey?: string; body?: unknown };
      expect(options.idempotencyKey).toBeTruthy();
      expect(options.body).toMatchObject({ tool: 'transactions.expense.create', normalizedArgs: { amountCents: 2000, date: '2020-03-15', description: 'despesa', accountId: ACCOUNT_NUBANK.id, categoryId: CATEGORY_MERCADO.id } });
      await turn(third, 'Nubank categoria Mercado', 'persist-third');
      expect(proposals()).toHaveLength(1);
      expect((proposals()[0]![2] as { idempotencyKey?: string }).idempotencyKey).toBe(options.idempotencyKey);
      expect(request.mock.calls.every((call) => call[1] === '/pending-operations/v2/propose')).toBe(true);
    } finally {
      connection.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});

describe('b058 temporal continuity (main-compatible, no F1 harness)', () => {
  it('asks for the incomplete date before proposing an expense and continues the draft', async () => {
    const nowMs = Date.parse('2026-10-24T12:00:00.000Z');
    const h = harness(nowMs);
    const listAt = (atMs: number) => h.store.listActive(draftCtx, atMs);

    const isolated = routeIntent('Gastei R$ 20 em 2020');
    expect(isolated.requestedOperations.map((o) => o.name)).toContain('transactions.expense.create');

    const first = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 20 em 2020', intentionId: 'b058-first' }, identity),
    );
    expect(first.plan.requestedOperations).toEqual([]);
    expect(first.response?.text).toMatch(/data|dia|m[eê]s/i);
    expect(first.clarification?.missingFields ?? first.plan.missingFields).toContain('date');
    expect(first.mutation).toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.responseProvider).not.toHaveBeenCalled();

    const before = listAt(nowMs + 1_000);
    expect(before).toHaveLength(1);
    expect(before[0]!.status).toBe('active');
    expect(before[0]!.resolvedArgs).toMatchObject({ kind: 'expense', amountCents: 2000, date: '', description: 'despesa' });
    expect(before[0]!.missingFields).toContain('date');

    const replayed = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Gastei R$ 20 em 2020', intentionId: 'b058-first' }, identity),
    );
    expect(replayed.mutation).toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
    const afterReplay = listAt(nowMs + 2_000);
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]!.draftId).toBe(before[0]!.draftId);
    expect(afterReplay[0]!.status).toBe('active');

    const query = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Quanto gastei em 2020?', intentionId: 'b058-query' }, identity),
    );
    expect(query.mutation).toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
    const afterQuery = listAt(nowMs + 3_000);
    expect(afterQuery).toHaveLength(1);
    expect(afterQuery[0]!.draftId).toBe(before[0]!.draftId);
    expect(afterQuery[0]!.status).toBe('active');
    expect(afterQuery[0]!.resolvedArgs).toMatchObject({ amountCents: 2000, date: '' });

    const second = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: '15 de março de 2020', intentionId: 'b058-second' }, identity),
    );
    expect(second.mutation).toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.responseProvider).not.toHaveBeenCalled();
    const after = listAt(nowMs + 4_000);
    expect(after).toHaveLength(1);
    expect(after[0]!.draftId).toBe(before[0]!.draftId);
    expect(after[0]!.resolvedArgs).toMatchObject({ kind: 'expense', amountCents: 2000, date: '2020-03-15', description: 'despesa' });
    expect(after[0]!.missingFields).not.toContain('date');
    expect(second.response?.text).not.toMatch(/data|dia|m[eê]s/i);

    await h.orchestrator.runTurn(normalizeRestTurn({ text: '15 de março de 2020', intentionId: 'b058-second' }, identity));
    const afterSecondReplay = listAt(nowMs + 5_000);
    expect(afterSecondReplay).toHaveLength(1);
    expect(afterSecondReplay[0]!.draftId).toBe(before[0]!.draftId);
    expect(afterSecondReplay[0]!.resolvedArgs).toMatchObject({ amountCents: 2000, date: '2020-03-15' });
    expect(h.request).not.toHaveBeenCalled();

    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'Nubank categoria Mercado', intentionId: 'b058-third' }, identity));
    const proposals = () => h.request.mock.calls.filter((call) => call[0] === 'POST' && call[1] === '/pending-operations/v2/propose');
    expect(proposals()).toHaveLength(1);
    const options = proposals()[0]![2] as { idempotencyKey?: string; body?: { tool?: string; normalizedArgs?: unknown } };
    expect(options.body).toMatchObject({ tool: 'transactions.expense.create', normalizedArgs: { amountCents: 2000, date: '2020-03-15', description: 'despesa', accountId: ACCOUNT_NUBANK.id, categoryId: CATEGORY_MERCADO.id } });
    expect(options.idempotencyKey).toBeTruthy();
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'Nubank categoria Mercado', intentionId: 'b058-third' }, identity));
    expect(proposals()).toHaveLength(1);
    expect((proposals()[0]![2] as { idempotencyKey?: string }).idempotencyKey).toBe(options.idempotencyKey);
  });
});

describe('b058 monetary and calendar distinctions', () => {
  it('separates written dates from expense descriptions', () => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    expect(parseFinancialMutation('Gastei R$ 20 com mercado em 15 de março de 2020', { now })).toMatchObject({ amountCents: 2000, date: '2020-03-15', description: 'com mercado' });
    expect(parseFinancialMutation('Gastei R$ 20 em 15 de março de 2020', { now })).toMatchObject({ amountCents: 2000, date: '2020-03-15', description: 'despesa' });
    expect(parseFinancialMutation('Gastei R$ 20 com modelo 2020 em 15 de março de 2020', { now })).toMatchObject({ description: 'com modelo 2020' });
  });
  it('preserves monetary and calendar distinctions', () => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    expect(parseFinancialMutation('Gastei R$ 2020', { now })).toMatchObject({ amountCents: 202000 });
    expect(parseFinancialMutation('Gastei R$ 20 ontem', { now })).toMatchObject({ amountCents: 2000, date: '2026-10-23' });
    expect(parseFinancialMutation('Gastei R$ 20 em 15/03/2020', { now })).toMatchObject({ amountCents: 2000, date: '2020-03-15' });
    expect(parseFinancialMutation('Gastei R$ 20 em 31/02/2020', { now })).toMatchObject({ amountCents: 2000, date: '' });
    expect(parseFinancialMutation('Gastei R$ 20 em 1800', { now })).toMatchObject({ amountCents: 2000, date: '' });
    expect(parseFinancialMutation('Gastei R$ 20 em 2100', { now })).toMatchObject({ amountCents: 2000, date: '' });
  });
});
