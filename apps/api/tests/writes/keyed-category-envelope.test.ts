/**
 * RED (reviewer3 item 1): o snapshot `{ category }` replayado pela chave V2
 * deve validar TODOS os campos opcionais do contrato — malformado nunca
 * replaya (fail-closed `idempotency.conflict`), válido replaya íntegro.
 *
 * Contrato (domain.ts): parentId?: UUID, icon?: string | null,
 * color?: string | null, sortOrder?: number (inteiro), isDefault?: boolean,
 * isSystem?: boolean. Hoje só id/householdId/name/kind/status são
 * validados — envelope com sortOrder:'3', parentId:null etc. replaya.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { runKeyedCategoryMutation } from '../../src/writes/pending-idempotency.js';
import { hashPayloadV2 } from '../../src/writes/idempotency.js';

const H = 'workspace-1';

const baseCategory = () => ({
  id: randomUUID(),
  householdId: H,
  name: 'Mercado',
  kind: 'expense',
  status: 'active',
});

const fullCategory = () => ({
  ...baseCategory(),
  parentId: randomUUID(),
  icon: 'ShoppingCart',
  color: '#AABBCC',
  sortOrder: 3,
  isDefault: true,
  isSystem: false,
});

/** Fake mínimo de Pool: withTransaction usa connect(); o runner usa
 *  client.query (SELECT do registro) e pool.query (só no lost-race). */
const fakePoolForRow = (row: { payload_hash: string; response: unknown } | undefined) => {
  const client = {
    query: async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (typeof text === 'string' && text.startsWith('SELECT payload_hash')) {
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`efeito inesperado no replay (deveria ler o registro): ${text}`);
    },
    release: () => undefined,
  };
  return {
    connect: async () => client,
    query: async () => {
      throw new Error('pool.query fora do caminho de replay');
    },
  } as unknown as Pool;
};

const replay = (payload: unknown, response: unknown) =>
  runKeyedCategoryMutation({
    pool: fakePoolForRow({ payload_hash: hashPayloadV2(payload), response: JSON.stringify(response) }),
    householdId: H,
    idempotencyKey: 'k-envelope',
    payload,
    mutate: async () => {
      throw new Error('mutate não deve executar no replay');
    },
  });

const payload = { name: 'Mercado', kind: 'expense' };

describe('snapshot { category } válido replaya íntegro (success)', () => {
  it('envelope mínimo replaya o mesmo id', async () => {
    const cat = baseCategory();
    const out = await replay(payload, { category: cat });
    expect(out).toEqual(cat);
  });

  it('envelope com TODOS os opcionais replaya com os mesmos valores', async () => {
    const cat = fullCategory();
    const out = await replay(payload, { category: cat });
    expect(out).toEqual(cat);
    expect(out.parentId).toBe(cat.parentId);
    expect(out.icon).toBe('ShoppingCart');
    expect(out.color).toBe('#AABBCC');
    expect(out.sortOrder).toBe(3);
    expect(out.isDefault).toBe(true);
    expect(out.isSystem).toBe(false);
  });

  it('icon/color null replayam como null', async () => {
    const cat = { ...baseCategory(), icon: null, color: null };
    const out = await replay(payload, { category: cat });
    expect(out.icon).toBeNull();
    expect(out.color).toBeNull();
  });
});

describe('snapshot { category } malformado nunca replaya (rejects, sem success)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['parentId numérico', { parentId: 123 }],
    ['parentId null', { parentId: null }],
    ['parentId não-UUID', { parentId: 'not-a-uuid' }],
    ['parentId vazio', { parentId: '' }],
    ['icon numérico', { icon: 42 }],
    ['icon objeto', { icon: {} }],
    ['color numérica', { color: 123456 }],
    ['color objeto', { color: {} }],
    ['sortOrder string', { sortOrder: '3' }],
    ['sortOrder fracionário', { sortOrder: 3.5 }],
    ['sortOrder NaN', { sortOrder: Number.NaN }],
    ['sortOrder null', { sortOrder: null }],
    ['isDefault string', { isDefault: 'yes' }],
    ['isDefault numérico', { isDefault: 1 }],
    ['isSystem string', { isSystem: 'no' }],
    ['isSystem numérico', { isSystem: 1 }],
    ['id ausente', { id: undefined }],
    ['id não-UUID', { id: 'abc' }],
    ['household divergente', { householdId: 'other-workspace' }],
    ['nome vazio', { name: '   ' }],
    ['kind fora do vocabulário', { kind: 'bank' }],
    ['status fora do vocabulário', { status: 'deleted' }],
  ];
  for (const [label, patch] of cases) {
    it(`${label} → idempotency.conflict`, async () => {
      const cat = { ...baseCategory(), ...patch };
      await expect(replay(payload, { category: cat })).rejects.toMatchObject({
        code: 'idempotency.conflict',
      });
    });
  }

  it('response com JSON inválido → idempotency.conflict', async () => {
    const pool = fakePoolForRow({ payload_hash: hashPayloadV2(payload), response: '{oops' });
    await expect(
      runKeyedCategoryMutation({
        pool,
        householdId: H,
        idempotencyKey: 'k-envelope',
        payload,
        mutate: async () => {
          throw new Error('mutate não deve executar no replay');
        },
      }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('envelope sem `category` (outro tipo de entidade) → idempotency.conflict', async () => {
    await expect(replay(payload, { account: baseCategory() })).rejects.toMatchObject({
      code: 'idempotency.conflict',
    });
  });

  it('envelope com category null → idempotency.conflict', async () => {
    await expect(replay(payload, { category: null })).rejects.toMatchObject({
      code: 'idempotency.conflict',
    });
  });

  it('response JSON null → idempotency.conflict', async () => {
    const pool = fakePoolForRow({ payload_hash: hashPayloadV2(payload), response: JSON.stringify(null) });
    await expect(
      runKeyedCategoryMutation({
        pool,
        householdId: H,
        idempotencyKey: 'k-envelope',
        payload,
        mutate: async () => {
          throw new Error('mutate não deve executar no replay');
        },
      }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });
});
