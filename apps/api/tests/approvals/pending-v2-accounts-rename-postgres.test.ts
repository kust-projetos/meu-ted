/**
 * accounts.update (rename-only, ADR-029): provas PG permanentes — canonical + legacy.
 *
 * Harness seguro (Round3/4): SEM provisionamento — sem CREATE DATABASE, sem
 * criar marker, sem migrations/DDL. beforeAll: preflight puro da URL →
 * cria os dois pools → requireTestDatabase (marker PRÉ-EXISTENTE) nos dois
 * → testes. afterAll: guards → DELETEs por household → end. ted_local e
 * produção nunca tocados; qualquer URL fora das duas bases descartáveis
 * falha fechada no preflight antes de qualquer I/O.
 *
 * Comandos reproduzíveis (a partir de D:/projetos/pi-financeiro):
 *   $env:DATABASE_URL_TEST='postgresql://127.0.0.1:5433/ted_validation_20261021'
 *   $env:DB_TEST_MARKER='<marker pré-existente nas 2 bases>'
 *   pnpm --filter meu-ted-api exec vitest run tests/approvals/pending-v2-accounts-rename-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import {
  assertValidationDatabaseUrl,
  createValidationPools,
} from '../../src/db/validation-preflight.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import { requireApprovalToolContract } from '../../src/approvals/tool-registry.js';
import type { WriteStore } from '../../src/writes/store.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const MARKER = process.env.DB_TEST_MARKER;
const ENABLED = Boolean(DB_URL && MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[acct-rename-pg] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const rename = (accountId: string, name: string, expectedName: string) => ({ accountId, name, expectedName });

const balanceOf = async (pool: Pool, householdId: string, id: string): Promise<number> => {
  const rows = await pool.query<{ balance_cents: string }>(
    'SELECT balance_cents::text AS balance_cents FROM accounts WHERE household_id = $1 AND id = $2',
    [householdId, id],
  );
  return Number(rows.rows[0]!.balance_cents);
};

const nameOf = async (pool: Pool, householdId: string, id: string): Promise<string> => {
  const rows = await pool.query<{ name: string }>(
    'SELECT name FROM accounts WHERE household_id = $1 AND id = $2',
    [householdId, id],
  );
  return rows.rows[0]!.name;
};

describeIfDb('accounts.update rename PG — canonical + legacy', () => {
  let pool: Pool;
  let legacyPool: Pool;
  const households: string[] = [];
  const legacyHouseholds: string[] = [];
  const trackedLegacyUsers: string[] = [];

  const track = (h: string): string => {
    households.push(h);
    return h;
  };
  const trackLegacy = (h: string): string => {
    legacyHouseholds.push(h);
    return h;
  };

  beforeAll(async () => {
    assertValidationDatabaseUrl(DB_URL!);
    const pools = createValidationPools({
      baseUrl: DB_URL!,
      createPool: (connectionString: string) => createPool({ connectionString, max: 10 }) as unknown as Pool,
    });
    pool = pools.main;
    legacyPool = pools.legacy;
    await requireTestDatabase(pool as never, 'acct-rename-pg');
    await requireTestDatabase(legacyPool as never, 'acct-rename-pg-legacy');
  }, 60_000);

  afterAll(async () => {
    if (pool) await requireTestDatabase(pool as never, 'acct-rename-pg-cleanup');
    if (legacyPool) await requireTestDatabase(legacyPool as never, 'acct-rename-pg-legacy-cleanup');
    for (const h of households) {
      await pool.query('DELETE FROM idempotency_keys WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM transactions WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM categories WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM accounts WHERE household_id = $1', [h]).catch(() => undefined);
      await pool.query('DELETE FROM pending_operations WHERE workspace_id = $1', [h]).catch(() => undefined);
    }
    for (const h of legacyHouseholds) {
      await legacyPool.query('DELETE FROM idempotency_keys WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM transactions WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM categories WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM accounts WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM memberships WHERE household_id = $1', [h]).catch(() => undefined);
      await legacyPool.query('DELETE FROM households WHERE id = $1', [h]).catch(() => undefined);
    }
    for (const u of trackedLegacyUsers) {
      await legacyPool.query('DELETE FROM users WHERE id = $1', [u]).catch(() => undefined);
    }
    await (pool as unknown as { end: () => Promise<void> })?.end();
    await (legacyPool as unknown as { end: () => Promise<void> })?.end();
  });

  const exec = (
    writes: WriteStore,
    workspaceId: string,
    args: unknown,
    idempotencyKey: string,
  ) =>
    requireApprovalToolContract('accounts.update').executor({
      writes,
      workspaceId,
      args,
      idempotencyKey,
      actorId: 'actor-1',
    });

  describe('canonical', () => {
    it('executor renomeia via chave: recibo, id estável, saldo intacto', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 7777 });
      const before = await balanceOf(pool, H, acc.id);
      const result = await exec(writes, H, rename(acc.id, 'Nova', 'Velha'), 'k-exec');
      expect(result.operationId).toBe(acc.id);
      expect(result.receipt.mutationKind).toBe('accounts.update');
      expect(result.receipt.entity).toEqual({ type: 'account', id: acc.id });
      expect(await nameOf(pool, H, acc.id)).toBe('Nova');
      expect(await balanceOf(pool, H, acc.id)).toBe(before);
    });

    it('replay mesma chave → mesmo id, sem novo efeito', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'cash', initialBalanceCents: 100 });
      const first = await exec(writes, H, rename(acc.id, 'Nova', 'Velha'), 'k-replay');
      const second = await exec(writes, H, rename(acc.id, 'Nova', 'Velha'), 'k-replay');
      expect(second.operationId).toBe(first.operationId);
      expect(await nameOf(pool, H, acc.id)).toBe('Nova');
    });

    it('isolamento cross-workspace: mesma chave em households distintos', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H1 = track(randomUUID());
      const H2 = track(randomUUID());
      const a = await writes.createAccount(H1, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const b = await writes.createAccount(H2, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const r1 = await exec(writes, H1, rename(a.id, 'Nova', 'Velha'), 'k-iso');
      const r2 = await exec(writes, H2, rename(b.id, 'Nova', 'Velha'), 'k-iso');
      expect(r1.operationId).toBe(a.id);
      expect(r2.operationId).toBe(b.id);
      expect(await nameOf(pool, H1, a.id)).toBe('Nova');
      expect(await nameOf(pool, H2, b.id)).toBe('Nova');
    });

    it('alvo desconhecido → not_found; inativo → not_found', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      await expect(
        exec(writes, H, rename(randomUUID(), 'Nova', 'Velha'), 'k-miss'),
      ).rejects.toMatchObject({ code: 'not_found' });
      const acc = await writes.createAccount(H, { name: 'Alvo', kind: 'bank', initialBalanceCents: 0 });
      await writes.deactivateAccount(H, acc.id);
      await expect(
        exec(writes, H, rename(acc.id, 'Nova', 'Alvo'), 'k-inactive'),
      ).rejects.toMatchObject({ code: 'not_found' });
      const rows = await pool.query('SELECT COUNT(*)::text AS n FROM accounts WHERE household_id = $1', [H]);
      expect(Number(rows.rows[0]!.n)).toBe(1);
    });

    it('expectedName divergente → account.name_conflict, sem efeito', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      await expect(
        exec(writes, H, rename(acc.id, 'Nova', 'Errado'), 'k-clash'),
      ).rejects.toMatchObject({ code: 'account.name_conflict' });
      expect(await nameOf(pool, H, acc.id)).toBe('Velha');
    });

    it('concorrente: dois renames mesma conta/mesmo expectedName → 1 vence + 1 name_conflict', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const outcomes = await Promise.allSettled([
        exec(writes, H, rename(acc.id, 'Nova A', 'Velha'), 'k-race-1'),
        exec(writes, H, rename(acc.id, 'Nova B', 'Velha'), 'k-race-2'),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as { code?: string }).code).toBe('account.name_conflict');
      const finalName = await nameOf(pool, H, acc.id);
      expect(['Nova A', 'Nova B']).toContain(finalName);
    });

    it('cancel → execute falha, 0 efeito', async () => {
      const writes = createPostgresWriteStore({ pool: pool as never });
      const { createPostgresPendingOperationV2Store } = await import('../../src/approvals/pending-v2.js');
      const { computePendingOperationV2Hash } = await import('@pi-finance/llm-contracts');
      const store = createPostgresPendingOperationV2Store(pool as never);
      const H = track(randomUUID());
      const identity = { workspaceId: H, actorId: 'actor-1', deviceId: 'device-1' };
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const args = rename(acc.id, 'Nova', 'Velha');
      const base = {
        version: 2 as const, ...identity, tool: 'accounts.update',
        normalizedArgs: args, proposalHash: '', idempotencyKey: 'k-cancel',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        bindings: { ...identity },
      };
      const saved = await store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
      const confirmed = await store.confirm(saved.id, identity);
      await store.cancel(saved.id, identity);
      await expect(
        store.execute(
          confirmed.attestation!, identity,
          (async (op: { tool: string; workspaceId: string; normalizedArgs: unknown; idempotencyKey: string }) =>
            requireApprovalToolContract(op.tool).executor({
              writes, workspaceId: op.workspaceId, args: op.normalizedArgs,
              idempotencyKey: op.idempotencyKey, actorId: 'actor-1',
            })) as never,
        ),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(await nameOf(pool, H, acc.id)).toBe('Velha');
    });

    it('replay após nome mudado externamente retorna o resultado original, sem sobrescrever', async () => {
      const writes: WriteStore = createPostgresWriteStore({ pool: pool as never });
      const H = track(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const first = await writes.updateAccount(
        H, acc.id, { name: 'Nova' }, { idempotencyKey: 'k-changed', expectedName: 'Velha' },
      );
      expect(first.name).toBe('Nova');
      // Mudança externa fora da chave (outro ator/ferramenta).
      await writes.updateAccount(H, acc.id, { name: 'Externa' });
      expect(await nameOf(pool, H, acc.id)).toBe('Externa');
      // Recovery com a MESMA chave: replay do resultado original, 0 efeito.
      const replayed = await writes.updateAccount(
        H, acc.id, { name: 'Nova' }, { idempotencyKey: 'k-changed', expectedName: 'Velha' },
      );
      expect(replayed.id).toBe(acc.id);
      expect(replayed.name).toBe('Nova');
      expect(await nameOf(pool, H, acc.id)).toBe('Externa');
    });
  });

  describe('legacy', () => {
    it('renomeia via chave, replay idêntico, mismatch determinístico', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha L', kind: 'bank', initialBalanceCents: 0 });
      const first = await exec(writes, H, rename(acc.id, 'Nova L', 'Velha L'), 'k-leg');
      expect(first.operationId).toBe(acc.id);
      const second = await exec(writes, H, rename(acc.id, 'Nova L', 'Velha L'), 'k-leg');
      expect(second.operationId).toBe(acc.id);
      await expect(
        exec(writes, H, rename(acc.id, 'Outra', 'Errado'), 'k-leg-clash'),
      ).rejects.toMatchObject({ code: 'account.name_conflict' });
      expect(await nameOf(legacyPool, H, acc.id)).toBe('Nova L');
    });

    it('isolamento cross-workspace + inativo → not_found', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H1 = trackLegacy(randomUUID());
      const H2 = trackLegacy(randomUUID());
      const a = await writes.createAccount(H1, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const b = await writes.createAccount(H2, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      await exec(writes, H1, rename(a.id, 'Nova', 'Velha'), 'k-iso-l');
      await exec(writes, H2, rename(b.id, 'Nova', 'Velha'), 'k-iso-l');
      expect(await nameOf(legacyPool, H1, a.id)).toBe('Nova');
      expect(await nameOf(legacyPool, H2, b.id)).toBe('Nova');
      // Inativo via fixture de dados (UPDATE direto): o deactivate legado
      // exigiria a forma completa de transactions (from_account_id), que
      // esta base descartável não tem e não será provisionada aqui. O estado
      // inativo em si é o que o rename valida.
      const c = await writes.createAccount(H1, { name: 'Alvo', kind: 'bank', initialBalanceCents: 0 });
      await legacyPool.query('UPDATE accounts SET active = false WHERE id = $1', [c.id]);
      await expect(
        exec(writes, H1, rename(c.id, 'Outra', 'Alvo'), 'k-leg-inactive'),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('concorrente: dois renames → 1 vence + 1 name_conflict', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const outcomes = await Promise.allSettled([
        exec(writes, H, rename(acc.id, 'Nova A', 'Velha'), 'k-leg-race-1'),
        exec(writes, H, rename(acc.id, 'Nova B', 'Velha'), 'k-leg-race-2'),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as { code?: string }).code).toBe('account.name_conflict');
      expect(['Nova A', 'Nova B']).toContain(await nameOf(legacyPool, H, acc.id));
    });

    it('cartão legado (is_credit_card) → validation.invalid, sem rename e sem mudar saldo', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      // Fixture honesta de cartão legado: flag real is_credit_card (a mesma
      // que o CardStore legado grava). Sem DDL, só dados.
      const cardId = randomUUID();
      await legacyPool.query(
        `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active, is_credit_card)
         VALUES ($1, $2, 'Cartão L', 1000, true, true)`,
        [cardId, H],
      );
      await expect(
        exec(writes, H, rename(cardId, 'Cartão Novo', 'Cartão L'), 'k-leg-card'),
      ).rejects.toMatchObject({ code: 'validation.invalid' });
      expect(await nameOf(legacyPool, H, cardId)).toBe('Cartão L');
      const anchor = await legacyPool.query<{ initial_balance_cents: string }>(
        'SELECT initial_balance_cents::text AS initial_balance_cents FROM accounts WHERE id = $1',
        [cardId],
      );
      expect(Number(anchor.rows[0]!.initial_balance_cents)).toBe(1000);
    });

    it('lifecycle legado: active renomeia; archived → 403; deleted → 410', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const seedHousehold = async (status: string): Promise<string> => {
        const userId = randomUUID();
        const id = trackLegacy(randomUUID());
        // Seed honesto de dados (sem DDL): users + households com owner —
        // os triggers do schema criam o membership; o guard só lê status.
        await legacyPool.query('INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, $4)', [
          userId,
          `lseed-${id}@example.test`,
          'L Seed',
          'active',
        ]);
        trackedLegacyUsers.push(userId);
        await legacyPool.query(
          'INSERT INTO households (id, name, kind, status, archived_at, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, `L ${id.slice(0, 8)}`, 'shared', status, status === 'archived' ? new Date().toISOString() : null, userId],
        );
        return id;
      };
      const hActive = await seedHousehold('active');
      const aActive = await writes.createAccount(hActive, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      await exec(writes, hActive, rename(aActive.id, 'Nova', 'Velha'), 'k-leg-cycle-active');
      expect(await nameOf(legacyPool, hActive, aActive.id)).toBe('Nova');

      const hArchived = await seedHousehold('archived');
      const aArchived = await writes.createAccount(hArchived, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      await expect(
        exec(writes, hArchived, rename(aArchived.id, 'Nova', 'Velha'), 'k-leg-cycle-archived'),
      ).rejects.toMatchObject({ code: 'workspace.archived' });
      expect(await nameOf(legacyPool, hArchived, aArchived.id)).toBe('Velha');

      const hDeleted = await seedHousehold('deleted');
      const bDeleted = await writes.createAccount(hDeleted, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      await expect(
        exec(writes, hDeleted, rename(bDeleted.id, 'Nova', 'Velha'), 'k-leg-cycle-deleted'),
      ).rejects.toMatchObject({ code: 'workspace.deleted' });
      expect(await nameOf(legacyPool, hDeleted, bDeleted.id)).toBe('Velha');
    });

    it('corrida rename vs archive: archive sempre vence o estado; rename ou aplica antes ou falha 403', async () => {
      const writes: WriteStore = createLegacyPostgresWriteStore({ pool: legacyPool as never });
      const H = trackLegacy(randomUUID());
      const userId = randomUUID();
      await legacyPool.query('INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, $4)', [
        userId,
        `lseed-${H}@example.test`,
        'L Seed',
        'active',
      ]);
      trackedLegacyUsers.push(userId);
      await legacyPool.query(
        'INSERT INTO households (id, name, kind, status, owner_user_id) VALUES ($1, $2, $3, $4, $5)',
        [H, `L race ${H.slice(0, 8)}`, 'shared', 'active', userId],
      );
      const acc = await writes.createAccount(H, { name: 'Velha', kind: 'bank', initialBalanceCents: 0 });
      const outcomes = await Promise.allSettled([
        exec(writes, H, rename(acc.id, 'Nova', 'Velha'), 'k-leg-race-cycle'),
        legacyPool.query("UPDATE households SET status = 'archived', archived_at = NOW() WHERE id = $1", [H]),
      ]);
      const renameOutcome = outcomes[0]!;
      expect(outcomes[1]!.status).toBe('fulfilled');
      if (renameOutcome.status === 'fulfilled') {
        expect(await nameOf(legacyPool, H, acc.id)).toBe('Nova');
      } else {
        expect((renameOutcome.reason as { code?: string }).code).toBe('workspace.archived');
        expect(await nameOf(legacyPool, H, acc.id)).toBe('Velha');
      }
      const status = await legacyPool.query<{ status: string }>('SELECT status FROM households WHERE id = $1', [H]);
      expect(status.rows[0]!.status).toBe('archived');
    });
  });
});
