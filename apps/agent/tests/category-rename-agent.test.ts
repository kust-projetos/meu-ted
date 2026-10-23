/**
 * categories.update (name-only) — fluxo conversacional de RENOMEAÇÃO de
 * CATEGORIA no AGENT (rascunho + proposta manual), espelhando o fluxo de
 * `accounts.update`.
 *
 * Contrato fechado: tool `categories.update`; normalizedArgs estrito
 * `{ categoryId: UUID, name: trim 1..120 (novo), expectedName: nome canônico
 * exato atual }`; alvo resolvido contra o CATÁLOGO autoritativo (escopo +
 * kind explícito + homônimo ambíguo); NUNCA auto_execute; proposta sempre
 * manual (card); DELETE continua sem suporte (recusa honesta, nunca forget).
 *
 * Provas comportamentais (SQLite real no draft store): turno fresco,
 * turno fragmentado → rascunho → nome novo → proposta, homônimo, mesmo
 * nome, replay do mesmo turno e recusa de delete.
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
  buildDraftRecord,
} from '../src/mutations/mutation-draft.js';
import { PendingOperationCoordinator } from '../src/orchestration/pending-operation-coordinator.js';
import {
  hasCategoryRenameSignal,
  resolveCategoryRenameTarget,
} from '../src/mutations/category-rename.js';
import { routeIntent, UNSUPPORTED_CATEGORY_MUTATION_TEXT } from '../src/orchestration/intent-router.js';

const CAT_VIAGEM = '33333333-3333-4333-8333-333333333333';
const CAT_VIAGEM_HOMONIMA = '44444444-4444-4444-8444-444444444444';
const CAT_MERCADO = '55555555-5555-4555-8555-555555555555';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-cat-rename',
  workspaceId: 'workspace-cat-rename',
  role: 'member',
  deviceId: 'device-cat-rename',
};

const T0 = Date.parse('2026-10-21T12:00:00Z');

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

type CategoryRow = {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  isActive?: boolean;
  parentId?: string;
  householdId?: string;
};

const CATEGORIES: CategoryRow[] = [
  { id: CAT_VIAGEM, name: 'QA Viagem Safira', kind: 'expense', status: 'active', householdId: identity.workspaceId },
];

const harness = (nowMs: number, categories: CategoryRow[] = CATEGORIES) => {
  let now = nowMs;
  const { sql } = createSql();
  const store = new SqlMutationDraftStore(sql as never);
  const proposeCalls: Array<{ tool: string; normalizedArgs: unknown; idempotencyKey?: string }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: never) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
      proposeCalls.push({
        tool: body!.tool,
        normalizedArgs: body!.normalizedArgs,
        idempotencyKey: (options as unknown as { idempotencyKey?: string }).idempotencyKey,
      });
      const operationId = `op-cat-rename-${proposeCalls.length}`;
      return {
        id: operationId,
        existing: false,
        summary: 'renomear a categoria',
        operation: { id: operationId, expiresAt: new Date(now + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: {
      listAccounts: async () => [],
      listCategories: async () => categories,
    },
    draftStore: store,
    draftNow: () => now,
    responseProvider: vi.fn(async () => 'invented by model'),
    evidenceProvider: vi.fn(async () => ({ version: '1', items: [] }) as never),
    events: () => undefined,
  });
  return {
    store,
    orchestrator,
    proposeCalls,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('categories.update sinal de intenção (router + parser)', () => {
  it('(1) "renomeie categoria QA Viagem Safira para QA Viagem Esmeralda" é renomeação (não create, não delete)', () => {
    expect(hasCategoryRenameSignal('renomeie categoria QA Viagem Safira para QA Viagem Esmeralda')).toBe(true);
    expect(routeIntent('renomeie categoria QA Viagem Safira para QA Viagem Esmeralda').requestedOperations
      .some((operation) => operation.name === 'categories.update')).toBe(true);
  });

  it('(2) delete continua sem fluxo V2 (recusa honesta, nunca forget)', () => {
    const plan = routeIntent('exclua a categoria QA Viagem Safira');
    expect(plan.ambiguity).toBe('unsupported_category_mutation');
    expect(UNSUPPORTED_CATEGORY_MUTATION_TEXT).toMatch(/excluir|alterar/i);
  });

  it('(3) não rouba criação, leitura nem transação', () => {
    expect(hasCategoryRenameSignal('crie uma categoria QA Viagem Safira')).toBe(false);
    expect(hasCategoryRenameSignal('liste minhas categorias')).toBe(false);
    expect(hasCategoryRenameSignal('gastei 50 no mercado')).toBe(false);
    expect(hasCategoryRenameSignal('renomeie a conta nubank para itau')).toBe(false);
  });
});

describe('categories.update resolução contra o catálogo autoritativo', () => {
  it('(4) homônimo (mesmo nome, pais diferentes) é ambíguo — nunca um chute', () => {
    const rows: CategoryRow[] = [
      { id: CAT_VIAGEM, name: 'QA Viagem', kind: 'expense', status: 'active' },
      { id: CAT_VIAGEM_HOMONIMA, name: 'QA Viagem', kind: 'expense', status: 'active', parentId: CAT_MERCADO },
    ];
    const resolution = resolveCategoryRenameTarget(
      'renomeie a categoria QA Viagem para QA Viagem Esmeralda',
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.kind ? { kind: row.kind } : {}),
        ...(row.status ? { status: row.status } : {}),
        ...(row.parentId ? { parentId: row.parentId } : {}),
      })),
    );
    expect(resolution.kind).toBe('ambiguous');
  });

  it('(5) categoria sem kind explícito é inapto (nunca curinga)', () => {
    const resolution = resolveCategoryRenameTarget(
      'renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda',
      [{ id: CAT_VIAGEM, name: 'QA Viagem Safira' }],
    );
    expect(resolution.kind).toBe('none');
  });
});

describe('categories.update fluxo de rascunho → proposta manual', () => {
  it('(6) turno fresco propõe o rename com os args estritos {categoryId, name, expectedName}', async () => {
    const h = harness(T0);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cat-rename-1' },
        identity,
      ),
    );
    expect(result.mutation?.status).toBe('proposed');
    expect(result.mutation?.operationId).toBe('op-cat-rename-1');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.tool).toBe('categories.update');
    // Args estritos: nada de amount/date/accountId/transaction.
    expect(h.proposeCalls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_VIAGEM,
      name: 'QA Viagem Esmeralda',
      expectedName: 'QA Viagem Safira',
    });
    // NUNCA auto_execute: a autorização é manual.
    expect(result.policy?.authorizationMode).toBe('manual');
  });

  it('(7) turno fragmentado abre rascunho e pede o novo nome; o nome novo propõe', async () => {
    const h = harness(T0);
    const first = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'renomeie a categoria QA Viagem Safira', intentionId: 'cat-rename-2a' }, identity),
    );
    expect(first.mutation).toBeUndefined();
    expect(first.response?.text).toMatch(/novo nome/i);
    expect(h.proposeCalls).toHaveLength(0);

    const second = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'QA Viagem Esmeralda', intentionId: 'cat-rename-2b' }, identity),
    );
    expect(second.mutation?.status).toBe('proposed');
    expect(h.proposeCalls).toHaveLength(1);
    expect(h.proposeCalls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_VIAGEM,
      name: 'QA Viagem Esmeralda',
      expectedName: 'QA Viagem Safira',
    });
  });

  it('(8) mesmo nome é no-op honesto — nunca uma proposta', async () => {
    const h = harness(T0);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie a categoria QA Viagem Safira para QA Viagem Safira', intentionId: 'cat-rename-3' },
        identity,
      ),
    );
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/já está com esse nome/i);
    expect(h.proposeCalls).toHaveLength(0);
  });

  it('(9) delete responde a recusa honesta, sem rascunho e sem proposta', async () => {
    const h = harness(T0);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'exclua a categoria QA Viagem Safira', intentionId: 'cat-rename-4' }, identity),
    );
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toBe(UNSUPPORTED_CATEGORY_MUTATION_TEXT);
    expect(h.proposeCalls).toHaveLength(0);
  });

  it('(10) replay do mesmo turno converge sem uma segunda proposta', async () => {
    const h = harness(T0);
    const turn = normalizeRestTurn(
      { text: 'renomeie categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cat-rename-5' },
      identity,
    );
    const first = await h.orchestrator.runTurn(turn);
    const replayed = await h.orchestrator.runTurn(turn);
    expect(first.mutation?.operationId).toBe('op-cat-rename-1');
    expect(replayed.mutation?.operationId).toBe('op-cat-rename-1');
    expect(h.proposeCalls).toHaveLength(1);
  });

  it('(11) replay terminal de A não sequestra nem renova o rascunho/proposta de B', async () => {
    const h = harness(T0);
    const a = normalizeRestTurn(
      { text: 'renomeie categoria QA Viagem Safira para QA Viagem Esmeralda', intentionId: 'cat-rename-6a' },
      identity,
    );
    const first = await h.orchestrator.runTurn(a);
    expect(first.mutation?.operationId).toBe('op-cat-rename-1');
    // Replay do turno terminal A: converge no MESMO recibo, sem nova proposta.
    const replay = await h.orchestrator.runTurn(a);
    expect(replay.mutation?.operationId).toBe('op-cat-rename-1');
    expect(h.proposeCalls).toHaveLength(1);
    // Intenção B (outro texto): proposta NOVA — nunca o recibo de A.
    const b = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'renomeie categoria QA Viagem Safira para QA Viagem Azul', intentionId: 'cat-rename-6b' },
        identity,
      ),
    );
    expect(b.mutation?.operationId).toBe('op-cat-rename-2');
    expect(h.proposeCalls).toHaveLength(2);
    expect(h.proposeCalls[1]!.idempotencyKey).not.toBe(h.proposeCalls[0]!.idempotencyKey);
  });
});

describe('categories.update cancel/silent recovery (coordinator)', () => {
  it('(12) recovery de rascunho proposing propõe com os args ESTRITOS de categoria (nunca tupla de transação)', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql as never);
    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'cat-rename-recovery-1',
      tool: 'categories.update',
      resolvedArgs: {
        kind: 'category-rename',
        amountCents: 0,
        description: 'QA Viagem Esmeralda',
        date: '',
        categoryId: CAT_VIAGEM,
        categoryName: 'QA Viagem Esmeralda',
        expectedName: 'QA Viagem Safira',
      },
      missingFields: [],
      question: '',
      ttlMs: 60_000,
      nowMs: T0,
    });
    store.getOrCreate(draft);
    store.update(draft.draftId, { status: 'proposing' });

    const calls: Array<{ tool: string; normalizedArgs: unknown; idempotencyKey?: string }> = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string, options: never) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = (options as unknown as { body?: { tool: string; normalizedArgs: unknown } }).body;
        calls.push({
          tool: body!.tool,
          normalizedArgs: body!.normalizedArgs,
          idempotencyKey: (options as unknown as { idempotencyKey?: string }).idempotencyKey,
        });
        return {
          id: 'op-cat-recovery-1',
          existing: false,
          summary: 'renomear a categoria',
          operation: { id: 'op-cat-recovery-1', expiresAt: new Date(T0 + 600_000).toISOString() },
        };
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const api = new MutationApiClient({ request: request as never });
    const coordinator = new PendingOperationCoordinator({ client: api, draftStore: store, now: () => T0 });
    const resolution = await coordinator.resolveCancel(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? 'device-cat-rename' } as never,
      { store, ctx, intentionId: 'cat-rename-recovery-1', deviceId: identity.deviceId ?? null, nowMs: T0 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('categories.update');
    // Args estritos: sem amountCents/date/accountId (nunca tupla de transação).
    expect(calls[0]!.normalizedArgs).toEqual({
      categoryId: CAT_VIAGEM,
      name: 'QA Viagem Esmeralda',
      expectedName: 'QA Viagem Safira',
    });
    expect(calls[0]!.idempotencyKey).toBe(draft.proposalIdempotencyKey);
    expect(resolution.kind).toBeDefined();
  });
});
