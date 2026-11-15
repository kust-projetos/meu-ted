import { render, screen } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SidebarRail from "../SidebarRail";

let mockPath = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn() }),
}));

describe("SidebarRail", () => {
  beforeEach(() => {
    mockPath = "/";
  });

  it("renders the Meu Ted logo and branding", () => {
    render(<SidebarRail onNewTransaction={vi.fn()} />);
    expect(screen.getByText("Meu Ted")).toBeInTheDocument();
    expect(screen.getByAltText("Meu Ted")).toBeInTheDocument();
  });

  it("renders canonical navigation items (item 13)", () => {
    render(<SidebarRail onNewTransaction={vi.fn()} />);
    for (const label of ["Início", "Extrato", "Cartões", "Relatórios", "Compromissos", "Contas", "Planejamento", "Metas", "Patrimônio", "Categorias", "Avisos e Lembretes", "Configurações", "Meus Espaços", "Auditoria"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Contas" })).toHaveAttribute("href", "/hub/patrimonio?aba=contas");
  });

  it("marks the active route with aria-current='page'", () => {
    mockPath = "/registros";
    render(<SidebarRail onNewTransaction={vi.fn()} />);

    const registrosLink = screen.getByText("Extrato").closest("a");
    expect(registrosLink).toHaveAttribute("aria-current", "page");

    const resumoLink = screen.getByText("Início").closest("a");
    expect(resumoLink).not.toHaveAttribute("aria-current");
  });

  it("links to the workspace manager and marks it active", () => {
    mockPath = "/workspaces";
    render(<SidebarRail onNewTransaction={vi.fn()} />);

    const workspacesLink = screen.getByRole("link", { name: "Meus Espaços" });
    expect(workspacesLink).toHaveAttribute("href", "/workspaces");
    expect(workspacesLink).toHaveAttribute("aria-current", "page");
  });

  it("calls onNewTransaction when new transaction button is clicked", async () => {
    const handleNewTx = vi.fn();
    const user = userEvent.setup();
    render(<SidebarRail onNewTransaction={handleNewTx} />);

    const newTxBtn = screen.getByRole("button", { name: /novo lançamento/i });
    await user.click(newTxBtn);
    expect(handleNewTx).toHaveBeenCalledTimes(1);
  });

  it("renders theme toggle button", async () => {
    render(<SidebarRail onNewTransaction={vi.fn()} />);
    const themeBtn = screen.getByLabelText(/alternar tema/i);
    expect(themeBtn).toBeInTheDocument();
  });
});
