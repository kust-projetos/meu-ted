/**
 * Round2 (ted-local.account-idempotency) + Round3 (preflight/envelope): provas
 * PG permanentes para accounts.create keyed — canonical + legacy, sem sleep.
 *
 * SEGURANÇA DO HARNESS (Round3 HIGH): esta suíte NÃO provisiona nada — sem
 * CREATE DATABASE, sem criar _test_marker. O beforeAll valida a URL pelo
 * preflight puro (`src/db/validation-preflight.ts`: protocolo postgresql,
 * host loopback 127.0.0.1/localhost, porta 5433, database EXATO
 * ted_validation_20261021; companion EXATO ted_validation_20261021_legacy)
 * ANTES de qualquer I/O, e o guard de marker pré-existente
 * (requireTestDatabase) passa ANTES de migration/schema/cleanup. URL
 * arbitrária (ted_local, produção, outro host/banco) falha fechada no
 * preflight; marker ausente/divergente falha no guard — sem nenhum write.
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER (marker PRÉ-EXISTENTE nas duas
 * bases, preparado fora desta suíte). Bases descartáveis desta validação;
 * ted_local (browser) e produção nunca tocados.
 *
 * Comandos reproduzíveis (a partir de D:/projetos/pi-financeiro):
 *   $env:DATABASE_URL_TEST='postgresql://127.0.0.1:5433/ted_validation_20261021'
 *   $env:DB_TEST_MARKER='<marker pré-existente nas 2 bases>'
 *   pnpm --filter meu-ted-api exec vitest run tests/approvals/pending-v2-accounts-create-idempotency-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { prepareValidationDatabases } from '../../src/db/validation-preflight.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore, createAccountInTx } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore, createAccountLegacyInTx } from '../../src/writes/legacy-postgres.js';
import {
  runKeyedAccountMutation,
} from '../../src/writes/pending-idempotency.js';
import { DomainError } from '../../src/writes/errors.js';
import type { WriteStore } from '../../src/writes/store.js';
import type { Account } from '../../src/types/domain.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const MARKER = process.env.DB_TEST_MARKER;
const ENABLED = Boolean(DB_URL && MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[acct-keyed-pg] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

// Forma legada mínima para o caminho de contas (mesmo recorte de
// xlt-07-undo-crash: canonical migrado + DDL de forma legada).
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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const countAccounts = async (pool: Pool, householdId: string): Promise<number> => {
  const rows = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM accounts WHERE household_id = $1', [
    householdId,
  ]);
  return Number(rows.rows[0]!.n);
};

describeIfDb('accounts.create keyed PG — canonical + legacy (round2)', () => {
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
    // Round3 HIGH: preflight puro ANTES de qualquer I/O — URL arbitrária
    // falha aqui, sem pool, sem conexão, sem write.
    // Round4 MEDIUM: preflight + guards (main e legacy) ANTES de qualquer
    // migration/schema via helper. Construir pools nao escreve; o primeiro
    // write possivel e o runMigrations, apos os dois guards.
    const prepared = await prepareValidationDatabases({
      baseUrl: DB_URL!,
      createPool: (connectionString: string) =>
        createPool({ connectionString, max: 10 }) as unknown as Pool,
      requireGuard: (target: unknown, operation: string) =>
        requireTestDatabase(target as never, operation),
      migrate: (target: unknown) => runMigrations(target as never),
      afterMigrate: async ({ legacy }) => {
        for (const ddl of LEGACY_SHAPE_DDL) await (legacy as Pool).query(ddl);
      },
    });
    pool = prepared.main;
    legacyPool = prepared.legacy;
  }, 240_000);

  afterAll(async () => {
    // Guard antes dos DELETEs de limpeza (fail-closed).
    if (pool) await requireTestDatabase(pool as never, 'acct-keyed-pg-cleanup');
    if (legacyPool) await requireTestDatabase(legacyPool as never, 'acct-keyed-pg-legacy-cleanup');
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
  });

  const keyedOpts = (
    targetPool: Pool,
    householdId: string,
    idempotencyKey: string,
    payload: unknown,
    mutate: (client: PoolClient) => Promise<Account>,
  ) => ({
    pool: targetPool as never,
    householdId,
    idempotencyKey,
    payload,
    mutate,
  });

  describe('canonical', () => {
    it('happy N=6 concorrente mesma chave+payload → 1 conta, mesmo id', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const payload = { name: 'Conta Happy', kind: 'bank' as const, initialBalanceCents: 1000 };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => writes.createAccount(H, payload, { idempotencyKey: 'k-happy' })),
      );
      const ids = new Set(results.map((a) => a.id));
      expect(ids.size).toBe(1);
      expect(await countAccounts(pool, H)).toBe(1);
    });

    it('mesma chave + payload divergente → idempotency.conflict', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      await writes.createAccount(H, { name: 'A', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-div' });
      await expect(
        writes.createAccount(H, { name: 'B', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-div' }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict' });
      expect(await countAccounts(pool, H)).toBe(1);
    });

    it('workspace isolado: mesma chave em households distintos → 2 contas', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H1 = track(randomUUID());
      const H2 = track(randomUUID());
      const payload = { name: 'Conta Iso', kind: 'cash' as const, initialBalanceCents: 0 };
      const a = await writes.createAccount(H1, payload, { idempotencyKey: 'k-iso' });
      const b = await writes.createAccount(H2, payload, { idempotencyKey: 'k-iso' });
      expect(b.id).not.toBe(a.id);
      expect(await countAccounts(pool, H1)).toBe(1);
      expect(await countAccounts(pool, H2)).toBe(1);
    });

    it('failure rollback: mutate com efeito + throw → nada persiste; retry converge a 1', async () => {
      const H = track(randomUUID());
      const payload = { name: 'Conta Rollback', kind: 'bank' as const, initialBalanceCents: 0 };
      let attempts = 0;
      const crashing = async (client: PoolClient): Promise<Account> => {
        attempts += 1;
        const acc = await createAccountInTx(client, H, payload);
        if (attempts === 1) throw new Error('crash-after-effect');
        return acc;
      };
      await expect(runKeyedAccountMutation(keyedOpts(pool, H, 'k-rb', payload, crashing))).rejects.toThrow(
        'crash-after-effect',
      );
      expect(await countAccounts(pool, H)).toBe(0);
      const retried = await runKeyedAccountMutation(keyedOpts(pool, H, 'k-rb', payload, crashing));
      expect(await countAccounts(pool, H)).toBe(1);
      const again = await runKeyedAccountMutation(keyedOpts(pool, H, 'k-rb', payload, crashing));
      expect(again.id).toBe(retried.id);
      expect(await countAccounts(pool, H)).toBe(1);
    });

    it.each([
      { kind: 'boom', error: () => new Error('boom-pre-claim') },
      {
        kind: 'archived',
        error: () => new DomainError('workspace.archived', 'Workspace arquivado.', 403),
      },
    ])(
      'achado 1: B SELECT ausente, A commit, B mutate $kind → replay do vencedor (1 conta)',
      async ({ error }) => {
        const H = track(randomUUID());
        const payload = { name: 'Conta Preclaim', kind: 'bank' as const, initialBalanceCents: 0 };
        const entered = deferred();
        const release = deferred();
        const bMutate = async (): Promise<Account> => {
          entered.resolve();
          await release.promise;
          throw error();
        };
        const bPromise = runKeyedAccountMutation(keyedOpts(pool, H, 'k-pre', payload, bMutate));
        await entered.promise;
        const winner = await runKeyedAccountMutation(
          keyedOpts(pool, H, 'k-pre', payload, (client) => createAccountInTx(client, H, payload)),
        );
        release.resolve();
        const replayed = await bPromise;
        expect(replayed.id).toBe(winner.id);
        expect(await countAccounts(pool, H)).toBe(1);
      },
    );

    it('achado 2: chaves distintas + mesmo nome (case-insensitive) → 2ª é in_use, 1 conta', async () => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      await writes.createAccount(H, { name: 'Caixa', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-d1' });
      await expect(
        writes.createAccount(H, { name: 'CAIXA', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-d2' }),
      ).rejects.toMatchObject({ code: 'in_use' });
      expect(await countAccounts(pool, H)).toBe(1);
    });

    it('achado 2: corrida N=6 chaves distintas mesmo nome → 1 criada + 5 in_use', async () => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          writes.createAccount(
            H,
            { name: 'Conta Corrida', kind: 'bank', initialBalanceCents: 0 },
            { idempotencyKey: `k-race-${i}` },
          ),
        ),
      );
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) expect((r.reason as { code?: string }).code).toBe('in_use');
      expect(await countAccounts(pool, H)).toBe(1);
    });
  });

  describe('legacy', () => {
    it('workspace isolado: mesma chave em households distintos → 2 contas', async () => {
      const writes = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H1 = trackLegacy(randomUUID());
      const H2 = trackLegacy(randomUUID());
      const payload = { name: 'Conta Iso L', kind: 'cash' as const, initialBalanceCents: 0 };
      const a = await writes.createAccount(H1, payload, { idempotencyKey: 'k-iso' });
      const b = await writes.createAccount(H2, payload, { idempotencyKey: 'k-iso' });
      expect(b.id).not.toBe(a.id);
      expect(await countAccounts(legacyPool, H1)).toBe(1);
      expect(await countAccounts(legacyPool, H2)).toBe(1);
    });

    it.each([
      { kind: 'boom', error: () => new Error('boom-pre-claim') },
      {
        kind: 'archived',
        error: () => new DomainError('workspace.archived', 'Workspace arquivado.', 403),
      },
    ])(
      'achado 1: B SELECT ausente, A commit, B mutate $kind → replay do vencedor (1 conta)',
      async ({ error }) => {
        const H = trackLegacy(randomUUID());
        const payload = { name: 'Conta Preclaim L', kind: 'bank' as const, initialBalanceCents: 0 };
        const entered = deferred();
        const release = deferred();
        const bMutate = async (): Promise<Account> => {
          entered.resolve();
          await release.promise;
          throw error();
        };
        const bPromise = runKeyedAccountMutation(keyedOpts(legacyPool, H, 'k-pre', payload, bMutate));
        await entered.promise;
        const winner = await runKeyedAccountMutation(
          keyedOpts(legacyPool, H, 'k-pre', payload, (client) => createAccountLegacyInTx(client, H, payload)),
        );
        release.resolve();
        const replayed = await bPromise;
        expect(replayed.id).toBe(winner.id);
        expect(await countAccounts(legacyPool, H)).toBe(1);
      },
    );

    it('happy N=6 concorrente mesma chave+payload → 1 conta, mesmo id', async () => {
      const writes = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const payload = { name: 'Conta Happy L', kind: 'bank' as const, initialBalanceCents: 1000 };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => writes.createAccount(H, payload, { idempotencyKey: 'k-happy' })),
      );
      expect(new Set(results.map((a) => a.id)).size).toBe(1);
      expect(await countAccounts(legacyPool, H)).toBe(1);
    });

    it('mesma chave + payload divergente → idempotency.conflict', async () => {
      const writes = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      await writes.createAccount(H, { name: 'AL', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-div' });
      await expect(
        writes.createAccount(H, { name: 'BL', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-div' }),
      ).rejects.toMatchObject({ code: 'idempotency.conflict' });
      expect(await countAccounts(legacyPool, H)).toBe(1);
    });

    it('failure rollback: mutate com efeito + throw → nada persiste; retry converge a 1', async () => {
      const H = trackLegacy(randomUUID());
      const payload = { name: 'Conta Rollback L', kind: 'bank' as const, initialBalanceCents: 0 };
      let attempts = 0;
      // Efeito legado inline (forma legada da tabela): o que importa aqui é
      // o rollback transacional do runner, não o helper da store.
      const crashing = async (client: PoolClient): Promise<Account> => {
        attempts += 1;
        const res = await client.query(
          `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active)
           VALUES (gen_random_uuid(), $1, $2, $3, true)
           RETURNING id, household_id, name, initial_balance_cents, active`,
          [H, payload.name, payload.initialBalanceCents],
        );
        const row = res.rows[0] as Record<string, unknown>;
        const acc: Account = {
          id: row['id'] as string,
          householdId: H,
          name: payload.name,
          kind: 'bank',
          balanceCents: 0,
          status: 'active',
        };
        if (attempts === 1) throw new Error('crash-after-effect');
        return acc;
      };
      await expect(runKeyedAccountMutation(keyedOpts(legacyPool, H, 'k-rb', payload, crashing))).rejects.toThrow(
        'crash-after-effect',
      );
      expect(await countAccounts(legacyPool, H)).toBe(0);
      const retried = await runKeyedAccountMutation(keyedOpts(legacyPool, H, 'k-rb', payload, crashing));
      expect(await countAccounts(legacyPool, H)).toBe(1);
      const again = await runKeyedAccountMutation(keyedOpts(legacyPool, H, 'k-rb', payload, crashing));
      expect(again.id).toBe(retried.id);
    });

    it('achado 2: chaves distintas + mesmo nome (case-insensitive) → 2ª é in_use, 1 conta', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      await writes.createAccount(H, { name: 'Caixa L', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-d1' });
      await expect(
        writes.createAccount(H, { name: 'caixa l', kind: 'bank', initialBalanceCents: 0 }, { idempotencyKey: 'k-d2' }),
      ).rejects.toMatchObject({ code: 'in_use' });
      expect(await countAccounts(legacyPool, H)).toBe(1);
    });

    it('achado 2: corrida N=6 chaves distintas mesmo nome → 1 criada + 5 in_use', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          writes.createAccount(
            H,
            { name: 'Conta Corrida L', kind: 'bank', initialBalanceCents: 0 },
            { idempotencyKey: `k-race-${i}` },
          ),
        ),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(5);
      for (const r of rejected) expect((r.reason as { code?: string }).code).toBe('in_use');
      expect(await countAccounts(legacyPool, H)).toBe(1);
    });
  });
});
