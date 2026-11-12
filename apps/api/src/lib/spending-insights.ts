import type { Category, Transaction } from '../types/domain.js';

export type SpendingInsightType = 'all' | 'comparison' | 'anomalies' | 'income-share';

type Comparison = {
  category: string;
  currentCents: number;
  previousCents: number;
  absoluteChange: number;
  percentChange: number | null;
  trend: 'up' | 'down' | 'stable' | 'new' | 'gone';
};

type Insight = {
  type: 'anomaly' | 'trend_up' | 'trend_down' | 'category_gone' | 'new_category';
  severity: 'info' | 'warning' | 'alert';
  category: string;
  message: string;
  currentCents?: number;
  previousCents?: number;
  percentChange?: number;
};

const monthStart = (yearMonth: string, offset: number): string => {
  const parts = yearMonth.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

const monthEnd = (yearMonth: string): string => {
  const parts = yearMonth.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
};

const categoryLabel = (tx: Transaction, categories: Map<string, Category>): string =>
  (tx.categoryId ? categories.get(tx.categoryId)?.name : undefined) ?? 'Sem categoria';

export const buildSpendingInsights = (
  transactions: Transaction[],
  categories: Category[],
  yearMonth: string,
  insightType: SpendingInsightType = 'all',
  lookbackMonths = 3,
) => {
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const start = monthStart(yearMonth, 0);
  const end = monthEnd(yearMonth);
  const previousStart = monthStart(yearMonth, -lookbackMonths);
  const current = transactions.filter((tx) => tx.kind === 'expense' && tx.date >= start && tx.date <= end);
  const previous = transactions.filter((tx) => tx.kind === 'expense' && tx.date >= previousStart && tx.date < start);
  const currentByCategory = new Map<string, number>();
  const previousByCategory = new Map<string, number>();
  for (const tx of current) {
    const category = categoryLabel(tx, categoryMap);
    currentByCategory.set(category, (currentByCategory.get(category) ?? 0) + tx.amountCents);
  }
  for (const tx of previous) {
    const category = categoryLabel(tx, categoryMap);
    previousByCategory.set(category, (previousByCategory.get(category) ?? 0) + tx.amountCents);
  }

  const comparisons: Comparison[] = [];
  const insights: Insight[] = [];
  for (const [category, currentCents] of currentByCategory) {
    const previousCents = Math.round((previousByCategory.get(category) ?? 0) / lookbackMonths);
    const absoluteChange = currentCents - previousCents;
    const percentChange = previousCents > 0 ? Math.round((absoluteChange / previousCents) * 100) : null;
    const trend = previousCents === 0 ? 'new' : percentChange !== null && percentChange > 20 ? 'up' : percentChange !== null && percentChange < -20 ? 'down' : 'stable';
    comparisons.push({ category, currentCents, previousCents, absoluteChange, percentChange, trend });
    if (trend === 'up' && percentChange !== null && percentChange > 50) {
      insights.push({ type: 'trend_up', severity: percentChange > 100 ? 'alert' : 'warning', category, message: `📈 ${category}: +${percentChange}% vs média`, currentCents, previousCents, percentChange });
    } else if (trend === 'down' && percentChange !== null && percentChange < -30) {
      insights.push({ type: 'trend_down', severity: 'info', category, message: `📉 ${category}: ${percentChange}% vs média`, currentCents, previousCents, percentChange });
    } else if (trend === 'new' && currentCents > 10_000) {
      insights.push({ type: 'new_category', severity: 'info', category, message: `🆕 Nova categoria: ${category}`, currentCents });
    }
  }
  for (const [category, total] of previousByCategory) {
    if (!currentByCategory.has(category) && total / lookbackMonths > 5_000) {
      const average = Math.round(total / lookbackMonths);
      comparisons.push({ category, currentCents: 0, previousCents: average, absoluteChange: -average, percentChange: -100, trend: 'gone' });
      insights.push({ type: 'category_gone', severity: 'info', category, message: `👋 ${category} não teve gastos este mês`, previousCents: average });
    }
  }
  comparisons.sort((a, b) => Math.abs(b.absoluteChange) - Math.abs(a.absoluteChange));

  const anomalies: Insight[] = [];
  for (const tx of current.sort((a, b) => b.amountCents - a.amountCents).slice(0, 20)) {
    const category = categoryLabel(tx, categoryMap);
    const categoryPrevious = previous.filter((item) => categoryLabel(item, categoryMap) === category);
    const average = categoryPrevious.length === 0 ? 0 : categoryPrevious.reduce((sum, item) => sum + item.amountCents, 0) / categoryPrevious.length;
    if (average > 0 && tx.amountCents > average * 2.5 && tx.amountCents > 10_000) {
      const percentChange = Math.round(((tx.amountCents - average) / average) * 100);
      anomalies.push({ type: 'anomaly', severity: 'warning', category, message: `🔍 ${tx.description}: ${percentChange}% da média`, currentCents: tx.amountCents, previousCents: Math.round(average), percentChange });
    }
  }

  const income = transactions.filter((tx) => tx.kind === 'income' && tx.date >= start && tx.date <= end).reduce((sum, tx) => sum + tx.amountCents, 0);
  const incomeShare = income === 0 ? [] : [...currentByCategory.entries()].map(([category, totalCents]) => ({ category, totalCents, sharePercent: Math.round((totalCents / income) * 100) })).sort((a, b) => b.totalCents - a.totalCents).slice(0, 10);
  return {
    yearMonth,
    ...(insightType === 'all' || insightType === 'comparison' ? { comparisons } : {}),
    ...(insightType === 'all' || insightType === 'anomalies' ? { anomalies } : {}),
    ...(insightType === 'all' || insightType === 'income-share' ? { incomeShare } : {}),
    message: [...(insightType === 'all' || insightType === 'comparison' ? insights : []), ...(insightType === 'all' || insightType === 'anomalies' ? anomalies : [])].map((item) => item.message).join('\n') || 'Sem insights para este período',
  };
};
