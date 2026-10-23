import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';

const CATEGORY_ID = '62900000-0000-4000-8000-000000000001';
const identity: AuthenticatedIdentity = {
  actorId: 'actor-rename-literal',
  workspaceId: 'workspace-rename-literal',
  role: 'member',
  deviceId: 'device-rename-literal',
};
const now = Date.parse('2026-10-22T12:00:00Z');
const category = { id: CATEGORY_ID, name: 'QA Viagem Jade', kind: 'expense', status: 'active', householdId: identity.workspaceId };

const harness = () => {
  const db = new DatabaseSync(':memory:');
  const sql = {
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
  const store = new SqlMutationDraftStore(sql as never);
  const proposals: Array<{ tool: string; normalizedArgs: unknown }> = [];
  const request = vi.fn(async (method: string, path: string, options: never) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as unknown as { body: { tool: string; normalizedArgs: unknown } }).body;
      proposals.push(body);
      const id = `op-${proposals.length}`;
      return { id, existing: false, summary: 'renomear categoria', operation: { id, expiresAt: new Date(now + 600_000).toISOString() } };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request: request as never }),
    entityReader: { listAccounts: async () => [], listCategories: async () => [category] },
    draftStore: store,
    draftNow: () => now,
    responseProvider: vi.fn(async () => 'model text'),
    evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
    events: () => undefined,
  });
  return { orchestrator, proposals, store };
};

const run = (orchestrator: ConversationOrchestrator, text: string, intentionId: string) =>
  orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));

describe('category rename literal decision-like names', () => {
  it('proposes a full explicit rename whose exact new-name span contains cancel words', async () => {
    const h = harness();
    const result = await run(h.orchestrator, 'renomeie a categoria QA Viagem Jade para QA Viagem Cancelada', 'fresh-cancelada');
    expect(result.mutation?.status).toBe('proposed');
    expect(h.proposals).toHaveLength(1);
    expect(h.proposals[0]).toMatchObject({
      tool: 'categories.update',
      normalizedArgs: { categoryId: CATEGORY_ID, name: 'QA Viagem Cancelada', expectedName: 'QA Viagem Jade' },
    });
  });

  it('accepts Cancelada as the contextual missing-name slot and proposes, without overwriting the target', async () => {
    const h = harness();
    const first = await run(h.orchestrator, 'renomeie a categoria QA Viagem Jade', 'fragment-cancelada-1');
    expect(first.mutation).toBeUndefined();
    expect(h.proposals).toHaveLength(0);
    const second = await run(h.orchestrator, 'para QA Viagem Cancelada', 'fragment-cancelada-2');
    expect(second.mutation?.status).toBe('proposed');
    expect(h.proposals[0]?.normalizedArgs).toEqual({
      categoryId: CATEGORY_ID, name: 'QA Viagem Cancelada', expectedName: 'QA Viagem Jade',
    });
  });

  it('keeps a bare Cancelada ambiguous while the rename draft is missing its name', async () => {
    const h = harness();
    await run(h.orchestrator, 'renomeie a categoria QA Viagem Jade', 'bare-slot-1');
    const result = await run(h.orchestrator, 'Cancelada', 'bare-slot-2');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/novo nome/i);
    expect(h.proposals).toHaveLength(0);
    const active = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, now);
    expect(active).toHaveLength(1);
    expect(active[0]?.resolvedArgs.categoryName).toBe('');
  });

  it.each(['Cancelada', 'Confirmada', 'Autorizada', 'Cancele o rascunho'])('preserves a quoted or unquoted literal name "%s" in a fresh rename', async (name) => {
    const h = harness();
    const result = await run(h.orchestrator, `renomeie a categoria QA Viagem Jade para "QA Viagem ${name}"`, `quoted-${name}`);
    expect(result.mutation?.status).toBe('proposed');
    expect(h.proposals[0]?.normalizedArgs).toMatchObject({
      categoryId: CATEGORY_ID, name: `QA Viagem ${name}`, expectedName: 'QA Viagem Jade',
    });
  });

  it.each(['cancela', 'cancele', 'cancelar', 'não renomeie'])('still treats standalone "%s" as a cancel/negation, not a name', async (text) => {
    const h = harness();
    const opened = await run(h.orchestrator, 'renomeie a categoria QA Viagem Jade', `cancel-${text}`);
    expect(opened.mutation).toBeUndefined();
    const result = await run(h.orchestrator, text, `cancel-${text}-decision`);
    expect(result.mutation).toBeUndefined();
    expect(h.proposals).toHaveLength(0);
    const active = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, now);
    expect(active).toHaveLength(0);
  });

  it('does not turn a bare Cancelada into a proposal or draft name when no rename draft exists', async () => {
    const h = harness();
    const result = await run(h.orchestrator, 'Cancelada', 'bare-cancelada');
    expect(result.mutation).toBeUndefined();
    expect(h.proposals).toHaveLength(0);
    expect(h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, now)).toHaveLength(0);
  });
});
