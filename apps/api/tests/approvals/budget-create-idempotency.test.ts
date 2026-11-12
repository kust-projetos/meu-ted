import { describe, expect, it } from 'vitest';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryBudgetStore } from '../../src/budgets/in-memory.js';

describe('budget create idempotency', () => {
  it('replays the same key, separates keys and rejects divergent amount', async () => {
    const { state, writes } = createInMemoryStores();
    const category = await writes.createCategory('ws', { name: 'Food', kind: 'expense' });
    const store = createInMemoryBudgetStore(state);
    const input = { categoryId: category.id, name: 'Food', amountCents: 50000, period: 'monthly' as const, startDate: '2026-11-01' };
    const first = await store.createBudget('ws', input, { idempotencyKey: 'same' });
    const replay = await Promise.all([store.createBudget('ws', input, { idempotencyKey: 'same' }), store.createBudget('ws', input, { idempotencyKey: 'same' })]);
    expect(replay.map((budget) => budget.id)).toEqual([first.id, first.id]);
    expect((await store.listBudgets('ws'))).toHaveLength(1);
    await store.createBudget('ws', input, { idempotencyKey: 'different' });
    expect(await store.listBudgets('ws')).toHaveLength(2);
    await expect(store.createBudget('ws', { ...input, amountCents: 60000 }, { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'validation.invalid' });
    for (const changed of [{ name: 'Other' }, { startDate: '2026-12-01' }, { alertThreshold: 90 }]) {
      await expect(store.createBudget('ws', { ...input, ...changed }, { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'validation.invalid' });
    }
    const otherCategory = await writes.createCategory('other-household', { name: 'Other food', kind: 'expense' });
    const other = await store.createBudget('other-household', { ...input, categoryId: otherCategory.id }, { idempotencyKey: 'same' });
    expect(other.id).not.toBe(first.id);
    await expect(store.createBudget('ws', { ...input, categoryId: '00000000-0000-4000-8000-000000000099' }, { idempotencyKey: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.listBudgets('ws')).toHaveLength(2);
  });
});
