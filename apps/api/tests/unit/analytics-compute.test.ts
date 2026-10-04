import { describe, expect, it } from 'vitest';
import {
  buildCategoryBreakdown,
  buildDailyHeatmap,
  buildNetWorthHistory,
  normalizeMonthly,
  previousRangeOf,
  resolveRange,
  savingsRatePct,
  statementsDueSoon,
} from '../../src/analytics/compute.js';
import type { CategorySum, MonthlyFlow } from '../../src/analytics/source.js';

describe('analytics ranges', () => {
  it('resolves presets against the injected today', () => {
    expect(resolveRange('last30days', '2026-09-07', undefined, undefined)).toEqual({ from: '2026-08-09', to: '2026-09-07' });
    expect(resolveRange('lastMonth', '2026-09-07', undefined, undefined)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(resolveRange('thisYear', '2026-09-07', undefined, undefined)).toEqual({ from: '2026-01-01', to: '2026-09-07' });
    expect(resolveRange('custom', '2026-09-07', '2026-01-05', '2026-02-05')).toEqual({ from: '2026-01-05', to: '2026-02-05' });
  });

  it('computes the same-length previous range', () => {
    expect(previousRangeOf({ from: '2026-09-01', to: '2026-09-07' })).toEqual({ from: '2026-08-25', to: '2026-08-31' });
  });
});

describe('kpi math', () => {
  it('returns null savings rate without income', () => {
    expect(savingsRatePct(0, 500)).toBeNull();
    expect(savingsRatePct(10_000, 7_500)).toBe(25);
  });

  it('normalizes subscription cycles to monthly cost', () => {
    expect(normalizeMonthly(1200, 'monthly')).toBe(1200);
    expect(normalizeMonthly(1200, 'yearly')).toBe(100);
    expect(normalizeMonthly(700, 'weekly')).toBe(3000);
  });

  it('selects open statements due within the window (inclusive bounds)', () => {
    const statements = [
      { status: 'open', dueDate: '2026-09-10' },
      { status: 'paid', dueDate: '2026-09-08' },
      { status: 'open', dueDate: '2026-09-11' },
      { status: 'open', dueDate: '2026-09-07' },
    ] as { status: 'open' | 'paid'; dueDate: string }[];
    const due = statementsDueSoon(statements, '2026-09-07', 3);
    expect(due.map((s) => s.dueDate).sort()).toEqual(['2026-09-07', '2026-09-10']);
  });
});

describe('category breakdown', () => {
  it('rolls subs up to macros and aggregates the tail into gray Outras', () => {
    const categories = [
      { id: 'm1', name: 'Moradia', parentId: undefined, color: null },
      { id: 's1', name: 'Aluguel', parentId: 'm1', color: null },
      ...[2, 3, 4, 5, 6, 7].map((n) => ({ id: `m${n}`, name: `Macro ${n}`, parentId: undefined, color: null })),
    ];
    // G-B: each aggregate carries its own exact decimal (`total`), which is what
    // the rollup re-sums. Values are unchanged by that shape.
    const sums: CategorySum[] = [
      { categoryId: 's1', total: { cents: 1000, exactText: '1000' }, transactionCount: 1 },
      ...[2, 3, 4, 5, 6, 7].map((n, i) => ({
        categoryId: `m${n}`,
        total: { cents: 100 * (i + 1), exactText: String(100 * (i + 1)) },
        transactionCount: 1,
      })),
    ];
    const result = buildCategoryBreakdown(sums, categories, { from: '2026-09-01', to: '2026-09-30' }, 'expense');
    expect(result.totalCents).toBe(1000 + 100 + 200 + 300 + 400 + 500 + 600);
    const outras = result.slices.find((s) => s.name === 'Outras');
    expect(outras).toBeDefined();
    expect(outras!.color).toBe('#9AA5A0');
    expect(result.slices).toHaveLength(6);
    const pctSum = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(Math.abs(pctSum - 100)).toBeLessThan(0.2);
    // Sub rolled up: no slice keeps the sub id.
    expect(result.slices.some((s) => s.categoryId === 's1')).toBe(false);
    // G-B: a total inside the safe integer gains no exact companion.
    expect(result).not.toHaveProperty('totalCentsExact');
    expect(result).not.toHaveProperty('approximate');
  });
});

describe('heatmap', () => {
  it('builds 4 Monday-first weeks ending with the week of endDate', () => {
    const result = buildDailyHeatmap(
      [
        { date: '2026-09-07', income: { cents: 0 }, expense: { cents: 400 }, transactionCount: 1 },
        { date: '2026-09-06', income: { cents: 9999 }, expense: { cents: 100 }, transactionCount: 2 },
      ],
      '2026-09-07',
    );
    expect(result.weeks).toHaveLength(4);
    for (const week of result.weeks) expect(week.days).toHaveLength(7);
    // 2026-09-07 is a Monday: grid starts 2026-08-17.
    expect(result.weeks[0]!.weekStart).toBe('2026-08-17');
    expect(result.weeks[3]!.weekStart).toBe('2026-09-07');
    const flat = result.weeks.flatMap((w) => w.days);
    expect(flat.find((d) => d.date === '2026-09-07')!.level).toBe(4);
    expect(flat.find((d) => d.date === '2026-09-06')!.level).toBe(1);
    expect(flat.find((d) => d.date === '2026-09-05')!.level).toBe(0);
    // Out-of-grid days are clipped, never crash.
    expect(flat.every((d) => d.level >= 0 && d.level <= 4)).toBe(true);
  });
});

describe('net worth history', () => {
  it('reconstructs monthly positions backwards from today', () => {
    const flows: MonthlyFlow[] = [
      { month: '2026-08', income: { cents: 0 }, expense: { cents: 2000 }, transactionCount: 1 },
      { month: '2026-09', income: { cents: 5000 }, expense: { cents: 0 }, transactionCount: 1 },
    ];
    const points = buildNetWorthHistory(10_000, flows, '2026-09-07', 3);
    expect(points.map((p) => p.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(points[2]!.netWorthCents).toBe(10_000);
    expect(points[1]!.netWorthCents).toBe(10_000 - 5_000);
    expect(points[0]!.netWorthCents).toBe(10_000 - 5_000 + 2_000);
  });
});
