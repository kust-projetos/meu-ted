import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

const H = 'category-deactivate';
const opts = (idempotencyKey: string, expectedName: string) => ({ idempotencyKey, expectedName });

describe('keyed category deactivation', () => {
  it('deactivates unused category and replays immutable inactive snapshot before current-state checks', async () => {
    const { state, writes } = createInMemoryStores();
    const category = { id: randomUUID(), householdId: H, name: 'Casa', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(category);
    const result = await writes.deactivateCategory(H, category.id, opts('deactivate-1', 'Casa'));
    expect(result).toMatchObject({ id: category.id, name: 'Casa', status: 'inactive' });
    category.name = 'Renomeada';
    category.status = 'active';
    state.categories.push({ id: randomUUID(), householdId: H, name: 'sub', kind: 'expense', status: 'inactive', parentId: category.id });
    await expect(writes.deactivateCategory(H, category.id, opts('deactivate-1', 'Casa'))).resolves.toMatchObject({ name: 'Casa', status: 'inactive' });
    expect(category.status).toBe('active');
  });

  it('checks expectedName and same-key payload conflicts without mutating', async () => {
    const { state, writes } = createInMemoryStores();
    const category = { id: randomUUID(), householdId: H, name: 'Casa', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(category);
    await expect(writes.deactivateCategory(H, category.id, opts('deactivate-2', 'Stale'))).rejects.toMatchObject({ code: 'category.name_conflict' });
    await writes.deactivateCategory(H, category.id, opts('deactivate-2', 'Casa'));
    await expect(writes.deactivateCategory(H, category.id, opts('deactivate-2', 'Other'))).rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(category.status).toBe('inactive');
  });

  it('requires expectedName for keyed calls and blocks persisted references', async () => {
    const { state, writes } = createInMemoryStores();
    const category = { id: randomUUID(), householdId: H, name: 'Casa', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(category);
    await expect(writes.deactivateCategory(H, category.id, { idempotencyKey: 'missing' })).rejects.toMatchObject({ code: 'validation.invalid' });
    state.transactions.push({ id: randomUUID(), householdId: H, kind: 'expense', description: 'ref', amountCents: 1, date: '2026-01-01', categoryId: category.id } as never);
    await expect(writes.deactivateCategory(H, category.id, opts('referenced', 'Casa'))).rejects.toMatchObject({ code: 'in_use' });
    expect(category.status).toBe('active');
  });

  it('concurrent duplicate calls return one category snapshot', async () => {
    const { state, writes } = createInMemoryStores();
    const category = { id: randomUUID(), householdId: H, name: 'Casa', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(category);
    const [a, b] = await Promise.all([
      writes.deactivateCategory(H, category.id, opts('deactivate-race', 'Casa')),
      writes.deactivateCategory(H, category.id, opts('deactivate-race', 'Casa')),
    ]);
    expect(a).toMatchObject({ id: category.id, status: 'inactive' });
    expect(b).toEqual(a);
    expect(category.status).toBe('inactive');
  });
});
