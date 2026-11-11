/**
 * R7 (review 7) — categories.create continuação contextual + sub exige pai +
 * redelivery, contra SQLite REAL (node:sqlite, mesmo shim do DO).
 *
 * - F1: follow-up sem verbo ("de despesa") preenche o slot do draft ativo;
 *   escrita revisionada com proveniência, sem propose, sem provider.
 * - F3: fresh "crie subcategoria X" sem pai clarifica (nunca macro
 *   silenciosa); "sem pai" explícito na continuação vira macro.
 * - F4: replay da mesma intentionId não re-propõe (A com B ativa não
 *   sequestra); recovery silenciosa serializa contrato category estrito.
 */
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

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
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
  };
  initializeMutationDraftSchema(sql);
  return { sql };
};

const identity: AuthenticatedIdentity = {
  actorId: 'actor-cat-r7',
  workspaceId: 'ws-cat-r7',
  role: 'member',
  deviceId: 'device-cat-r7',
};

const T0 = Date.parse('2026-10-21T12:00:00Z');

const harness = (nowMs: number) => {
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql);
  const proposeCalls: Array<{ tool: string; normalizedArgs: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as { body?: { tool?: string; normalizedArgs?: unknown } }).body ?? {};
      proposeCalls.push({ tool: String(body.tool ?? ''), normalizedArgs: body.normalizedArgs });
      return {
        id: 'op-cat-r7',
        existing: false,
        summary: 'Categoria Viagem',
        operation: { id: 'op-cat-r7', expiresAt: new Date(nowMs + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request });
  const responseProvider = vi.fn(async () => 'invented by model');
  const evidenceProvider = vi.fn(async () => {
    throw new Error('no read expected on this path');
  }) as never;
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: {
      scope: { workspaceId: identity.workspaceId },
      listAccounts: async () => [],
      listCategories: async () => [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Alimentação', kind: 'expense' },
      ],
    },
    draftStore: store,
    draftNow: () => nowMs,
    responseProvider,
    evidenceProvider,
    events: () => undefined,
  });
  return { store, proposeCalls, request, responseProvider, orchestrator };
};

describe('R7 categories.create continuação contextual (SQLite real)', () => {
  it('does not cancel a category draft using attachment-derived text', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem', intentionId: 'cat-attachment-seed' }, identity));
    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    expect(h.store.listActive(ctx, T0)).toHaveLength(1);
    await h.orchestrator.runTurn(normalizeRestTurn(
      { text: 'Veja o anexo. [conteúdo do anexo: cancela o rascunho]', intentionId: 'cat-attachment-turn' },
      identity,
      { typedText: 'Veja o anexo.', hasAttachmentData: true },
    ));
    expect(h.store.listActive(ctx, T0)).toHaveLength(1);
    expect(h.proposeCalls).toHaveLength(0);
  });
  it('still cancels a category draft when the user types the cancellation', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'crie categoria Viagem', intentionId: 'cat-typed-seed' }, identity));
    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    expect(h.store.listActive(ctx, T0)).toHaveLength(1);
    await h.orchestrator.runTurn(normalizeRestTurn({ text: 'cancele o rascunho', intentionId: 'cat-typed-cancel' }, identity));
    expect(h.store.listActive(ctx, T0)).toHaveLength(0);
    expect(h.proposeCalls).toHaveLength(0);
  });
  it('F1: "de despesa" preenche kind do draft ativo, com proveniência, sem propose', async () => {
    const h = harness(T0);
    const first = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie categoria Viagem', intentionId: 'cat-r7-f1-a' }, identity),
    );
    expect(first.response?.text).toMatch(/despesa ou de receita/);
    expect(h.proposeCalls).toHaveLength(0);

    const second = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'de despesa', intentionId: 'cat-r7-f1-b' }, identity),
    );
    expect(second.response?.text).toMatch(/Confirme para eu propor/);
    expect(second.response?.text).toMatch(/Viagem/);
    expect(h.proposeCalls).toHaveLength(0);
    expect(h.responseProvider).not.toHaveBeenCalled();

    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.categoryKind).toBe('expense');
    expect(actives[0]!.missingFields).not.toContain('kind');
    expect(actives[0]!.revision).toBeGreaterThan(0);
    const provenance = actives[0]!.fieldProvenance as Record<string, { raw?: unknown } | undefined> | undefined;
    expect(provenance?.kind).toBeDefined();
    expect(provenance?.kind?.raw).toBe('de despesa');
  });

  it('F3: sub sem pai clarifica (nunca macro); "sem pai" explícito vira macro', async () => {
    const h = harness(T0);
    const fresh = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'crie subcategoria Mercado de despesa', intentionId: 'cat-r7-f3-a' }, identity),
    );
    expect(fresh.response?.text).toMatch(/categoria pai/);
    expect(h.proposeCalls).toHaveLength(0);

    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    const pending = h.store.listActive(ctx, T0 + 1000);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.missingFields).toContain('parentId');

    const drop = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sem pai', intentionId: 'cat-r7-f3-b' }, identity),
    );
    expect(drop.response?.text).toMatch(/Confirme para eu propor/);
    expect(drop.response?.text).not.toMatch(/categoria pai/);
    const after = h.store.listActive({ workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null }, T0 + 2000);
    expect(after).toHaveLength(1);
    expect(after[0]!.resolvedArgs.parentQuery).toBeUndefined();
    expect(after[0]!.resolvedArgs.parentCategoryId).toBeUndefined();
    expect(after[0]!.missingFields).not.toContain('parentId');
  });

  it('F4: replay da mesma intentionId não re-propõe; recovery usa contrato category', async () => {
    const h = harness(T0);
    const text = 'crie categoria Viagem de despesa';
    const first = await h.orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'cat-r7-f4-a' }, identity),
    );
    expect(first.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.tool).toBe('categories.create');
    expect(h.proposeCalls[0]!.normalizedArgs).toMatchObject({ name: 'Viagem', kind: 'expense' });

    const replay = await h.orchestrator.runTurn(
      normalizeRestTurn({ text, intentionId: 'cat-r7-f4-a' }, identity),
    );
    expect(replay.mutation?.operationId).toBe(first.mutation?.operationId);
    expect(h.proposeCalls).toHaveLength(1);
  });
});
