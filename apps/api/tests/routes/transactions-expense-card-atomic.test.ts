/**
 * alt-card-expense-atomic — POST /transactions/expense with cardId joins the
 * open idempotency claim tx (P1 crash gap).
 *
 * Before: the route called `cardStore.createCardPurchase(...)` ignoring
 * `claimTx` — the purchase committed on its own boundary while the claim
 * committed separately (crash gap). After: the route threads `claimTx`
 * through `runCardMutation('purchase')`; a PG store without
 * `createCardPurchaseInTx` fails closed with
 * `idempotency.atomic_mutation_not_supported`.
 *
 * - Unit dispatch (no DB): claimTx → InTx, no claimTx → plain, claimTx +
 *   no InTx → invariant error with zero plain calls.
 * - Route (no DB): Fastify + registerTransactionWriteRoutes with a stub
 *   idempotency store that forwards an open claimTx; asserts the card effect
 *   runs on that client, receipt shape is unchanged (single tx +
 *   transaction.create), and the household is forwarded (cross-household
 *   card → 404, no leak).
 * - Postgres proofs (canonical + legacy, gated): crash AFTER the purchase
 *   but BEFORE completion rolls everything back; retry converges to 1 tx.
 */
import { describe, expect, it, vi, afterAll, beforeAll } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { registerTransactionWriteRoutes } from '../../src/routes/transactions-write.js';
import { runCardMutation } from '../../src/cards/keyed-mutations.js';

const fakeTx = { query: async () => ({ rows: [], rowCount: 0 }) };
const HH = '00000000-0000-4000-8000-0000000000a1';
const CARD_ID = '00000000-0000-4000-8000-0000000000c1';
const CAT_ID = '00000000-0000-4000-8000-0000000000d1';
const PURCHASE = { accountId: CARD_ID, description: 'Lunch', amountCents: 1500, date: '2026-06-10', categoryId: CAT_ID };

describe('alt-card-expense-atomic dispatch (no DB)', () => {
  it('routes purchase onto the claim client when InTx exists', async () => {
    const txs = [{ id: 'tx1' }];
    const store = {
      createCardPurchase: vi.fn(async () => { throw new Error('plain must not run'); }),
      createCardPurchaseInTx: vi.fn(async () => txs),
    };
    await expect(runCardMutation(store as never, fakeTx, HH, 'purchase', PURCHASE as never)).resolves.toBe(txs);
    expect(store.createCardPurchaseInTx).toHaveBeenCalledWith(fakeTx, HH, PURCHASE);
    expect(store.createCardPurchase).not.toHaveBeenCalled();
  });

  it('falls back to the plain method only without a claim client', async () => {
    const txs = [{ id: 'tx1' }];
    const plain = { createCardPurchase: vi.fn(async () => txs) };
    await expect(runCardMutation(plain as never, undefined, HH, 'purchase', PURCHASE as never)).resolves.toBe(txs);
    expect(plain.createCardPurchase).toHaveBeenCalledWith(HH, PURCHASE);
  });

  it('fail-closed: Tx client but no InTx extension → invariant error, zero plain calls', async () => {
    const txs = [{ id: 'tx1' }];
    const plain = { createCardPurchase: vi.fn(async () => txs) };
    await expect(runCardMutation(plain as never, fakeTx, HH, 'purchase', PURCHASE as never)).rejects.toMatchObject({
      code: 'idempotency.atomic_mutation_not_supported',
    });
    expect(plain.createCardPurchase).not.toHaveBeenCalled();
  });
});

const buildRouteApp = (opts: {
  cardStore: unknown;
  idempotency: unknown;
  writes?: unknown;
  householdId?: string;
}) => {
  const app = Fastify({ logger: false });
  registerTransactionWriteRoutes(app as never, {
    store: {} as never,
    writes: (opts.writes ?? { createExpense: vi.fn() }) as never,
    resolveToken: (async () => ({ deviceId: 'd1', householdId: opts.householdId ?? HH })) as never,
    idempotency: opts.idempotency as never,
    cardStore: opts.cardStore as never,
  });
  return app;
};

const expensePayload = { description: 'Lunch', amountCents: 1500, date: '2026-06-10', cardId: CARD_ID, categoryId: CAT_ID };

describe('POST /transactions/expense cardId threads claimTx (no DB)', () => {
  it('forwards the open claimTx to createCardPurchaseInTx; receipt shape unchanged', async () => {
    const first = { id: 'tx1', accountId: CARD_ID, description: 'Lunch' };
    const cardStore = {
      createCardPurchase: vi.fn(async () => { throw new Error('plain must not run'); }),
      createCardPurchaseInTx: vi.fn(async () => [first]),
    };
    let seenClaimTx: unknown;
    const idempotency = {
      lookupOrRecord: async (_hh: string, _key: string, _payload: unknown, producer: (tx?: unknown) => Promise<unknown>) => {
        const response = await producer(fakeTx);
        seenClaimTx = fakeTx;
        return { response, replayed: false };
      },
    };
    const app = buildRouteApp({ cardStore, idempotency });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      payload: expensePayload,
    });
    expect(res.statusCode).toBe(201);
    expect(cardStore.createCardPurchaseInTx).toHaveBeenCalledWith(fakeTx, HH, expect.objectContaining({ accountId: CARD_ID }));
    expect(cardStore.createCardPurchase).not.toHaveBeenCalled();
    expect(seenClaimTx).toBe(fakeTx);
    const body = res.json();
    expect(body.id).toBe('tx1');
    expect(body.receipt.mutationKind).toBe('transaction.create');
    expect(body.receipt.entity).toEqual({ type: 'transaction', id: 'tx1' });
    await app.close();
  });

  it('fail-closed: PG-style claimTx + store without InTx → 500 atomic_mutation_not_supported, zero plain calls', async () => {
    const cardStore = { createCardPurchase: vi.fn(async () => [{ id: 'tx1' }]) };
    const idempotency = {
      lookupOrRecord: async (_hh: string, _key: string, _payload: unknown, producer: (tx?: unknown) => Promise<unknown>) => {
        const response = await producer(fakeTx);
        return { response, replayed: false };
      },
    };
    const app = buildRouteApp({ cardStore, idempotency });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k2' },
      payload: expensePayload,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('idempotency.atomic_mutation_not_supported');
    expect(cardStore.createCardPurchase).not.toHaveBeenCalled();
    await app.close();
  });

  it('without Idempotency-Key the plain boundary is kept (claimTx undefined)', async () => {
    const first = { id: 'tx1', accountId: CARD_ID };
    const cardStore = { createCardPurchase: vi.fn(async () => [first]) };
    const app = buildRouteApp({
      cardStore,
      idempotency: { lookupOrRecord: vi.fn(async () => { throw new Error('must not be used without key'); }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'content-type': 'application/json' },
      payload: expensePayload,
    });
    expect(res.statusCode).toBe(201);
    expect(cardStore.createCardPurchase).toHaveBeenCalledWith(HH, expect.objectContaining({ accountId: CARD_ID }));
    await app.close();
  });

  it('forwards the authenticated household (no cross-household leak)', async () => {
    const cardStore = {
      createCardPurchaseInTx: vi.fn(async (_tx: unknown, householdId: string) => {
        if (householdId !== HH) {
          const err = new Error('Cartão não encontrado.') as Error & { statusCode: number; code: string };
          err.statusCode = 404;
          err.code = 'not_found';
          throw err;
        }
        return [{ id: 'tx1' }];
      }),
    };
    const idempotency = {
      lookupOrRecord: async (_hh: string, _key: string, _payload: unknown, producer: (tx?: unknown) => Promise<unknown>) => ({
        response: await producer(fakeTx),
        replayed: false,
      }),
    };
    const app = buildRouteApp({ cardStore, idempotency, householdId: 'other-household' });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k3' },
      payload: expensePayload,
    });
    expect(res.statusCode).toBe(404);
    expect(cardStore.createCardPurchaseInTx).toHaveBeenCalledWith(fakeTx, 'other-household', expect.anything());
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Postgres crash-gap proofs (canonical + legacy). Same gate as
// domain-keyed-mutations-postgres: DATABASE_URL_TEST + DB_TEST_MARKER.
// Skips cleanly without a test DB; when enabled, proves the route's
// dispatcher shape (claimTx + runCardMutation('purchase')) rolls back the
// purchase when the claim tx aborts.
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log('[transactions-expense-card-atomic] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required — Postgres proofs skipped.');
}

describeIfDb('POST /transactions/expense cardId — Postgres single-tx proofs', () => {
  let pool: Pool;
  let legPool: Pool;
  let createPool: typeof import('../../src/db/pool.js').createPool;
  let requireTestDatabase: typeof import('../../src/db/db-guard.js').requireTestDatabase;
  let runMigrations: typeof import('../../src/read-models/sql/migrate.js').runMigrations;
  const households: string[] = [];
  const track = (h: string): string => {
    households.push(h);
    return h;
  };
  const LEGACY_SCHEMA = `g_alt_card_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    ({ createPool } = await import('../../src/db/pool.js'));
    ({ requireTestDatabase } = await import('../../src/db/db-guard.js'));
    ({ runMigrations } = await import('../../src/read-models/sql/migrate.js'));
    pool = createPool({ connectionString: DB_URL!, max: 8 });
    await requireTestDatabase(pool, 'transactions-expense-card-atomic');
    await runMigrations(pool);
    const url = new URL(DB_URL!);
    url.searchParams.set('options', `-c search_path=${LEGACY_SCHEMA},public`);
    legPool = createPool({ connectionString: url.toString(), max: 8 });
    await legPool.query(`CREATE SCHEMA IF NOT EXISTS ${LEGACY_SCHEMA}`);
    await legPool.query(`
      CREATE TABLE accounts (
        id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
        initial_balance_cents BIGINT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true,
        is_credit_card BOOLEAN NOT NULL DEFAULT false, credit_limit_cents BIGINT,
        closing_day INTEGER, due_day INTEGER, deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE categories (
        id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, parent_id UUID,
        icon TEXT, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
        is_default BOOLEAN NOT NULL DEFAULT false, is_system BOOLEAN NOT NULL DEFAULT false,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE statements (
        id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
        cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
        total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT statements_cycle_uniq UNIQUE (household_id, account_id, cycle_year_month)
      );
      CREATE TABLE card_purchases (
        id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
        statement_id UUID NOT NULL, description TEXT NOT NULL,
        amount_cents BIGINT NOT NULL, date DATE NOT NULL, category_id UUID,
        subcategory_id UUID, notes TEXT,
        installments_total INTEGER, installment_number INTEGER,
        is_recurring BOOLEAN NOT NULL DEFAULT false, transaction_id UUID,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE transactions (
        id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
        description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
        from_account_id UUID, to_account_id UUID, category_id UUID, subcategory_id UUID,
        notes TEXT, is_credit_card_purchase BOOLEAN NOT NULL DEFAULT false,
        statement_id UUID, installments_total INTEGER, installment_number INTEGER,
        is_recurring BOOLEAN NOT NULL DEFAULT false,
        deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- NOTE: operation_records / audit_logs are intentionally NOT created here.
      -- The canonical idempotency store (createPostgresIdempotencyStore without
      -- legacy:true) claims against the V013/V014/V016 canonical shape
      -- (workspace_id, actor_id, operation, idempotency_key, payload_hash,
      -- status, lease_until, retry_until, retention_until, completed_at,
      -- effect_ref + canonical audit_logs). Those already-migrated public
      -- tables are reached via search_path fallthrough
      -- (LEGACY_SCHEMA,public), so the claim + legacy purchase + completion
      -- share one real claimTx and the crash-gap rollback is proven, not faked.
      -- A minimal legacy-shaped operation_records here would shadow public and
      -- break the canonical claim with
      -- "column actor_id of relation operation_records does not exist".
    `);
  }, 60_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool.query('DELETE FROM card_purchases WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM transactions WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM statements WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query(
        'DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))',
        [households],
      );
      await pool.query('DELETE FROM operation_records WHERE workspace_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM categories WHERE household_id = ANY($1)', [households]).catch(() => undefined);
      await pool.query('DELETE FROM accounts WHERE household_id = ANY($1)', [households]).catch(() => undefined);
    }
    if (legPool) {
      await legPool.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`).catch(() => undefined);
      await legPool.end().catch(() => undefined);
    }
    await pool?.end();
  });

  it('canonical: crash after purchase rolls back; retry converges to 1 tx', async () => {
    const { createPostgresWriteStore, createPostgresIdempotencyStore } = await import('../../src/writes/postgres.js');
    const { createPostgresCardStore } = await import('../../src/cards/postgres.js');
    const household = track(randomUUID());
    const writes = createPostgresWriteStore({ pool });
    const cards = createPostgresCardStore(pool);
    const idempotency = createPostgresIdempotencyStore({ pool });
    const cat = await writes.createCategory(household, { name: 'PG Food', kind: 'expense' });
    const card = await cards.createCard(household, { name: 'PG Visa', creditLimitCents: 200_000, closingDay: 10, dueDay: 20 });
    const payload = { accountId: card.id, description: 'PG shop', amountCents: 1500, date: '2026-06-10', categoryId: cat.id };

    let attempts = 0;
    await expect(
      idempotency.lookupOrRecord(household, 'pg-alt-expense-canonical-crash', payload, async (claimTx: unknown) => {
        attempts += 1;
        const txs = await runCardMutation(cards, claimTx, household, 'purchase', payload);
        expect(txs).toHaveLength(1);
        if (attempts === 1) {
          await (claimTx as { query: (t: string) => Promise<unknown> }).query('INSERT INTO transactions (id) VALUES (NULL)');
        }
        return txs;
      }),
    ).rejects.toThrow();
    const orphaned = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(orphaned.rows[0]!.n).toBe(0);
    const retry = await idempotency.lookupOrRecord(household, 'pg-alt-expense-canonical-crash', payload, (claimTx: unknown) =>
      runCardMutation(cards, claimTx, household, 'purchase', payload),
    );
    expect(retry.replayed).toBe(false);
    const final = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(final.rows[0]!.n).toBe(1);
  }, 60_000);

  it('legacy: crash after purchase rolls back; retry converges to 1 tx', async () => {
    const { createLegacyPostgresCardStore } = await import('../../src/cards/legacy-postgres.js');
    const { createPostgresIdempotencyStore } = await import('../../src/writes/postgres.js');
    const household = track(randomUUID());
    const cards = createLegacyPostgresCardStore(legPool);
    const idempotency = createPostgresIdempotencyStore({ pool: legPool });
    const catRow = await legPool.query(
      'INSERT INTO categories (id, household_id, name, kind) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id',
      [household, 'PG Food', 'expense'],
    );
    const catId = catRow.rows[0]!.id as string;
    const card = await cards.createCard(household, { name: 'PG Visa', creditLimitCents: 200_000, closingDay: 10, dueDay: 20 });
    const payload = { accountId: card.id, description: 'PG shop', amountCents: 1500, date: '2026-06-10', categoryId: catId };

    let attempts = 0;
    await expect(
      idempotency.lookupOrRecord(household, 'pg-alt-expense-legacy-crash', payload, async (claimTx: unknown) => {
        attempts += 1;
        const txs = await runCardMutation(cards, claimTx, household, 'purchase', payload);
        expect(txs).toHaveLength(1);
        if (attempts === 1) {
          await (claimTx as { query: (t: string) => Promise<unknown> }).query('INSERT INTO transactions (id) VALUES (NULL)');
        }
        return txs;
      }),
    ).rejects.toThrow();
    const orphaned = await legPool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(orphaned.rows[0]!.n).toBe(0);
    const retry = await idempotency.lookupOrRecord(household, 'pg-alt-expense-legacy-crash', payload, (claimTx: unknown) =>
      runCardMutation(cards, claimTx, household, 'purchase', payload),
    );
    expect(retry.replayed).toBe(false);
    const final = await legPool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1', [household]);
    expect(final.rows[0]!.n).toBe(1);
  }, 60_000);
});
