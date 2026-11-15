import { render, screen } from "@/lib/test-utils";
import ReportsPage from "../ReportsPage";

// H-10: Relatórios has a single source of truth — the server-driven
// ReportsAnalyticsZone. No client-side duplicate aggregates may render.
describe("ReportsPage", () => {
  it("renders the page header", () => {
    render(<ReportsPage />);
    expect(screen.getByText("Relatórios")).toBeInTheDocument();
  });

  it("renders the server-driven analytics zone", () => {
    render(<ReportsPage />);
    expect(screen.getByTestId("reports-analytics-zone")).toBeInTheDocument();
  });

  it("keeps operational adoption metrics out of financial reports", () => {
    render(<ReportsPage />);
    expect(screen.queryByText("Adoção das notificações")).not.toBeInTheDocument();
  });

  it("does not render legacy client-computed duplicates", () => {
    render(<ReportsPage />);
    expect(screen.queryByText(/Resultado do período/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fluxo mensal/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Distribuição de gastos/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Top categorias/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Evolução patrimonial/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Orçamentos vs Real/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ticket médio/i)).not.toBeInTheDocument();
  });
});
