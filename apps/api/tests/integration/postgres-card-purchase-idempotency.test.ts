/**
 * P3.4 — card purchase keyed idempotency (Postgres proofs).
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER + requireTestDatabase (fail-closed
 * marker check before any DDL/DML). Skips cleanly otherwise. Rows are isolated
 * by unique household UUIDs and every row is removed afterwards.
 *
 * Covers the four P3.4 acceptance scenarios:
 * 1. a single purchase creates exactly ONE transaction;
 * 2. a retry with the SAME Idempotency-Key does not duplicate it;
 * 3. a reconcile re-run after a lost post-commit response (the key was already
 *    committed) replays the original purchase instead of writing a second one;
 * 4. the purchase is linked to the CORRECT card statement (total + detail).
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
    '[postgres-card-purchase-idempotency] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.',
  );
}

// A future purchase date keeps the attaching statement genuinely OPEN under
// the real clock (statement status is wall-clock relative).
const FUTURE_DATE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

describeIfDb('P3.4 card purchase keyed idempotency (Postgres)', () => {
  let pool: Pool;
  const households: string[] = [];

  const track = (household: string): string => {
    households.push(household);
    return household;
  };

  const seedCard = async (household: string, cards: ReturnType<typeof createPostgresCardStore>) => {
    const card = await cards.createCard(household, {
      name: 'Nubank Card',
      creditLimitCents: 500_000,
      closingDay: 15,
      dueDay: 25,
    });
    const writes = createPostgresWriteStore({ pool });
    const category = await writes.createCategory(household, { name: 'Mercado', kind: 'expense' });
    return { card, category };
  };

  const cardPurchaseRows = async (household: string): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM card_purchases WHERE household_id = $1',
      [household],
    );
    return Number(res.rows[0]!.count);
  };

  const transactionRows = async (household: string): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM transactions WHERE household_id = $1',
      [household],
    );
    return Number(res.rows[0]!.count);
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'postgres-card-purchase-idempotency');
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

  it('creates exactly one purchase and links it to the correct card statement', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card, category } = await seedCard(household, cards);

    const created = await cards.createCardPurchase(
      household,
      {
        accountId: card.id,
        description: 'supermercado',
        amountCents: 15000,
        date: FUTURE_DATE,
        categoryId: category.id,
      },
      { idempotencyKey: `single-${randomUUID()}` },
    );

    expect(created).toHaveLength(1);
    const tx = created[0]!;
    expect(tx.kind).toBe('expense');
    expect(tx.amountCents).toBe(15000);
    expect(tx.description).toBe('supermercado');
    expect(await transactionRows(household)).toBe(1);
    expect(await cardPurchaseRows(household)).toBe(1);

    const statements = await cards.listStatements(household, card.id);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.totalCents).toBe(15000);
    const detail = await cards.getStatementDetail(household, statements[0]!.id);
    expect(detail).not.toBeNull();
    expect(detail!.purchases.map((p) => p.id)).toContain(tx.id);
  });

  it('retries with the SAME key without duplicating the purchase', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const { card, category } = await seedCard(household, cards);
    const idempotencyKey = `retry-${randomUUID()}`;
    const purchase = {
      accountId: card.id,
      description: 'supermercado',
      amountCents: 15000,
      date: FUTURE_DATE,
      categoryId: category.id,
    };

    const first = await cards.createCardPurchase(household, purchase, { idempotencyKey });
    const second = await cards.createCardPurchase(household, purchase, { idempotencyKey });

    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(await transactionRows(household)).toBe(1);
    expect(await cardPurchaseRows(household)).toBe(1);

    // A different payload under the same key fails closed — it never writes.
    await expect(
      cards.createCardPurchase(household, { ...purchase, amountCents: 9900 }, { idempotencyKey }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(await transactionRows(household)).toBe(1);
  });

  it('reconciles after a lost post-commit response without duplicating', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const writes = createPostgresWriteStore({ pool });
    const { card, category } = await seedCard(household, cards);
    const idempotencyKey = `reconcile-${randomUUID()}`;
    const args = {
      accountId: card.id,
      description: 'supermercado',
      amountCents: 15000,
      date: FUTURE_DATE,
      categoryId: category.id,
    };
    const executor = getApprovalToolContract('cards.purchase.create')!.executor;

    // First execution commits the purchase; the caller then LOSES the
    // response (the pending operation stays uncertain and a reconcile re-runs
    // the SAME idempotency key).
    const first = await executor({
      writes,
      cardStore: cards,
      workspaceId: household,
      args,
      idempotencyKey,
      actorId: 'actor-p34',
    });
    expect(first.status).toBe('succeeded');
    expect(await transactionRows(household)).toBe(1);

    const reconciled = await executor({
      writes,
      cardStore: cards,
      workspaceId: household,
      args,
      idempotencyKey,
      actorId: 'actor-p34',
    });
    expect(reconciled.status).toBe('succeeded');
    expect(reconciled.operationId).toBe(first.operationId);
    expect(await transactionRows(household)).toBe(1);
    expect(await cardPurchaseRows(household)).toBe(1);
  });
});
