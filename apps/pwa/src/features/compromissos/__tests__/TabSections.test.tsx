import { render, screen } from "@/lib/test-utils";
import CompromissosTabs from "../CompromissosTabs";
import PatrimonioTabs from "../../patrimonio/PatrimonioTabs";
import PlanejamentoTabs from "../../planejamento/PlanejamentoTabs";
import AlertasTabs from "../../alertas/AlertasTabs";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  pathname: "/compromissos",
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/features/payables/PayablesPage", () => ({
  default: () => <div data-testid="payables-page">Payables</div>,
}));
vi.mock("@/features/accounts/AccountsPage", () => ({
  default: () => <div data-testid="accounts-page">Accounts</div>,
}));
vi.mock("@/features/cards/CardsPage", () => ({
  default: () => <div data-testid="cards-page">Cards</div>,
}));
vi.mock("@/features/wallet/WalletPage", () => ({
  default: () => <div data-testid="wallet-page">Wallet</div>,
}));
vi.mock("@/features/budgets/BudgetsPage", () => ({
  default: () => <div data-testid="budgets-page">Budgets</div>,
}));
vi.mock("@/features/goals/GoalsPage", () => ({
  default: () => <div data-testid="goals-page">Goals</div>,
}));
vi.mock("@/features/subscriptions/SubscriptionsPage", () => ({
  default: () => <div data-testid="subscriptions-page">Subscriptions</div>,
}));
vi.mock("@/features/price-alerts/PriceAlertsPage", () => ({
  default: () => <div data-testid="price-page">Price</div>,
}));
vi.mock("@/features/profile/NotificationsSheet", () => ({
  default: ({ inline }: { inline?: boolean }) => (
    <div data-testid="notifications-panel" data-inline={String(inline ?? false)}>Notifications</div>
  ),
}));

describe("canonical tab sections (item 13)", () => {
  beforeEach(() => {
    navigation.replace.mockClear();
    navigation.search = "";
  });

  it("compromissos renders only A Pagar (no aprovações tab)", () => {
    navigation.pathname = "/compromissos";
    render(<CompromissosTabs />);
    expect(screen.getByTestId("payables-page")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("patrimonio cycles contas, cartoes and patrimonio tabs", () => {
    navigation.pathname = "/hub/patrimonio";
    navigation.search = "";
    const { unmount } = render(<PatrimonioTabs />);
    expect(screen.getByTestId("accounts-page")).toBeInTheDocument();
    unmount();

    navigation.search = "aba=cartoes";
    const second = render(<PatrimonioTabs />);
    expect(screen.getByTestId("cards-page")).toBeInTheDocument();
    second.unmount();

    navigation.search = "aba=patrimonio";
    render(<PatrimonioTabs />);
    expect(screen.getByTestId("wallet-page")).toBeInTheDocument();
  });

  it("planejamento cycles orcamentos, metas and assinaturas tabs", () => {
    navigation.pathname = "/hub/planejamento";
    navigation.search = "";
    const { unmount } = render(<PlanejamentoTabs />);
    expect(screen.getByTestId("budgets-page")).toBeInTheDocument();
    unmount();

    navigation.search = "aba=metas";
    const second = render(<PlanejamentoTabs />);
    expect(screen.getByTestId("goals-page")).toBeInTheDocument();
    second.unmount();

    navigation.search = "aba=assinaturas";
    render(<PlanejamentoTabs />);
    expect(screen.getByTestId("subscriptions-page")).toBeInTheDocument();
  });

  it("alertas shows the inline financeiras panel by default and preco on demand", () => {
    navigation.pathname = "/hub/alertas";
    navigation.search = "";
    const { unmount } = render(<AlertasTabs />);
    const panel = screen.getByTestId("notifications-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute("data-inline", "true");
    expect(screen.queryByTestId("price-page")).not.toBeInTheDocument();
    unmount();

    navigation.search = "aba=preco";
    render(<AlertasTabs />);
    expect(screen.getByTestId("price-page")).toBeInTheDocument();
  });
});
