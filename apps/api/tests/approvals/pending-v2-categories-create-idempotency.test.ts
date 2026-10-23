/**
 * RED (categories-create-api): createCategory keyed replay seguro.
 *
 * WriteStore.createCategory ainda não aceita chave V2 — replay mesma
 * chave + mesmo payload deve retornar MESMO id sem duplicar; payload
 * divergente → idempotency.conflict; workspace isola; nome duplicado
 * com chave distinta → in_use; concorrência PG serializa.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

const H = 'workspace-1';
const OTHER = 'workspace-2';

const catArgs = (name = 'Mercado') => ({
  name,
  kind: 'expense' as const,
});

describe('RED: categories.create keyed replay', () => {
  it('replay mesma chave + mesmos args retorna a mesma categoria, exatamente uma', async () => {
    const { state, writes } = createInMemoryStores();
    const args = catArgs();
    const first = await writes.createCategory(H, args, { idempotencyKey: 'op-key-cat' });
    const second = await writes.createCategory(H, args, { idempotencyKey: 'op-key-cat' });
    expect(second.id).toBe(first.id);
    expect(state.categories.filter((c) => c.householdId === H)).toHaveLength(1);
  });

  it('mesma chave com payload divergente rejeita com idempotency.conflict', async () => {
    const { writes } = createInMemoryStores();
    await writes.createCategory(H, catArgs('Conta A'), { idempotencyKey: 'op-key-cat-conflict' });
    await expect(
      writes.createCategory(H, catArgs('Conta B'), { idempotencyKey: 'op-key-cat-conflict' }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('mesma chave em workspace distinto não conflita', async () => {
    const { state, writes } = createInMemoryStores();
    const first = await writes.createCategory(H, catArgs(), { idempotencyKey: 'op-key-shared' });
    const second = await writes.createCategory(OTHER, catArgs(), { idempotencyKey: 'op-key-shared' });
    expect(second.id).not.toBe(first.id);
    expect(state.categories).toHaveLength(2);
  });

  it('guard de duplicado preservado: chaves distintas com mesmo nome seguem 409 in_use', async () => {
    const { writes } = createInMemoryStores();
    await writes.createCategory(H, catArgs('Dup'), { idempotencyKey: randomUUID() });
    await expect(
      writes.createCategory(H, catArgs('dup'), { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'in_use' });
  });

  it('parent de outro workspace rejeita sem vazar (not_found)', async () => {
    const { writes } = createInMemoryStores();
    const parent = await writes.createCategory(H, catArgs('Pai'), {});
    await expect(
      writes.createCategory(OTHER, { name: 'Filha', kind: 'expense', parentId: parent.id }, { idempotencyKey: 'k-xws' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('parent de kind divergente rejeita (invalid)', async () => {
    const { writes } = createInMemoryStores();
    const parent = await writes.createCategory(H, { name: 'Pai', kind: 'income' }, {});
    await expect(
      writes.createCategory(H, { name: 'Filha', kind: 'expense', parentId: parent.id }, { idempotencyKey: 'k-kind' }),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
  });
});

describe('round2 achado 3: snapshot do resultado keyed em memória', () => {
  const input = () => ({ name: 'Orig', kind: 'expense' as const });

  it('replay após updateCategory retorna o snapshot original com o ID original', async () => {
    const { writes } = createInMemoryStores();
    const first = await writes.createCategory(H, input(), { idempotencyKey: 'k-snap' });
    expect(first.name).toBe('Orig');
    await writes.updateCategory(H, first.id, { name: 'Edited' });
    const replayed = await writes.createCategory(H, input(), { idempotencyKey: 'k-snap' });
    expect(replayed.id).toBe(first.id);
    expect(replayed.name).toBe('Orig');
  });

  it('mutar o objeto retornado não corrompe o snapshot persistido', async () => {
    const { writes } = createInMemoryStores();
    await writes.createCategory(H, input(), { idempotencyKey: 'k-snap2' });
    const r1 = await writes.createCategory(H, input(), { idempotencyKey: 'k-snap2' });
    r1.name = 'Corrupted';
    const r2 = await writes.createCategory(H, input(), { idempotencyKey: 'k-snap2' });
    expect(r2.name).toBe('Orig');
  });

  it('replay com todos os opcionais preserva parentId/icon/color/sortOrder/isDefault', async () => {
    const { writes } = createInMemoryStores();
    const parent = await writes.createCategory(H, { name: 'Pai', kind: 'expense' });
    const args = {
      name: 'Filha',
      kind: 'expense' as const,
      parentId: parent.id,
      icon: 'ShoppingCart',
      color: '#AABBCC',
      sortOrder: 3,
      isDefault: true,
    };
    const first = await writes.createCategory(H, args, { idempotencyKey: 'k-full' });
    const replayed = await writes.createCategory(H, args, { idempotencyKey: 'k-full' });
    expect(replayed).toEqual(first);
    expect(replayed.parentId).toBe(parent.id);
  });
});
