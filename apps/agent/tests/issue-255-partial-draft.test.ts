/**
 * Issue #255 — partial draft (strategy a) — TDD RED→GREEN.
 *
 * Turn 1 "comprei uma bicicleta parcela em 10 x" must persist a partial
 * draft (amount missing) and ask for the value; turn 2 with a value must
 * resume it even without a finite verb. Pure reads never hijack.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';
import type { EntityReader } from '../src/mutations/entity-resolver.js';

const MISSING_AMOUNT_TEXT =
  'Não identifiquei o valor a registrar. Informe o valor e a descrição.';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-255',
  workspaceId: 'workspace-255',
  role: 'member',
  deviceId: 'device-255',
};

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const CATEGORY_MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };

const reader = (): EntityReader => ({
  listAccounts: async () => [ACCOUNT_NUBANK],
  listCategories: async () => [CATEGORY_MERCADO],
});

const mockClient = () => {
  const request = vi.fn().mockImplementation(async (method: string, path: string) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'op-255-1' };
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api: new MutationApiClient({ request }), request };
};

const harness = (nowMs: number) => {
  let now = nowMs;
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
    draftNow: () => now,
    responseProvider,
    evidenceProvider,
    events: () => undefined,
  });
  return { store, request, responseProvider, evidenceProvider, orchestrator, advance: (ms: number) => { now += ms; } };
};

describe('issue #255 (a) partial draft', () => {
  it('1) turn 1 persists a partial draft and asks for the value without proposing', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    const r1 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-t1' }, identity),
    );
    expect(r1.response?.text).toBe(MISSING_AMOUNT_TEXT);
    expect([...r1.plan.missingFields]).toContain('amount');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.responseProvider).not.toHaveBeenCalled();
    const actives = h.store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      Date.parse('2026-10-19T12:00:01Z'),
    );
    expect(actives).toHaveLength(1);
    expect(actives[0]!.missingFields).toContain('amount');
  });

  it('2) turn 2 with a value resumes the partial draft and proposes (no absence copy)', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s2-t1' }, identity),
    );
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: '2500 com o cartao nubank categoria mercado', intentionId: 'i255-s2-t2' },
        identity,
      ),
    );
    expect(r2.response?.text).not.toMatch(/Ainda n[aã]o encontrei/i);
    expect(r2.mutation?.status).toBe('proposed');
    expect(h.request).toHaveBeenCalledTimes(1);
    const body = h.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({ amountCents: 250000, accountId: ACCOUNT_NUBANK.id });
    expect(h.responseProvider).not.toHaveBeenCalled();
  });

  it('3) redelivery of the amount turn is idempotent (same key, no second draft)', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s3-t1' }, identity),
    );
    const first = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: '2500 com o cartao nubank categoria mercado', intentionId: 'i255-s3-t2' }, identity),
    );
    const callsAfterFirst = h.request.mock.calls.length;
    const second = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: '2500 com o cartao nubank categoria mercado', intentionId: 'i255-s3-t2' }, identity),
    );
    expect(second.mutation?.status).toBe('proposed');
    expect(second.mutation?.operationId).toBe(first.mutation?.operationId);
    expect(h.request.mock.calls.length).toBe(callsAfterFirst);
  });

  it('4) expired partial draft does not resume (asks again, no propose)', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s4-t1' }, identity),
    );
    h.advance(16 * 60_000);
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: '2500', intentionId: 'i255-s4-t2' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    expect(r2.mutation).toBeUndefined();
  });

  it('5) pure read after a pending partial is never hijacked', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s5-t1' }, identity),
    );
    const read = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'liste meus cartões', intentionId: 'i255-s5-read' }, identity),
    );
    expect(read.mutation).toBeUndefined();
    expect(read.response?.text).toMatch(/faturas/i);
    expect(h.request).not.toHaveBeenCalled();
    const actives = h.store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      Date.parse('2026-10-19T12:01:00Z'),
    );
    expect(actives).toHaveLength(1);
  });

  it('6) cancel terminates the partial draft', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s6-t1' }, identity),
    );
    const cancelled = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'cancela', intentionId: 'i255-s6-cancel' }, identity),
    );
    expect(cancelled.mutation).toBeUndefined();
    expect(h.request.mock.calls.filter((call) => call[0] === 'POST')).toHaveLength(0);
    const actives = h.store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      Date.parse('2026-10-19T12:01:00Z'),
    );
    expect(actives).toHaveLength(0);
  });

  it('7) issue verbatim: "2500 sendo 10x 250 com o cartão nubank" never answers absence', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s7-t1' }, identity),
    );
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: '2500 sendo 10x 250 com o cartão nubank', intentionId: 'i255-s7-t2' },
        identity,
      ),
    );
    expect(r2.response?.text).not.toMatch(/Ainda n[aã]o encontrei/i);
    expect(r2.clarification ?? r2.mutation).toBeDefined();
    expect(h.responseProvider).not.toHaveBeenCalled();
  });

  it('8) provider is never called on the partial path', async () => {
    const h = harness(Date.parse('2026-10-19T12:00:00Z'));
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'comprei uma bicicleta parcela em 10 x', intentionId: 'i255-s8-t1' }, identity),
    );
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: '2500', intentionId: 'i255-s8-t2' }, identity),
    );
    expect(h.responseProvider).not.toHaveBeenCalled();
  });
});
