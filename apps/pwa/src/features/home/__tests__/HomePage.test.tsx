import { render, screen, waitFor, within } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import HomePage from "../HomePage";
import * as appStateModule from "@/lib/state/app-state-context";
import * as workspaceModule from "@/lib/auth/workspace-context";
import type { AppState } from "@/lib/state/app-state-context";
import { readFileSync } from "node:fs";

// V4.1 Phase 5 (SPEC §12.6): the browser defaults to the same-origin proxy,
// so this UI suite pins the unconfigured mock-data provider path explicitly.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, isApiConfigured: () => false };
});
import {
  mockAccounts,
  mockCategories,
  ALL_MOCK_TRANSACTIONS,
  mockPayables,
  mockBudgets,
  mockGoals,
  mockDashboardSummary,
} from "@/lib/state/mock-data";

const mockRouter = { push: vi.fn(), refresh: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

function defaultState(): AppState {
  const today = new Date();
  const currentMonthDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-05`;
  return {
    accounts: [...mockAccounts],
    categories: [...mockCategories],
    transactions: ALL_MOCK_TRANSACTIONS.map((transaction) => ({
      ...transaction,
      date: currentMonthDate,
    })),
    payables: [...mockPayables],
    budgets: [...mockBudgets],
    goals: [...mockGoals],
    debts: [],
    subscriptions: [],
    loading: false,
    error: null,
    dashboardSummary: mockDashboardSummary,
    saveProfile: vi.fn(),
    refreshProfile: vi.fn(),
    refreshDashboardSummary: vi.fn(),
    refreshDomains: vi.fn().mockResolvedValue(undefined),
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
    profile: null,
    addTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    markPayablePaid: vi.fn(),
    cancelPayable: vi.fn(),
    updatePayable: vi.fn(),
    undoPayablePayment: vi.fn(),
    createPayable: vi.fn(),
    createBudget: vi.fn(),
    updateBudget: vi.fn(),
    createGoal: vi.fn(),
    contributeToGoal: vi.fn(),
    cancelGoal: vi.fn(),
    updateGoal: vi.fn(),
    deactivateAccount: vi.fn(),
    updateCategory: vi.fn(),
    deactivateCategory: vi.fn(),
    refreshSubscriptions: vi.fn(),
    cardStatements: [],
    writeError: null,
    clearWriteError: vi.fn(),
    sync: {
      accounts: { source: "mock", syncedAt: null },
      categories: { source: "mock", syncedAt: null },
      transactions: { source: "mock", syncedAt: null },
      payables: { source: "mock", syncedAt: null },
      budgets: { source: "mock", syncedAt: null },
      goals: { source: "mock", syncedAt: null },
      subscriptions: { source: "mock", syncedAt: null },
      cardStatements: { source: "mock", syncedAt: null },
    },
    readOnly: false,
    addAccount: vi.fn(),
    updateAccount: vi.fn(),
    addCategory: vi.fn(),
    addCard: vi.fn(),
    updateCard: vi.fn(),
    addSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    createTransfer: vi.fn(),
    payStatement: vi.fn(),
    createInstallments: vi.fn(),
    createCardPurchase: vi.fn(),
    deleteCategory: vi.fn(),
    applyCategoryDefaults: vi.fn(),
  };
}

describe("HomePage editorial composition", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    window.localStorage.removeItem("meu-ted:hide-balance");
  });
  it("renders greeting, status, balance visibility and a single monthly statement", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /Bom dia|Boa tarde|Boa noite/,
    );
    expect(
      screen.getByText(/Tudo em dia\.|\d+ itens para hoje/),
    ).toBeInTheDocument();
    expect(screen.getByText("Saldo total em contas")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ocultar saldos" }));
    expect(
      screen.getByRole("button", { name: "Mostrar saldos" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll(".statement-sheen")).toHaveLength(1);
    expect(screen.getByText("Receitas")).toBeInTheDocument();
    expect(screen.getByText("Despesas")).toBeInTheDocument();
    expect(screen.getByText("Resultado do mês")).toBeInTheDocument();
    expect(screen.getByText(/% das receitas/)).toBeInTheDocument();
  });
  it("omits the savings rate when income is zero", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      dashboardSummary: { ...mockDashboardSummary, monthIncomeCents: 0 },
    } as AppState);
    render(<HomePage />);
    expect(screen.queryByText(/% guardado/)).not.toBeInTheDocument();
  });
  it("uses only category color tokens defined by the design variables", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
    const css = readFileSync("src/app/globals.css", "utf8");
    const defined = new Set(
      Array.from(css.matchAll(/--([a-zA-Z0-9-]+)\s*:/g), (match) => match[1]),
    );
    render(<HomePage />);
    const band = screen.getByRole("img", { name: /Proporção por categoria/ });
    const variables = Array.from(
      band.querySelectorAll<HTMLElement>("span[style]"),
    )
      .map(
        (segment) =>
          segment.style.backgroundColor.match(/var\(--([^)\s]+)\)/)?.[1],
      )
      .filter((token): token is string => token !== undefined);
    expect(variables.length).toBeGreaterThan(0);
    expect(variables.every((token) => defined.has(token))).toBe(true);
    expect(variables).not.toContain("mint");
  });
  it("shows compact empty lines and relevant actions for empty sections", async () => {
    const user = userEvent.setup();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      accounts: [],
      transactions: [],
      categories: [],
      payables: [],
      cardStatements: [],
    } as AppState);
    render(<HomePage />);
    expect(screen.getByText("Nenhuma conta conectada")).toBeInTheDocument();
    expect(screen.getByText("Nenhum cartão conectado")).toBeInTheDocument();
    expect(screen.getByText("Nada por aqui")).toBeInTheDocument();
    expect(screen.getByText("Sem despesas no período")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Adicionar conta" }));
    expect(mockRouter.push).toHaveBeenCalledWith("/hub/patrimonio?aba=contas");
    await user.click(screen.getByRole("button", { name: "Adicionar cartão" }));
    expect(mockRouter.push).toHaveBeenCalledWith("/hub/patrimonio?aba=cartoes");
  });
  it("shows danger attention for an overdue pending payable", () => {
    const y = new Date();
    y.setDate(y.getDate() - 2);
    const dueDate = y.toISOString().slice(0, 10);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      payables: [
        {
          id: "late",
          description: "Internet",
          amountCents: 8900,
          dueDate,
          status: "pending",
        },
      ],
      cardStatements: [],
    } as AppState);
    render(<HomePage />);
    expect(
      screen.getByRole("button", { name: /Internet vencida/ }).className,
    ).toContain("attention-danger");
  });
  it("renders no attention rail when no rule qualifies", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      accounts: [],
      payables: [],
      cardStatements: [],
    } as AppState);
    render(<HomePage />);
    expect(
      screen.queryByRole("navigation", {
        name: "Itens que precisam de atenção",
      }),
    ).not.toBeInTheDocument();
  });
  it("renders account ledger and bank marks", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      accounts: [
        {
          id: "checking-1",
          name: "Nubank",
          kind: "checking",
          balanceCents: 1200,
        },
      ],
    } as AppState);
    render(<HomePage />);
    expect(
      screen.getByRole("list", { name: "Contas conectadas" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
  });
  it("renders a single featured card with remaining cards in a ledger", () => {
    const cards = [
      {
        id: "c1",
        name: "Nu principal",
        kind: "credit_card" as const,
        balanceCents: 80000,
        balanceSemantics: "outstanding_debt" as const,
        creditLimitCents: 200000,
      },
      {
        id: "c2",
        name: "Nu secundário",
        kind: "credit_card" as const,
        balanceCents: 20000,
        balanceSemantics: "outstanding_debt" as const,
        creditLimitCents: 100000,
      },
    ];
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      accounts: [
        ...mockAccounts.filter((a) => a.kind !== "credit_card"),
        ...cards,
      ],
      payables: [],
      cardStatements: [],
    } as AppState);
    const { container } = render(<HomePage />);
    expect(
      container.querySelectorAll('[data-testid="bank-card"]'),
    ).toHaveLength(1);
    expect(
      screen.getByRole("list", { name: "Outros cartões" }),
    ).toBeInTheDocument();
  });
  it("renders proportion accessible summary and TED insight action", () => {
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
    render(<HomePage />);
    expect(
      screen.getByRole("img", { name: /Proporção por categoria/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TED" })).toBeInTheDocument();
  });
  it("keeps the removed duplicated dashboard stack absent", () => {
    const { container } = render(<HomePage />);
    expect(
      container.querySelector('[data-testid="kpi-delta-row"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="category-donut"]'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Insights")).not.toBeInTheDocument();
  });
  it("preserves profile routing and notifications behavior", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Abrir perfil" }));
    expect(mockRouter.push).toHaveBeenCalledWith("/perfil");
    await user.click(screen.getByRole("button", { name: "Notificações" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("customizes visibility, presets, ordering, persistence and reset", async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem("meu-ted:block-layout:v2:default:home");
    const { unmount } = render(<HomePage />);
    expect(screen.getByText("Contas")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Personalizar início" }));
    expect(screen.getByRole("dialog", { name: "Personalizar início" })).toBeInTheDocument();
    expect(screen.getAllByText("Cartões").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Ocultar Contas" }));
    expect(screen.queryByRole("list", { name: "Contas conectadas" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostrar Contas" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Completa" }));
    expect(screen.getByRole("button", { name: "Ocultar Cartões" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Essencial" }));
    expect(screen.getByRole("button", { name: "Mostrar Cartões" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mover Fechamento do mês para baixo" }));
    expect(screen.getByText("Fechamento do mês movido para a posição 3")).toBeInTheDocument();
    unmount();
    render(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Personalizar início" }));
    expect(screen.getByRole("button", { name: "Mover Fechamento do mês para cima" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Restaurar padrão" }));
    expect(screen.getByRole("button", { name: "Ocultar Cartões" })).toBeInTheDocument();
  });
  it("keeps Home layout customizations isolated per workspace", async () => {
    const user = userEvent.setup();
    const keyA = "meu-ted:block-layout:v2:workspace-a:home";
    const keyB = "meu-ted:block-layout:v2:workspace-b:home";
    window.localStorage.removeItem(keyA);
    window.localStorage.removeItem(keyB);
    const workspace = vi.spyOn(workspaceModule, "useWorkspaceSafe")
      .mockReturnValue({ activeWorkspace: { id: "workspace-a", name: "A" } } as never);

    const { rerender } = render(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Personalizar início" }));
    await user.click(screen.getByRole("button", { name: "Ocultar Contas" }));
    expect(screen.queryByRole("list", { name: "Contas conectadas" })).not.toBeInTheDocument();

    workspace.mockReturnValue({ activeWorkspace: { id: "workspace-b", name: "B" } } as never);
    rerender(<HomePage />);
    await waitFor(() => expect(screen.getByRole("list", { name: "Contas conectadas" })).toBeInTheDocument());

    workspace.mockReturnValue({ activeWorkspace: { id: "workspace-a", name: "A" } } as never);
    rerender(<HomePage />);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Contas conectadas" })).not.toBeInTheDocument());
  });
  it("surfaces strict summary failure and retries it on request", async () => {
    const user = userEvent.setup();
    const refreshDomains = vi.fn().mockResolvedValue(true);
    const refreshStrict = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue({
      activeWorkspace: { id: "ws-1", name: "Casa" },
    } as never);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue({
      ...defaultState(),
      sync: {
        ...defaultState().sync,
        accounts: { source: "snapshot", syncedAt: "2026-06-20T10:00:00.000Z" },
      },
      readOnly: true,
      refreshDomains,
      refreshDashboardSummaryStrict: refreshStrict,
    } as AppState);
    render(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(refreshStrict).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("home-summary-error")).toBeInTheDocument();
    await user.click(
      within(screen.getByTestId("home-summary-error")).getByRole("button", {
        name: "Tentar novamente",
      }),
    );
    expect(refreshStrict).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(
        screen.queryByTestId("home-summary-error"),
      ).not.toBeInTheDocument(),
    );
  });
});
