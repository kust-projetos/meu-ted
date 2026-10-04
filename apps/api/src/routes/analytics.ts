/**
 * Analytics read endpoints (item 14, etapa A). All GET, workspace-scoped
 * via device token, household derived server-side. Optional ?period=
 * (last30days|lastMonth|thisYear|custom), ?from/?to= for custom,
 * ?accountId= to scope, ?kind= for the category breakdown.
 *
 * G03 (SPEC adendo 11.1) adds two things, both ADDITIVE and both opt-in:
 * - `?basis=liquidez|competencia` on the expense aggregates. Omission is
 *   `liquidez` - the current behaviour, byte for byte.
 * - a proof envelope on all six routes: `transactionCount`, `asOf`, `basis`,
 *   `semanticsVersion`, `effectiveFilter` and `emptyReason` (SPEC 11.1.3).
 *
 * Two invariants this file must keep:
 * - **The default never moves.** Every pre-existing field keeps its value and
 *   its type; new fields only appear.
 * - **A failed read is never a zero.** Errors leave through `handleError` with
 *   their status; they are never converted into a 200 with `totalCents: 0`
 *   (R04/R09). An empty window is an empty 200 with `emptyReason`.
 */

import type { FastifyInstance } from 'fastify';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { AuthResolver } from './auth.js';
import type { AnalyticsSource } from '../analytics/source.js';
import {
  buildBudgetConsumption,
  buildCashflowSeries,
  buildCategoryBreakdown,
  buildDailyHeatmap,
  buildFixedVsDiscretionary,
  buildNetWorthHistory,
  heatmapWindowStart,
  previousRangeOf,
  resolveRange,
  savingsRatePct,
  statementRemaining,
  statementsDueSoon,
  isOpenStatement,
  toISODate,
} from '../analytics/compute.js';
import { legacyCompetenciaRefusal, scopeFromQuery } from '../analytics/source.js';
import {
  ANALYTICS_SEMANTICS_VERSION,
  DEFAULT_ANALYTICS_BASIS,
  analyticsQuerySchema,
  categoryBreakdownQuerySchema,
  type AnalyticsBasis,
  type AnalyticsEffectiveFilter,
  type AnalyticsEmptyReason,
  type AnalyticsProofEnvelope,
} from '../analytics/types.js';
import { exactCentsCompanion } from '../analytics/exact.js';

export type AnalyticsRouteDeps = {
  source: AnalyticsSource;
  resolveToken: AuthResolver;
  clock?: () => Date;
};

export const DUE_SOON_DAYS = 3;
export const SAVINGS_TARGET_PCT = 20;
export const NET_WORTH_MONTHS = 12;

export const registerAnalyticsRoutes = (app: FastifyInstance, opts: AnalyticsRouteDeps): void => {
  const resolve = async (req: import('fastify').FastifyRequest) => {
    if (req.authenticatedContext) return req.authenticatedContext;
    const token = req.headers[DEVICE_TOKEN_HEADER];
    return opts.resolveToken(Array.isArray(token) ? token[0] : token);
  };
  const handleError = (err: unknown, reply: import('fastify').FastifyReply) => {
    if ((err as { statusCode?: number }).statusCode) {
      const e = err as { statusCode: number; code: string; message: string };
      return reply.code(e.statusCode).send({ code: e.code, message: e.message });
    }
    throw err;
  };
  /**
   * One instant per read: every handler takes `readAt` once, so `asOf` and the
   * dates derived from it cannot disagree (a request that crossed midnight
   * would otherwise report a period and an `asOf` from different days).
   */
  const nowOf = (): Date => (opts.clock ? opts.clock() : new Date());

  /**
   * G-C: `emptyReason` is a CLOSED, conclusive reason - never a guess and never
   * a stand-in for a failure. The rule is about the DATA, not about the shape
   * of the payload: routes that always paint (a daily series, a 4x7 heatmap,
   * 12 net-worth months) still say "no transactions in the period" when
   * `transactionCount` is 0, because that is the fact a consumer needs.
   *
   * Each aggregate names its own universe, because they differ: `kpis` counts
   * income+expense rows, `category-breakdown` only counts the ones WITH a
   * category, and `budget-consumption` reads no transactions at all. Claiming
   * "no transactions" for a breakdown that simply has nothing categorised would
   * be a wrong reason, not a coarse one.
   *
   * A timeout or 403 never reaches this function: it leaves through
   * `handleError` with its status code and is never turned into a zero.
   */
  const emptyReasonFor = (
    transactionCount: number,
    aggregate: 'transactions' | 'categorised_transactions' | 'budgets',
  ): AnalyticsEmptyReason | null => {
    if (transactionCount > 0) return null;
    if (aggregate === 'budgets') return 'no_budgets';
    if (aggregate === 'categorised_transactions') return 'no_categorised_transactions_in_period';
    return 'no_transactions_in_period';
  };

  const proof = (
    input: {
      transactionCount: number;
      asOf: string;
      basis: AnalyticsBasis;
      effectiveFilter: AnalyticsEffectiveFilter;
      aggregate?: 'transactions' | 'categorised_transactions';
    },
  ): AnalyticsProofEnvelope => ({
    transactionCount: input.transactionCount,
    asOf: input.asOf,
    basis: input.basis,
    semanticsVersion: ANALYTICS_SEMANTICS_VERSION,
    effectiveFilter: input.effectiveFilter,
    emptyReason: emptyReasonFor(input.transactionCount, input.aggregate ?? 'transactions'),
  });

  /**
   * Routes whose aggregation is NOT a `basis` surface (SPEC 11.1.1 lists only
   * the four expense aggregates). An explicit `basis` there is refused with a
   * typed code instead of ignored: `net-worth-history` reads monthly flows and
   * `budget-consumption` reads no transactions at all, so accepting the
   * parameter and answering under `liquidez` would hand back a number whose
   * meaning the caller did not ask for. Omitting it stays valid.
   */
  const refuseUnsupportedBasis = (
    basis: AnalyticsBasis | undefined,
    path: string,
  ): { code: string; message: string } | null =>
    basis === undefined
      ? null
      : {
          code: 'analytics.basis_unsupported',
          message: `${path} does not apply the expense basis; basis is not supported here.`,
        };

  /**
   * G-A: `competencia` needs the canonical statement-payment link
   * (`statement_payment_id`, V056), which the LEGACY dialect does not have. A
   * source built with `legacy: true` declares that, and the request is refused
   * with H-10's typed code BEFORE any query is assembled — instead of letting
   * the database answer "column does not exist" (a 500 that says nothing about
   * the basis the caller asked for). `liquidez` and omission are untouched.
   */
  const refuseUnavailableBasis = (basis: AnalyticsBasis | undefined): { code: string; message: string } | null =>
    basis === 'competencia' && opts.source.competenciaBasis === 'unavailable' ? legacyCompetenciaRefusal() : null;

  app.get('/analytics/kpis', async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = analyticsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    const basisRefusal = refuseUnavailableBasis(parsed.data.basis);
    if (basisRefusal) return reply.code(400).send(basisRefusal);
    try {
      const basis = parsed.data.basis ?? DEFAULT_ANALYTICS_BASIS;
      // One instant per read: `asOf` and every date derived from `today` agree
      // even if the clock ticks across midnight mid-request.
      const readAt = nowOf();
      const asOf = readAt.toISOString();
      const readToday = toISODate(readAt);
      const range = resolveRange(parsed.data.period, readToday, parsed.data.from, parsed.data.to);
      const previous = previousRangeOf(range);
      const accountId = parsed.data.accountId;
      const scope = scopeFromQuery(accountId);
      const [lists, now, before] = await Promise.all([
        opts.source.loadLists(ctx.householdId),
        opts.source.sumByKind(ctx.householdId, range.from, range.to, scope, { basis }),
        opts.source.sumByKind(ctx.householdId, previous.from, previous.to, scope, { basis }),
      ]);
      const inScopeAccount = (id: string): boolean => !accountId || id === accountId;
      const accountsTotalCents = lists.bankAccounts
        .filter((account) => inScopeAccount(account.id))
        .reduce((sum, account) => sum + account.balanceCents, 0);
      const openStatements = lists.statements.filter((s) => isOpenStatement(s) && inScopeAccount(s.accountId));
      const dueSoonCents = statementsDueSoon(openStatements, readToday, DUE_SOON_DAYS).reduce(
        (sum, s) => sum + statementRemaining(s),
        0,
      );
      const committedCents = openStatements.reduce((sum, s) => sum + statementRemaining(s), 0);
      const limitCents = lists.cards
        .filter((card) => inScopeAccount(card.id))
        .reduce((sum, card) => sum + (card.creditLimitCents ?? 0), 0);
      const fixed = buildFixedVsDiscretionary(
        lists.subscriptions,
        lists.recurring,
        scope,
        now.expense.cents,
        now.income.cents,
      );
      return reply.code(200).send({
        period: range,
        previousPeriod: previous,
        netLiquidBalanceCents: accountsTotalCents - dueSoonCents,
        accountsTotalCents,
        dueSoonCents,
        openInvoices: {
          committedCents,
          limitCents,
          utilizationPct: limitCents > 0 ? Math.round((committedCents / limitCents) * 1000) / 10 : null,
        },
        savingsRatePct: savingsRatePct(now.income.cents, now.expense.cents),
        savingsRateTargetPct: SAVINGS_TARGET_PCT,
        previousSavingsRatePct: savingsRatePct(before.income.cents, before.expense.cents),
        fixedVsDiscretionary: {
          scope: fixed.scope,
          fixedCents: fixed.fixedCents,
          discretionaryCents: fixed.discretionaryCents,
          fixedPctOfIncome: fixed.fixedPctOfIncome,
          subscriptionsCents: fixed.subscriptionsCents,
        },
        incomeCents: now.income.cents,
        ...exactCentsCompanion('incomeCents', now.income),
        expenseCents: now.expense.cents,
        ...exactCentsCompanion('expenseCents', now.expense),
        previousIncomeCents: before.income.cents,
        ...exactCentsCompanion('previousIncomeCents', before.income),
        previousExpenseCents: before.expense.cents,
        ...exactCentsCompanion('previousExpenseCents', before.expense),
        netWorthCents: accountsTotalCents - committedCents,
        // G-C: `transactionCount` counts the income/expense rows the aggregate
        // really read (transfers are never summed, so they are not counted).
        ...proof(
          {
            transactionCount: now.transactionCount,
            asOf,
            basis,
            effectiveFilter: {
              period: parsed.data.period ?? 'last30days',
              from: range.from,
              to: range.to,
              accountId: accountId ?? null,
            },
          },
        ),
      });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/analytics/cashflow-series', async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = analyticsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    const basisRefusal = refuseUnavailableBasis(parsed.data.basis);
    if (basisRefusal) return reply.code(400).send(basisRefusal);
    try {
      const basis = parsed.data.basis ?? DEFAULT_ANALYTICS_BASIS;
      const readAt = nowOf();
      const asOf = readAt.toISOString();
      const range = resolveRange(parsed.data.period, toISODate(readAt), parsed.data.from, parsed.data.to);
      const previous = previousRangeOf(range);
      const scope = scopeFromQuery(parsed.data.accountId);
      const [current, prev] = await Promise.all([
        opts.source.dailySums(ctx.householdId, range.from, range.to, scope, { basis }),
        opts.source.dailySums(ctx.householdId, previous.from, previous.to, scope, { basis }),
      ]);
      const transactionCount = current.reduce((sum, day) => sum + day.transactionCount, 0);
      return reply.code(200).send({
        ...buildCashflowSeries(range, previous, current, prev),
        // G-C: the series always paints one point per day, so an empty window is
        // still a payload - the proof is `transactionCount`, not the array.
        ...proof(
          {
            transactionCount,
            asOf,
            basis,
            effectiveFilter: {
              period: parsed.data.period ?? 'last30days',
              from: range.from,
              to: range.to,
              accountId: parsed.data.accountId ?? null,
            },
          },
        ),
      });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/analytics/category-breakdown', async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = categoryBreakdownQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    const basisRefusal = refuseUnavailableBasis(parsed.data.basis);
    if (basisRefusal) return reply.code(400).send(basisRefusal);
    try {
      const basis = parsed.data.basis ?? DEFAULT_ANALYTICS_BASIS;
      const readAt = nowOf();
      const asOf = readAt.toISOString();
      const range = resolveRange(parsed.data.period, toISODate(readAt), parsed.data.from, parsed.data.to);
      const kind = parsed.data.kind ?? 'expense';
      const [sums, lists] = await Promise.all([
        opts.source.categorySums(
          ctx.householdId,
          range.from,
          range.to,
          kind,
          scopeFromQuery(parsed.data.accountId),
          { basis },
        ),
        opts.source.loadLists(ctx.householdId),
      ]);
      // `categorySums` reads only categorised rows, so an uncategorised expense
      // is absent from both the total and the count. The envelope makes that
      // divergence from `kpis` observable instead of silent.
      const transactionCount = sums.reduce((sum, entry) => sum + entry.transactionCount, 0);
      return reply.code(200).send({
        ...buildCategoryBreakdown(sums, lists.categories, range, kind),
        ...proof(
          {
            transactionCount,
            asOf,
            basis,
            aggregate: 'categorised_transactions',
            effectiveFilter: {
              period: parsed.data.period ?? 'last30days',
              from: range.from,
              to: range.to,
              accountId: parsed.data.accountId ?? null,
              kind,
            },
          },
        ),
      });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/analytics/budget-consumption', async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = analyticsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    // H-10: budgets aggregate categories household-wide (spent has no
    // account dimension), so this endpoint is formally household-only. An
    // explicit account filter is rejected instead of silently ignored.
    if (parsed.data.accountId) {
      return reply.code(400).send({
        code: 'analytics.account_scope_unsupported',
        message: 'budget-consumption is household-only; accountId is not supported.',
      });
    }
    // Same discipline for `basis`: spentCents comes from the budget store, not
    // from `transactions`, so the parameter has no meaning here. Ignoring it
    // would answer `competencia` with `liquidez` numbers and label them
    // `liquidez` in the envelope — the silent-swap class the envelope exists to
    // prevent (spike §3.1).
    const basisRefusal = refuseUnsupportedBasis(parsed.data.basis, 'budget-consumption');
    if (basisRefusal) return reply.code(400).send(basisRefusal);
    try {
      const asOf = (nowOf()).toISOString();
      const lists = await opts.source.loadLists(ctx.householdId);
      const items = buildBudgetConsumption(lists.budgets);
      return reply.code(200).send({
        items,
        total: items.length,
        scope: 'household',
        // G-C: this route reads NO transactions (spentCents comes from the
        // budget store), so the count is honestly 0 and the empty reason names
        // budgets, never "no transactions". It also applies no period filter:
        // budget status is "as of now", which the envelope declares as nulls.
        transactionCount: 0,
        semanticsVersion: ANALYTICS_SEMANTICS_VERSION,
        asOf,
        basis: DEFAULT_ANALYTICS_BASIS,
        effectiveFilter: { period: null, from: null, to: null, accountId: null },
        emptyReason: items.length > 0 ? null : emptyReasonFor(0, 'budgets'),
      });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/analytics/daily-heatmap', async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = analyticsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    const basisRefusal = refuseUnavailableBasis(parsed.data.basis);
    if (basisRefusal) return reply.code(400).send(basisRefusal);
    try {
      const basis = parsed.data.basis ?? DEFAULT_ANALYTICS_BASIS;
      const readAt = nowOf();
      const asOf = readAt.toISOString();
      const end = parsed.data.to ?? toISODate(readAt);
      const scope = scopeFromQuery(parsed.data.accountId);
      // The read window IS the grid window. The grid discards every day before
      // its start, so reading the wider 35-day window only produced rows that
      // `transactionCount` counted and no cell ever painted — the shape that
      // allowed "every cell zero" with `emptyReason: null`. One window now:
      // read, declared and painted by the same rule.
      const windowStart = heatmapWindowStart(end);
      const sums = await opts.source.dailySums(ctx.householdId, windowStart, end, scope, { basis });
      const transactionCount = sums.reduce((sum, day) => sum + day.transactionCount, 0);
      return reply.code(200).send({
        ...buildDailyHeatmap(sums, end),
        // G-C: the grid is always 4x7 painted cells, so it is never "empty";
        // `transactionCount` is what tells a reader whether anything happened.
        ...proof(
          {
            transactionCount,
            asOf,
            basis,
            effectiveFilter: {
              // `period` is NOT applied (the window is the fixed 4x7 grid ending
              // at `to`), but `from`/`to` ARE — and they are the grid's own
              // bounds, so the count and the cells describe one universe.
              period: null,
              from: windowStart,
              to: end,
              accountId: parsed.data.accountId ?? null,
            },
          },
        ),
      });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/analytics/net-worth-history', async (req, reply) => {
    let ctx;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = analyticsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      // `basis` is not a surface here: monthly flows stay on `liquidez` by
      // design (SPEC 11.1.1 lists only the four expense aggregates), and an
      // explicit request is refused rather than quietly reinterpreted.
      const basisRefusal = refuseUnsupportedBasis(parsed.data.basis, 'net-worth-history');
      if (basisRefusal) return reply.code(400).send(basisRefusal);
      const readAt = nowOf();
      const asOf = readAt.toISOString();
      const now = toISODate(readAt);
      const since = addMonths(now.slice(0, 7), -(NET_WORTH_MONTHS - 1));
      const scope = scopeFromQuery(parsed.data.accountId);
      const [lists, flows] = await Promise.all([
        opts.source.loadLists(ctx.householdId),
        opts.source.monthlyFlows(ctx.householdId, since, scope),
      ]);
      const inScope = (id: string): boolean => !parsed.data.accountId || id === parsed.data.accountId;
      const accountsTotal = lists.bankAccounts.filter((a) => inScope(a.id)).reduce((s, a) => s + a.balanceCents, 0);
      const committed = lists.statements
        .filter((s) => isOpenStatement(s) && inScope(s.accountId))
        .reduce((s, st) => s + statementRemaining(st), 0);
      const transactionCount = flows.reduce((sum, flow) => sum + flow.transactionCount, 0);
      return reply.code(200).send({
        months: buildNetWorthHistory(accountsTotal - committed, flows, now, NET_WORTH_MONTHS),
        // G-C: `basis` is `liquidez` here BY DESIGN - net worth reconstructs from
        // monthly flows, which are not a `basis` surface (SPEC 11.1.1 lists only
        // the four expense aggregates). Declared rather than left undefined.
        ...proof(
          {
            transactionCount,
            asOf,
            basis: DEFAULT_ANALYTICS_BASIS,
            effectiveFilter: {
              period: null,
              from: `${since}-01`,
              // `monthlyFlows` filters ONLY the start (both the store loop and
              // the SQL), so no upper bound is applied: declaring `now` would
              // claim a filter the source never made, and a future-dated row
              // would be counted as if it sat inside the window. `null` is the
              // honest reading of "not applied".
              to: null,
              accountId: parsed.data.accountId ?? null,
            },
          },
        ),
      });
    } catch (e) {
      return handleError(e, reply);
    }
  });
};

const addMonths = (yearMonth: string, delta: number): string => {
  const cursor = new Date(`${yearMonth}-01T00:00:00.000Z`);
  cursor.setUTCMonth(cursor.getUTCMonth() + delta);
  return toISODate(cursor).slice(0, 7);
};
