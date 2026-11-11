/**
 * P3.3 — internal transfer through the SAME Pending V2 protocol (synthetic,
 * real tool-registry executor, in-memory WriteStore, no network):
 *
 *   transfer intent → propose persists a PENDING operation with ZERO ledger
 *   rows → authoritative card (title/amount/origin/destination) → authenticated
 *   confirm + execute → EXACTLY ONE `transfer` row and both balance legs.
 *
 * Also proves: rejection writes zero, reload keeps the proposal, cross-workspace
 * or unknown accounts are refused before persistence, the same-account proposal
 * is refused, the credit-card restriction survives, and a failed execution
 * leaves NO partial movement.
 */
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createInMemoryPendingOperationV2Store, type PendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import type { ReadModelStore } from '../../src/read-models/store.js';
import type { Account } from '../../src/types/domain.js';

const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FROM_ID = '11111111-1111-4111-8111-111111111111';
const TO_ID = '11111111-1111-4111-8111-111111111112';
const CARD_ID = '11111111-1111-4111-8111-111111111113';
const FOREIGN_ID = '11111111-1111-4111-8111-111111111114';

const account = (id: string, householdId: string, name: string, balanceCents: number, kind: Account['kind'] = 'bank'): Account => ({
  id,
  householdId,
  name,
  kind,
  balanceCents,
  status: 'active',
});

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const seed = () => [
  account(FROM_ID, WORKSPACE_A, 'Itaú', 100_000),
  account(TO_ID, WORKSPACE_A, 'Nubank', 50_000),
  account(CARD_ID, WORKSPACE_A, 'Cartão', 0, 'credit_card'),
  account(FOREIGN_ID, WORKSPACE_B, 'Bradesco', 90_000),
];

const identity = { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' };

function harness() {
  const { state, writes } = createInMemoryStores({ accounts: seed() });
  const readModel = {
    // Mirrors the production read model: active accounts of THIS workspace,
    // credit cards excluded (they are not transferable and live elsewhere).
    listAccounts: async (householdId: string) =>
      state.accounts
        .filter((a) => a.householdId === householdId && a.status === 'active' && a.kind !== 'credit_card')
        .map((a) => ({ id: a.id, name: a.name })),
    listCategories: async () => [],
  } as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;
  const v2Store = createInMemoryPendingOperationV2Store();
  const app = appFor(v2Store, readModel, writes);
  return { app, v2Store, state };
}

function appFor(
  v2Store: PendingOperationV2Store,
  readModel: Pick<ReadModelStore, 'listAccounts' | 'listCategories'>,
  writes: ReturnType<typeof createInMemoryStores>['writes'],
  identityOverride: typeof identity = identity,
): FastifyInstance {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: identityOverride.actorId,
      workspace: identityOverride.workspaceId, role: 'owner',
      capabilities: [
        'financial.approval.propose', 'financial.approval.read',
        'financial.approval.confirm', 'financial.approval.execute',
        'financial.approval.cancel', 'financial.approval.retry',
      ],
      jti: crypto.randomUUID(), request: 'req-p3-transfer', deviceId: identityOverride.deviceId, iat: 1, exp: 301,
    };
    request.authenticatedContext = {
      householdId: identityOverride.workspaceId,
      actorId: identityOverride.actorId,
      authUserId: identityOverride.actorId,
      actorType: 'user',
      deviceId: identityOverride.deviceId,
      role: 'owner',
    };
  });
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: identityOverride.workspaceId, deviceId: identityOverride.deviceId }),
    v2Store,
    v2Executor: createPendingOperationV2Executor(writes),
    v2Only: true,
    readModel,
  });
  return app;
}

const transferArgs = (overrides: Record<string, unknown> = {}) => ({
  description: 'Transferência Itaú → Nubank',
  amountCents: 30_000,
  date: '2026-11-07',
  fromAccountId: FROM_ID,
  toAccountId: TO_ID,
  ...overrides,
});

const propose = (app: FastifyInstance, key: string, args = transferArgs()) =>
  app.inject({
    method: 'POST',
    url: '/pending-operations/v2/propose',
    headers: { 'idempotency-key': key },
    payload: { tool: 'transactions.transfer.create', normalizedArgs: args },
  });

const balances = (state: { accounts: Account[] }) => ({
  from: state.accounts.find((a) => a.id === FROM_ID)?.balanceCents,
  to: state.accounts.find((a) => a.id === TO_ID)?.balanceCents,
});

const transferRows = (state: { transactions: Array<{ kind: string; householdId: string }> }) =>
  state.transactions.filter((t) => t.kind === 'transfer' && t.householdId === WORKSPACE_A);

describe('P3 transfer slice — propose/confirm/reject invariants (synthetic, real executor)', () => {
  it('propose writes ZERO rows; confirm+execute writes ONE atomic transfer and moves both balances', async () => {
    const { app, state } = harness();
    const before = balances(state);

    const proposed = await propose(app, 'key-happy');
    expect(proposed.statusCode).toBe(201);
    expect(transferRows(state)).toHaveLength(0);
    expect(balances(state)).toEqual(before);

    const id = proposed.json().id as string;
    const active = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const card = (active.json().items as Array<{ id: string; presentation?: Record<string, unknown> }>).find((item) => item.id === id);
    expect(card?.presentation).toMatchObject({
      tool: 'transactions.transfer.create',
      title: 'Transferência de R$ 300,00',
      amountCents: 30_000,
      fromAccount: { id: FROM_ID, label: 'Itaú' },
      toAccount: { id: TO_ID, label: 'Nubank' },
    });
    expect(card?.presentation).not.toHaveProperty('category');

    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    expect(confirmed.statusCode).toBe(200);
    expect(transferRows(state)).toHaveLength(0);

    const executed = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: confirmed.json().attestation },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe('succeeded');
    const receipt = executed.json().execution?.receipt ?? executed.json().receipt;
    expect(receipt.mutationKind).toBe('transactions.transfer.create');
    expect(receipt.entity?.type).toBe('transaction');

    // ONE transfer row — never an expense+income pair — and both legs moved.
    expect(transferRows(state)).toHaveLength(1);
    expect(state.transactions.filter((t) => t.kind === 'expense' || t.kind === 'income')).toHaveLength(0);
    expect(balances(state)).toEqual({ from: before.from! - 30_000, to: before.to! + 30_000 });
    expect(transferRows(state)[0]).toMatchObject({ transferToAccountId: TO_ID, amountCents: 30_000 });
  });

  it('rejection writes zero rows and blocks execution', async () => {
    const { app, state } = harness();
    const before = balances(state);
    const proposed = await propose(app, 'key-reject');
    const id = proposed.json().id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const cancelled = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(transferRows(state)).toHaveLength(0);
    expect(balances(state)).toEqual(before);

    const executed = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: confirmed.json().attestation },
    });
    expect(executed.statusCode).toBeGreaterThanOrEqual(400);
    expect(transferRows(state)).toHaveLength(0);
    expect(balances(state)).toEqual(before);
  });

  it('a repeated execute never duplicates the transfer (single-use attestation + idempotent key)', async () => {
    const { app, state } = harness();
    const proposed = await propose(app, 'key-replay');
    const id = proposed.json().id as string;
    const first = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: first.json().attestation },
    });
    expect(transferRows(state)).toHaveLength(1);

    const replay = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${id}/execute`,
      payload: { attestation: first.json().attestation },
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    const secondConfirm = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    if (secondConfirm.statusCode === 200 && typeof secondConfirm.json().attestation === 'string') {
      await app.inject({
        method: 'POST',
        url: `/pending-operations/v2/${id}/execute`,
        payload: { attestation: secondConfirm.json().attestation },
      });
    }
    expect(transferRows(state)).toHaveLength(1);
  });

  it('rejects the same origin and destination account before persisting', async () => {
    const { app, v2Store, state } = harness();
    const before = balances(state);
    const response = await propose(app, 'key-same', transferArgs({ toAccountId: FROM_ID }));
    expect(response.statusCode).toBe(422);
    expect(v2Store.audit.filter((e) => e.event === 'propose')).toHaveLength(0);
    expect(transferRows(state)).toHaveLength(0);
    expect(balances(state)).toEqual(before);
  });

  it('rejects an unknown or foreign-workspace account before persisting', async () => {
    const { app, v2Store, state } = harness();
    const before = balances(state);
    for (const key of ['key-foreign', 'key-unknown']) {
      const toAccountId = key === 'key-foreign' ? FOREIGN_ID : crypto.randomUUID();
      const response = await propose(app, key, transferArgs({ toAccountId }));
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('not_found');
    }
    expect(v2Store.audit.filter((e) => e.event === 'propose')).toHaveLength(0);
    expect(transferRows(state)).toHaveLength(0);
    expect(balances(state)).toEqual(before);
  });

  it('preserves the credit-card restriction: a card is not transferable', async () => {
    const { app } = harness();
    // The read model never lists cards, so a card target is refused at propose
    // exactly like an unknown destination (uniform "not transferable here").
    const asDestination = await propose(app, 'key-card-dest', transferArgs({ toAccountId: CARD_ID }));
    expect(asDestination.statusCode).toBe(404);
    const asSource = await propose(app, 'key-card-src', transferArgs({ fromAccountId: CARD_ID }));
    expect(asSource.statusCode).toBe(404);
  });

  it('a failed execution leaves NO partial movement', async () => {
    const { state, writes } = createInMemoryStores({ accounts: seed() });
    const before = balances(state);
    // Destination belongs to another workspace: the transfer fails inside the
    // atomic writer BEFORE any balance UPDATE, so neither leg moves.
    await expect(
      writes.createTransfer(WORKSPACE_A, {
        description: 'Transferência inválida',
        amountCents: 30_000,
        date: '2026-11-07',
        fromAccountId: FROM_ID,
        toAccountId: FOREIGN_ID,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(balances(state)).toEqual(before);
    expect(transferRows(state)).toHaveLength(0);
  });

  it('the pending transfer survives a reload (new app instance, same store)', async () => {
    const { state, writes } = createInMemoryStores({ accounts: seed() });
    const readModel = {
      listAccounts: async (householdId: string) =>
        state.accounts
          .filter((a) => a.householdId === householdId && a.status === 'active' && a.kind !== 'credit_card')
          .map((a) => ({ id: a.id, name: a.name })),
      listCategories: async () => [],
    } as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;
    const store = createInMemoryPendingOperationV2Store();

    const first = appFor(store, readModel, writes);
    const proposed = await propose(first, 'key-reload');
    const id = proposed.json().id as string;

    const reloaded = appFor(store, readModel, writes);
    const active = await reloaded.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(active.statusCode).toBe(200);
    expect(active.json().items.map((item: { id: string }) => item.id)).toContain(id);
    expect(transferRows(state)).toHaveLength(0);
  });
});
