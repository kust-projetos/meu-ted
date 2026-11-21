import { renderHook } from "@/lib/test-utils";
import { useMonthlyComparison } from "./useMonthlyComparison";
import type { Transaction } from "@/lib/state/types";

function tx(partial: Partial<Transaction> & { id: string }): Transaction {
  return {
    description: partial.id,
    amountCents: 10000,
    date: "2026-11-05",
    kind: "expense",
    categoryId: "cat1",
    accountId: "acc1",
    ...partial,
  };
}

describe("useMonthlyComparison", () => {
  it("returns empty when there are no income or expense transactions (ignores transfers)", () => {
    const { result } = renderHook(() =>
      useMonthlyComparison([
        tx({ id: "trf-1", kind: "transfer", amountCents: 50000, date: "2026-11-05" }),
      ]),
    );
    expect(result.current).toEqual([]);
  });

  it("only includes months with records, skipping empty months before first record and gaps", () => {
    const { result } = renderHook(() =>
      useMonthlyComparison([
        tx({ id: "aug-in", kind: "income", amountCents: 900000, date: "2026-08-05" }),
        tx({ id: "aug-out", kind: "expense", amountCents: 400000, date: "2026-08-12" }),
        // 2026-09 intentionally has no transactions -> must NOT appear
        tx({ id: "oct-out", kind: "expense", amountCents: 250000, date: "2026-10-18" }),
        tx({ id: "nov-in", kind: "income", amountCents: 1200000, date: "2026-11-02" }),
      ]),
    );

    expect(result.current).toHaveLength(3);
    expect(result.current.map((p) => p.yearMonth)).toEqual([
      "2026-08",
      "2026-10",
      "2026-11",
    ]);
    expect(result.current[0]).toMatchObject({
      yearMonth: "2026-08",
      shortLabel: "Ago",
      incomeCents: 900000,
      expenseCents: 400000,
      netCents: 500000,
    });
    expect(result.current[1]).toMatchObject({
      yearMonth: "2026-10",
      shortLabel: "Out",
      incomeCents: 0,
      expenseCents: 250000,
      netCents: -250000,
    });
  });

  it("caps returned series to maxMonths keeping the most recent active months", () => {
    const { result } = renderHook(() =>
      useMonthlyComparison(
        [
          tx({ id: "m1", kind: "expense", date: "2026-06-05" }),
          tx({ id: "m2", kind: "expense", date: "2026-07-05" }),
          tx({ id: "m3", kind: "expense", date: "2026-09-05" }),
          tx({ id: "m4", kind: "expense", date: "2026-11-05" }),
        ],
        2,
      ),
    );
    expect(result.current.map((p) => p.yearMonth)).toEqual(["2026-09", "2026-11"]);
  });
});
