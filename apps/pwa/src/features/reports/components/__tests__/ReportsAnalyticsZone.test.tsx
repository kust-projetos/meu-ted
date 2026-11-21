import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { ReportsAnalyticsZone } from "../ReportsAnalyticsZone";
import * as client from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const ACCOUNTS = [{ id: "acc-1", name: "Conta corrente" }];

const mockOk = () => {
  vi.mocked(client.apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith("/analytics/kpis")) {
      return {
        netLiquidBalanceCents: 125000,
        openInvoices: { committedCents: 0, limitCents: 0, utilizationPct: null },
        savingsRatePct: 25.0,
        savingsRateTargetPct: 20,
        previousSavingsRatePct: 20.0,
        fixedVsDiscretionary: { fixedCents: 200000, discretionaryCents: 100000, fixedPctOfIncome: 50 },
        incomeCents: 400000,
        expenseCents: 300000,
        previousIncomeCents: 400000,
        previousExpenseCents: 320000,
        netWorthCents: 500000,
      } as never;
    }
    if (path.startsWith("/analytics/cashflow-series")) {
      return {
        current: [
          { date: "2026-01-01", valueCents: 100 },
          { date: "2026-02-01", valueCents: 300 },
        ],
        previous: [{ date: "2025-01-01", valueCents: 50 }],
      } as never;
    }
    if (path.startsWith("/analytics/category-breakdown")) {
      return {
        kind: "expense",
        totalCents: 10000,
        slices: [
          { categoryId: "c1", name: "Mercado", totalCents: 4000, pct: 40, color: "#0E8C5A" },
          { categoryId: "c2", name: "Transporte", totalCents: 2000, pct: 20, color: null },
          { categoryId: "c3", name: "Lazer", totalCents: 1500, pct: 15, color: null },
          { categoryId: "c4", name: "Saúde", totalCents: 1000, pct: 10, color: null },
          { categoryId: "c5", name: "Casa", totalCents: 800, pct: 8, color: null },
          { categoryId: "c6", name: "Pets", totalCents: 400, pct: 4, color: null },
          { categoryId: "c7", name: "Outros gastos", totalCents: 300, pct: 3, color: null },
        ],
      } as never;
    }
    if (path.startsWith("/analytics/budget-consumption")) {
      return {
        items: [
          {
            budgetId: "b1",
            name: "Mercado",
            categoryId: "c1",
            spentCents: 450000,
            amountCents: 400000,
            pctUsed: 112,
            overBudget: true,
            thresholdBreached: true,
          },
        ],
      } as never;
    }
    if (path.startsWith("/analytics/net-worth-history")) {
      return { months: [{ month: "2026-08", netWorthCents: 480000 }] } as never;
    }
    throw new Error(`unexpected path ${path}`);
  });
};

describe("ReportsAnalyticsZone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renderiza KPIs estratégicos, donut 5+Outras, bullets, fluxo e comparativo do período", async () => {
    mockOk();
    render(<ReportsAnalyticsZone accounts={ACCOUNTS} />);

    await waitFor(() => expect(screen.getByTestId("reports-kpi-grid")).toBeInTheDocument());
    const summary = screen.getByTestId("reports-cashflow-summary");
    expect(within(summary).getByText("Entrou")).toBeInTheDocument();
    expect(within(summary).getByText("R$ 4.000,00")).toBeInTheDocument();
    expect(within(summary).getByText("Saiu")).toBeInTheDocument();
    expect(within(summary).getByText("R$ 3.000,00")).toBeInTheDocument();
    expect(within(summary).getByText("Sobrou")).toBeInTheDocument();
    expect(within(summary).getByText("R$ 1.000,00")).toBeInTheDocument();
    expect(screen.getByText("Taxa de poupança real")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getByText("Patrimônio líquido")).toBeInTheDocument();
    expect(screen.getByText("R$ 5.000,00")).toBeInTheDocument();
    const donut = screen.getByTestId("analytics-block-reports-donut");
    expect(within(donut).getByText("Gastos por categoria")).toBeInTheDocument();
    expect(within(donut).getByText("Outras")).toBeInTheDocument();
    expect(within(donut).getAllByText("Mercado").length).toBeGreaterThanOrEqual(1);
    const budgets = screen.getByTestId("analytics-block-reports-budgets");
    expect(within(budgets).getByText("112%")).toBeInTheDocument();
    expect(screen.getByText("Fluxo de caixa")).toBeInTheDocument();

    const comparison = screen.getByTestId("analytics-block-reports-comparison");
    expect(within(comparison).getByText("Comparativo do período")).toBeInTheDocument();
    expect(within(comparison).getByText("Receitas")).toBeInTheDocument();
    expect(within(comparison).getByText("Despesas")).toBeInTheDocument();
    expect(within(comparison).getByText("Saldo líquido")).toBeInTheDocument();
    expect(within(comparison).getByText("−6.3%")).toBeInTheDocument();
    expect(within(comparison).getByText(/Sobrou R\$\s*200,00 a mais/)).toBeInTheDocument();

    expect(screen.queryByText("Atividade no mês")).not.toBeInTheDocument();
    expect(
      vi.mocked(client.apiFetch).mock.calls.some(([p]) => String(p).startsWith("/analytics/daily-heatmap")),
    ).toBe(false);
  });

  it("toque na fatia mostra o valor no centro", async () => {
    mockOk();
    const user = userEvent.setup();
    render(<ReportsAnalyticsZone accounts={ACCOUNTS} />);
    await waitFor(() => expect(screen.getByTestId("reports-kpi-grid")).toBeInTheDocument());

    const donut = screen.getByTestId("analytics-block-reports-donut");
    await user.click(within(donut).getByRole("button", { name: /Transporte/ }));
    expect(within(donut).getByTestId("donut-center-value")).toHaveTextContent("R$ 20,00");
  });

  it("erro com retry e personalização persistida", async () => {
    vi.mocked(client.apiFetch).mockRejectedValue(new Error("rede caiu"));
    const user = userEvent.setup();
    const { unmount } = render(<ReportsAnalyticsZone accounts={ACCOUNTS} />);

    await waitFor(() =>
      expect(screen.getByText("Não foi possível carregar os gráficos.")).toBeInTheDocument(),
    );
    mockOk();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(screen.getByTestId("reports-kpi-grid")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Editar blocos" }));
    const budgets = screen.getByTestId("analytics-block-reports-budgets");
    await user.click(within(budgets).getByRole("button", { name: /Ocultar Orçamentos/ }));
    expect(budgets.getAttribute("data-hidden")).toBe("true");

    unmount();
    render(<ReportsAnalyticsZone accounts={ACCOUNTS} />);
    await waitFor(() => expect(screen.getByTestId("reports-kpi-grid")).toBeInTheDocument());
    expect(screen.queryByTestId("analytics-block-reports-budgets")).not.toBeInTheDocument();
  });
});
