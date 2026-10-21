/**
 * offer-accept-vs-confirmation — colisão "quero sim" pós-oferta × confirmação V2.
 *
 * A oferta textual de cadastro ("Ainda não encontrei … Quer que eu te guie
 * no cadastro?") não é proposta V2; o aceite curto ("quero sim") roteia
 * `confirmation` no `routeIntent` (contém "sim") e, sem pendência, caía no
 * "Não há nenhuma operação pendente para confirmar" em vez de abrir o fluxo
 * de criação de conta. Este arquivo fixa:
 * (1) "quero sim"/"sim, quero" sem pending abrem o rascunho de conta
 *     (coleta de campos, sem defaults inventados);
 * (2) com pending V2 existente, "quero sim" confirma (fluxo V2 intacto);
 * (3) "sim" isolado sem pending mantém o "sem pendente" honesto.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';
import {
  initializeMemorySchema,
  listActiveForgetProposals,
  rememberFact,
  type MemorySql,
} from '../src/agent-config/memory/store.js';
import { createMemorySql, type MemorySqlMock } from './helpers/memory-sql.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-offer',
  workspaceId: 'workspace-offer',
  role: 'member',
  deviceId: 'device-offer',
};

const ctx = {
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
};

const ENT_ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T0 = Date.parse('2026-10-21T12:00:00Z');

const harness = (nowMs: number, opts?: { forget?: boolean }) => {
  let now = nowMs;
  const store = new InMemoryMutationDraftStore();
  let activeOp: Record<string, unknown> | null = null;
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const body = (options as { body?: Record<string, unknown> }).body ?? {};
      return {
        id: 'op-acct-1',
        existing: false,
        summary: body.summary ?? 'Conta',
        operation: { id: 'op-acct-1', expiresAt: new Date(now + 10 * 60_000).toISOString() },
      };
    }
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      return activeOp ? { items: [activeOp], total: 1 } : { items: [], total: 0 };
    }
    if (method === 'POST' && path === '/pending-operations/v2/op-acct-1/confirm') {
      return { id: 'op-acct-1', attestation: 'a'.repeat(32) };
    }
    if (method === 'POST' && path === '/pending-operations/v2/op-acct-1/execute') {
      return {
        id: 'op-acct-1',
        status: 'succeeded',
        execution: {
          status: 'succeeded',
          operationId: ENT_ACCT,
          receipt: {
            mutationId: 'm-acct-1',
            mutationKind: 'accounts.create',
            status: 'succeeded',
            affectedTargets: ['accounts'],
            operationId: 'op-acct-1',
            entity: { type: 'account', id: ENT_ACCT },
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
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
  let memMock: MemorySqlMock | null = null;
  let memSql: MemorySql | null = null;
  if (opts?.forget) {
    memMock = createMemorySql();
    initializeMemorySchema(memMock);
    memSql = memMock as unknown as MemorySql;
  }
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: { listAccounts: async () => [], listCategories: async () => [] },
    draftStore: store,
    draftNow: () => now,
    responseProvider,
    evidenceProvider,
    events: () => undefined,
    ...(memSql ? { forgetMemory: { sql: memSql, now: () => now } } : {}),
  });
  return {
    store,
    request,
    calls,
    responseProvider,
    orchestrator,
    memSql,
    nowMs: () => now,
    publishActiveOp: () => {
      activeOp = {
        id: 'op-acct-1',
        status: 'proposed',
        tool: 'accounts.create',
        createdAt: new Date(T0).toISOString(),
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
      };
    },
    clearActiveOp: () => {
      activeOp = null;
    },
    seedMemory: (content: string) => {
      if (!memSql) throw new Error('harness without forgetMemory cannot seed memory');
      rememberFact(memSql, {
        workspaceId: identity.workspaceId,
        actor: identity.actorId,
        kind: 'preference',
        content,
      });
    },
    activeForgetCount: () => {
      if (!memSql) throw new Error('harness without forgetMemory has no forget proposals');
      return listActiveForgetProposals(
        memSql,
        { workspaceId: identity.workspaceId, actorId: identity.actorId },
        now,
      ).length;
    },
    presentOp: () => {
      store.noteConfirmationPresentation!({ ctx, operationIds: ['op-acct-1'], nowMs: T0 });
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('offer-accept-vs-confirmation', () => {
  it('(1) oferta de cadastro seguida de "quero sim" abre o fluxo de criação (sem "sem operação pendente", sem defaults)', async () => {
    const h = harness(T0);
    const offer = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'qual meu saldo?', intentionId: 'offer-t0' }, identity),
    );
    expect(offer.response?.text).toMatch(/cadastro/i);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero sim', intentionId: 'offer-t1' }, identity),
    );
    expect(r.response?.text).not.toMatch(/nenhuma opera..o pendente/i);
    expect(h.calls.some((c) => c.path === '/pending-operations/v2/propose')).toBe(false);
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    expect([...actives[0]!.missingFields]).toEqual(
      expect.arrayContaining(['name', 'kind', 'initialBalanceCents']),
    );
    // Sem defaults inventados: nada preenchido sem dado do usuário.
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBeUndefined();
    expect(actives[0]!.resolvedArgs.accountKind).toBeUndefined();
    expect(r.response?.text).toMatch(/nome|saldo/i);
  });

  it('(1b) variante "sim, quero" após a oferta também abre o fluxo de criação', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'qual meu saldo?', intentionId: 'offer-v-t0' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim, quero', intentionId: 'offer-v-t1' }, identity),
    );
    expect(r.response?.text).not.toMatch(/nenhuma opera..o pendente/i);
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBeUndefined();
    expect(actives[0]!.resolvedArgs.accountKind).toBeUndefined();
  });

  it('(2) "quero sim" COM pending V2 existente confirma (fluxo V2 intacto, sem rascunho de conta)', async () => {
    const h = harness(T0);
    h.publishActiveOp();
    h.presentOp();
    h.advance(5000);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero sim', intentionId: 'offer-v2-t1' }, identity),
    );
    expect(r.mutation?.status).toBe('succeeded');
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-acct-1/execute')).toHaveLength(1);
    expect(h.store.listActive(ctx, T0 + 6000)).toHaveLength(0);
  });

  it('(3) "sim" isolado sem oferta e sem pending mantém o "sem pendente" honesto', async () => {
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'offer-bare-t1' }, identity),
    );
    expect(r.response?.text).toMatch(/nenhuma opera..o pendente/i);
    expect(h.store.listActive(ctx, T0 + 1000)).toHaveLength(0);
  });

  it('(P2-1) reentrega do mesmo intentionId após execução reproduz o recibo original, sem abrir draft novo', async () => {
    const h = harness(T0);
    h.publishActiveOp();
    h.presentOp();
    h.advance(5000);
    const first = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero sim', intentionId: 'offer-replay-t1' }, identity),
    );
    expect(first.mutation?.status).toBe('succeeded');
    expect(first.mutation?.operationId).toBe('op-acct-1');
    expect(first.mutation?.receipt).toBeDefined();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-acct-1/execute')).toHaveLength(1);
    // Operação terminal: o listing autoritativo esvazia a partir daqui.
    h.clearActiveOp();
    h.advance(1000);
    const second = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero sim', intentionId: 'offer-replay-t1' }, identity),
    );
    expect(second.mutation?.status).toBe('succeeded');
    expect(second.mutation?.operationId).toBe(first.mutation?.operationId);
    expect(second.mutation?.receipt).toEqual(first.mutation?.receipt);
    // Sem reexecução no transporte e sem rascunho novo de conta.
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/op-acct-1/execute')).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(h.store.listActive(ctx, T0 + 7000)).toHaveLength(0);
  });

  it('(P2-2) forget-pendente + "quero sim" não abre rascunho financeiro e o forget segue confirmável', async () => {
    const h = harness(T0, { forget: true });
    h.seedMemory('Prefere usar Nubank');
    const asked = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'esqueça o que falei sobre Nubank', intentionId: 'offer-fg-t0' }, identity),
    );
    expect(asked.response?.text).toMatch(/Quer que eu a esqueça/);
    expect(h.activeForgetCount()).toBe(1);
    h.advance(5000);
    const accept = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'quero sim', intentionId: 'offer-fg-t1' }, identity),
    );
    // Cede ao forget: resposta honesta sem pendente financeiro, sem draft.
    expect(accept.response?.text).toMatch(/nenhuma opera..o pendente/i);
    expect(h.store.listActive(ctx, T0 + 6000)).toHaveLength(0);
    expect(h.activeForgetCount()).toBe(1);
    h.advance(1000);
    const done = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'offer-fg-t2' }, identity),
    );
    expect(done.response?.text).toMatch(/esqueci/);
    expect(h.activeForgetCount()).toBe(0);
    expect(h.store.listActive(ctx, T0 + 7000)).toHaveLength(0);
  });
});
