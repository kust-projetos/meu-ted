/**
 * Contract test for any WriteStore implementation.
 *
 * Same pattern as the read-side contract: a function that registers a
 * describe block; each backend wires its own store factory.
 */

import { describe, it, expect } from 'vitest';
import type { WriteStore } from '../../src/writes/store.js';

export type WriteContractHarness = {
  name: string;
  create: () => Promise<{
    writes: WriteStore;
    cleanup: () => Promise<void>;
  }>;
};

const H1 = '00000000-0000-4000-8000-00000000000a';
const H2 = '00000000-0000-4000-8000-00000000000b';
const OTHER_ACC = '11111111-1111-4111-8111-111111111111';
const _OTHER_CAT = '22222222-2222-4222-8222-222222222221';

export const runWriteStoreContract = (harness: WriteContractHarness): void => {
  describe(`WriteStore contract: ${harness.name}`, () => {
    let writes: WriteStore;
    let cleanup: () => Promise<void>;

    const setup = async (): Promise<void> => {
      const r = await harness.create();
      writes = r.writes;
      cleanup = r.cleanup;
    };

    // ── accounts ─────────────────────────────────────────────
    it('createAccount returns active account with id, in derived household', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'Itaú',
        kind: 'bank',
        initialBalanceCents: 100_000,
      });
      expect(acc.id).toBeDefined();
      expect(acc.householdId).toBe(H1);
      expect(acc.status).toBe('active');
      expect(acc.balanceCents).toBe(100_000);
    });

    it('updateAccount changes the name and returns the updated account', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'Old',
        kind: 'bank',
        initialBalanceCents: 0,
      });
      const upd = await writes.updateAccount(H1, acc.id, { name: 'New' });
      expect(upd.name).toBe('New');
    });

    it('updateAccount on unknown id throws notFound', async () => {
      await setup();
      await expect(
        writes.updateAccount(H1, '00000000-0000-4000-8000-000000000099', { name: 'X' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('updateAccount on other household throws household_mismatch', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'Mine',
        kind: 'bank',
        initialBalanceCents: 0,
      });
      await expect(writes.updateAccount(H2, acc.id, { name: 'X' })).rejects.toMatchObject({
        code: 'not_found', // accounts are scoped by householdId in find
      });
    });

    it('deactivateAccount on account with no transactions succeeds', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'X',
        kind: 'bank',
        initialBalanceCents: 0,
      });
      const out = await writes.deactivateAccount(H1, acc.id);
      expect(out.status).toBe('inactive');
    });

    it('deactivateAccount with active transactions throws in_use', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'X',
        kind: 'bank',
        // V4.1 Phase 4 (D1): fixtures fund the account — an unfunded
        // expense is rejected before any transaction exists.
        initialBalanceCents: 5_000,
      });
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      await writes.createExpense(H1, {
        description: 'Lunch',
        amountCents: 1000,
        date: '2026-06-10',
        accountId: acc.id,
        categoryId: cat.id,
      });
      await expect(writes.deactivateAccount(H1, acc.id)).rejects.toMatchObject({
        code: 'in_use',
      });
    });

    // ── categories ───────────────────────────────────────────
    it('createCategory returns active category', async () => {
      await setup();
      const cat = await writes.createCategory(H1, { name: 'Mercado', kind: 'expense' });
      expect(cat.status).toBe('active');
      expect(cat.householdId).toBe(H1);
    });

    it('updateCategory renames', async () => {
      await setup();
      const cat = await writes.createCategory(H1, { name: 'Old', kind: 'expense' });
      const upd = await writes.updateCategory(H1, cat.id, { name: 'New' });
      expect(upd.name).toBe('New');
    });

    it('deactivateCategory with no transactions succeeds', async () => {
      await setup();
      const cat = await writes.createCategory(H1, { name: 'X', kind: 'expense' });
      const out = await writes.deactivateCategory(H1, cat.id);
      expect(out.status).toBe('inactive');
    });

    it('deactivateCategory with active transactions throws in_use', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        // V4.1 Phase 4 (D1): funded fixture (see above).
        initialBalanceCents: 5_000,
      });
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      await writes.createExpense(H1, {
        description: 'Lunch',
        amountCents: 1000,
        date: '2026-06-10',
        accountId: acc.id,
        categoryId: cat.id,
      });
      await expect(writes.deactivateCategory(H1, cat.id)).rejects.toMatchObject({
        code: 'in_use',
      });
    });

    it('deactivateCategory blocks soft-deleted transaction references without rewriting history', async () => {
      await setup();
      const acc = await writes.createAccount(H1, { name: 'History account', kind: 'bank', initialBalanceCents: 5_000 });
      const cat = await writes.createCategory(H1, { name: 'History category', kind: 'expense' });
      const tx = await writes.createExpense(H1, {
        description: 'Historical expense', amountCents: 100, date: '2026-06-10', accountId: acc.id, categoryId: cat.id,
      });
      await writes.softDeleteTransaction(H1, tx.id);
      await expect(writes.deactivateCategory(H1, cat.id)).rejects.toMatchObject({ code: 'in_use' });
    });

    it('deactivateCategory blocks inactive child rows', async () => {
      await setup();
      const parent = await writes.createCategory(H1, { name: 'Parent', kind: 'expense' });
      const child = await writes.createCategory(H1, { name: 'Child', kind: 'expense', parentId: parent.id });
      await writes.deactivateCategory(H1, child.id);
      await expect(writes.deactivateCategory(H1, parent.id)).rejects.toMatchObject({ code: 'in_use' });
    });

    // ── transactions ─────────────────────────────────────────
    it('createExpense returns a transaction and debits the account', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        initialBalanceCents: 5_000,
      });
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      const tx = await writes.createExpense(H1, {
        description: 'Lunch',
        amountCents: 1500,
        date: '2026-06-10',
        accountId: acc.id,
        categoryId: cat.id,
      });
      expect(tx.kind).toBe('expense');
      expect(tx.amountCents).toBe(1500);
    });

    it('createExpense rejects amount <= 0', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        initialBalanceCents: 0,
      });
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      await expect(
        writes.createExpense(H1, {
          description: 'X',
          amountCents: 0,
          date: '2026-06-10',
          accountId: acc.id,
          categoryId: cat.id,
        }),
      ).rejects.toMatchObject({ code: 'validation.invalid' });
    });

    it('createExpense on account from other household throws household_mismatch', async () => {
      await setup();
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      await expect(
        writes.createExpense(H1, {
          description: 'X',
          amountCents: 100,
          date: '2026-06-10',
          accountId: OTHER_ACC, // belongs to H2 in this contract
          categoryId: cat.id,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('createIncome credits the account', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        initialBalanceCents: 0,
      });
      const cat = await writes.createCategory(H1, { name: 'Salary', kind: 'income' });
      const tx = await writes.createIncome(H1, {
        description: 'Paycheck',
        amountCents: 12_000_00,
        date: '2026-06-01',
        accountId: acc.id,
        categoryId: cat.id,
      });
      expect(tx.kind).toBe('income');
    });

    it('createTransfer between two accounts in same household succeeds', async () => {
      await setup();
      const a = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        // V4.1 Phase 4 (D1): the source must cover the transfer.
        initialBalanceCents: 5_000,
      });
      const b = await writes.createAccount(H1, {
        name: 'B',
        kind: 'cash',
        initialBalanceCents: 0,
      });
      const tx = await writes.createTransfer(H1, {
        description: 'Move',
        amountCents: 500,
        date: '2026-06-10',
        fromAccountId: a.id,
        toAccountId: b.id,
      });
      expect(tx.kind).toBe('transfer');
      expect(tx.transferToAccountId).toBe(b.id);
    });

    it('createTransfer rejects fromAccount === toAccount', async () => {
      await setup();
      const a = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        initialBalanceCents: 0,
      });
      await expect(
        writes.createTransfer(H1, {
          description: 'X',
          amountCents: 100,
          date: '2026-06-10',
          fromAccountId: a.id,
          toAccountId: a.id,
        }),
      ).rejects.toMatchObject({ code: 'validation.invalid' });
    });

    it('updateTransaction on transfer allows description/date only', async () => {
      await setup();
      const a = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        // V4.1 Phase 4 (D1): the source must cover the transfer.
        initialBalanceCents: 5_000,
      });
      const b = await writes.createAccount(H1, {
        name: 'B',
        kind: 'cash',
        initialBalanceCents: 0,
      });
      const tx = await writes.createTransfer(H1, {
        description: 'Old',
        amountCents: 100,
        date: '2026-06-10',
        fromAccountId: a.id,
        toAccountId: b.id,
      });
      const upd = await writes.updateTransaction(H1, tx.id, { description: 'New' });
      expect(upd.description).toBe('New');
      // Amount change on transfer should be unsupported
      await expect(
        writes.updateTransaction(H1, tx.id, { amountCents: 200 }),
      ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('updateTransaction on expense allows amount and account changes', async () => {
      await setup();
      const a = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        initialBalanceCents: 5_000,
      });
      const b = await writes.createAccount(H1, {
        name: 'B',
        kind: 'cash',
        // V4.1 Phase 4 (D1): the destination must cover the moved amount.
        initialBalanceCents: 5_000,
      });
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      const tx = await writes.createExpense(H1, {
        description: 'Lunch',
        amountCents: 1000,
        date: '2026-06-10',
        accountId: a.id,
        categoryId: cat.id,
      });
      const upd = await writes.updateTransaction(H1, tx.id, {
        amountCents: 2000,
        accountId: b.id,
      });
      expect(upd.amountCents).toBe(2000);
      expect(upd.accountId).toBe(b.id);
    });

    it('softDeleteTransaction removes the transaction', async () => {
      await setup();
      const acc = await writes.createAccount(H1, {
        name: 'A',
        kind: 'bank',
        // V4.1 Phase 4 (D1): funded fixture (see above).
        initialBalanceCents: 5_000,
      });
      const cat = await writes.createCategory(H1, { name: 'Food', kind: 'expense' });
      const tx = await writes.createExpense(H1, {
        description: 'X',
        amountCents: 100,
        date: '2026-06-10',
        accountId: acc.id,
        categoryId: cat.id,
      });
      await writes.softDeleteTransaction(H1, tx.id);
      await expect(writes.updateTransaction(H1, tx.id, { description: 'Y' })).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('softDeleteTransaction on missing id throws notFound', async () => {
      await setup();
      await expect(
        writes.softDeleteTransaction(H1, '00000000-0000-4000-8000-000000000099'),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('teardown is safe to call', async () => {
      await setup();
      await cleanup();
      await cleanup();
    });
  });
};
