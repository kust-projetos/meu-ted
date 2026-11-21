import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { DonutChart } from "../DonutChart";
import { CashflowAreaChart } from "../CashflowAreaChart";
import { BudgetBulletBars } from "../BudgetBulletBars";
import { WeeklyHeatmap } from "../WeeklyHeatmap";
import { KpiCard } from "../KpiCard";

const fmt = (cents: number): string => `R$ ${(cents / 100).toFixed(2)}`;

describe("DonutChart", () => {
  const slices = [
    { id: "m1", name: "Moradia", valueCents: 50000, color: "#3E6FB0" },
    { id: "m2", name: "Comida", valueCents: 30000, color: "#E53E3E" },
  ];

  it("renders slice values and total in the accessible summary", () => {
    render(<DonutChart slices={slices} formatValue={fmt} />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toContain("R$ 800.00");
    expect(svg.getAttribute("aria-label")).toContain("Moradia");
    // Center shows the first (largest) slice value (also listed in the legend).
    expect(screen.getAllByText("R$ 500.00").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the tapped slice value in the center", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<DonutChart slices={slices} formatValue={fmt} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Comida/ }));
    expect(onSelect).toHaveBeenCalledWith("m2");
    rerender(<DonutChart slices={slices} formatValue={fmt} onSelect={onSelect} selectedId="m2" />);
    expect(screen.getByTestId("donut-center-value")).toHaveTextContent("R$ 300.00");
  });

  it("renders a gray Outras slice passed by the caller", () => {
    render(
      <DonutChart
        slices={[...slices, { id: "outras", name: "Outras", valueCents: 20000, color: "#9AA5A0" }]}
        formatValue={fmt}
      />,
    );
    expect(screen.getByRole("button", { name: /Outras/ })).toBeInTheDocument();
  });
});

describe("CashflowAreaChart", () => {
  const current = [
    { date: "2026-09-01", valueCents: -1000 },
    { date: "2026-09-02", valueCents: 2000 },
    { date: "2026-09-03", valueCents: 5000 },
  ];
  const previous = [
    { date: "2026-08-29", valueCents: 0 },
    { date: "2026-08-30", valueCents: 1000 },
    { date: "2026-08-31", valueCents: 1000 },
  ];

  it("draws current area plus dashed previous line with text alternative", () => {
    const { container } = render(
      <CashflowAreaChart
        current={[
          { date: "2026-09-01", valueCents: -1000 },
          { date: "2026-09-02", valueCents: 5000 },
        ]}
        previous={[{ date: "2026-08-25", valueCents: 0 }]}
        formatValue={fmt}
      />,
    );
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toContain("R$ 50.00");
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
  });

  it("renders a header summary with accumulated net and delta vs previous period", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    // Net acumulado = último ponto do período atual.
    expect(screen.getByTestId("cashflow-summary-value")).toHaveTextContent("R$ 50.00");
    // Delta vs período anterior = 5000 - 1000.
    const delta = screen.getByTestId("cashflow-summary-delta");
    expect(delta).toHaveTextContent("R$ 40.00");
    expect(delta).toHaveTextContent(/período anterior/i);
  });

  it("accepts an external available balance and delta override (kpis)", () => {
    render(
      <CashflowAreaChart
        current={current}
        previous={previous}
        formatValue={fmt}
        availableBalanceCents={125000}
        deltaCents={-2500}
      />,
    );
    expect(screen.getByTestId("cashflow-summary-value")).toHaveTextContent("R$ 1250.00");
    expect(screen.getByTestId("cashflow-summary-delta")).toHaveTextContent("R$ -25.00");
  });

  it("shows an explicit visual legend for both series", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    expect(screen.getByText("Este período")).toBeInTheDocument();
    expect(screen.getByText("Período anterior")).toBeInTheDocument();
    expect(screen.getByTestId("cashflow-legend-current")).toBeInTheDocument();
    expect(screen.getByTestId("cashflow-legend-previous")).toBeInTheDocument();
  });

  it("renders readable X (DD/MM) and Y (compact money) axes", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    const xAxis = screen.getByTestId("cashflow-x-axis");
    expect(xAxis).toHaveTextContent("01/09");
    expect(xAxis).toHaveTextContent("03/09");
    const yAxis = screen.getByTestId("cashflow-y-axis");
    expect(yAxis.textContent).toMatch(/R\$/);
    expect(yAxis.querySelectorAll("text, [data-testid^='cashflow-y-tick']").length).toBeGreaterThanOrEqual(2);
  });

  it("draws a discreet zero line when values cross negative and positive", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    expect(screen.getByTestId("cashflow-zero-line")).toBeInTheDocument();
  });

  it("does not draw a zero line when all values are positive", () => {
    render(
      <CashflowAreaChart
        current={[
          { date: "2026-09-01", valueCents: 1000 },
          { date: "2026-09-02", valueCents: 2000 },
        ]}
        previous={[{ date: "2026-08-31", valueCents: 500 }]}
        formatValue={fmt}
      />,
    );
    expect(screen.queryByTestId("cashflow-zero-line")).not.toBeInTheDocument();
  });

  it("marks the chart container as a no-swipe zone for the gesture nav", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    expect(screen.getByTestId("cashflow-chart")).toHaveAttribute("data-no-swipe", "true");
  });

  it("reveals a tooltip with date and value on keyboard focus", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    const firstPoint = screen.getByTestId("cashflow-point-0");
    fireEvent.focus(firstPoint);
    const tooltip = screen.getByTestId("cashflow-tooltip");
    expect(tooltip).toHaveTextContent("01/09");
    expect(tooltip).toHaveTextContent("R$ -10.00");
  });

  it("moves the tooltip with arrow keys between points", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    const firstPoint = screen.getByTestId("cashflow-point-0");
    fireEvent.focus(firstPoint);
    fireEvent.keyDown(firstPoint, { key: "ArrowRight" });
    expect(screen.getByTestId("cashflow-tooltip")).toHaveTextContent("R$ 20.00");
  });

  it("reveals a tooltip on touch over a point", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    fireEvent.touchStart(screen.getByTestId("cashflow-point-2"));
    const tooltip = screen.getByTestId("cashflow-tooltip");
    expect(tooltip).toHaveTextContent("03/09");
    expect(tooltip).toHaveTextContent("R$ 50.00");
  });

  it("exposes every point to keyboard and screen readers", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    const points = screen.getAllByRole("button", { name: /R\$/ });
    expect(points).toHaveLength(current.length);
  });

  it("keeps interactive points out of the svg img subtree (valid a11y tree)", () => {
    const { container } = render(
      <CashflowAreaChart current={current} previous={previous} formatValue={fmt} />,
    );
    // O svg continua sendo a alternativa textual estática (retrocompatível).
    expect(screen.getByRole("img")).toBeInTheDocument();
    // Mas nenhum controle interativo vive dentro dele.
    expect(container.querySelectorAll("svg button").length).toBe(0);
    expect(container.querySelectorAll("svg [role='button']").length).toBe(0);
    for (const point of screen.getAllByRole("button", { name: /R\$/ })) {
      expect(point.tagName).toBe("BUTTON");
    }
  });

  it("renders a physical touch-sized hit area on every point", () => {
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    for (const point of screen.getAllByRole("button", { name: /R\$/ })) {
      const width = Number.parseFloat(point.style.width);
      const height = Number.parseFloat(point.style.height);
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(24);
    }
  });

  it("activates the focused point with Enter", async () => {
    const user = userEvent.setup();
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    await user.tab();
    expect(screen.getByTestId("cashflow-point-0")).toHaveFocus();
    await user.keyboard("{Enter}");
    const tooltip = screen.getByTestId("cashflow-tooltip");
    expect(tooltip).toHaveTextContent("01/09");
    expect(tooltip).toHaveTextContent("R$ -10.00");
  });

  it("activates the focused point with Space", async () => {
    const user = userEvent.setup();
    render(<CashflowAreaChart current={current} previous={previous} formatValue={fmt} />);
    await user.tab();
    await user.tab();
    expect(screen.getByTestId("cashflow-point-1")).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByTestId("cashflow-tooltip")).toHaveTextContent("R$ 20.00");
  });

  it("keeps focus and tooltip isolated between two chart instances", () => {
    const other = [
      { date: "2026-09-01", valueCents: 90000 },
      { date: "2026-09-02", valueCents: 95000 },
    ];
    render(
      <>
        <CashflowAreaChart current={current} previous={previous} formatValue={fmt} />
        <CashflowAreaChart current={other} previous={[]} formatValue={fmt} />
      </>,
    );
    const [firstChart, secondChart] = screen.getAllByTestId("cashflow-chart");
    const firstPoint = within(firstChart!).getByTestId("cashflow-point-0");
    fireEvent.focus(firstPoint);
    fireEvent.keyDown(firstPoint, { key: "ArrowRight" });
    // A navegação por setas ficou dentro da primeira instância (escopo por container).
    expect(within(firstChart!).getByTestId("cashflow-tooltip")).toHaveTextContent("R$ 20.00");
    expect(within(secondChart!).queryByTestId("cashflow-tooltip")).not.toBeInTheDocument();
  });

  it("generates a unique gradient id per instance", () => {
    const { container } = render(
      <>
        <CashflowAreaChart current={current} previous={previous} formatValue={fmt} />
        <CashflowAreaChart current={current} previous={previous} formatValue={fmt} />
      </>,
    );
    const svgs = container.querySelectorAll("svg");
    const first = svgs[0]!.querySelector("linearGradient")!.getAttribute("id")!;
    const second = svgs[1]!.querySelector("linearGradient")!.getAttribute("id")!;
    expect(first).not.toBe("cashflow-esmeralda");
    expect(first).not.toBe(second);
  });

  it("keeps a stable scale with zeroed values and a single point", () => {
    const { container } = render(
      <CashflowAreaChart
        current={[{ date: "2026-09-01", valueCents: 0 }]}
        previous={[{ date: "2026-08-31", valueCents: 0 }]}
        formatValue={fmt}
      />,
    );
    expect(screen.getByTestId("cashflow-summary-value")).toHaveTextContent("R$ 0.00");
    const paths = container.querySelectorAll("path");
    for (const path of Array.from(paths)) {
      expect(path.getAttribute("d")).not.toMatch(/NaN/);
    }
  });

  it("honors prefers-reduced-motion on animated paths", () => {
    const { container } = render(
      <CashflowAreaChart current={current} previous={previous} formatValue={fmt} />,
    );
    const animated = container.querySelector(".motion-reduce\\:transition-none");
    expect(animated).not.toBeNull();
  });
});

describe("BudgetBulletBars", () => {
  it("paints over-100% bars red with goal marker and text alternative", () => {
    const { container } = render(
      <BudgetBulletBars
        items={[{ id: "b1", name: "Lazer", spentCents: 12000, amountCents: 10000, pctUsed: 120 }]}
        formatValue={fmt}
      />,
    );
    // jsdom serializes hex to rgb: #F87171 -> rgb(248, 113, 113).
    const fill = container.querySelector('[style*="248, 113, 113"]');
    expect(fill).not.toBeNull();
    expect(screen.getByText("120%")).toBeInTheDocument();
    expect(screen.getByLabelText(/acima do teto/)).toBeInTheDocument();
  });

  it("uses mint below the ceiling", () => {
    const { container } = render(
      <BudgetBulletBars
        items={[{ id: "b1", name: "Comida", spentCents: 5000, amountCents: 10000, pctUsed: 50 }]}
        formatValue={fmt}
      />,
    );
    expect(container.querySelector('[style*="102, 194, 163"]')).not.toBeNull();
  });
});

describe("WeeklyHeatmap", () => {
  const weeks = [0, 1, 2, 3].map((w) => ({
    weekStart: `2026-08-${17 + w * 7}`,
    days: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      date: `2026-08-${17 + w * 7 + d}`,
      totalCents: d === 0 ? 1000 * (w + 1) : 0,
      level: (d === 0 ? Math.min(4, w + 1) : 0) as 0 | 1 | 2 | 3 | 4,
    })),
  }));

  it("renders 7 rows x 4 columns with legend and summary", () => {
    const { container } = render(<WeeklyHeatmap weeks={weeks} formatValue={fmt} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("R$ 40.00");
    expect(container.querySelectorAll('[title^="2026-08"]').length).toBe(28);
    expect(screen.getByText("Mais")).toBeInTheDocument();
  });
});

describe("KpiCard", () => {
  it("renders value, delta and sparkline with accessible group label", () => {
    render(<KpiCard label="Taxa de poupança" value="25%" deltaText="+5 p.p. vs mês anterior" trend="up" spark={[10, 20, 25]} hint="meta >20%" />);
    expect(screen.getByRole("group", { name: /Taxa de poupança: 25%/ })).toBeInTheDocument();
    expect(screen.getByText("+5 p.p. vs mês anterior")).toBeInTheDocument();
    expect(screen.getByText("meta >20%")).toBeInTheDocument();
  });

  it("renders contextual icon and semantic progressbar without truncating labels", () => {
    const { container } = render(
      <KpiCard
        label="Saldo disponível líquido"
        value="R$ 1.250,00"
        deltaText={null}
        icon={<svg aria-hidden="true" data-testid="kpi-icon" />}
        progress={{ valuePct: 16, label: "Utilização do limite: 16.0%" }}
        hint="uso de 16.0% do limite"
      />,
    );
    expect(screen.getByText("Saldo disponível líquido")).toBeInTheDocument();
    expect(container.querySelectorAll(".truncate").length).toBe(0);
    expect(screen.getByTestId("kpi-icon")).toHaveAttribute("aria-hidden", "true");
    const bar = screen.getByRole("progressbar", { name: /Utilização do limite/ });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "16");
  });

  it("omits the progressbar when progress is null", () => {
    render(<KpiCard label="Taxa de poupança" value="—" deltaText={null} hint="Sem renda no período" />);
    expect(screen.getByText("Sem renda no período")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("previne overflow do label em viewports estreitos (min-w-0 break-words)", () => {
    render(<KpiCard label="Fixo vs discricionário" value="R$ 1,00" deltaText={null} />);
    const label = screen.getByText("Fixo vs discricionário");
    expect(label.className).toMatch(/min-w-0/);
    expect(label.className).toMatch(/break-words/);
  });

  it("pinta a barra de danger quando a porcentagem passa de 100%", () => {
    render(
      <KpiCard
        label="Faturas em aberto"
        value="R$ 1,00"
        deltaText={null}
        progress={{ valuePct: 120, label: "Utilização do limite: 120.0%" }}
        hint="uso de 120.0% do limite"
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /Utilização do limite/ });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar.firstChild).toHaveClass("bg-danger");
  });

  it("mantém a barra em primary até 100%", () => {
    render(
      <KpiCard
        label="Faturas em aberto"
        value="R$ 1,00"
        deltaText={null}
        progress={{ valuePct: 16, label: "Utilização do limite: 16.0%" }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /Utilização do limite/ });
    expect(bar).toHaveAttribute("aria-valuenow", "16");
    expect(bar.firstChild).toHaveClass("bg-primary");
  });

  it("destaca valor negativo com tom danger e mantém '—' neutro", () => {
    const { rerender } = render(
      <KpiCard label="Saldo disponível líquido" value="R$ -10,00" deltaText={null} />,
    );
    const negative = screen.getByText("R$ -10,00");
    expect(negative.className).toMatch(/text-danger/);
    expect(negative.className).not.toMatch(/text-text-primary/);

    rerender(<KpiCard label="Taxa de poupança" value="—" deltaText={null} />);
    // Sem delta/sparkline, apenas o valor neutro "—" é exibido.
    const dashes = screen.getAllByText("—");
    expect(dashes).toHaveLength(1);
    expect(dashes[0]!.className).toMatch(/text-text-primary/);
    expect(dashes[0]!.className).not.toMatch(/text-danger/);
  });
});
