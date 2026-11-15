import { renderHook } from "@/lib/test-utils";
import { useFallbackInsights } from "./useFallbackInsights";
import type {
  Budget,
  Payable,
  Transaction,
} from "@/lib/state/types";

function tx(partial: Partial<Transaction> & { id: string }): Transaction {
  const today = new Date();
  return {
    description: partial.id,
    amountCents: 10000,
    date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-05`,
    kind: "expense",
    categoryId: "cat1",
    accountId: "acc1",
    ...partial,
  };
}

const base = {
  transactions: [] as Transaction[],
  budgets: [] as Budget[],
  payables: [] as Payable[],
  quickInsights: [],
  monthIncome: null as number | null,
  monthExpenses: null as number | null,
  macros: [],
};

describe("useFallbackInsights", () => {
  it("returns empty when there is no data source", () => {
    const { result } = renderHook(() => useFallbackInsights(base));
    expect(result.current).toEqual([]);
  });

  it("builds savings + top-macro insights from server totals and shared breakdown", () => {
    const { result } = renderHook(() =>
      useFallbackInsights({
        ...base,
        monthIncome: 1000000,
        monthExpenses: 600000,
        transactions: [tx({ id: "e1" }), tx({ id: "e2" }), tx({ id: "e3" })],
        macros: [
          { name: "Moradia", amountCents: 150000, pct: 75 },
          { name: "Alimentação", amountCents: 50000, pct: 25 },
        ],
      }),
    );
    const titles = result.current.map((i) => i.title);
    expect(titles).toContain("Sobra do mês");
    expect(result.current.find((i) => i.title === "Sobra do mês")?.body).toMatch(/Sobraram 40(?:[,.]0)?%/);
    expect(titles).toContain("Maior categoria de gasto");
    const macro = result.current.find((i) => i.title === "Maior categoria de gasto")!;
    expect(macro.body).toMatch(/Moradia/);
  });

  it("describes overspending factually and omits remainder without expenses", () => {
    const { result } = renderHook(() => useFallbackInsights({ ...base, monthIncome: 10000, monthExpenses: 12000 }));
    expect(result.current.find((i) => i.title === "Sobra do mês")?.body).toMatch(/superaram as receitas em 20(?:[,.]0)?%/);
    const empty = renderHook(() => useFallbackInsights({ ...base, monthIncome: 10000, monthExpenses: 0 }));
    expect(empty.result.current.some((i) => i.title === "Sobra do mês")).toBe(false);
  });

  it("keeps only specific API insights (with R$) alongside local ones", () => {
    const { result } = renderHook(() =>
      useFallbackInsights({
        ...base,
        monthIncome: 1000000,
        monthExpenses: 900000,
        quickInsights: [
          { id: "g", title: "Mês equilibrado", body: "Receitas e despesas empatadas.", severity: "info" },
          { id: "s", title: "Caixa crescendo", body: "Caixa subiu R$ 100,00 em 30 dias.", severity: "good" },
        ],
      }),
    );
    const titles = result.current.map((i) => i.title);
    expect(titles).toContain("Caixa crescendo");
    expect(titles).not.toContain("Mês equilibrado");
  });

  it("flags budgets near the limit with the concise copy", () => {
    const budget: Budget = {
      id: "b1",
      categoryId: "cat1",
      name: "Alimentação",
      amountCents: 50000,
      spentCents: 0,
      period: "monthly",
    };
    const { result } = renderHook(() =>
      useFallbackInsights({
        ...base,
        budgets: [budget],
        transactions: [tx({ id: "t1", amountCents: 48000 })],
        quickInsights: [],
      }),
    );
    const body = result.current.map((i) => i.body).join(" ");
    expect(body).toMatch(/Alimentação está perto do limite/);
  });

  it("names the budget as the denominator for ordinary usage insights", () => {
    const budget: Budget = {
      id: "b1",
      categoryId: "cat1",
      name: "Alimentação Mensal",
      amountCents: 100000,
      spentCents: 18800,
      period: "monthly",
    };
    const { result } = renderHook(() =>
      useFallbackInsights({ ...base, budgets: [budget] }),
    );

    expect(result.current.find((i) => i.title === "Orçamentos sob controle")?.body)
      .toBe("Alimentação Mensal: 18,8% do orçamento.");
  });
});
