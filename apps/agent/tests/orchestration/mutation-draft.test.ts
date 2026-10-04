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
  DRAFT_RELATIONS,
  InMemoryMutationDraftStore,
  MAX_DRAFT_ORIGIN_MESSAGES,
  appendDraftRelation,
  appendOriginMessage,
  buildDraftRecord,
  type MutationDraftRecord,
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
    // Barrier 2 (propose): yield the microtask queue before the winner's propose
    // is issued. The loser's conclusion is PURELY in-memory (its consume write
    // is refused or its CAS misses, A07/RR fix 1b), so it always completes
    // before the next macrotask — deterministically, without counting calls:
    // the loser observes `proposing` and converges inconclusive instead of
    // reusing the winner's now-consumed proposal.
    const loserSettled = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
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

describe('A07/R07 — goal metadata, fragments and corrections', () => {
  // Fixed instant: 2026-09-14T18:00Z is 15:00 in America/Sao_Paulo, so the
  // draft date is 2026-09-14 and "ontem" is 2026-09-13.
  const NOW_MS = Date.parse('2026-09-14T18:00:00.000Z');
  const TODAY = '2026-09-14';
  const YESTERDAY = '2026-09-13';
  const draftOf = (store: MutationDraftStore, draftId: string): MutationDraftRecord =>
    store.get(draftId)!;

  it('AC14: one goal across "gastei 50" → "de carne" → "ontem" → "nubank", one proposal', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, {
      entityReader: reader([NUBANK, ITAU], [CARNE_BOVINA]),
      now: () => NOW_MS,
    });

    const first = await turn(orchestrator, 'gastei 50', 'ac14-1');
    expect(first.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    const draftId = first.clarification?.draft?.draftId!;
    expect(draftId).toBeTruthy();
    const opened = draftOf(store, draftId);
    expect(opened.resolvedArgs.amountCents).toBe(5000);
    expect(opened.resolvedArgs.date).toBe(TODAY);
    expect(opened.revision).toBe(0);
    expect(opened.relations).toEqual(['new_intent']);

    // Fragment 1: "de carne" completes the pending category WITHOUT turning
    // the description into one (R03/A03) and without proposing yet.
    const second = await turn(orchestrator, 'de carne', 'ac14-2');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(second.clarification?.missingFields).toEqual(['accountId']);
    const afterCategory = draftOf(store, draftId);
    expect(afterCategory.resolvedArgs.categoryQuery).toBe('carne');
    expect(afterCategory.resolvedArgs.description).toBe(opened.resolvedArgs.description);
    expect(afterCategory.missingFields).not.toContain('categoryId');

    // Fragment 2: "ontem" corrects the date against the injected clock.
    const third = await turn(orchestrator, 'ontem', 'ac14-3');
    expect(third.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(draftOf(store, draftId).resolvedArgs.date).toBe(YESTERDAY);

    // Same goal the whole way: same draft/goal identity, revision monotonic,
    // every turn recorded as an origin of the goal.
    const final = draftOf(store, draftId);
    expect(final.draftId).toBe(draftId);
    expect(final.goalId).toBe(draftId);
    // Revision is strictly monotonic across the turns that touched the draft.
    expect(afterCategory.revision).toBeGreaterThan(opened.revision);
    expect(final.revision).toBeGreaterThan(afterCategory.revision);
    expect(final.originMessages).toEqual(['ac14-1', 'ac14-2', 'ac14-3']);
    expect(final.relations).toEqual(['new_intent', 'continuation']);

    // Fragment 3: the account completes it — exactly ONE proposal.
    const fourth = await turn(orchestrator, 'nubank', 'ac14-4');
    expect(fourth.mutation?.operationId).toMatch(/^pending-/);
    expect(fake.proposePosts()).toBe(1);
    expect(fake.ops.size).toBe(1);
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      description: 'despesa',
      date: YESTERDAY,
      accountId: NUBANK.id,
      categoryId: CARNE_BOVINA.id,
    });
    const consumed = draftOf(store, draftId);
    expect(consumed.goalId).toBe(draftId);
    expect(consumed.originMessages).toContain('ac14-4');
    // The propose key is still derived from the draft identity alone (V22).
    expect(consumed.proposalIdempotencyKey).toBe(opened.proposalIdempotencyKey);
  });

  it('AC14: the "de X" fragment needs a pending category — the fresh path never reads it', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const IFOOD = { id: '00000000-0000-4000-8000-000000000041', name: 'Ifood' };
    const orchestrator = setup(fake, store, {
      entityReader: reader([NUBANK], [IFOOD]),
      now: () => NOW_MS,
    });
    // Both entities resolve on the fresh turn, so there is no draft for the
    // fragment grammar to attach to: it is structurally unreachable here.
    const first = await turn(orchestrator, 'gastei 50 no ifood', 'ac14-frag-1');
    expect(first.clarification?.draft).toBeUndefined();
    expect(fake.proposePosts()).toBe(1);
    expect(store.listActive(ctxOf(), NOW_MS)).toHaveLength(0);
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      description: 'ifood',
      categoryId: IFOOD.id,
    });
  });

  it('AC14: a bare fragment never becomes a category without an active draft', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    // No draft exists: "de carne" is an ordinary unsupported turn. No draft is
    // created from it and nothing is proposed (R03/A03 preserved).
    const result = await turn(orchestrator, 'de carne', 'ac14-frag-2');
    expect(result.clarification?.draft).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(store.listActive(ctxOf(), NOW_MS)).toHaveLength(0);
  });

  it('AC14: "hoje" also corrects the date, and an explicit date is never invented', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, {
      entityReader: reader([NUBANK, ITAU], [CARNE_BOVINA]),
      now: () => NOW_MS,
    });
    await turn(orchestrator, 'gastei 50 de carne', 'ac14-date-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    await turn(orchestrator, 'ontem', 'ac14-date-2');
    expect(draftOf(store, draftId).resolvedArgs.date).toBe(YESTERDAY);
    await turn(orchestrator, 'hoje', 'ac14-date-3');
    expect(draftOf(store, draftId).resolvedArgs.date).toBe(TODAY);
    expect(fake.proposePosts()).toBe(0);
  });

  it('AC15: "não, 500" corrects the amount, proposes nothing early, and flows into the proposal', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac15-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    const opened = draftOf(store, draftId);
    expect(opened.resolvedArgs.amountCents).toBe(5000);

    const corrected = await turn(orchestrator, 'não, 500', 'ac15-2');
    // Zero early write: a proposal only appears once every field is resolved.
    expect(corrected.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);

    const afterCorrection = draftOf(store, draftId);
    expect(afterCorrection.resolvedArgs.amountCents).toBe(50000);
    // No inheritance: the correction replaced ONE field and nothing else.
    expect(afterCorrection.resolvedArgs.description).toBe(opened.resolvedArgs.description);
    expect(afterCorrection.resolvedArgs.date).toBe(opened.resolvedArgs.date);
    expect(afterCorrection.resolvedArgs.accountId).toBeUndefined();
    expect(afterCorrection.resolvedArgs.categoryId).toBeUndefined();
    // Provenance records the correction origin (A06 FieldProvenance reused).
    expect(afterCorrection.fieldProvenance?.amountCents).toMatchObject({
      source: 'token',
      raw: 'não, 500',
      value: 50000,
    });
    expect(afterCorrection.relations).toContain('correction');
    expect(afterCorrection.relations).not.toContain('continuation');
    expect(afterCorrection.revision).toBeGreaterThan(opened.revision);
    expect(afterCorrection.goalId).toBe(draftId);
    expect(afterCorrection.originMessages).toContain('ac15-2');

    const completed = await turn(orchestrator, 'Nubank', 'ac15-3');
    expect(completed.mutation?.operationId).toMatch(/^pending-/);
    expect(fake.proposePosts()).toBe(1);
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({ amountCents: 50000, description: 'mercado' });
  });

  it('AC15: "<valor> em vez de <valor>" and "não, foi <valor>" are both corrections', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac15-emvez-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    // Pattern "não[, é]? <valor>" also accepts the "não, foi <valor>" shape.
    const negated = await turn(orchestrator, 'não, foi 1200', 'ac15-emvez-2');
    expect(negated.mutation).toBeUndefined();
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(120000);

    // Pattern "<valor> em vez" needs no negation at all.
    await turn(orchestrator, '900 em vez de 1200', 'ac15-emvez-3');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(90000);
    expect(fake.proposePosts()).toBe(0);
  });

  it('AC15: a negation WITHOUT a value keeps its fail-closed behaviour (no correction)', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac15-neg-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    const opened = draftOf(store, draftId);
    const result = await turn(orchestrator, 'não', 'ac15-neg-2');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    const after = draftOf(store, draftId);
    expect(after.resolvedArgs.amountCents).toBe(5000);
    expect(after.relations).toContain('negation');
    expect(after.relations).not.toContain('correction');
    expect(after.revision).toBeGreaterThan(opened.revision);
  });

  it('AC15: a new intention replaces the draft WITHOUT inheriting any field', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, {
      entityReader: reader([NUBANK, ITAU], [MERCADO]),
      now: () => NOW_MS,
    });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'ac15-replace-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    const opened = draftOf(store, draftId);
    const result = await turn(orchestrator, 'gastei 300 no ifood', 'ac15-replace-2');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(draftOf(store, draftId).status).toBe('replaced');

    const reopened = store.listActive(ctxOf(), NOW_MS)[0]!;
    expect(reopened.draftId).not.toBe(draftId);
    expect(reopened.goalId).toBe(reopened.draftId);
    expect(reopened.resolvedArgs.amountCents).toBe(30000);
    expect(reopened.resolvedArgs.description).toBe('ifood');
    expect(reopened.resolvedArgs.date).toBe(TODAY);
    expect(reopened.resolvedArgs.accountId).toBeUndefined();
    expect(reopened.resolvedArgs.categoryId).toBeUndefined();
    expect(reopened.originMessages).toEqual(['ac15-replace-2']);
    expect(reopened.proposalIdempotencyKey).not.toBe(opened.proposalIdempotencyKey);
  });

  it('AC15: a corrected draft can still be cancelled without any effect', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac15-cancel-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    await turn(orchestrator, 'não, 500', 'ac15-cancel-2');
    const cancelled = await turn(orchestrator, 'cancela', 'ac15-cancel-3');
    expect(cancelled.response?.text).toMatch(/cancelada/);
    expect(fake.proposePosts()).toBe(0);
    expect(fake.ops.size).toBe(0);
    const closed = draftOf(store, draftId);
    expect(closed.status).toBe('discarded');
    expect(closed.discardReason).toBe('user_cancel');
    expect(closed.relations).toContain('cancel_ref');
  });

  it('AC15: a correction on an expired draft effects nothing', async () => {
    let now = NOW_MS;
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => now });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac15-exp-1');
    now += 16 * 60_000;
    const result = await turn(orchestrator, 'não, 500', 'ac15-exp-2');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(result.clarification?.draft).toBeUndefined();
    expect(store.listActive(ctxOf(), now)).toHaveLength(0);
  });

  it('AC16: a correction racing another write never overwrites it (revision fingerprint)', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac16-race-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    // A concurrent write lands right BEFORE every guarded correction attempt,
    // so the stored revision has moved and the stale guard must miss — twice.
    const rawUpdate = store.update.bind(store);
    let injected = 0;
    vi.spyOn(store, 'update').mockImplementation((id, patch, options) => {
      if (options?.expectedRevision !== undefined) {
        injected += 1;
        rawUpdate(id, { lastQuestion: `concorrente-${injected}` });
      }
      return rawUpdate(id, patch, options);
    });

    const result = await turn(orchestrator, 'não, 500', 'ac16-race-2');
    // Exactly two attempts: the initial one and the single deterministic retry.
    expect(injected).toBe(2);
    // Fail closed: nothing proposed, nothing written over the winner.
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(result.clarification?.missingFields).toEqual(['amount']);
    const draft = draftOf(store, draftId);
    expect(draft.resolvedArgs.amountCents).toBe(5000);
    expect(draft.lastQuestion).toBe('concorrente-2');
    expect(draft.relations).not.toContain('correction');
  });

  it('AC16: a single concurrent write is absorbed by the one deterministic retry', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'ac16-retry-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    const rawUpdate = store.update.bind(store);
    let injected = false;
    vi.spyOn(store, 'update').mockImplementation((id, patch, options) => {
      if (options?.expectedRevision !== undefined && !injected) {
        injected = true;
        rawUpdate(id, { lastQuestion: 'concorrente' });
      }
      return rawUpdate(id, patch, options);
    });

    await turn(orchestrator, 'não, 500', 'ac16-retry-2');
    const draft = draftOf(store, draftId);
    expect(injected).toBe(true);
    // The retry re-read the revision and applied the correction on top of the
    // concurrent write — the winner's question survives.
    expect(draft.resolvedArgs.amountCents).toBe(50000);
    expect(draft.relations).toContain('correction');
    expect(fake.proposePosts()).toBe(0);
  });

  it('AC16: two active drafts are asked about, never merged, never proposed', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    for (const [intention, description] of [['ac16-two-1', 'mercado'], ['ac16-two-2', 'farmacia']] as const) {
      store.getOrCreate(
        buildDraftRecord({
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          deviceId: identity.deviceId ?? null,
          intentionId: intention,
          tool: 'transactions.expense.create',
          resolvedArgs: { kind: 'expense', amountCents: 1000, description, date: TODAY },
          missingFields: ['accountId'],
          question: 'Em qual conta devo registrar?',
          nowMs: NOW_MS,
        }),
      );
    }
    const before = store.listActive(ctxOf(), NOW_MS).map((draft) => ({ ...draft }));
    const orchestrator = setup(fake, store, { now: () => NOW_MS });

    // A fragment against two drafts is still a question, never a merge.
    const asked = await turn(orchestrator, 'de carne', 'ac16-two-3');
    expect(asked.response?.text).toMatch(/mais de uma inten/);
    expect(asked.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    const after = store.listActive(ctxOf(), NOW_MS);
    expect(after.map((draft) => ({ draftId: draft.draftId, revision: draft.revision, amount: draft.resolvedArgs.amountCents }))).toEqual(
      before.map((draft) => ({ draftId: draft.draftId, revision: draft.revision, amount: draft.resolvedArgs.amountCents })),
    );

    // A value correction against two drafts is also never applied blindly.
    const corrected = await turn(orchestrator, 'não, 900', 'ac16-two-4');
    expect(corrected.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(store.listActive(ctxOf(), NOW_MS).map((draft) => draft.resolvedArgs.amountCents)).toEqual([1000, 1000]);
  });

  it('AC16: `proposing` is frozen — a later turn re-emits the SAME proposal', async () => {
    const fake = makeFakeApi([{ persistThenThrow: timeoutError() }]);
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS, maxAttempts: 1 });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'ac16-frz-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    const inconclusive = await turn(orchestrator, 'Nubank', 'ac16-frz-2');
    expect(inconclusive.mutation).toBeUndefined();
    expect(draftOf(store, draftId).status).toBe('proposing');
    const postsBefore = fake.proposePosts();
    const keysBefore = [...fake.proposeKeys];

    // A DIFFERENT turn while the handoff is in flight: the frozen draft is
    // re-emitted with the same key and never re-resolved against new text.
    const later = await turn(orchestrator, 'Itau', 'ac16-frz-3');
    expect(later.mutation).toBeUndefined();
    // The re-emission carries the SAME propose key, so the API dedups onto the
    // operation that already exists — one operation for one intent.
    expect(fake.proposeKeys).toHaveLength(2);
    expect(fake.proposeKeys.at(-1)).toBe(keysBefore[0]);
    expect(fake.proposePosts()).toBe(postsBefore + 1);
    expect(fake.ops.size).toBe(1);
    // Frozen means never re-resolved: the new text ("Itau") did not rewrite
    // the handoff that was already in flight.
    const settled = draftOf(store, draftId);
    expect(settled.resolvedArgs.accountId).toBe(NUBANK.id);
    expect(settled.status).toBe('consumed');
    expect(settled.proposalId).toBe([...fake.ops.values()][0]!.id);
  });

  it('AC16: `consumed` is terminal — a late turn reuses the proposal, args unchanged', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, { now: () => NOW_MS });
    await turn(orchestrator, 'Gastei R$ 85 no mercado', 'ac16-cons-1');
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    const completed = await turn(orchestrator, 'Nubank', 'ac16-cons-2');
    const consumed = draftOf(store, draftId);
    expect(consumed.status).toBe('consumed');
    const argsAtConsumption = { ...consumed.resolvedArgs };

    // Neither a redelivery nor a new turn may patch the consumed draft.
    const resent = await turn(orchestrator, 'Nubank', 'ac16-cons-2');
    expect(resent.mutation?.operationId).toBe(completed.mutation?.operationId);
    const correction = await turn(orchestrator, 'não, 999', 'ac16-cons-3');
    expect(correction.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(1);
    const still = draftOf(store, draftId);
    expect(still.status).toBe('consumed');
    expect(still.resolvedArgs).toEqual(argsAtConsumption);
    expect(still.relations).not.toContain('correction');
  });

  it('AC16: the revision guard refuses a stale write without touching the draft', () => {
    const store = new InMemoryMutationDraftStore();
    const record = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'ac16-guard-1',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'mercado', date: TODAY },
      missingFields: ['accountId'],
      question: 'Em qual conta devo registrar?',
      nowMs: NOW_MS,
    });
    store.getOrCreate(record);
    const first = store.update(record.draftId, { lastQuestion: 'primeira' }, { expectedRevision: 0 })!;
    expect(first.revision).toBe(1);
    expect(store.update(record.draftId, { lastQuestion: 'segunda' }, { expectedRevision: 0 })).toBeUndefined();
    expect(store.get(record.draftId)?.lastQuestion).toBe('primeira');
    expect(store.update(record.draftId, { lastQuestion: 'terceira' }, { expectedRevision: 1 })?.lastQuestion).toBe('terceira');
    // Without a guard the write still works (every pre-A07 caller).
    expect(store.update(record.draftId, { lastQuestion: 'quarta' })?.revision).toBe(3);
  });

  it('FIX 6/P10: a stale resolution write is refused and the stored args are untouched', () => {
    const store = new InMemoryMutationDraftStore();
    const record = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'fix6-p10-1',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'mercado', date: TODAY },
      missingFields: ['accountId'],
      question: 'Em qual conta devo registrar?',
      nowMs: NOW_MS,
    });
    store.getOrCreate(record);
    // The fresh writer resolves the account and closes `missingFields`.
    const fresh = store.update(
      record.draftId,
      { resolvedArgs: { ...record.resolvedArgs, accountId: NUBANK.id }, missingFields: [] },
      { expectedRevision: 0 },
    )!;
    expect(fresh.revision).toBe(1);
    // The stale writer (revision 0) may not touch the resolved payload.
    const stale = store.update(
      record.draftId,
      { resolvedArgs: { ...record.resolvedArgs, amountCents: 99999 }, missingFields: [] },
      { expectedRevision: 0 },
    );
    expect(stale).toBeUndefined();
    const persisted = store.get(record.draftId)!;
    expect(persisted.resolvedArgs.amountCents).toBe(5000);
    expect(persisted.resolvedArgs.accountId).toBe(NUBANK.id);
    expect(persisted.missingFields).toEqual([]);
    expect(persisted.revision).toBe(1);
  });

  it('A07: `draft_relation` vocabulary and its bounded helpers', () => {
    expect(DRAFT_RELATIONS).toEqual([
      'new_intent',
      'continuation',
      'correction',
      'confirmation_ref',
      'negation',
      'cancel_ref',
      'goal_ref',
      'historic_ref',
    ]);
    expect(appendDraftRelation(['new_intent'], 'continuation')).toEqual(['new_intent', 'continuation']);
    expect(appendDraftRelation(['new_intent'], 'new_intent')).toEqual(['new_intent']);
    expect(appendDraftRelation(['new_intent'], 'goal_ref')).toEqual(['new_intent', 'goal_ref']);
    expect(appendOriginMessage(['a'], 'a')).toEqual(['a']);
    const bounded = Array.from({ length: MAX_DRAFT_ORIGIN_MESSAGES + 5 }, (_, index) => appendOriginMessage(
      index === 0 ? [] : Array.from({ length: index }, (_, inner) => `m${inner}`),
      `m${index}`,
    )).at(-1)!;
    expect(bounded).toHaveLength(MAX_DRAFT_ORIGIN_MESSAGES);
    expect(bounded[0]).toBe('m5');
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

/**
 * A07/RR — rodada de correção do review da fatia A07.
 *
 * Cada contraexemplo do review vira um teste RED antes da implementação:
 * - FIX 1 (HIGH): escrita pós-await não pode sobrescrever uma correção nem
 *   tocar um draft congelado;
 * - FIX 2 (HIGH): token de valor inteiro, moeda não-BRL e alternativa
 *   disjuntiva são esclarecimento, nunca um valor inventado;
 * - FIX 4 (MEDIUM): fragmento de data só quando inequívoco e não negado;
 * - FIX 5 (MEDIUM): fragmento categorial nunca vira escolha de conta.
 */
describe('A07/RR — interleaving, correção inequívoca e fragmentos', () => {
  const NOW_MS = Date.parse('2026-09-14T18:00:00.000Z');
  const TODAY = '2026-09-14';
  const YESTERDAY = '2026-09-13';
  const draftOf = (store: MutationDraftStore, draftId: string): MutationDraftRecord =>
    store.get(draftId)!;
  const proposedArgs = (fake: ReturnType<typeof makeFakeApi>): Record<string, unknown> =>
    (fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } })
      ?.body?.normalizedArgs ?? {};

  /** Seeds an active draft pending its account, as a real prior turn would. */
  const openDraft = async (
    fake: ReturnType<typeof makeFakeApi>,
    store: MutationDraftStore,
    options: { entityReader?: EntityReader } = {},
  ): Promise<ConversationOrchestrator> => {
    const orchestrator = setup(fake, store, {
      ...(options.entityReader ? { entityReader: options.entityReader } : {}),
      now: () => NOW_MS,
    });
    await turn(orchestrator, 'Gastei R$ 50 no mercado', 'rr-seed-1');
    return orchestrator;
  };

  it('FIX 1: a post-await continuation never overwrites a correction that landed while it resolved', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    // Deferred authoritative read: turn A parks INSIDE the entity resolution,
    // exactly the window between its draft read and its write.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let gateUsed = false;
    const deferredReader: EntityReader = {
      listAccounts: async () => {
        if (!gateUsed) {
          gateUsed = true;
          entered();
          await parked;
        }
        return [NUBANK, ITAU];
      },
      listCategories: async () => [MERCADO],
    };
    // The gate parks the FIRST read it ever sees, so the seeding turn must not
    // run through it: it gets the plain reader over the same store, and the
    // continuation below is the orchestrator that owns the deferred read.
    await openDraft(fake, store);
    const orchestrator = setup(fake, store, { entityReader: deferredReader, now: () => NOW_MS });
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(5000);

    // Turn A read the draft (R$50) and is now parked in the read.
    const slow = turn(orchestrator, 'Nubank', 'rr-interleave-a1');
    await reached;
    // Turn B corrects to R$500 while A is still awaiting.
    await turn(orchestrator, 'não, 500', 'rr-interleave-b1');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);

    release();
    const result = await slow;

    // B's correction SURVIVED A's completion: the stored args and the proposal
    // both carry R$500, never the R$50 A had read before its await.
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);
    expect(result.mutation?.operationId).toMatch(/^pending-/);
    expect(fake.proposePosts()).toBe(1);
    expect(proposedArgs(fake)).toMatchObject({ amountCents: 50000, accountId: NUBANK.id });
  });

  it('FIX A: a correction captured before the await NEVER overwrites the correction that landed while it resolved', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    // Same deferred read as FIX 1: turn A parks INSIDE the entity resolution,
    // between its draft read and its post-await write.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let gateUsed = false;
    const deferredReader: EntityReader = {
      listAccounts: async () => {
        if (!gateUsed) {
          gateUsed = true;
          entered();
          await parked;
        }
        return [NUBANK, ITAU];
      },
      listCategories: async () => [MERCADO],
    };
    await openDraft(fake, store);
    const orchestrator = setup(fake, store, { entityReader: deferredReader, now: () => NOW_MS });
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(5000);

    // Turn A corrects to R$500 AND names the account, so its continuation is
    // the branch that WRITES after the await (the propose path).
    const slow = turn(orchestrator, 'não, 500 reais na Nubank', 'rr-interleave-a2');
    await reached;
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);

    // Turn B corrects to R$700 while A is still awaiting. B carries no account
    // hint, so it cannot complete the draft: it only corrects the stored value.
    await turn(orchestrator, 'não, 700', 'rr-interleave-b2');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(70000);

    release();
    const result = await slow;

    // B's fresher correction SURVIVED A's completion: the stored args and the
    // proposal both carry R$700, never the R$500 A captured before its await.
    expect(result.mutation?.operationId).toMatch(/^pending-/);
    expect(fake.proposePosts()).toBe(1);
    expect(proposedArgs(fake)).toMatchObject({ amountCents: 70000, accountId: NUBANK.id });
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(70000);
  });

  it('FIX 1: a resolution patch is refused unless the draft is still active', () => {
    const store = new InMemoryMutationDraftStore();
    const record = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'rr-status-1',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'mercado', date: TODAY },
      missingFields: ['accountId'],
      question: 'Em qual conta devo registrar?',
      nowMs: NOW_MS,
    });
    store.getOrCreate(record);
    // ACTIVE: the legitimate resolution write applies (and only while active).
    expect(
      store.update(
        record.draftId,
        { resolvedArgs: { ...record.resolvedArgs, accountId: NUBANK.id }, missingFields: [] },
        { expectedRevision: 0 },
      )?.missingFields,
    ).toEqual([]);
    // The propose transition itself keeps going through `cas`, never `update`.
    expect(store.cas(record.draftId, 'active', 'proposing').ok).toBe(true);

    const frozen = { ...store.get(record.draftId)!.resolvedArgs };
    for (const status of ['proposing', 'consumed', 'discarded', 'expired', 'replaced'] as const) {
      store.update(record.draftId, { status });
      const at = store.get(record.draftId)!;
      expect(at.status).toBe(status);
      // A patch touching the resolved payload of a non-active draft is
      // refused WITHOUT writing — the frozen propose payload is authoritative.
      expect(
        store.update(record.draftId, {
          resolvedArgs: { ...at.resolvedArgs, amountCents: 99999 },
          missingFields: ['accountId'],
        }),
      ).toBeUndefined();
      expect(store.update(record.draftId, { missingFields: ['categoryId'] })).toBeUndefined();
      const after = store.get(record.draftId)!;
      expect(after.resolvedArgs).toEqual(frozen);
      expect(after.missingFields).toEqual([]);
      // A non-resolution write (terminal state, question) still lands.
      expect(store.update(record.draftId, { lastQuestion: `pergunta-${status}` })?.lastQuestion).toBe(
        `pergunta-${status}`,
      );
    }
  });

  it('FIX 2: "não, 50,123" never truncates the value into 50,12', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    const result = await turn(orchestrator, 'não, 50,123', 'rr-sep-1');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    // Honest clarification, draft intact: the value is untouched.
    expect(result.clarification?.text).toMatch(/valor/i);
    const draft = draftOf(store, draftId);
    expect(draft.resolvedArgs.amountCents).toBe(5000);
    expect(draft.relations).not.toContain('correction');
    // The unambiguous thousand form IS still read as one value.
    const thousand = await turn(orchestrator, 'não, 1.500', 'rr-sep-2');
    expect(thousand.mutation).toBeUndefined();
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(150000);
  });

  it('FIX 2: "não, 500 dólares" clarifies instead of reading 500 as reais', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    for (const text of ['não, 500 dólares', 'não, 500 dollars', 'não, 500 euros']) {
      const result = await turn(orchestrator, text, `rr-cur-${text}`);
      expect(result.mutation).toBeUndefined();
      expect(fake.proposePosts()).toBe(0);
      expect(result.clarification?.text).toMatch(/reais/i);
      expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(5000);
    }
    // No currency conversion happened, so the real value still corrects.
    await turn(orchestrator, 'não, 500', 'rr-cur-final');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);
  });

  it('FIX 2: "não, 500 ou 50" clarifies instead of silently picking one value', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    const result = await turn(orchestrator, 'não, 500 ou 50', 'rr-disj-1');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(result.clarification?.text).toMatch(/valor/i);
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(5000);
    expect(draftOf(store, draftId).relations).not.toContain('correction');
  });

  it('FIX 2: the three accepted correction shapes still correct the amount', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    await turn(orchestrator, 'não, 500', 'rr-pos-1');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);
    await turn(orchestrator, 'não é 500', 'rr-pos-2');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);
    await turn(orchestrator, '500 em vez', 'rr-pos-3');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(50000);
    await turn(orchestrator, 'não, 900', 'rr-pos-4');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(90000);
    // The most common pt-BR spellings stay corrections: the "r$" prefix and the
    // BRL unit are not a foreign currency.
    await turn(orchestrator, 'não, r$ 1200', 'rr-pos-5');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(120000);
    await turn(orchestrator, 'não, 1500 reais', 'rr-pos-6');
    expect(draftOf(store, draftId).resolvedArgs.amountCents).toBe(150000);
    expect(draftOf(store, draftId).relations).toContain('correction');
    expect(fake.proposePosts()).toBe(0);

    const completed = await turn(orchestrator, 'Nubank', 'rr-pos-7');
    expect(completed.mutation?.operationId).toMatch(/^pending-/);
    expect(proposedArgs(fake)).toMatchObject({ amountCents: 150000 });
  });

  it('FIX 4: "ontem ou hoje" clarifies and the stored date survives', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    const result = await turn(orchestrator, 'ontem ou hoje', 'rr-date-1');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(result.clarification?.text).toMatch(/data/i);
    const draft = draftOf(store, draftId);
    expect(draft.resolvedArgs.date).toBe(TODAY);
    expect(draft.missingFields).toContain('accountId');
  });

  it('FIX 4: "não foi ontem" clarifies and never dates the draft to yesterday', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    const result = await turn(orchestrator, 'não foi ontem', 'rr-date-2');
    expect(result.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(result.clarification?.text).toMatch(/data/i);
    expect(draftOf(store, draftId).resolvedArgs.date).toBe(TODAY);
  });

  it('FIX 4: a single unnegated relative date still corrects the draft', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = await openDraft(fake, store);
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;

    await turn(orchestrator, 'ontem', 'rr-date-3');
    expect(draftOf(store, draftId).resolvedArgs.date).toBe(YESTERDAY);
    await turn(orchestrator, 'hoje', 'rr-date-4');
    expect(draftOf(store, draftId).resolvedArgs.date).toBe(TODAY);
    expect(fake.proposePosts()).toBe(0);
  });

  it('FIX 5: a category fragment never resolves a same-named account, and a bare answer still does', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const CARNE_CONTA = { id: '00000000-0000-4000-8000-000000000031', name: 'Carne' };
    const CARNE_CATEGORIA = { id: '00000000-0000-4000-8000-000000000032', name: 'Carne' };
    const orchestrator = await openDraft(fake, store, {
      entityReader: reader([CARNE_CONTA, NUBANK], [CARNE_CATEGORIA]),
    });
    const draftId = store.listActive(ctxOf(), NOW_MS)[0]!.draftId;
    expect(draftOf(store, draftId).missingFields).toEqual(['accountId', 'categoryId']);

    // "de carne" answers the CATEGORY question. The account is still pending and
    // its homonyms stay visible — the fragment text never picks an account.
    const fragment = await turn(orchestrator, 'de carne', 'rr-frag-1');
    expect(fragment.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(fragment.clarification?.missingFields).toEqual(['accountId']);
    expect(fragment.response?.text).toMatch(/Carne/);
    expect(fragment.response?.text).toMatch(/Nubank/);
    const afterFragment = draftOf(store, draftId);
    expect(afterFragment.resolvedArgs.categoryQuery).toBe('carne');
    expect(afterFragment.resolvedArgs.accountId).toBeUndefined();
    expect(afterFragment.missingFields).toEqual(['accountId']);

    // Regression: a NON-fragment turn ("nubank") still resolves the account —
    // the fragment is what was excluded, not the bare-answer grammar.
    const completed = await turn(orchestrator, 'nubank', 'rr-frag-2');
    expect(completed.mutation?.operationId).toMatch(/^pending-/);
    expect(fake.proposePosts()).toBe(1);
    expect(proposedArgs(fake)).toMatchObject({
      amountCents: 5000,
      accountId: NUBANK.id,
      categoryId: CARNE_CATEGORIA.id,
    });
  });
});
