import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

const HH = 'workspace-rename';

describe('keyed category rename (in-memory)', () => {
  it('renames with expectedName and replays the original snapshot', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'Antigo', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);

    const first = await writes.updateCategory(HH, cat.id, { name: 'Novo' }, { idempotencyKey: 'k1', expectedName: 'Antigo' });
    expect(first.name).toBe('Novo');

    // replay same key+payload returns original snapshot
    const replay = await writes.updateCategory(HH, cat.id, { name: 'Novo' }, { idempotencyKey: 'k1', expectedName: 'Antigo' });
    expect(replay.name).toBe('Novo');
    expect(replay.id).toBe(cat.id);

    // expectedName stale -> typed conflict
    await expect(
      writes.updateCategory(HH, cat.id, { name: 'Outro' }, { idempotencyKey: 'k2', expectedName: 'Antigo' }),
    ).rejects.toMatchObject({ code: 'category.name_conflict' });
  });

  it('no-op when name already matches', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'Mesmo', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);
    const out = await writes.updateCategory(HH, cat.id, { name: 'Mesmo' }, { idempotencyKey: 'k3', expectedName: 'Mesmo' });
    expect(out.name).toBe('Mesmo');
  });

  it('snapshot is cloned synchronously (later mutation does not contaminate replay)', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);

    const first = await writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k4', expectedName: 'A' });
    expect(first.name).toBe('B');

    // mutate the live stored category afterwards
    const live = state.categories.find((c) => c.id === cat.id)!;
    live.name = 'Z';

    const replay = await writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k4', expectedName: 'A' });
    expect(replay.name).toBe('B');
  });

  it('different payload with same key conflicts', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);
    await writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k5', expectedName: 'A' });
    await expect(
      writes.updateCategory(HH, cat.id, { name: 'C' }, { idempotencyKey: 'k5', expectedName: 'A' }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('strict: keyed path rejects extra fields before effect', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);
    await expect(
      writes.updateCategory(HH, cat.id, { name: 'B', icon: 'X' } as any, { idempotencyKey: 'k6', expectedName: 'A' }),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
    // no effect
    expect(state.categories[0].name).toBe('A');
  });

  it('unkeyed broad patch still supports icon/isDefault', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const, icon: null, isDefault: false };
    state.categories.push(cat);
    const out = await writes.updateCategory(HH, cat.id, { icon: 'Home', isDefault: true });
    expect(out.icon).toBe('Home');
    expect(out.isDefault).toBe(true);
  });

  it('name conflict within same workspace/kind/parent', async () => {
    const { state, writes } = createInMemoryStores();
    const c1 = { id: randomUUID(), householdId: HH, name: 'Dup', kind: 'expense' as const, status: 'active' as const };
    const c2 = { id: randomUUID(), householdId: HH, name: 'Orig', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(c1, c2);
    await expect(
      writes.updateCategory(HH, c2.id, { name: 'Dup' }, { idempotencyKey: 'k7', expectedName: 'Orig' }),
    ).rejects.toMatchObject({ code: 'in_use' });
  });

  it('concurrent same key converges to one result', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);
    const p1 = writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k8', expectedName: 'A' });
    const p2 = writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k8', expectedName: 'A' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.name).toBe('B');
    expect(r2.name).toBe('B');
  });

  it('two promises constructed before await: A->B then B->C, replays stay B/C', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);
    const first = writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'key-a', expectedName: 'A' });
    const second = writes.updateCategory(HH, cat.id, { name: 'C' }, { idempotencyKey: 'key-b', expectedName: 'B' });
    const [a, b] = await Promise.all([first, second]);
    expect(a.name).toBe('B');
    expect(b.name).toBe('C');
    const replayA = await writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'key-a', expectedName: 'A' });
    const replayB = await writes.updateCategory(HH, cat.id, { name: 'C' }, { idempotencyKey: 'key-b', expectedName: 'B' });
    expect(replayA.name).toBe('B');
    expect(replayB.name).toBe('C');
  });

  it('replays remain immutable after sequential renames', async () => {
    const { state, writes } = createInMemoryStores();
    const cat = { id: randomUUID(), householdId: HH, name: 'A', kind: 'expense' as const, status: 'active' as const };
    state.categories.push(cat);
    await writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k9', expectedName: 'A' });
    await writes.updateCategory(HH, cat.id, { name: 'C' }, { idempotencyKey: 'k10', expectedName: 'B' });
    const replayB = await writes.updateCategory(HH, cat.id, { name: 'B' }, { idempotencyKey: 'k9', expectedName: 'A' });
    const replayC = await writes.updateCategory(HH, cat.id, { name: 'C' }, { idempotencyKey: 'k10', expectedName: 'B' });
    expect(replayB.name).toBe('B');
    expect(replayC.name).toBe('C');
  });
});