/**
 * PWA parser (categories.create): presentation acionável exige nome+kind;
 * pai ausente (raiz) segue acionável; kind fora do vocabulário nunca.
 */
import { describe, expect, it } from "vitest";
import { isActionablePendingOperationPresentation } from "@pi-finance/llm-contracts/types";

const base = {
  id: "op-cat-1",
  status: "proposed",
  tool: "categories.create",
  title: "Criar categoria",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  warnings: [],
} as const;

describe("pwa categories.create presentation predicate", () => {
  it("nome+kind acionável, com ou sem pai", () => {
    expect(
      isActionablePendingOperationPresentation({
        ...base,
        categoryName: "Mercado",
        categoryKind: "expense",
        category: { id: "p1", label: "Alimentação" },
      } as never),
    ).toBe(true);
    expect(
      isActionablePendingOperationPresentation({ ...base, categoryName: "Salário", categoryKind: "income" } as never),
    ).toBe(true);
  });

  it("sem nome/kind ou kind fora do vocabulário nunca acionável", () => {
    expect(isActionablePendingOperationPresentation({ ...base, categoryKind: "expense" } as never)).toBe(false);
    expect(isActionablePendingOperationPresentation({ ...base, categoryName: "X", categoryKind: "bank" } as never)).toBe(false);
  });
});
