/**
 * Pure analytics computations (item 14, etapa A). These functions operate on
 * aggregate outputs from `AnalyticsSource` (daily/category/monthly sums plus
 * small entity lists), so the same code serves every backend: the
 * per-backend sources decide how inputs are loaded (in-memory loops vs
 * aggregate SQL).
 */

import type { BudgetStatus, Category, RecurringPurchase, Statement, Subscription } from '../types/domain.js';
import type {
  AnalyticsRange,
  BudgetConsumptionItem,
  CashflowSeries,
  CategoryBreakdown,
  CategorySlice,
  DailyHeatmap,
  FixedVsDiscretionary,
  HeatmapDay,
  MoneyPoint,
  NetWorthPoint,
} from './types.js';
import type { AccountScope, CategorySum, DailySum, MonthlyFlow } from './source.js';
import { exactCentsCompanion, mergeCents, type Cents } from './exact.js';

export const toISODate = (date: Date): string => date.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toISODate(date);
};

const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

export const resolveRange = (
  period: 'last30days' | 'lastMonth' | 'thisYear' | 'custom' | undefined,
  today: string,
  from?: string,
  to?: string,
): AnalyticsRange => {
  const kind = period ?? 'last30days';
  if (kind === 'custom') return { from: from as string, to: to as string };
  if (kind === 'lastMonth') {
    const first = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
    first.setUTCMonth(first.getUTCMonth() - 1);
    return { from: toISODate(first), to: addDays(`${today.slice(0, 7)}-01`, -1) };
  }
  if (kind === 'thisYear') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return { from: addDays(today, -29), to: today };
};

/** Same-length range immediately before `range` (for deltas/overlays). */
export const previousRangeOf = (range: AnalyticsRange): AnalyticsRange => {
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
};

export const savingsRatePct = (incomeCents: number, expenseCents: number): number | null => {
  if (incomeCents <= 0) return null;
  return Math.round(((incomeCents - expenseCents) / incomeCents) * 1000) / 10;
};

/** Monthly-normalized fixed costs: subscriptions + active card recurrings. */
export const MONTHLY_FACTOR: Record<string, number> = { weekly: 30 / 7, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

export const normalizeMonthly = (amountCents: number, cycle: string): number =>
  Math.round(amountCents * (MONTHLY_FACTOR[cycle] ?? 1));

/**
 * H-10: subscriptions have no account relation anywhere in the domain
 * (see Subscription in types/domain.ts) — they are formally
 * household-only. Recurring purchases DO carry accountId and follow the
 * AccountScope. This constant is the single declaration both routes and
 * tests reference; `householdSubscriptions` asserts it at runtime so a
 * future schema addition cannot silently change the universe.
 */
export const SUBSCRIPTIONS_ACCOUNT_SCOPE = 'household' as const;

export const assertHouseholdOnlySubscriptions = (subscriptions: Subscription[]): void => {
  for (const sub of subscriptions) {
    if ('accountId' in (sub as Record<string, unknown>)) {
      throw new Error('analytics.scope_violation: subscriptions must stay household-only');
    }
  }
};

export const householdSubscriptionsMonthly = (subscriptions: Subscription[]): number => {
  assertHouseholdOnlySubscriptions(subscriptions);
  return subscriptions.reduce((sum, sub) => sum + normalizeMonthly(sub.amountCents, sub.cycle), 0);
};

export const scopedRecurringMonthly = (recurring: RecurringPurchase[], scope: AccountScope): number =>
  recurring.reduce(
    (sum, rec) =>
      rec.status === 'active' && (scope.kind === 'household' || rec.accountId === scope.accountId)
        ? sum + normalizeMonthly(rec.amountCents, rec.frequency)
        : sum,
    0,
  );

/**
 * Fixed-vs-discretionary under one explicit universe. Household scope
 * keeps the legacy total (subscriptions + active recurrings). Account
 * scope uses the account's active recurrings only — subscriptions are
 * household-wide and reported separately in `subscriptionsCents` instead
 * of being mixed into an account total.
 */
export const buildFixedVsDiscretionary = (
  subscriptions: Subscription[],
  recurring: RecurringPurchase[],
  scope: AccountScope,
  expenseCents: number,
  incomeCents: number,
): FixedVsDiscretionary => {
  const subscriptionsCents = householdSubscriptionsMonthly(subscriptions);
  const fixedCents =
    scope.kind === 'household'
      ? subscriptionsCents + scopedRecurringMonthly(recurring, scope)
      : scopedRecurringMonthly(recurring, scope);
  return {
    scope: scope.kind,
    fixedCents,
    discretionaryCents: Math.max(0, expenseCents - fixedCents),
    fixedPctOfIncome: incomeCents > 0 ? Math.round((fixedCents / incomeCents) * 1000) / 10 : null,
    subscriptionsCents,
  };
};

export const statementRemaining = (statement: Pick<Statement, 'totalCents' | 'paidCents'>): number =>
  Math.max(0, statement.totalCents - statement.paidCents);

export const isOpenStatement = (statement: Pick<Statement, 'status'>): boolean =>
  statement.status === 'open' ||
  statement.status === 'closed' ||
  statement.status === 'overdue' ||
  statement.status === 'partial';

/** Open statements due within `withinDays` days from `today` (inclusive). */
export const statementsDueSoon = <T extends Pick<Statement, 'status' | 'dueDate'>>(
  statements: T[],
  today: string,
  withinDays: number,
): T[] => {
  const limit = addDays(today, withinDays);
  return statements.filter((s) => isOpenStatement(s) && s.dueDate >= today && s.dueDate <= limit);
};

const accumulateDaily = (slot: AnalyticsRange, sums: DailySum[]): MoneyPoint[] => {
  const byDay = new Map(sums.map((s) => [s.date, s.income.cents - s.expense.cents]));
  const points: MoneyPoint[] = [];
  let cumulative = 0;
  for (let cursor = slot.from; cursor <= slot.to; cursor = addDays(cursor, 1)) {
    cumulative += byDay.get(cursor) ?? 0;
    points.push({ date: cursor, valueCents: cumulative });
  }
  return points;
};

export const buildCashflowSeries = (
  range: AnalyticsRange,
  previous: AnalyticsRange,
  currentSums: DailySum[],
  previousSums: DailySum[],
): CashflowSeries => ({
  period: range,
  current: accumulateDaily(range, currentSums),
  previous: accumulateDaily(previous, previousSums),
});

const MACRO_PALETTE = ['#0E8C5A', '#3E6FB0', '#B7791F', '#C8483B', '#805AD5'];
export const DONUT_MAX_SLICES = 5;

export const buildCategoryBreakdown = (
  sums: CategorySum[],
  categories: Pick<Category, 'id' | 'name' | 'parentId' | 'color'>[],
  range: AnalyticsRange,
  kind: 'expense' | 'income',
  maxSlices = DONUT_MAX_SLICES,
): CategoryBreakdown => {
  const byId = new Map(categories.map((c) => [c.id, c]));
  // G-B: keep the aggregates per macro (not a running number total), so the
  // exact decimal each one carries survives into the rollup and the total.
  const addends = new Map<string, Cents[]>();
  const overall: Cents[] = [];
  for (const sum of sums) {
    const cat = byId.get(sum.categoryId);
    const macroId = cat ? (cat.parentId ?? cat.id) : sum.categoryId;
    const bucket = addends.get(macroId);
    if (bucket) bucket.push(sum.total);
    else addends.set(macroId, [sum.total]);
    overall.push(sum.total);
  }
  const totals = new Map([...addends].map(([macroId, values]) => [macroId, mergeCents(values)]));
  const total = mergeCents(overall);
  const ranked = [...totals.entries()].sort((a, b) => b[1].cents - a[1].cents);
  const head = ranked.slice(0, Math.max(1, maxSlices));
  const tail = ranked.slice(Math.max(1, maxSlices));
  const tailTotal = mergeCents(tail.map(([, value]) => value));
  const pctOf = (value: number): number => (total.cents > 0 ? Math.round((value / total.cents) * 1000) / 10 : 0);
  const slices: CategorySlice[] = head.map(([macroId, value], index) => {
    const cat = byId.get(macroId);
    return {
      categoryId: macroId,
      name: cat?.name ?? 'Outras',
      totalCents: value.cents,
      pct: pctOf(value.cents),
      color: cat?.color ?? MACRO_PALETTE[index % MACRO_PALETTE.length] ?? '#0E8C5A',
      ...exactCentsCompanion('totalCents', value),
    };
  });
  if (tailTotal.cents > 0) {
    slices.push({
      categoryId: 'outras',
      name: 'Outras',
      totalCents: tailTotal.cents,
      pct: pctOf(tailTotal.cents),
      color: '#9AA5A0',
      ...exactCentsCompanion('totalCents', tailTotal),
    });
  }
  return {
    period: range,
    kind,
    totalCents: total.cents,
    slices,
    ...exactCentsCompanion('totalCents', total),
  };
};

export const buildBudgetConsumption = (budgets: BudgetStatus[]): BudgetConsumptionItem[] =>
  budgets.map((budget) => {
    const pctUsed = budget.amountCents > 0 ? Math.round((budget.spentCents / budget.amountCents) * 1000) / 10 : 0;
    return {
      budgetId: budget.id,
      name: budget.name,
      categoryId: budget.categoryId,
      spentCents: budget.spentCents,
      amountCents: budget.amountCents,
      pctUsed,
      overBudget: pctUsed > 100,
      thresholdBreached: pctUsed >= (budget.alertThreshold ?? 80),
    };
  });

const heatLevel = (value: number, max: number): 0 | 1 | 2 | 3 | 4 => {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
};

/** Monday of the week containing `iso`. */
export const mondayOf = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00.000Z`);
  return addDays(iso, -((date.getUTCDay() + 6) % 7));
};

/**
 * First day of the 4x7 grid that ends with the week of `endDate` — i.e. the
 * earliest day `buildDailyHeatmap` can paint.
 *
 * Exported so the ROUTE reads exactly this window: the grid used to be painted
 * from a wider read (`end - 34`), which made the envelope count rows the grid
 * discarded (a payload with zero cells and `emptyReason: null`). One window,
 * declared, read and painted by the same rule.
 */
export const heatmapWindowStart = (endDate: string): string => addDays(mondayOf(endDate), -21);

/**
 * Last 4 Monday-first weeks ending with the week that contains `endDate`
 * (GitHub style, exactly 7x4). Cells outside [gridStart, endDate] render
 * empty; `sums` may cover a wider window and are clipped.
 */
export const buildDailyHeatmap = (sums: DailySum[], endDate: string): DailyHeatmap => {
  const gridStart = heatmapWindowStart(endDate);
  const byDay = new Map<string, number>();
  for (const sum of sums) {
    if (sum.date < gridStart || sum.date > endDate) continue;
    byDay.set(sum.date, (byDay.get(sum.date) ?? 0) + sum.expense.cents);
  }
  let max = 0;
  for (const value of byDay.values()) max = Math.max(max, value);
  const weeks: DailyHeatmap['weeks'] = [];
  for (let week = 0; week < 4; week += 1) {
    const weekStart = addDays(gridStart, week * 7);
    const days: HeatmapDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(weekStart, day);
      const inWindow = date >= gridStart && date <= endDate;
      const totalCents = inWindow ? (byDay.get(date) ?? 0) : 0;
      days.push({ date, totalCents, level: heatLevel(totalCents, max) });
    }
    weeks.push({ weekStart, days });
  }
  return { endDate, weeks };
};

/**
 * Net worth per month for the last `months` months, reconstructed backwards
 * from today's position: worth(month) = now − flows strictly after it.
 */
export const buildNetWorthHistory = (
  currentNetWorthCents: number,
  flows: MonthlyFlow[],
  today: string,
  months: number,
): NetWorthPoint[] => {
  const monthStartOf = (back: number): string => {
    const cursor = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
    cursor.setUTCMonth(cursor.getUTCMonth() - back);
    return toISODate(cursor);
  };
  const points: NetWorthPoint[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const start = monthStartOf(back);
    if (back === 0) {
      points.push({ month: start.slice(0, 7), netWorthCents: currentNetWorthCents });
      continue;
    }
    const windowStart = monthStartOf(back - 1);
    let flowAfter = 0;
    for (const flow of flows) {
      if (flow.month >= windowStart.slice(0, 7)) flowAfter += flow.income.cents - flow.expense.cents;
    }
    points.push({ month: start.slice(0, 7), netWorthCents: currentNetWorthCents - flowAfter });
  }
  return points;
};
