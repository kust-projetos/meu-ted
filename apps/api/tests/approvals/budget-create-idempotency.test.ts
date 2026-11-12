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
    const replay = await store.createBudget('ws', input, { idempotencyKey: 'same' });
    expect(replay.id).toBe(first.id);
    expect((await store.listBudgets('ws'))).toHaveLength(1);
    await store.createBudget('ws', input, { idempotencyKey: 'different' });
    expect(await store.listBudgets('ws')).toHaveLength(2);
    await expect(store.createBudget('ws', { ...input, amountCents: 60000 }, { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'validation.invalid' });
  });
});
