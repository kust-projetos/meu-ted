/**
 * categories.create propose route — R7 F6 (replay-first) + F7a (parent-gone).
 *
 * TDD RED:
 * - F6: retry mesma chave + mesmos args após o pai sair do ar deve
 *   replayar a operação existente (200), nunca 404 no gate mutável;
 *   corrida (vencedor commita durante o gate) retorna o vencedor (200);
 *   hash divergente na mesma chave → 409 idempotency.conflict.
 * - F7a: pai removido entre propose e confirm → presentation nula,
 *   listing sem presentation, confirm 409 approval.not_actionable
 *   (nenhum Confirm/Retry); raiz segue 201 + confirm 200.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { requireApprovalToolContract } from '../../src/approvals/tool-registry.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const ALL = [
  'financial.approval.propose',
  'financial.approval.read',
  'financial.approval.confirm',
  'financial.approval.execute',
  'financial.approval.retry',
  'financial.approval.cancel',
  'financial.approval.reconcile',
];

const catArgs = (name = 'Mercado', kind = 'expense' as const, parentId?: string) => ({
  name,
  kind,
  ...(parentId !== undefined ? { parentId } : {}),
});

const harness = (onListCategories?: () => Promise<void>) => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w',
      role: 'owner', capabilities: ALL, jti: randomUUID(), request: 'r',
      deviceId: 'd', iat: 1, exp: 9999999999,
    };
    request.authenticatedContext = {
      householdId: 'w', actorId: 'a', authUserId: 'a',
      actorType: 'user', deviceId: 'd', role: 'owner',
    };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  const { state, writes } = createInMemoryStores();
  const v2Executor = async (operation: {
    tool: string; workspaceId: string; normalizedArgs: unknown; idempotencyKey: string; actorId: string;
  }) =>
    requireApprovalToolContract(operation.tool).executor({
      writes,
      workspaceId: operation.workspaceId,
      args: operation.normalizedArgs,
      idempotencyKey: operation.idempotencyKey,
      actorId: operation.actorId,
    });
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }),
    v2Store,
    v2Executor,
    v2Only: true,
    readModel: {
      listAccounts: async (householdId: string) =>
        state.accounts.filter(
          (a) => a.householdId === householdId && a.status === 'active' && a.kind !== 'credit_card',
        ),
      // Espelha o read-model real: só categorias ativas.
      listCategories: async (householdId: string) => {
        if (onListCategories) await onListCategories();
        return state.categories.filter(
          (c) => c.householdId === householdId && (c as { status?: string }).status === 'active',
        );
      },
    },
  });
  return { app, v2Store, state, writes };
};

const propose = (app: FastifyInstance, key: string | undefined, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/pending-operations/v2/propose',
    ...(key !== undefined ? { headers: { 'idempotency-key': key } } : {}),
    payload: body,
  });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const seedParent = (h: ReturnType<typeof harness>, name = 'Alimentação') =>
  h.writes.createCategory('w', { name, kind: 'expense' });

describe('categories.create propose (replay-first + parent gate)', () => {
  it('raiz feliz → 201', async () => {
    const h = harness();
    const res = await propose(h.app, randomUUID(), { tool: 'categories.create', normalizedArgs: catArgs() });
    expect(res.statusCode).toBe(201);
  });

  it('pai vivo → 201', async () => {
    const h = harness();
    const parent = await seedParent(h);
    const res = await propose(h.app, randomUUID(), {
      tool: 'categories.create',
      normalizedArgs: catArgs('Mercado', 'expense', parent.id),
    });
    expect(res.statusCode).toBe(201);
  });

  it('pai desconhecido → 404 not_found, sem vazar existência', async () => {
    const h = harness();
    const res = await propose(h.app, randomUUID(), {
      tool: 'categories.create',
      normalizedArgs: catArgs('Mercado', 'expense', randomUUID()),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('F6 RED: retry mesma chave + mesmos args após pai sair do ar → 200 replay (não 404)', async () => {
    const h = harness();
    const parent = await seedParent(h);
    const key = randomUUID();
    const body = { tool: 'categories.create', normalizedArgs: catArgs('Mercado', 'expense', parent.id) };
    const first = await propose(h.app, key, body);
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;
    await h.writes.deactivateCategory('w', parent.id);
    const replay = await propose(h.app, key, body);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { id: string }).id).toBe(firstId);
    expect((replay.json() as { existing: boolean }).existing).toBe(true);
  });

  it('mesma chave + payload divergente → 409 idempotency.conflict', async () => {
    const h = harness();
    const key = randomUUID();
    const first = await propose(h.app, key, { tool: 'categories.create', normalizedArgs: catArgs('A') });
    expect(first.statusCode).toBe(201);
    const clash = await propose(h.app, key, { tool: 'categories.create', normalizedArgs: catArgs('B') });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe('idempotency.conflict');
  });

  it('F6 RED: corrida — vencedor commita a mesma proposta durante o gate → 200 replay (não 404)', async () => {
    const gate = deferred();
    let gateOpen = false;
    const h = harness(async () => {
      if (!gateOpen) await gate.promise;
    });
    const parent = await seedParent(h);
    const key = randomUUID();
    const normalizedArgs = catArgs('Filha', 'expense', parent.id);
    // B observa chave ausente e estaciona no gate mutável.
    const pendingB = propose(h.app, key, { tool: 'categories.create', normalizedArgs });
    // A (vencedor) commita a MESMA proposta enquanto B está no gate.
    const draftHash = await computePendingOperationV2Hash({
      tool: 'categories.create',
      normalizedArgs,
      workspaceId: 'w',
      actorId: 'a',
      deviceId: 'd',
    });
    const now = Date.now();
    const winner = await h.v2Store.propose({
      version: 2 as const,
      workspaceId: 'w',
      actorId: 'a',
      deviceId: 'd',
      tool: 'categories.create',
      normalizedArgs: normalizedArgs as never,
      proposalHash: draftHash,
      idempotencyKey: key,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      bindings: { workspaceId: 'w', actorId: 'a', deviceId: 'd' },
    });
    // O pai sai do ar antes de B retomar: sem o replay-after, B responderia 404.
    await h.writes.deactivateCategory('w', parent.id);
    gateOpen = true;
    gate.resolve();
    const b = await pendingB;
    expect(b.statusCode).toBe(200);
    expect((b.json() as { id: string }).id).toBe(winner.id);
    expect((b.json() as { existing: boolean }).existing).toBe(true);
  });
});

describe('categories.create parent-gone (F7a: presentation nula + gate 409)', () => {
  it('pai removido após propose → listing sem presentation; confirm 409 approval.not_actionable', async () => {
    const h = harness();
    const parent = await seedParent(h);
    const proposed = await propose(h.app, randomUUID(), {
      tool: 'categories.create',
      normalizedArgs: catArgs('Mercado', 'expense', parent.id),
    });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;
    await h.writes.deactivateCategory('w', parent.id);
    const active = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(active.statusCode).toBe(200);
    const item = (active.json() as { items: Array<{ presentation?: unknown }> }).items[0]!;
    expect(item.presentation == null).toBe(true);
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().code).toBe('approval.not_actionable');
  });

  it('raiz segue confirmável (sem regressão): confirm 200', async () => {
    const h = harness();
    const proposed = await propose(h.app, randomUUID(), { tool: 'categories.create', normalizedArgs: catArgs() });
    expect(proposed.statusCode).toBe(201);
    const pendingId = (proposed.json() as { id: string }).id;
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    expect(typeof (confirmed.json() as { attestation?: unknown }).attestation).toBe('string');
  });
});
