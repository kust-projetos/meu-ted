/**
 * categories.create keyed PG — prova real em banco descartável ISOLADO.
 *
 * HARNESS (higiene total, sem tocar QA/produção):
 * - Container próprio `ted-category-keyed-validation` (rede isolada
 *   `ted-category-keyed-net`, IP 172.23.0.2, porta publicada SÓ em
 *   127.0.0.1:55433 efêmera; imagem local postgres:15-alpine, sem pull).
 * - Gate duplo: (1) preflight puro desta suíte — protocolo postgresql,
 *   host loopback, porta EFÊMERA 49152–65535 (nunca 5432/5433 do QA),
 *   database EXATO `ted_category_keyed_validation` (companion EXATO
 *   `..._legacy`); (2) `requireTestDatabase` (marker pré-existente nas
 *   duas bases descartáveis + nomes de produção bloqueados).
 * - `SELECT current_database()` é afirmado dentro da suíte antes de
 *   qualquer mutação. QA (`ted-local-postgres`, `ted-local-qa-*`) nunca é
 *   conectado, reiniciado ou alterado; container/rede descartáveis são
 *   preservados (não deletados) ao final.
 *
 * Gate: TED_CATEGORY_PG_URL + TED_CATEGORY_PG_MARKER (marker aleatório
 * da sessão, só nas duas bases descartáveis, nunca commitado).
 *
 * Comandos (a partir de D:/projetos/pi-financeiro, PowerShell):
 *   $env:TED_CATEGORY_PG_URL='postgresql://postgres:<pass>@127.0.0.1:55433/ted_category_keyed_validation'
 *   $env:TED_CATEGORY_PG_MARKER='<marker das 2 bases>'
 *   pnpm --filter meu-ted-api exec vitest run tests/approvals/pending-v2-categories-create-idempotency-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore, createCategoryInTx } from '../../src/writes/postgres.js';
import {
  createLegacyPostgresWriteStore,
  createCategoryLegacyKeyedInTx,
} from '../../src/writes/legacy-postgres.js';
import { runKeyedCategoryMutation, PENDING_V2_IDEMPOTENCY_PREFIX } from '../../src/writes/pending-idempotency.js';
import { hashPayloadV2 } from '../../src/writes/idempotency.js';
import { domainErrors } from '../../src/writes/errors.js';
import type { WriteStore } from '../../src/writes/store.js';
import type { Category } from '../../src/types/domain.js';

const DISPOSABLE_DB = 'ted_category_keyed_validation';
const DISPOSABLE_LEGACY_DB = 'ted_category_keyed_validation_legacy';

const assertDisposableUrl = (raw: unknown): string => {
  const fail = (reason: string): never => {
    throw new Error(`[cat-keyed-pg] URL descartável recusada (${reason})`);
  };
  if (typeof raw !== 'string' || raw.trim() === '') return fail('ausente ou vazia');
  if (/[?#]/.test(raw)) return fail('query/hash na URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail('URL inválida');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return fail(`protocolo '${parsed.protocol}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') return fail(`host '${parsed.hostname}'`);
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 49152 || port > 65535) {
    return fail(`porta '${parsed.port || '(ausente)'}' (exigida efêmera 49152–65535, nunca 5432/5433)`);
  }
  if (parsed.pathname !== `/${DISPOSABLE_DB}`) return fail(`database '${parsed.pathname}'`);
  return raw;
};

const companionUrl = (raw: string): string => {
  const url = new URL(assertDisposableUrl(raw));
  url.pathname = `/${DISPOSABLE_LEGACY_DB}`;
  return url.toString();
};

const DB_URL = process.env.TED_CATEGORY_PG_URL;
const MARKER = process.env.TED_CATEGORY_PG_MARKER;
const ENABLED = Boolean(DB_URL && MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[cat-keyed-pg] SKIP: TED_CATEGORY_PG_URL + TED_CATEGORY_PG_MARKER required.');
}

// Forma legada mínima (mesmo recorte do fixture de accounts):
// canônico migrado + DDL de forma legada no companion.
const LEGACY_SHAPE_DDL = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE categories ALTER COLUMN status DROP NOT NULL`,
];

const countCategories = async (pool: Pool, householdId: string): Promise<number> => {
  const rows = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM categories WHERE household_id = $1', [
    householdId,
  ]);
  return Number(rows.rows[0]!.n);
};

describeIfDb('categories.create keyed PG descartável — canonical + legacy', () => {
  let pool: Pool;
  let legacyPool: Pool;
  const households: string[] = [];
  const legacyHouseholds: string[] = [];

  const track = (h: string): string => {
    households.push(h);
    return h;
  };
  const trackLegacy = (h: string): string => {
    legacyHouseholds.push(h);
    return h;
  };

  beforeAll(async () => {
    process.env.DB_TEST_MARKER = MARKER;
    // Preflight puro ANTES de qualquer I/O; guards (marker + nomes
    // protegidos) ANTES de migration/schema. Construir pools não escreve;
    // o primeiro write possível é o runMigrations, após os dois guards.
    const mainUrl = assertDisposableUrl(DB_URL);
    const main = createPool({ connectionString: mainUrl, max: 10 }) as unknown as Pool;
    const legacy = createPool({ connectionString: companionUrl(DB_URL!), max: 10 }) as unknown as Pool;
    await requireTestDatabase(main as never, 'cat-keyed-pg-main');
    await requireTestDatabase(legacy as never, 'cat-keyed-pg-legacy');
    // Defesa extra explícita: afirma o banco atual antes de migrar.
    for (const [p, expected] of [[main, DISPOSABLE_DB], [legacy, DISPOSABLE_LEGACY_DB]] as const) {
      const cur = await (p as Pool).query<{ current_database: string }>('SELECT current_database()');
      expect(cur.rows[0]!.current_database).toBe(expected);
    }
    await runMigrations(main as never);
    await runMigrations(legacy as never);
    // Marker precisa existir ANTES do runMigrations? Não: o guard já passou
    // (marker criado no provisionamento do container). DDL de forma legada:
    for (const ddl of LEGACY_SHAPE_DDL) await legacy.query(ddl);
    pool = main;
    legacyPool = legacy;
  }, 240_000);

  afterAll(async () => {
    try {
    if (pool) await requireTestDatabase(pool as never, 'cat-keyed-pg-cleanup');
    if (legacyPool) await requireTestDatabase(legacyPool as never, 'cat-keyed-pg-legacy-cleanup');
    for (const h of households) {
      await pool.query('DELETE FROM idempotency_keys WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM transactions WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM categories WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM accounts WHERE household_id = $1', [h]).catch(() => undefined);
    }
    for (const h of legacyHouseholds) {
      await legacyPool.query('DELETE FROM idempotency_keys WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM transactions WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM categories WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM accounts WHERE household_id = $1', [h]).catch(() => undefined);
    }
    await (pool as unknown as { end: () => Promise<void> })?.end();
    await (legacyPool as unknown as { end: () => Promise<void> })?.end();
    // Container/rede descartáveis preservados de propósito (higiene).
    } finally {
      delete process.env.DB_TEST_MARKER;
    }
  });

  describe('canonical', () => {
    it('isolamento do banco: current_database é o descartável', async () => {
      const cur = await pool.query<{ current_database: string }>('SELECT current_database()');
      expect(cur.rows[0]!.current_database).toBe(DISPOSABLE_DB);
    });

    it('happy N=6 concorrente mesma chave+payload → 1 categoria, mesmo id', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const payload = { name: 'Lazer', kind: 'expense' as const };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => writes.createCategory(H, payload, { idempotencyKey: 'k-happy' })),
      );
      expect(new Set(results.map((c) => c.id))).toEqual(new Set([results[0]!.id]));
      expect(await countCategories(pool, H)).toBe(1);
    });

    it('mesma chave + payload divergente → idempotency.conflict, 1 linha', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      await writes.createCategory(H, { name: 'A', kind: 'expense' }, { idempotencyKey: 'k-div' });
      await expect(
        writes.createCategory(H, { name: 'B', kind: 'expense' }, { idempotencyKey: 'k-div' }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict' });
      expect(await countCategories(pool, H)).toBe(1);
    });

    it('chaves distintas + mesmo nome → 2ª é in_use, 1 linha', async () => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      await writes.createCategory(H, { name: 'Mercado', kind: 'expense' }, { idempotencyKey: 'k-d1' });
      await expect(
        writes.createCategory(H, { name: 'MERCADO', kind: 'expense' }, { idempotencyKey: 'k-d2' }),
      ).rejects.toMatchObject({ code: 'in_use' });
      expect(await countCategories(pool, H)).toBe(1);
    });

    it('corrida N=6 chaves distintas mesmo nome → 1 criada + 5 in_use', async () => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          writes.createCategory(
            H,
            { name: 'Farmácia', kind: 'expense' },
            { idempotencyKey: `k-race-${i}` },
          ),
        ),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(5);
      for (const r of rejected) expect((r.reason as { code?: string }).code).toBe('in_use');
      expect(await countCategories(pool, H)).toBe(1);
    });

    it('workspace isolado: mesma chave em households distintos → 2 linhas, ids distintos', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H1 = track(randomUUID());
      const H2 = track(randomUUID());
      const payload = { name: 'Iso', kind: 'expense' as const };
      const a = await writes.createCategory(H1, payload, { idempotencyKey: 'k-iso' });
      const b = await writes.createCategory(H2, payload, { idempotencyKey: 'k-iso' });
      expect(b.id).not.toBe(a.id);
      expect(await countCategories(pool, H1)).toBe(1);
      expect(await countCategories(pool, H2)).toBe(1);
    });

    it('failure rollback: mutate com efeito + throw → nada persiste; retry converge a 1', async () => {
      const H = track(randomUUID());
      const payload = { name: 'Rollback', kind: 'expense' as const };
      let attempts = 0;
      const crashing = async (client: PoolClient): Promise<Category> => {
        attempts += 1;
        const cat = await createCategoryInTx(client, H, payload);
        if (attempts === 1) throw new Error('crash-after-effect');
        return cat;
      };
      await expect(
        runKeyedCategoryMutation({ pool, householdId: H, idempotencyKey: 'k-rb', payload, mutate: crashing }),
      ).rejects.toThrow('crash-after-effect');
      expect(await countCategories(pool, H)).toBe(0);
      const retried = await runKeyedCategoryMutation({
        pool,
        householdId: H,
        idempotencyKey: 'k-rb',
        payload,
        mutate: crashing,
      });
      expect(await countCategories(pool, H)).toBe(1);
      const again = await runKeyedCategoryMutation({
        pool,
        householdId: H,
        idempotencyKey: 'k-rb',
        payload,
        mutate: crashing,
      });
      expect(again.id).toBe(retried.id);
      expect(await countCategories(pool, H)).toBe(1);
    });

    it('snapshot integral: replay com todos os opcionais devolve os mesmos valores', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const parent = await writes.createCategory(H, { name: 'Pai', kind: 'expense' });
      const payload = {
        name: 'Filha',
        kind: 'expense' as const,
        parentId: parent.id,
        icon: 'ShoppingCart',
        color: '#AABBCC',
        sortOrder: 3,
        isDefault: true,
      };
      const first = await writes.createCategory(H, payload, { idempotencyKey: 'k-full' });
      const replayed = await writes.createCategory(H, payload, { idempotencyKey: 'k-full' });
      expect(replayed.id).toBe(first.id);
      expect(replayed.parentId).toBe(parent.id);
      expect(replayed.icon).toBe('ShoppingCart');
      expect(replayed.color).toBe('#AABBCC');
      expect(replayed.sortOrder).toBe(3);
      expect(replayed.isDefault).toBe(true);
    });

    it('snapshot antes do estado mutável: replay após parent desativado devolve o id; chave nova com parent inativo → not_found', async () => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const parent = await writes.createCategory(H, { name: 'Pai', kind: 'expense' });
      const payload = { name: 'Filha', kind: 'expense' as const, parentId: parent.id };
      const first = await writes.createCategory(H, payload, { idempotencyKey: 'k-snap-parent' });
      await writes.deactivateCategory(H, parent.id);
      const replayed = await writes.createCategory(H, payload, { idempotencyKey: 'k-snap-parent' });
      expect(replayed.id).toBe(first.id);
      await expect(
        writes.createCategory(H, payload, { idempotencyKey: 'k-snap-parent-new' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it.each([
      ['sortOrder string', { sortOrder: '3' }],
      ['parentId null', { parentId: null }],
      ['parentId não-UUID', { parentId: 'nope' }],
      ['icon numérico', { icon: 42 }],
      ['isDefault string', { isDefault: 'yes' }],
    ])('registro corrompido (%s) → replay rejeita idempotency.conflict sem criar linha', async (_label, patch) => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const payload = { name: 'Corrompida', kind: 'expense' as const };
      const key = `${PENDING_V2_IDEMPOTENCY_PREFIX}k-corrupt-${randomUUID()}`;
      const corrupted = {
        id: randomUUID(),
        householdId: H,
        name: 'Corrompida',
        kind: 'expense',
        status: 'active',
        ...patch,
      };
      await pool.query(
        'INSERT INTO idempotency_keys (household_id, key, payload_hash, response) VALUES ($1, $2, $3, $4)',
        [H, key, hashPayloadV2(payload), JSON.stringify({ category: corrupted })],
      );
      await expect(
        writes.createCategory(H, payload, { idempotencyKey: key.replace(PENDING_V2_IDEMPOTENCY_PREFIX, '') }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict' });
      expect(await countCategories(pool, H)).toBe(0);
    });
  });

  describe('legacy', () => {
    it('isolamento do banco: current_database é o companion descartável', async () => {
      const cur = await legacyPool.query<{ current_database: string }>('SELECT current_database()');
      expect(cur.rows[0]!.current_database).toBe(DISPOSABLE_LEGACY_DB);
    });

    it('happy N=6 concorrente mesma chave+payload → 1 categoria, mesmo id', async () => {
      const writes = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const payload = { name: 'Lazer L', kind: 'expense' as const };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => writes.createCategory(H, payload, { idempotencyKey: 'k-happy' })),
      );
      expect(new Set(results.map((c) => c.id))).toEqual(new Set([results[0]!.id]));
      expect(await countCategories(legacyPool, H)).toBe(1);
    });

    it('mesma chave + payload divergente → idempotency.conflict, 1 linha', async () => {
      const writes = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      await writes.createCategory(H, { name: 'AL', kind: 'expense' }, { idempotencyKey: 'k-div' });
      await expect(
        writes.createCategory(H, { name: 'BL', kind: 'expense' }, { idempotencyKey: 'k-div' }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict' });
      expect(await countCategories(legacyPool, H)).toBe(1);
    });

    it('RED legado keyed: chaves distintas + mesmo nome → 2ª é in_use (sem reaproveitar a linha)', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const first = await writes.createCategory(
        H,
        { name: 'Mercado L', kind: 'expense' },
        { idempotencyKey: 'k-d1' },
      );
      await expect(
        writes.createCategory(H, { name: 'MERCADO L', kind: 'expense' }, { idempotencyKey: 'k-d2' }),
      ).rejects.toMatchObject({ code: 'in_use' });
      expect(await countCategories(legacyPool, H)).toBe(1);
      // A linha existente é a da primeira chave — nada foi reaproveitado.
      const rows = await legacyPool.query<{ id: string }>('SELECT id FROM categories WHERE household_id = $1', [H]);
      expect(rows.rows[0]!.id).toBe(first.id);
    });

    it('compatibilidade unkeyed legada preservada: duplicado sem chave nunca falha com in_use', async () => {
      // O reaproveitamento da linha (ON CONFLICT) depende do índice V049 do
      // deployment; o contrato preservado aqui é que o caminho sem chave
      // nunca falha fechado com in_use/idempotency.conflict — só o caminho
      // keyed (chaves distintas) falha com in_use.
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const first = await writes.createCategory(H, { name: 'Compat', kind: 'expense' });
      const second = await writes.createCategory(H, { name: 'COMPAT', kind: 'expense' });
      expect(first.householdId).toBe(H);
      expect(second.householdId).toBe(H);
      expect(second.kind).toBe('expense');
    });

    it('corrida N=6 chaves distintas mesmo nome → 1 criada + 5 in_use', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          writes.createCategory(H, { name: 'Farmácia L', kind: 'expense' }, { idempotencyKey: `k-race-${i}` }),
        ),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(5);
      for (const r of rejected) expect((r.reason as { code?: string }).code).toBe('in_use');
      expect(await countCategories(legacyPool, H)).toBe(1);
    });

    it('workspace isolado: mesma chave em households distintos → 2 linhas', async () => {
      const writes = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H1 = trackLegacy(randomUUID());
      const H2 = trackLegacy(randomUUID());
      const payload = { name: 'Iso L', kind: 'expense' as const };
      const a = await writes.createCategory(H1, payload, { idempotencyKey: 'k-iso' });
      const b = await writes.createCategory(H2, payload, { idempotencyKey: 'k-iso' });
      expect(b.id).not.toBe(a.id);
      expect(await countCategories(legacyPool, H1)).toBe(1);
      expect(await countCategories(legacyPool, H2)).toBe(1);
    });

    it('failure rollback: mutate com efeito + throw → nada persiste; retry converge a 1', async () => {
      const H = trackLegacy(randomUUID());
      const payload = { name: 'Rollback L', kind: 'expense' as const };
      let attempts = 0;
      const crashing = async (client: PoolClient): Promise<Category> => {
        attempts += 1;
        const cat = await createCategoryLegacyKeyedInTx(client, H, payload);
        if (attempts === 1) throw new Error('crash-after-effect');
        return cat;
      };
      await expect(
        runKeyedCategoryMutation({ pool: legacyPool, householdId: H, idempotencyKey: 'k-rb', payload, mutate: crashing }),
      ).rejects.toThrow('crash-after-effect');
      expect(await countCategories(legacyPool, H)).toBe(0);
      const retried = await runKeyedCategoryMutation({
        pool: legacyPool,
        householdId: H,
        idempotencyKey: 'k-rb',
        payload,
        mutate: crashing,
      });
      expect(await countCategories(legacyPool, H)).toBe(1);
      const again = await runKeyedCategoryMutation({
        pool: legacyPool,
        householdId: H,
        idempotencyKey: 'k-rb',
        payload,
        mutate: crashing,
      });
      expect(again.id).toBe(retried.id);
      expect(await countCategories(legacyPool, H)).toBe(1);
    });

    it('snapshot antes do estado mutável: replay após parent desativado devolve o id; chave nova → not_found', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const parent = await writes.createCategory(H, { name: 'Pai L', kind: 'expense' });
      const payload = { name: 'Filha L', kind: 'expense' as const, parentId: parent.id };
      const first = await writes.createCategory(H, payload, { idempotencyKey: 'k-snap-parent' });
      await writes.deactivateCategory(H, parent.id);
      const replayed = await writes.createCategory(H, payload, { idempotencyKey: 'k-snap-parent' });
      expect(replayed.id).toBe(first.id);
      await expect(
        writes.createCategory(H, payload, { idempotencyKey: 'k-snap-parent-new' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('registro corrompido (sortOrder string) → replay rejeita idempotency.conflict sem criar linha', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const payload = { name: 'Corrompida L', kind: 'expense' as const };
      const key = `${PENDING_V2_IDEMPOTENCY_PREFIX}k-corrupt-${randomUUID()}`;
      const corrupted = { id: randomUUID(), householdId: H, name: 'Corrompida L', kind: 'expense', status: 'active', sortOrder: '3' };
      await legacyPool.query(
        'INSERT INTO idempotency_keys (household_id, key, payload_hash, response) VALUES ($1, $2, $3, $4)',
        [H, key, hashPayloadV2(payload), JSON.stringify({ category: corrupted })],
      );
      await expect(
        writes.createCategory(H, payload, { idempotencyKey: key.replace(PENDING_V2_IDEMPOTENCY_PREFIX, '') }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict' });
      expect(await countCategories(legacyPool, H)).toBe(0);
    });

    it('replay após erro próprio conserva o erro original quando não há vencedor (sem máscara)', async () => {
      // Cobre o own-error path: mutate falha sem registro vencedor → o erro
      // original propaga (nunca convertido em conflict).
      const H = trackLegacy(randomUUID());
      const payload = { name: 'OwnErr', kind: 'expense' as const };
      const boom = async (): Promise<Category> => {
        throw domainErrors.invalid('name', 'nome inválido de propósito');
      };
      await expect(
        runKeyedCategoryMutation({ pool: legacyPool, householdId: H, idempotencyKey: `k-own-${randomUUID()}`, payload, mutate: boom }),
      ).rejects.toMatchObject({ code: 'validation.invalid' });
      expect(await countCategories(legacyPool, H)).toBe(0);
    });
  });
});
