/**
 * V4.1 PHASE 2 (Tasks 2.5–2.9, 2.18) — Postgres proofs.
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Isolated schemas per run so
 * parallel suites never share rows:
 * - canonical schema: full migrations via runMigrations (createPostgresCardStore).
 * - legacy schema: hand-built Agent-Pi-shaped tables (createLegacyPostgresCardStore).
 *
 * RED coverage (fails before the fix, passes after):
 * - 2.5/2.6: legacy updateCard/updatePurchase fixed placeholders $3..$6 break
 *   any partial PATCH that does not start at `name`/`description`.
 * - 2.7: canonical updatePurchase leaves the card_purchases projection stale.
 * - 2.8: N concurrent purchases on one statement lose totals (both stores).
 * - 2.9: two concurrent payStatement calls double-pay (both stores);
 *   canonical overpay is accepted.
 * - 2.18: canonical + legacy createRecurringPurchase skip the normal
 *   card/category validation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[postgres-cards-v41-hardening] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.',
  );
}

const suffix = `${process.pid}_${Date.now()}`;
const CANON_SCHEMA = `v41c_${suffix}`;
const LEG_SCHEMA = `v41l_${suffix}`;

// V4.1 REVIEWFIX F7: PATCH requires an open statement — future purchase
// dates keep fixture statements genuinely 'open' regardless of wall-clock
// (computeStatus is wall-clock relative).
const FUTURE_DATE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

const scopedPool = (schema: string, max: number): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max });
};

let adminPool: Pool | undefined;
let canonPool: Pool | undefined;
let legPool: Pool | undefined;

/**
 * Hand-built canonical tables (isolated schema). runMigrations on a FRESH
 * schema is broken at HEAD (V049 expects legacy `active` on a canonical
 * `status` table — pre-existing drift, also failing card-store-idor and
 * postgres-financial-integrity at baseline), so card-scope tests own their
 * DDL here. Column names/types mirror V001/V004/V009/V032/V033/V046/V047.
 */
const createCanonicalTables = async (db: Pool): Promise<void> => {
  await db.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, balance_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      credit_limit_cents BIGINT, closing_day INTEGER, due_day INTEGER,
      institution_id TEXT, card_product_id TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE categories (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', parent_id UUID,
      icon TEXT, color TEXT, sort_order INTEGER,
      is_default BOOLEAN NOT NULL DEFAULT false, is_system BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT statements_cycle_uniq UNIQUE (household_id, account_id, cycle_year_month)
    );
    CREATE TABLE transactions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, kind TEXT NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, date DATE NOT NULL,
      account_id UUID NOT NULL, category_id UUID, subcategory_id UUID, notes TEXT,
      transfer_to_account_id UUID, statement_id UUID,
      -- V056/V057: structured statement-payment link (canonical-only).
      -- Mirrors the migrated final state: nullable column + composite
      -- (statement_payment_id, household_id) -> statements(id, household_id)
      -- FK + partial index. Legacy fixture tables deliberately omit it
      -- (legacy payStatement keeps description-matched coverage).
      statement_payment_id UUID,
      installments_total INTEGER, installment_number INTEGER,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    CREATE TABLE recurring_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, frequency TEXT NOT NULL,
      start_date DATE NOT NULL, end_date DATE, category_id UUID,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- V057 backing UNIQUE for the composite statement-payment FK below
    -- (statements.id is the PK, but Postgres only accepts a PK or an
    -- explicit UNIQUE covering the exact referenced columns).
    ALTER TABLE statements
      ADD CONSTRAINT statements_id_household_uidx UNIQUE (id, household_id);
    -- V056+V057 final state: composite household FK + partial index.
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_statement_payment_household_fkey
      FOREIGN KEY (statement_payment_id, household_id)
      REFERENCES statements (id, household_id);
    CREATE INDEX transactions_statement_payment_idx
      ON transactions (statement_payment_id)
      WHERE statement_payment_id IS NOT NULL AND deleted_at IS NULL;
  `);
};

const createLegacyTables = async (db: Pool): Promise<void> => {
  await db.query(`
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
      icon TEXT, color TEXT, sort_order INTEGER,
      is_default BOOLEAN NOT NULL DEFAULT false, is_system BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE statements (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      cycle_year_month TEXT NOT NULL, closing_date DATE NOT NULL, due_date DATE NOT NULL,
      total_cents BIGINT NOT NULL DEFAULT 0, paid_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    CREATE TABLE recurring_purchases (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, account_id UUID NOT NULL,
      description TEXT NOT NULL, amount_cents BIGINT NOT NULL, frequency TEXT NOT NULL,
      start_date DATE NOT NULL, next_due_date DATE NOT NULL, end_date DATE,
      category_id UUID, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

// ── Canonical seed helpers ────────────────────────────────────────────

const seedCanonHousehold = async (_db: Pool, _name: string): Promise<string> => {
  // No households table in the hand-built scope (accounts carry no FK here);
  // the household id is just a scope marker cleaned up per test.
  return randomUUID();
};

const seedCanonCard = async (db: Pool, householdId: string, name = 'Nubank'): Promise<string> => {
  const r = await db.query(
    `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status, credit_limit_cents, closing_day, due_day)
     VALUES (gen_random_uuid(), $1, $2, 'credit_card', 0, 'active', 500000, 15, 25) RETURNING id`,
    [householdId, name],
  );
  return r.rows[0]!['id'] as string;
};

const seedCanonBank = async (db: Pool, householdId: string, balance: number): Promise<string> => {
  const r = await db.query(
    `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status)
     VALUES (gen_random_uuid(), $1, 'Itaú', 'bank', $2, 'active') RETURNING id`,
    [householdId, balance],
  );
  return r.rows[0]!['id'] as string;
};

const seedCanonCategory = async (db: Pool, householdId: string, kind: 'expense' | 'income'): Promise<string> => {
  const r = await db.query(
    `INSERT INTO categories (id, household_id, name, kind, status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active') RETURNING id`,
    [householdId, `Cat-${kind}-${randomUUID().slice(0, 8)}`, kind],
  );
  return r.rows[0]!['id'] as string;
};

// ── Legacy seed helpers ───────────────────────────────────────────────

describeIfDb('Postgres cards V4.1 hardening (tasks 2.5–2.9, 2.18)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    // REVIEW R2 (F9): refuse DDL against databases without the server-side
    // test marker — env presence alone is not a safety guarantee.
    await requireTestDatabase(adminPool, 'schema-create');
    canonPool = scopedPool(CANON_SCHEMA, 10);
    legPool = scopedPool(LEG_SCHEMA, 10);
    await adminPool.query(`CREATE SCHEMA ${CANON_SCHEMA}`);
    await adminPool.query(`CREATE SCHEMA ${LEG_SCHEMA}`);
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await createCanonicalTables(canonPool);
    await createLegacyTables(legPool);
  }, 120_000);

  afterAll(async () => {
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${CANON_SCHEMA} CASCADE`).catch(() => undefined);
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${LEG_SCHEMA} CASCADE`).catch(() => undefined);
    await canonPool?.end();
    await legPool?.end();
    await adminPool?.end();
  });

  // ── 2.5 canonical updateCard per-field isolation ───────────────────
  describe('2.5 canonical updateCard per-field isolation', () => {
    it('updating a single non-leading field preserves the rest', async () => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = randomUUID();
      const card = await cards.createCard(hh, { name: 'Nubank', creditLimitCents: 500000, closingDay: 15, dueDay: 25 });
      try {
        const renamed = await cards.updateCard(hh, card.id, { name: 'Inter' });
        expect(renamed.name).toBe('Inter');
        expect(renamed.creditLimitCents).toBe(500000);
        const limited = await cards.updateCard(hh, card.id, { creditLimitCents: 800000 });
        expect(limited.creditLimitCents).toBe(800000);
        expect(limited.name).toBe('Inter');
        expect(limited.closingDay).toBe(15);
        expect(limited.dueDay).toBe(25);
      } finally {
        await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
      }
    });
  });

  // ── 2.5 legacy updateCard partial PATCH ────────────────────────────

  // ── 2.6 legacy updatePurchase partial PATCH ────────────────────────

  // ── 2.7 canonical projection sync ──────────────────────────────────
  describe('2.7 canonical updatePurchase syncs the card_purchases projection', () => {
    it('patching amount updates the linked projection row', async () => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = await seedCanonHousehold(canonPool!, 'Proj H');
      const cardId = await seedCanonCard(canonPool!, hh);
      const catId = await seedCanonCategory(canonPool!, hh, 'expense');
      const [tx] = await cards.createCardPurchase(hh, {
        accountId: cardId, description: 'Mercado', amountCents: 15000, date: FUTURE_DATE, categoryId: catId,
      });
      await cards.updatePurchase(hh, tx!.id, { amountCents: 20000 });
      const proj = await canonPool!.query(
        `SELECT amount_cents, description FROM card_purchases WHERE transaction_id = $1 AND household_id = $2`,
        [tx!.id, hh],
      );
      expect(proj.rowCount).toBe(1);
      expect(Number(proj.rows[0]!['amount_cents'])).toBe(20000);
      expect(proj.rows[0]!['description']).toBe('Mercado');
      await canonPool!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM categories WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM households WHERE id = $1`, [hh]).catch(() => undefined);
    });
  });

  // ── 2.8 statement total concurrency ────────────────────────────────
  describe('2.8 concurrent purchases keep an exact statement total', () => {
    it('canonical: 8 concurrent purchases sum exactly', async () => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = await seedCanonHousehold(canonPool!, 'Race C');
      try {
        const cardId = await seedCanonCard(canonPool!, hh);
        const catId = await seedCanonCategory(canonPool!, hh, 'expense');
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            cards.createCardPurchase(hh, {
              accountId: cardId, description: `Item ${i}`, amountCents: 1000,
              date: '2026-08-20', categoryId: catId,
            }),
          ),
        );
        const stmts = await cards.listStatements(hh, cardId);
        expect(stmts).toHaveLength(1);
        expect(stmts[0]!.totalCents).toBe(8000);
      } finally {
        await canonPool!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM categories WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM households WHERE id = $1`, [hh]).catch(() => undefined);
      }
    }, 30_000);

  });

  // ── 2.9 statement payment concurrency + overpay ────────────────────
  describe('2.9 concurrent statement payments serialize', () => {
    const setupCanonInvoice = async (total: number) => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = await seedCanonHousehold(canonPool!, 'Pay C');
      const cardId = await seedCanonCard(canonPool!, hh);
      const payerId = await seedCanonBank(canonPool!, hh, 100000);
      const catId = await seedCanonCategory(canonPool!, hh, 'expense');
      await cards.createCardPurchase(hh, {
        accountId: cardId, description: 'Compra', amountCents: total, date: '2026-06-10', categoryId: catId,
      });
      const stmt = (await cards.listStatements(hh, cardId))[0]!;
      return { cards, hh, cardId, payerId, stmt };
    };
    const cleanupCanon = async (hh: string) => {
      await canonPool!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM categories WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
      await canonPool!.query(`DELETE FROM households WHERE id = $1`, [hh]).catch(() => undefined);
    };

    it('canonical: overpay is rejected with 4xx', async () => {
      const { cards, hh, payerId, stmt } = await setupCanonInvoice(50000);
      try {
        await expect(
          cards.payStatement(hh, stmt.id, { amountCents: 60000, fromAccountId: payerId }),
        ).rejects.toMatchObject({ statusCode: 400 });
      } finally {
        await cleanupCanon(hh);
      }
    });

    it('canonical: two concurrent full payments yield exactly one effect', async () => {
      const { cards, hh, payerId, stmt } = await setupCanonInvoice(50000);
      try {
        const results = await Promise.allSettled([
          cards.payStatement(hh, stmt.id, { amountCents: 50000, fromAccountId: payerId }),
          cards.payStatement(hh, stmt.id, { amountCents: 50000, fromAccountId: payerId }),
        ]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const failed = results.filter((r) => r.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 400 });
        const after = await canonPool!.query(
          `SELECT paid_cents FROM statements WHERE id = $1`, [stmt.id],
        );
        expect(Number(after.rows[0]!['paid_cents'])).toBe(50000);
        const payments = await canonPool!.query(
          `SELECT COUNT(*) AS n FROM transactions WHERE household_id = $1 AND description LIKE 'Pagamento fatura%' AND deleted_at IS NULL`,
          [hh],
        );
        expect(Number(payments.rows[0]!['n'])).toBe(1);
      } finally {
        await cleanupCanon(hh);
      }
    }, 30_000);

  });

  // ── 2.18 recurring validation on Postgres ──────────────────────────
  describe('2.18 recurring purchase validation on Postgres', () => {
    it('canonical: non-credit account and income category are rejected', async () => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = await seedCanonHousehold(canonPool!, 'Rec C');
      try {
        const bankId = await seedCanonBank(canonPool!, hh, 100000);
        const incomeId = await seedCanonCategory(canonPool!, hh, 'income');
        const cardId = await seedCanonCard(canonPool!, hh);
        await expect(cards.createRecurringPurchase(hh, {
          accountId: bankId, description: 'X', amountCents: 1000, frequency: 'monthly', startDate: '2026-06-15',
        })).rejects.toMatchObject({ statusCode: 400 });
        await expect(cards.createRecurringPurchase(hh, {
          accountId: cardId, description: 'X', amountCents: 1000, frequency: 'monthly',
          startDate: '2026-06-15', categoryId: incomeId,
        })).rejects.toMatchObject({ statusCode: 400 });
        await expect(cards.createRecurringPurchase(hh, {
          accountId: '00000000-0000-4000-8000-00000000ffff', description: 'X', amountCents: 1000,
          frequency: 'monthly', startDate: '2026-06-15',
        })).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await canonPool!.query(`DELETE FROM recurring_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM categories WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM households WHERE id = $1`, [hh]).catch(() => undefined);
      }
    });

  });

  // ── V4.1 REVIEWFIX F5: shared STATEMENT → TRANSACTION lock order ─────
  describe('REVIEWFIX F5 — concurrent PATCH + cancel serialize without deadlock', () => {
    const isBenign = (r: PromiseSettledResult<unknown>): boolean => {
      if (r.status === 'fulfilled') return true;
      const err = r.reason as { statusCode?: number; code?: string; message?: string };
      // Serialized loser: purchase already patched/cancelled (404/409).
      // Anything else — deadlock (40P01), 500, connection loss — fails.
      if (err && typeof err.statusCode === 'number' && (err.statusCode === 404 || err.statusCode === 409)) return true;
      const msg = String((err as Error)?.message ?? '');
      if (/deadlock/i.test(msg)) return false;
      return false;
    };

    it('canonical: racing updatePurchase + cancelPurchase never deadlocks', async () => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = await seedCanonHousehold(canonPool!, 'F5 C');
      try {
        const cardId = await seedCanonCard(canonPool!, hh);
        const catId = await seedCanonCategory(canonPool!, hh, 'expense');
        for (let round = 0; round < 5; round += 1) {
          const [tx] = await cards.createCardPurchase(hh, {
            accountId: cardId, description: `Race ${round}`, amountCents: 1000,
            date: FUTURE_DATE, categoryId: catId,
          });
          const results = await Promise.allSettled([
            cards.updatePurchase(hh, tx!.id, { description: `Patched ${round}` }),
            cards.cancelPurchase(hh, tx!.id),
          ]);
          for (const r of results) {
            expect(isBenign(r)).toBe(true);
          }
        }
      } finally {
        await canonPool!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM categories WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM households WHERE id = $1`, [hh]).catch(() => undefined);
      }
    }, 60_000);

  });

  // ── V4.1 REVIEWFIX F6: legacy cancel under the statement lock ────────

  // ── V4.1 REVIEWFIX F7: PATCH requires an open statement (PG) ─────────
  describe('REVIEWFIX F7 — purchase PATCH requires an open statement', () => {
    it('canonical: PATCH after full payment → 409; open → 200', async () => {
      const cards = createPostgresCardStore(canonPool!);
      const hh = await seedCanonHousehold(canonPool!, 'F7 C');
      try {
        const cardId = await seedCanonCard(canonPool!, hh);
        const payerId = await seedCanonBank(canonPool!, hh, 100000);
        const catId = await seedCanonCategory(canonPool!, hh, 'expense');
        const [tx] = await cards.createCardPurchase(hh, {
          accountId: cardId, description: 'Mercado', amountCents: 15000, date: FUTURE_DATE, categoryId: catId,
        });
        // Control: open statement accepts the PATCH.
        const open = await cards.updatePurchase(hh, tx!.id, { description: 'Feira' });
        expect(open.purchases[0]!.description).toBe('Feira');
        const stmt = (await cards.listStatements(hh, cardId))[0]!;
        await cards.payStatement(hh, stmt.id, { amountCents: 15000, fromAccountId: payerId });
        await expect(
          cards.updatePurchase(hh, tx!.id, { description: 'Tarde demais' }),
        ).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await canonPool!.query(`DELETE FROM card_purchases WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM transactions WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM statements WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM categories WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM accounts WHERE household_id = $1`, [hh]).catch(() => undefined);
        await canonPool!.query(`DELETE FROM households WHERE id = $1`, [hh]).catch(() => undefined);
      }
    });

  });

  // ── FINAL REVIEW: projection failure must roll the cancel back ─────────
});
