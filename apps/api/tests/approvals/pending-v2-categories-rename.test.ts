/**
 * categories.update (rename-only, name-only) no fluxo V2 — prova comportamental
 * da ROTA (propose replay-first + hash-bound auth antes do gate mutável,
 * alvo no workspace, expectedName stale, apresentação De → Para e execute).
 *
 * Contrato: normalizedArgs STRICT {categoryId UUID, name trim 1..120,
 * expectedName nonempty}; manual-only (nunca autoexec); o propose valida o
 * schema e o alvo (categoria deste workspace, nome atual == expectedName)
 * ANTES de persistir; o replay da MESMA proposta (mesma chave + mesmo
 * hash) devolve a existente ANTES de qualquer leitura mutável.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AUTOEXECUTION_ELIGIBLE_TOOLS,
  createApprovalPolicy,
} from '../../src/approvals/policy.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import {
  getApprovalToolContract,
  requireApprovalToolContract,
  validateApprovalToolArgs,
} from '../../src/approvals/tool-registry.js';
import { isActionablePendingOperationPresentation } from '@pi-finance/llm-contracts';
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

const renameArgs = (categoryId: string, name = 'Categoria Nova', expectedName = 'Categoria Velha') => ({
  categoryId,
  name,
  expectedName,
});
const deactivateArgs = (categoryId: string, expectedName = 'Categoria Velha') => ({ categoryId, expectedName });

const harness = () => {
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
      listAccounts: async () => [],
      // Espelha o read-model real: só as categorias ativas deste household.
      listCategories: async (householdId: string) =>
        state.categories.filter((category) => category.householdId === householdId && category.status === 'active'),
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

const seedCategory = async (h: ReturnType<typeof harness>, name = 'Categoria Velha', householdId = 'w') =>
  h.writes.createCategory(householdId, { name, kind: 'expense' });

describe('categories.update registry (rename-only, manual-only)', () => {
  it('contrato registrado com schema estrito e nunca auto-execução', () => {
    const contract = getApprovalToolContract('categories.update');
    expect(contract).toBeDefined();
    expect(contract?.approvalRequired).toBe(true);
    expect(contract?.autoExecutionEligible).toBe(false);
    expect(AUTOEXECUTION_ELIGIBLE_TOOLS.has('categories.update')).toBe(false);
  });

  it('schema estrito rejeita campo extra, uuid ruim, nome vazio/longo e expectedName ausente', () => {
    const id = randomUUID();
    expect(validateApprovalToolArgs('categories.update', { categoryId: id, name: 'N', expectedName: 'V', extra: 1 } as never).success).toBe(false);
    expect(validateApprovalToolArgs('categories.update', { categoryId: 'nope', name: 'N', expectedName: 'V' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.update', { categoryId: id, name: '  ', expectedName: 'V' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.update', { categoryId: id, name: 'x'.repeat(121), expectedName: 'V' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.update', { categoryId: id, name: 'N' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.update', { categoryId: id, name: 'N', expectedName: 'V' }).success).toBe(true);
  });

  it('policy: sempre require_confirmation, nunca auto_execute', () => {
    const policy = createApprovalPolicy();
    const decision = policy.evaluateMutation({
      tool: 'categories.update',
      workspaceId: 'w',
      destructive: false,
      complete: true,
      ambiguousEntity: false,
      duplicateSuspected: false,
      explicitIntent: true,
      amountCents: 1,
    });
    expect(decision.action).toBe('require_confirmation');
  });
});

describe('categories.update propose (replay primeiro + gate mutável)', () => {
  it('(1) proposta válida cria a operação; a mesma chave + mesmos args devolve a existente (200, existing)', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const key = randomUUID();
    const first = await propose(h.app, key, { tool: 'categories.update', normalizedArgs: renameArgs(category.id) });
    expect(first.statusCode).toBe(201);
    const replay = await propose(h.app, key, { tool: 'categories.update', normalizedArgs: renameArgs(category.id) });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().existing).toBe(true);
    expect(replay.json().id).toBe(first.json().id);
  });

  it('(2) replay ANTES do gate mutável: após o rename, a mesma chave ainda devolve a existente (nunca 409)', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const key = randomUUID();
    const args = renameArgs(category.id);
    const first = await propose(h.app, key, { tool: 'categories.update', normalizedArgs: args });
    expect(first.statusCode).toBe(201);
    // O nome muda fora do propose: o expectedName fica stale.
    await h.writes.updateCategory('w', category.id, { name: 'Categoria Outro' }, { idempotencyKey: randomUUID(), expectedName: 'Categoria Velha' });
    const replay = await propose(h.app, key, { tool: 'categories.update', normalizedArgs: args });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().existing).toBe(true);
  });

  it('(3) expectedName divergente (stale) numa proposta NOVA → 409 conflict', async () => {
    const h = harness();
    const category = await seedCategory(h);
    await h.writes.updateCategory('w', category.id, { name: 'Categoria Mudada' }, { idempotencyKey: randomUUID(), expectedName: 'Categoria Velha' });
    const res = await propose(h.app, randomUUID(), { tool: 'categories.update', normalizedArgs: renameArgs(category.id) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('category.name_conflict');
  });

  it('(4) alvo inexistente → 404 (sem oráculo de existência além do rename)', async () => {
    const h = harness();
    const res = await propose(h.app, randomUUID(), { tool: 'categories.update', normalizedArgs: renameArgs(randomUUID()) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('(5) alvo de OUTRO workspace → 404 (escopo do household)', async () => {
    const h = harness();
    const foreign = await seedCategory(h, 'Categoria Extranha', 'outro-workspace');
    const res = await propose(h.app, randomUUID(), { tool: 'categories.update', normalizedArgs: renameArgs(foreign.id) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('(6) args inválidos → 422 (schema estrito antes de qualquer leitura)', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const res = await propose(h.app, randomUUID(), { tool: 'categories.update', normalizedArgs: { categoryId: category.id, name: 'N' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('approval.invalid_args');
  });
});

describe('categories.update apresentação + execute', () => {
  it('(7) apresentação De → Para é acionável só com o nome atual exato', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const key = randomUUID();
    const res = await propose(h.app, key, { tool: 'categories.update', normalizedArgs: renameArgs(category.id) });
    expect(res.statusCode).toBe(201);
    // A apresentação é derivada server-side no listing (rótulo do read-model).
    const listing = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(listing.statusCode).toBe(200);
    const items = listing.json().items as Array<{
      tool: string;
      presentation?: {
        tool: string;
        title: string;
        categoryName?: string;
        category?: { id: string; label: string };
      };
    }>;
    const item = items.find((entry) => entry.tool === 'categories.update');
    expect(item).toBeDefined();
    const presentation = item!.presentation;
    expect(presentation?.tool).toBe('categories.update');
    expect(presentation?.title).toBe('Renomear categoria');
    expect(presentation?.categoryName).toBe('Categoria Nova');
    expect(presentation?.category?.id).toBe(category.id);
    expect(presentation?.category?.label).toBe('Categoria Velha');
    expect(isActionablePendingOperationPresentation(presentation as never)).toBe(true);
  });

  it('(7b) alvo ausente (nome divergente no read-model) deixa a apresentação NÃO acionável', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const key = randomUUID();
    const res = await propose(h.app, key, { tool: 'categories.update', normalizedArgs: renameArgs(category.id) });
    expect(res.statusCode).toBe(201);
    // O read-model deixa de resolver o alvo (categoria removida do catálogo).
    h.state.categories = h.state.categories.filter((row) => row.id !== category.id);
    const listing = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const items = listing.json().items as Array<{ tool: string; presentation?: { tool: string } }>;
    const item = items.find((entry) => entry.tool === 'categories.update');
    // Sem rótulo resolvido não há apresentação acionável: o card degrada.
    expect(isActionablePendingOperationPresentation(item!.presentation as never)).toBe(false);
  });

  it('(8) execute renomeia e devolve o recibo categories.update com entity da categoria', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const res = await propose(h.app, randomUUID(), { tool: 'categories.update', normalizedArgs: renameArgs(category.id) });
    const operationId = res.json().id as string;
    const receipt = await requireApprovalToolContract('categories.update').executor({
      writes: h.writes,
      workspaceId: 'w',
      args: renameArgs(category.id),
      idempotencyKey: randomUUID(),
      actorId: 'a',
    });
    expect(receipt.receipt.mutationKind).toBe('categories.update');
    expect(receipt.receipt.entity).toEqual({ type: 'category', id: category.id });
    const renamed = h.state.categories.find((row) => row.id === category.id);
    expect(renamed?.name).toBe('Categoria Nova');
    expect(operationId).toBeTruthy();
  });
});

describe('categories.deactivate Pending V2 (manual, keyed and target-bound)', () => {
  it('rejects extra args and is never eligible for auto-execution', () => {
    const contract = getApprovalToolContract('categories.deactivate');
    expect(contract).toBeDefined();
    expect(contract?.autoExecutionEligible).toBe(false);
    expect(validateApprovalToolArgs('categories.deactivate', { ...deactivateArgs(randomUUID()), bogus: true }).success).toBe(false);
  });

  it('proposes only for an active category with its exact current name; replay wins before the changed target', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const key = randomUUID();
    const body = { tool: 'categories.deactivate', normalizedArgs: deactivateArgs(category.id) };
    const first = await propose(h.app, key, body);
    expect(first.statusCode).toBe(201);
    await h.writes.updateCategory('w', category.id, { name: 'Alterada' }, { idempotencyKey: randomUUID(), expectedName: 'Categoria Velha' });
    const replay = await propose(h.app, key, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, existing: true });
    const stale = await propose(h.app, randomUUID(), body);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('category.name_conflict');
  });

  it('presentation is actionable only while server-resolved category name equals expectedName', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const proposed = await propose(h.app, randomUUID(), { tool: 'categories.deactivate', normalizedArgs: deactivateArgs(category.id) });
    expect(proposed.statusCode).toBe(201);
    const listing = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const item = listing.json().items.find((row: { tool: string }) => row.tool === 'categories.deactivate');
    expect(item.presentation).toMatchObject({ tool: 'categories.deactivate', title: 'Desativar categoria', category: { id: category.id, label: 'Categoria Velha' } });
    expect(isActionablePendingOperationPresentation(item.presentation)).toBe(true);
    await h.writes.updateCategory('w', category.id, { name: 'Alterada' }, { idempotencyKey: randomUUID(), expectedName: 'Categoria Velha' });
    const staleList = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const staleItem = staleList.json().items.find((row: { tool: string }) => row.tool === 'categories.deactivate');
    expect(isActionablePendingOperationPresentation(staleItem.presentation)).toBe(false);
  });

  it('deactivation presentation includes the target kind and resolved parent when the catalog has them', async () => {
    const h = harness();
    const parent = await h.writes.createCategory('w', { name: 'QA Alimentação', kind: 'expense' });
    const category = await h.writes.createCategory('w', { name: 'QA Viagem Jade', kind: 'expense', parentId: parent.id });
    const proposed = await propose(h.app, randomUUID(), { tool: 'categories.deactivate', normalizedArgs: deactivateArgs(category.id, category.name) });
    expect(proposed.statusCode).toBe(201);
    const listing = await h.app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const item = listing.json().items.find((row: { tool: string }) => row.tool === 'categories.deactivate');
    expect(item.presentation).toMatchObject({
      category: { id: category.id, label: 'QA Viagem Jade' },
      categoryKind: 'expense',
      categoryParent: { id: parent.id, label: 'QA Alimentação' },
    });
  });

  it('executes keyed deactivate and refuses writer failures without fabricating a receipt', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const contract = requireApprovalToolContract('categories.deactivate');
    const result = await contract.executor({ writes: h.writes, workspaceId: 'w', args: deactivateArgs(category.id), idempotencyKey: 'deactivate-one', actorId: 'a' });
    expect(result.receipt).toMatchObject({ mutationKind: 'categories.deactivate', operationId: category.id, entity: { type: 'category', id: category.id } });
    expect(h.state.categories.find((row) => row.id === category.id)?.status).toBe('inactive');

    const inUse = await seedCategory(h, 'Com dependência');
    const guardedWrites = { ...h.writes, deactivateCategory: async () => { throw new Error('writer failed'); } };
    await expect(contract.executor({ writes: guardedWrites, workspaceId: 'w', args: deactivateArgs(inUse.id, inUse.name), idempotencyKey: 'deactivate-fail', actorId: 'a' }))
      .rejects.toMatchObject({ code: 'approval.execution_uncertain' });
  });

  it('confirms and executes the actual Pending V2 operation with a category-bound receipt', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const proposed = await propose(h.app, randomUUID(), { tool: 'categories.deactivate', normalizedArgs: deactivateArgs(category.id) });
    expect(proposed.statusCode).toBe(201);
    const pendingId = proposed.json().id as string;
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    const attestation = confirmed.json().attestation as string;
    const executed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`, payload: { attestation } });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      status: 'succeeded',
      execution: { status: 'succeeded', operationId: category.id, receipt: {
        mutationKind: 'categories.deactivate', operationId: pendingId,
        entity: { type: 'category', id: category.id },
      } },
    });
    expect(h.state.categories.find((row) => row.id === category.id)?.status).toBe('inactive');
  });

  it('a referenced category fails execution honestly; the proposal never yields a success receipt', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const account = await h.writes.createAccount('w', { name: 'QA conta', kind: 'bank', initialBalanceCents: 0 });
    const transaction = await h.writes.createExpense('w', {
      description: 'QA referência preservada', amountCents: 100, date: '2026-10-22', accountId: account.id, categoryId: category.id,
    });
    // The deactivation guard covers historical soft-deleted references too.
    h.state.deletedTransactions.add(transaction.id);
    const proposed = await propose(h.app, randomUUID(), { tool: 'categories.deactivate', normalizedArgs: deactivateArgs(category.id) });
    expect(proposed.statusCode).toBe(201);
    const pendingId = proposed.json().id as string;
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    const attestation = confirmed.json().attestation as string;
    const executed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`, payload: { attestation } });
    expect(executed.statusCode).not.toBe(200);
    expect(executed.json().execution?.receipt).toBeUndefined();
    expect(h.state.categories.find((row) => row.id === category.id)?.status).toBe('active');
    expect(h.state.transactions.find((row) => row.id === transaction.id)?.categoryId).toBe(category.id);
  });

  it('rename between proposal and execute fails the writer CAS without a receipt or status change', async () => {
    const h = harness();
    const category = await seedCategory(h);
    const proposed = await propose(h.app, randomUUID(), { tool: 'categories.deactivate', normalizedArgs: deactivateArgs(category.id) });
    const pendingId = proposed.json().id as string;
    const confirmed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/confirm`, payload: {} });
    const attestation = confirmed.json().attestation as string;
    await h.writes.updateCategory('w', category.id, { name: 'Renomeada após proposta' }, { idempotencyKey: randomUUID(), expectedName: category.name });
    const executed = await h.app.inject({ method: 'POST', url: `/pending-operations/v2/${pendingId}/execute`, payload: { attestation } });
    expect(executed.json().status).not.toBe('succeeded');
    expect(executed.json().execution?.receipt).toBeUndefined();
    expect(h.state.categories.find((row) => row.id === category.id)).toMatchObject({ name: 'Renomeada após proposta', status: 'active' });
  });
});
