/**
 * Analytics data sources (item 14, etapa A).
 *
 * Transaction aggregates run in the database on Postgres
 * (`createSqlAnalyticsSource`, canonical and legacy dialects) and as plain
 * loops on the in-memory backend (`createStoreAnalyticsSource`). Small
 * entity lists always come from the existing domain stores so backend
 * behavior (status filters, computed balances, statement totals) is reused
 * instead of reimplemented.
 */

import type { Account, BudgetStatus, Category, RecurringPurchase, Statement, Subscription, Transaction } from '../types/domain.js';
import type { ReadModelStore } from '../read-models/store.js';
import type { BudgetStore } from '../budgets/store.js';
import type { CardStore } from '../cards/store.js';
import type { SubscriptionStore } from '../subscriptions/store.js';
import { centsFromSqlText, sumCents, type Cents } from './exact.js';
import { DEFAULT_ANALYTICS_BASIS, type AnalyticsBasis } from './types.js';

/** Minimal query surface (compatible with pg.Pool and the route pool type). */
export type AnalyticsPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * G-C: how many income/expense rows the aggregate actually read. Transfers are
 * never summed by any analytics read model, so counting them would inflate the
 * proof; the count is what lets a consumer separate "total 0 with entries" from
 * "no entries in the window" (A04 `period_empty`).
 */
export type AggregateCount = { transactionCount: number };

export type KindSum = {
  income: Cents;
  expense: Cents;
} & AggregateCount;

export type DailySum = { date: string; income: Cents; expense: Cents } & AggregateCount;
export type CategorySum = { categoryId: string; total: Cents } & AggregateCount;
export type MonthlyFlow = { month: string; income: Cents; expense: Cents } & AggregateCount;

/** G-A: read options. `basis` defaults to `liquidez` (current behaviour). */
export type AnalyticsReadOptions = { basis?: AnalyticsBasis };

const resolveBasis = (options?: AnalyticsReadOptions): AnalyticsBasis => options?.basis ?? DEFAULT_ANALYTICS_BASIS;

/**
 * G-A: whether a source can APPLY `competencia` at all.
 *
 * The predicate reads `transactions.statement_payment_id`, and V056 is
 * `canonical-only` (`read-models/sql/migrate.ts`). A source assembled with
 * `legacy: true` therefore DECLARES the basis unavailable instead of emitting
 * SQL for a column that database does not have: the route refuses with a typed
 * 400 before any query is assembled, rather than surfacing a Postgres
 * "column does not exist" as a 500 that says nothing about what was asked.
 *
 * The in-memory store is `available`: it applies the same rule in JS over the
 * domain field `statementPaymentId`.
 */
export type CompetenciaAvailability = 'available' | 'unavailable';

/**
 * Typed refusal for `basis=competencia` on the legacy dialect. It reuses H-10's
 * `analytics.basis_unsupported` code on purpose — that is the contract clients
 * already know as "this basis cannot be applied here" — while the message names
 * the real reason (the canonical link does not exist), not "this route has no
 * basis surface".
 */
export const legacyCompetenciaRefusal = (): { code: string; message: string } => ({
  code: 'analytics.basis_unsupported',
  message:
    'basis=competencia is unavailable on the legacy analytics dialect: transactions.statement_payment_id (V056) is canonical-only.',
});

/**
 * G-A predicate, mirrored in SQL and in the store loop.
 *
 * `competencia` removes rows that ARE a statement payment
 * (`statement_payment_id`, V056) from the EXPENSE aggregate. The purchase stays
 * on its purchase date, so the invoice is counted once (in the cycle it was
 * bought) instead of twice (purchase + payment). Income is untouched, and
 * `liquidez` adds no predicate at all - the default query is unchanged.
 */
const excludesExpense = (kind: Transaction['kind']): boolean => kind !== 'expense';

const isStatementPayment = (tx: Transaction): boolean =>
  (tx as Transaction & { statementPaymentId?: string }).statementPaymentId !== undefined;

/** Store-loop twin of the SQL predicate above; same rule, same effect. */
const keepForBasis = (tx: Transaction, basis: AnalyticsBasis): boolean =>
  basis !== 'competencia' || excludesExpense(tx.kind) || !isStatementPayment(tx);

export type DomainLists = {
  bankAccounts: Account[];
  cards: Account[];
  categories: Category[];
  statements: Statement[];
  subscriptions: Subscription[];
  budgets: BudgetStatus[];
  recurring: RecurringPurchase[];
};

/**
 * H-10: explicit account universe for every analytics computation.
 *
 * `household` aggregates the whole household; `account` restricts to one
 * account. Sources that support an account MUST take this (not an optional
 * `accountId?` that callers can forget); entity lists stay household-wide
 * and routes apply the scope when reducing. Subscriptions and budgets are
 * declared household-only (see SUBSCRIPTIONS_ACCOUNT_SCOPE in compute.ts):
 * they have no account relation, so an account scope never filters them —
 * routes must say so explicitly instead of mixing universes.
 */
export type AccountScope = { kind: 'household' } | { kind: 'account'; accountId: string };

export const householdScope = (): AccountScope => ({ kind: 'household' });

export const accountScope = (accountId: string): AccountScope => ({ kind: 'account', accountId });

export const scopeAccountId = (scope: AccountScope): string | undefined =>
  scope.kind === 'account' ? scope.accountId : undefined;

export const scopeFromQuery = (accountId?: string): AccountScope =>
  accountId ? accountScope(accountId) : householdScope();

export type AnalyticsSource = {
  /** G-A: declared capability, so a refusal happens before any query. */
  readonly competenciaBasis: CompetenciaAvailability;
  loadLists(householdId: string): Promise<DomainLists>;
  sumByKind(
    householdId: string,
    from: string,
    to: string,
    scope: AccountScope,
    options?: AnalyticsReadOptions,
  ): Promise<KindSum>;
  dailySums(
    householdId: string,
    from: string,
    to: string,
    scope: AccountScope,
    options?: AnalyticsReadOptions,
  ): Promise<DailySum[]>;
  categorySums(
    householdId: string,
    from: string,
    to: string,
    kind: 'expense' | 'income',
    scope: AccountScope,
    options?: AnalyticsReadOptions,
  ): Promise<CategorySum[]>;
  monthlyFlows(householdId: string, sinceMonth: string, scope: AccountScope): Promise<MonthlyFlow[]>;
};

export type StoreBackedDeps = {
  store: ReadModelStore;
  cardStore?: CardStore;
  budgetStore?: BudgetStore;
  subscriptionStore?: SubscriptionStore;
};

export const createStoreAnalyticsSource = (deps: StoreBackedDeps): AnalyticsSource => {
  const loadLists = async (householdId: string): Promise<DomainLists> => {
    const [accounts, categories, statements, subscriptions, budgets, recurring, cards] = await Promise.all([
      deps.store.listAccounts(householdId),
      deps.store.listCategories(householdId),
      deps.cardStore ? deps.cardStore.listStatements(householdId) : Promise.resolve([]),
      deps.subscriptionStore ? deps.subscriptionStore.listSubscriptions(householdId, 'active') : Promise.resolve([]),
      deps.budgetStore ? deps.budgetStore.listBudgets(householdId) : Promise.resolve([]),
      deps.cardStore ? deps.cardStore.listRecurringPurchases(householdId, { status: 'active' }) : Promise.resolve([]),
      deps.cardStore ? deps.cardStore.listCreditCardAccounts(householdId) : Promise.resolve([]),
    ]);
    return { bankAccounts: accounts, cards, categories, statements, subscriptions, budgets, recurring };
  };

  // Range-bounded reads page through the 200-row filter limit instead of
  // fetching everything at once.
  const rangeTransactions = async (householdId: string, from: string, to: string, scope: AccountScope) => {
    const items: Awaited<ReturnType<ReadModelStore['listTransactions']>>['items'] = [];
    const accountId = scopeAccountId(scope);
    for (let offset = 0; ; offset += 200) {
      const page = await deps.store.listTransactions(householdId, {
        startDate: from,
        endDate: to,
        ...(accountId ? { accountId } : {}),
        limit: 200,
        offset,
      });
      items.push(...page.items);
      if (page.items.length < 200) break;
    }
    return items;
  };

  return {
    // The store loop applies the G-A rule in JS, so `competencia` is available
    // here regardless of which SQL dialect backs the deployment.
    competenciaBasis: 'available',
    loadLists,
    async sumByKind(householdId, from, to, scope, options) {
      const basis = resolveBasis(options);
      const items = (await rangeTransactions(householdId, from, to, scope)).filter((tx) => keepForBasis(tx, basis));
      // G-B: the addends are summed in BigInt so a total above 2^53 keeps its
      // exact decimal; inside the safe integer the number is unchanged.
      return {
        income: sumCents(items.filter((tx) => tx.kind === 'income').map((tx) => tx.amountCents)),
        expense: sumCents(items.filter((tx) => tx.kind === 'expense').map((tx) => tx.amountCents)),
        transactionCount: items.filter((tx) => tx.kind === 'income' || tx.kind === 'expense').length,
      };
    },
    async dailySums(householdId, from, to, scope, options) {
      const basis = resolveBasis(options);
      const items = (await rangeTransactions(householdId, from, to, scope)).filter((tx) => keepForBasis(tx, basis));
      const byDay = new Map<string, { date: string; income: number[]; expense: number[] }>();
      for (const tx of items) {
        if (tx.kind !== 'income' && tx.kind !== 'expense') continue;
        const slot = byDay.get(tx.date) ?? { date: tx.date, income: [], expense: [] };
        (tx.kind === 'income' ? slot.income : slot.expense).push(tx.amountCents);
        byDay.set(tx.date, slot);
      }
      return [...byDay.values()]
        .map((slot) => ({
          date: slot.date,
          income: sumCents(slot.income),
          expense: sumCents(slot.expense),
          transactionCount: slot.income.length + slot.expense.length,
        }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    },
    async categorySums(householdId, from, to, kind, scope, options) {
      const basis = resolveBasis(options);
      const items = (await rangeTransactions(householdId, from, to, scope)).filter((tx) => keepForBasis(tx, basis));
      const totals = new Map<string, number[]>();
      for (const tx of items) {
        if (tx.kind !== kind || !tx.categoryId) continue;
        const bucket = totals.get(tx.categoryId) ?? [];
        bucket.push(tx.amountCents);
        totals.set(tx.categoryId, bucket);
      }
      return [...totals.entries()].map(([categoryId, values]) => ({
        categoryId,
        total: sumCents(values),
        transactionCount: values.length,
      }));
    },
    async monthlyFlows(householdId, sinceMonth, scope) {
      const items: Awaited<ReturnType<ReadModelStore['listTransactions']>>['items'] = [];
      const accountId = scopeAccountId(scope);
      for (let offset = 0; ; offset += 200) {
        const page = await deps.store.listTransactions(householdId, {
          startDate: `${sinceMonth}-01`,
          ...(accountId ? { accountId } : {}),
          limit: 200,
          offset,
        });
        items.push(...page.items);
        if (page.items.length < 200) break;
      }
      const byMonth = new Map<string, { month: string; income: number[]; expense: number[] }>();
      for (const tx of items) {
        if (tx.kind !== 'income' && tx.kind !== 'expense') continue;
        const month = tx.date.slice(0, 7);
        const slot = byMonth.get(month) ?? { month, income: [], expense: [] };
        (tx.kind === 'income' ? slot.income : slot.expense).push(tx.amountCents);
        byMonth.set(month, slot);
      }
      return [...byMonth.values()]
        .map((slot) => ({
          month: slot.month,
          income: sumCents(slot.income),
          expense: sumCents(slot.expense),
          transactionCount: slot.income.length + slot.expense.length,
        }))
        .sort((a, b) => (a.month < b.month ? -1 : 1));
    },
  };
};

/**
 * Aggregate SQL implementation. `legacy=true` switches account scoping to
 * the legacy from/to_account_id columns; the canonical schema uses
 * account_id. Both share household + soft-delete + date filters, and both read
 * monthly flows from the START only (no upper bound — routes declare that).
 *
 * `legacy=true` also means V056 is absent, so `competenciaBasis` is
 * `unavailable` there: see `legacyCompetenciaRefusal`.
 */
export const createSqlAnalyticsSource = (
  pool: AnalyticsPool,
  opts: { legacy?: boolean; stores: StoreBackedDeps },
): AnalyticsSource => {
  const fallback = createStoreAnalyticsSource(opts.stores);
  const accountFilter = (alias: string, index: number, accountId?: string): { clause: string; values: unknown[] } => {
    if (!accountId) return { clause: '', values: [] };
    if (opts.legacy) {
      return { clause: `AND (${alias}.from_account_id = $${index} OR ${alias}.to_account_id = $${index})`, values: [accountId] };
    }
    return { clause: `AND ${alias}.account_id = $${index}`, values: [accountId] };
  };

  /**
   * G-A in SQL. `liquidez` adds NO predicate, so the default query text is
   * unchanged. `competencia` drops expense rows that are a statement payment
   * (V056); the purchase itself is untouched and stays on its own date.
   *
   * On the legacy dialect there is no such column, so the request is refused
   * with the same typed contract the route uses — fail-closed, BEFORE the
   * query exists. The route already refuses earlier; this keeps any other
   * caller from handing the database a column it does not have.
   */
  const basisFilter = (alias: string, basis: AnalyticsBasis): string => {
    if (basis !== 'competencia') return '';
    if (opts.legacy) {
      const refusal = legacyCompetenciaRefusal();
      throw Object.assign(new Error(refusal.message), { statusCode: 400, code: refusal.code });
    }
    return `AND (${alias}.kind <> 'expense' OR ${alias}.statement_payment_id IS NULL)`;
  };

  return {
    competenciaBasis: opts.legacy ? 'unavailable' : 'available',
    loadLists: fallback.loadLists,
    async sumByKind(householdId, from, to, scope, options) {
      const basis = resolveBasis(options);
      const filter = accountFilter('t', 4, scopeAccountId(scope));
      const res = await pool.query(
        `SELECT t.kind AS kind, SUM(t.amount_cents)::text AS total, COUNT(*)::int AS rows
           FROM transactions t
          WHERE t.household_id = $1 AND t.deleted_at IS NULL
            AND t.date >= $2 AND t.date <= $3 ${basisFilter('t', basis)} ${filter.clause}
          GROUP BY t.kind`,
        [householdId, from, to, ...filter.values],
      );
      let income: Cents = { cents: 0 };
      let expense: Cents = { cents: 0 };
      let transactionCount = 0;
      for (const row of res.rows) {
        const kind = row['kind'];
        if (kind !== 'income' && kind !== 'expense') continue;
        const total = centsFromSqlText(row['total']);
        if (kind === 'income') income = total;
        else expense = total;
        transactionCount += Number(row['rows'] ?? 0);
      }
      return { income, expense, transactionCount };
    },
    async dailySums(householdId, from, to, scope, options) {
      const basis = resolveBasis(options);
      const filter = accountFilter('t', 4, scopeAccountId(scope));
      const res = await pool.query(
        `SELECT t.date::text AS date,
                SUM(CASE WHEN t.kind = 'income' THEN t.amount_cents ELSE 0 END)::text AS income,
                SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)::text AS expense,
                COUNT(*) FILTER (WHERE t.kind IN ('income', 'expense'))::int AS rows
           FROM transactions t
          WHERE t.household_id = $1 AND t.deleted_at IS NULL
            AND t.date >= $2 AND t.date <= $3 ${basisFilter('t', basis)} ${filter.clause}
          GROUP BY t.date ORDER BY t.date`,
        [householdId, from, to, ...filter.values],
      );
      return res.rows.map((row) => ({
        date: String(row['date']).slice(0, 10),
        income: centsFromSqlText(row['income']),
        expense: centsFromSqlText(row['expense']),
        transactionCount: Number(row['rows'] ?? 0),
      }));
    },
    async categorySums(householdId, from, to, kind, scope, options) {
      const basis = resolveBasis(options);
      const filter = accountFilter('t', 5, scopeAccountId(scope));
      const res = await pool.query(
        `SELECT t.category_id AS category_id, SUM(t.amount_cents)::text AS total, COUNT(*)::int AS rows
           FROM transactions t
          WHERE t.household_id = $1 AND t.deleted_at IS NULL
            AND t.date >= $2 AND t.date <= $3 AND t.kind = $4
            AND t.category_id IS NOT NULL ${basisFilter('t', basis)} ${filter.clause}
          GROUP BY t.category_id`,
        [householdId, from, to, kind, ...filter.values],
      );
      return res.rows.map((row) => ({
        categoryId: String(row['category_id']),
        total: centsFromSqlText(row['total']),
        transactionCount: Number(row['rows'] ?? 0),
      }));
    },
    async monthlyFlows(householdId, sinceMonth, scope) {
      const filter = accountFilter('t', 3, scopeAccountId(scope));
      const res = await pool.query(
        `SELECT to_char(t.date, 'YYYY-MM') AS month,
                SUM(CASE WHEN t.kind = 'income' THEN t.amount_cents ELSE 0 END)::text AS income,
                SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)::text AS expense,
                COUNT(*) FILTER (WHERE t.kind IN ('income', 'expense'))::int AS rows
           FROM transactions t
          WHERE t.household_id = $1 AND t.deleted_at IS NULL AND t.date >= $2 ${filter.clause}
          GROUP BY 1 ORDER BY 1`,
        [householdId, `${sinceMonth}-01`, ...filter.values],
      );
      return res.rows.map((row) => ({
        month: String(row['month']),
        income: centsFromSqlText(row['income']),
        expense: centsFromSqlText(row['expense']),
        transactionCount: Number(row['rows'] ?? 0),
      }));
    },
  };
};
