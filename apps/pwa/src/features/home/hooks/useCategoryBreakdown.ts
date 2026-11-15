import { useMemo } from "react";
import type { Category, Transaction } from "@/lib/state/types";

export interface MacroSlice {
  name: string;
  amountCents: number;
  /** % sobre o total de despesas (0-100). */
  pct: number;
}

/**
 * Agregação por macro-categoria das despesas (T1).
 * Lógica antes duplicada entre donut e insights da HomePage; regra única:
 * parentId > prefixo "Macro > Sub" > nome próprio/"Outros", ordenado desc.
 */
export function useCategoryBreakdown(
  transactions: Transaction[],
  categories: Category[],
): MacroSlice[] {
  return useMemo(() => {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    const parentById = new Map<string, string>();
    for (const c of categories) {
      parentById.set(c.id, c.name);
    }

    const idToMacro = new Map<string, string>();
    for (const c of categories) {
      if (c.parentId) {
        idToMacro.set(c.id, parentById.get(c.parentId) ?? c.parentId);
      } else if (c.name.includes(" > ")) {
        idToMacro.set(c.id, c.name.split(" > ")[0]!.trim());
      }
    }

    const macroTotals = new Map<string, number>();
    let total = 0;
    for (const t of transactions) {
      if (t.kind !== "expense") continue;
      const match = /^(\d{4})-(\d{2})-\d{2}/.exec(t.date);
      if (!match || Number(match[1]) !== currentYear || Number(match[2]) - 1 !== currentMonth) continue;
      total += t.amountCents;
      const macro =
        idToMacro.get(t.categoryId) ??
        parentById.get(t.categoryId) ??
        "Outros";
      macroTotals.set(macro, (macroTotals.get(macro) ?? 0) + t.amountCents);
    }

    const denom = total || 1;
    return Array.from(macroTotals.entries())
      .map(([name, amountCents]) => ({
        name,
        amountCents,
        pct: (amountCents / denom) * 100,
      }))
      .sort((a, b) => b.amountCents - a.amountCents);
  }, [transactions, categories]);
}
