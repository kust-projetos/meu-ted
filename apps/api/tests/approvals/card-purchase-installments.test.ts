/**
 * P3.5 — `cards.purchase.create` with the optional `installmentsTotal`.
 *
 * Unit-level proofs over the in-memory stores (the Postgres atomicity /
 * idempotency proofs live in
 * tests/integration/postgres-card-installments-idempotency.test.ts):
 * - absent or 1 keeps the EXACT P3.4 single-purchase path;
 * - 2..48 goes through `createCardInstallments` with the TOTAL amount;
 * - a declared split never silently degrades into a 1x purchase;
 * - the card debt grows by the total, the bank balance never moves;
 * - the canonical receipt is bound to the first created transaction.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import { createInMemoryWriteStore, type InMemoryState } from '../../src/writes/in-memory.js';
import { getApprovalToolContract } from '../../src/approvals/tool-registry.js';
import type { Account } from '../../src/types/domain.js';

const H = 'household-p35';
const PURCHASE_DATE = '2030-08-05'; // card closingDay 10 → cycle 2030-08

const baseState = (): InMemoryState => ({
  accounts: [],
  categories: [],
  transactions: [],
  deletedTransactions: new Set<string>(),
});

const bank = (): Account => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  householdId: H,
  name: 'Conta corrente',
  kind: 'bank',
  balanceCents: 500_00,
  status: 'active',
});

const setup = async () => {
  const state = baseState();
  state.accounts.push(bank());
  const cards = createInMemoryCardStore(state);
  const card = await cards.createCard(H, {
    name: 'Nubank',
    creditLimitCents: 5_000_00,
    closingDay: 10,
    dueDay: 20,
  });
  const writes = createInMemoryWriteStore(state);
  return { state, cards, card, writes };
};

const executor = () => getApprovalToolContract('cards.purchase.create')!.executor;

describe('P3.5 cards.purchase.create installments', () => {
  it('keeps the exact P3.4 path when installmentsTotal is absent', async () => {
    const { state, cards, card, writes } = await setup();
    const createInstallments = vi.spyOn(cards, 'createCardInstallments');

    const result = await executor()({
      writes,
      cardStore: cards,
      workspaceId: H,
      args: { accountId: card.id, amountCents: 150_00, description: 'supermercado', date: PURCHASE_DATE },
      idempotencyKey: 'k-1x-absent',
      actorId: 'actor-p35',
    });

    expect(result.status).toBe('succeeded');
    expect(createInstallments).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]!.amountCents).toBe(150_00);
    expect(card.balanceCents).toBe(150_00);
    expect(bankBalance(state)).toBe(500_00);
  });

  it('keeps the exact P3.4 path when installmentsTotal is 1', async () => {
    const { state, cards, card, writes } = await setup();
    const createInstallments = vi.spyOn(cards, 'createCardInstallments');

    const result = await executor()({
      writes,
      cardStore: cards,
      workspaceId: H,
      args: {
        accountId: card.id,
        amountCents: 150_00,
        description: 'supermercado',
        date: PURCHASE_DATE,
        installmentsTotal: 1,
      },
      idempotencyKey: 'k-1x-explicit',
      actorId: 'actor-p35',
    });

    expect(result.status).toBe('succeeded');
    expect(createInstallments).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(1);
  });

  it('creates 6 parcels of R$ 200 from a R$ 1.200 TOTAL and binds the receipt to the first', async () => {
    const { state, cards, card, writes } = await setup();

    const result = await executor()({
      writes,
      cardStore: cards,
      workspaceId: H,
      args: {
        accountId: card.id,
        amountCents: 1_200_00,
        description: 'celular',
        date: PURCHASE_DATE,
        installmentsTotal: 6,
      },
      idempotencyKey: 'k-6x',
      actorId: 'actor-p35',
    });

    expect(result.status).toBe('succeeded');
    expect(state.transactions).toHaveLength(6);
    expect(state.transactions.map((t) => t.amountCents)).toEqual([
      200_00, 200_00, 200_00, 200_00, 200_00, 200_00,
    ]);
    expect(state.transactions.map((t) => t.date)).toEqual([
      '2030-08-05',
      '2030-09-05',
      '2030-10-05',
      '2030-11-05',
      '2030-12-05',
      '2031-01-05',
    ]);
    expect(card.balanceCents).toBe(1_200_00);
    expect(bankBalance(state)).toBe(500_00);
    expect(result.receipt.mutationKind).toBe('cards.purchase.create');
    expect(result.receipt.entity?.id).toBe(state.transactions[0]!.id);
    expect(result.operationId).toBe(state.transactions[0]!.id);
  });

  it('uses the existing cent rule (R$ 10,00 in 3x → 3,33 + 3,33 + 3,34)', async () => {
    const { state, cards, card, writes } = await setup();

    await executor()({
      writes,
      cardStore: cards,
      workspaceId: H,
      args: {
        accountId: card.id,
        amountCents: 10_00,
        description: 'cafe',
        date: PURCHASE_DATE,
        installmentsTotal: 3,
      },
      idempotencyKey: 'k-cents',
      actorId: 'actor-p35',
    });

    expect(state.transactions.map((t) => t.amountCents)).toEqual([333, 333, 334]);
    expect(card.balanceCents).toBe(10_00);
  });

  it('rejects an out-of-range or non-integer parcel count before any write', async () => {
    for (const installmentsTotal of [0, 49, 1.5, -2]) {
      const { state, cards, card, writes } = await setup();
      await expect(
        executor()({
          writes,
          cardStore: cards,
          workspaceId: H,
          args: {
            accountId: card.id,
            amountCents: 1_200_00,
            description: 'celular',
            date: PURCHASE_DATE,
            installmentsTotal,
          },
          idempotencyKey: `k-invalid-${installmentsTotal}`,
          actorId: 'actor-p35',
        }),
      ).rejects.toThrow('validation.invalid_card_purchase_arguments');
      expect(state.transactions).toHaveLength(0);
      expect(card.balanceCents).toBe(0);
    }
  });

  it('rejects a total that cannot cover at least 1 cent per parcel', async () => {
    const { state, cards, card, writes } = await setup();
    await expect(
      executor()({
        writes,
        cardStore: cards,
        workspaceId: H,
        args: {
          accountId: card.id,
          amountCents: 2,
          description: 'doce',
          date: PURCHASE_DATE,
          installmentsTotal: 3,
        },
        idempotencyKey: 'k-zero-cent',
        actorId: 'actor-p35',
      }),
    ).rejects.toThrow('validation.invalid_card_purchase_arguments');
    expect(state.transactions).toHaveLength(0);
    expect(card.balanceCents).toBe(0);
  });

  it('never silently falls back to a single purchase when the declared split fails', async () => {
    const { state, cards, card, writes } = await setup();
    const createPurchase = vi.spyOn(cards, 'createCardPurchase');
    const failingStore = {
      ...cards,
      createCardInstallments: async () => {
        throw new Error('installment path unavailable');
      },
    };

    await expect(
      executor()({
        writes,
        cardStore: failingStore,
        workspaceId: H,
        args: {
          accountId: card.id,
          amountCents: 1_200_00,
          description: 'celular',
          date: PURCHASE_DATE,
          installmentsTotal: 6,
        },
        idempotencyKey: 'k-no-fallback',
        actorId: 'actor-p35',
      }),
    ).rejects.toMatchObject({ code: 'approval.execution_uncertain' });

    expect(createPurchase).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(0);
    expect(card.balanceCents).toBe(0);
  });
});

function bankBalance(state: InMemoryState): number {
  return state.accounts.find((account) => account.kind === 'bank')!.balanceCents;
}
