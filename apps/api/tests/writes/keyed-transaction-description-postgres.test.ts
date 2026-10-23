/**
 * Permanent canonical + legacy PostgreSQL proofs for the internal description
 * writer. This test never provisions or cleans databases; the disposable,
 * marked databases must be prepared by the local fixture launcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import type { WriteStore } from '../../src/writes/store.js';

const CANONICAL_DB = 'ted_category_keyed_validation127';
const LEGACY_DB = 'ted_category_keyed_validation127_legacy';
const DB_URL = process.env.TED_TRANSACTION_DESCRIPTION_PG_URL;
const MARKER = process.env.TED_TRANSACTION_DESCRIPTION_PG_MARKER;
const ENABLED = Boolean(DB_URL && MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

const checkedUrl = (raw: string, expectedDatabase: string): string => {
  if (/[?#]/.test(raw)) throw new Error('query/hash not allowed');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55433' ||
      url.pathname !== `/${expectedDatabase}`) throw new Error('transaction-description PG target rejected');
  return raw;
};

const legacyUrl = (raw: string): string => {
  const url = new URL(checkedUrl(raw, CANONICAL_DB));
  url.pathname = `/${LEGACY_DB}`;
  return url.toString();
};

const LEGACY_SHAPE_DDL = [
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS initial_balance_cents BIGINT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_credit_card BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE accounts ALTER COLUMN kind DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN balance_cents DROP NOT NULL`,
  `ALTER TABLE accounts ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN`,
  `ALTER TABLE categories ALTER COLUMN status DROP NOT NULL`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS from_account_id UUID`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS to_account_id UUID`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_credit_card_purchase BOOLEAN`,
  `ALTER TABLE transactions ALTER COLUMN account_id DROP NOT NULL`,
];

const INSTALL_AUDIT_FAULT = {
  canonical: `
    CREATE OR REPLACE FUNCTION test_reject_description_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.operation = 'transaction.update' AND NEW.metadata->>'idempotencyKey' = 'tx-description-audit-fail' THEN
        RAISE EXCEPTION 'injected description audit failure';
      END IF;
      RETURN NEW;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'test_reject_description_audit_trigger') THEN
        CREATE TRIGGER test_reject_description_audit_trigger BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION test_reject_description_audit();
      END IF;
    END $$;`,
  legacy: `
    CREATE OR REPLACE FUNCTION test_reject_description_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'transaction.update' AND NEW.after_json->>'idempotencyKey' = 'tx-description-audit-fail' THEN
        RAISE EXCEPTION 'injected description audit failure';
      END IF;
      RETURN NEW;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'test_reject_description_audit_trigger') THEN
        CREATE TRIGGER test_reject_description_audit_trigger BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION test_reject_description_audit();
      END IF;
    END $$;`,
};

describeIfDb('internal transaction description writer — PostgreSQL canonical + legacy', () => {
  let canonical: Pool;
  let legacy: Pool;

  beforeAll(async () => {
    const previousMarker = process.env.DB_TEST_MARKER;
    process.env.DB_TEST_MARKER = MARKER!;
    const baseUrl = checkedUrl(DB_URL!, CANONICAL_DB);
    const companion = legacyUrl(baseUrl);
    canonical = createPool({ connectionString: baseUrl, max: 12 }) as unknown as Pool;
    legacy = createPool({ connectionString: companion, max: 12 }) as unknown as Pool;
    await requireTestDatabase(canonical as never, 'tx-description-canonical-preflight');
    await requireTestDatabase(legacy as never, 'tx-description-legacy-preflight');
    for (const [pool, database] of [[canonical, CANONICAL_DB], [legacy, LEGACY_DB]] as const) {
      const proof = await pool.query<{ current_database: string; version: string; marker_value: string }>(
        `SELECT current_database(), version(), (SELECT marker_value FROM _test_marker LIMIT 1) AS marker_value`,
      );
      expect(proof.rows[0]?.current_database).toBe(database);
      expect(proof.rows[0]?.version).toContain('PostgreSQL 15');
      expect(proof.rows[0]?.marker_value).toBe(MARKER);
    }
    await runMigrations(canonical as never);
    await runMigrations(legacy as never);
    for (const statement of LEGACY_SHAPE_DDL) await legacy.query(statement);
    await canonical.query(INSTALL_AUDIT_FAULT.canonical);
    await legacy.query(INSTALL_AUDIT_FAULT.legacy);
    process.env.DB_TEST_MARKER = previousMarker;
  }, 240_000);

  afterAll(async () => {
    await canonical?.end();
    await legacy?.end();
  });

  const contexts = [
    ['canonical', () => canonical, (pool: Pool) => createPostgresWriteStore({ pool })],
    ['legacy', () => legacy, (pool: Pool) => createLegacyPostgresWriteStore({ pool })],
  ] as const;

  const seed = async (pool: Pool, kind: 'expense' | 'income' | 'transfer' = 'expense') => {
    const householdId = randomUUID();
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    const txId = randomUUID();
    if (pool === canonical) {
      await pool.query(`INSERT INTO accounts (id, household_id, name, kind, balance_cents, initial_balance_cents, status)
        VALUES ($1,$2,'description test','bank',10000,10000,'active'),($3,$2,'other','bank',5000,5000,'active')`, [accountId, householdId, otherAccountId]);
      await pool.query(`INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, transfer_to_account_id)
        VALUES ($1,$2,$3,'literal old',1200,'2026-10-20',$4,$5)`,
      [txId, householdId, kind, accountId, kind === 'transfer' ? otherAccountId : null]);
    } else {
      await pool.query(`INSERT INTO accounts (id, household_id, name, kind, balance_cents, initial_balance_cents, status, active, is_credit_card)
        VALUES ($1,$2,'description test',NULL,NULL,10000,NULL,true,false),($3,$2,'other',NULL,NULL,5000,NULL,true,false)`, [accountId, householdId, otherAccountId]);
      await pool.query(`INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, from_account_id, to_account_id, transfer_to_account_id, is_credit_card_purchase)
        VALUES ($1,$2,$3,'literal old',1200,'2026-10-20',$4,$5,$6,$7,false)`,
      [txId, householdId, kind, accountId,
        kind === 'expense' || kind === 'transfer' ? accountId : null,
        kind === 'income' ? accountId : kind === 'transfer' ? otherAccountId : null,
        kind === 'transfer' ? otherAccountId : null]);
    }
    return { householdId, accountId, otherAccountId, txId };
  };

  const auditRows = async (pool: Pool, householdId: string) => pool === canonical
    ? (await pool.query(`SELECT operation, actor_id, effect_ref, metadata FROM audit_logs WHERE workspace_id=$1 AND operation='transaction.update'`, [householdId])).rows
    : (await pool.query(`SELECT action, entity_id, before_json, after_json FROM audit_logs WHERE household_id=$1 AND action='transaction.update'`, [householdId])).rows;

  for (const [label, getPool, makeStore] of contexts) {
    for (const kind of ['expense', 'income'] as const) {
      it(`${label}: ${kind} edit audits one lean event and preserves every other transaction/account field`, async () => {
        const pool = getPool();
        const writes = makeStore(pool);
        const { householdId, accountId, txId } = await seed(pool, kind);
        const beforeAccount = await pool.query(`SELECT * FROM accounts WHERE id=$1 AND household_id=$2`, [accountId, householdId]);
        const before = await pool.query(`SELECT * FROM transactions WHERE id=$1 AND household_id=$2`, [txId, householdId]);
        const key = `desc-${randomUUID()}`;
        const input = { transactionId: txId, expectedDescription: 'literal old', description: '  new description  ' };
        const out = await writes.editTransactionDescription(householdId, input, { idempotencyKey: key, actorId: 'server-actor' });
        expect(out.description).toBe('new description');
        const after = await pool.query(`SELECT * FROM transactions WHERE id=$1 AND household_id=$2`, [txId, householdId]);
        expect(after.rows[0]).toMatchObject({ description: 'new description', account_id: accountId });
        expect(Number(after.rows[0]!.amount_cents)).toBe(1200);
        const afterWithoutDescription = { ...after.rows[0] };
        const beforeWithoutDescription = { ...before.rows[0] };
        delete afterWithoutDescription.description;
        delete beforeWithoutDescription.description;
        delete afterWithoutDescription.updated_at;
        delete beforeWithoutDescription.updated_at;
        expect(afterWithoutDescription).toEqual(beforeWithoutDescription);
        const afterAccount = await pool.query(`SELECT * FROM accounts WHERE id=$1 AND household_id=$2`, [accountId, householdId]);
        expect(afterAccount.rows[0]).toEqual(beforeAccount.rows[0]);
        const audits = await auditRows(pool, householdId);
        expect(audits).toHaveLength(1);
        if (pool === canonical) {
          expect(audits[0]).toMatchObject({ operation: 'transaction.update', actor_id: 'server-actor', effect_ref: txId });
          expect(JSON.stringify(audits[0]!.metadata)).toContain('literal old');
          expect(JSON.stringify(audits[0]!.metadata)).toContain('new description');
          expect(JSON.stringify(audits[0]!.metadata)).toContain(key);
          expect(JSON.stringify(audits[0]!.metadata)).not.toContain('amountCents');
        } else {
          expect(audits[0]).toMatchObject({ action: 'transaction.update', entity_id: txId });
          expect(JSON.stringify(audits[0]!.after_json)).toContain('server-actor');
        }
      });
    }

    it(`${label}: stale CAS and unsupported links reject before key/audit/effect`, async () => {
      const pool = getPool();
      const writes: WriteStore = makeStore(pool);
      const { householdId, accountId, txId } = await seed(pool);
      const key = `desc-stale-${randomUUID()}`;
      await expect(writes.editTransactionDescription(householdId,
        { transactionId: txId, expectedDescription: 'not current', description: 'new' }, { idempotencyKey: key, actorId: 'server-actor' }))
        .rejects.toMatchObject({ code: 'transaction.description_conflict' });
      expect((await pool.query(`SELECT description FROM transactions WHERE id=$1`, [txId])).rows[0]!.description).toBe('literal old');
      expect((await pool.query(`SELECT 1 FROM idempotency_keys WHERE household_id=$1 AND key=$2`, [householdId, `pending-v2:${key}`])).rowCount).toBe(0);
      expect(await auditRows(pool, householdId)).toHaveLength(0);

      await pool.query(`UPDATE transactions SET installments_total=1 WHERE id=$1`, [txId]);
      await expect(writes.editTransactionDescription(householdId,
        { transactionId: txId, expectedDescription: 'literal old', description: 'new' }, { idempotencyKey: `desc-installment-${randomUUID()}`, actorId: 'server-actor' }))
        .rejects.toMatchObject({ code: 'unsupported' });
      expect((await pool.query(`SELECT description FROM transactions WHERE id=$1`, [txId])).rows[0]!.description).toBe('literal old');

      const transfer = await seed(pool, 'transfer');
      await expect(writes.editTransactionDescription(transfer.householdId,
        { transactionId: transfer.txId, expectedDescription: 'literal old', description: 'new' }, { idempotencyKey: `desc-transfer-${randomUUID()}`, actorId: 'server-actor' }))
        .rejects.toMatchObject({ code: 'unsupported' });
      expect(accountId).toBeTruthy();
    });

    it(`${label}: payable/card links reject; replay survives a later tombstone and concurrent same-key requests write/audit once`, async () => {
      const pool = getPool();
      const writes = makeStore(pool);
      const payableTarget = await seed(pool);
      await pool.query(`INSERT INTO accounts_payable (household_id, account_id, description, amount_cents, due_date, status, paid_transaction_id)
        VALUES ($1,$2,'paid link',1200,'2026-10-20','paid',$3)`, [payableTarget.householdId, payableTarget.accountId, payableTarget.txId]);
      await expect(writes.editTransactionDescription(payableTarget.householdId,
        { transactionId: payableTarget.txId, expectedDescription: 'literal old', description: 'new' }, { idempotencyKey: `desc-payable-${randomUUID()}`, actorId: 'server-actor' }))
        .rejects.toMatchObject({ code: 'unsupported' });

      const target = await seed(pool);
      const key = `desc-replay-${randomUUID()}`;
      const input = { transactionId: target.txId, expectedDescription: 'literal old', description: 'new' };
      const results = await Promise.all([
        writes.editTransactionDescription(target.householdId, input, { idempotencyKey: key, actorId: 'server-actor' }),
        writes.editTransactionDescription(target.householdId, input, { idempotencyKey: key, actorId: 'server-actor' }),
      ]);
      expect(results.map((row) => row.description)).toEqual(['new', 'new']);
      await expect(writes.editTransactionDescription(target.householdId,
        { ...input, description: 'different' }, { idempotencyKey: key, actorId: 'server-actor' }))
        .rejects.toMatchObject({ code: 'idempotency.conflict' });
      await pool.query(`UPDATE transactions SET deleted_at=NOW() WHERE id=$1 AND household_id=$2`, [target.txId, target.householdId]);
      expect((await writes.editTransactionDescription(target.householdId, input, { idempotencyKey: key, actorId: 'server-actor' })).description).toBe('new');
      expect(await auditRows(pool, target.householdId)).toHaveLength(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM idempotency_keys WHERE household_id=$1 AND key=$2`, [target.householdId, `pending-v2:${key}`])).rows[0]!.n).toBe(1);
    });

    it(`${label}: card-purchase link and injected audit failure leave no description edit, key, or audit`, async () => {
      const pool = getPool();
      const writes = makeStore(pool);
      const cardTarget = await seed(pool);
      const statementId = randomUUID();
      await pool.query(`INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date)
        VALUES ($1,$2,$3,'2026-10','2026-10-20','2026-10-25')`, [statementId, cardTarget.householdId, cardTarget.accountId]);
      await pool.query(`INSERT INTO card_purchases (id, household_id, account_id, statement_id, description, amount_cents, date, transaction_id)
        VALUES ($1,NULL,$2,$3,'card link',1200,'2026-10-20',$4)`, [randomUUID(), cardTarget.accountId, statementId, cardTarget.txId]);
      await expect(writes.editTransactionDescription(cardTarget.householdId,
        { transactionId: cardTarget.txId, expectedDescription: 'literal old', description: 'new' }, { idempotencyKey: `desc-card-${randomUUID()}`, actorId: 'server-actor' }))
        .rejects.toMatchObject({ code: 'unsupported' });

      const failureTarget = await seed(pool);
      await expect(writes.editTransactionDescription(failureTarget.householdId,
        { transactionId: failureTarget.txId, expectedDescription: 'literal old', description: 'new' },
        { idempotencyKey: 'tx-description-audit-fail', actorId: 'server-actor' })).rejects.toThrow('injected description audit failure');
      expect((await pool.query(`SELECT description FROM transactions WHERE id=$1`, [failureTarget.txId])).rows[0]!.description).toBe('literal old');
      expect((await pool.query(`SELECT 1 FROM idempotency_keys WHERE household_id=$1 AND key='pending-v2:tx-description-audit-fail'`, [failureTarget.householdId])).rowCount).toBe(0);
      expect(await auditRows(pool, failureTarget.householdId)).toHaveLength(0);
    });
  }
});
