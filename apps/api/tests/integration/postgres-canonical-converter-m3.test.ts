/**
 * M3 canonical converter proof (V058 anchor + balances step).
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Uses a dedicated throwaway
 * DATABASE per run (same pattern as the M1/M2 suites): fresh canonical
 * migrations (V001–V058) are applied, so this suite also proves V058 lands
 * the anchor column on a clean ledger. The database is dropped in afterAll.
 *
 * - V058: anchor column exists (NOT NULL, DEFAULT 0), canonical manifest
 *   carries V058 while the legacy manifest stops before it (justified), and
 *   `verifySchema` passes on the fresh canonical ledger.
 * - Green flow: archive anchors (0 and nonzero) + income/expense/transfer +
 *   circular transfer + statement-linked purchase expense ->
 *   `runBalancesStep` backfills, computes and persists; the canonical
 *   reconciliation `accounts_balance` query agrees row by row and the full
 *   report is drift-free.
 * - Drift flow: a tampered stored balance is reported as `balance_drift`
 *   with the recomputed expectation.
 * - Fail-closed flow: a credit_card driven negative refuses BEFORE any
 *   write (stored balances untouched); a negative bank result persists and
 *   reconciles (ADR-018).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { expectedMigrationManifest, runMigrations } from '../../src/read-models/sql/migrate.js';
import { LEGACY_EXCLUDED_JUSTIFICATIONS } from '../../src/read-models/sql/migrate.js';
import { verifySchema } from '../../src/server/schema-verifier.js';
import { BalanceError, runBalancesStep } from '../../src/scripts/canonical-converter/balances.js';
import {
  buildReconciliationQueries,
} from '../../src/scripts/reconciliation/sql.js';
import { runReconciliation } from '../../src/scripts/reconciliation/run.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[postgres-canonical-converter-m3] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

const DB_NAME = `pi_converter_m3_${process.pid}`;

let adminPool: Pool | undefined;
let db: Pool | undefined;

const seedHousehold = async (householdId: string): Promise<void> => {
  const ownerId = randomUUID();
  await db!.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'M3 Owner', 'active')`, [
    ownerId,
    `m3-${householdId}@example.test`,
  ]);
  await db!.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, 'M3 H', 'shared', $2)`, [
    householdId,
    ownerId,
  ]);
};

const seedAccount = async (
  householdId: string,
  name: string,
  kind: string,
  archiveInitial: number,
): Promise<string> => {
  const id = randomUUID();
  await db!.query(
    `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status)
     VALUES ($1, $2, $3, $4, 0, 'active')`,
    [id, householdId, name, kind],
  );
  await db!.query(
    `INSERT INTO legacy_archive.accounts (id, household_id, initial_balance_cents) VALUES ($1, $2, $3)`,
    [id, householdId, archiveInitial],
  );
  return id;
};

const seedTx = async (
  householdId: string,
  kind: string,
  accountId: string,
  amount: number,
  extra: { to?: string; statementId?: string } = {},
): Promise<void> => {
  await db!.query(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, transfer_to_account_id, statement_id)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, $8)`,
    [randomUUID(), householdId, kind, `M3 ${kind}`, amount, accountId, extra.to ?? null, extra.statementId ?? null],
  );
};

describeIfDb('Postgres canonical converter M3 (anchor + balances step)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    await adminPool.query(`CREATE DATABASE "${DB_NAME}"`);
    const url = new URL(DB_URL!);
    url.pathname = `/${DB_NAME}`;
    db = createPool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 60_000 });
    let connected = false;
    for (let attempt = 0; attempt < 12 && !connected; attempt++) {
      try {
        await db.query('SELECT 1');
        connected = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    if (!connected) throw new Error('dedicated converter database never accepted connections');
    await db.query(`CREATE TABLE _test_marker (marker_value TEXT NOT NULL)`);
    await db.query(`INSERT INTO _test_marker (marker_value) VALUES ($1)`, [process.env.DB_TEST_MARKER!]);
    await requireTestDatabase(db, 'converter-m3-fixture');
    await runMigrations(db);
    await db.query(`CREATE SCHEMA IF NOT EXISTS legacy_archive`);
    await db.query(
      `CREATE TABLE legacy_archive.accounts (id UUID PRIMARY KEY, household_id UUID NOT NULL, initial_balance_cents BIGINT NOT NULL DEFAULT 0)`,
    );
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await adminPool?.end();
  });

  it('V058 lands the anchor on a fresh canonical ledger and gates the manifests', async () => {
    const col = await db!.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'initial_balance_cents'`,
    );
    expect(col.rowCount).toBe(1);
    expect(col.rows[0]!['is_nullable']).toBe('NO');
    expect(String(col.rows[0]!['column_default'])).toMatch(/0/);
    expect(expectedMigrationManifest(false).map((m) => m.version)).toContain(58);
    expect(expectedMigrationManifest(true).map((m) => m.version)).not.toContain(58);
    expect(LEGACY_EXCLUDED_JUSTIFICATIONS['V058']?.trim().length).toBeGreaterThan(0);
    expect(await verifySchema(db!, false)).toBe(true);
  }, 60_000);

  it('recomputes anchored balances and agrees with the canonical reconciliation', async () => {
    const householdId = randomUUID();
    await seedHousehold(householdId);
    const bank = await seedAccount(householdId, 'Checking', 'bank', 5000);
    const cash = await seedAccount(householdId, 'Wallet', 'cash', 0);
    const card = await seedAccount(householdId, 'Card', 'credit_card', 0);
    await db!.query(
      `UPDATE accounts SET credit_limit_cents = 100000, closing_day = 10, due_day = 20 WHERE id = $1`,
      [card],
    );
    const stmt = randomUUID();
    await db!.query(
      `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status)
       VALUES ($1, $2, $3, '2026-09', '2026-09-10', '2026-09-20', 400, 0, 'open')`,
      [stmt, householdId, card],
    );
    await seedTx(householdId, 'income', bank, 1000);
    await seedTx(householdId, 'expense', bank, 200);
    await seedTx(householdId, 'transfer', bank, 150, { to: cash });
    await seedTx(householdId, 'transfer', cash, 50, { to: bank });
    await seedTx(householdId, 'expense', card, 400, { statementId: stmt });

    const result = await runBalancesStep(db!, { householdId });
    expect(result.households).toEqual([householdId]);
    expect(result.backfilled).toMatchObject({ updated: 3, canonicalCount: 3 });
    // bank: 5000 + 1000 − 200 − 150 + 50 = 5700; cash: 0 + 150 − 50 = 100;
    // card (slice-2 debt): 0 + 400 (linked purchase) − 0 (paid) = 400.
    // FINDING-2: computations are bigint-exact (pg BIGINT arrives as string).
    expect(result.applied.find((r) => r.accountId === bank)).toMatchObject({ computed: 5700n, initial: 5000n });
    expect(result.applied.find((r) => r.accountId === cash)).toMatchObject({ computed: 100n, initial: 0n });
    expect(result.applied.find((r) => r.accountId === card)).toMatchObject({
      computed: 400n,
      cardPurchases: 400n,
      cardPaid: 0n,
    });

    const stored = await db!.query(
      `SELECT id, balance_cents, initial_balance_cents FROM accounts WHERE household_id = $1`,
      [householdId],
    );
    expect(new Map(stored.rows.map((r) => [String(r['id']), Number(r['balance_cents'])]))).toEqual(
      new Map([[bank, 5700], [cash, 100], [card, 400]]),
    );

    // The reconciliation query on the same fixture agrees row by row…
    const query = buildReconciliationQueries('canonical', { householdId }).accounts_balance;
    const rows = (await db!.query(query.text, query.values)).rows;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const derived = String(row['account_kind']) === 'credit_card'
        ? Number(row['initial_cents']) + Number(row['card_purchase_cents']) - Number(row['card_paid_cents'])
        : Number(row['initial_cents']) +
          Number(row['income_cents']) -
          Number(row['expense_cents']) -
          Number(row['transfer_out_cents']) +
          Number(row['transfer_in_cents']);
      expect(Number(row['stored_cents'])).toBe(derived);
    }
    // …and the full report is drift-free.
    const report = await runReconciliation(db!, 'canonical', householdId);
    const balances = report.checks.find((c) => c.check === 'accounts_balance')!;
    expect(balances.counts).toEqual({ checked: 3, drifted: 0 });
  }, 60_000);

  it('reports a tampered stored balance as balance_drift with the recomputed expectation', async () => {
    const householdId = randomUUID();
    await seedHousehold(householdId);
    const bank = await seedAccount(householdId, 'Checking', 'bank', 1000);
    await seedTx(householdId, 'income', bank, 500);
    const result = await runBalancesStep(db!, { householdId });
    expect(result.applied.find((r) => r.accountId === bank)).toMatchObject({ computed: 1500n });
    await db!.query(`UPDATE accounts SET balance_cents = 1501 WHERE id = $1`, [bank]);
    const report = await runReconciliation(db!, 'canonical', householdId);
    const balances = report.checks.find((c) => c.check === 'accounts_balance')!;
    expect(balances.counts.drifted).toBe(1);
    expect(balances.findings[0]).toMatchObject({ kind: 'balance_drift', expected: 1500, actual: 1501 });
  }, 60_000);

  it('fails closed on a negative credit_card result and persists a negative bank result', async () => {
    const householdId = randomUUID();
    await seedHousehold(householdId);
    const card = await seedAccount(householdId, 'Card', 'credit_card', 100);
    const bank = await seedAccount(householdId, 'Checking', 'bank', 100);
    // Slice 2: a plain (unlinked) expense on a card is an orphan under the
    // debt model — still fail-closed BEFORE any write, like the old
    // negative-derivation refusal.
    await seedTx(householdId, 'expense', card, 250);
    await seedTx(householdId, 'expense', bank, 250);
    await expect(runBalancesStep(db!, { householdId })).rejects.toThrow(BalanceError);
    // Nothing was written: both accounts keep the pre-step zero.
    const stored = await db!.query(`SELECT id, balance_cents FROM accounts WHERE household_id = $1`, [householdId]);
    for (const row of stored.rows) expect(Number(row['balance_cents'])).toBe(0);

    await db!.query(`DELETE FROM transactions WHERE household_id = $1 AND account_id = $2`, [householdId, card]);
    const retry = await runBalancesStep(db!, { householdId });
    expect(retry.applied.find((r) => r.accountId === bank)).toMatchObject({ computed: -150n });
    const report = await runReconciliation(db!, 'canonical', householdId);
    // Card (0, anchored, no movements) is clean; bank −150 matches its derivation.
    expect(report.checks.find((c) => c.check === 'accounts_balance')!.counts.drifted).toBe(0);
  }, 60_000);

  it('FINDING-1: backfills statement_id from card_purchases.transaction_id before recomputing', async () => {
    // Legacy shape (V032/V033): the purchase link lives in
    // card_purchases.transaction_id while the transaction row carries no
    // statement_id. Without the pre-balances resolution the purchase
    // would hit the debt computation as an UNLINKED card expense and fail
    // closed as an orphan. With it, the purchase links and adds to debt
    // exactly like the write path adds it.
    const householdId = randomUUID();
    await seedHousehold(householdId);
    const card = await seedAccount(householdId, 'Card', 'credit_card', 0);
    const stmt = randomUUID();
    await db!.query(
      `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status)
       VALUES ($1, $2, $3, '2026-09', '2026-09-10', '2026-09-20', 400, 0, 'open')`,
      [stmt, householdId, card],
    );
    const txId = randomUUID();
    await db!.query(
      `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, account_id, statement_id)
       VALUES ($1, $2, 'expense', 'Shop', 400, CURRENT_DATE, $3, NULL)`,
      [txId, householdId, card],
    );
    await db!.query(
      `INSERT INTO card_purchases (id, household_id, account_id, statement_id, description, amount_cents, date, transaction_id)
       VALUES ($1, $2, $3, $4, 'Shop', 400, CURRENT_DATE, $5)`,
      [randomUUID(), householdId, card, stmt, txId],
    );
    await db!.query(
      `CREATE TABLE IF NOT EXISTS legacy_archive.card_purchases (transaction_id UUID, statement_id UUID, household_id UUID)`,
    );
    await db!.query(
      `CREATE TABLE IF NOT EXISTS legacy_archive.transactions (id UUID PRIMARY KEY, household_id UUID, is_credit_card_purchase BOOLEAN, deleted_at TIMESTAMPTZ)`,
    );
    await db!.query(
      `CREATE TABLE IF NOT EXISTS legacy_archive.statements (id UUID PRIMARY KEY, household_id UUID)`,
    );
    await db!.query(`INSERT INTO legacy_archive.transactions (id, household_id, is_credit_card_purchase) VALUES ($1, $2, true)`, [
      txId,
      householdId,
    ]);
    await db!.query(`INSERT INTO legacy_archive.card_purchases (transaction_id, statement_id, household_id) VALUES ($1, $2, $3)`, [
      txId,
      stmt,
      householdId,
    ]);
    await db!.query(`INSERT INTO legacy_archive.statements (id, household_id) VALUES ($1, $2)`, [stmt, householdId]);

    const result = await runBalancesStep(db!, { householdId });
    // The purchase is statement-linked like the write path: it adds to the
    // card debt (statement paid 0, so debt = 400).
    expect(result.applied.find((r) => r.accountId === card)).toMatchObject({
      computed: 400n,
      cardPurchases: 400n,
      cardPaid: 0n,
    });
    const tx = await db!.query(`SELECT statement_id FROM transactions WHERE id = $1`, [txId]);
    expect(String(tx.rows[0]!.statement_id)).toBe(stmt);
  }, 60_000);
});
