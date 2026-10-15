/**
 * FIX-DUP-PROPOSAL — redelivery of a contributing intention must recover the
 * SAME draft/proposal, never create a second pending operation.
 *
 * Production anchor: 1 turno → 2 pending_operations (7s aparte, chaves
 * distintas, 2ª sem vínculo de confirmação). Root cause: the draft lookup is
 * keyed ONLY on `last_intention_id`, which every continuation overwrites — so
 * after intention J completes/consumes a draft created by intention I, a
 * redelivery of I misses the lookup and the fresh flow proposes anew under a
 * different idempotency key. The in-memory store accidentally converges (its
 * `byIntention` map accumulates every toucher); the SQL store does not.
 * These tests assert store parity + end-to-end single-effect redelivery.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  appendOriginMessage,
  buildDraftRecord,
  initializeMutationDraftSchema,
  InMemoryMutationDraftStore,
  SqlMutationDraftStore,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const ctxOf = () => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
});

const NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

const reader = (accounts = [NUBANK, ITAU], categories = [MERCADO]): EntityReader => ({
  listAccounts: async () => accounts,
  listCategories: async () => categories,
});

const mutationPlan = () => ({
  version: '2' as const,
  mode: 'mutation-proposal' as const,
  domain: 'transactions' as const,
  skillNames: ['transactions'],
  requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' as const }],
  missingFields: [] as readonly string[],
  ambiguity: null,
  confidence: 1,
});

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createSqlStore = (): MutationDraftStore => {
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
  return new SqlMutationDraftStore(sql);
};

const makeFakeApi = () => {
  const ops = new Map<string, string>();
  let seq = 0;
  const proposeKeys: Array<string | undefined> = [];
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const key = opts?.idempotencyKey;
      proposeKeys.push(key);
      const known = key ? ops.get(key) : undefined;
      if (known) return { id: known, existing: true };
      seq += 1;
      const id = `pending-${seq}`;
      if (key) ops.set(key, id);
      return { id };
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  const proposePosts = () =>
    request.mock.calls.filter((call) => call[0] === 'POST' && call[1] === '/pending-operations/v2/propose').length;
  return { api: new MutationApiClient({ request }), request, proposeKeys, proposePosts };
};

const setup = (fake: ReturnType<typeof makeFakeApi>, store: MutationDraftStore, entityReader: EntityReader) =>
  new ConversationOrchestrator({
    mutationApiClient: fake.api,
    entityReader,
    draftStore: store,
    plan: mutationPlan,
  });

const draftSeed = (intentionId: string) => ({
  workspaceId: ctxOf().workspaceId,
  actorId: ctxOf().actorId,
  deviceId: ctxOf().deviceId,
  intentionId,
  tool: 'transactions.expense.create' as const,
  resolvedArgs: {
    kind: 'expense' as const,
    amountCents: 8500,
    description: 'mercado',
    date: '2026-10-15',
  },
  missingFields: ['accountId'] as readonly string[],
  question: 'Em qual conta devo registrar?',
});

describe('FIX-DUP-PROPOSAL: contributor intention recovers the consumed draft (store parity)', () => {
  const cases: ReadonlyArray<readonly [string, () => MutationDraftStore]> = [
    ['memory', () => new InMemoryMutationDraftStore()],
    ['sqlite', () => createSqlStore()],
  ];
  for (const [name, createStore] of cases) {
    it(`[${name}] I creates draft, J completes/consumes, redelivered I recovers the SAME proposal`, () => {
      const store = createStore();
      const ctx = ctxOf();
      const seed = store.getOrCreate(buildDraftRecord(draftSeed('intent-I')));
      expect(seed.created).toBe(true);

      // Intention J continues the draft (as `continueDraft` does: touch +
      // lastIntentionId overwrite + origin append).
      const touched = store.update(seed.record.draftId, {
        updatedAt: new Date().toISOString(),
        lastIntentionId: 'intent-J',
        lastQuestion: 'Em qual conta devo registrar?',
        originMessages: appendOriginMessage(seed.record.originMessages, 'intent-J'),
      });
      expect(touched?.lastIntentionId).toBe('intent-J');

      // Intention J completes and consumes with the draft propose key.
      const consumed = store.update(seed.record.draftId, {
        status: 'consumed',
        proposalId: 'pending-1',
        proposeOutcome: 'created',
        updatedAt: new Date().toISOString(),
        lastIntentionId: 'intent-J',
      });
      expect(consumed?.status).toBe('consumed');

      // Redelivery of the ORIGINAL contributor I must recover the same
      // draft/proposal — never miss (a miss re-enters the fresh flow and
      // proposes anew under a different key).
      expect(store.findByIntention(ctx, 'intent-I')?.proposalId).toBe('pending-1');
      expect(store.findByIntention(ctx, 'intent-J')?.proposalId).toBe('pending-1');
    });
  }
});

describe('FIX-DUP-PROPOSAL: end-to-end — one turn, one pending operation', () => {
  const cases: ReadonlyArray<readonly [string, () => MutationDraftStore]> = [
    ['memory', () => new InMemoryMutationDraftStore()],
    ['sqlite', () => createSqlStore()],
  ];
  for (const [name, createStore] of cases) {
    it(`[${name}] redelivered I after J consumed reuses pending-1 (no second propose)`, async () => {
      const store = createStore();
      const fake = makeFakeApi();
      // First delivery: two accounts → account stays pending → draft.
      const orch1 = setup(fake, store, reader([NUBANK, ITAU], [MERCADO]));
      const first = await orch1.runTurn(
        normalizeRestTurn({ text: 'Gastei R$ 85 no mercado', intentionId: 'msg-dup-I' }, identity),
      );
      expect(first.mutation).toBeUndefined();
      expect(fake.proposePosts()).toBe(0);

      // Continuation J completes the draft → single propose (draft key).
      const completed = await orch1.runTurn(
        normalizeRestTurn({ text: 'Nubank', intentionId: 'msg-dup-J' }, identity),
      );
      expect(completed.mutation?.operationId).toBe('pending-1');
      expect(fake.proposePosts()).toBe(1);

      // Redelivery of I 7s later, entity lists reloaded (single account now
      // auto-resolves, so the fresh flow WOULD propose if the lookup missed).
      const orch2 = setup(fake, store, reader([NUBANK], [MERCADO]));
      const redelivered = await orch2.runTurn(
        normalizeRestTurn({ text: 'Gastei R$ 85 no mercado', intentionId: 'msg-dup-I' }, identity),
      );
      expect(redelivered.mutation?.operationId).toBe('pending-1');
      expect(fake.proposePosts()).toBe(1);
      expect(new Set(fake.proposeKeys).size).toBe(1);
    });

    it(`[${name}] a genuinely NEW intention still proposes distinctly (no false merge)`, async () => {
      const store = createStore();
      const fake = makeFakeApi();
      const orch = setup(fake, store, reader([NUBANK], [MERCADO]));
      const first = await orch.runTurn(
        normalizeRestTurn({ text: 'Gastei R$ 85 no mercado', intentionId: 'msg-new-A' }, identity),
      );
      const second = await orch.runTurn(
        normalizeRestTurn({ text: 'Gastei R$ 85 no mercado', intentionId: 'msg-new-B' }, identity),
      );
      expect(first.mutation?.operationId).toBe('pending-1');
      expect(second.mutation?.operationId).toBe('pending-2');
      expect(fake.proposePosts()).toBe(2);
    });
  }
});

describe('FIX-DUP-PROPOSAL-R2: durable link wins over hijacked last_intention_id (store parity)', () => {
  const cases: ReadonlyArray<readonly [string, () => MutationDraftStore]> = [
    ['memory', () => new InMemoryMutationDraftStore()],
    ['sqlite', () => createSqlStore()],
  ];
  for (const [name, createStore] of cases) {
    it(`[${name}] findByIntention(I) returns A after B hijacks lastIntentionId=I`, () => {
      const store = createStore();
      const ctx = ctxOf();
      const a = store.getOrCreate(buildDraftRecord(draftSeed('intent-R2-I')));
      expect(a.created).toBe(true);
      const b = store.getOrCreate(buildDraftRecord(draftSeed('intent-R2-J')));
      expect(b.created).toBe(true);
      expect(b.record.draftId).not.toBe(a.record.draftId);

      // B is later touched with A's intention id (stale replay / crossed
      // update overwriting the mutable fast-path column).
      const hijacked = store.update(b.record.draftId, {
        updatedAt: new Date().toISOString(),
        lastIntentionId: 'intent-R2-I',
      });
      expect(hijacked?.lastIntentionId).toBe('intent-R2-I');

      // The immutable first-writer link (A ↔ I) wins over the hijacked
      // mutable fast-path column (B.last_intention_id = I).
      expect(store.findByIntention(ctx, 'intent-R2-I')?.draftId).toBe(a.record.draftId);
      expect(store.findByIntention(ctx, 'intent-R2-J')?.draftId).toBe(b.record.draftId);
    });
  }
});

describe('FIX-DUP-PROPOSAL-R2: selective draft-table outage degrades to miss', () => {
  it('[sqlite] index ok + draft-table read failure → miss, never throws', () => {
    const db = new DatabaseSync(':memory:');
    let failDraftReads = false;
    const sql: SqlShim = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        // Fault injection: every read of the drafts table fails, while the
        // durable intention index keeps answering. (`mutation_drafts\b`
        // never matches `mutation_draft_intentions`: `_` is a word char, so
        // there is no boundary after `drafts` there.)
        if (failDraftReads && /FROM\s+mutation_drafts\b/i.test(query)) {
          throw new Error('injected draft-table outage');
        }
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
          return statement.all(...(bindings as never[])) as T[];
        }
        statement.run(...(bindings as never[]));
        return [] as T[];
      },
    };
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    const ctx = ctxOf();
    const seed = store.getOrCreate(buildDraftRecord(draftSeed('intent-R2-K')));
    expect(seed.created).toBe(true);
    expect(store.findByIntention(ctx, 'intent-R2-K')?.draftId).toBe(seed.record.draftId);

    failDraftReads = true;
    let result: ReturnType<MutationDraftStore['findByIntention']> = undefined;
    expect(() => {
      result = store.findByIntention(ctx, 'intent-R2-K');
    }).not.toThrow();
    expect(result).toBeUndefined();
  });
});
