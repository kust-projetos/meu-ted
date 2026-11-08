/**
 * P3.6 — statement payment keyed idempotency + financial rules (Postgres).
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER + requireTestDatabase (fail-closed
 * marker check before any DDL/DML). Skips cleanly otherwise. Rows are isolated
 * by unique household UUIDs and every row is removed afterwards.
 *
 * Covers the P3.6 acceptance scenarios that need real transactions:
 * 1. total payment: payer debited, card debt reduced, invoice paid;
 * 2. partial payment: exact remaining balance preserved;
 * 3. retry with the SAME key does not debit twice;
 * 4. reconcile re-run after a lost post-commit response replays the payment;
 * 5. same key + different payload conflicts and writes nothing;
 * 6. overpay is rejected with zero changes;
 * 7. an already-paid invoice cannot receive another payment;
 * 8. a credit-card payer is rejected;
 * 9. competence excludes the payment row (purchase counted once).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresReadModelStore } from '../../src/read-models/postgres-store.js';
import { createSqlAnalyticsSource } from '../../src/analytics/source.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[postgres-statement-payment-idempotency] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.',
  );
}

const PG_TEST_TIMEOUT = 120_000;
const itDb = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, PG_TEST_TIMEOUT);
};

const FUTURE_DATE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const WINDOW_FROM = TODAY.slice(0, 7) + '-01';
const WINDOW_TO = FUTURE_DATE;

describeIfDb('P3.6 statement payment keyed idempotency (Postgres)', () => {
  let pool: Pool;
  const households: string[] = [];

  const track = (household: string): string => {
    households.push(household);
    return household;
  };

  const seed = async (household: string) => {
    const cards = createPostgresCardStore(pool);
    const writes = createPostgresWriteStore({ pool });
    const bank = await writes.createAccount(household, {
      name: 'Itaú',
      kind: 'bank',
      initialBalanceCents: 100_000,
    });
    const card = await cards.createCard(household, {
      name: 'Nubank Card',
      creditLimitCents: 500_000,
      closingDay: 15,
      dueDay: 25,
    });
    await cards.createCardPurchase(household, {
      accountId: card.id,
      description: 'compra',
      amountCents: 120_000,
      date: FUTURE_DATE,
    });
    const statement = (await cards.listStatements(household, card.id))[0]!;
    return { cards, writes, bank, card, statement };
  };

  const paymentRows = async (household: string): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM transactions WHERE household_id = $1 AND statement_payment_id IS NOT NULL',
      [household],
    );
    return Number(res.rows[0]!.count);
  };

  const accountBalance = async (household: string, accountId: string): Promise<number> => {
    const res = await pool.query<{ balance_cents: string }>(
      'SELECT balance_cents::text AS balance_cents FROM accounts WHERE household_id = $1 AND id = $2',
      [household, accountId],
    );
    return Number(res.rows[0]!.balance_cents);
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'postgres-statement-payment-idempotency');
    await runMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool.query('DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))', [households]).catch(() => undefined);
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

  itDb('pays the total invoice exactly once and updates bank, card debt and statement', async () => {
    const household = track(randomUUID());
    const { cards, bank, card, statement } = await seed(household);
    const key = `total-${randomUUID()}`;

    const paid = await cards.payStatement(
      household,
      statement.id,
      { amountCents: 120_000, fromAccountId: bank.id },
      { idempotencyKey: key },
    );

    expect(paid.id).toBe(statement.id);
    expect(paid.paidCents).toBe(120_000);
    expect(paid.status).toBe('paid');
    expect(await accountBalance(household, bank.id)).toBe(-20_000);
    expect(await accountBalance(household, card.id)).toBe(0);
    expect(await paymentRows(household)).toBe(1);
  });

  itDb('pays partially and preserves the exact remaining balance', async () => {
    const household = track(randomUUID());
    const { cards, bank, card, statement } = await seed(household);

    const paid = await cards.payStatement(
      household,
      statement.id,
      { amountCents: 30_000, fromAccountId: bank.id },
      { idempotencyKey: `partial-${randomUUID()}` },
    );

    expect(paid.paidCents).toBe(30_000);
    expect(paid.totalCents - paid.paidCents).toBe(90_000);
    expect(paid.status).toBe('partial');
    expect(await accountBalance(household, bank.id)).toBe(70_000);
    expect(await accountBalance(household, card.id)).toBe(90_000);
    expect(await paymentRows(household)).toBe(1);
  });

  itDb('retries with the SAME key without a second debit', async () => {
    const household = track(randomUUID());
    const { cards, bank, statement } = await seed(household);
    const key = `retry-${randomUUID()}`;
    const input = { amountCents: 30_000, fromAccountId: bank.id };

    const first = await cards.payStatement(household, statement.id, input, { idempotencyKey: key });
    const second = await cards.payStatement(household, statement.id, input, { idempotencyKey: key });

    expect(second.id).toBe(first.id);
    expect(second.paidCents).toBe(first.paidCents);
    expect(await paymentRows(household)).toBe(1);
    expect(await accountBalance(household, bank.id)).toBe(70_000);
  });

  itDb('replays a post-commit reconcile re-run instead of paying again', async () => {
    const household = track(randomUUID());
    const { cards, bank, statement } = await seed(household);
    const key = `reconcile-${randomUUID()}`;
    const input = { amountCents: 30_000, fromAccountId: bank.id };

    const first = await cards.payStatement(household, statement.id, input, { idempotencyKey: key });
    // The persisted key already committed; a reconciler re-runs the SAME key.
    const replay = await cards.payStatement(household, statement.id, input, { idempotencyKey: key });

    expect(replay.id).toBe(first.id);
    expect(replay.paidCents).toBe(30_000);
    expect(await paymentRows(household)).toBe(1);
    expect(await accountBalance(household, bank.id)).toBe(70_000);
  });

  itDb('rejects the SAME key with a different payload and writes nothing', async () => {
    const household = track(randomUUID());
    const { cards, bank, statement } = await seed(household);
    const key = `conflict-${randomUUID()}`;

    await cards.payStatement(household, statement.id, { amountCents: 30_000, fromAccountId: bank.id }, { idempotencyKey: key });
    await expect(
      cards.payStatement(household, statement.id, { amountCents: 40_000, fromAccountId: bank.id }, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });

    expect(await paymentRows(household)).toBe(1);
    expect(await accountBalance(household, bank.id)).toBe(70_000);
  });

  itDb('rejects an overpayment with zero changes', async () => {
    const household = track(randomUUID());
    const { cards, bank, card, statement } = await seed(household);

    await expect(
      cards.payStatement(
        household,
        statement.id,
        { amountCents: 130_000, fromAccountId: bank.id },
        { idempotencyKey: `overpay-${randomUUID()}` },
      ),
    ).rejects.toThrow(/restante/);

    expect(await paymentRows(household)).toBe(0);
    expect(await accountBalance(household, bank.id)).toBe(100_000);
    expect(await accountBalance(household, card.id)).toBe(120_000);
  });

  itDb('rejects a second payment on an already-paid invoice', async () => {
    const household = track(randomUUID());
    const { cards, bank, statement } = await seed(household);
    await cards.payStatement(
      household,
      statement.id,
      { amountCents: 120_000, fromAccountId: bank.id },
      { idempotencyKey: `already-paid-first-${randomUUID()}` },
    );

    await expect(
      cards.payStatement(
        household,
        statement.id,
        { amountCents: 1_000, fromAccountId: bank.id },
        { idempotencyKey: `already-paid-second-${randomUUID()}` },
      ),
    ).rejects.toThrow(/já está paga/);
    expect(await paymentRows(household)).toBe(1);
  });

  itDb('rejects a credit-card payer', async () => {
    const household = track(randomUUID());
    const { cards, bank, card, statement } = await seed(household);

    await expect(
      cards.payStatement(
        household,
        statement.id,
        { amountCents: 30_000, fromAccountId: card.id },
        { idempotencyKey: `card-payer-${randomUUID()}` },
      ),
    ).rejects.toThrow(/cartão de crédito/);

    expect(await paymentRows(household)).toBe(0);
    expect(await accountBalance(household, bank.id)).toBe(100_000);
  });

  itDb('keeps competence free of the payment row while liquidity includes it', async () => {
    const household = track(randomUUID());
    const { cards, bank, statement } = await seed(household);
    await cards.payStatement(
      household,
      statement.id,
      { amountCents: 30_000, fromAccountId: bank.id },
      { idempotencyKey: `competence-${randomUUID()}` },
    );

    const readModel = createPostgresReadModelStore({ pool });
    const source = createSqlAnalyticsSource(pool, { stores: { store: readModel, cardStore: cards } });
    const liquidity = await source.sumByKind(household, WINDOW_FROM, WINDOW_TO, { kind: 'household' }, { basis: 'liquidez' });
    const competence = await source.sumByKind(household, WINDOW_FROM, WINDOW_TO, { kind: 'household' }, { basis: 'competencia' });

    expect(liquidity.expense.cents).toBe(150_000);
    expect(competence.expense.cents).toBe(120_000);
    expect(competence.expense.cents).toBe(liquidity.expense.cents - 30_000);
  });
});
