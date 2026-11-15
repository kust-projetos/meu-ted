import { fireEvent, render, screen } from "@testing-library/react";
import {
  AttentionChip,
  InsightLine,
  Ledger,
  LedgerRow,
  ProportionBand,
  SectionHeader,
  StatementPanel,
} from "../index";

describe("design primitives", () => {
  it("renders a titled section with optional meta and action", () => {
    render(<SectionHeader title="Atividade" meta="Este mês" action={<button>Ver tudo</button>} />);
    expect(screen.getByRole("heading", { name: "Atividade", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("Este mês")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver tudo" })).toBeInTheDocument();
  });

  it("renders ledger rows as semantic list items and makes clickable rows buttons", () => {
    const onClick = vi.fn();
    render(
      <Ledger label="Transações">
        <LedgerRow primary="Mercado" secondary="Hoje" trailing="− R$ 40,00" onClick={onClick} />
        <LedgerRow primary="Salário" trailing="R$ 3.000,00" />
      </Ledger>,
    );
    expect(screen.getByRole("list", { name: "Transações" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Mercado/ }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByText("− R$ 40,00")).toHaveClass("tabular");
  });

  it("renders statement content and footer", () => {
    render(<StatementPanel eyebrow="Junho" footer="Atualizado agora"><strong>Saldo mensal</strong></StatementPanel>);
    expect(screen.getByText("Junho")).toBeInTheDocument();
    expect(screen.getByText("Saldo mensal")).toBeInTheDocument();
    expect(screen.getByText("Atualizado agora")).toBeInTheDocument();
  });

  it.each(["danger", "warning", "neutral"] as const)("uses the %s attention tone", (tone) => {
    const { container } = render(<AttentionChip tone={tone} label="Ação pendente" value="2" />);
    expect(container.firstChild).toHaveAttribute("data-tone", tone);
    expect(container.firstChild).toHaveClass(`bg-[var(--attention-${tone}-bg)]`);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("uses a button for an interactive attention chip", () => {
    const onClick = vi.fn();
    render(<AttentionChip tone="warning" label="Vencimentos" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Vencimentos" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("summarizes proportion segments accessibly and renders the legend", () => {
    render(
      <ProportionBand segments={[
        { label: "Casa", pct: 60, colorToken: "primary", amount: "R$ 600" },
        { label: "Lazer", pct: 40, colorToken: "var(--accent-money)" },
      ]} />,
    );
    expect(screen.getByRole("img", { name: "Proporção por categoria — Casa: 60%, Lazer: 40%" })).toBeInTheDocument();
    expect(screen.getByText(/R\$ 600/)).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("renders an insight line without a card wrapper", () => {
    render(<InsightLine>Seu mês está dentro do planejado.</InsightLine>);
    expect(screen.getByText("Seu mês está dentro do planejado.").closest("aside")).toHaveClass("hairline-t");
  });
});
