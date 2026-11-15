import { renderHook } from "@/lib/test-utils";
import { useCategoryBreakdown } from "./useCategoryBreakdown";
import type { Category, Transaction } from "@/lib/state/types";

function tx(id: string, amountCents: number, categoryId: string): Transaction {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-05`;
  return {
    id,
    description: id,
    amountCents,
    date,
    kind: "expense",
    categoryId,
    accountId: "acc1",
  };
}

function cat(id: string, name: string, parentId?: string): Category {
  return { id, name, kind: "expense", icon: "Home", parentId };
}

describe("useCategoryBreakdown", () => {
  it("excludes expenses from the previous month", () => {
    const today = new Date();
    const currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-10`;
    const previous = new Date(today.getFullYear(), today.getMonth() - 1, 10);
    const previousDate = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-10`;
    const { result } = renderHook(() => useCategoryBreakdown([
      { ...tx("current", 1000, "food"), date: currentDate },
      { ...tx("previous", 9000, "home"), date: previousDate },
    ], [cat("food", "Alimentação"), cat("home", "Moradia")]));
    expect(result.current).toEqual([{ name: "Alimentação", amountCents: 1000, pct: 100 }]);
  });
  it("aggregates subcategories under the macro and sorts desc with pct", () => {
    const { result } = renderHook(() =>
      useCategoryBreakdown(
        [
          tx("t1", 100000, "micro-1"),
          tx("t2", 50000, "micro-2"),
          tx("t3", 20000, "macro-food"),
        ],
        [
          cat("micro-1", "Moradia > Aluguel"),
          cat("micro-2", "Moradia > Condomínio"),
          cat("macro-food", "Alimentação"),
        ],
      ),
    );
    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toMatchObject({ name: "Moradia", amountCents: 150000 });
    expect(result.current[0]!.pct).toBeCloseTo(150000 / 170000 * 100);
    expect(result.current[1]).toMatchObject({ name: "Alimentação", amountCents: 20000 });
  });

  it("prefers parentId metadata over name prefix and ignores income", () => {
    const { result } = renderHook(() =>
      useCategoryBreakdown(
        [
          tx("t1", 30000, "sub1"),
          {
            id: "i1",
            description: "Salário",
            amountCents: 999900,
            date: "2026-06-05",
            kind: "income",
            categoryId: "sub1",
            accountId: "acc1",
          },
        ],
        [
          cat("macro", "Transporte"),
          cat("sub1", "Gasolina", "macro"),
        ],
      ),
    );
    expect(result.current).toEqual([
      { name: "Transporte", amountCents: 30000, pct: 100 },
    ]);
  });

  it("returns empty when there are no expenses", () => {
    const { result } = renderHook(() => useCategoryBreakdown([], []));
    expect(result.current).toEqual([]);
  });
});
