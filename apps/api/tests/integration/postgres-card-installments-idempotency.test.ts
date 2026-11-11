/**
 * P3.5 — card installment purchase (Postgres proofs).
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER + requireTestDatabase (fail-closed
 * marker check before any DDL/DML). Skips cleanly otherwise. Rows are isolated
 * by unique household UUIDs and every row is removed afterwards.
 *
 * Covers the P3.5 acceptance scenarios:
 * 1. one confirmation writes ALL parcels (single transaction), each linked to
 *    its own statement;
 * 2. the card debt grows by the TOTAL (never by total × parcels) and no bank
 *    account is debited;
 * 3. the canonical receipt is bound to the FIRST created transaction;
 * 4. a retry with the SAME key returns the same set without duplicating;
 * 5. a reconcile after a lost post-commit response replays the same set;
 * 6. the same key with different args conflicts and writes nothing;
 * 7. a mid-write failure leaves NO partial parcel;
 * 8. cent distribution follows the single existing rule (10,00 / 3x);
 * 9. calendar edge cases reuse the existing billing-month rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { getApprovalToolContract } from '../../src/approvals/tool-registry.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[postgres-card-installments-idempotency] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.',
  );
}

// Future dates keep the generated statements genuinely OPEN under the real
// clock (statement status is wall-clock relative).
const FUTURE_DATE = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
const futureMonth = (monthsAhead: number): string => {
  const d = new Date(Date.now() + 120 * 86_400_000);
  d.setUTCMonth(d.getUTCMonth() + monthsAhead);
  return d.toISOString().slice(0, 10);
};

// Generous per-test budget: a synthetic Postgres may live behind a tunnel in
// local validation; in CI it is a local container and every case is fast.
describeIfDb('P3.5 card installments (Postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  const households: string[] = [];

  const track = (household: string): string => {
    households.push(household);
    return household;
  };

  const seedCard = async (
    household: string,
    cards: ReturnType<typeof createPostgresCardStore>,
    closingDay = 15,
    dueDay = 25,
  ) => {
    const card = await cards.createCard(household, {
      name: 'Nubank Card',
      creditLimitCents: 5_000_000,
      closingDay,
      dueDay,
    });
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(household, { name: 'Mercado', kind: 'expense' });
    return { card, category, writes };
  };

  const balanceOf = async (accountId: string): Promise<number> => {
    const res = await pool.query<{ balance_cents: string }>(
      'SELECT balance_cents FROM accounts WHERE id = $1',
      [accountId],
    );
    return Number(res.rows[0]!.balance_cents);
  };

  const transactionRows = async (household: string): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM transactions WHERE household_id = $1',
      [household],
    );
    return Number(res.rows[0]!.count);
  };

  const cardPurchaseRows = async (household: string): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM card_purchases WHERE household_id = $1',
      [household],
    );
    return Number(res.rows[0]!.count);
  };

  const idempotencyRows = async (household: string): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM idempotency_keys WHERE household_id = $1',
      [household],
    );
    return Number(res.rows[0]!.count);
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'postgres-card-installments-idempotency');
    await runMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool
        .query('DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))', [households])
        .catch(() => undefined);
      await pool.query('DELETE FROM operation_records WHERE workspace_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM idempotency_keys WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM card_purchases WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM transactions WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM statements WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM categories WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM accounts WHERE household_id = ANY($1)', [households]).catch(() => undefined);
    }
    await pool?.end();
  });

  it('writes 6 parcels of R$ 200, raises the card debt by the TOTAL and never debits the bank', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card, category, writes } = await seedCard(household, cards);
    const bank = await writes.createAccount(household, {
      name: 'Conta corrente',
      kind: 'bank',
      initialBalanceCents: 500_000,
    });

    const executor = getApprovalToolContract('cards.purchase.create')!.executor;
    const result = await executor({
      writes,
      cardStore: cards,
      workspaceId: household,
      args: {
        accountId: card.id,
        amountCents: 120_000,
        description: 'celular',
        date: FUTURE_DATE,
        categoryId: category.id,
        installmentsTotal: 6,
      },
      idempotencyKey: `installments-${randomUUID()}`,
      actorId: 'actor-p35',
    });

    expect(result.status).toBe('succeeded');
    expect(result.receipt.mutationKind).toBe('cards.purchase.create');
    expect(result.receipt.entity?.type).toBe('transaction');

    expect(await transactionRows(household)).toBe(6);
    expect(await cardPurchaseRows(household)).toBe(6);

    const rows = await pool.query<{ id: string; amount_cents: string; installments_total: number; installment_number: number }>(
      `SELECT id, amount_cents, installments_total, installment_number
         FROM transactions WHERE household_id = $1
        ORDER BY installment_number ASC`,
      [household],
    );
    expect(rows.rows.map((r) => Number(r.amount_cents))).toEqual([20_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
    expect(rows.rows.map((r) => r.installments_total)).toEqual([6, 6, 6, 6, 6, 6]);
    expect(rows.rows.map((r) => r.installment_number)).toEqual([1, 2, 3, 4, 5, 6]);

    // The canonical receipt is bound to the FIRST parcel (never the total).
    expect(result.receipt.entity?.id).toBe(rows.rows[0]!.id);
    expect(result.operationId).toBe(rows.rows[0]!.id);

    // Card debt: exactly +120_000 (not 120_000 × 6). Bank untouched.
    expect(await balanceOf(card.id)).toBe(120_000);
    expect(await balanceOf(bank.id)).toBe(500_000);

    // Each parcel is attached to a statement; the six statements sum to the
    // total exactly once.
    const statements = await cards.listStatements(household, card.id);
    expect(statements).toHaveLength(6);
    expect(statements.reduce((sum, s) => sum + s.totalCents, 0)).toBe(120_000);
    expect(statements.every((s) => s.totalCents === 20_000)).toBe(true);

    const detailIds = new Set<string>();
    for (const statement of statements) {
      const detail = await cards.getStatementDetail(household, statement.id);
      expect(detail).not.toBeNull();
      for (const purchase of detail!.purchases) detailIds.add(purchase.id);
    }
    expect([...detailIds].sort()).toEqual(rows.rows.map((r) => r.id).sort());
  });

  it('distributes cents with the single existing rule (R$ 10,00 in 3x → 3,33 + 3,33 + 3,34)', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card } = await seedCard(household, cards);

    await cards.createCardInstallments(household, {
      accountId: card.id,
      description: 'cafe',
      totalAmountCents: 1_000,
      purchaseDate: FUTURE_DATE,
      installmentsTotal: 3,
    });

    const rows = await pool.query<{ amount_cents: string }>(
      `SELECT amount_cents FROM transactions WHERE household_id = $1 ORDER BY installment_number ASC`,
      [household],
    );
    expect(rows.rows.map((r) => Number(r.amount_cents))).toEqual([333, 333, 334]);
    expect(await balanceOf(card.id)).toBe(1_000);
  });

  it('retries with the SAME key without duplicating (and conflicts on different args)', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card } = await seedCard(household, cards);
    const idempotencyKey = `retry-installments-${randomUUID()}`;
    const input = {
      accountId: card.id,
      description: 'celular',
      totalAmountCents: 120_000,
      purchaseDate: FUTURE_DATE,
      installmentsTotal: 6,
    };

    const first = await cards.createCardInstallments(household, input, { idempotencyKey });
    const second = await cards.createCardInstallments(household, input, { idempotencyKey });

    expect(first).toHaveLength(6);
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(await transactionRows(household)).toBe(6);
    expect(await cardPurchaseRows(household)).toBe(6);
    expect(await balanceOf(card.id)).toBe(120_000);

    // Same key + different args: conflict, zero extra rows (never a partial
    // second set).
    await expect(
      cards.createCardInstallments(household, { ...input, installmentsTotal: 3 }, { idempotencyKey }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(await transactionRows(household)).toBe(6);
    expect(await cardPurchaseRows(household)).toBe(6);
    expect(await balanceOf(card.id)).toBe(120_000);
  });

  it('reconciles after a lost post-commit response without duplicating any parcel', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card, writes } = await seedCard(household, cards);
    const idempotencyKey = `reconcile-installments-${randomUUID()}`;
    const args = {
      accountId: card.id,
      amountCents: 120_000,
      description: 'celular',
      date: FUTURE_DATE,
      installmentsTotal: 6,
    };
    const executor = getApprovalToolContract('cards.purchase.create')!.executor;

    const first = await executor({
      writes,
      cardStore: cards,
      workspaceId: household,
      args,
      idempotencyKey,
      actorId: 'actor-p35',
    });
    expect(first.status).toBe('succeeded');

    const reconciled = await executor({
      writes,
      cardStore: cards,
      workspaceId: household,
      args,
      idempotencyKey,
      actorId: 'actor-p35',
    });
    expect(reconciled.status).toBe('succeeded');
    expect(reconciled.operationId).toBe(first.operationId);
    expect(await transactionRows(household)).toBe(6);
    expect(await cardPurchaseRows(household)).toBe(6);
    expect(await balanceOf(card.id)).toBe(120_000);
  });

  it('leaves NO partial parcel when a write fails mid-set (fault injection)', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card } = await seedCard(household, cards);
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const fnName = `p35_fail_third_${suffix}`;
    const triggerName = `p35_fail_third_${suffix}`;

    // Fail the THIRD transaction insert of this household only. The first two
    // inserts are already inside the same open transaction: if the store were
    // not atomic, they would survive as partial parcels.
    await pool.query(`
      CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.household_id = '${household}'
           AND (SELECT COUNT(*) FROM transactions WHERE household_id = NEW.household_id) >= 2 THEN
          RAISE EXCEPTION 'p35 injected failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON transactions
      FOR EACH ROW EXECUTE FUNCTION ${fnName}()`);

    try {
      await expect(
        cards.createCardInstallments(
          household,
          {
            accountId: card.id,
            description: 'celular',
            totalAmountCents: 120_000,
            purchaseDate: FUTURE_DATE,
            installmentsTotal: 6,
          },
          { idempotencyKey: `fault-${randomUUID()}` },
        ),
      ).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON transactions`).catch(() => undefined);
      await pool.query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => undefined);
    }

    expect(await transactionRows(household)).toBe(0);
    expect(await cardPurchaseRows(household)).toBe(0);
    expect(await idempotencyRows(household)).toBe(0);
    expect(await balanceOf(card.id)).toBe(0);
  });

  it('attaches the first parcel to the current cycle on the closing day and to the next cycle the day after', async () => {
    const onClosing = track(randomUUID());
    const cardsA = createPostgresCardStore(pool);
    const a = await seedCard(onClosing, cardsA, 15, 25);
    const closingDayDate = futureMonth(3).slice(0, 7) + '-15';

    const firstA = await cardsA.createCardInstallments(onClosing, {
      accountId: a.card.id,
      description: 'notebook',
      totalAmountCents: 60_000,
      purchaseDate: closingDayDate,
      installmentsTotal: 2,
    });
    expect(firstA).toHaveLength(2);

    const statementsA = await cardsA.listStatements(onClosing, a.card.id);
    const closingA = statementsA.find((s) => s.closingDate === closingDayDate);
    expect(closingA, `purchase on ${closingDayDate} must land in the cycle closing that day`).toBeTruthy();
    expect(closingA!.totalCents).toBe(30_000);

    const afterClosing = track(randomUUID());
    const cardsB = createPostgresCardStore(pool);
    const b = await seedCard(afterClosing, cardsB, 15, 25);
    const dayAfterClosing = futureMonth(3).slice(0, 7) + '-16';
    await cardsB.createCardInstallments(afterClosing, {
      accountId: b.card.id,
      description: 'notebook',
      totalAmountCents: 60_000,
      purchaseDate: dayAfterClosing,
      installmentsTotal: 2,
    });
    const statementsB = await cardsB.listStatements(afterClosing, b.card.id);
    expect(statementsB.some((s) => s.closingDate === closingDayDate)).toBe(false);
    const nextCycleClosing = futureMonth(4).slice(0, 7) + '-15';
    expect(statementsB.find((s) => s.closingDate === nextCycleClosing)).toBeTruthy();
  });

  it('clamps end-of-month parcel dates instead of overflowing (Jan 31 → Feb 28)', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card } = await seedCard(household, cards, 15, 25);

    await cards.createCardInstallments(household, {
      accountId: card.id,
      description: 'curso',
      totalAmountCents: 90_000,
      purchaseDate: '2027-01-31',
      installmentsTotal: 3,
    });

    const rows = await pool.query<{ date: Date }>(
      `SELECT date FROM transactions WHERE household_id = $1 ORDER BY installment_number ASC`,
      [household],
    );
    expect(rows.rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ]);
  });
});
