import { useMemo } from "react";
import type {
  Budget,
  Payable,
  QuickInsight,
  Transaction,
} from "@/lib/state/types";
import { formatBRL, formatPct } from "@/lib/format/brl";
import type { MacroSlice } from "./useCategoryBreakdown";

export interface InsightItem {
  color: string;
  title: string;
  body: string;
}

interface FallbackArgs {
  transactions: Transaction[];
  budgets: Budget[];
  payables: Payable[];
  quickInsights?: QuickInsight[];
  /** null = gate do resumo do servidor fechado (sem agregado confiável). */
  monthIncome: number | null;
  monthExpenses: number | null;
  macros: MacroSlice[];
}

/**
 * Insights locais de fallback + itens específicos da API (T1).
 * Montagem antes inline na HomePage; usa o breakdown compartilhado para o
 * top-macro em vez de recomputar (era a segunda duplicação).
 */
export function useFallbackInsights({
  transactions,
  budgets,
  payables,
  quickInsights,
  monthIncome,
  monthExpenses,
  macros,
}: FallbackArgs): InsightItem[] {
  return useMemo(() => {
    const fallback: InsightItem[] = [];

    if (monthIncome !== null && monthIncome > 0 && monthExpenses !== null && monthExpenses > 0) {
      const savingsRate = ((monthIncome - monthExpenses) / monthIncome) * 100;
      const isGood = savingsRate >= 20;
      const isWarn = savingsRate >= 5;
      fallback.push({
        color: isGood
          ? "var(--color-primary)"
          : isWarn
            ? "var(--color-warning)"
            : "var(--color-danger)",
        title: "Sobra do mês",
        body: savingsRate >= 0
          ? `Sobraram ${formatPct(savingsRate)} das receitas neste mês.`
          : `As despesas superaram as receitas em ${formatPct(Math.abs(savingsRate))}.`,
      });
    }

    const today = new Date();
    const currentPeriodExpenses = transactions.filter((t) => {
      if (t.kind !== "expense") return false;
      const match = /^(\d{4})-(\d{2})-\d{2}/.exec(t.date);
      return match !== null &&
        Number(match[1]) === today.getFullYear() &&
        Number(match[2]) === today.getMonth() + 1;
    });
    if (currentPeriodExpenses.length >= 3 && macros.length > 0) {
      const top = macros[0]!;
      fallback.push({
        color: "var(--color-info)",
        title: "Maior categoria de gasto",
        body: `${top.name} — ${formatBRL(top.amountCents)} no período.`,
      });
    }

    {
      const effectiveUsage = budgets.map((b) => {
        if (b.amountCents <= 0) return { name: b.name, pct: 0 };
        const realSpent =
          b.spentCents > 0
            ? b.spentCents
            : transactions
                .filter((t) => t.categoryId === b.categoryId && t.kind === "expense")
                .reduce((s, t) => s + t.amountCents, 0);
        return { name: b.name, pct: (realSpent / b.amountCents) * 100 };
      });
      const nearLimit = effectiveUsage.filter((u) => u.pct >= 90);
      if (nearLimit.length > 0) {
        const topName = nearLimit.sort((a, b) => b.pct - a.pct)[0]!.name;
        const body =
          nearLimit.length === 1
            ? `${topName} está perto do limite (${formatPct(90)}+).`
            : `${nearLimit.length} orçamentos perto do limite. Mais pressionado: ${topName}.`;
        fallback.push({
          color: "var(--color-warning)",
          title: "Orçamentos no limite",
          body,
        });
      } else if (effectiveUsage.length > 0) {
        const maxEntry = effectiveUsage.reduce((max, u) =>
          u.pct > max.pct ? u : max,
        );
        if (maxEntry.pct > 0) {
          const budgetUsagePct = new Intl.NumberFormat("pt-BR", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }).format(maxEntry.pct);
          fallback.push({
            color: "var(--color-primary)",
            title: "Orçamentos sob controle",
            body: `${maxEntry.name}: ${budgetUsagePct}% do orçamento.`,
          });
        }
      }
    }

    const upcomingPayables = payables
      .filter((p) => p.status === "pending")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (upcomingPayables.length > 0) {
      const next = upcomingPayables[0]!;
      const dueDate = new Date(next.dueDate);
      const today = new Date();
      const daysUntil = Math.ceil(
        (dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      fallback.push({
        color:
          daysUntil <= 1
            ? "var(--color-danger)"
            : daysUntil <= 7
              ? "var(--color-warning)"
              : "var(--color-info)",
        title: "Próxima conta a vencer",
        body: `${next.description} — ${formatBRL(next.amountCents)} em ${
          daysUntil <= 0
            ? "vencida!"
            : daysUntil === 1
              ? "amanhã"
              : `${daysUntil} dias`
        } (${next.dueDate}).`,
      });
    }

    const specificQuick = (quickInsights ?? []).filter(
      (item) => item.body && item.body.includes("R$"),
    );
    return [
      ...fallback,
      ...specificQuick.map((item) => ({
        title: item.title,
        body: item.body,
        color:
          item.severity === "good"
            ? "var(--color-primary)"
            : item.severity === "warn"
              ? "var(--color-warning)"
              : "var(--color-info)",
      })),
    ];
  }, [transactions, budgets, payables, quickInsights, monthIncome, monthExpenses, macros]);
}
