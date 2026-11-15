import { render, screen } from "@/lib/test-utils";
import Hub from "../../hub/page";
import HubConfiguracoes from "../../hub/configuracoes/page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/hub",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/AppShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("hub pages (item 13)", () => {
  it("hub lists the six canonical modules with links", () => {
    render(<Hub />);
    expect(screen.getByRole("heading", { name: "Explorar" })).toBeInTheDocument();
    for (const [label, href] of [
      ["Contas", "/hub/patrimonio?aba=contas"],
      ["Cartões", "/hub/patrimonio?aba=cartoes"],
      ["Planejamento", "/hub/planejamento"],
      ["Metas", "/hub/planejamento?aba=metas"],
      ["Patrimônio", "/hub/patrimonio?aba=patrimonio"],
      ["Relatórios", "/hub/relatorios"],
      ["Avisos e Lembretes", "/hub/alertas"],
      ["Categorias", "/hub/categorias"],
      ["Configurações", "/hub/configuracoes"],
    ] as const) {
      const link = screen.getAllByRole("link").find((candidate) =>
        candidate.getAttribute("href") === href,
      );
      expect(link).toBeDefined();
      expect(link).toHaveTextContent(label);
    }
  });

  it("configuracoes links the kept real subpages", () => {
    render(<HubConfiguracoes />);
    expect(screen.getByRole("heading", { name: "Configurações" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Perfil/ })).toHaveAttribute("href", "/perfil");
    expect(screen.getByRole("link", { name: /Meus Espaços/ })).toHaveAttribute("href", "/workspaces");
    expect(screen.getByRole("link", { name: /Auditoria/ })).toHaveAttribute("href", "/audit");
  });
});
