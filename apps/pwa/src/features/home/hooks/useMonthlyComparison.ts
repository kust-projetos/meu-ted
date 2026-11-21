import { useMemo } from "react";
import type { Transaction } from "@/lib/state/types";

export interface MonthlyComparisonPoint {
  yearMonth: string;
  shortLabel: string;
  fullLabel: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMonthLabels(
  yearMonth: string,
  includeYear: boolean,
): { shortLabel: string; fullLabel: string } {
  const [yStr, mStr] = yearMonth.split("-");
  const date = new Date(Number(yStr), Number(mStr) - 1, 15, 12, 0, 0);
  const shortMonth = capitalize(
    new Intl.DateTimeFormat("pt-BR", { month: "short" })
      .format(date)
      .replace(/\.$/, ""),
  );
  const fullLabel = capitalize(
    new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(
      date,
    ),
  );
  return {
    shortLabel: includeYear ? `${shortMonth}/${yStr!.slice(2)}` : shortMonth,
    fullLabel,
  };
}

/**
 * Comparativo mensal de receitas e despesas apenas para meses que possuem registros.
 * Nunca preenche meses vazios anteriores ao primeiro registro nem lacunas sem movimento.
 */
export function useMonthlyComparison(
  transactions: Transaction[],
  maxMonths = 6,
): MonthlyComparisonPoint[] {
  return useMemo(() => {
    const totals = new Map<string, { incomeCents: number; expenseCents: number }>();

    for (const t of transactions) {
      if (t.kind !== "income" && t.kind !== "expense") continue;
      const match = /^(\d{4})-(\d{2})-\d{2}/.exec(t.date);
      if (!match) continue;
      const yearMonth = `${match[1]}-${match[2]}`;
      const bucket = totals.get(yearMonth) ?? { incomeCents: 0, expenseCents: 0 };
      if (t.kind === "income") {
        bucket.incomeCents += t.amountCents;
      } else {
        bucket.expenseCents += t.amountCents;
      }
      totals.set(yearMonth, bucket);
    }

    const active = Array.from(totals.entries())
      .filter(([, bucket]) => bucket.incomeCents > 0 || bucket.expenseCents > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-Math.max(1, maxMonths));

    const years = new Set(active.map(([ym]) => ym.slice(0, 4)));
    const includeYear = years.size > 1;

    return active.map(([yearMonth, bucket]) => {
      const { shortLabel, fullLabel } = formatMonthLabels(yearMonth, includeYear);
      return {
        yearMonth,
        shortLabel,
        fullLabel,
        incomeCents: bucket.incomeCents,
        expenseCents: bucket.expenseCents,
        netCents: bucket.incomeCents - bucket.expenseCents,
      };
    });
  }, [transactions, maxMonths]);
}
