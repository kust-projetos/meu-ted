/**
 * V4.1 Phase 3 (UOW2) — Postgres proofs for domain keyed mutations.
 *
 * Gate: DATABASE_URL_TEST + DB_TEST_MARKER + requireTestDatabase (fail-closed
 * marker check before any DDL/DML), same pattern as
 * tests/writes/keyed-mutations-postgres.test.ts. Skips cleanly otherwise.
 * Rows isolated by unique household UUIDs; every row cleaned up.
 *
 * - Race (payables pay, goals contribute, cards purchase): N concurrent
 *   same-key claims through the Postgres idempotency store + the domain
 *   `runXMutation` dispatcher commit exactly 1 effect — claim + effect +
 *   completion on the SAME claim client.
 * - Failure injection (payables pay): a crash AFTER the financial write but
 *   BEFORE completion rolls everything back (single tx); the same-key retry
 *   converges to exactly 1 effect instead of duplicating it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore, createPostgresIdempotencyStore } from '../../src/writes/postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';
import { runPayableMutation } from '../../src/payables/keyed-mutations.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';
import { runGoalMutation } from '../../src/goals/keyed-mutations.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { runCardMutation } from '../../src/cards/keyed-mutations.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[domain-keyed-mutations-postgres] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — Postgres proofs skipped.',
  );
}

describeIfDb('V4.1 Phase 3 (UOW2) — Postgres single-tx domain mutations', () => {
  let pool: Pool;
  const households: string[] = [];
  const track = (h: string): string => {
    households.push(h);
    return h;
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'domain-keyed-mutations-postgres');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool.query(
        'DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))',
        [households],
      ).catch(() => undefined);
      await pool.query('DELETE FROM operation_records WHERE workspace_id = ANY($1)', [households]);
      await pool.query('DELETE FROM idempotency_keys WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM card_purchases WHERE household_id = ANY($1)', [households]);
      // FK-safe order: payables reference payment transactions
      // (paid_transaction_id), transactions reference statements, and
      // statements reference accounts.
      await pool.query('DELETE FROM accounts_payable WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM transactions WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM recurring_purchases WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM statements WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM payable_templates WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = ANY($1))', [households]);
      await pool.query('DELETE FROM goals WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM categories WHERE household_id = ANY($1)', [households]);
      await pool.query('DELETE FROM accounts WHERE household_id = ANY($1)', [households]);
    }
    await pool?.end();
  });

  const seedBankAndCategory = async (household: string) => {
    const writes = createPostgresWriteStore({ pool });
    const acc = await writes.createAccount(household, { name: 'PG Bank', kind: 'bank', initialBalanceCents: 500_000 });
    const cat = await writes.createCategory(household, { name: 'PG Food', kind: 'expense' });
    return { acc, cat };
  };

  it('payables pay: N concurrent same-key claims commit exactly 1 payment', async () => {
    const household = track(randomUUID());
    const { acc } = await seedBankAndCategory(household);
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'PG energy', amountCents: 2500, dueDate: '2026-08-10',
    });
    const payload = {};

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        idempotency.lookupOrRecord(household, 'pg-pay-race-same', payload, (claimTx) =>
          runPayableMutation(payables, claimTx, household, 'pay', { id: payable.id, input: {} }),
        ),
      ),
    );
    const paidIds = new Set(results.map((r) => (r.response as { paidTransactionId?: string }).paidTransactionId));
    expect(paidIds.size).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBeGreaterThanOrEqual(1);
    const txCount = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(txCount.rows[0]!.n).toBe(1);
    const status = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(status.rows[0]!.status).toBe('paid');
  }, 60_000);

  it('goals contribute: N concurrent same-key claims sum exactly once', async () => {
    const household = track(randomUUID());
    const goals = createPostgresGoalStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const goal = await goals.createGoal(household, {
      name: 'PG trip', goalType: 'savings', targetAmountCents: 100_000, startDate: '2026-01-01',
    });
    const payload = { id: goal.id, amountCents: 1000 };

    await Promise.all(
      Array.from({ length: 6 }, () =>
        idempotency.lookupOrRecord(household, 'pg-goal-race-same', payload, (claimTx) =>
          runGoalMutation(goals, claimTx, household, 'contribute', { id: goal.id, input: { amountCents: 1000 } }),
        ),
      ),
    );
    const current = await pool.query('SELECT current_amount_cents FROM goals WHERE id = $1', [goal.id]);
    expect(Number(current.rows[0]!.current_amount_cents)).toBe(1000);
    const contribs = await pool.query('SELECT COUNT(*)::int AS n FROM goal_contributions WHERE goal_id = $1', [goal.id]);
    expect(contribs.rows[0]!.n).toBe(1);
  }, 60_000);

  it('cards purchase: N concurrent same-key claims commit exactly 1 purchase', async () => {
    const household = track(randomUUID());
    const { cat } = await seedBankAndCategory(household);
    const cards = createPostgresCardStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const card = await cards.createCard(household, {
      name: 'PG Visa', creditLimitCents: 200_000, closingDay: 10, dueDay: 20,
    });
    const payload = { accountId: card.id, description: 'PG shop', amountCents: 1500, date: '2026-06-10', categoryId: cat.id };

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        idempotency.lookupOrRecord(household, 'pg-card-race-same', payload, (claimTx) =>
          runCardMutation(cards, claimTx, household, 'purchase', payload),
        ),
      ),
    );
    // runCardMutation 'purchase' resolves the raw Transaction[] (the route
    // wraps it into `{ items }`); all racers must see the same single tx.
    const ids = new Set(results.map((r) => ((r.response as unknown as { id: string }[])[0]!).id));
    expect(ids.size).toBe(1);
    const txCount = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(txCount.rows[0]!.n).toBe(1);
    const linkCount = await pool.query('SELECT COUNT(*)::int AS n FROM card_purchases WHERE household_id = $1', [household]);
    expect(linkCount.rows[0]!.n).toBe(1);
  }, 60_000);

  it('failure injection: crash after the pay effect rolls back; same-key retry converges to 1 effect', async () => {
    const household = track(randomUUID());
    const { acc } = await seedBankAndCategory(household);
    const payables = createPostgresPayableStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payable = await payables.createPayable(household, {
      accountId: acc.id, description: 'PG crash pay', amountCents: 1200, dueDate: '2026-08-10',
    });

    let attempts = 0;
    const crashingProducer = async (claimTx: unknown) => {
      attempts += 1;
      const paid = await runPayableMutation(payables, claimTx, household, 'pay', { id: payable.id, input: {} });
      if (attempts === 1) {
        // Simulate a crash AFTER the financial write but BEFORE completion:
        // a deliberate constraint violation aborts the whole claim tx.
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO transactions (id) VALUES (NULL)',
        );
      }
      return paid;
    };
    await expect(idempotency.lookupOrRecord(household, 'pg-pay-crash-1', {}, crashingProducer)).rejects.toThrow();

    // Single-tx proof: the rolled-back attempt left NO orphan behind.
    const orphaned = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(orphaned.rows[0]!.n).toBe(0);
    const status = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(status.rows[0]!.status).toBe('pending');

    const retry = await idempotency.lookupOrRecord(household, 'pg-pay-crash-1', {}, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'pay', { id: payable.id, input: {} }),
    );
    expect(retry.replayed).toBe(false);
    const final = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(final.rows[0]!.n).toBe(1);

    const replay = await idempotency.lookupOrRecord(household, 'pg-pay-crash-1', {}, (claimTx) =>
      runPayableMutation(payables, claimTx, household, 'pay', { id: payable.id, input: {} }),
    );
    expect(replay.replayed).toBe(true);
    expect((replay.response as { id: string }).id).toBe((retry.response as { id: string }).id);
  }, 60_000);

  it('cards createCard: crash after the effect rolls back; retry converges to 1 card', async () => {
    const household = track(randomUUID());
    const cards = createPostgresCardStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const payload = { name: 'PG Visa', creditLimitCents: 200_000, closingDay: 10, dueDay: 20 };

    let attempts = 0;
    const crashingProducer = async (claimTx: unknown) => {
      attempts += 1;
      const card = await runCardMutation(cards, claimTx, household, 'createCard', payload);
      if (attempts === 1) {
        // Simulate a crash AFTER the financial write but BEFORE completion:
        // a deliberate constraint violation aborts the whole claim tx.
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO transactions (id) VALUES (NULL)',
        );
      }
      return card;
    };
    await expect(idempotency.lookupOrRecord(household, 'pg-card-create-crash-1', payload, crashingProducer)).rejects.toThrow();

    // Single-tx proof: the rolled-back attempt left NO orphan behind.
    const orphaned = await pool.query('SELECT COUNT(*)::int AS n FROM accounts WHERE household_id = $1', [household]);
    expect(orphaned.rows[0]!.n).toBe(0);

    const retry = await idempotency.lookupOrRecord(household, 'pg-card-create-crash-1', payload, (claimTx) =>
      runCardMutation(cards, claimTx, household, 'createCard', payload),
    );
    expect(retry.replayed).toBe(false);
    const final = await pool.query('SELECT COUNT(*)::int AS n FROM accounts WHERE household_id = $1', [household]);
    expect(final.rows[0]!.n).toBe(1);

    const replay = await idempotency.lookupOrRecord(household, 'pg-card-create-crash-1', payload, (claimTx) =>
      runCardMutation(cards, claimTx, household, 'createCard', payload),
    );
    expect(replay.replayed).toBe(true);
    expect((replay.response as { id: string }).id).toBe((retry.response as { id: string }).id);
  }, 60_000);

  it('cards updatePurchase: crash after the effect rolls back; retry converges + replay', async () => {
    const household = track(randomUUID());
    const { cat } = await seedBankAndCategory(household);
    const cards = createPostgresCardStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const card = await cards.createCard(household, {
      name: 'PG Visa', creditLimitCents: 200_000, closingDay: 10, dueDay: 20,
    });
    // Future date keeps the attaching statement genuinely 'open' under the
    // real clock (an overdue statement would reject the PATCH).
    const openDate = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    const txs = await cards.createCardPurchase(household, {
      accountId: card.id, description: 'PG shop', amountCents: 1500, date: openDate, categoryId: cat.id,
    });
    const purchaseId = txs[0]!.id;
    const patch = { description: 'PG fair' };

    let attempts = 0;
    const crashingProducer = async (claimTx: unknown) => {
      attempts += 1;
      const detail = await runCardMutation(cards, claimTx, household, 'updatePurchase', { purchaseId, patch });
      // The InTx detail reflects the uncommitted change on the same client.
      expect(detail.purchases.map((p) => p.description)).toContain('PG fair');
      if (attempts === 1) {
        // Simulate a crash AFTER the effect but BEFORE completion:
        // a deliberate constraint violation aborts the whole claim tx.
        await (claimTx as { query: (t: string) => Promise<unknown> }).query(
          'INSERT INTO transactions (id) VALUES (NULL)',
        );
      }
      return detail;
    };
    await expect(idempotency.lookupOrRecord(household, 'pg-card-patch-crash-1', { id: purchaseId, ...patch }, crashingProducer)).rejects.toThrow();

    // Single-tx proof: the rolled-back attempt left the ledger untouched.
    const orphaned = await pool.query('SELECT description FROM transactions WHERE id = $1', [purchaseId]);
    expect(orphaned.rows[0]!.description).toBe('PG shop');

    const retry = await idempotency.lookupOrRecord(household, 'pg-card-patch-crash-1', { id: purchaseId, ...patch }, (claimTx) =>
      runCardMutation(cards, claimTx, household, 'updatePurchase', { purchaseId, patch }),
    );
    expect(retry.replayed).toBe(false);
    expect((retry.response as { purchases: { description: string }[] }).purchases.map((p) => p.description)).toContain('PG fair');
    const final = await pool.query('SELECT description FROM transactions WHERE id = $1', [purchaseId]);
    expect(final.rows[0]!.description).toBe('PG fair');

    const replay = await idempotency.lookupOrRecord(household, 'pg-card-patch-crash-1', { id: purchaseId, ...patch }, (claimTx) =>
      runCardMutation(cards, claimTx, household, 'updatePurchase', { purchaseId, patch }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(retry.response);
  }, 60_000);

  it('Phase 4 fail-closed: real PG claim client + store without InTx → invariant error, zero effects', async () => {
    const household = track(randomUUID());
    const { acc } = await seedBankAndCategory(household);
    const full = createPostgresPayableStore(pool);
    const payable = await full.createPayable(household, {
      accountId: acc.id, description: 'PG fail-closed', amountCents: 900, dueDate: '2026-08-10',
    });
    // Strip the client-bound extension the way a store without atomic
    // support would look — the dispatcher must throw, never fall back.
    const { markPayablePaidInTx: _dropped, ...stripped } = full as unknown as Record<string, unknown>;
    expect(_dropped).toBeTypeOf('function');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        runPayableMutation(stripped as never, client, household, 'pay', { id: payable.id, input: {} }),
      ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const status = await pool.query('SELECT status FROM accounts_payable WHERE id = $1', [payable.id]);
    expect(status.rows[0]!.status).toBe('pending');
    const txCount = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(txCount.rows[0]!.n).toBe(0);
  }, 60_000);
});
