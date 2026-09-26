/**
 * TASK card-atomic-three (TDD):
 * `runCardMutation` covers card create/update + purchase update with the
 * same single-transaction contract as the other card ops:
 * - claimTx is an open Postgres claim client AND the store exposes the
 *   required `*InTx` extension → the effect runs on that client;
 * - claimTx undefined → the plain `CardStore` method keeps its own
 *   boundary (behavior unchanged);
 * - claimTx present but the extension is missing → fail-closed
 *   `idempotency.atomic_mutation_not_supported`, never a plain fallback.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCardMutation } from '../../src/cards/keyed-mutations.js';

const fakeTx = { query: async () => ({ rows: [], rowCount: 0 }) };
const HH = '00000000-0000-4000-8000-0000000000a1';

describe('runCardMutation card-atomic-three dispatch', () => {
  it('routes createCard/updateCard/updatePurchase onto the claim client when InTx exists', async () => {
    const card = { id: 'card1' };
    const detail = { id: 'stmt1', purchases: [{ id: 'tx1', description: 'Feira' }] };
    const store = {
      createCard: vi.fn(async () => { throw new Error('plain must not run'); }),
      createCardInTx: vi.fn(async () => card),
      updateCard: vi.fn(async () => { throw new Error('plain must not run'); }),
      updateCardInTx: vi.fn(async () => card),
      updatePurchase: vi.fn(async () => { throw new Error('plain must not run'); }),
      updatePurchaseInTx: vi.fn(async () => detail),
    };
    const create = { name: 'Visa', creditLimitCents: 100_000, closingDay: 10, dueDay: 20 };
    await expect(runCardMutation(store as never, fakeTx, HH, 'createCard', create as never)).resolves.toBe(card);
    expect(store.createCardInTx).toHaveBeenCalledWith(fakeTx, HH, create);
    await expect(
      runCardMutation(store as never, fakeTx, HH, 'updateCard', { id: 'card1', patch: { name: 'X' } }),
    ).resolves.toBe(card);
    expect(store.updateCardInTx).toHaveBeenCalledWith(fakeTx, HH, 'card1', { name: 'X' });
    await expect(
      runCardMutation(store as never, fakeTx, HH, 'updatePurchase', { purchaseId: 'tx1', patch: { description: 'Feira' } }),
    ).resolves.toBe(detail);
    expect(store.updatePurchaseInTx).toHaveBeenCalledWith(fakeTx, HH, 'tx1', { description: 'Feira' });
    for (const fn of [store.createCard, store.updateCard, store.updatePurchase]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('falls back to the plain methods only without a claim client', async () => {
    const card = { id: 'card1' };
    const detail = { id: 'stmt1', purchases: [] };
    const plain = {
      createCard: vi.fn(async () => card),
      updateCard: vi.fn(async () => card),
      updatePurchase: vi.fn(async () => detail),
    };
    const create = { name: 'Visa', creditLimitCents: 100_000, closingDay: 10, dueDay: 20 };
    await expect(runCardMutation(plain as never, undefined, HH, 'createCard', create as never)).resolves.toBe(card);
    expect(plain.createCard).toHaveBeenCalledWith(HH, create);
    await expect(
      runCardMutation(plain as never, undefined, HH, 'updateCard', { id: 'card1', patch: { name: 'X' } }),
    ).resolves.toBe(card);
    expect(plain.updateCard).toHaveBeenCalledWith(HH, 'card1', { name: 'X' });
    await expect(
      runCardMutation(plain as never, undefined, HH, 'updatePurchase', { purchaseId: 'tx1', patch: { description: 'F' } }),
    ).resolves.toBe(detail);
    expect(plain.updatePurchase).toHaveBeenCalledWith(HH, 'tx1', { description: 'F' });
  });

  it('fail-closed: Tx client but no InTx extension → invariant error, zero plain calls', async () => {
    const plain = {
      createCard: vi.fn(async () => ({ id: 'card1' })),
      updateCard: vi.fn(async () => ({ id: 'card1' })),
      updatePurchase: vi.fn(async () => ({ id: 'stmt1' })),
    };
    const create = { name: 'Visa', creditLimitCents: 100_000, closingDay: 10, dueDay: 20 };
    await expect(runCardMutation(plain as never, fakeTx, HH, 'createCard', create as never)).rejects.toMatchObject({
      code: 'idempotency.atomic_mutation_not_supported',
    });
    await expect(
      runCardMutation(plain as never, fakeTx, HH, 'updateCard', { id: 'card1', patch: { name: 'X' } }),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    await expect(
      runCardMutation(plain as never, fakeTx, HH, 'updatePurchase', { purchaseId: 'tx1', patch: { description: 'F' } }),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    for (const fn of Object.values(plain)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
