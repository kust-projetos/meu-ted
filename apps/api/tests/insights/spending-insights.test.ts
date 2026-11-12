import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../src/types/domain.js';
import { buildSpendingInsights } from '../../src/lib/spending-insights.js';

const tx = (date: string, kind: Transaction['kind'], amountCents: number): Transaction => ({
  id: `${date}-${kind}-${amountCents}`,
  householdId: 'household',
  kind,
  description: 'transaction',
  amountCents,
  date,
  accountId: 'account',
});

describe('buildSpendingInsights', () => {
  it('compares current expenses with prior month and historical average', () => {
    const result = buildSpendingInsights([
      tx('2026-06-10', 'expense', 30000),
      tx('2026-05-10', 'expense', 20000),
      tx('2026-04-10', 'expense', 30000),
    ], '2026-06', 'comparison', 2);
    expect(result).toEqual([{
      type: 'comparison', basis: 'competencia', yearMonth: '2026-06', previousYearMonth: '2026-05',
      currentExpenseCents: 30000, previousExpenseCents: 20000, averageExpenseCents: 25000,
      deltaVsPreviousCents: 10000, deltaVsPreviousPercent: 50,
      deltaVsAverageCents: 5000, deltaVsAveragePercent: 20,
    }]);
  });

  it('returns zero totals and null percentages without transactions', () => {
    expect(buildSpendingInsights([], '2026-06')).toEqual([
      {
        type: 'comparison', basis: 'competencia', yearMonth: '2026-06', previousYearMonth: '2026-05',
        currentExpenseCents: 0, previousExpenseCents: 0, averageExpenseCents: 0,
        deltaVsPreviousCents: 0, deltaVsPreviousPercent: null, deltaVsAverageCents: 0, deltaVsAveragePercent: null,
      },
      { type: 'income-share', basis: 'competencia', yearMonth: '2026-06', expenseCents: 0, incomeCents: 0, sharePercent: null },
    ]);
  });

  it('computes income share and handles zero income', () => {
    expect(buildSpendingInsights([tx('2026-06-01', 'expense', 25000)], '2026-06', 'income-share')[0]).toMatchObject({ incomeCents: 0, sharePercent: null });
    expect(buildSpendingInsights([
      tx('2026-06-01', 'expense', 25000), tx('2026-06-02', 'income', 100000),
    ], '2026-06', 'income-share')[0]).toMatchObject({ expenseCents: 25000, incomeCents: 100000, sharePercent: 25 });
  });

  it('filters insight types and defers anomalies', () => {
    expect(buildSpendingInsights([], '2026-06', 'comparison')).toHaveLength(1);
    expect(buildSpendingInsights([], '2026-06', 'income-share')).toHaveLength(1);
    expect(buildSpendingInsights([], '2026-06', 'anomalies')).toEqual([]);
    expect(buildSpendingInsights([], '2026-06', 'all').map((item) => item.type)).toEqual(['comparison', 'income-share']);
  });

  it('excludes transactions from other months and income from expense totals', () => {
    expect(buildSpendingInsights([
      tx('2026-06-01', 'expense', 500), tx('2026-06-02', 'income', 9000), tx('2026-07-01', 'expense', 8000),
    ], '2026-06', 'comparison')[0]).toMatchObject({ currentExpenseCents: 500, previousExpenseCents: 0 });
  });
});
