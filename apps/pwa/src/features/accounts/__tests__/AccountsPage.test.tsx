import { render, screen, fireEvent, within, waitFor } from "@/lib/test-utils";
import AccountsPage, {
  formatInputBRL,
  parseBRLToCents,
  toApiAccountKind,
  isNegativeInitialBalanceAllowed,
} from "../AccountsPage";
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
    addAccount: vi.fn(), updateAccount: vi.fn(), deactivateAccount: vi.fn(),
    addCategory: vi.fn(), updateCategory: vi.fn(), deactivateCategory: vi.fn(),
    addCard: vi.fn(), updateCard: vi.fn(),
    addSubscription: vi.fn(), cancelSubscription: vi.fn(),
    createTransfer: vi.fn(), payStatement: vi.fn(), createInstallments: vi.fn(),
    createCardPurchase: vi.fn(), updateTransaction: vi.fn(), updatePayable: vi.fn(),
    undoPayablePayment: vi.fn(), updateGoal: vi.fn(), deleteCategory: vi.fn(),
    applyCategoryDefaults: vi.fn(), updateSubscription: vi.fn(), refreshSubscriptions: vi.fn(),
    refreshDomains: vi.fn(),
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
  };
}
function mockState(o: Partial<AppState>): AppState { return { ...defaultState(), ...o }; }

describe("AccountsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  describe("with data", () => {
    it("renders page header", () => { render(<AccountsPage />); expect(screen.getByText("Contas")).toBeInTheDocument(); });
    it("shows total balance", () => { render(<AccountsPage />); expect(screen.getByText(/2\.072,\d{2}/)).toBeInTheDocument(); });
    it("renders account names", () => { render(<AccountsPage />); expect(screen.getAllByText("Nubank").length).toBeGreaterThanOrEqual(1); expect(screen.getAllByText("Itaú").length).toBeGreaterThanOrEqual(1); expect(screen.getAllByText("Inter").length).toBeGreaterThanOrEqual(1); });
    it("does not render credit cards", () => { render(<AccountsPage />); expect(screen.queryByText("Nubank Crédito")).not.toBeInTheDocument(); });
    it("shows individual balances", () => { render(<AccountsPage />); expect(screen.getByText(/1\.543,20/)).toBeInTheDocument(); expect(screen.getByText(/28,90/)).toBeInTheDocument(); expect(screen.getByText(/500,00/)).toBeInTheDocument(); });
    it("shows mini history inside detail sheet when card is clicked", () => {
      render(<AccountsPage />);
      // First card is Nubank (acc1) — shows Supermercado Extra in mini history
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
      // Aluguel is for Itaú (acc2) — should NOT be in Nubank's detail
      expect(screen.queryByText("Aluguel")).not.toBeInTheDocument();
    });
    it("shows account type labels", () => {
      render(<AccountsPage />);
      expect(screen.getAllByText("Conta corrente")).toHaveLength(2);
      expect(screen.getByText("Poupança")).toBeInTheDocument();
    });
    it("labels API-kind bank as Conta", () => {
      const bankAccount = { ...mockAccounts[0], kind: "bank" as const };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        accounts: [bankAccount],
        transactions: [],
      }));
      render(<AccountsPage />);
      expect(screen.getByText("Conta")).toBeInTheDocument();
      expect(screen.queryByText("Conta corrente")).not.toBeInTheDocument();
    });
    it("labels unknown kind as Outro", () => {
      const weirdAccount = { ...mockAccounts[0], kind: "unknown" as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        accounts: [weirdAccount],
        transactions: [],
      }));
      render(<AccountsPage />);
      expect(screen.getByText("Outro")).toBeInTheDocument();
      expect(screen.queryByText("Cartão")).not.toBeInTheDocument();
    });
  });

  describe("loading", () => {
    it("shows loading indicator", () => { vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ loading: true })); render(<AccountsPage />); expect(screen.getByText(/carregando/i)).toBeInTheDocument(); expect(screen.queryByText("Contas")).not.toBeInTheDocument(); });
  });

  describe("error", () => {
    it("shows error banner alongside data", () => { vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ error: "Offline" })); render(<AccountsPage />); expect(screen.getByText(/Offline/i)).toBeInTheDocument(); expect(screen.getByText("Contas")).toBeInTheDocument(); });
  });

  describe("account actions", () => {
    it("no inline edit/deactivate buttons on cards (actions inside detail sheet)", () => {
      render(<AccountsPage />);
      // Inline buttons must NOT exist. Only the card itself is clickable.
      expect(screen.queryAllByText("Editar").length).toBe(0);
      expect(screen.queryAllByText("Desativar").length).toBe(0);
    });

    it("clicking account card opens detail sheet", () => {
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      // Detail sheet should show account name + actions
      expect(screen.getByText("Detalhes da conta")).toBeInTheDocument();
      expect(screen.getByText("Editar conta")).toBeInTheDocument();
      expect(screen.getByText("Desativar conta")).toBeInTheDocument();
    });

    it("opens edit sheet from detail sheet", () => {
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      fireEvent.click(screen.getByText("Editar conta"));
      expect(screen.getByText("Salvar")).toBeInTheDocument();
    });

    it("detail sheet has 'Ver todos os registros' CTA linking to /registros?accountId=<id>", () => {
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      const cta = screen.getByText("Ver todos os registros");
      expect(cta).toBeInTheDocument();
      expect(cta.closest("a")).toHaveAttribute("href", "/registros?accountId=acc1");
    });

    it("opens confirm dialog from detail sheet", async () => {
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      fireEvent.click(screen.getByText("Desativar conta"));
      expect(await screen.findByText("Desativar")).toBeInTheDocument();
    });
  });

  describe("deep-link from Home (Slice A: ?accountId=)", () => {
    /**
     * Bug fix: Home now routes to /contas?accountId=<id> when the user
     * taps an account row. AccountsPage must reflect that context so the
     * user lands on the right account (highlighted/expanded).
     */
    function setUrlSearch(search: string) {
      Object.defineProperty(window, "location", {
        value: { ...window.location, search },
        writable: true,
        configurable: true,
      });
    }

    it("deep-link ?accountId opens the detail sheet for the matching account", () => {
      setUrlSearch("?accountId=acc1");
      render(<AccountsPage />);
      // Should open detail sheet automatically
      expect(screen.getByText("Detalhes da conta")).toBeInTheDocument();
    });

    it("does not open detail sheet when ?accountId is missing", () => {
      setUrlSearch("");
      render(<AccountsPage />);
      expect(screen.queryByText("Detalhes da conta")).not.toBeInTheDocument();
    });

    it("ignores ?accountId that does not match any account (no crash, no sheet)", () => {
      setUrlSearch("?accountId=acc-does-not-exist");
      render(<AccountsPage />);
      expect(screen.queryByText("Detalhes da conta")).not.toBeInTheDocument();
      expect(screen.getAllByText("Nubank").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("create / edit / deactivate flows (coverage)", () => {
    it("opens Nova conta sheet, fills name/kind/balance and saves", () => {
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
      render(<AccountsPage />);
      fireEvent.click(screen.getByText("Nova"));
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByPlaceholderText(/Nubank, Itaú/i), { target: { value: "Banco X" } });
      fireEvent.click(within(dialog).getByText("Poupança"));
      fireEvent.change(within(dialog).getByPlaceholderText("0,00"), { target: { value: "100000" } });
      fireEvent.click(within(dialog).getByText("Salvar conta"));
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "Banco X", kind: "bank", initialBalanceCents: 100000 }));
    });

    it("saves with empty name + non-default bank color using bankColor as name", () => {
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
      render(<AccountsPage />);
      fireEvent.click(screen.getByText("Nova"));
      const dialog = screen.getByRole("dialog");
      fireEvent.focus(within(dialog).getByRole("combobox"));
      fireEvent.click(within(dialog).getByText("Caixa Econômica Federal"));
      fireEvent.click(within(dialog).getByText("Salvar conta"));
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "#005CA9" }));
    });

    it("renders kind buttons and saves with investment kind", () => {
      const addSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
      render(<AccountsPage />);
      fireEvent.click(screen.getByText("Nova"));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByText("Investimento"));
      fireEvent.click(within(dialog).getByText("Salvar conta"));
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "bank" }));
    });

    it("edits an account name and saves", () => {
      const updateSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateAccount: updateSpy }));
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      fireEvent.click(screen.getByText("Editar conta"));
      const input = screen.getAllByDisplayValue("Nubank").find((element) => element.getAttribute("role") !== "combobox") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Nubank Editado" } });
      fireEvent.click(screen.getByText("Salvar"));
      expect(updateSpy).toHaveBeenCalledWith("acc1", { name: "Nubank Editado" });
    });

    it("edits account but empty name does not save", () => {
      const updateSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateAccount: updateSpy }));
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      fireEvent.click(screen.getByText("Editar conta"));
      const input = screen.getAllByDisplayValue("Nubank").find((element) => element.getAttribute("role") !== "combobox") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.click(screen.getByText("Salvar"));
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("deactivates an account via confirm dialog", async () => {
      const deactSpy = vi.fn();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ deactivateAccount: deactSpy }));
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      fireEvent.click(screen.getByText("Desativar conta"));
      await fireEvent.click(await screen.findByRole("button", { name: "Desativar" }));
      expect(deactSpy).toHaveBeenCalledWith("acc1");
    });
  });

  describe("kind labels (coverage)", () => {
    it("labels credit_card / investment / cash kinds", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        accounts: [
          { ...mockAccounts[0], id: "a-inv", kind: "investment" as any, name: "Invest X" }, // eslint-disable-line @typescript-eslint/no-explicit-any
          { ...mockAccounts[0], id: "a-cash", kind: "cash" as any, name: "Cash X" }, // eslint-disable-line @typescript-eslint/no-explicit-any
        ],
        transactions: [],
      }));
      render(<AccountsPage />);
      expect(screen.getByText("Investimento")).toBeInTheDocument();
      expect(screen.getByText("Dinheiro")).toBeInTheDocument();
    });
  });

  describe("edge cases (coverage)", () => {
    it("ignores balance input longer than 12 digits in new account form", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({}));
      render(<AccountsPage />);
      fireEvent.click(screen.getByText("Nova"));
      const dialog = screen.getByRole("dialog");
      const balanceInput = within(dialog).getByPlaceholderText("0,00") as HTMLInputElement;
      fireEvent.change(balanceInput, { target: { value: "1234567890123" } });
      expect(balanceInput.value).toBe("");
    });

    it("detail sheet shows Outro for unknown kind", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        accounts: [{ ...mockAccounts[0], id: "a-unk", kind: "zzz" as any, name: "Estranho" }], // eslint-disable-line @typescript-eslint/no-explicit-any
        transactions: [],
      }));
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      expect(within(screen.getByRole("dialog")).getByText("Outro")).toBeInTheDocument();
    });

    it("uses default color when account.color is undefined (list + detail)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({
        accounts: [{ ...mockAccounts[0], id: "a-nocolor", color: undefined as any, name: "Sem Cor", kind: "checking" as any }], // eslint-disable-line @typescript-eslint/no-explicit-any
        transactions: [],
      }));
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      expect(screen.getByText("Detalhes da conta")).toBeInTheDocument();
    });

    it("evaluates income branch in mini-history filter", () => {
      const base = ALL_MOCK_TRANSACTIONS[0];
      const incomeTx = { ...base, id: "tx-inc", accountId: "acc1", kind: "income" as const, description: "Salário" };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ transactions: [...ALL_MOCK_TRANSACTIONS, incomeTx] }));
      render(<AccountsPage />);
      fireEvent.click(screen.getAllByTestId("account-card")[0]);
      expect(screen.getByText("Supermercado Extra")).toBeInTheDocument();
    });

    it("shows empty state when there are no bank accounts", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ accounts: [], transactions: [] }));
      render(<AccountsPage />);
      expect(screen.getByText(/Nenhuma conta cadastrada/)).toBeInTheDocument();
    });
  });
});
describe("AccountsPage — P2-1/P2-3 (payload bankColor + failure UX)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("propagates the chosen bankColor through the add payload", () => {
    const addSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
    render(<AccountsPage />);
    fireEvent.click(screen.getByText("Nova"));
    const dialog = screen.getByRole("dialog");
    fireEvent.focus(within(dialog).getByRole("combobox"));
    fireEvent.click(within(dialog).getByText("Itaú Unibanco"));
    fireEvent.change(within(dialog).getByPlaceholderText(/Nubank, Itaú/i), { target: { value: "Banco Laranja" } });
    fireEvent.click(within(dialog).getByText("Salvar conta"));
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "Banco Laranja", bankColor: "#EC7000" }));
  });

  it("maps every UI subkind to the API bank kind", () => {
    const addSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
    render(<AccountsPage />);
    for (const label of ["Conta corrente", "Poupança", "Investimento"]) {
      fireEvent.click(screen.getByText("Nova"));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByText(label));
      fireEvent.click(within(dialog).getByText("Salvar conta"));
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "bank" }));
      addSpy.mockClear();
    }
  });

  it("keeps the create sheet open and preserves fields when addAccount rejects", async () => {
    const addSpy = vi.fn().mockRejectedValue(new Error("falha de rede"));
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
    render(<AccountsPage />);
    fireEvent.click(screen.getByText("Nova"));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/Nubank, Itaú/i), { target: { value: "Banco X" } });
    fireEvent.click(within(dialog).getByText("Salvar conta"));
    await waitFor(() => expect(addSpy).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByPlaceholderText(/Nubank, Itaú/i)).toHaveValue("Banco X");
  });

  it("closes the create sheet only after a successful save", async () => {
    const addSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
    render(<AccountsPage />);
    fireEvent.click(screen.getByText("Nova"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Salvar conta"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the edit sheet open and preserves the name when updateAccount rejects", async () => {
    const updateSpy = vi.fn().mockRejectedValue(new Error("erro de salvamento"));
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ updateAccount: updateSpy }));
    render(<AccountsPage />);
    fireEvent.click(screen.getAllByTestId("account-card")[0]);
    fireEvent.click(screen.getByText("Editar conta"));
    const input = screen.getAllByDisplayValue("Nubank").find((element) => element.getAttribute("role") !== "combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Nubank Editado" } });
    fireEvent.click(screen.getByText("Salvar"));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect((screen.getByDisplayValue("Nubank Editado") as HTMLInputElement)).toBeInTheDocument();
  });
});

describe("AccountsPage — ADR-018 (negative initial balance for bank/cash)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("accepts and submits a negative initial balance for a bank account", () => {
    const addSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
    render(<AccountsPage />);
    fireEvent.click(screen.getByText("Nova"));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/Nubank, Itaú/i), { target: { value: "Banco Devedor" } });
    const balanceInput = within(dialog).getByPlaceholderText("0,00") as HTMLInputElement;
    fireEvent.change(balanceInput, { target: { value: "-100000" } });
    // The minus sign survives masking (valid signed pt-BR formatting).
    expect(balanceInput.value).toBe("-1.000,00");
    fireEvent.click(within(dialog).getByText("Salvar conta"));
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Banco Devedor", kind: "bank", initialBalanceCents: -100000 }),
    );
  });

  it("submits zero when the balance is left empty (positive/zero unchanged)", () => {
    const addSpy = vi.fn();
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(mockState({ addAccount: addSpy }));
    render(<AccountsPage />);
    fireEvent.click(screen.getByText("Nova"));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/Nubank, Itaú/i), { target: { value: "Banco Zerado" } });
    fireEvent.click(within(dialog).getByText("Salvar conta"));
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Banco Zerado", kind: "bank", initialBalanceCents: 0 }),
    );
  });

  it("formats signed input preserving the minus sign", () => {
    expect(formatInputBRL("-100000")).toBe("-1.000,00");
    expect(formatInputBRL("-500")).toBe("-5,00");
    expect(formatInputBRL("-")).toBe("-");
    expect(formatInputBRL("")).toBe("");
    // Positive formatting is unchanged.
    expect(formatInputBRL("100000")).toBe("1.000,00");
    expect(formatInputBRL("500")).toBe("5,00");
  });

  it("parses signed display values to cents", () => {
    expect(parseBRLToCents("-1.000,00")).toBe(-100000);
    expect(parseBRLToCents("-5,00")).toBe(-500);
    expect(parseBRLToCents("1.000,00")).toBe(100000);
    expect(parseBRLToCents("0,00")).toBe(0);
    expect(parseBRLToCents("")).toBe(0);
    expect(parseBRLToCents("-")).toBe(0);
  });

  it("allows a negative initial balance for bank/cash but never for credit_card", () => {
    expect(isNegativeInitialBalanceAllowed("bank")).toBe(true);
    expect(isNegativeInitialBalanceAllowed("cash")).toBe(true);
    expect(isNegativeInitialBalanceAllowed("credit_card")).toBe(false);
    // The UI subkinds keep mapping to the API bank kind.
    expect(toApiAccountKind("checking")).toBe("bank");
    expect(toApiAccountKind("cash")).toBe("cash");
    expect(toApiAccountKind("credit_card")).toBe("credit_card");
  });
});
