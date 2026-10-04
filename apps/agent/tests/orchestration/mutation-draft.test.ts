/**
 * MutationDraft multi-turno (SPEC §7.8/§25.3.1/§25.3.2 — ADR-014).
 *
 * The API boundary is mocked like the existing agent tests: a fake
 * `/pending-operations/v2/propose` that dedups by idempotencyKey exactly
 * like the real API (same key + same payload → existing; divergent payload
 * → 409). INV-09/INV-10 are asserted as: distinct operations per draft ≤ 1.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  buildDraftRecord,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };
const CARNE_BOVINA = { id: '00000000-0000-4000-8000-000000000021', name: 'Carne Bovina' };

const reader = (
  accounts = [NUBANK, ITAU],
  categories = [MERCADO],
  delayMs = 0,
): EntityReader => ({
  listAccounts: async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return accounts;
  },
  listCategories: async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return categories;
  },
});

type ScriptEntry = { persistThenThrow?: unknown; throw?: unknown };

const makeFakeApi = (script: ScriptEntry[] = []) => {
  const ops = new Map<string, { id: string; payload: string }>();
  const statusById = new Map<string, 'proposed' | 'cancelled'>();
  let seq = 0;
  const proposeKeys: Array<string | undefined> = [];
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    // T1.5 authoritative surface used by the coordinator: listing returns
    // every non-cancelled op (all start `proposed` in this fake), cancel
    // persists the terminal state before any reply is built.
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      const items = [...ops.values()]
        .filter((op) => (statusById.get(op.id) ?? 'proposed') !== 'cancelled')
        .map((op) => {
          const parsed = JSON.parse(op.payload) as { tool?: unknown; normalizedArgs?: Record<string, unknown> };
          const args = (parsed.normalizedArgs ?? {}) as Record<string, unknown>;
          return {
            id: op.id,
            status: statusById.get(op.id) ?? 'proposed',
            tool: parsed.tool,
            createdAt: '2026-09-14T00:00:00.000Z',
            expiresAt: '2026-09-14T01:00:00.000Z',
            ...(typeof args.amountCents === 'number' ? { amountCents: args.amountCents } : {}),
            ...(typeof args.description === 'string' ? { description: args.description } : {}),
            ...(typeof args.date === 'string' ? { date: args.date } : {}),
            ...(typeof args.accountId === 'string' ? { accountId: args.accountId } : {}),
          };
        });
      return { items, total: items.length };
    }
    const cancelMatch = /^\/pending-operations\/v2\/([^/]+)\/cancel$/.exec(path);
    if (method === 'POST' && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]!);
      const op = [...ops.values()].find((entry) => entry.id === id);
      if (!op) {
        const missing = new Error('approval.not_found');
        (missing as { statusCode?: number }).statusCode = 404;
        throw missing;
      }
      statusById.set(id, 'cancelled');
      return { id, status: 'cancelled' };
    }
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const key = opts?.idempotencyKey;
      proposeKeys.push(key);
      // Canonical fingerprint (tool + normalizedArgs): expiresAt and other
      // envelope fields rotate per emission and must not fork the operation.
      const wireBody = (opts?.body ?? {}) as { tool?: unknown; normalizedArgs?: unknown };
      const payload = JSON.stringify({ tool: wireBody.tool, normalizedArgs: wireBody.normalizedArgs });
      const step = script.shift();
      if (step?.persistThenThrow) {
        if (!ops.has(key ?? '')) {
          seq += 1;
          ops.set(key ?? '', { id: `pending-${seq}`, payload });
          statusById.set(`pending-${seq}`, 'proposed');
        }
        throw step.persistThenThrow;
      }
      if (step?.throw) throw step.throw;
      const known = ops.get(key ?? '');
      if (known) {
        if (known.payload !== payload) {
          const conflict = new Error('idempotency.conflict');
          (conflict as { statusCode?: number }).statusCode = 409;
          throw conflict;
        }
        return { id: known.id, existing: true };
      }
      seq += 1;
      const id = `pending-${seq}`;
      ops.set(key ?? '', { id, payload });
      statusById.set(id, 'proposed');
      return { id };
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  const proposePosts = () => request.mock.calls.filter((call) => call[0] === 'POST' && call[1] === '/pending-operations/v2/propose').length;
  const opStatus = (id: string): string => statusById.get(id) ?? 'unknown';
  return { api: new MutationApiClient({ request }), request, ops, proposeKeys, proposePosts, opStatus };
};

const timeoutError = () => new Error('fetch failed');
const definitiveError = () => Object.assign(new Error('validation.failed'), { statusCode: 400 });

const ctxOf = () => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
});

const setup = (
  fake: ReturnType<typeof makeFakeApi>,
  store: MutationDraftStore,
  options: { now?: () => number; maxAttempts?: number; entityReader?: EntityReader } = {},
) =>
  new ConversationOrchestrator({
    mutationApiClient: fake.api,
    entityReader: options.entityReader ?? reader(),
    draftStore: store,
    ...(options.now ? { draftNow: options.now } : {}),
    ...(options.maxAttempts !== undefined ? { draftMaxProposeAttempts: options.maxAttempts } : {}),
  });

const turn = (orchestrator: ConversationOrchestrator, text: string, intentionId: string) =>
  orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));

describe('SPEC §25.3.1 — MutationDraft multi-turno', () => {
  it('happy flow: incomplete → draft → continuation completes with correct args', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store);
    const first = await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-draft-happy-1');
    expect(first.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(first.clarification?.missingFields).toContain('accountId');
    expect(first.clarification?.draft).toMatchObject({ tool: 'transactions.expense.create', missingFields: ['accountId'] });
    expect(Object.keys(first.clarification?.draft ?? {}).sort()).toEqual(
      ['draftId', 'expiresAt', 'missingFields', 'question', 'tool'],
    );

    const second = await turn(orchestrator, 'Nubank', 'msg-draft-happy-2');
    expect(second.mutation?.operationId).toMatch(/^pending-/);
    expect(fake.proposePosts()).toBe(1);
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 8500,
      description: 'mercado',
      accountId: NUBANK.id,
      categoryId: MERCADO.id,
    });
    expect(body?.body?.normalizedArgs).not.toHaveProperty('categoryQuery');
    expect(second.response?.text).toMatch(/Proposta/);
  });

  // R03/AC08: the category clarification is only usable if answering it
  // completes the draft — "carne" stays the description and the category the
  // user names in the answer is the explicit category statement.
  it('R03: answering the category clarification completes the draft with the named category', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { entityReader: reader([NUBANK], [CARNE_BOVINA]) });

    const first = await turn(orchestrator, 'gastei 50 de carne', 'msg-draft-category-1');
    expect(first.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(first.clarification?.missingFields).toEqual(['categoryId']);
    expect(first.response?.text).toMatch(/qual categoria/i);

    const second = await turn(orchestrator, 'categoria Carne Bovina', 'msg-draft-category-2');
    expect(fake.proposePosts()).toBe(1);
    expect(second.mutation?.operationId).toMatch(/^pending-/);
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      description: 'carne',
      accountId: NUBANK.id,
      categoryId: CARNE_BOVINA.id,
    });
  });

  // R03: the explicit category survives while another field stays pending —
  // answering the remaining question must not lose the accepted choice.
  it('R03: an accepted category is kept while the account is still pending', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { entityReader: reader([NUBANK, ITAU], [CARNE_BOVINA]) });

    const first = await turn(orchestrator, 'gastei 50 de carne', 'msg-draft-keep-category-1');
    expect(first.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(first.clarification?.missingFields).toEqual(['accountId', 'categoryId']);

    // The category is accepted and only the account is asked for now.
    const second = await turn(orchestrator, 'categoria Carne Bovina', 'msg-draft-keep-category-2');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(second.clarification?.missingFields).toEqual(['accountId']);
    expect(second.response?.text).toMatch(/conta/i);
    expect(second.response?.text).not.toMatch(/qual categoria/i);

    const third = await turn(orchestrator, 'Nubank', 'msg-draft-keep-category-3');
    expect(third.clarification?.missingFields ?? []).not.toContain('categoryId');
    expect(fake.proposePosts()).toBe(1);
    expect(third.mutation?.operationId).toMatch(/^pending-/);
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      description: 'carne',
      accountId: NUBANK.id,
      categoryId: CARNE_BOVINA.id,
    });
  });

  it('expired draft: short answer executes nothing', async () => {
    let now = 1_700_000_000_000;
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => now });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-draft-exp-1');
    expect(store.listActive(ctxOf(), now)).toHaveLength(1);
    now += 16 * 60_000;
    const second = await turn(orchestrator, 'Nubank', 'msg-draft-exp-2');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    // No live draft exists, so nothing executes; the legacy unsupported turn
    // carries no fabricated proposal either.
    expect(second.clarification?.draft).toBeUndefined();
  });

  it('2 compatible drafts: disambiguation, no propose', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const now = Date.now();
    for (const [intention, description] of [['msg-amb-1', 'mercado'], ['msg-amb-2', 'farmacia']] as const) {
      store.getOrCreate(
        buildDraftRecord({
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          deviceId: identity.deviceId ?? null,
          intentionId: intention,
          tool: 'transactions.expense.create',
          resolvedArgs: { kind: 'expense', amountCents: 1000, description, date: '2026-09-14' },
          missingFields: ['accountId'],
          question: 'Em qual conta devo registrar?',
          nowMs: now,
        }),
      );
    }
    const orchestrator = setup(fake, store);
    const result = await turn(orchestrator, 'Nubank', 'msg-amb-3');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(result.response?.text).toMatch(/mais de uma inten/);
  });

  it('"cancela": active draft discarded, no pending operation', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store);
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-cancel-1');
    const cancelled = await turn(orchestrator, 'cancela', 'msg-cancel-2');
    expect(fake.proposePosts()).toBe(0);
    expect(cancelled.response?.text).toMatch(/cancelada/);
    const ctx = ctxOf();
    expect(store.listActive(ctx, Date.now())).toHaveLength(0);
    const discarded = store.findByIntention(ctx, 'msg-cancel-1');
    expect(discarded?.status).toBe('discarded');
  });

  it('incompatible new intention: replaced, zero field inheritance', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store);
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-replace-1');
    const second = await turn(orchestrator, 'esquece isso, recebi 500 reais no Nubank categoria mercado', 'msg-replace-2');
    expect(second.mutation?.operationId).toMatch(/^pending-/);
    const proposes = fake.request.mock.calls.filter((call) => call[0] === 'POST');
    const body = proposes[proposes.length - 1]?.[2] as { body?: { tool?: string; normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.tool).toBe('transactions.income.create');
    expect(body?.body?.normalizedArgs).toMatchObject({ amountCents: 50000 });
    expect(body?.body?.normalizedArgs?.description).not.toBe('mercado');
    const ctx = ctxOf();
    expect(store.findByIntention(ctx, 'msg-replace-1')?.status).toBe('replaced');
  });

  it('same-turn resend after lost HTTP: no duplicate draft', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store);
    const first = await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-resend-1');
    const second = await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-resend-1');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(second.clarification?.draft?.draftId).toBe(first.clarification?.draft?.draftId);
    const ctx = ctxOf();
    expect(store.listActive(ctx, Date.now())).toHaveLength(1);
  });

  it('two concurrent continuations: exactly one proposal (CAS)', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    // Seed the draft with a plain reader: the assertions below must start
    // from exactly one active draft.
    const seedOrchestrator = setup(fake, store);
    await turn(seedOrchestrator, 'Gastei R$ 85 no mercado', 'msg-cas-1');
    // Deterministic rendezvous barriers (flake fix): the old 10ms-delay +
    // Promise.all did NOT guarantee both continuations reached the CAS
    // (mutation-draft.ts:266-282, synchronous in-memory) before the winner
    // consumed the proposal — on CI the winner could consume first and the
    // loser would then reuse the SAME proposal via handleCasLoss
    // (conversation-orchestrator.ts:579-590), yielding 2 mutations.
    // Barrier 1 (pre-CAS): each continuation issues exactly 2 reader calls
    // (listAccounts + listCategories via Promise.allSettled in
    // resolveMutationEntities). Hold every reader call until all 4 have been
    // entered, so both continuations provably reach the CAS together.
    let readerEntries = 0;
    let releaseReads: () => void = () => {};
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const gateReads = async <T>(value: T): Promise<T> => {
      readerEntries += 1;
      if (readerEntries >= 4) releaseReads();
      await readsReleased;
      return value;
    };
    const gatedReader: EntityReader = {
      listAccounts: async () => gateReads([NUBANK, ITAU]),
      listCategories: async () => gateReads([MERCADO]),
    };
    // Barrier 2 (propose): hold the winner's propose resolution until the
    // loser has also concluded its CAS attempt (2 CAS calls observed). The
    // loser then deterministically sees status 'proposing' → inconclusive,
    // never reusing a consumed proposal.
    let casCalls = 0;
    let releasePropose: () => void = () => {};
    const loserSettled = new Promise<void>((resolve) => {
      releasePropose = resolve;
    });
    const rawCas = store.cas.bind(store);
    vi.spyOn(store, 'cas').mockImplementation((...args: Parameters<typeof store.cas>) => {
      const result = rawCas(...args);
      casCalls += 1;
      if (casCalls >= 2) releasePropose();
      return result;
    });
    const rawRequest = fake.request.getMockImplementation() as
      ((...args: unknown[]) => Promise<unknown>) | undefined;
    fake.request.mockImplementation(async (...args: unknown[]) => {
      const [method, path] = args as [string, string];
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        await loserSettled;
      }
      return rawRequest?.(...args);
    });
    const orchestrator = setup(fake, store, { entityReader: gatedReader });
    const [a, b] = await Promise.all([
      turn(orchestrator, 'Nubank', 'msg-cas-2a'),
      turn(orchestrator, 'Nubank', 'msg-cas-2b'),
    ]);
    expect(fake.proposePosts()).toBe(1);
    expect(fake.ops.size).toBe(1);
    const winners = [a, b].filter((result) => result.mutation !== undefined);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((result) => result.mutation === undefined)!;
    expect(loser.response?.text).toBeTruthy();
    expect(loser.response?.text).not.toMatch(/Proposta/);
  });

  it('continuation racing "cancela": first event wins, at most one operation', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { entityReader: reader([NUBANK, ITAU], [MERCADO], 10) });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-race-1');
    const [continuation, cancel] = await Promise.all([
      turn(orchestrator, 'Nubank', 'msg-race-2'),
      turn(orchestrator, 'cancela', 'msg-race-3'),
    ]);
    expect(continuation).toBeDefined();
    expect(cancel).toBeDefined();
    expect(fake.ops.size).toBeLessThanOrEqual(1);
    const ctx = ctxOf();
    expect(store.listActive(ctx, Date.now())).toHaveLength(0);
    if (fake.ops.size === 1) {
      // T1.5 (SPEC §8.5/INV-10): whenever an operation exists after the
      // race, it must have been cancelled authoritatively — "cancelada" is
      // only ever answered with no live operation remaining.
      const opId = [...fake.ops.values()][0]!.id;
      expect(fake.opStatus(opId)).toBe('cancelled');
      expect(cancel.response?.text).toMatch(/cancelada|processamento/);
    } else {
      // Cancel won before any proposal: nothing may have been created.
      expect(cancel.response?.text).toMatch(/cancelada/);
    }
  });

  it('resend after consumption: existing proposal reused, no second operation', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store);
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-reuse-1');
    const completed = await turn(orchestrator, 'Nubank', 'msg-reuse-2');
    const callsAfterComplete = fake.proposePosts();
    expect(callsAfterComplete).toBe(1);
    const resent = await turn(orchestrator, 'Nubank', 'msg-reuse-2');
    expect(resent.mutation?.operationId).toBe(completed.mutation?.operationId);
    expect(fake.proposePosts()).toBe(callsAfterComplete);
    expect(fake.ops.size).toBe(1);
  });

  it('draft never holds attestation material', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store);
    const first = await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-noatt-1');
    const draftId = first.clarification?.draft?.draftId;
    expect(draftId).toBeTruthy();
    const record = store.get(draftId!);
    expect(JSON.stringify(record)).not.toMatch(/attest/i);
  });
});

describe('SPEC §25.3.2 — handoff MutationDraft → PendingOperation', () => {
  it('case A: API persisted but response lost → retry same key → same operation, consumed', async () => {
    const fake = makeFakeApi([{ persistThenThrow: timeoutError() }], );
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { maxAttempts: 1 });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-a-1');
    const inconclusive = await turn(orchestrator, 'Nubank', 'msg-a-2');
    expect(inconclusive.mutation).toBeUndefined();
    expect(inconclusive.response?.text).toMatch(/processamento/);
    expect(fake.ops.size).toBe(1);
    const keys = fake.proposeKeys.filter(Boolean);
    expect(new Set(keys).size).toBe(1);
    // Redelivery of the lost turn converges to the SAME operation.
    const recovered = await turn(orchestrator, 'Nubank', 'msg-a-2');
    expect(recovered.mutation?.operationId).toBeDefined();
    expect(fake.ops.size).toBe(1);
    const ctx = ctxOf();
    const draft = store.findByIntention(ctx, 'msg-a-1');
    expect(draft?.status).toBe('consumed');
    expect(draft?.proposalId).toBe(recovered.mutation?.operationId);
    expect(draft?.proposeOutcome).toBe('existing');
  });

  it('case B: crash before the API call → restart → same key → exactly 1 operation', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const firstOrchestrator = setup(fake, store);
    await turn(firstOrchestrator, 'Gastei R$ 85 no mercado', 'msg-b-1');
    // Crash simulation: the continuation won the CAS (complete args staged)
    // then died before any HTTP call — the store is the only survivor.
    const ctx = ctxOf();
    const draft = store.findByIntention(ctx, 'msg-b-1')!;
    expect(fake.proposePosts()).toBe(0);
    store.update(draft.draftId, {
      resolvedArgs: { ...draft.resolvedArgs, accountId: NUBANK.id, categoryId: MERCADO.id },
      missingFields: [],
    });
    const cas = store.cas(draft.draftId, 'active', 'proposing', { lastIntentionId: 'msg-b-2' });
    expect(cas.ok).toBe(true);
    // Restart: brand-new orchestrator over the same DO storage.
    const restarted = setup(fake, store);
    const recovered = await turn(restarted, 'Nubank', 'msg-b-3');
    expect(fake.proposePosts()).toBe(1);
    expect(fake.ops.size).toBe(1);
    expect(store.get(draft.draftId)?.status).toBe('consumed');
    expect(recovered.response?.text).toBeTruthy();
  });

  it('case C: definitive 4xx → discarded (propose_rejected), never silently consumed', async () => {
    const fake = makeFakeApi([{ throw: definitiveError() }]);
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { maxAttempts: 1 });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'msg-c-1');
    const result = await turn(orchestrator, 'Nubank', 'msg-c-2');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/Não foi possível concluir/);
    expect(fake.ops.size).toBe(0);
    const ctx = ctxOf();
    const draft = store.findByIntention(ctx, 'msg-c-1');
    expect(draft?.status).toBe('discarded');
    expect(draft?.proposeOutcome).toBe('rejected');
  });

  it('case D: concurrent same-key proposes → single operation (API dedup)', async () => {
    const fake = makeFakeApi();
    const key = 'deadbeef-same-key';
    const payload = {
      body: { tool: 'transactions.expense.create', normalizedArgs: { amountCents: 100 }, expiresAt: 'x' },
      idempotencyKey: key,
    };
    const first = await fake.request('POST', '/pending-operations/v2/propose', payload);
    const second = await fake.request('POST', '/pending-operations/v2/propose', payload);
    expect(second).toMatchObject({ id: (first as { id: string }).id, existing: true });
    expect(fake.ops.size).toBe(1);
  });

  it('case E: "cancela" during proposing with existing operation → authoritative cancel, then "cancelado"', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const now = Date.now();
    const seed = store.getOrCreate(
      buildDraftRecord({
        workspaceId: identity.workspaceId,
        actorId: identity.actorId,
        deviceId: identity.deviceId ?? null,
        intentionId: 'msg-e-1',
        tool: 'transactions.expense.create',
        resolvedArgs: {
          kind: 'expense',
          amountCents: 8500,
          description: 'mercado',
          date: '2026-09-14',
          accountId: NUBANK.id,
          categoryId: MERCADO.id,
        },
        missingFields: [],
        question: 'q',
        nowMs: now,
      }),
    );
    store.cas(seed.record.draftId, 'active', 'proposing', { lastIntentionId: 'msg-e-2' });
    // The API already persisted under the same key (crash-after-persist).
    await fake.request('POST', '/pending-operations/v2/propose', {
      body: {
        tool: 'transactions.expense.create',
        normalizedArgs: {
          amountCents: 8500,
          description: 'mercado',
          date: '2026-09-14',
          accountId: NUBANK.id,
          categoryId: MERCADO.id,
        },
        expiresAt: 'x',
      },
      idempotencyKey: seed.record.proposalIdempotencyKey,
    });
    const orchestrator = setup(fake, store);
    const result = await turn(orchestrator, 'cancela', 'msg-e-3');
    // T1.5 (SPEC §8.5): the same-key outcome resolved to the existing
    // operation, which is cancelled authoritatively BEFORE replying.
    expect(result.response?.text).toMatch(/cancelada/);
    expect(result.response?.text).not.toMatch(/cartão de aprovação/);
    expect(result.mutation).toBeUndefined();
    expect(fake.ops.size).toBe(1);
    expect(store.get(seed.record.draftId)?.status).toBe('consumed');
    const opId = [...fake.ops.values()][0]!.id;
    expect(fake.opStatus(opId)).toBe('cancelled');
    const cancels = fake.request.mock.calls.filter(
      (call) => call[0] === 'POST' && typeof call[1] === 'string' && call[1].endsWith('/cancel'),
    );
    expect(cancels).toHaveLength(1);
  });

  it('case E-unknown: "cancela" with unresolvable outcome → inconclusive, stays proposing', async () => {
    const fake = makeFakeApi([{ throw: timeoutError() }]);
    const store = new InMemoryMutationDraftStore();
    const now = Date.now();
    const seed = store.getOrCreate(
      buildDraftRecord({
        workspaceId: identity.workspaceId,
        actorId: identity.actorId,
        deviceId: identity.deviceId ?? null,
        intentionId: 'msg-eu-1',
        tool: 'transactions.expense.create',
        resolvedArgs: {
          kind: 'expense',
          amountCents: 8500,
          description: 'mercado',
          date: '2026-09-14',
          accountId: NUBANK.id,
          categoryId: MERCADO.id,
        },
        missingFields: [],
        question: 'q',
        nowMs: now,
      }),
    );
    store.cas(seed.record.draftId, 'active', 'proposing', { lastIntentionId: 'msg-eu-2' });
    const orchestrator = setup(fake, store);
    const result = await turn(orchestrator, 'cancela', 'msg-eu-3');
    expect(result.response?.text).toMatch(/processamento/);
    expect(result.response?.text).not.toMatch(/cancelada/);
    expect(store.get(seed.record.draftId)?.status).toBe('proposing');
  });
});
