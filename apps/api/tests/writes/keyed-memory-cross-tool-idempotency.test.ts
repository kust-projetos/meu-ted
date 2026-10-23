import { describe, expect, it } from 'vitest';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

const H = '00000000-0000-4000-8000-00000000d0b1';
const OTHER_H = '00000000-0000-4000-8000-00000000d0b2';
const KEY = 'cross-tool-same-key';

describe('in-memory pending-v2 idempotency namespace', () => {
  it('conflicts across account/category writers before the second effect', async () => {
    const { state, writes } = createInMemoryStores();
    const account = await writes.createAccount(H, { name: 'Main', kind: 'bank' }, { idempotencyKey: KEY });
    const categoriesBefore = state.categories.filter((row) => row.householdId === H).length;
    await expect(writes.createCategory(H, { name: 'Food', kind: 'expense' }, { idempotencyKey: KEY }))
      .rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(state.accounts.map((row) => row.id)).toContain(account.id);
    expect(state.categories.filter((row) => row.householdId === H)).toHaveLength(categoriesBefore);
  });

  it('reserves one owner across concurrent entity types and scopes keys by household', async () => {
    const { state, writes } = createInMemoryStores();
    const first = writes.createAccount(H, { name: 'Main', kind: 'bank' }, { idempotencyKey: KEY });
    const crossType = writes.createCategory(H, { name: 'Food', kind: 'expense' }, { idempotencyKey: KEY });
    const results = await Promise.allSettled([first, crossType]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const other = await writes.createCategory(OTHER_H, { name: 'Food', kind: 'expense' }, { idempotencyKey: KEY });
    expect(other.householdId).toBe(OTHER_H);
    expect(state.categories.filter((row) => row.householdId === OTHER_H)).toHaveLength(1);
  });

  it('conflicts between transaction and account keys without a second effect', async () => {
    const { state, writes } = createInMemoryStores();
    const account = await writes.createAccount(H, { name: 'Ledger', kind: 'bank' });
    const category = state.categories.find((row) => row.householdId === H && row.kind === 'expense' && !row.parentId)!;
    const tx = await writes.createExpense(H, {
      description: 'Groceries', amountCents: 250, date: '2026-10-23', accountId: account.id, categoryId: category.id,
    }, { idempotencyKey: KEY, audit: { operation: 'transactions.expense.create', actorId: 'actor-1' } });
    const balance = account.balanceCents;
    await expect(writes.createAccount(H, { name: 'Other', kind: 'bank' }, { idempotencyKey: KEY }))
      .rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(state.transactions.map((row) => row.id)).toContain(tx.id);
    expect(account.balanceCents).toBe(balance);
    expect(state.accounts.filter((row) => row.name === 'Other')).toHaveLength(0);
  });

  it('replays the original immutable account/category/transaction snapshots after mutable state changes', async () => {
    const { writes } = createInMemoryStores();
    const accountKey = `${KEY}-account`;
    const originalAccount = await writes.createAccount(H, { name: 'Snapshot account', kind: 'bank' }, { idempotencyKey: accountKey });
    await writes.updateAccount(H, originalAccount.id, { name: 'Renamed account' });
    const replayedAccount = await writes.createAccount(H, { name: 'Snapshot account', kind: 'bank' }, { idempotencyKey: accountKey });
    expect(replayedAccount).toEqual(originalAccount);
    expect(replayedAccount.name).toBe('Snapshot account');

    const categoryKey = `${KEY}-category`;
    const originalCategory = await writes.createCategory(H, { name: 'Snapshot category', kind: 'expense' }, { idempotencyKey: categoryKey });
    await writes.updateCategory(H, originalCategory.id, { name: 'Renamed category' });
    const replayedCategory = await writes.createCategory(H, { name: 'Snapshot category', kind: 'expense' }, { idempotencyKey: categoryKey });
    expect(replayedCategory).toEqual(originalCategory);
    expect(replayedCategory.name).toBe('Snapshot category');

    const txInput = {
      description: 'Original description', amountCents: 125, date: '2026-10-23', accountId: originalAccount.id, categoryId: originalCategory.id,
    };
    const originalTransaction = await writes.createExpense(H, txInput, { idempotencyKey: `${KEY}-transaction` });
    await writes.updateTransaction(H, originalTransaction.id, { description: 'Changed description' });
    const replayedTransaction = await writes.createExpense(H, txInput, { idempotencyKey: `${KEY}-transaction` });
    expect(replayedTransaction).toEqual(originalTransaction);
    expect(replayedTransaction.description).toBe('Original description');
  });

  it('coalesces same-type concurrent calls to one immutable result/effect', async () => {
    const { state, writes } = createInMemoryStores();
    const input = { name: 'Concurrent account', kind: 'bank' as const };
    const [first, second] = await Promise.all([
      writes.createAccount(H, input, { idempotencyKey: KEY }),
      writes.createAccount(H, input, { idempotencyKey: KEY }),
    ]);
    expect(first).toEqual(second);
    expect(state.accounts.filter((row) => row.householdId === H && row.name === input.name)).toHaveLength(1);
  });

  it('allows a failed producer to release its reservation for a valid retry', async () => {
    const { state, writes } = createInMemoryStores();
    await writes.createAccount(H, { name: 'Already exists', kind: 'bank' });
    await expect(writes.createAccount(H, { name: 'Already exists', kind: 'bank' }, { idempotencyKey: KEY })).rejects.toBeDefined();
    const category = await writes.createCategory(H, { name: 'Food', kind: 'expense' }, { idempotencyKey: KEY });
    expect(category.name).toBe('Food');
    expect(state.categories.filter((row) => row.householdId === H && row.name === 'Food')).toHaveLength(1);
  });
});
