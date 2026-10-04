/**
 * G03 - Postgres twin of `analytics-semantics-fixture.test.ts`.
 *
 * The store-backed suite proves the semantics through the in-memory source.
 * This one proves them through the SQL that production actually runs
 * (`createSqlAnalyticsSource`): `SUM(...)::text` exactness (G-B), the
 * `statement_payment_id` predicate (G-A) and the row counts (G-C) are all
 * database behaviour, and no in-memory loop can stand in for them.
 *
 * Runs only with DATABASE_URL_TEST + DB_TEST_MARKER (CI job "Postgres -
 * integration tests", or a local disposable database); skips otherwise. The
 * db-guard refuses to run against a database without the test marker and every
 * test cleans up its own households.
 *
 * The SAME `analytics-semantics.fixture.json` seeds both suites, so drift
 * between them is impossible: the dataset is loaded once, by a shared loader.
 * Fixture ids are symbolic; the database demands UUIDs, so every id is mapped
 * once and the tests read back through that map.
 */

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createSqlAnalyticsSource } from '../../src/analytics/source.js';
import { registerAnalyticsRoutes } from '../../src/routes/analytics.js';
import { createInMemoryReadModelStore } from '../../src/read-models/store.js';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import type { Account, Category } from '../../src/types/domain.js';
import { analyticsFixture, fixtureCase, fixtureTransactions } from '../fixtures/analytics-semantics-dataset.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;
const CLOCK = () => new Date('2026-09-07T12:00:00.000Z');
const TOKEN = 'g03-token';

let pool: Pool | undefined;
let app: FastifyInstance | undefined;
/** Symbolic fixture id -> real UUID (the database demands UUID keys). */
const uuidByFixtureId = new Map<string, string>();
/** Household the stub token currently points at (per request). */
let activeHouseholdId = '';
const householdIds: string[] = [];
const ownerIds: string[] = [];

const uuidFor = (symbolic: string): string => {
  const existing = uuidByFixtureId.get(symbolic);
  if (existing) return existing;
  const created = randomUUID();
  uuidByFixtureId.set(symbolic, created);
  return created;
};

const expectedOf = <T = Record<string, any>>(id: string): T => fixtureCase(id).expected as T;

async function seedHousehold(db: Pool): Promise<string> {
  const id = randomUUID();
  const ownerId = randomUUID();
  await db.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'G03 Fixture', 'active')`, [
    ownerId,
    `g03-${id}@example.test`,
  ]);
  await db.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, $2, 'shared', $3)`, [
    id,
    `G03 ${id.slice(0, 8)}`,
    ownerId,
  ]);
  householdIds.push(id);
  ownerIds.push(ownerId);
  uuidByFixtureId.set(`household:${id}`, id);
  return id;
}

async function seedAll(db: Pool): Promise<{ a: string; b: string }> {
  // `hh-a`/`hh-b` become two real households so isolation (case J) is real.
  const byFixture: Record<string, string> = { 'hh-a': await seedHousehold(db), 'hh-b': await seedHousehold(db) };

  for (const account of analyticsFixture.dataset.accounts) {
    await db.query(
      `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status, credit_limit_cents)
       VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [
        uuidFor(account.id),
        byFixture[account.householdId],
        account.name,
        account.kind,
        account.status,
        account.creditLimitCents ?? null,
      ],
    );
  }
  for (const category of analyticsFixture.dataset.categories) {
    await db.query(
      `INSERT INTO categories (id, household_id, name, kind, status, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        uuidFor(category.id),
        byFixture[category.householdId],
        category.name,
        category.kind,
        category.status,
        category.parentId ? uuidFor(category.parentId) : null,
      ],
    );
  }
  // Statements first: `statement_payment_id` (V056/V057) has an FK to them.
  for (const statement of analyticsFixture.dataset.statements) {
    await db.query(
      `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidFor(statement.id),
        byFixture[statement.householdId],
        uuidFor(statement.accountId),
        statement.cycleYearMonth,
        statement.closingDate,
        statement.dueDate,
        statement.totalCents,
        statement.paidCents,
        statement.status,
      ],
    );
  }
  const softDeleted = new Set(
    analyticsFixture.dataset.transactions.filter((row) => row.deletedAt).map((row) => row.id),
  );
  const purchases = new Map(
    analyticsFixture.dataset.transactions
      .filter((row) => row.statementId)
      .map((row) => [row.id, row.statementId as string]),
  );
  for (const tx of fixtureTransactions()) {
    await db.query(
      `INSERT INTO transactions
         (id, household_id, kind, description, amount_cents, date, account_id, category_id,
          subcategory_id, transfer_to_account_id, statement_id, statement_payment_id, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        uuidFor(tx.id),
        byFixture[tx.householdId],
        tx.kind,
        tx.description,
        tx.amountCents,
        tx.date,
        uuidFor(tx.accountId),
        tx.categoryId ? uuidFor(tx.categoryId) : null,
        tx.subcategoryId ? uuidFor(tx.subcategoryId) : null,
        tx.transferToAccountId ? uuidFor(tx.transferToAccountId) : null,
        purchases.has(tx.id) ? uuidFor(purchases.get(tx.id) as string) : null,
        tx.statementPaymentId ? uuidFor(tx.statementPaymentId) : null,
        softDeleted.has(tx.id) ? '2026-01-06T10:00:00Z' : null,
      ],
    );
  }
  return { a: byFixture['hh-a'] as string, b: byFixture['hh-b'] as string };
}

/**
 * Entity lists come from the in-memory stores, exactly as
 * `createSqlAnalyticsSource` composes them in production (`server/index.ts`):
 * the aggregates are SQL, the labels are domain stores.
 */
function listsFor(byFixture: Record<string, string>): { accounts: Account[]; categories: Category[] } {
  const accounts: Account[] = analyticsFixture.dataset.accounts.map((account) => {
    const seeded: Account = {
      id: uuidFor(account.id),
      householdId: byFixture[account.householdId] as string,
      name: account.name,
      kind: account.kind,
      balanceCents: 0,
      status: account.status,
    };
    if (account.creditLimitCents !== undefined) seeded.creditLimitCents = account.creditLimitCents;
    return seeded;
  });
  const categories: Category[] = analyticsFixture.dataset.categories.map((category) => {
    const seeded: Category = {
      id: uuidFor(category.id),
      householdId: byFixture[category.householdId] as string,
      name: category.name,
      kind: category.kind,
      status: category.status,
    };
    if (category.parentId) seeded.parentId = uuidFor(category.parentId);
    return seeded;
  });
  return { accounts, categories };
}

async function cleanup(db: Pool): Promise<void> {
  for (const householdId of householdIds) {
    await db.query(`DELETE FROM transactions WHERE household_id = $1`, [householdId]).catch(() => undefined);
    await db.query(`DELETE FROM statements WHERE household_id = $1`, [householdId]).catch(() => undefined);
    await db.query(`DELETE FROM categories WHERE household_id = $1`, [householdId]).catch(() => undefined);
    await db.query(`DELETE FROM accounts WHERE household_id = $1`, [householdId]).catch(() => undefined);
    await db.query(`DELETE FROM households WHERE id = $1`, [householdId]).catch(() => undefined);
  }
  for (const ownerId of ownerIds) {
    await db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => undefined);
  }
}

/** `get` scopes the stub token to `householdId` for the duration of the call. */
const get = async (householdId: string, path: string, query: Record<string, string>): Promise<Record<string, any>> => {
  activeHouseholdId = householdId;
  try {
    const search = new URLSearchParams(query).toString();
    const res = await app!.inject({ method: 'GET', url: `${path}?${search}`, headers: { 'x-device-token': TOKEN } });
    expect(res.statusCode, `${path} ${search}`).toBe(200);
    return res.json() as Record<string, any>;
  } finally {
    activeHouseholdId = '';
  }
};

const JANUARY = { period: 'custom', from: '2026-01-01', to: '2026-01-31' };
const QUARTER = { period: 'custom', from: '2026-01-01', to: '2026-03-31' };
const JUNE = { period: 'custom', from: '2026-06-01', to: '2026-06-30' };

describe('Postgres analytics semantics (G03 — a fixture contra o SQL de produção)', () => {
  let householdA = '';
  let householdB = '';

  beforeAll(async () => {
    if (!DB_URL) return;
    pool = createPool({ connectionString: DB_URL, max: 4 });
    await requireTestDatabase(pool, 'migrate');
    await runMigrations(pool);
    const db = pool;
    const seeded = await seedAll(db);
    householdA = seeded.a;
    householdB = seeded.b;

    const byFixture: Record<string, string> = { 'hh-a': seeded.a, 'hh-b': seeded.b };
    const { accounts, categories } = listsFor(byFixture);
    const state = createInMemoryStores({ accounts, categories, transactions: [] }).state;
    app = Fastify({ logger: false });
    registerAnalyticsRoutes(app, {
      source: createSqlAnalyticsSource(db, {
        stores: {
          store: createInMemoryReadModelStore({ accounts, categories }),
          cardStore: createInMemoryCardStore(state),
        },
      }),
      // The token is the ONLY household authority; no query parameter can
      // override it (case J).
      resolveToken: async (token: string | undefined) => {
        if (token !== TOKEN) {
          throw Object.assign(new Error('invalid'), { statusCode: 401, code: 'auth.invalid_token' });
        }
        return { deviceId: 'g03-device', householdId: activeHouseholdId || householdA, userId: null };
      },
      clock: CLOCK,
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (pool) await cleanup(pool);
    await app?.close();
    await pool?.end();
  });

  itIfDatabase('A/C/K: o default (basis ausente) não move um centavo', async () => {
    const a = expectedOf<{ totalCents: number; kpisExpenseCents: number; kpisIncomeCents: number }>(
      'A-competencia-vs-pagamento',
    );
    const breakdown = await get(householdA, '/analytics/category-breakdown', { ...JANUARY, kind: 'expense' });
    expect(breakdown.totalCents).toBe(a.totalCents);
    expect(breakdown.basis).toBe('liquidez');

    const kpis = await get(householdA, '/analytics/kpis', JANUARY);
    expect(kpis.expenseCents).toBe(a.kpisExpenseCents);
    expect(kpis.incomeCents).toBe(a.kpisIncomeCents);
    // C: as duas linhas soft-deleted (999.000 de receita + 12.000 de despesa)
    // nunca entram. Sem o filtro a receita de janeiro seria 1.499.000.
    expect(kpis.incomeCents).not.toBe(1_499_000);
    expect(kpis.transactionCount).toBe(7);

    const k = expectedOf<{ januaryExpenseCents: number; februaryExpenseCents: number; deltaCents: number }>(
      'K-comparacao-entre-meses',
    );
    const february = await get(householdA, '/analytics/kpis', { period: 'custom', from: '2026-02-01', to: '2026-02-28' });
    expect(february.expenseCents).toBe(k.februaryExpenseCents);
    expect(kpis.expenseCents - february.expenseCents).toBe(-k.deltaCents);
  });

  itIfDatabase('E: transferência não conta e o escopo canônico casa só a origem', async () => {
    // acc-a-bank2 é o DESTINO da transferência de 40.000: no dialeto canônico
    // o filtro casa `account_id` de origem, então ele devolve zero.
    const destination = await get(householdA, '/analytics/kpis', {
      ...JANUARY,
      accountId: uuidFor('acc-a-bank2'),
    });
    expect(destination.expenseCents).toBe(0);
    expect(destination.transactionCount).toBe(0);
    expect(destination.emptyReason).toBe('no_transactions_in_period');
    // A origem carrega as 41.000 de despesa de janeiro (a transferência não).
    const origin = await get(householdA, '/analytics/kpis', { ...JANUARY, accountId: uuidFor('acc-a-bank') });
    expect(origin.expenseCents).toBe(41_000);
  });

  itIfDatabase('F: basis=competencia tira o pagamento da fatura do agregado de despesa', async () => {
    const f = expectedOf<{
      naiveExpenseCents: number;
      invoiceDoubleCountedCents: number;
      competenciaExpenseCents: number;
      categoryBreakdownTotalCents: number;
    }>('F-cartao-vs-fatura');

    const liquidez = await get(householdA, '/analytics/kpis', QUARTER);
    expect(liquidez.expenseCents).toBe(f.naiveExpenseCents);
    const competencia = await get(householdA, '/analytics/kpis', { ...QUARTER, basis: 'competencia' });
    expect(competencia.expenseCents).toBe(f.competenciaExpenseCents);
    expect(competencia.basis).toBe('competencia');
    expect(liquidez.expenseCents - competencia.expenseCents).toBe(f.invoiceDoubleCountedCents);
    // Receita intocada pelo predicado, e a contagem segue o agregado real.
    expect(competencia.incomeCents).toBe(liquidez.incomeCents);
    expect(competencia.transactionCount).toBe(10);

    // A compra continua na data da compra: 20/jan segue com 30.000.
    const heatmap = await get(householdA, '/analytics/daily-heatmap', { to: '2026-01-20', basis: 'competencia' });
    const day = heatmap.weeks
      .flatMap((week: { days: Array<{ date: string; totalCents: number }> }) => week.days)
      .find((entry: { date: string }) => entry.date === '2026-01-20');
    expect(day.totalCents).toBe(30_000);

    const breakdown = await get(householdA, '/analytics/category-breakdown', { ...QUARTER, kind: 'expense' });
    expect(breakdown.totalCents).toBe(f.categoryBreakdownTotalCents);
  });

  itIfDatabase('H: SUM(...)::text atravessa a resposta como decimal exato', async () => {
    const h = expectedOf<{ totalCentsExact: string; transactionCount: number }>('H-safe-integers');
    const kpis = await get(householdA, '/analytics/kpis', JUNE);
    // O banco devolve o decimal exato; o `number` é o double aproximado.
    expect(kpis.expenseCentsExact).toBe(h.totalCentsExact);
    expect(kpis.approximate).toBe(true);
    expect(kpis.transactionCount).toBe(h.transactionCount);
    // O double realmente perdeu centavos: essa é a razão da flag.
    expect(BigInt(kpis.expenseCentsExact) - BigInt(kpis.expenseCents)).not.toBe(0n);

    const breakdown = await get(householdA, '/analytics/category-breakdown', { ...JUNE, kind: 'expense' });
    expect(breakdown.totalCentsExact).toBe(h.totalCentsExact);
    const slice = breakdown.slices.find(
      (entry: { categoryId: string }) => entry.categoryId === uuidFor('cat-utilities'),
    );
    expect(slice.totalCentsExact).toBe(h.totalCentsExact);
    expect(slice.approximate).toBe(true);
  });

  itIfDatabase('L: o envelope de prova acompanha as 6 rotas do Postgres', async () => {
    const fields = ['transactionCount', 'asOf', 'basis', 'semanticsVersion', 'effectiveFilter', 'emptyReason'];
    const window = { period: 'custom', from: '2026-02-01', to: '2026-02-28' };
    for (const route of [
      '/analytics/kpis',
      '/analytics/cashflow-series',
      '/analytics/category-breakdown',
      '/analytics/budget-consumption',
      '/analytics/daily-heatmap',
      '/analytics/net-worth-history',
    ]) {
      const body = await get(householdA, route, window);
      for (const field of fields) expect(body, `${route}.${field}`).toHaveProperty(field);
      expect(body.semanticsVersion, route).toBe('1');
      expect(body.asOf, route).toBe(CLOCK().toISOString());
    }
    const empty = await get(householdA, '/analytics/kpis', { period: 'custom', from: '2025-01-01', to: '2025-01-31' });
    expect(empty.transactionCount).toBe(0);
    expect(empty.expenseCents).toBe(0);
    expect(empty.emptyReason).toBe('no_transactions_in_period');
  });

  itIfDatabase('J: dois households reais não se enxergam', async () => {
    const j = expectedOf<{
      workspaceA: { expenseCents: number };
      workspaceB: { expenseCents: number; incomeCents: number };
    }>('J-dois-workspaces');
    const a = await get(householdA, '/analytics/kpis', JANUARY);
    const b = await get(householdB, '/analytics/kpis', JANUARY);
    expect(a.expenseCents).toBe(j.workspaceA.expenseCents);
    expect(b.expenseCents).toBe(j.workspaceB.expenseCents);
    expect(b.incomeCents).toBe(j.workspaceB.incomeCents);
    expect(b.transactionCount).toBe(2);
    expect(b.emptyReason).toBeNull();
  });

  itIfDatabase('I: o dataset maior que uma página soma inteiro no SQL', async () => {
    const i = expectedOf<{ g1: { totalCents: number; transactionCount: number } }>('I-dataset-maior-que-uma-pagina');
    const april = await get(householdA, '/analytics/kpis', { period: 'custom', from: '2026-04-01', to: '2026-04-30' });
    expect(april.expenseCents).toBe(i.g1.totalCents);
    expect(april.transactionCount).toBe(i.g1.transactionCount);
  });
});