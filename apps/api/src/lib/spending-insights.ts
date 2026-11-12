import type { Transaction } from '../types/domain.js';

export type SpendingInsightType = 'all' | 'comparison' | 'anomalies' | 'income-share';

type ComparisonInsight = {
  type: 'comparison';
  basis: 'competencia';
  yearMonth: string;
  previousYearMonth: string;
  currentExpenseCents: number;
  previousExpenseCents: number;
  averageExpenseCents: number;
  deltaVsPreviousCents: number;
  deltaVsPreviousPercent: number | null;
  deltaVsAverageCents: number;
  deltaVsAveragePercent: number | null;
};

type IncomeShareInsight = {
  type: 'income-share';
  basis: 'competencia';
  yearMonth: string;
  expenseCents: number;
  incomeCents: number;
  sharePercent: number | null;
};

export type SpendingInsight = ComparisonInsight | IncomeShareInsight;

const monthOffset = (yearMonth: string, offset: number): string => {
  const [year = 0, month = 1] = yearMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

export const buildSpendingInsights = (
  transactions: Transaction[],
  yearMonth: string,
  insightType: SpendingInsightType = 'all',
  lookbackMonths = 3,
): SpendingInsight[] => {
  if (insightType === 'anomalies') return []; // Anomaly detection is intentionally deferred.

  const sumKindForMonth = (kind: 'expense' | 'income', month: string): number =>
    transactions.reduce((sum, tx) => sum + (tx.kind === kind && tx.date.slice(0, 7) === month ? tx.amountCents : 0), 0);

  const currentExpenseCents = sumKindForMonth('expense', yearMonth);
  const previousYearMonth = monthOffset(yearMonth, -1);
  const previousExpenseCents = sumKindForMonth('expense', previousYearMonth);
  const historicalExpenses = Array.from({ length: lookbackMonths }, (_, index) =>
    sumKindForMonth('expense', monthOffset(yearMonth, -(index + 1))),
  );
  const averageExpenseCents = Math.round(historicalExpenses.reduce((sum, value) => sum + value, 0) / lookbackMonths);
  const deltaVsPreviousCents = currentExpenseCents - previousExpenseCents;
  const deltaVsAverageCents = currentExpenseCents - averageExpenseCents;
  const expenseCents = currentExpenseCents;
  const incomeCents = sumKindForMonth('income', yearMonth);

  const insights: SpendingInsight[] = [];
  if (insightType === 'all' || insightType === 'comparison') {
    insights.push({
      type: 'comparison', basis: 'competencia', yearMonth, previousYearMonth,
      currentExpenseCents, previousExpenseCents, averageExpenseCents,
      deltaVsPreviousCents,
      deltaVsPreviousPercent: previousExpenseCents > 0 ? round1(deltaVsPreviousCents / previousExpenseCents * 100) : null,
      deltaVsAverageCents,
      deltaVsAveragePercent: averageExpenseCents > 0 ? round1(deltaVsAverageCents / averageExpenseCents * 100) : null,
    });
  }
  if (insightType === 'all' || insightType === 'income-share') {
    insights.push({
      type: 'income-share', basis: 'competencia', yearMonth, expenseCents, incomeCents,
      sharePercent: incomeCents > 0 ? round1(expenseCents / incomeCents * 100) : null,
    });
  }
  return insights;
};
