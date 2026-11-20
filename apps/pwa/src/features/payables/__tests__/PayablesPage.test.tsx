import { render, screen, within, act, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import PayablesPage from "../PayablesPage";
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
    loading: false,
    error: null,
    addTransaction: vi.fn(),
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
    cardStatements: [],
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
    updateTransaction: vi.fn(),
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

describe("PayablesPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-25T12:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("with data", () => {
    it("renders the page header", () => {
      render(<PayablesPage />);      expect(screen.getByText("Contas a pagar")).toBeInTheDocument();
    });

    it("renders KPI totals", () => {
      render(<PayablesPage />);
      const totalMatches = screen.getAllByText(/2\.140,\d{2}/);
      expect(totalMatches.length).toBeGreaterThanOrEqual(1);
    });

    it("renders all payable descriptions", () => {
      render(<PayablesPage />);
      expect(screen.getByText("Luz")).toBeInTheDocument();
      expect(screen.getByText("Internet")).toBeInTheDocument();
      expect(screen.getByText("Aluguel")).toBeInTheDocument();
    });

    it("renders filter chips", () => {
      render(<PayablesPage />);
      expect(screen.getByText("Todas")).toBeInTheDocument();
      expect(screen.getByText("Próximas")).toBeInTheDocument();
      expect(screen.getByText("Vencidas")).toBeInTheDocument();
      expect(screen.getByText("Pagas")).toBeInTheDocument();
    });

    it("marks the horizontal chip scroller as a swipe opt-out (v2 F1)", () => {
      const { container } = render(<PayablesPage />);
      const scroller = screen.getByText("Todas").closest("div.overflow-x-auto");
      expect(scroller).toBeInTheDocument();
      expect(scroller).toHaveAttribute("data-no-swipe");
      expect(container.querySelectorAll("[data-no-swipe]").length).toBeGreaterThanOrEqual(1);
    });

    it("shows grouped sections and formats due dates in pt-BR instead of raw ISO (mobile audit 11)", () => {
      render(<PayablesPage />);
      expect(screen.getAllByText(/Vencidas/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/Próximas/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/Pagas/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/Venceu em 20\/06\/2026/)).toBeInTheDocument();
      expect(screen.queryByText(/2026-06-20/)).not.toBeInTheDocument();
    });

    it("no inline Pago/Cancelar buttons exist on cards", () => {
      render(<PayablesPage />);
      expect(screen.queryByText(/✓ Pago/)).not.toBeInTheDocument();
      expect(screen.queryAllByRole("button", { name: /^Cancelar$/ })).toHaveLength(0);
    });

    it("clicking a payable card opens a detail sheet", async () => {
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Luz"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Marcar como paga")).toBeInTheDocument();
      expect(screen.getByText("Cancelar conta")).toBeInTheDocument();
    });

    it("detail sheet for a paid payable shows editable fields but no mark-paid action", async () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        payables: [{ id: "p-paid", description: "Conta Paga", amountCents: 50000, dueDate: "2026-06-01", status: "paid" }],
      }));
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Conta Paga"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Editable: shows Salvar alterações
      expect(screen.getByText("Salvar alterações")).toBeInTheDocument();
      // But NOT mark-as-paid or cancel (already paid)
      expect(screen.queryByText("Marcar como paga")).not.toBeInTheDocument();
      expect(screen.queryByText("Cancelar conta")).not.toBeInTheDocument();
    });

    it("calls markPayablePaid from detail sheet", async () => {
      const markPaidSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ markPayablePaid: markPaidSpy }));
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Luz"));
      await user.click(screen.getByText("Marcar como paga"));
      expect(markPaidSpy).toHaveBeenCalledWith("p2");
    });

    it("cancel dialog has distinct labels", async () => {
      const user = userEvent.setup();
      render(<PayablesPage />);
      // Click a card to open detail sheet
      await user.click(screen.getByText("Luz"));
      await user.click(screen.getByText("Cancelar conta"));

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("button", { name: /sim.*cancelar conta/i })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^voltar$/i })).toBeInTheDocument();
    });

    it("cancel dialog confirm button calls cancelPayable", async () => {
      const cancelPayableSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ cancelPayable: cancelPayableSpy, payables: [{ id: "p1", description: "Aluguel", amountCents: 180000, dueDate: "2026-07-01", status: "pending" }] }));
      const user = userEvent.setup();
      render(<PayablesPage />);

      // Only 1 payable. Click the card, then Cancelar conta.
      await user.click(screen.getByText("Aluguel"));
      await user.click(screen.getByText("Cancelar conta"));
      await user.click(screen.getByRole("button", { name: /sim.*cancelar conta/i }));

      expect(cancelPayableSpy).toHaveBeenCalledTimes(1);
      expect(cancelPayableSpy).toHaveBeenCalledWith("p1");
    });

    it("calls updatePayable from detail sheet when save is clicked", async () => {
      const updatePayableSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updatePayable: updatePayableSpy }));
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Luz"));

      // Change value in text field
      const descInput = screen.getByDisplayValue("Luz");
      await user.clear(descInput);
      await user.type(descInput, "Luz Atualizada");
      await user.click(screen.getByText("Salvar alterações"));

      expect(updatePayableSpy).toHaveBeenCalledWith("p2", expect.objectContaining({ description: "Luz Atualizada" }));
    });

    it("filters: only overdue items show when Vencidas selected", async () => {
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Vencidas"));
      expect(screen.getByText("Luz")).toBeInTheDocument();
      expect(screen.getByText("Internet")).toBeInTheDocument();
      expect(screen.queryByText("Aluguel")).not.toBeInTheDocument();
    });

    it("paid item shows Desfazer pagamento button in detail sheet", async () => {
      const undoSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        undoPayablePayment: undoSpy,
        payables: [{ id: "p-paid", description: "Conta Paga", amountCents: 50000, dueDate: "2026-06-01", status: "paid" }],
      }));
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Conta Paga"));
      expect(screen.getByText("Desfazer pagamento")).toBeInTheDocument();
      await user.click(screen.getByText("Desfazer pagamento"));
      // Confirm dialog opens
      expect(screen.getByText("Sim, desfazer pagamento")).toBeInTheDocument();
      await user.click(screen.getByText("Sim, desfazer pagamento"));
      expect(undoSpy).toHaveBeenCalledWith("p-paid");
    });
  });

  describe("empty state (item premium 3)", () => {
    it("shows the relaxed bear with Tudo em dia copy when nothing matches", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ payables: [] }));
      render(<PayablesPage />);
      expect(screen.getByText("Nenhuma conta pendente. Tudo em dia!")).toBeInTheDocument();
      expect(screen.getByLabelText("Ted relaxado")).toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows loading indicator when loading", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ loading: true }));
      render(<PayablesPage />);
      expect(screen.getByText(/carregando/i)).toBeInTheDocument();
      expect(screen.queryByText("Luz")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error banner when error is set", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ error: "Timeout ao carregar" }));
      render(<PayablesPage />);
      expect(screen.getByText(/Timeout ao carregar/i)).toBeInTheDocument();
      expect(screen.getByText("Luz")).toBeInTheDocument();
    });
  });

  describe("create payable", () => {
    it("opens new payable form when Nova is clicked", async () => {
      const user = userEvent.setup();
      render(<PayablesPage />);
      await user.click(screen.getByText("Nova"));
      expect(screen.getByText("Nova conta a pagar")).toBeInTheDocument();
      expect(screen.getByText("Salvar conta")).toBeInTheDocument();
    });

    it("creates a payable via the new form", async () => {
      const createSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ createPayable: createSpy }));
      const user = userEvent.setup();
      const { container } = render(<PayablesPage />);
      await user.click(screen.getByText("Nova"));
      await user.type(screen.getByPlaceholderText(/Aluguel, Netflix/i), "Conta Nova");
      await user.type(screen.getByPlaceholderText("0,00"), "123450");
      const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
      await user.type(dateInput, "2026-07-10");
      const [accountSelect, catSelect] = screen.getAllByRole("combobox");
      await user.selectOptions(accountSelect, "acc2");
      await user.selectOptions(catSelect, "cat1");
      await user.click(screen.getByText("Salvar conta"));
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        description: "Conta Nova",
        amountCents: 123450,
        dueDate: "2026-07-10",
        accountId: "acc2",
        categoryId: "cat1",
      }));
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

    it("pull from the top refreshes payables and accounts", async () => {
      installCoarsePointer();
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ refreshDomains: refreshSpy }),
      );
      render(<PayablesPage />);
      const point = (y: number) => [{ clientX: 100, clientY: y, identifier: 0 }];
      const start = new Event("touchstart", { bubbles: true, cancelable: true });
      (start as unknown as { touches: unknown }).touches = point(120);
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      // 170px crus com damping 0.45 = 76.5px exibidos (threshold 64px).
      (move as unknown as { touches: unknown }).touches = point(290);
      const end = new Event("touchend", { bubbles: true, cancelable: true });
      act(() => {
        window.dispatchEvent(start);
        window.dispatchEvent(move);
      });
      await act(async () => {
        window.dispatchEvent(end);
      });
      await waitFor(() =>
        expect(refreshSpy).toHaveBeenCalledWith(["payables", "accounts"]),
      );
    });
  });
});
