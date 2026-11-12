import { describe, expect, it } from 'vitest';
import type { Category, Transaction } from '../../src/types/domain.js';
import { buildSpendingInsights } from '../../src/lib/spending-insights.js';

const householdId = 'household';
const accountId = 'account';
const food: Category = { id: 'food', householdId, name: 'Food', kind: 'expense', status: 'active' };
const rent: Category = { id: 'rent', householdId, name: 'Rent', kind: 'expense', status: 'active' };
const salary: Category = { id: 'salary', householdId, name: 'Salary', kind: 'income', status: 'active' };
const categories = [food, rent, salary];

const tx = (date: string, kind: Transaction['kind'], amountCents: number, categoryId?: string, description = 'transaction'): Transaction => ({
  id: `${date}-${kind}-${amountCents}-${categoryId ?? 'none'}`,
  householdId,
  kind,
  description,
  amountCents,
  date,
  accountId,
  ...(categoryId ? { categoryId } : {}),
});

const transactions = [
  tx('2026-05-05', 'expense', 10000, food.id),
  tx('2026-05-06', 'expense', 20000, rent.id),
  tx('2026-06-10', 'expense', 30000, food.id, 'Large grocery purchase'),
  tx('2026-06-12', 'expense', 15000, rent.id),
  tx('2026-06-01', 'income', 100000, salary.id),
];

describe('buildSpendingInsights', () => {
  it('compares category spending against the lookback average', () => {
    const result = buildSpendingInsights(transactions, categories, '2026-06', 'comparison', 2);
    expect(result.comparisons).toEqual([
      { category: 'Food', currentCents: 30000, previousCents: 5000, absoluteChange: 25000, percentChange: 500, trend: 'up' },
      { category: 'Rent', currentCents: 15000, previousCents: 10000, absoluteChange: 5000, percentChange: 50, trend: 'up' },
    ]);
    expect(result).not.toHaveProperty('anomalies');
  });

  it('detects transactions above 2.5 times the category historical mean and 10000 cents', () => {
    const result = buildSpendingInsights(transactions, categories, '2026-06', 'anomalies', 2);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies?.[0]).toMatchObject({
      type: 'anomaly', category: 'Food', currentCents: 30000, previousCents: 10000, percentChange: 200,
    });
  });

  it('calculates category income shares', () => {
    const result = buildSpendingInsights(transactions, categories, '2026-06', 'income-share', 2);
    expect(result.incomeShare).toEqual([
      { category: 'Food', totalCents: 30000, sharePercent: 30 },
      { category: 'Rent', totalCents: 15000, sharePercent: 15 },
    ]);
    expect(result).not.toHaveProperty('comparisons');
    expect(result).not.toHaveProperty('anomalies');
  });

  it('returns only fields selected by insightType and all three in all mode', () => {
    const all = buildSpendingInsights(transactions, categories, '2026-06', 'all', 2);
    expect(all).toHaveProperty('comparisons');
    expect(all).toHaveProperty('anomalies');
    expect(all).toHaveProperty('incomeShare');
    expect(buildSpendingInsights(transactions, categories, '2026-06', 'comparison', 2)).not.toHaveProperty('incomeShare');
    expect(buildSpendingInsights(transactions, categories, '2026-06', 'anomalies', 2)).not.toHaveProperty('comparisons');
    expect(buildSpendingInsights(transactions, categories, '2026-06', 'income-share', 2)).not.toHaveProperty('anomalies');
  });

  it('handles a month without transactions', () => {
    const result = buildSpendingInsights([], categories, '2026-06');
    expect(result.comparisons).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.incomeShare).toEqual([]);
    expect(result.yearMonth).toBe('2026-06');
  });
});
