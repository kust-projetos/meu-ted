import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';

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
];

const scopedApp = (
  identity: { workspace: string; actor: string; device: string },
  readModel?: {
    listAccounts: (householdId: string) => Promise<Array<{ id: string; name: string }>>;
    listCategories: (householdId: string) => Promise<Array<{ id: string; name: string }>>;
  },
  cardStore?: {
    listCreditCardAccounts: (householdId: string) => Promise<Array<{ id: string; name: string }>>;
  },
  goalStore?: { listGoals: (householdId: string) => Promise<Array<{ id: string; name: string }>> },
) => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: identity.actor, workspace: identity.workspace,
      role: 'owner', capabilities: ALL, jti: crypto.randomUUID(), request: 'r',
      deviceId: identity.device, iat: 1, exp: 301,
    };
    request.authenticatedContext = {
      householdId: identity.workspace, actorId: identity.actor, authUserId: identity.actor,
      actorType: 'user', deviceId: identity.device, role: 'owner',
    };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }),
    v2Store,
    v2Only: true,
    ...(readModel ? { readModel } : {}),
    ...(cardStore ? { cardStore } : {}),
    ...(goalStore ? { goalStore } : {}),
  } as Parameters<typeof registerPendingOperationRoutes>[1]);
  return { app, v2Store };
};

const FORBIDDEN = ['attestation', 'attestationHash', 'attestation_hash', 'proposalHash', 'proposal_hash', 'normalizedArgs', 'normalized_args', 'idempotencyKey', 'token'];

describe('FIX-P1 RED: GET /pending-operations/v2/active carries canonical presentation', () => {
  it('returns a browser-safe presentation derived from the hash-bound record', async () => {
    const { app } = scopedApp({ workspace: 'ws-p1', actor: 'a', device: 'd' });
    const args = {
      description: 'Mercado',
      amountCents: 85000,
      date: '2026-09-14',
      accountId: crypto.randomUUID(),
      categoryId: crypto.randomUUID(),
    };
    const created = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'p1-key-1' },
      payload: { tool: 'transactions.expense.create', normalizedArgs: args },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    const item = body.items[0]!;
    const presentation = item.presentation as Record<string, unknown> | undefined;
    expect(presentation).toBeDefined();
    expect(presentation!.id).toBe(item.id);
    expect(presentation!.status).toBe('proposed');
    expect(presentation!.tool).toBe('transactions.expense.create');
    expect(presentation!.title).toBe('Confirmar despesa');
    expect(presentation!.amountCents).toBe(85000);
    expect(presentation!.description).toBe('Mercado');
    expect(presentation!.date).toBe('2026-09-14');
    expect(presentation!.expiresAt).toBe(item.expiresAt);
    expect(Array.isArray(presentation!.warnings)).toBe(true);
    for (const key of FORBIDDEN) {
      expect(item).not.toHaveProperty(key);
      expect(presentation!).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain('attestation');
    expect(JSON.stringify(body)).not.toContain('normalizedArgs');
    expect(JSON.stringify(body)).not.toContain('proposalHash');
  });

  it('resolves goal contribution name on active presentation without exposing the goal UUID', async () => {
    const goalId = crypto.randomUUID();
    const { app } = scopedApp(
      { workspace: 'ws-goal-label', actor: 'a', device: 'd' },
      undefined,
      undefined,
      { listGoals: async (householdId) => {
        expect(householdId).toBe('ws-goal-label');
        return [{ id: goalId, name: 'Reserva da casa' }];
      } },
    );
    const created = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'goal-label-key' },
      payload: { tool: 'goals.contribute', normalizedArgs: { goalId, amountCents: 5000 } },
    });
    expect(created.statusCode).toBe(201);
    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(200);
    const presentation = response.json().items[0].presentation;
    expect(presentation).toMatchObject({
      title: 'Aporte na meta — R$ 50,00', description: 'Reserva da casa',
      goal: { label: 'Reserva da casa' },
    });
    expect(presentation.goal.id).toBe(goalId);
    expect([presentation.title, presentation.description, presentation.goal.label].join(' ')).not.toContain(goalId);
  });

  it('uses a generic goal label and keeps the listing available when goal lookup fails', async () => {
    const goalId = crypto.randomUUID();
    const { app } = scopedApp(
      { workspace: 'ws-goal-label-error', actor: 'a', device: 'd' },
      undefined,
      undefined,
      { listGoals: async () => { throw new Error('lookup unavailable'); } },
    );
    await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'goal-label-error-key' },
      payload: { tool: 'goals.contribute', normalizedArgs: { goalId, amountCents: 5000 } },
    });
    const response = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(response.statusCode).toBe(200);
    const presentation = response.json().items[0].presentation;
    expect(presentation).toMatchObject({ description: 'Aporte em meta', goal: { label: 'Meta' } });
    expect(presentation.goal.id).toBe(goalId);
    expect([presentation.title, presentation.description, presentation.goal.label].join(' ')).not.toContain(goalId);
  });

  it('FIX-P1 labels RED: resolves account/category labels server-side from the authoritative read model', async () => {
    const accountId = crypto.randomUUID();
    const categoryId = crypto.randomUUID();
    const readModel = {
      listAccounts: async (householdId: string) => {
        expect(householdId).toBe('ws-p1-labels');
        return [{ id: accountId, name: 'Conta Nubank' }];
      },
      listCategories: async (householdId: string) => {
        expect(householdId).toBe('ws-p1-labels');
        return [{ id: categoryId, name: 'Alimentação' }];
      },
    };
    const { app } = scopedApp({ workspace: 'ws-p1-labels', actor: 'a', device: 'd' }, readModel);
    const created = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'p1-key-labels' },
      payload: {
        tool: 'transactions.expense.create',
        normalizedArgs: { description: 'Mercado', amountCents: 85000, date: '2026-09-14', accountId, categoryId },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    const presentation = body.items[0]!.presentation as Record<string, unknown>;
    // Labels come from the server-side read model — never from PWA/LLM input.
    expect(presentation.account).toEqual({ id: accountId, label: 'Conta Nubank' });
    expect(presentation.category).toEqual({ id: categoryId, label: 'Alimentação' });
    // Resolvable labels: no honest-unavailability warnings.
    expect(presentation.warnings).toEqual([]);
    for (const key of FORBIDDEN) {
      expect(presentation).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain('attestation');
  });

  it('FIX-P1 labels RED: omits labels honestly when ids are unknown to the read model', async () => {
    const readModel = {
      listAccounts: async () => [{ id: crypto.randomUUID(), name: 'Outra conta' }],
      listCategories: async () => [{ id: crypto.randomUUID(), name: 'Outra categoria' }],
    };
    const { app } = scopedApp({ workspace: 'ws-p1-nolabel', actor: 'a', device: 'd' }, readModel);
    const created = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'p1-key-nolabel' },
      payload: {
        tool: 'transactions.expense.create',
        normalizedArgs: { description: 'Mercado', amountCents: 85000, date: '2026-09-14', accountId: crypto.randomUUID(), categoryId: crypto.randomUUID() },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
    const presentation = body.items[0]!.presentation as Record<string, unknown>;
    expect(presentation.amountCents).toBe(85000);
    expect(presentation.description).toBe('Mercado');
    expect(presentation.date).toBe('2026-09-14');
    // Unresolvable ids are omitted — never invented — with honest warnings
    // so the card can fail closed (V3-FIX-CARD-FAILCLOSED).
    expect(presentation).not.toHaveProperty('account');
    expect(presentation).not.toHaveProperty('category');
    expect(presentation.warnings).toEqual(
      expect.arrayContaining([
        'Dados da conta indisponíveis no momento',
        'Dados da categoria indisponíveis no momento',
      ]),
    );
  });

  it('FIX-P1 labels RED: a label-lookup failure never fails the listing', async () => {
    const readModel = {
      listAccounts: async (): Promise<Array<{ id: string; name: string }>> => { throw new Error('read model down'); },
      listCategories: async (): Promise<Array<{ id: string; name: string }>> => { throw new Error('read model down'); },
    };
    const { app } = scopedApp({ workspace: 'ws-p1-labelfail', actor: 'a', device: 'd' }, readModel);
    const created = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'p1-key-labelfail' },
      payload: {
        tool: 'transactions.expense.create',
        normalizedArgs: { description: 'Mercado', amountCents: 85000, date: '2026-09-14', accountId: crypto.randomUUID(), categoryId: crypto.randomUUID() },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    const presentation = body.items[0]!.presentation as Record<string, unknown>;
    expect(presentation.amountCents).toBe(85000);
    expect(presentation).not.toHaveProperty('account');
    expect(presentation).not.toHaveProperty('category');
    // A read-model outage degrades honestly - never a 500, never invented labels.
    expect(presentation.warnings).toEqual(
      expect.arrayContaining([
        'Dados da conta indisponíveis no momento',
        'Dados da categoria indisponíveis no momento',
      ]),
    );
  });

  it('P3.4: resolves the CARD label from the CardStore and keeps the card purchase actionable', async () => {
    const cardId = crypto.randomUUID();
    // The generic read model deliberately excludes credit cards - it only
    // returns bank/cash accounts. The card label must come from CardStore.
    const readModel = {
      listAccounts: async () => [{ id: crypto.randomUUID(), name: 'Conta corrente' }],
      listCategories: async () => [],
    };
    const cardStore = {
      listCreditCardAccounts: async (householdId: string) => {
        expect(householdId).toBe('ws-p1-card');
        return [{ id: cardId, name: 'Nubank Card' }];
      },
    };
    const { app } = scopedApp({ workspace: 'ws-p1-card', actor: 'a', device: 'd' }, readModel, cardStore);
    const created = await app.inject({
      method: 'POST',
      url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'p34-card-key-1' },
      payload: {
        tool: 'cards.purchase.create',
        normalizedArgs: {
          description: 'supermercado',
          amountCents: 15000,
          date: '2026-11-07',
          accountId: cardId,
        },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    const presentation = body.items[0]!.presentation as Record<string, unknown>;
    expect(presentation.title).toBe('Confirmar compra no cartão');
    expect(presentation.account).toEqual({ id: cardId, label: 'Nubank Card' });
    expect(presentation.amountCents).toBe(15000);
    expect(presentation.description).toBe('supermercado');
    expect(presentation.warnings).toEqual([]);
  });
});
