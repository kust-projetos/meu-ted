import { render, screen, fireEvent, act, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";

const mockRouter = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

import RecordsPage from "../RecordsPage";
import * as appStateModule from "@/lib/state/app-state-context";
import { mockAccounts, mockCategories, ALL_MOCK_TRANSACTIONS, mockPayables, mockBudgets, mockGoals } from "@/lib/state/mock-data";
import type { AppState } from "@/lib/state/app-state-context";

// V4.1 Phase 5 (SPEC §12.6): the browser defaults to the same-origin proxy,
// so this UI suite pins the unconfigured mock-data provider path explicitly.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, isApiConfigured: () => false };
});

function defaultState(): AppState {
  return {
    accounts: [...mockAccounts],
    categories: [...mockCategories],
    transactions: [...ALL_MOCK_TRANSACTIONS],
    payables: [...mockPayables],
    budgets: [...mockBudgets],
    goals: [...mockGoals],
    debts: [],
    subscriptions: [],
    cardStatements: [],
    loading: false,
    error: null,
    writeError: null,
    clearWriteError: vi.fn(),
    profile: null,
    dashboardSummary: null,
    saveProfile: vi.fn(),
    refreshProfile: vi.fn(),
    refreshDashboardSummary: vi.fn(),
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
    addTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    markPayablePaid: vi.fn(),
    cancelPayable: vi.fn(),
    createPayable: vi.fn(),
    createBudget: vi.fn(),
    updateBudget: vi.fn(),
    createGoal: vi.fn(),
    contributeToGoal: vi.fn(),
    cancelGoal: vi.fn(),
    addAccount: vi.fn(),
    addCategory: vi.fn(),
    addCard: vi.fn(),
    updateCard: vi.fn(),
    addSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    createTransfer: vi.fn(),
    payStatement: vi.fn(),
    createInstallments: vi.fn(),
    createCardPurchase: vi.fn(),
    updatePayable: vi.fn(),
    undoPayablePayment: vi.fn(),
    updateGoal: vi.fn(),
    updateAccount: vi.fn(),
    deactivateAccount: vi.fn(),
    updateCategory: vi.fn(),
    deactivateCategory: vi.fn(),
    deleteCategory: vi.fn(),
    applyCategoryDefaults: vi.fn(),
    updateSubscription: vi.fn(),
    refreshSubscriptions: vi.fn(),
    refreshDomains: vi.fn(),
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
  };
}

function mockState(overrides: Partial<AppState>): AppState {
  return { ...defaultState(), ...overrides };
}

describe("RecordsPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("with data", () => {
    it("renders the page header", () => {
      render(<RecordsPage />);
      expect(screen.getByText("Extrato")).toBeInTheDocument();
    });

    it("renders all transactions by default", () => {
      render(<RecordsPage />);
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      expect(screen.getByText("Salário Junho")).toBeInTheDocument();
      expect(screen.getByText("PIX para Nubank")).toBeInTheDocument();
    });

    it("displays transaction notes under the description (item 10/B4)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          transactions: [
            {
              id: "tx-notes",
              kind: "expense",
              description: "Mercado",
              amountCents: 5000,
              date: "2026-06-20",
              categoryId: "cat1",
              accountId: "acc1",
              notes: "Compra do mês",
            } as never,
          ],
        }),
      );
      render(<RecordsPage />);
      expect(screen.getByText("Mercado")).toBeInTheDocument();
      expect(screen.getByText("Compra do mês")).toBeInTheDocument();
    });

    it("renders category icons in Extrato rows and initials when the icon is null", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          categories: mockCategories.map((category) => ({
            ...category,
            icon: category.id === "cat1" ? "UtensilsCrossed" : category.id === "cat2" ? "" : category.icon,
          })),
          transactions: [
            {
              id: "tx-icon",
              kind: "expense",
              description: "Ícone conhecido",
              amountCents: 5000,
              date: "2026-06-20",
              categoryId: "cat1",
              accountId: "acc1",
            },
            {
              id: "tx-no-icon",
              kind: "expense",
              description: "Sem ícone",
              amountCents: 5000,
              date: "2026-06-20",
              categoryId: "cat2",
              accountId: "acc1",
            },
          ] as never,
        }),
      );
      render(<RecordsPage />);

      const iconRow = screen.getByText("Ícone conhecido").closest(".border-b");
      expect(iconRow?.querySelector("[data-testid='category-badge'] svg")).toBeInTheDocument();
      const noIconRow = screen.getByText("Sem ícone").closest(".border-b");
      expect(noIconRow?.querySelector("[data-testid='category-badge']")).toHaveTextContent("T");
      expect(noIconRow?.querySelector("[data-testid='category-badge'] svg")).not.toBeInTheDocument();
    });

    it("filters by type: only expenses (via filter sheet)", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByText("Despesas"));
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      expect(screen.queryByText("Salário Junho")).not.toBeInTheDocument();
      expect(screen.queryByText("PIX para Nubank")).not.toBeInTheDocument();
    });

    it("filters by type: only transfers (via filter sheet)", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByText("Transf."));
      expect(screen.getByText("PIX para Nubank")).toBeInTheDocument();
      expect(screen.queryByText("Supermercado Extra")).not.toBeInTheDocument();
    });

    it("filters by period 7d (via filter sheet)", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByText("7d"));
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      expect(screen.queryByText("Aluguel")).not.toBeInTheDocument();
      expect(screen.queryByText("Salário Junho")).not.toBeInTheDocument();
    });

    it("filters by search text and exposes persistent label and direct clear button (mobile audit 05)", () => {
      render(<RecordsPage />);
      const searchInput = screen.getByLabelText("Buscar lançamento");
      fireEvent.change(searchInput, { target: { value: "Uber" } });
      expect(screen.getByText("Uber para casa")).toBeInTheDocument();
      expect(screen.queryByText("Supermercado Extra")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Limpar busca" }));
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
    });

    it("allows direct removal of active filters outside the filter sheet (mobile audit 05)", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByText("Despesas"));
      expect(screen.queryByText("Salário Junho")).not.toBeInTheDocument();
      const activeBar = screen.getByTestId("active-filters-bar");
      expect(activeBar).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Remover filtro Despesas/i }));
      expect(screen.getByText("Salário Junho")).toBeInTheDocument();
    });

    it("shows empty state when no results match", () => {
      render(<RecordsPage />);
      const searchInput = screen.getByPlaceholderText(/buscar/i);
      fireEvent.change(searchInput, { target: { value: "ZZZZNOTFOUND" } });
      expect(screen.getByText(/nada encontrado/i)).toBeInTheDocument();
    });

    it("groups transactions by date", () => {
      render(<RecordsPage />);
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      expect(screen.getByText("Ifood")).toBeInTheDocument();
    });

    it("renders a compact filter trigger button", () => {
      render(<RecordsPage />);
      const trigger = screen.getByTestId("filter-trigger");
      expect(trigger).toBeInTheDocument();
      expect(trigger.textContent).toMatch(/Filtro/i);
    });

    it("clicking filter trigger opens a BottomSheet", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("filter sheet shows type, period with new options (Hoje, Este mes, Personalizado)", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      expect(screen.getByText("Despesas")).toBeInTheDocument();
      expect(screen.getByText("Receitas")).toBeInTheDocument();
      expect(screen.getByText("Hoje")).toBeInTheDocument();
      expect(screen.getByText("Este mês")).toBeInTheDocument();
      expect(screen.getByText("Personalizado")).toBeInTheDocument();
    });

    it("category is shown as single selector trigger, not chips", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      expect(screen.getByTestId("category-selector-trigger")).toBeInTheDocument();
      expect(screen.queryByText("Alimentação")).not.toBeInTheDocument();
    });

    it("category selector opens a list with Voltar, Todas as categorias and categories", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByTestId("category-selector-trigger"));
      expect(screen.getByText("Voltar")).toBeInTheDocument();
      expect(screen.getByText("Todas as categorias")).toBeInTheDocument();
      expect(screen.getByText("Alimentação")).toBeInTheDocument();
    });

    it("selecting a category filters results and shows badge", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByTestId("category-selector-trigger"));
      fireEvent.click(screen.getByText("Alimentação"));
      expect(screen.getByTestId("filter-trigger").textContent).toMatch(/Alimentação/);
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      expect(screen.queryByText("Uber para casa")).not.toBeInTheDocument();
    });

    it("custom date inputs appear when Personalizado is selected", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByText("Personalizado"));
      expect(screen.getByText(/Data inicial/i)).toBeInTheDocument();
      expect(screen.getByText(/Data final/i)).toBeInTheDocument();
    });
  });

  describe("accountId filter from URL (?accountId=)", () => {
    function setUrlSearch(search: string) {
      Object.defineProperty(window, "location", {
        value: { ...window.location, search },
        writable: true,
        configurable: true,
      });
    }

    it("filters transactions by accountId when ?accountId= is in the URL", () => {
      setUrlSearch("?accountId=acc1");
      render(<RecordsPage />);
      // Nubank (acc1) transactions should be visible
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      // Itaú (acc2) transactions should be filtered out
      expect(screen.queryByText("Aluguel")).not.toBeInTheDocument();
    });

    it("shows account name badge when account filter is active", () => {
      setUrlSearch("?accountId=acc1");
      render(<RecordsPage />);
      const trigger = screen.getByTestId("filter-trigger");
      expect(trigger.textContent).toMatch(/Nubank/);
    });

    it("shows all transactions when ?accountId is missing", () => {
      setUrlSearch("");
      render(<RecordsPage />);
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      expect(screen.getByText("Aluguel")).toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows loading skeleton elements when loading", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ loading: true }));
      const { container } = render(<RecordsPage />);
      const skeleton = container.querySelector('[role="status"]');
      expect(skeleton).toBeTruthy();
      expect(screen.queryByText("Supermercado Extra")).not.toBeInTheDocument();
    });
  });

  describe("row actions", () => {
    it("shows action sheet when a transaction row is clicked", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByText("Supermercado Extra"));
      expect(screen.getByText("Editar")).toBeInTheDocument();
      expect(screen.getByText("Excluir")).toBeInTheDocument();
    });
  });

  describe("stale state", () => {
    it("shows stale banner when transactions are from snapshot (read-only)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          sync: {
            accounts: { source: "mock", syncedAt: null },
            categories: { source: "mock", syncedAt: null },
            transactions: {
              source: "snapshot",
              syncedAt: "2026-06-25T10:00:00.000Z",
            },
            payables: { source: "mock", syncedAt: null },
            budgets: { source: "mock", syncedAt: null },
            goals: { source: "mock", syncedAt: null },
            subscriptions: { source: "mock", syncedAt: null },
            cardStatements: { source: "mock", syncedAt: null },
          },
          readOnly: true,
        }),
      );
      render(<RecordsPage />);
      expect(screen.getByTestId("stale-banner")).toBeInTheDocument();
    });

    it("shows unavailable banner when transactions are unavailable", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          sync: {
            accounts: { source: "mock", syncedAt: null },
            categories: { source: "mock", syncedAt: null },
            transactions: {
              source: "unavailable",
              syncedAt: null,
            },
            payables: { source: "mock", syncedAt: null },
            budgets: { source: "mock", syncedAt: null },
            goals: { source: "mock", syncedAt: null },
            subscriptions: { source: "mock", syncedAt: null },
            cardStatements: { source: "mock", syncedAt: null },
          },
          readOnly: true,
        }),
      );
      render(<RecordsPage />);
      expect(screen.getByText(/indisponível/i)).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error banner when error is set", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ error: "Erro de rede" }),
      );
      render(<RecordsPage />);
      expect(screen.getByText(/Erro de rede/i)).toBeInTheDocument();
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
    });
  });

  describe("edit sheet account selector includes cards", () => {
    it("account options show 'Cartão' prefix for credit cards", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByText("Supermercado Extra"));
      fireEvent.click(screen.getByText("Editar"));
      const accountSelects = screen.getAllByRole("combobox");
      const acctSelect = accountSelects[accountSelects.length - 1] as HTMLSelectElement;
      const options = Array.from(acctSelect.options);
      const cardOption = options.find((o) => o.textContent?.includes("Cartão"));
      expect(cardOption).toBeTruthy();
    });

    it("account options show 'Conta' prefix for non-credit accounts", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByText("Supermercado Extra"));
      fireEvent.click(screen.getByText("Editar"));
      const accountSelects = screen.getAllByRole("combobox");
      const acctSelect = accountSelects[accountSelects.length - 1] as HTMLSelectElement;
      const options = Array.from(acctSelect.options);
      const contaOption = options.find((o) => o.textContent?.startsWith("Conta"));
      expect(contaOption).toBeTruthy();
    });
  });

  describe("extended handler coverage", () => {
    it("opens edit sheet via Editar action", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByText("Supermercado Extra"));
      fireEvent.click(screen.getByText("Editar"));
      // Edit sheet should be open (header text from TransactionEditSheet)
      expect(screen.getByText(/Editar transação|Editar lançamento/i)).toBeInTheDocument();
    });

    it("Excluir opens confirmation dialog instead of deleting immediately", async () => {
      const delSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ deleteTransaction: delSpy }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<RecordsPage />);
      await user.click(screen.getByText("Supermercado Extra"));
      await user.click(screen.getByText("Excluir"));
      // Cancel button in the dialog should be visible (proves dialog opened)
      // and deleteTransaction should NOT have been called yet
      expect(screen.getByText("Cancelar")).toBeInTheDocument();
      expect(delSpy).not.toHaveBeenCalled();
    });

    it("canceling confirmation does NOT call deleteTransaction", async () => {
      const delSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ deleteTransaction: delSpy }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<RecordsPage />);
      await user.click(screen.getByText("Supermercado Extra"));
      await user.click(screen.getByText("Excluir"));
      // Cancel
      await user.click(screen.getByText("Cancelar"));
      expect(delSpy).not.toHaveBeenCalled();
    });

    it("confirming calls deleteTransaction once with correct id", async () => {
      const delSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ deleteTransaction: delSpy }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<RecordsPage />);
      // Open action sheet
      await user.click(screen.getByText("Supermercado Extra"));
      // Verify action sheet is open (ConfirmActionDialog is NOT yet open)
      const dialogsBefore = document.querySelectorAll('[role="dialog"]');
      expect(dialogsBefore.length).toBe(1); // only action sheet
      // Click Excluir in action sheet → opens ConfirmActionDialog
      await user.click(screen.getByText("Excluir"));
      // Action sheet closes; confirm dialog opens — Editar/Excluir buttons gone
      expect(screen.queryByText("Editar")).not.toBeInTheDocument();
      // ConfirmActionDialog has Cancelar and Excluir buttons
      expect(screen.queryByText("Cancelar")).toBeInTheDocument();
      // Click Excluir in dialog
      await user.click(screen.getByText("Excluir"));
      expect(delSpy).toHaveBeenCalledTimes(1);
      expect(delSpy).toHaveBeenCalledWith("tx1");
    });

    it("updates custom date inputs when typed", () => {
      const { container } = render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByText("Personalizado"));
      const dateInputs = container.querySelectorAll('input[type="date"]');
      expect(dateInputs.length).toBe(2);
      fireEvent.change(dateInputs[0]!, { target: { value: "2026-06-01" } });
      expect((dateInputs[0] as HTMLInputElement).value).toBe("2026-06-01");
      fireEvent.change(dateInputs[1]!, { target: { value: "2026-06-30" } });
      expect((dateInputs[1] as HTMLInputElement).value).toBe("2026-06-30");
    });

    it("resets category filter via 'Todas as categorias'", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByTestId("category-selector-trigger"));
      fireEvent.click(screen.getByText("Todas as categorias"));
      expect(screen.getByTestId("filter-trigger").textContent).toMatch(/Filtro/i);
    });

    it("returns to main filter page via 'Voltar'", () => {
      render(<RecordsPage />);
      fireEvent.click(screen.getByTestId("filter-trigger"));
      fireEvent.click(screen.getByTestId("category-selector-trigger"));
      fireEvent.click(screen.getByText("Voltar"));
      expect(screen.getByTestId("category-selector-trigger")).toBeInTheDocument();
    });
  });

  describe("empty states (v2 A4)", () => {
    it("shows onboarding copy and Novo lançamento CTA when there are no transactions", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ transactions: [] }),
      );
      render(<RecordsPage />);
      expect(screen.getByText(/nenhum lançamento ainda/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /novo lançamento/i })).toBeInTheDocument();
      expect(screen.queryByText(/nada encontrado/i)).not.toBeInTheDocument();
    });

    it("dispatches pwa:open-tx (expense) when Novo lançamento is clicked", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ transactions: [] }),
      );
      const handler = vi.fn();
      window.addEventListener("pwa:open-tx", handler);
      try {
        render(<RecordsPage />);
        fireEvent.click(screen.getByRole("button", { name: /novo lançamento/i }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({
          kind: "expense",
        });
      } finally {
        window.removeEventListener("pwa:open-tx", handler);
      }
    });

    it("shows filter copy and Ver tudo when search has no matches; Ver tudo clears", () => {
      render(<RecordsPage />);
      const searchInput = screen.getByPlaceholderText(/buscar/i);
      fireEvent.change(searchInput, { target: { value: "ZZZZNOTFOUND" } });
      expect(screen.getByText(/nada encontrado/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /novo lançamento/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /ver tudo/i }));
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
    });
  });

  describe("pull-to-refresh (v2 F4)", () => {
    function installCoarsePointer() {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query === "(pointer: coarse)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: () => false,
        }),
      });
    }

    function pullWindow(distance: number) {
      const point = (y: number) => [{ clientX: 100, clientY: y, identifier: 0 }];
      const start = new Event("touchstart", { bubbles: true, cancelable: true });
      (start as unknown as { touches: unknown }).touches = point(120);
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      (move as unknown as { touches: unknown }).touches = point(120 + distance);
      const end = new Event("touchend", { bubbles: true, cancelable: true });
      act(() => {
        window.dispatchEvent(start);
        window.dispatchEvent(move);
      });
      return end;
    }

    it("pull from the top refreshes transactions and accounts", async () => {
      installCoarsePointer();
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ refreshDomains: refreshSpy }),
      );
      render(<RecordsPage />);
      // 170px crus com damping 0.45 = 76.5px exibidos (threshold 64px).
      const end = pullWindow(170);
      await act(async () => {
        window.dispatchEvent(end);
      });
      await waitFor(() =>
        expect(refreshSpy).toHaveBeenCalledWith(["transactions", "accounts"]),
      );
    });
  });
});
