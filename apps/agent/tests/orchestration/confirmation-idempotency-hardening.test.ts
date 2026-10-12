/**
 * PR137-HARDEN (Bloco A) — idempotência de confirmação contra SQLite REAL
 * (node:sqlite, mesmo shim do DO), RED→GREEN.
 *
 * Cada teste prova postconditions em SQL (`mutation_confirmations`) + efeitos
 * financeiros reais (executes contados no backend isolado). Invariantes em
 * todos os casos: DUPLICATE_FINANCIAL_EFFECT=0, WRONG_OPERATION_CONFIRMED=0,
 * FALSE_SUCCESS=0, UNAUTHORIZED_MUTATION=0, CROSS_WORKSPACE_LEAK=0,
 * CROSS_ACTOR_LEAK=0.
 *
 * Cobertura (criterion 8): replay A com B pendente; replay após restart (nova
 * instância + mesmo SQLite); replay após falha de gravação; replay após falha
 * de leitura; replay após TTL (tombstone); dupla confirmação concorrente;
 * vínculo conflitante; receipt corrompido/divergente/não-succeeded; execução
 * persistida com resposta perdida; reconciliação indisponível; fail-closed sem
 * store / sem métodos; reserva-durável-antes-de-executar (ordem provada).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnPlan,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { PendingOperationCoordinator } from '../../src/orchestration/pending-operation-coordinator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  initializeMutationDraftSchema,
  SqlMutationDraftStore,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import { renderInconclusive, renderMutationResult } from '../../src/responses/deterministic-responses.js';
import { createMemorySql } from '../helpers/memory-sql.js';
import {
  initializeMemorySchema,
  type MemorySql,
} from '../../src/agent-config/memory/store.js';

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createSql = (): { db: DatabaseSync; sql: SqlShim } => {
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
  return { db, sql };
};

const IDENTITY: AuthenticatedIdentity = {
  actorId: 'actor-harden',
  workspaceId: 'ws-harden',
  role: 'member',
  deviceId: 'device-harden',
};

const CTX = { workspaceId: 'ws-harden', actorId: 'actor-harden', deviceId: 'device-harden' } as const;

const confirmationPlan = (): TurnPlan => ({
  version: '2',
  mode: 'confirmation',
  domain: 'transactions',
  skillNames: [],
  requestedOperations: [],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

type FakeOp = { id: string; status: string; createdAt?: string };
type ConfirmBehavior = 'succeed' | 'throw-after-persist' | 'throw-clean' | 'throw-keep-executing';

/** Ops dos doubles carregam `createdAt` autoritativo como a API real (`ActiveOperationRecord.createdAt`). */
const OP_CREATED_AT = '2026-10-11T11:00:00.000Z';

const validReceipt = (operationId: string): string =>
  JSON.stringify({
    operationId,
    mutationId: `mut-${operationId}`,
    mutationKind: 'transactions.expense.create',
    status: 'succeeded',
    affectedTargets: ['transactions'],
    entity: { type: 'transaction', id: `tx-${operationId}` },
  });

/**
 * Backend isolado com efeitos financeiros reais contados. `confirm`
 * persiste (remove do active set) e SÓ então executa o comportamento
 * configurado — `throw-after-persist` modela a resposta perdida com efeito
 * aplicado (o caso Bloco A fase 2).
 */
const fakeBackend = (options: {
  active: FakeOp[];
  confirmBehavior?: ConfirmBehavior;
  confirmHook?: (operationId: string) => void;
  listFailure?: unknown;
  listCalls?: { count: number };
  /** Hook executado no início de cada `listActive` (simula nascimentos durante o I/O). */
  listHook?: () => void;
  /** Turn clock for the API-side intention frontier (default: frozen NOW). */
  nowMs?: () => number;
  /** Review round 4 P1-A3: pre-present ops (proposal cards shown before the turn). Unlisted here ⇒ never presented (race/out-of-band). */
  store?: MutationDraftStore;
}): {
  coordinator: PendingOperationCoordinator;
  executes: Array<{ operationId: string }>;
  active: FakeOp[];
} => {
  const active: FakeOp[] = options.active.map((op) => ({ tool: 'transactions.expense.create', createdAt: OP_CREATED_AT, ...op }));
  const executes: Array<{ operationId: string }> = [];
  const nowMs = options.nowMs ?? (() => NOW);
  // Review round 4 P1-B: API-side intention frontier (authoritative
  // intentionId→firstSeenAt/operationId, per identity). Survives agent
  // restarts inside the test (closure-scoped, like a real API table).
  const apiIntentions = new Map<string, { firstSeenAt: string }>();
  const apiBindings = new Map<string, string>();
  const intentionKey = (identity: { workspaceId: string; actorId: string; deviceId?: string | null }, intentionId: string): string =>
    `${identity.workspaceId}|${identity.actorId}|${identity.deviceId ?? ''}|${intentionId}`;
  // P1-A3: initial active ops were proposed (card shown) before the turn —
  // seed their presentations at proposal time so legitimate first confirms
  // pass; ops pushed later are presented only when the test says so.
  if (options.store) {
    for (const op of active) {
      const at = Date.parse(op.createdAt ?? '');
      try {
        options.store.noteConfirmationPresentation?.({
          ctx: CTX,
          operationIds: [op.id],
          nowMs: Number.isFinite(at) ? at : NOW,
        });
      } catch {
        // Best-effort seeding only.
      }
    }
  }
  const coordinator = {
    listActive: async () => {
      if (options.listCalls) options.listCalls.count += 1;
      options.listHook?.();
      if (options.listFailure) throw options.listFailure;
      // Normalizado na leitura (não só na construção): pushes diretos nos
      // testes carregam o mesmo shape autoritativo da API real.
      return active.map((op) => ({ tool: 'transactions.expense.create', createdAt: OP_CREATED_AT, ...op }));
    },
    resolveDecisionTarget: async () => {
      const listed = await (coordinator as unknown as { listActive: () => Promise<FakeOp[]> }).listActive();
      const decidable = listed.filter((op) => op.status === 'proposed' || op.status === 'confirmed');
      if (decidable.length === 0) return { kind: 'none', operations: listed, hasActiveDraft: false, hasProposingDraft: false };
      if (decidable.length > 1) return { kind: 'multiple', operations: decidable, hasActiveDraft: false, hasProposingDraft: false };
      return { kind: 'single', operation: decidable[0], operations: decidable, hasActiveDraft: false, hasProposingDraft: false };
    },
    confirm: async (operationId: string, identity?: { workspaceId: string; actorId: string; deviceId?: string | null }, intentionId?: string) => {
      options.confirmHook?.(operationId);
      // Review round 4 P1-B: the API enforces the intentionId→operationId
      // binding atomically inside confirm — identical re-binds proceed, a
      // divergent binding is refused with zero effect (no execute record).
      if (typeof intentionId === 'string' && intentionId !== '' && identity) {
        const key = intentionKey(identity, intentionId);
        const bound = apiBindings.get(key);
        if (bound !== undefined && bound !== operationId) {
          throw Object.assign(new Error('approval.intention_conflict'), { statusCode: 409, code: 'approval.intention_conflict' });
        }
        if (bound === undefined) apiBindings.set(key, operationId);
      }
      executes.push({ operationId });
      const behavior = options.confirmBehavior ?? 'succeed';
      // P1-1: o efeito fica suspenso no API (`executing`) e o transporte
      // falha — o turno não pode alegar `failed` nem liquidar a reserva.
      if (behavior === 'throw-keep-executing') {
        const op = active.find((entry) => entry.id === operationId);
        if (op) op.status = 'executing';
        throw Object.assign(new Error('injected_confirm_transport_failure'), { statusCode: 502 });
      }
      const index = active.findIndex((op) => op.id === operationId);
      if (index >= 0) active.splice(index, 1);
      if (behavior !== 'succeed') {
        throw Object.assign(new Error('injected_confirm_transport_failure'), { statusCode: 502 });
      }
      return {
        operationId,
        status: 'succeeded' as const,
        receipt: JSON.parse(validReceipt(operationId)) as Record<string, unknown>,
      };
    },
  } as unknown as PendingOperationCoordinator;
  // Review round 4 P1-B: the pre-listing authoritative bind lives on the
  // coordinator in the orchestrator's call path, so the double carries it.
  (coordinator as unknown as Record<string, unknown>).bindConfirmationIntention = async (
    identity: { workspaceId: string; actorId: string; deviceId?: string | null },
    intentionId: string,
  ): Promise<{ firstSeenAt: string; fresh: boolean; operationId: string | null }> => {
    const key = intentionKey(identity, intentionId);
    const existing = apiIntentions.get(key);
    if (existing) {
      return { firstSeenAt: existing.firstSeenAt, fresh: false, operationId: apiBindings.get(key) ?? null };
    }
    const at = new Date(nowMs()).toISOString();
    apiIntentions.set(key, { firstSeenAt: at });
    return { firstSeenAt: at, fresh: true, operationId: apiBindings.get(key) ?? null };
  };
  return { coordinator, executes, active };
};

type CapturedEvent = { type: string; fields: Record<string, unknown> };

/**
 * Review fix P2-5: preserva o prototype do store (o spread `{...store}`
 * PERDE os métodos da classe — `canBind` era falso antes do throw e os
 * testes de fault passavam pelo motivo errado). `Object.create` mantém a
 * cadeia de protótipos e aplica só os overrides.
 */
const wrapStore = (store: SqlMutationDraftStore, overrides: Partial<MutationDraftStore>): MutationDraftStore =>
  Object.assign(Object.create(Object.getPrototypeOf(store) as object), store, overrides) as MutationDraftStore;

const orchestratorFor = (
  coordinator: PendingOperationCoordinator,
  store: MutationDraftStore | undefined,
  nowRef: { now: number },
  events: CapturedEvent[] = [],
): ConversationOrchestrator =>
  new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({
      request: async () => {
        throw new Error('must_not_happen');
      },
    }),
    plan: confirmationPlan,
    coordinator,
    ...(store ? { draftStore: store } : {}),
    draftNow: () => nowRef.now,
    events: (type: string, fields: Record<string, unknown>) => {
      events.push({ type, fields });
    },
  });

const blockedReason = (events: CapturedEvent[]): unknown =>
  events.find((event) => event.type === 'mutation.blocked')?.fields['reason'];

const confirmTurn = (
  orchestrator: ConversationOrchestrator,
  intentionId: string,
  identity: AuthenticatedIdentity = IDENTITY,
) => orchestrator.runTurn(normalizeRestTurn({ text: 'sim', intentionId }, identity));

const confirmationRows = (sql: SqlShim): Array<Record<string, unknown>> => [
  ...sql.exec<Record<string, unknown>>(
    `SELECT workspace_id AS workspaceId, actor_id AS actorId, device_id AS deviceId, intention_id AS intentionId, operation_id AS operationId, status, receipt_json AS receiptJson, expires_at AS expiresAt FROM mutation_confirmations`,
  ),
];

const NOW = Date.parse('2026-10-11T12:00:00.000Z');

describe('PR137-HARDEN: idempotência de confirmação sobre SQLite real', () => {
  it('reserva durável existe ANTES do confirm remoto (ordem provada no SQL)', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    let rowAtConfirm: Array<Record<string, unknown>> | null = null;
    const backend = fakeBackend({
      active: [{ id: 'op-A', status: 'proposed' }],
      store,
      confirmHook: () => {
        rowAtConfirm = confirmationRows(sql);
      },
    });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const first = await confirmTurn(orchestrator, 'intent-A');

    expect(first.mutation?.status).toBe('succeeded');
    expect(first.mutation?.operationId).toBe('op-A');
    // No instante do confirm remoto a reserva já estava durável em SQL.
    expect(rowAtConfirm).toHaveLength(1);
    expect(rowAtConfirm?.[0]).toMatchObject({ operationId: 'op-A', status: 'reserved' });
    // Pós-sucesso a reserva liquidou para succeeded com recibo válido.
    expect(confirmationRows(sql)).toHaveLength(1);
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A', status: 'succeeded' });
    expect(backend.executes).toEqual([{ operationId: 'op-A' }]);
  });

  it('replay de A com B pendente: 0 executes novos, B intacta, replay idêntico (SQLite real)', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const listCalls = { count: 0 };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], listCalls, store });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const first = await confirmTurn(orchestrator, 'intent-A');
    expect(first.mutation?.operationId).toBe('op-A');
    expect(backend.executes).toHaveLength(1);

    backend.active.push({ id: 'op-B', status: 'proposed' });
    const callsBefore = listCalls.count;
    const replayed = await confirmTurn(orchestrator, 'intent-A');

    // Replay cego: a listagem sequer é consultada — B não pode ser tocada.
    expect(listCalls.count).toBe(callsBefore);
    expect(backend.executes).toHaveLength(1);
    expect(replayed.mutation?.status).toBe('succeeded');
    expect(replayed.mutation?.operationId).toBe('op-A');
    expect(replayed.mutation?.receipt).toEqual(first.mutation?.receipt);
    expect(replayed.response?.text).toBe(renderMutationResult('succeeded'));
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
    expect(confirmationRows(sql)).toHaveLength(1);
  });

  it('replay após RESTART (nova instância + mesmo SQLite): reencontra A, nunca executa B', async () => {
    const { sql } = createSql();
    const nowRef = { now: NOW };
    const store = new SqlMutationDraftStore(sql);
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store });

    const first = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-A');
    expect(first.mutation?.operationId).toBe('op-A');

    backend.active.push({ id: 'op-B', status: 'proposed' });
    // Restart do DO: instância nova, mesmo SQLite durável.
    const restarted = orchestratorFor(backend.coordinator, new SqlMutationDraftStore(sql), nowRef);
    const replayed = await confirmTurn(restarted, 'intent-A');

    expect(backend.executes).toHaveLength(1);
    expect(backend.executes).toEqual([{ operationId: 'op-A' }]);
    expect(replayed.mutation?.operationId).toBe('op-A');
    expect(replayed.response?.text).toBe(renderMutationResult('succeeded'));
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
  });

  it('dupla confirmação concorrente (mesma intention): 1 execute; perdedor inconclusivo sem tocar B', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const [left, right] = await Promise.all([confirmTurn(orchestrator, 'intent-A'), confirmTurn(orchestrator, 'intent-A')]);

    // DUPLICATE_FINANCIAL_EFFECT=0 mesmo com transporte sem dedup: o CAS
    // elegeu um único vencedor.
    expect(backend.executes).toHaveLength(1);
    const succeededCount = [left, right].filter((turn) => turn.mutation?.status === 'succeeded').length;
    expect(succeededCount).toBe(1);
    const loser = left.mutation?.status === 'succeeded' ? right : left;
    expect(loser.mutation).toBeUndefined();
    expect(loser.response?.text).toBe(renderInconclusive());
    expect(confirmationRows(sql)).toHaveLength(1);
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A' });
  });

  it('falha de gravação da reserva (claim throw): inconclusivo, 0 executes, claim chamado + reason', async () => {
    // Review fix P2-5: o double preserva o prototype (wrapStore) — o
    // `canBind` é verdadeiro e o fluxo ALCANÇA o claim injetado. Com o
    // spread `{...store}` o teste passava pelo motivo errado (`canBind`
    // falso antes do throw: claim nunca chamado, reason
    // `confirmation_store_unavailable`).
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    let claimCalls = 0;
    let settleCalls = 0;
    const broken = wrapStore(store, {
      claimConfirmation: () => {
        claimCalls += 1;
        throw new Error('injected_sqlite_write_failure');
      },
      settleConfirmation: () => {
        settleCalls += 1;
        throw new Error('injected_sqlite_write_failure');
      },
    });
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store: broken });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, broken, nowRef, events), 'intent-A');

    expect(claimCalls).toBe(1);
    // A sentinela best-effort foi tentada no catch (também falhou — store down).
    expect(settleCalls).toBe(1);
    expect(blockedReason(events)).toBe('confirmation_reserve_failed');
    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    // A sighting (pré-reserva) foi persistida antes da falha do claim.
    expect(confirmationRows(sql)).toMatchObject([{ operationId: '', status: 'reserved' }]);
  });

  it('falha de leitura do marcador (sighting throw): inconclusivo, nunca resolve a listagem', async () => {
    // O sighting é a primeira leitura do fluxo (o `find` direto saiu do
    // caminho de confirmação): com o prototype preservado, o throw é
    // alcançado de verdade — `noteConfirmationSighted` chamado, listagem
    // nunca consultada.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    let noteCalls = 0;
    const blind = wrapStore(store, {
      noteConfirmationSighted: () => {
        noteCalls += 1;
        throw new Error('injected_sqlite_read_failure');
      },
    });
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const listCalls = { count: 0 };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], listCalls });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, blind, nowRef, events), 'intent-A');

    expect(noteCalls).toBe(1);
    expect(blockedReason(events)).toBe('confirmation_marker_unreadable');
    expect(backend.executes).toHaveLength(0);
    expect(listCalls.count).toBe(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
  });

  it('falha de gravação do settle pós-sucesso: sucesso mantido (API é autoridade), redelivery inconclusivo sem B', async () => {
    // O settle é best-effort: um sucesso que a API persistiu nunca é
    // quebrado por falha local de bookkeeping. A reserva não liquidada segue
    // bloqueando B no redelivery (reconcile → inconclusivo, nunca replay de
    // sucesso sem prova, nunca B).
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    let settleCalls = 0;
    const unsettled = wrapStore(store, {
      settleConfirmation: () => {
        settleCalls += 1;
        throw new Error('injected_sqlite_settle_failure');
      },
    });
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store: unsettled });
    const orchestrator = orchestratorFor(backend.coordinator, unsettled, nowRef);

    const first = await confirmTurn(orchestrator, 'intent-A');
    expect(first.mutation?.status).toBe('succeeded');
    expect(first.mutation?.operationId).toBe('op-A');
    expect(backend.executes).toEqual([{ operationId: 'op-A' }]);
    expect(settleCalls).toBe(1);
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A', status: 'reserved' });

    backend.active.push({ id: 'op-B', status: 'proposed' });
    const redelivery = await confirmTurn(orchestrator, 'intent-A');
    expect(backend.executes).toHaveLength(1);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
  });

  it('schema não inicializado: confirmação financeira é fail-closed (inconclusivo, 0 executes)', async () => {
    // Sem a tabela, o sighting (primeira escrita do fluxo) lança — o turno
    // fecha antes de qualquer resolução ou efeito. Nota: `createSql` do
    // arquivo já inicializa; aqui o shim é cru de propósito.
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
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const listCalls = { count: 0 };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], listCalls });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, events), 'intent-A');

    expect(blockedReason(events)).toBe('confirmation_marker_unreadable');
    expect(backend.executes).toHaveLength(0);
    expect(listCalls.count).toBe(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
  });

  it('sem store: confirmação financeira é fail-closed (inconclusivo, 0 executes)', async () => {
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }] });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, undefined, nowRef), 'intent-A');

    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
  });

  it('métodos de binding ausentes (double legado): fail-closed, 0 executes', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const legacy = {
      findConfirmation: store.findConfirmation.bind(store),
    } as unknown as MutationDraftStore;
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }] });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, legacy, nowRef), 'intent-A');

    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
  });

  it('execução persistida com resposta perdida: inconclusivo + settle; redelivery nunca confirma B', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({
      active: [{ id: 'op-A', status: 'proposed' }],
      confirmBehavior: 'throw-after-persist',
      store,
    });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const answered = await confirmTurn(orchestrator, 'intent-A');

    // FALSE_SUCCESS=0: o efeito pode ter aplicado — nada de `failed`
    // definitivo e nada de sucesso alegado.
    expect(backend.executes).toEqual([{ operationId: 'op-A' }]);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A', status: 'inconclusive' });

    backend.active.push({ id: 'op-B', status: 'proposed' });
    const redelivery = await confirmTurn(orchestrator, 'intent-A');

    expect(backend.executes).toHaveLength(1);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
  });

  it('reconciliação indisponível após resposta perdida: inconclusivo, sem sucesso falso', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({
      active: [{ id: 'op-A', status: 'proposed' }],
      confirmBehavior: 'throw-after-persist',
      store,
    });
    // O resolve enxerga A uma vez; TODA listagem posterior (a reconciliação
    // do catch) é ilegível.
    const flakyCoordinator = {
      ...(backend.coordinator as unknown as Record<string, unknown>),
      listActive: async (): Promise<never> => {
        throw new Error('injected_listing_unavailable');
      },
      resolveDecisionTarget: async () =>
        ({
          kind: 'single',
          operation: { id: 'op-A', status: 'proposed', createdAt: OP_CREATED_AT },
          operations: [{ id: 'op-A', status: 'proposed', createdAt: OP_CREATED_AT }],
          hasActiveDraft: false,
          hasProposingDraft: false,
        }) as unknown as PendingOperationCoordinator['resolveDecisionTarget'],
    } as unknown as PendingOperationCoordinator;
    const answered = await confirmTurn(orchestratorFor(flakyCoordinator, store, nowRef), 'intent-A');

    expect(backend.executes).toHaveLength(1);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(answered.response?.text).not.toBe(renderMutationResult('failed'));
    expect(answered.response?.text).not.toBe(renderMutationResult('succeeded'));
  });

  it('tombstone pós-TTL com A terminal: replay de A (nunca B); com A ativa: inconclusivo', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    await confirmTurn(orchestrator, 'intent-A');
    expect(backend.executes).toHaveLength(1);

    // 25h depois: recibo expirado, binding retido como tombstone.
    nowRef.now = NOW + 25 * 60 * 60_000;
    backend.active.push({ id: 'op-B', status: 'proposed' });
    const replayed = await confirmTurn(orchestrator, 'intent-A');

    expect(backend.executes).toHaveLength(1);
    expect(replayed.mutation?.operationId).toBe('op-A');
    expect(replayed.response?.text).toBe(renderMutationResult('succeeded'));
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Tombstone com a operação vinculada ainda ativa: inconclusivo, sem executar.
    const { sql: sql2 } = createSql();
    const store2 = new SqlMutationDraftStore(sql2);
    const nowRef2 = { now: NOW };
    store2.claimConfirmation!({
      ctx: CTX,
      intentionId: 'intent-T',
      operationId: 'op-T',
      receiptJson: validReceipt('op-T'),
      status: 'succeeded',
      nowMs: NOW,
      ttlMs: 60_000,
    });
    nowRef2.now = NOW + 61_000;
    const backend2 = fakeBackend({ active: [{ id: 'op-T', status: 'proposed' }] });
    const stuck = await confirmTurn(orchestratorFor(backend2.coordinator, store2, nowRef2), 'intent-T');
    expect(backend2.executes).toHaveLength(0);
    expect(stuck.mutation).toBeUndefined();
    expect(stuck.response?.text).toBe(renderInconclusive());
  });

  it('recibo corrompido/divergente/não-succeeded com A terminal: replay sem recibo falso; com A ativa: inconclusivo', async () => {
    const seed = (
      sql: SqlShim,
      intentionId: string,
      operationId: string,
      receiptJson: string | null,
    ): SqlMutationDraftStore => {
      const store = new SqlMutationDraftStore(sql);
      const claimed = store.claimConfirmation!({
        ctx: CTX,
        intentionId,
        operationId,
        receiptJson: null,
        status: 'reserved',
        nowMs: NOW,
      });
      expect(claimed).toBe('claimed');
      expect(
        store.settleConfirmation!({
          ctx: CTX,
          intentionId,
          operationId,
          status: 'succeeded',
          receiptJson,
          nowMs: NOW,
        }),
      ).toBe(true);
      return store;
    };
    const cases: Array<{ name: string; receipt: string | null }> = [
      { name: 'corrupt', receipt: '{not-json' },
      { name: 'divergent', receipt: JSON.stringify({ operationId: 'op-EVIL', status: 'succeeded' }) },
      { name: 'not-succeeded', receipt: JSON.stringify({ operationId: 'op-A', status: 'failed' }) },
    ];
    for (const { name, receipt } of cases) {
      // A terminal: replay de A SEM o recibo inválido (nunca sucesso falso,
      // nunca B) — B pendente permanece intocada.
      {
        const { sql } = createSql();
        const store = seed(sql, `intent-${name}`, 'op-A', receipt);
        const nowRef = { now: NOW };
        const backend = fakeBackend({ active: [{ id: 'op-B', status: 'proposed' }] });
        const replayed = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), `intent-${name}`);
        expect(replayed.mutation?.operationId, name).toBe('op-A');
        expect(replayed.mutation?.receipt, name).toBeUndefined();
        expect(replayed.response?.text, name).toBe(renderMutationResult('succeeded'));
        expect(backend.executes, name).toHaveLength(0);
        expect(backend.active.map((op) => op.id), name).toEqual(['op-B']);
      }
      // A ainda ativa com recibo inválido: contraditório ⇒ inconclusivo.
      {
        const { sql } = createSql();
        const store = seed(sql, `intent-${name}`, 'op-A', receipt);
        const nowRef = { now: NOW };
        const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }] });
        const stuck = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), `intent-${name}`);
        expect(stuck.mutation, name).toBeUndefined();
        expect(stuck.response?.text, name).toBe(renderInconclusive());
        expect(backend.executes, name).toHaveLength(0);
      }
    }
  });

  it('janela de crash reserva→execute: redelivery encontra A reservada, nunca executa B', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const ctx = CTX;
    // O turno original reservou A e caiu antes do execute remoto.
    expect(
      store.claimConfirmation!({ ctx, intentionId: 'intent-A', operationId: 'op-A', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('claimed');
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-B', status: 'proposed' }] });
    const redelivery = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-A');

    // WRONG_OPERATION_CONFIRMED=0: B é a única decidível e segue pendente.
    // A reserva terminal liquidou para inconclusivo (o efeito é impossível
    // de provar — pode ser o execute perdido ou cancelamento alheio): o
    // vínculo segue bloqueando B para esta intention.
    expect(backend.executes).toHaveLength(0);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A', status: 'inconclusive' });
  });

  it('P1-1: redelivery durante executing preserva a reserva; vencedor liquida; replay posterior sucede', async () => {
    // O API aplica o efeito sob `executing` (listing autoritativo inclui o
    // status; o escopo `decidable` do agent, não). Tratar `executing` como
    // terminal liquidava a reserva `inconclusive` no meio da execução — o
    // settle `reserved → succeeded` do vencedor (CAS só transiciona
    // `reserved`) retornava false ignorado e o replay de sucesso se perdia.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    // Fluxo do vencedor até a janela de crash: sighting + claim adotada, com
    // a execução em voo no API (`executing`).
    expect(store.noteConfirmationSighted!(CTX, 'intent-A', NOW).fresh).toBe(true);
    expect(
      store.claimConfirmation!({ ctx: CTX, intentionId: 'intent-A', operationId: 'op-A', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('claimed');
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'executing' }] });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    // Reenvio intermediário com a execução suspensa: inconclusivo SEM settle.
    const mid = await confirmTurn(orchestrator, 'intent-A');
    expect(mid.mutation).toBeUndefined();
    expect(mid.response?.text).toBe(renderInconclusive());
    expect(backend.executes).toHaveLength(0);
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A', status: 'reserved' });

    // O vencedor conclui e liquida `reserved → succeeded` (CAS sucede porque
    // a reserva foi preservada); A sai do active set.
    expect(
      store.settleConfirmation!({ ctx: CTX, intentionId: 'intent-A', operationId: 'op-A', status: 'succeeded', receiptJson: validReceipt('op-A'), nowMs: NOW }),
    ).toBe(true);
    backend.active.length = 0;
    backend.active.push({ id: 'op-B', status: 'proposed' });

    // Replay posterior: sucesso idêntico com SQL + recibo, B intocada.
    const replayed = await confirmTurn(orchestrator, 'intent-A');
    expect(backend.executes).toHaveLength(0);
    expect(replayed.mutation?.status).toBe('succeeded');
    expect(replayed.mutation?.operationId).toBe('op-A');
    expect(replayed.mutation?.receipt).toEqual(JSON.parse(validReceipt('op-A')));
    expect(replayed.response?.text).toBe(renderMutationResult('succeeded'));
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
  });

  it('P1-1b: confirm falha com o alvo em executing → inconclusivo (nunca `failed`)', async () => {
    // O efeito pode ter aplicado antes do erro de transporte e o API segue
    // com a execução — um `failed` definitivo seria uma alegação falsa.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({
      active: [{ id: 'op-A', status: 'proposed' }],
      confirmBehavior: 'throw-keep-executing',
      store,
    });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, events), 'intent-A');

    expect(backend.executes).toEqual([{ operationId: 'op-A' }]);
    expect(backend.active).toMatchObject([{ id: 'op-A', status: 'executing' }]);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(answered.response?.text).not.toBe(renderMutationResult('failed'));
    expect(confirmationRows(sql)[0]).toMatchObject({ operationId: 'op-A', status: 'inconclusive' });
  });

  it('P1-2a: "sim" sem alvo persiste sentinela; B posterior nunca executa no redelivery', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [], store, nowMs: () => nowRef.now });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const first = await confirmTurn(orchestrator, 'intent-X');
    expect(first.mutation).toBeUndefined();
    expect(first.response?.text).toBe('Não há nenhuma operação pendente para confirmar.');
    expect(confirmationRows(sql)).toMatchObject([{ operationId: '', status: 'inconclusive' }]);

    // B aparece DEPOIS: o redelivery de X reproduz inconclusivo, nunca
    // resolve-e-confirma B (só um turno novo com nova intenção pode).
    backend.active.push({ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 1_000).toISOString() });
    // A proposta de B exibiu seu card (apresentação em T+1s): uma intenção
    // NOVA posterior pode confirmá-la; o redelivery de X, nunca.
    store.noteConfirmationPresentation?.({ ctx: CTX, operationIds: ['op-B'], nowMs: NOW + 1_000 });
    const redelivery = await confirmTurn(orchestrator, 'intent-X');
    expect(backend.executes).toHaveLength(0);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Disponibilidade preservada: intenção NOVA confirma B normalmente.
    nowRef.now = NOW + 2_000;
    const fresh = await confirmTurn(orchestrator, 'intent-Y');
    expect(fresh.mutation?.status).toBe('succeeded');
    expect(fresh.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('P1-2b: ambiguidade persiste sentinela; após A sair, redelivery não confirma B', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({
      active: [
        { id: 'op-A', status: 'proposed' },
        { id: 'op-B', status: 'proposed' },
      ],
    });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const first = await confirmTurn(orchestrator, 'intent-X');
    expect(first.mutation).toBeUndefined();
    expect(first.response?.text).toContain('Qual delas deseja confirmar?');
    expect(confirmationRows(sql)).toMatchObject([{ operationId: '', status: 'inconclusive' }]);

    // A é cancelada legitimamente; B segue a única pendente.
    backend.active.splice(0, 1);
    const redelivery = await confirmTurn(orchestrator, 'intent-X');
    expect(backend.executes).toHaveLength(0);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
  });

  it('P1-4: claim transiente falha → recuperação → B (mais nova que a sighting) é rejeitada; A legítima confirma', async () => {
    // Direções (i) admissibilidade temporal + (ii) evidência durável
    // pré-seleção (sighting/sentinela). A falha é localizada no claim: o
    // sighting (T0) foi persistido antes, então o redelivery pós-recuperação
    // encontra a sentinela inconclusiva e reproduz inconclusivo sem tocar a
    // listagem. Nota de fronteira (round 4, skew 5 s com `>=`): B nascida
    // exatamente em T0+5 s é rejeitada pelo check temporal (a fronteira
    // rejeita); a sentinela barra em defense-in-depth. B estritamente além
    // de T0+5 s cai no check temporal (regressão P1-A round 3 abaixo).
    const { sql } = createSql();
    const real = new SqlMutationDraftStore(sql);
    let claimFailures = 1;
    const flaky = wrapStore(real, {
      claimConfirmation: (input) => {
        if (claimFailures > 0) {
          claimFailures -= 1;
          throw new Error('injected_transient_claim_failure');
        }
        return real.claimConfirmation!(input);
      },
    });
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed', createdAt: new Date(NOW - 60_000).toISOString() }], store: flaky });
    const orchestrator = orchestratorFor(backend.coordinator, flaky, nowRef, events);

    const failed = await confirmTurn(orchestrator, 'intent-X');
    expect(blockedReason(events)).toBe('confirmation_reserve_failed');
    expect(backend.executes).toHaveLength(0);
    expect(failed.response?.text).toBe(renderInconclusive());
    // O catch deixou a sentinela unbound (store recuperável para o settle).
    expect(confirmationRows(sql)).toMatchObject([{ operationId: '', status: 'inconclusive' }]);

    // A é cancelada legitimamente; B nasce DEPOIS da sighting (T0 = NOW).
    backend.active.length = 0;
    backend.active.push({ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 5_000).toISOString() });
    nowRef.now = NOW + 10_000;
    const redelivery = await confirmTurn(orchestrator, 'intent-X');
    expect(backend.executes).toHaveLength(0);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Disponibilidade: com A ainda pendente (nascida antes da sighting),
    // uma NOVA intenção confirma A normalmente — a cerca é por intenção
    // (o redelivery de X segue inconclusivo para sempre: fail-closed).
    const { sql: sql2 } = createSql();
    const real2 = new SqlMutationDraftStore(sql2);
    let claimFailures2 = 1;
    const flaky2 = wrapStore(real2, {
      claimConfirmation: (input) => {
        if (claimFailures2 > 0) {
          claimFailures2 -= 1;
          throw new Error('injected_transient_claim_failure');
        }
        return real2.claimConfirmation!(input);
      },
    });
    const backend2 = fakeBackend({ active: [{ id: 'op-A', status: 'proposed', createdAt: new Date(NOW - 60_000).toISOString() }], store: flaky2 });
    const orchestrator2 = orchestratorFor(backend2.coordinator, flaky2, { now: NOW });
    await confirmTurn(orchestrator2, 'intent-X');
    const poisoned = await confirmTurn(orchestrator2, 'intent-X');
    expect(poisoned.mutation).toBeUndefined();
    expect(poisoned.response?.text).toBe(renderInconclusive());
    const recovered = await confirmTurn(orchestrator2, 'intent-X2');
    // A segue a única pendente e nasceu antes da sighting: confirma.
    expect(backend2.executes).toHaveLength(1);
    expect(recovered.mutation?.status).toBe('succeeded');
    expect(recovered.mutation?.operationId).toBe('op-A');
  });

  it('P1-4b: operação nascida depois da sighting é rejeitada pelo check temporal (fail-closed)', async () => {
    // Backstop da direção (i) quando nenhuma sentinela protege a intenção
    // (sighting fresca + operação futura — relógio do API à frente ou
    // proposta que pousou depois do "sim"): nunca confirma, só um turno
    // novo com nova intenção pode confirmar a operação mais nova.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({
      active: [{ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 120_000).toISOString() }],
      store,
      nowMs: () => nowRef.now,
    });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, events), 'intent-X');

    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(blockedReason(events)).toBe('confirmation_operation_newer_than_intention');
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Intenção nova confirma a mesma operação normalmente (a cerca é por
    // intenção, nunca global): a sighting nova é posterior à criação de B.
    nowRef.now = NOW + 180_000;
    const fresh = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-Y');
    expect(fresh.mutation?.status).toBe('succeeded');
    expect(fresh.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('round 3 P1-A: B nascida após o "sim" além de 5 s é rejeitada (janela antiga de 60 s admitia)', async () => {
    // A tolerância antiga (60 s) autorizava qualquer B nascida até 60 s após
    // a sighting — exatamente a janela "B surge durante a listagem". Com a
    // âncora no instante da mensagem (sighting durável T0) + tolerância de 5 s
    // (só skew relógio), B em T0+10 s é fail-closed. Sem sentinela prévia:
    // sighting fresca no turno, listagem com B única, temporal barra.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({
      active: [{ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 10_000).toISOString() }],
      store,
      nowMs: () => nowRef.now,
    });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, events), 'intent-X');

    expect(blockedReason(events)).toBe('confirmation_operation_newer_than_intention');
    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
    // Evidência durável da rejeição: sentinela unbound inconclusiva — um
    // redelivery futuro de X segue inconclusivo sem tocar a listagem.
    expect(confirmationRows(sql)).toMatchObject([{ operationId: '', status: 'inconclusive' }]);

    // Intenção nova confirma a mesma B normalmente (a cerca é por intenção).
    nowRef.now = NOW + 20_000;
    const fresh = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-Y');
    expect(fresh.mutation?.status).toBe('succeeded');
    expect(fresh.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('round 4 P1-B: outage TOTAL das duas gravações no turno 1 → redelivery pós-recuperação usa o vínculo API e nunca confirma B', async () => {
    // As DUAS escritas locais falham (sighting + fallback claim-path): zero
    // marcador local. Mas o bind da API (fronteira independente, anterior às
    // escritas locais) persistiu X@T0 — a redelivery pós-recuperação encontra
    // sighting API prévia + sighting local fresca e falha fechado pela regra
    // pós-outage, sem tocar a listagem: 0 executes em B, B intacta. Uma
    // intenção nova, sem vínculo, segue o caminho normal (B nunca apresentada
    // ⇒ apresenta fail-closed; com card ⇒ confirma).
    const { sql } = createSql();
    const real = new SqlMutationDraftStore(sql);
    let storeDown = true;
    const flaky = wrapStore(real, {
      noteConfirmationSighted: (ctx, intentionId, nowMs) => {
        if (storeDown) throw new Error('injected_total_outage');
        return real.noteConfirmationSighted!(ctx, intentionId, nowMs);
      },
      claimConfirmation: (input) => {
        if (storeDown) throw new Error('injected_total_outage');
        return real.claimConfirmation!(input);
      },
      settleConfirmation: (input) => {
        if (storeDown) throw new Error('injected_total_outage');
        return real.settleConfirmation!(input);
      },
    });
    const nowRef = { now: NOW };
    const events1: CapturedEvent[] = [];
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store: real, nowMs: () => nowRef.now });

    const first = await confirmTurn(orchestratorFor(backend.coordinator, flaky, nowRef, events1), 'intent-X');
    expect(blockedReason(events1)).toBe('confirmation_marker_unreadable');
    expect(backend.executes).toHaveLength(0);
    expect(first.mutation).toBeUndefined();
    expect(first.response?.text).toBe(renderInconclusive());
    // Outage total: NENHUMA linha local (nem sighting, nem fallback).
    expect(confirmationRows(sql)).toHaveLength(0);

    // A cancelada legitimamente; B nasce DEPOIS do instante da mensagem,
    // sem card exibido (nunca apresentada).
    backend.active.length = 0;
    backend.active.push({ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 10_000).toISOString() });

    // Store recupera; redelivery do MESMO intentionId.
    storeDown = false;
    nowRef.now = NOW + 30_000;
    const events2: CapturedEvent[] = [];
    const redelivery = await confirmTurn(orchestratorFor(backend.coordinator, real, nowRef, events2), 'intent-X');
    expect(backend.executes).toHaveLength(0);
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    // O vínculo API (X visto em T0) + sighting local fresca = redelivery
    // pós-outage: nunca confirma B com âncora reconstruída.
    expect(blockedReason(events2)).toBe('confirmation_post_outage_redelivery');
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Intenção nova Z: sem vínculo API, B nunca apresentada ⇒ fail-closed
    // (apresenta para o próximo turno), B intocada.
    const events3: CapturedEvent[] = [];
    await confirmTurn(orchestratorFor(backend.coordinator, real, nowRef, events3), 'intent-Z');
    expect(blockedReason(events3)).toBe('confirmation_operation_not_presented');
    expect(backend.executes).toHaveLength(0);
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Com o card de B exibido, a intenção seguinte confirma normalmente.
    real.noteConfirmationPresentation?.({ ctx: CTX, operationIds: ['op-B'], nowMs: NOW + 30_000 });
    nowRef.now = NOW + 40_000;
    const confirmed = await confirmTurn(orchestratorFor(backend.coordinator, real, nowRef), 'intent-W');
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(confirmed.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('isolamento por identidade: outra workspace/actor/device nunca herda o binding', async () => {    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({ active: [{ id: 'op-A', status: 'proposed' }], store });
    const orchestrator = orchestratorFor(backend.coordinator, store, nowRef);

    const first = await confirmTurn(orchestrator, 'intent-A');
    expect(first.mutation?.operationId).toBe('op-A');

    // CROSS_WORKSPACE_LEAK=0 / CROSS_ACTOR_LEAK=0: mesma intentionId string
    // noutra identidade não replaya nada e não confirma nada alheio.
    const foreignIdentities: AuthenticatedIdentity[] = [
      { ...IDENTITY, workspaceId: 'ws-other' },
      { ...IDENTITY, actorId: 'actor-other' },
      { ...IDENTITY, deviceId: 'device-other' },
    ];
    for (const foreign of foreignIdentities) {
      const answered = await confirmTurn(orchestrator, 'intent-A', foreign);
      expect(answered.mutation?.operationId).not.toBe('op-A');
    }
    expect(backend.executes).toEqual([{ operationId: 'op-A' }]);
    const rows = confirmationRows(sql);
    // 1 binding de A + 3 sentinelas unbound (uma por identidade estrangeira:
    // o `none` estrangeiro agora deixa evidência durável em vez de nada).
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ workspaceId: 'ws-harden', actorId: 'actor-harden', operationId: 'op-A' });
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({ operationId: '', status: 'inconclusive' });
    }
  });
});

describe('PR137-HARDEN round 4 (P1-A1/A2/A3)', () => {
  it('P1-A1: B nascida durante a sondagem pré-sighting (I/O do forget) é rejeitada; âncora = tEntry', async () => {
    // O relógio avança a cada leitura (I/O real leva tempo): tEntry é a
    // PRIMEIRA leitura do turno, antes de qualquer await. B nasce durante a
    // sondagem de precedência do forget (I/O 2535-2543, após a âncora) com
    // createdAt DENTRO do skew (+100ms): o temporal admite, mas B nunca foi
    // apresentada ⇒ `not_presented`, 0 executes. Sem a âncora síncrona + o
    // vínculo de apresentação, o código pré-round-4 confirmava B (sighting
    // carimbada pós-I/O + sem cerca de conjunto).
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const advancingNow = (): number => (nowRef.now += 25);
    let listedOnce = false;
    const backend = fakeBackend({
      active: [],
      store,
      nowMs: () => nowRef.now,
      listHook: () => {
        if (!listedOnce) {
          listedOnce = true;
          // B nasce DURANTE a primeira listagem (a sondagem do forget), com
          // carimbo dentro do skew — indistinguível por tempo, mas nunca
          // apresentada a esta identidade.
          backend.active.push({ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 100).toISOString() });
        }
      },
    });
    const memMock = createMemorySql();
    initializeMemorySchema(memMock as unknown as MemorySql);
    const events: CapturedEvent[] = [];
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({
        request: async () => {
          throw new Error('must_not_happen');
        },
      }),
      plan: confirmationPlan,
      coordinator: backend.coordinator,
      draftStore: store,
      draftNow: advancingNow,
      forgetMemory: { sql: memMock as unknown as MemorySql },
      events: (type: string, fields: Record<string, unknown>) => {
        events.push({ type, fields });
      },
    });

    const answered = await confirmTurn(orchestrator, 'intent-X');

    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(blockedReason(events)).toBe('confirmation_operation_not_presented');
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
    // A âncora precede todo o I/O: sighting.createdAt < createdAt de B
    // (nascida na janela). ROUND5-1: a rejeição NÃO deixa testemunho — a
    // listagem avistou B mas a resposta é só inconclusiva (sem card), então
    // nenhuma apresentação é gravada.
    const sightingRows = [
      ...sql.exec<Record<string, unknown>>(
        `SELECT created_at AS createdAt FROM mutation_confirmations WHERE intention_id = 'intent-X'`,
      ),
    ];
    const presentationRows = [
      ...sql.exec<Record<string, unknown>>(
        `SELECT presented_at AS presentedAt FROM mutation_confirmation_presentations WHERE operation_id = 'op-B'`,
      ),
    ];
    expect(sightingRows).toHaveLength(1);
    expect(presentationRows).toHaveLength(0);
    const anchorMs = Date.parse(String(sightingRows[0]?.createdAt));
    expect(anchorMs).toBeLessThan(NOW + 100);
  });

  it('P1-A2: B na fronteira exata (+5s) na 1ª listagem é rejeitada; intenção nova confirma', async () => {
    // A fronteira REJEITA (`>=`): B em T0+5s não executa no turno que a
    // avistou primeiro — só uma intenção nova. Sem vínculo prévio: sighting
    // fresca no turno, B única na listagem, temporal barra. O código
    // pré-round-4 (`>`) admitia a fronteira.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({
      active: [{ id: 'op-B', status: 'proposed', createdAt: new Date(NOW + 5_000).toISOString() }],
      store,
      nowMs: () => nowRef.now,
    });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, events), 'intent-X');

    expect(blockedReason(events)).toBe('confirmation_operation_newer_than_intention');
    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);
    expect(confirmationRows(sql)).toMatchObject([{ operationId: '', status: 'inconclusive' }]);

    // Intenção nova confirma a mesma B (a cerca é por intenção; a listagem
    // do turno anterior a apresentou, então o vínculo existe).
    nowRef.now = NOW + 20_000;
    const fresh = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-Y');
    expect(fresh.mutation?.status).toBe('succeeded');
    expect(fresh.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('P1-A3: B com createdAt forjado antigo (skew negativo) mas nunca apresentada é rejeitada; com card, nova intenção confirma', async () => {
    // Tempo como prova de identidade é insuficiente: B carrega createdAt 60s
    // ANTES da âncora (relógio da API atrás, ou carimbo forjado) e passa no
    // temporal — mas nunca pertenceu ao conjunto apresentado ⇒ rejeitada
    // mesmo dentro do skew. Só depois do card exibido (apresentação) uma
    // intenção nova pode confirmá-la. Sem o vínculo, o código pré-round-4
    // confirmava B neste turno.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const events: CapturedEvent[] = [];
    const backend = fakeBackend({
      active: [{ id: 'op-B', status: 'proposed', createdAt: new Date(NOW - 60_000).toISOString() }],
      // Sem `store`: B existe mas nunca foi apresentada (sem card, sem
      // disambiguação, sem listagem prévia registrada).
      nowMs: () => nowRef.now,
    });
    const answered = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, events), 'intent-X');

    expect(blockedReason(events)).toBe('confirmation_operation_not_presented');
    expect(backend.executes).toHaveLength(0);
    expect(answered.mutation).toBeUndefined();
    expect(answered.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // O card de B é exibido (apresentação em T+5s); a intenção seguinte a
    // confirma normalmente — o vínculo, não o tempo, autoriza.
    store.noteConfirmationPresentation?.({ ctx: CTX, operationIds: ['op-B'], nowMs: NOW + 5_000 });
    nowRef.now = NOW + 30_000;
    const confirmed = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-Y');
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(confirmed.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('ROUND5-1: rejeição nunca deixa testemunho — X rejeita B sem apresentá-la; Y sem card também rejeita; Z após proposta confirma', async () => {
    // Uma rejeição responde só `renderInconclusive()` (sem card/resumo de
    // B): registrar apresentação ali forjaria um testemunho sem exibição e
    // a intenção seguinte confirmaria B sem nunca tê-la visto. Regressão
    // em dois turnos + proposta real no fim.
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    const backend = fakeBackend({
      active: [{ id: 'op-B', status: 'proposed', createdAt: new Date(NOW - 60_000).toISOString() }],
      // Sem `store`: B existe mas nunca foi apresentada (sem card).
      nowMs: () => nowRef.now,
    });
    const countPresentations = (): number => [
      ...sql.exec<Record<string, unknown>>(`SELECT * FROM mutation_confirmation_presentations`),
    ].length;

    // Turno X rejeita B nunca apresentada: 0 executes, inconclusiva, e —
    // ponto deste teste — NENHUM testemunho de apresentação gravado.
    const eventsX: CapturedEvent[] = [];
    const answeredX = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, eventsX), 'intent-X');
    expect(blockedReason(eventsX)).toBe('confirmation_operation_not_presented');
    expect(backend.executes).toHaveLength(0);
    expect(answeredX.mutation).toBeUndefined();
    expect(answeredX.response?.text).toBe(renderInconclusive());
    expect(countPresentations()).toBe(0);

    // Nova intenção Y, ainda sem nenhum card de B: também rejeita (o turno
    // X não deixou testemunho) e continua sem gravar nada.
    nowRef.now = NOW + 10_000;
    const eventsY: CapturedEvent[] = [];
    const answeredY = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, eventsY), 'intent-Y');
    expect(blockedReason(eventsY)).toBe('confirmation_operation_not_presented');
    expect(backend.executes).toHaveLength(0);
    expect(answeredY.mutation).toBeUndefined();
    expect(answeredY.response?.text).toBe(renderInconclusive());
    expect(countPresentations()).toBe(0);
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Turno de proposta exibe B (card real); a intenção seguinte confirma.
    store.noteConfirmationPresentation?.({ ctx: CTX, operationIds: ['op-B'], nowMs: NOW + 15_000 });
    nowRef.now = NOW + 30_000;
    const confirmed = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef), 'intent-Z');
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(confirmed.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });

  it('ROUND5-2: fronteira same-ms — B apresentada DURANTE os awaits de X (mesmo ms) não entra no snapshot', async () => {
    // Relógio congelado: X entra em T0 com present-set vazio; B nasce e é
    // "apresentada" durante o I/O do turno com o MESMO carimbo T0. O check
    // antigo (`presentedAt <= anchor`) admitia a igualdade; o snapshot
    // lógico congelado na entrada não contém B ⇒ rejeita. A intenção Y,
    // cujo snapshot já inclui B, confirma normalmente. Temporal mantido
    // como defense-in-depth (createdAt de B passa nele de propósito).
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    const nowRef = { now: NOW };
    let pushed = false;
    const backend = fakeBackend({
      active: [],
      nowMs: () => nowRef.now,
      listHook: () => {
        if (pushed) return;
        pushed = true;
        backend.active.push({ id: 'op-B', status: 'proposed', createdAt: new Date(NOW).toISOString() });
        // Apresentação intra-turno no mesmo ms (nunca vista na entrada).
        store.noteConfirmationPresentation?.({ ctx: CTX, operationIds: ['op-B'], nowMs: NOW });
      },
    });
    const eventsX: CapturedEvent[] = [];
    const answeredX = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, eventsX), 'intent-X');
    expect(blockedReason(eventsX)).toBe('confirmation_operation_not_presented');
    expect(backend.executes).toHaveLength(0);
    expect(answeredX.mutation).toBeUndefined();
    expect(answeredX.response?.text).toBe(renderInconclusive());
    expect(backend.active.map((op) => op.id)).toEqual(['op-B']);

    // Snapshot posterior inclui B apresentada: Y confirma.
    const eventsY: CapturedEvent[] = [];
    const confirmed = await confirmTurn(orchestratorFor(backend.coordinator, store, nowRef, eventsY), 'intent-Y');
    expect(confirmed.mutation?.status).toBe('succeeded');
    expect(confirmed.mutation?.operationId).toBe('op-B');
    expect(backend.executes).toEqual([{ operationId: 'op-B' }]);
  });
});
