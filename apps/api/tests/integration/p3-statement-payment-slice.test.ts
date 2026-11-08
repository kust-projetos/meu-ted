/**
 * P3.6 — credit-card statement payment through the SAME Pending V2 protocol
 * (synthetic, real tool-registry executor, in-memory stores, no network):
 *
 *   message intent → propose persists a PENDING operation with ZERO financial
 *   writes → authoritative card (invoice/card/payer/total/paid/remaining) →
 *   authenticated confirm + execute → EXACTLY ONE payment: payer debited, card
 *   debt reduced, statement paid/status updated, canonical statement receipt.
 *
 * Also proves: rejection writes zero, reload rehydrates the same proposal,
 * overpay/already-paid/credit-card-payer are refused, and the competence
 * basis excludes the payment row (the original purchase stays).
 */
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createInMemoryPendingOperationV2Store, type PendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import { createInMemoryReadModelStoreFromState, type ReadModelStore } from '../../src/read-models/store.js';
import { createStoreAnalyticsSource } from '../../src/analytics/source.js';
import type { Account } from '../../src/types/domain.js';

const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BANK_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '11111111-1111-4111-8111-111111111112';
const FOREIGN_ID = '11111111-1111-4111-8111-111111111113';
const FUTURE_DATE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const WINDOW_FROM = TODAY.slice(0, 7) + '-01';
const WINDOW_TO = FUTURE_DATE;

const account = (id: string, householdId: string, name: string, balanceCents: number, kind: Account['kind'] = 'bank'): Account => ({
  id,
  householdId,
  name,
  kind,
  balanceCents,
  status: 'active',
  ...(kind === 'credit_card' ? { creditLimitCents: 500_000, closingDay: 15, dueDay: 25 } : {}),
});

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const identity = { workspaceId: WORKSPACE_A, actorId: 'actor-a', deviceId: 'device-a' };

async function harness() {
  const { state, writes } = createInMemoryStores({
    accounts: [
      account(BANK_ID, WORKSPACE_A, 'Itaú', 100_000),
      account(CARD_ID, WORKSPACE_A, 'Nubank Card', 0, 'credit_card'),
      account(FOREIGN_ID, WORKSPACE_B, 'Bradesco', 90_000),
    ],
  });
  const cardStore = createInMemoryCardStore(state);
  await cardStore.createCardPurchase(WORKSPACE_A, {
    accountId: CARD_ID,
    description: 'compra',
    amountCents: 120_000,
    date: FUTURE_DATE,
  });
  const statement = (await cardStore.listStatements(WORKSPACE_A, CARD_ID))[0]!;
  const readModel = {
    // Production parity: active bank/cash accounts only (cards live in the
    // CardStore and are never payable accounts).
    listAccounts: async (householdId: string) =>
      state.accounts
        .filter((a) => a.householdId === householdId && a.status === 'active' && a.kind !== 'credit_card')
        .map((a) => ({ id: a.id, name: a.name })),
    listCategories: async () => [],
  } as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;
  const v2Store = createInMemoryPendingOperationV2Store();
  const app = appFor(v2Store, readModel, writes, cardStore);
  return { app, v2Store, state, cardStore, statement };
}

function appFor(
  v2Store: PendingOperationV2Store,
  readModel: Pick<ReadModelStore, 'listAccounts' | 'listCategories'>,
  writes: ReturnType<typeof createInMemoryStores>['writes'],
  cardStore: ReturnType<typeof createInMemoryCardStore>,
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
      jti: crypto.randomUUID(), request: 'req-p3-statement-pay', deviceId: identityOverride.deviceId, iat: 1, exp: 301,
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
    v2Executor: createPendingOperationV2Executor(writes, cardStore),
    v2Only: true,
    readModel,
    cardStore,
  });
  return app;
}

const payArgs = (statementId: string, overrides: Record<string, unknown> = {}) => ({
  statementId,
  fromAccountId: BANK_ID,
  amountCents: 120_000,
  ...overrides,
});

const propose = (app: FastifyInstance, key: string, statementId: string, args = payArgs(statementId)) =>
  app.inject({
    method: 'POST',
    url: '/pending-operations/v2/propose',
    headers: { 'idempotency-key': key },
    payload: { tool: 'cards.statement.pay', normalizedArgs: args },
  });

const execute = async (app: FastifyInstance, id: string, attestation: string) =>
  app.inject({
    method: 'POST',
    url: `/pending-operations/v2/${id}/execute`,
    payload: { attestation },
  });

const paymentRows = (state: { transactions: Array<{ kind: string; householdId: string; statementPaymentId?: string }> }) =>
  state.transactions.filter((t) => t.householdId === WORKSPACE_A && t.kind === 'expense' && t.statementPaymentId !== undefined);

const bank = (state: { accounts: Account[] }) => state.accounts.find((a) => a.id === BANK_ID)!;
const card = (state: { accounts: Account[] }) => state.accounts.find((a) => a.id === CARD_ID)!;

describe('P3.6 statement payment slice — propose/confirm/reject invariants (synthetic, real executor)', () => {
  it('proposes with ZERO writes, then confirms ONE total payment and updates bank/card/statement', async () => {
    const { app, state, cardStore, statement } = await harness();
    const beforeBank = bank(state).balanceCents;
    const beforeCard = card(state).balanceCents;

    const proposed = await propose(app, 'key-total', statement.id);
    expect(proposed.statusCode).toBe(201);
    expect(paymentRows(state)).toHaveLength(0);
    expect(bank(state).balanceCents).toBe(beforeBank);
    expect(card(state).balanceCents).toBe(beforeCard);

    const id = proposed.json().id as string;
    const active = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const cardItem = (active.json().items as Array<{ id: string; presentation?: Record<string, unknown> }>).find((item) => item.id === id);
    expect(cardItem?.presentation).toMatchObject({
      tool: 'cards.statement.pay',
      title: 'Pagamento de fatura — R$ 1.200,00',
      amountCents: 120_000,
      account: { id: CARD_ID, label: 'Nubank Card' },
      fromAccount: { id: BANK_ID, label: 'Itaú' },
      statement: { id: statement.id, label: expect.any(String) },
      statementTotalCents: 120_000,
      statementPaidCents: 0,
      statementRemainingCents: 120_000,
      statementDueDate: statement.dueDate,
    });

    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    expect(confirmed.statusCode).toBe(200);
    expect(paymentRows(state)).toHaveLength(0);

    const executed = await execute(app, id, confirmed.json().attestation);
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe('succeeded');
    const receipt = executed.json().execution?.receipt ?? executed.json().receipt;
    expect(receipt.mutationKind).toBe('cards.statement.pay');
    expect(receipt.entity?.type).toBe('statement');
    expect(receipt.entity?.id).toBe(statement.id);

    expect(paymentRows(state)).toHaveLength(1);
    expect(bank(state).balanceCents).toBe(beforeBank - 120_000);
    expect(card(state).balanceCents).toBe(0);
    const after = (await cardStore.listStatements(WORKSPACE_A, CARD_ID))[0]!;
    expect(after.paidCents).toBe(120_000);
    expect(after.status).toBe('paid');
  });

  it('supports a partial payment and leaves the exact remaining balance', async () => {
    const { app, state, cardStore, statement } = await harness();
    const beforeBank = bank(state).balanceCents;
    const proposed = await propose(app, 'key-partial', statement.id, payArgs(statement.id, { amountCents: 30_000 }));
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const executed = await execute(app, id, confirmed.json().attestation);
    expect(executed.statusCode).toBe(200);
    expect(paymentRows(state)).toHaveLength(1);
    expect(bank(state).balanceCents).toBe(beforeBank - 30_000);
    expect(card(state).balanceCents).toBe(90_000);
    const after = (await cardStore.listStatements(WORKSPACE_A, CARD_ID))[0]!;
    expect(after.paidCents).toBe(30_000);
    expect(after.totalCents - after.paidCents).toBe(90_000);
    expect(after.status).toBe('partial');
  });

  it('rejection writes zero financial movement', async () => {
    const { app, state, statement } = await harness();
    const beforeBank = bank(state).balanceCents;
    const beforeCard = card(state).balanceCents;
    const proposed = await propose(app, 'key-reject', statement.id);
    const id = proposed.json().id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const cancelled = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(paymentRows(state)).toHaveLength(0);
    expect(bank(state).balanceCents).toBe(beforeBank);
    expect(card(state).balanceCents).toBe(beforeCard);
    const blocked = await execute(app, id, confirmed.json().attestation);
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
    expect(paymentRows(state)).toHaveLength(0);
  });

  it('refuses an overpayment at propose time with zero writes', async () => {
    const { app, state, statement } = await harness();
    const beforeBank = bank(state).balanceCents;
    const beforeCard = card(state).balanceCents;
    const proposed = await propose(app, 'key-overpay', statement.id, payArgs(statement.id, { amountCents: 130_000 }));
    expect(proposed.statusCode).toBe(422);
    expect(proposed.json().code).toBe('approval.invalid_args');
    expect(paymentRows(state)).toHaveLength(0);
    expect(bank(state).balanceCents).toBe(beforeBank);
    expect(card(state).balanceCents).toBe(beforeCard);
  });

  it('refuses a credit-card payer (never an actionable payer)', async () => {
    const { app, state, statement } = await harness();
    const proposed = await propose(app, 'key-card-payer', statement.id, payArgs(statement.id, { fromAccountId: CARD_ID }));
    expect(proposed.statusCode).toBe(404);
    expect(proposed.json().code).toBe('not_found');
    expect(paymentRows(state)).toHaveLength(0);
  });

  it('reload rehydrates the SAME proposal without repeating the intent', async () => {
    const { app, statement } = await harness();
    const proposed = await propose(app, 'key-reload', statement.id);
    const id = proposed.json().id as string;
    const first = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const second = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    const firstItem = (first.json().items as Array<{ id: string }>).find((item) => item.id === id);
    const secondItem = (second.json().items as Array<{ id: string }>).find((item) => item.id === id);
    expect(firstItem).toBeTruthy();
    expect(secondItem).toBeTruthy();
    const replay = await propose(app, 'key-reload', statement.id);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(id);
    expect(replay.json().existing).toBe(true);
  });

  it('refuses a second payment after the invoice is fully paid', async () => {
    const { app, statement } = await harness();
    const proposed = await propose(app, 'key-first-total', statement.id);
    const id = proposed.json().id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const executed = await execute(app, id, confirmed.json().attestation);
    expect(executed.statusCode).toBe(200);

    const second = await propose(app, 'key-second-total', statement.id, payArgs(statement.id, { amountCents: 1_000 }));
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('card.statement_already_paid');
  });

  it('keeps the competence aggregate free of the payment row (purchase counted once)', async () => {
    const { app, state, cardStore, statement } = await harness();
    const proposed = await propose(app, 'key-competence', statement.id, payArgs(statement.id, { amountCents: 30_000 }));
    const id = proposed.json().id as string;
    const confirmed = await app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/confirm` });
    const executed = await execute(app, id, confirmed.json().attestation);
    expect(executed.statusCode).toBe(200);

    // The payment row carries the canonical statement_payment_id; the
    // purchase row does not. The competence basis must exclude ONLY the
    // former, so the original purchase remains counted once.
    const rows = paymentRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statementPaymentId).toBe(statement.id);

    const source = createStoreAnalyticsSource({
      store: createInMemoryReadModelStoreFromState(state),
      cardStore,
    });
    const liquidity = await source.sumByKind(WORKSPACE_A, WINDOW_FROM, WINDOW_TO, { kind: 'household' }, { basis: 'liquidez' });
    const competence = await source.sumByKind(WORKSPACE_A, WINDOW_FROM, WINDOW_TO, { kind: 'household' }, { basis: 'competencia' });
    expect(liquidity.expense.cents).toBe(150_000);
    expect(competence.expense.cents).toBe(120_000);
    expect(competence.expense.cents).toBe(liquidity.expense.cents - 30_000);
  });
});
