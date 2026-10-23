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

const CAT_MERCADO = '55555555-5555-4555-8555-555555555555';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-s2',
  workspaceId: 'workspace-s2',
  role: 'member',
  deviceId: 'device-s2',
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

type CategoryRow = { id: string; name: string; kind?: string; status?: string; parentId?: string; scopeId?: string };

const harness = (catalog: CategoryRow[]) => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql as never);
  const proposeCalls: Array<{ tool: string; normalizedArgs: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, optionsArg: never) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (optionsArg as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
      proposeCalls.push({ tool: body!.tool, normalizedArgs: body!.normalizedArgs });
      const operationId = `op-s2-${proposeCalls.length}`;
      return { id: operationId, existing: false, summary: 'renomear a categoria', operation: { id: operationId, expiresAt: new Date(T0 + 10 * 60_000).toISOString() } };
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
    entityReader: {
      listAccounts: async () => [],
      listCategories: async () => catalog,
    },
    draftStore: store,
    draftNow: () => T0,
    responseProvider: vi.fn(async () => 'invented by model'),
    evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
    events: () => undefined,
  });
  return { store, orchestrator, proposeCalls };
};

describe('SMALL2 (B) kind filter: income qualifier with only expense catalog', () => {
  it('B1 no resolved id, no proposal, no expense options in clarification', async () => {
    const h = harness([{ id: CAT_MERCADO, name: 'Mercado', kind: 'expense', status: 'active' }]);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie categoria de receita Mercado para Feira', intentionId: 's2-c1' },
        identity,
      ),
    );
    expect(h.proposeCalls).toHaveLength(0);
    expect(result.mutation).toBeUndefined();
    const text =
      (result.response as { text?: string } | undefined)?.text ??
      (result.clarification as { text?: string } | undefined)?.text ??
      '';
    expect(text).not.toContain('• Mercado');
  });
});
