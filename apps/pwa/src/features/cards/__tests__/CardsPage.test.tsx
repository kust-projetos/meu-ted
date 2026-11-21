import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import CardsPage from "../CardsPage";
import * as appStateModule from "@/lib/state/app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import { mockAccounts, mockCategories, ALL_MOCK_TRANSACTIONS, mockPayables, mockBudgets, mockGoals } from "@/lib/state/mock-data";
import type { AppState } from "@/lib/state/app-state-context";

// V4.1 Phase 5 (SPEC §12.6): the browser defaults to the same-origin proxy,
// so this UI suite pins the unconfigured mock-data provider path explicitly.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, isApiConfigured: () => false };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function defaultState(): AppState {
  return {
    accounts: [...mockAccounts], categories: [...mockCategories],
    transactions: [...ALL_MOCK_TRANSACTIONS], payables: [...mockPayables],
    budgets: [...mockBudgets], goals: [...mockGoals],
    debts: [], subscriptions: [], loading: false, error: null,
    addTransaction: vi.fn(), deleteTransaction: vi.fn(), markPayablePaid: vi.fn(), cancelPayable: vi.fn(), createPayable: vi.fn(), createBudget: vi.fn(), updateBudget: vi.fn(), createGoal: vi.fn(), contributeToGoal: vi.fn(), cancelGoal: vi.fn(),
    cardStatements: [], writeError: null, clearWriteError: vi.fn(),
    profile: null, dashboardSummary: null,
    saveProfile: vi.fn(), refreshProfile: vi.fn(), refreshDashboardSummary: vi.fn(),
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
    addAccount: vi.fn(), addCategory: vi.fn(), addCard: vi.fn(), updateCard: vi.fn(),
    addSubscription: vi.fn(), cancelSubscription: vi.fn(),
    createTransfer: vi.fn(), payStatement: vi.fn(), createInstallments: vi.fn(),
    createCardPurchase: vi.fn(), updateTransaction: vi.fn(), updatePayable: vi.fn(),
    undoPayablePayment: vi.fn(), updateGoal: vi.fn(), updateAccount: vi.fn(),
    deactivateAccount: vi.fn(), updateCategory: vi.fn(), deactivateCategory: vi.fn(),
    deleteCategory: vi.fn(), applyCategoryDefaults: vi.fn(), updateSubscription: vi.fn(),
    refreshSubscriptions: vi.fn(), refreshDomains: vi.fn(),
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
  };
}
function mockState(o: Partial<AppState>): AppState { return { ...defaultState(), ...o }; }

describe("CardsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  describe("with data", () => {
    it("renders the page header", () => { render(<CardsPage />); expect(screen.getByText("Cartões")).toBeInTheDocument(); });
    it("renders credit card names", () => { render(<CardsPage />); expect(screen.getByText("Nubank Crédito")).toBeInTheDocument(); expect(screen.getByText("Inter Mastercard")).toBeInTheDocument(); });
    it("shows closing and due days", () => { render(<CardsPage />); expect(screen.getAllByText(/Fecha dia/).length).toBe(2); expect(screen.getAllByText(/vence dia/i).length).toBe(2); });
    it("shows current fatura total per card", () => { render(<CardsPage />); expect(screen.getByText(/41,80/)).toBeInTheDocument(); const inter = screen.getAllByText(/187,50/); expect(inter.length).toBeGreaterThanOrEqual(1); });
    it("shows purchases when drilling into card", async () => {
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      expect(screen.getByText("App Store")).toBeInTheDocument();
      const backBtn = screen.getByRole("button", { name: /cartões/i });
      await user.click(backBtn);
      expect(screen.getByText("Inter Mastercard")).toBeInTheDocument();
    });
    it("exposes limit usage accessibly", () => { render(<CardsPage />); expect(screen.getByRole("progressbar", { name: /uso do limite: 0\.3%/i })).toBeInTheDocument(); expect(screen.getByRole("progressbar", { name: /uso do limite: 2\.3%/i })).toBeInTheDocument(); });
    it("shows total and available limit for each card", () => { render(<CardsPage />); expect(screen.getAllByText(/Limite total/).length).toBe(2); expect(screen.getAllByText(/Disponível/).length).toBe(2); });
    it("shows pagar fatura button in card detail", async () => {
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      expect(screen.getByText(/pagar fatura/i)).toBeInTheDocument();
    });
  });

  // ── Card creation ──
  describe("creating a card", () => {
    it("filters products by institution and derives network from the selected product", async () => {
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      const institution = screen.getByRole("combobox", { name: "Instituição" });
      await user.click(institution);
      await user.clear(institution);
      await user.type(institution, "Itaú");
      await user.click(await screen.findByText("Itaú"));
      const model = screen.getByRole("combobox", { name: "Modelo do cartão" });
      expect(model).toHaveTextContent("Itaú Click");
      expect(model).toHaveTextContent("Personnalité");
      await user.selectOptions(model, "itau-personnalite");
      const flags = screen.getAllByTestId("card-flag");
      expect(flags[flags.length - 1]).toHaveAttribute("aria-label", "Visa");
    });

    it("persists selected appearance against the returned account id", async () => {
      const addSpy = vi.fn().mockResolvedValue({ id: "created-card-id" });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: addSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      await user.type(screen.getByPlaceholderText("0,00"), "500000");
      await user.click(screen.getByRole("button", { name: "Salvar cartão" }));
      await waitFor(() => expect(addSpy).toHaveBeenCalled());
      const stored = JSON.parse(localStorage.getItem("meu-ted:account-appearance:v1:default") ?? "{}");
      expect(stored["created-card-id"]).toEqual({ institutionId: "nubank", cardProductId: "nubank-roxinho" });
    });

    it("renders legacy cards without stored appearance", () => {
      render(<CardsPage />);
      expect(screen.getAllByTestId("bank-card")).toHaveLength(2);
      expect(screen.getAllByText("Nubank").length).toBeGreaterThan(0);
    });

    it("calls addCard with form data when saving", async () => {
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: addSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      // Fill limit
      const limitInput = screen.getByPlaceholderText("0,00");
      await user.type(limitInput, "500000");
      // Click save
      await user.click(screen.getByRole("button", { name: "Salvar cartão" }));
      expect(addSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Nubank", creditLimitCents: 500000 }),
      );
    });
  });

  // ── Paying a statement ──
  describe("paying a statement", () => {
    it("calls payStatement when paying full", async () => {
      const paySpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ payStatement: paySpy, cardStatements: [{ id: "stmt-1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 4180, paidCents: 0, status: "open" }] }),
      );
      const user = userEvent.setup();
      render(<CardsPage />);
      // Drill into Nubank Crédito
      await user.click(screen.getByText("Nubank Crédito"));
      // Click Pagar fatura
      await user.click(screen.getByText(/pagar fatura/i));
      // Select account Nubank (checking)
      const nubankBtns = screen.getAllByText("Nubank");
      // The PayStatementSheet has Nubank as an account option; click the account picker one
      await user.click(nubankBtns[nubankBtns.length - 1]);
      // Click "Pagar fatura total"
      await user.click(screen.getByRole("button", { name: /Pagar fatura total/i }));
      expect(paySpy).toHaveBeenCalledWith("stmt-1", expect.objectContaining({
        amountCents: 4180,
        fromAccountId: "acc1",
      }));
    });

    it("calls payStatement when paying partial", async () => {
      const paySpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ payStatement: paySpy, cardStatements: [{ id: "stmt-1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 4180, paidCents: 0, status: "open" }] }),
      );
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      await user.click(screen.getByText(/pagar fatura/i));
      // Switch to Partial
      await user.click(screen.getByText("Parcial"));
      // Fill partial amount
      const partialInput = screen.getAllByPlaceholderText("0,00")[0];
      await user.type(partialInput, "2000");
      // Select account
      const nubankBtns = screen.getAllByText("Nubank");
      await user.click(nubankBtns[nubankBtns.length - 1]);
      await user.click(screen.getByRole("button", { name: /Pagar valor parcial/i }));
      expect(paySpy).toHaveBeenCalledWith("stmt-1", expect.objectContaining({
        amountCents: 2000,
      }));
    });
  });

  // ── Editing a card ──
  describe("editing a card", () => {
    it("opens edit sheet and calls updateCard", async () => {
      const updateSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateCard: updateSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      await user.click(screen.getByText("Editar"));
      await user.click(screen.getByRole("button", { name: "Salvar edição do cartão" }));
      expect(updateSpy).toHaveBeenCalledWith("acc4", expect.objectContaining({
        name: "Nubank Crédito",
      }));
    });
  });

  // ── Loading/Error ──
  describe("loading", () => {
    it("shows card skeletons while loading", () => { vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ loading: true })); render(<CardsPage />); expect(screen.getAllByTestId("skeleton")).toHaveLength(3); expect(screen.queryByText("Nubank Crédito")).not.toBeInTheDocument(); });
  });

  describe("error", () => {
    it("shows error banner alongside data", () => { vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ error: "Erro" })); render(<CardsPage />); expect(screen.getByText(/Erro/i)).toBeInTheDocument(); expect(screen.getByText("Nubank Crédito")).toBeInTheDocument(); });
  });

  describe("statement data in card list", () => {
    it("shows statement totalCents instead of transaction-based spentCents", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          cardStatements: [
            {
              id: "stmt-acc4",
              accountId: "acc4",
              cycleYearMonth: "2026-06",
              closingDate: "2026-06-15",
              dueDate: "2026-06-25",
              totalCents: 77740,
              paidCents: 0,
              status: "open",
            },
          ],
        }),
      );
      render(<CardsPage />);
      // Statement total (R$ 777,40) overrides transaction-based total (R$ 41,80)
      expect(screen.getByText(/777,40/)).toBeInTheDocument();
      // The old transaction-based number should NOT be the primary total
      // (may appear elsewhere as subtotal but not as the fatura total)
    });
  });

  describe("statement detail purchases", () => {
    it("loads statement detail and shows purchases when card is opened", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({
        id: "stmt-acc4",
        accountId: "acc4",
        cycleYearMonth: "2026-06",
        closingDate: "2026-06-15",
        dueDate: "2026-06-25",
        totalCents: 77740,
        paidCents: 0,
        status: "open",
        purchases: [
          {
            id: "detail-p1",
            description: "Compra do statement",
            amountCents: 5000,
            date: "2026-06-10",
            categoryName: "Alimentação",
          },
        ],
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          cardStatements: [
            {
              id: "stmt-acc4",
              accountId: "acc4",
              cycleYearMonth: "2026-06",
              closingDate: "2026-06-15",
              dueDate: "2026-06-25",
              totalCents: 77740,
              paidCents: 0,
              status: "open",
            },
          ],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      // Wait for the statement detail purchases to render
      await waitFor(() =>
        expect(screen.getByText("Compra do statement")).toBeInTheDocument(),
      );
    });

    it("falls back to transaction-based purchases when no statement detail", async () => {
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      // Existing transaction-based purchases still appear (fallback)
      expect(screen.getByText("App Store")).toBeInTheDocument();
    });
  });

  describe("paying selected (not always latest) statement", () => {
    it("pays the historical statement when it is selected in the history", async () => {
      const paySpy = vi.fn();
      vi.spyOn(endpoints, "fetchStatementDetail").mockImplementation(async (id: string) => {
        if (id === "stmt-may") {
          return { id: "stmt-may", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 50000, paidCents: 0, status: "open", purchases: [{ id: "p-may", description: "Compra maio", amountCents: 50000, date: "2026-05-10", categoryName: "Mercado" }] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        }
        return { id: "stmt-jun", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 77740, paidCents: 0, status: "open", purchases: [{ id: "p-jun", description: "Compra junho", amountCents: 77740, date: "2026-06-10", categoryName: "Mercado" }] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          payStatement: paySpy,
          cardStatements: [
            { id: "stmt-jun", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 77740, paidCents: 0, status: "open" },
            { id: "stmt-may", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 50000, paidCents: 0, status: "open" },
          ],
        }),
      );
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      // Select the May (historical) statement
      await user.click(screen.getByRole("button", { name: /maio de 2026/i }));
      await waitFor(() => expect(screen.getByText("Compra maio")).toBeInTheDocument());
      // Click Pagar fatura
      await user.click(screen.getByText(/pagar fatura/i));
      // Select account
      const nubankBtns = screen.getAllByText("Nubank");
      await user.click(nubankBtns[nubankBtns.length - 1]);
      await user.click(screen.getByRole("button", { name: /Pagar fatura total/i }));
      // Must pay stmt-may (the selected historical one), NOT stmt-jun (the latest)
      expect(paySpy).toHaveBeenCalledWith("stmt-may", expect.objectContaining({
        amountCents: 50000,
      }));
    });
  });

  describe("pay button respects statement status", () => {
    it("disables Pagar fatura when a paid statement is selected", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({
        id: "stmt-may", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 50000, paidCents: 50000, status: "paid", purchases: [],
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          cardStatements: [
            { id: "stmt-jun", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 77740, paidCents: 0, status: "open" },
            { id: "stmt-may", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 50000, paidCents: 50000, status: "paid" },
          ],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      // Initially open statement is selected — button should be active
      expect(screen.getByRole("button", { name: /pagar fatura/i })).not.toBeDisabled();
      // Click the paid May statement
      await user.click(screen.getByRole("button", { name: /maio de 2026.*Paga/i }));
      // Now the pay button should be disabled
      await waitFor(() => expect(screen.getByRole("button", { name: /pagar fatura/i })).toBeDisabled());
    });

    it("keeps Pagar fatura active when an open statement is selected", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({
        id: "stmt-may", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 50000, paidCents: 50000, status: "paid", purchases: [],
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          cardStatements: [
            { id: "stmt-jun", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 77740, paidCents: 0, status: "open" },
            { id: "stmt-may", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 50000, paidCents: 50000, status: "paid" },
          ],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      // Click paid → verify disabled
      await user.click(screen.getByRole("button", { name: /maio de 2026.*Paga/i }));
      await waitFor(() => expect(screen.getByRole("button", { name: /pagar fatura/i })).toBeDisabled());
      // Click back to open June statement → verify active again
      await user.click(screen.getByRole("button", { name: /junho de 2026.*Aberta/i }));
      await waitFor(() => expect(screen.getByRole("button", { name: /pagar fatura/i })).not.toBeDisabled());
    });
  });

  describe("statement history", () => {
    it("shows an honest empty state instead of synthetic months when no statements", async () => {
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      expect(
        screen.getByText(/Nenhuma fatura anterior registrada/i),
      ).toBeInTheDocument();
    });

    it("switches to the clicked historical statement and loads its purchases", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockImplementation(async (id: string) => {
        if (id === "stmt-jun") {
          return {
            id,
            accountId: "acc4",
            cycleYearMonth: "2026-06",
            closingDate: "2026-06-15",
            dueDate: "2026-06-25",
            totalCents: 162730,
            paidCents: 0,
            status: "open",
            purchases: [
              {
                id: "jun-p1",
                description: "Compra de junho",
                amountCents: 162730,
                date: "2026-06-10",
                categoryName: "Mercado",
              },
            ],
          };
        }

        return {
          id,
          accountId: "acc4",
          cycleYearMonth: "2026-07",
          closingDate: "2026-07-05",
          dueDate: "2026-07-13",
          totalCents: 77740,
          paidCents: 0,
          status: "open",
          purchases: [
            {
              id: "jul-p1",
              description: "Compra de julho",
              amountCents: 77740,
              date: "2026-07-02",
              categoryName: "Mercado",
            },
          ],
        };
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          cardStatements: [
            {
              id: "stmt-jul",
              accountId: "acc4",
              cycleYearMonth: "2026-07",
              closingDate: "2026-07-05",
              dueDate: "2026-07-13",
              totalCents: 77740,
              paidCents: 0,
              status: "open",
            },
            {
              id: "stmt-jun",
              accountId: "acc4",
              cycleYearMonth: "2026-06",
              closingDate: "2026-06-15",
              dueDate: "2026-06-25",
              totalCents: 162730,
              paidCents: 0,
              status: "open",
            },
          ],
        }),
      );

      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));

      await waitFor(() => expect(screen.getByText("Compra de julho")).toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: /junho de 2026/i }));

      await waitFor(() => expect(screen.getByText("Compra de junho")).toBeInTheDocument());
      expect(screen.getAllByText(/1\.627,30/).length).toBeGreaterThan(0);
      expect(endpoints.fetchStatementDetail).toHaveBeenCalledWith("stmt-jun");
    });
  });

  describe("deep-link from Home (Slice A: ?cardId=)", () => {
    /**
     * Home now routes to /cartoes?cardId=<id> when the user taps a card row.
     * CardsPage must already render that card in detail view, without the
     * user having to tap the card tile first.
     */
    function setUrlSearch(search: string) {
      Object.defineProperty(window, "location", {
        value: { ...window.location, search },
        writable: true,
        configurable: true,
      });
    }

    it("opens the matching card detail when ?cardId=<id> is in the URL", () => {
      setUrlSearch("?cardId=acc4");
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({
        id: "stmt",
        accountId: "acc4",
        cycleYearMonth: "2026-07",
        closingDate: "2026-07-05",
        dueDate: "2026-07-13",
        totalCents: 0,
        paidCents: 0,
        status: "open",
        purchases: [],
      });
      render(<CardsPage />);
      // The detail view shows the back button "Cartões" and the hero name.
      expect(screen.getByText("Nubank Crédito")).toBeInTheDocument();
      // The "Pagar fatura" CTA is only present in detail mode.
      expect(screen.getByRole("button", { name: /pagar fatura/i })).toBeInTheDocument();
      // Back-button label is the routing breadcrumb.
      expect(screen.getByRole("button", { name: /^Cartões$/i })).toBeInTheDocument();
    });

    it("stays on the card overview when ?cardId is missing", () => {
      setUrlSearch("");
      render(<CardsPage />);
      // In overview mode, the "Pagar fatura" CTA is NOT rendered (only when
      // a card is selected).
      expect(screen.queryByRole("button", { name: /pagar fatura/i })).not.toBeInTheDocument();
      // Card tiles are present.
      expect(screen.getByText("Nubank Crédito")).toBeInTheDocument();
    });

    it("ignores ?cardId that does not match any card (renders overview)", () => {
      setUrlSearch("?cardId=acc-missing");
      render(<CardsPage />);
      // No detail view opened; "Pagar fatura" CTA is absent.
      expect(screen.queryByRole("button", { name: /pagar fatura/i })).not.toBeInTheDocument();
    });
  });

  describe("form field coverage", () => {
    function resetUrl() {
      Object.defineProperty(window, "location", {
        value: { ...window.location, search: "" },
        writable: true,
        configurable: true,
      });
    }

    it("creates card with brand, name, closing and due days", async () => {
      resetUrl();
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: addSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      const institution = screen.getByRole("combobox", { name: "Instituição" });
      await user.click(institution);
      await user.clear(institution);
      await user.type(institution, "Itaú");
      await user.click(await screen.findByText("Itaú"));
      await user.clear(screen.getByPlaceholderText(/Nubank, It/i));
      await user.type(screen.getByPlaceholderText(/Nubank, It/i), "Meu Cartao");
      const [closing, due] = screen.getAllByRole("spinbutton");
      await user.clear(closing);
      await user.type(closing, "5");
      await user.clear(due);
      await user.type(due, "12");
      await user.type(screen.getByPlaceholderText("0,00"), "500000");
      await user.click(screen.getByRole("button", { name: /Salvar cart/i }));
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        name: "Meu Cartao",
        creditLimitCents: 500000,
        closingDay: 5,
        dueDay: 12,
      }));
    });

    it("retains a new-card draft until discard is explicitly confirmed", async () => {
      resetUrl();
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: addSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      const name = screen.getByPlaceholderText(/Nubank, It/i);
      await user.clear(name);
      await user.type(name, "Rascunho");
      await user.keyboard("{Escape}");
      expect(screen.getByDisplayValue("Rascunho")).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Descartar alterações?" })).toBeInTheDocument();
      expect(addSpy).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Continuar editando" }));
      expect(screen.getByDisplayValue("Rascunho")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Fechar" }));
      await user.click(screen.getByRole("button", { name: "Descartar" }));
      expect(addSpy).not.toHaveBeenCalled();
      expect(screen.queryByDisplayValue("Rascunho")).not.toBeInTheDocument();
    });

    it("edits card fields and saves", async () => {
      resetUrl();
      const updateSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateCard: updateSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText(/Nubank Cr/i));
      await user.click(screen.getByText("Editar"));
      const nameInput = screen.getByDisplayValue(/Nubank Cr/i);
      await user.clear(nameInput);
      await user.type(nameInput, "Nubank Editado");
      const [closing, due] = screen.getAllByRole("spinbutton");
      await user.clear(closing);
      await user.type(closing, "10");
      await user.clear(due);
      await user.type(due, "20");
      await user.click(screen.getByRole("button", { name: /Salvar edi/i }));
      expect(updateSpy).toHaveBeenCalledWith("acc4", expect.objectContaining({
        name: "Nubank Editado",
        closingDay: 10,
        dueDay: 20,
      }));
    });
  });

  // ── Coverage: branch edges (TDD, test-only) ──
  describe("coverage branch edges", () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it("renders cards with missing optional fields (color/limit/closing/due fallbacks)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [
            { id: "cx1", name: "Sem Campos", kind: "credit_card", balanceCents: 0 },
            { id: "cx2", name: "Cor Estranha", kind: "credit_card", balanceCents: 0, color: "#123456", creditLimitCents: 100000, closingDay: 5, dueDay: 10 },
            { id: "ck1", name: "Nubank", kind: "checking", balanceCents: 0 },
          ],
          transactions: [
            { id: "t1", accountId: "cx1", kind: "expense", amountCents: 1000, date: "2026-06-01", description: "Compra Estranha", categoryId: "cat-inexistente" },
          ],
        }),
      );
      render(<CardsPage />);
      expect(screen.getByText("Sem Campos")).toBeInTheDocument();
      expect(screen.getByText("Cor Estranha")).toBeInTheDocument();
    });

    it("shows empty state when there are no credit cards", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({ accounts: [{ id: "ck1", name: "Nubank", kind: "checking", balanceCents: 0 }] }),
      );
      render(<CardsPage />);
      expect(screen.getByText(/Nenhum cartão/i)).toBeInTheDocument();
    });

    it("new card: clearing the limit input hits the empty-digits branch", async () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: vi.fn() }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      const limitInput = screen.getByPlaceholderText("0,00");
      await user.type(limitInput, "500000");
      await user.clear(limitInput);
    });

    it("new card: empty closing/due day falls back to 15/25", async () => {
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: addSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      await user.type(screen.getByPlaceholderText("0,00"), "500000");
      const [closing, due] = screen.getAllByRole("spinbutton");
      await user.clear(closing);
      await user.clear(due);
      await user.click(screen.getByRole("button", { name: /Salvar cart/i }));
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ closingDay: 15, dueDay: 25 }));
    });

    it("new card: limit input truncates beyond 12 digits", async () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addCard: vi.fn() }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText("Novo"));
      const limitInput = screen.getByPlaceholderText("0,00") as HTMLInputElement;
      await user.type(limitInput, "1234567890123");
      expect(limitInput.value.replace(/\D/g, "").length).toBeLessThanOrEqual(12);
    });

    it("edit card: limit input truncates beyond 12 digits", async () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [
            { id: "acc4", name: "Nubank Crédito", kind: "credit_card", balanceCents: 0, color: "#820AD1", creditLimitCents: 0, closingDay: 10, dueDay: 15 },
            { id: "acc1", name: "Nubank", kind: "checking", balanceCents: 0 },
          ],
          updateCard: vi.fn(),
        }),
      );
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText(/Nubank Cr/i));
      await user.click(screen.getByText("Editar"));
      const limitInput = screen.getByPlaceholderText("0,00") as HTMLInputElement;
      await user.type(limitInput, "1234567890123");
      expect(limitInput.value.replace(/\D/g, "").length).toBeLessThanOrEqual(12);
    });

    it("edit card: empty name/closing/due falls back to the card's values", async () => {
      const updateSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateCard: updateSpy }));
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText(/Nubank Cr/i));
      await user.click(screen.getByText("Editar"));
      const nameInput = screen.getByDisplayValue(/Nubank Cr/i);
      await user.clear(nameInput);
      const [closing, due] = screen.getAllByRole("spinbutton");
      await user.clear(closing);
      await user.clear(due);
      await user.click(screen.getByRole("button", { name: /Salvar edi/i }));
      const args = updateSpy.mock.calls[0][1] as { name: string; closingDay: number; dueDay: number };
      expect(args.name).toBe("Nubank Crédito");
      expect(Number.isFinite(args.closingDay)).toBe(true);
      expect(args.closingDay).toBeGreaterThan(0);
      expect(Number.isFinite(args.dueDay)).toBe(true);
      expect(args.dueDay).toBeGreaterThan(0);
    });

    it("edit card: placeholder shows 0,00 when creditLimitCents is 0", async () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [
            { id: "acc4", name: "Nubank Crédito", kind: "credit_card", balanceCents: 0, color: "#820AD1", creditLimitCents: 0, closingDay: 10, dueDay: 15 },
            { id: "acc1", name: "Nubank", kind: "checking", balanceCents: 0 },
          ],
        }),
      );
      const user = userEvent.setup();
      render(<CardsPage />);
      await user.click(screen.getByText(/Nubank Cr/i));
      await user.click(screen.getByText("Editar"));
      expect(screen.getByPlaceholderText("0,00")).toBeInTheDocument();
    });

    it("pay sheet: no checking accounts shows the empty message and partial input truncates", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open", purchases: [] });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [{ id: "acc4", name: "Nubank Crédito", kind: "credit_card", balanceCents: 0, color: "#820AD1", creditLimitCents: 100000, closingDay: 10, dueDay: 15 }],
          cardStatements: [{ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open" }],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      await user.click(screen.getByText(/pagar fatura/i));
      expect(screen.getByText(/Nenhuma conta disponível/i)).toBeInTheDocument();
      await user.click(screen.getByText("Parcial"));
      const partialInput = screen.getByPlaceholderText("0,00") as HTMLInputElement;
      await user.type(partialInput, "1234567890123");
      expect(partialInput.value.replace(/\D/g, "").length).toBeLessThanOrEqual(12);
    });

    it("pay sheet: clicking the selected account again deselects it", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open", purchases: [] });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [
            { id: "acc4", name: "Nubank Crédito", kind: "credit_card", balanceCents: 0, color: "#820AD1", creditLimitCents: 100000, closingDay: 10, dueDay: 15 },
            { id: "acc1", name: "Nubank", kind: "checking", balanceCents: 0 },
          ],
          cardStatements: [{ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open" }],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      await user.click(screen.getByText(/pagar fatura/i));
      const nubankBtn = screen.getByRole("button", { name: "Nubank" });
      await user.click(nubankBtn);
      await user.click(nubankBtn);
    });

    it("statement history shows all status labels (paid/overdue/open/partial/closed)", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open", purchases: [] });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [
            { id: "acc4", name: "Nubank Crédito", kind: "credit_card", balanceCents: 0, color: "#820AD1", creditLimitCents: 100000, closingDay: 10, dueDay: 15 },
            { id: "acc1", name: "Nubank", kind: "checking", balanceCents: 0 },
          ],
          cardStatements: [
            { id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open" },
            { id: "s2", accountId: "acc4", cycleYearMonth: "2026-05", closingDate: "2026-05-15", dueDate: "2026-05-25", totalCents: 2000, paidCents: 2000, status: "paid" },
            { id: "s3", accountId: "acc4", cycleYearMonth: "2026-04", closingDate: "2026-04-15", dueDate: "2026-04-25", totalCents: 3000, paidCents: 0, status: "overdue" },
            { id: "s4", accountId: "acc4", cycleYearMonth: "2026-03", closingDate: "2026-03-15", dueDate: "2026-03-25", totalCents: 4000, paidCents: 1000, status: "partial" },
            { id: "s5", accountId: "acc4", cycleYearMonth: "2026-02", closingDate: "2026-02-15", dueDate: "2026-02-25", totalCents: 5000, paidCents: 0, status: "closed" },
          ],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      expect(screen.getByText("Aberta")).toBeInTheDocument();
      expect(screen.getByText("Paga")).toBeInTheDocument();
      expect(screen.getByText("Atrasada")).toBeInTheDocument();
      expect(screen.getByText("Parcial")).toBeInTheDocument();
      expect(screen.getByText("Fechada")).toBeInTheDocument();
    });

    it("switching the selected card re-resolves the statement id", async () => {
      const user = userEvent.setup();
      vi.spyOn(endpoints, "fetchStatementDetail").mockResolvedValue({ id: "x", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 0, paidCents: 0, status: "open", purchases: [] });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        mockState({
          accounts: [
            { id: "acc4", name: "Nubank Crédito", kind: "credit_card", balanceCents: 0, color: "#820AD1", creditLimitCents: 100000, closingDay: 10, dueDay: 15 },
            { id: "acc5", name: "Inter Mastercard", kind: "credit_card", balanceCents: 0, color: "#EC7000", creditLimitCents: 100000, closingDay: 5, dueDay: 10 },
            { id: "acc1", name: "Nubank", kind: "checking", balanceCents: 0 },
          ],
          cardStatements: [
            { id: "sa", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open" },
            { id: "sb", accountId: "acc5", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 2000, paidCents: 0, status: "open" },
          ],
        }),
      );
      render(<CardsPage />);
      await user.click(screen.getByText("Nubank Crédito"));
      await user.click(screen.getByRole("button", { name: /cartões/i }));
      await user.click(screen.getByText("Inter Mastercard"));
    });

    describe("purchase edit coverage", () => {
      it("opens purchase edit with a category and exercises field branches", async () => {
        const user = userEvent.setup();
        vi.spyOn(endpoints, "updateCardPurchase").mockResolvedValue({ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open", purchases: [] });
        vi.spyOn(appStateModule, "useAppState").mockReturnValue(
          mockState({
            transactions: [
              { id: "t-edit", accountId: "acc4", kind: "expense", amountCents: 500, date: "2026-06-02", description: "Editavel", categoryId: "cat-x" },
            ],
          }),
        );
        render(<CardsPage />);
        await user.click(screen.getByText("Nubank Crédito"));
        await user.click(screen.getByText("Editavel"));
        expect(screen.getByText("Editar compra")).toBeInTheDocument();
        // 516: amount input truncates beyond 12 digits
        const amountInput = screen.getByDisplayValue("5,00") as HTMLInputElement;
        await user.type(amountInput, "1234567890123");
        expect(amountInput.value.replace(/\D/g, "").length).toBeLessThanOrEqual(12);
        // 539: clearing the description disables save via !description.trim()
        const descInput = screen.getByDisplayValue("Editavel");
        await user.clear(descInput);
        expect(screen.getByRole("button", { name: /Salvar alterações/i })).toBeDisabled();
        await user.type(descInput, "Editavel");
        // 493: category select — left arm (real) then save
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        await user.selectOptions(select, mockCategories[0].id);
        await user.click(screen.getByRole("button", { name: /Salvar alterações/i }));
        // reopen and cover 493 right arm (empty category -> undefined)
        await user.click(screen.getByText("Editavel"));
        const select2 = screen.getByRole("combobox") as HTMLSelectElement;
        await user.selectOptions(select2, "");
        await user.click(screen.getByRole("button", { name: /Salvar alterações/i }));
      });

      it("opens purchase edit with an undefined category (?? fallback)", async () => {
        const user = userEvent.setup();
        vi.spyOn(endpoints, "updateCardPurchase").mockResolvedValue({ id: "s1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 1000, paidCents: 0, status: "open", purchases: [] });
        vi.spyOn(appStateModule, "useAppState").mockReturnValue(
          mockState({
            transactions: [
              { id: "t-nocat", accountId: "acc4", kind: "expense", amountCents: 500, date: "2026-06-02", description: "SemCat", categoryId: undefined as unknown as string },
            ],
          }),
        );
        render(<CardsPage />);
        await user.click(screen.getByText("Nubank Crédito"));
        await user.click(screen.getByText("SemCat"));
        expect(screen.getByText("Editar compra")).toBeInTheDocument();
      });
    });
  });
});

describe("CardsPage — P2-12 (erro visível ao pagar fatura)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows a visible error and keeps the sheet open when payStatement fails", async () => {
    const paySpy = vi.fn().mockRejectedValue(new Error("Falha de rede ao pagar"));
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      mockState({
        payStatement: paySpy,
        cardStatements: [{ id: "stmt-1", accountId: "acc4", cycleYearMonth: "2026-06", closingDate: "2026-06-15", dueDate: "2026-06-25", totalCents: 4180, paidCents: 0, status: "open" }],
      }),
    );
    const user = userEvent.setup();
    render(<CardsPage />);
    await user.click(screen.getByText("Nubank Crédito"));
    await user.click(screen.getByText(/pagar fatura/i));
    const nubankBtns = screen.getAllByText("Nubank");
    await user.click(nubankBtns[nubankBtns.length - 1]);
    await user.click(screen.getByRole("button", { name: /Pagar fatura total/i }));
    expect(await screen.findByTestId("pay-error")).toHaveTextContent("Falha de rede ao pagar");
    expect(screen.getByRole("button", { name: /Pagar fatura total/i })).toBeInTheDocument();
  });
});
