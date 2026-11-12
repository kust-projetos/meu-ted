import { describe, expect, it } from 'vitest';
import { createInMemoryGoalStore } from '../../src/goals/in-memory.js';

describe('in-memory goal contribution idempotency', () => {
  it('counts a key once and distinct keys separately', async () => {
    const state = {} as never;
    const store = createInMemoryGoalStore(state);
    const goal = await store.createGoal('workspace', {
      name: 'Trip', goalType: 'savings', targetAmountCents: 100_000, startDate: '2026-01-01',
    });
    const input = { amountCents: 500 };
    const first = await store.contributeToGoal('workspace', goal.id, input, { idempotencyKey: 'same' });
    const replay = await store.contributeToGoal('workspace', goal.id, input, { idempotencyKey: 'same' });
    const another = await store.contributeToGoal('workspace', goal.id, input, { idempotencyKey: 'other' });
    expect(replay.id).toBe(first.id);
    expect(another.id).not.toBe(first.id);
    expect((await store.listGoals('workspace'))[0]?.currentAmountCents).toBe(1000);
  });
});
