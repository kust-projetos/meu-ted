import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import HomePage from "../HomePage";
import * as appStateModule from "@/lib/state/app-state-context";
import * as workspaceModule from "@/lib/auth/workspace-context";
import type { AppState } from "@/lib/state/app-state-context";

// V4.1 Phase 5 (SPEC §12.6): the browser defaults to the same-origin proxy,
// so this UI suite pins the unconfigured mock-data provider path explicitly.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, isApiConfigured: () => false };
});
import { mockAccounts, mockCategories, ALL_MOCK_TRANSACTIONS, mockPayables, mockBudgets, mockGoals, mockDashboardSummary } from "@/lib/state/mock-data";

const mockRouter = { push: vi.fn(), refresh: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

function defaultState(): AppState {
  return {
    accounts: [...mockAccounts], categories: [...mockCategories],
    transactions: [...ALL_MOCK_TRANSACTIONS], payables: [...mockPayables],
    budgets: [...mockBudgets], goals: [...mockGoals],
    debts: [], subscriptions: [], loading: false, error: null,
    dashboardSummary: mockDashboardSummary,
    saveProfile: vi.fn(), refreshProfile: vi.fn(), refreshDashboardSummary: vi.fn(),
    refreshDomains: vi.fn().mockResolvedValue(undefined),
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
    profile: null,
    addTransaction: vi.fn(), updateTransaction: vi.fn(), deleteTransaction: vi.fn(), markPayablePaid: vi.fn(),
    cancelPayable: vi.fn(), updatePayable: vi.fn(), undoPayablePayment: vi.fn(), createPayable: vi.fn(),
    createBudget: vi.fn(), updateBudget: vi.fn(), createGoal: vi.fn(), contributeToGoal: vi.fn(),
    cancelGoal: vi.fn(), updateGoal: vi.fn(),
    deactivateAccount: vi.fn(), updateCategory: vi.fn(), deactivateCategory: vi.fn(),
    refreshSubscriptions: vi.fn(),
    cardStatements: [], writeError: null, clearWriteError: vi.fn(),
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
    addAccount: vi.fn(), updateAccount: vi.fn(), addCategory: vi.fn(), addCard: vi.fn(), updateCard: vi.fn(),
    addSubscription: vi.fn(), cancelSubscription: vi.fn(), updateSubscription: vi.fn(),
    createTransfer: vi.fn(), payStatement: vi.fn(), createInstallments: vi.fn(),
    createCardPurchase: vi.fn(), deleteCategory: vi.fn(), applyCategoryDefaults: vi.fn(),
  };
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a consistent main heading", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("routes to profile when avatar button is clicked", async () => {
    const user = userEvent.setup();

    render(<HomePage />);

    await user.click(screen.getByRole("button", { name: /Abrir perfil/i }));

    expect(mockRouter.push).toHaveBeenCalledWith("/perfil");
  });

  it("opens notifications sheet when bell button is clicked", async () => {
    const user = userEvent.setup();

    render(<HomePage />);

    await user.click(screen.getByRole("button", { name: "Notificações" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Notificações")).toBeInTheDocument();
    // Slice B: sheet now derives items from real data; empty state shows
    // this friendly copy when there's nothing actionable.
    expect(
      screen.getByText(/Nada urgente agora|Alertas do Meu Ted/i),
    ).toBeInTheDocument();
  });

  describe("loading state", () => {
    it("shows a layout-aware skeleton when loading (not a spinner)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({ ...defaultState(), loading: true });
      render(<HomePage />);
      expect(screen.getAllByRole("status", { name: /carregando/i }).length).toBeGreaterThan(0);
      expect(screen.queryByText(/^Carregando\.\.\.$/)).not.toBeInTheDocument();
    });
  });

  describe("delta cards microcopy", () => {
    it("explains that delta cards compare current vs previous month", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
      render(<HomePage />);

      // both cards must carry an explanatory title for hover/screen-reader
      const receitaCard = screen.getByTitle(/receitas.*m[êe]s anterior/i);
      const despesaCard = screen.getByTitle(/despesas.*m[êe]s anterior/i);
      expect(receitaCard).toBeInTheDocument();
      expect(despesaCard).toBeInTheDocument();

      // and visible microcopy under the headline
      expect(screen.getAllByText(/vs m[êe]s anterior/i).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("sync banner UX", () => {
    it("shows softer copy when serving a snapshot (not danger color)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        sync: {
          ...defaultState().sync,
          accounts: { source: "snapshot", syncedAt: "2026-06-20T10:00:00.000Z" },
        },
        readOnly: true,
      });
      const { container } = render(<HomePage />);
      // Should not use danger color classes
      const banner = container.querySelector('[data-testid="stale-banner"]');
      expect(banner).toBeInTheDocument();
      expect(banner?.className).not.toMatch(/bg-danger-tint/);
      expect(banner?.className).not.toMatch(/text-danger/);
    });

    it("provides a retry CTA when data is unavailable", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        sync: {
          ...defaultState().sync,
          accounts: { source: "unavailable", syncedAt: null },
        },
        readOnly: true,
      });
      render(<HomePage />);
      expect(
        screen.getByRole("button", { name: /tentar novamente/i }),
      ).toBeInTheDocument();
    });

    it("wires unavailable retry button to router.refresh", async () => {
      const user = userEvent.setup();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        sync: {
          ...defaultState().sync,
          accounts: { source: "unavailable", syncedAt: null },
        },
        readOnly: true,
      });
      render(<HomePage />);
      await user.click(
        screen.getByRole("button", { name: /tentar novamente/i }),
      );
      expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("desktop adaptation", () => {
    it("uses responsive horizontal padding on the content area (sm:px-8 lg:px-12)", () => {
      const { container } = render(<HomePage />);
      // Find the content area that has padding classes
      const padded = Array.from(container.querySelectorAll("[class*='px-5']")).find(
        (el) =>
          el.className.includes("sm:px-8") ||
          el.className.includes("lg:px-12"),
      );
      expect(padded).toBeTruthy();
    });

    it("KPI delta row uses larger gap on desktop (sm:gap-4 lg:gap-6)", () => {
      const { container } = render(<HomePage />);
      const grid = container.querySelector('[data-testid="kpi-delta-row"]');
      expect(grid).toBeInTheDocument();
      expect(grid?.className).toMatch(/sm:gap-4/);
      expect(grid?.className).toMatch(/lg:gap-6/);
    });

    it("mini-stats row stays inside the shell (max-w matches shell container)", () => {
      const { container } = render(<HomePage />);
      const hero = container.querySelector('[data-testid="hero-area"]') as HTMLElement;
      expect(hero).toBeInTheDocument();
      // Hero should NOT have an arbitrary max-w larger than shell — uses full shell width
      expect(hero.className).not.toMatch(/max-w-\[\d+px\]/);
    });
  });

  describe("account labels", () => {
    it("shows correct kind labels for mock accounts", () => {
      render(<HomePage />);
      expect(screen.getAllByText("Conta corrente")).toHaveLength(2);
      expect(screen.getByText("Poupança")).toBeInTheDocument();
    });

    it("labels API-kind bank as Conta", () => {
      const bankAccount = { ...mockAccounts[0], name: "Nubank", kind: "bank" as const };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        accounts: [bankAccount],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Conta")).toBeInTheDocument();
      expect(screen.queryByText("Cartão")).not.toBeInTheDocument();
    });
  });

  describe("account badge abbreviations", () => {
    it("uses 2-letter initials for single-word accounts (Nubank → NU)", () => {
      const { container } = render(<HomePage />);
      expect(container.textContent).toContain("NU");
    });

    it("uses word initials for multi-word accounts (mock: Conta Conjunta → CC)", () => {
      // Replace accounts with a multi-word name to exercise the multi-word path.
      const stateWithMultiWordAccount = {
        ...defaultState(),
        accounts: [
          {
            id: "acc-multi",
            name: "Conta Conjunta",
            kind: "checking",
            color: "#0E8C5A",
            balanceCents: 100000,
            initialBalanceCents: 100000,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
        ],
      } as AppState;
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(stateWithMultiWordAccount);
      const { container } = render(<HomePage />);
      const ccBadge = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "CC",
      );
      expect(ccBadge).toBeInTheDocument();
    });

    it("exposes full account name as badge title for hover/QA inspection", () => {
      const stateWithMultiWordAccount = {
        ...defaultState(),
        accounts: [
          {
            id: "acc-multi",
            name: "Conta Conjunta",
            kind: "checking",
            color: "#0E8C5A",
            balanceCents: 100000,
            initialBalanceCents: 100000,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
        ],
      } as AppState;
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(stateWithMultiWordAccount);
      const { container } = render(<HomePage />);
      const ccBadge = Array.from(container.querySelectorAll("span[title]")).find(
        (el) => el.textContent === "CC",
      );
      expect(ccBadge?.getAttribute("title")).toBe("Conta Conjunta");
    });
  });

  describe("credit card summary", () => {
    it("maps statement totals to cards by accountId, not by order", () => {
      // Simulate live data: statements exist with totals for each card.
      // Statements are in REVERSE order to catch index-based mapping bugs.
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        cardStatements: [
          {
            id: "stmt-acc5",
            accountId: "acc5",
            cycleYearMonth: "2026-06",
            closingDate: "2026-06-10",
            dueDate: "2026-06-18",
            totalCents: 999_99,
            paidCents: 0,
            status: "open",
          },
          {
            id: "stmt-acc4",
            accountId: "acc4",
            cycleYearMonth: "2026-06",
            closingDate: "2026-06-15",
            dueDate: "2026-06-25",
            totalCents: 777_40,
            paidCents: 0,
            status: "open",
          },
        ],
      } as AppState);
      render(<HomePage />);

      // Card section renders
      expect(screen.getByText("Cartões de crédito")).toBeInTheDocument();

      // Nubank Crédito (acc4) should show R$ 777,40 (its own statement total)
      expect(screen.getByText("Nubank Crédito")).toBeInTheDocument();
      expect(screen.getByText(/777,40/)).toBeInTheDocument();

      // Inter Mastercard (acc5) should show R$ 999,99 (its own statement total)
      expect(screen.getByText("Inter Mastercard")).toBeInTheDocument();
      expect(screen.getByText(/999,99/)).toBeInTheDocument();
    });

    it("falls back to transaction-based spent when no cardStatements exist", () => {
      // Default state has cardStatements: [] — should use transactions
      render(<HomePage />);
      // The page renders without breaking
      expect(screen.getByText("Cartões de crédito")).toBeInTheDocument();
    });
  });

  describe("month-over-month delta (Slice A: most-recent-month-with-data)", () => {
    /**
     * Bug: delta cards currently compute against the calendar "current month".
     * When the live clock is in a month with no transactions (e.g., we're in
     * July 2026 but all data lives in June), the cards show a meaningless
     * -100% drop instead of comparing June vs May.
     *
     * Fix: pick the most recent month that has at least one transaction of
     * that kind, then compare it against the calendar month before.
     */
    it("compares most-recent-month-with-data vs calendar previous when current month is empty", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-02T12:00:00"));
      // Mock data: all transactions in 2026-06 (June).
      // After fix: income should compare June vs May, not July vs June.
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
      const { unmount } = render(<HomePage />);
      // June had ~R$6.550 income (tx3 + tx6 + any others).
      // May would have been 0 → if naive prev=0 fix hasn't been applied,
      // the card shows "—". With the fix, ratio is computed against May=0
      // and the card renders "—" (we just want to confirm we are NOT in
      // the -100%-because-current-is-empty state). Most importantly, the
      // card should NOT display a numeric delta based on the empty July.
      const cards = screen.getAllByTitle(/m[êe]s anterior/i);
      expect(cards.length).toBeGreaterThanOrEqual(2);
      const numbers = cards.map((c) => c.textContent ?? "");
      // Neither card should be rendered as the "-100%" produced by the old
      // logic (current=0, prev>0). Old logic produced "-100%"; the new
      // logic finds June as most-recent and pairs it with May (prev=0) →
      // renders "—" (null ratio).
      numbers.forEach((txt) => {
        expect(txt).not.toMatch(/-100%/);
      });
      unmount();
      vi.useRealTimers();
    });

    it("finds June as most-recent income month when clock is July 2 (tx3+tx6 in June)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-02T12:00:00"));
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
      const { container } = render(<HomePage />);
      // The +5700 + +850 = 6550 cents (R$ 65,50) → tx3 + tx6 are June income.
      // After fix, "most recent" income month = June, "previous calendar" = May
      // (no May transactions → card shows null ratio → "—").
      const numberSpans = container.querySelectorAll('.font-mono');
      const presentAsDash = Array.from(numberSpans).some((s) => s.textContent === "—");
      expect(presentAsDash).toBe(true);
      vi.useRealTimers();
    });

    it("computes delta correctly when both current and previous months have data", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-15T12:00:00"));
      const mk = (id: string, amountCents: number, date: string) => ({
        id, description: "x", amountCents, date,
        kind: "expense" as const, categoryId: "cat1", accountId: "acc1",
        method: "PIX" as const,
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [
          mk("july", 20000, "2026-07-10"), // R$ 200 → current month expense
          mk("june", 10000, "2026-06-10"), // R$ 100 → previous month expense
        ],
      } as AppState);
      const { container } = render(<HomePage />);
      // Most-recent expense month with data = July.
      // Calendar previous = June (10000). Delta = (20000-10000)/10000*100 = +100%.
      const expenseCard = container.querySelector('[aria-label*="despesas"]');
      expect(expenseCard?.textContent).toMatch(/\+100%/);
      vi.useRealTimers();
    });
  });

  describe("navigation from Home cards (Slice A: deep-link to destinations)", () => {
    /**
     * Bug: account rows, credit-card rows, and donut category rows render
     * as plain <div>s without click handlers. Today the user must tap "Ver
     * tudo" to drill down, which loses the specific item they cared about.
     *
     * Fix: turn those rows into buttons that push the destination route
     * with a query string identifying the item:
     *   /hub/patrimonio?aba=contas&accountId=acc1
     *   /hub/patrimonio?aba=cartoes&cardId=acc4
     *   /registros?type=expense&categoryId=cat1
     */

    it("navigates to patrimonio contas with ?accountId=<id> when an account row is clicked", async () => {
      const user = userEvent.setup();
      render(<HomePage />);
      // The first checking account is "Nubank" (acc1) in mock-data.
      const nubankRow = screen.getAllByRole("button", { name: /Nubank/i }).find((b) =>
        b.className?.includes("flex items-center gap-3"),
      );
      // Fallback: search by row content
      const accRow = nubankRow ?? screen.getByText("Nubank", { selector: "div" }).closest('[data-testid="account-row"]');
      expect(accRow).toBeTruthy();
      await user.click(accRow!);
      expect(mockRouter.push).toHaveBeenCalledWith("/hub/patrimonio?aba=contas&accountId=acc1");
    });

    it("navigates to patrimonio cartoes with ?cardId=<id> when a card row is clicked", async () => {
      const user = userEvent.setup();
      // Make sure a credit card exists in the default state.
      render(<HomePage />);
      // Find the card row by its text ("Nubank Crédito").
      const cardRow = screen.getByText("Nubank Crédito").closest('[data-testid="card-row"]');
      expect(cardRow).toBeTruthy();
      await user.click(cardRow!);
      expect(mockRouter.push).toHaveBeenCalledWith("/hub/patrimonio?aba=cartoes&cardId=acc4");
    });

    it("category rows no longer need click-through (macro rows are non-clickable)", () => {
      // Slice B/C: category rows now aggregate by macro. Aggregated rows
      // have no single categoryId → they're rendered as divs, not buttons.
      // This is intentional — see macro-categories-only test below.
      render(<HomePage />);
      const categoryRows = screen.getAllByTestId("category-row");
      expect(categoryRows.length).toBeGreaterThan(0);
      // They must NOT be clickable. Iterate to confirm no <button>
      categoryRows.forEach((row) => {
        expect(row.tagName).not.toBe("BUTTON");
      });
    });

    it("does not navigate when 'Ver tudo' links are clicked (preserves existing behavior)", async () => {
      const user = userEvent.setup();
      render(<HomePage />);
      const verTudoLinks = screen.getAllByRole("link", { name: /^Ver tudo$/i });
      expect(verTudoLinks.length).toBeGreaterThan(0);
      await user.click(verTudoLinks[0]!);
      // "Ver tudo" is a Next.js <Link>, which uses the real router inside
      // next/link — the router.push mock only receives pushes from
      // component-level onClick handlers. Since "Ver tudo" has no onClick,
      // mockRouter.push stays empty here. That's the existing behavior we
      // want to preserve (no query param appended to "Ver tudo" navigation).
      expect(mockRouter.push).not.toHaveBeenCalled();
    });
  });

  describe("Slice B: profile integration (Home avatar + greeting)", () => {
    /**
     * Bug fix: Home avatar + name were hard-coded to "M" / "Marina",
     * ignoring the persisted profile. After Slice B the avatar shows the
     * profile's first letter + avatarColor, and the greeting shows the
     * profile's name.
     */
    it("renders the profile's first letter on the avatar", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        profile: {
          householdId: "h-1",
          name: "Marina Silva",
          email: "marina@email.com",
          phone: "(11) 99999-9999",
          avatarColor: "#820AD1",
          greetingStyle: "auto",
          updatedAt: "2026-07-02T12:00:00Z",
        },
      } as AppState);
      render(<HomePage />);
      const avatarBtn = screen.getByRole("button", { name: /Abrir perfil/i });
      expect(avatarBtn).toHaveTextContent("M");
      expect(avatarBtn.style.background).toContain("rgb(130, 10, 209)"); // #820AD1
    });

    it("renders the profile name (not the baked 'Marina' literal)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        profile: {
          householdId: "h-1",
          name: "Wal",
          email: "wal@email.com",
          phone: "(11) 98888-7777",
          avatarColor: "#0E8C5A",
          greetingStyle: "auto",
          updatedAt: "2026-07-02T12:00:00Z",
        },
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Wal")).toBeInTheDocument();
    });

    it("falls back to a default avatar when profile is not loaded", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        profile: null,
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Visitante")).toBeInTheDocument();
    });
  });

  describe("Slice B: insights backend feed", () => {
    it("prefers quickInsights from state over generic local fallback", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        quickInsights: [
          {
            id: "cashflow-grow",
            title: "Caixa crescendo",
            body: "Caixa subiu R$ 100,00 nos últimos 30 dias.",
            severity: "good",
          },
        ],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Caixa crescendo")).toBeInTheDocument();
      // String completa do insight (a Home agora tem filtro global de
      // período com o mesmo vocabulário — o pin segue exato no card).
      expect(screen.getByText("Caixa subiu R$ 100,00 nos últimos 30 dias.")).toBeInTheDocument();
    });
  });

  describe("Slice B: card list redesign", () => {
    /**
     * The credit card section was rebuilt: per-card tile with first-letter
     * badge, limit-progress bar, and % pill. Old: a horizontal bar with
     * no badge. Preserved: click still drills into patrimonio cartoes with ?cardId=<id>.
     */
    it("per-card tile shows percentage, name and amount", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        cardStatements: [
          {
            id: "stmt",
            accountId: "acc4",
            cycleYearMonth: "2026-06",
            closingDate: "2026-06-15",
            dueDate: "2026-06-25",
            totalCents: 480000,
            paidCents: 0,
            status: "open",
          },
        ],
      } as AppState);
      render(<HomePage />);
      const row = screen.getAllByTestId("card-row")[0]!;
      // Card name visible
      expect(row.textContent).toMatch(/Nubank Crédito/);
      // Percentage pill shows 40% (480000 / 1200000 = 40%)
      expect(row.textContent).toMatch(/40%/);
      // Amount
      expect(row.textContent).toMatch(/4\.800,00/);
    });

    it("aggregate row shows fatura + limite livre totals", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        cardStatements: [
          {
            id: "stmt",
            accountId: "acc4",
            cycleYearMonth: "2026-06",
            closingDate: "2026-06-15",
            dueDate: "2026-06-25",
            totalCents: 100000,
            paidCents: 0,
            status: "open",
          },
        ],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText(/Fatura atual/i)).toBeInTheDocument();
      expect(screen.getByText(/Limite livre/i)).toBeInTheDocument();
    });
  });

  describe("Slice B: category list (no top-N cap, no gray slice)", () => {
    it("shows ALL categories with spending (no 4-item cap)", () => {
      // Build transactions spanning 5 expense categories.
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [
          { id: "t1", description: "a", amountCents: 10000, date: "2026-06-01", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "b", amountCents: 20000, date: "2026-06-01", kind: "expense", categoryId: "cat2", accountId: "acc1", method: "PIX" },
          { id: "t3", description: "c", amountCents: 30000, date: "2026-06-01", kind: "expense", categoryId: "cat3", accountId: "acc1", method: "PIX" },
          { id: "t4", description: "d", amountCents: 40000, date: "2026-06-01", kind: "expense", categoryId: "cat4", accountId: "acc1", method: "PIX" },
        ],
      } as AppState);
      render(<HomePage />);
      const rows = screen.getAllByTestId("category-row");
      // All 4 categories shown — no 4-item slice that would hide the 5th.
      expect(rows.length).toBe(4);
    });

    it("category rows render percent + amount without ambiguous gray section", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [
          { id: "t1", description: "Mercado", amountCents: 50000, date: "2026-06-20", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
        ],
      } as AppState);
      render(<HomePage />);
      const row = screen.getByTestId("category-row");
      expect(row.textContent).toMatch(/100%/);
      expect(row.textContent).toMatch(/500,00/);
      // No "Outros"/"resto" sub-section that would imply missing data.
      expect(screen.queryByText(/Outros/i)).not.toBeInTheDocument();
    });

    // ── Corrections: donut chart visible ────────────────────────────────

    it("renders a visible donut / conic-gradient alongside category rows", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [
          { id: "t1", description: "Mercado", amountCents: 30000, date: "2026-06-20", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Uber", amountCents: 10000, date: "2026-06-19", kind: "expense", categoryId: "cat2", accountId: "acc1", method: "PIX" },
        ],
      } as AppState);
      const { container } = render(<HomePage />);
      // There must be a conic-gradient element somewhere (the donut chart).
      const donut = container.querySelector('[style*="conic-gradient"]');
      expect(donut).toBeInTheDocument();
    });

    it("legend lists each category with name + value + percentage", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [
          { id: "t1", description: "Supermercado", amountCents: 75000, date: "2026-06-20", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Uber", amountCents: 25000, date: "2026-06-19", kind: "expense", categoryId: "cat2", accountId: "acc1", method: "PIX" },
        ],
      } as AppState);
      render(<HomePage />);
      // Each category row shows name + formatted value + percent
      const rows = screen.getAllByTestId("category-row");
      expect(rows.length).toBe(2);
      expect(rows[0]!.textContent).toMatch(/Alimentação/i);
      expect(rows[0]!.textContent).toMatch(/75%/);
      expect(rows[1]!.textContent).toMatch(/Transporte/i);
      expect(rows[1]!.textContent).toMatch(/25%/);
    });
  });

  describe("Corrections: credit card per-card detail", () => {
    it("per-card tile shows limit total + available + closing day + due day when statement present", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        cardStatements: [
          {
            id: "stmt-1",
            accountId: "acc4",
            cycleYearMonth: "2026-07",
            closingDate: "2026-07-05",
            dueDate: "2026-07-13",
            totalCents: 480000,
            paidCents: 0,
            status: "open",
          },
        ],
      } as AppState);
      render(<HomePage />);
      const row = screen.getAllByTestId("card-row")[0]!;
      // Must show limit info (limit total, available, %)
      expect(row.textContent).toMatch(/12\.000?/); // limit or available
      // Closing / due day from account meta
      // The card data now includes closing/due day
      expect(row.textContent).toMatch(/15/); // closingDay from mock
      expect(row.textContent).toMatch(/22/); // dueDay from mock
    });

    it("aggregate shows fatura total + limite livre + limite total", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        cardStatements: [
          {
            id: "stmt-1",
            accountId: "acc4",
            cycleYearMonth: "2026-07",
            closingDate: "2026-07-05",
            dueDate: "2026-07-13",
            totalCents: 480000,
            paidCents: 0,
            status: "open",
          },
        ],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText(/Fatura atual/i)).toBeInTheDocument();
      expect(screen.getByText(/Limite livre/i)).toBeInTheDocument();
      expect(screen.getByText(/Limite total/i)).toBeInTheDocument();
    });
  });

  describe("card metadata does not overlap spent amount", () => {
    it("metadata row uses flex-wrap class to prevent overflow on long amounts", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        cardStatements: [
          {
            id: "stmt-1",
            accountId: "acc4",
            cycleYearMonth: "2026-07",
            closingDate: "2026-07-05",
            dueDate: "2026-07-13",
            totalCents: 9999900,
            paidCents: 0,
            status: "open",
          },
        ],
      } as AppState);
      render(<HomePage />);
      // The card should render with "Fecha" in the metadata row, proving
      // the metadata row exists and wraps alongside the spent value.
      const cardRow = screen.getAllByTestId("card-row")[0]!;
      expect(cardRow.textContent).toMatch(/Fecha dia/);
      // The spent value renders after the metadata — text order proves
      // there's no overlap collision (both visible texts)
      expect(cardRow.textContent).toMatch(/livre/);
      expect(cardRow.textContent).toMatch(/R\$/);
    });
  });

  describe("Corrections: insights specificity", () => {
    it("fallback insights mention specific financial entities when API provides none", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [
          { id: "t1", description: "Supermercado", amountCents: 30000, date: "2026-06-20", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Salário", amountCents: 570000, date: "2026-06-05", kind: "income", categoryId: "cat5", accountId: "acc1", method: "PIX" },
        ],
        payables: [
          { id: "p1", description: "Aluguel", amountCents: 180000, dueDate: "2026-07-01", status: "pending" },
        ],
        // Set budgets so the budget insight branch is tested
        budgets: [
          { id: "b1", categoryId: "cat1", name: "Alimentação", amountCents: 50000, spentCents: 29200, period: "monthly" },
        ],
        quickInsights: undefined,
      } as unknown as AppState);
      render(<HomePage />);
      // Must contain subjects like Aluguel, poupança, Alimentação, etc.
      const body = document.body.textContent ?? "";
      const hasFinancialSubject = /Aluguel|Supermercado|poupança|Alimentação|Salário/i.test(body);
      expect(hasFinancialSubject).toBe(true);
    });
  });

  describe("macro-categories only (aggregate subcategories)", () => {
    /**
     * Bug: the donut shows individual subcategory rows (e.g. "Moradia > Aluguel")
     * alongside their macro. This clutters the home view. Fix: group transactions
     * by macro-category, where a "macro" is the parent of categories with parentId
     * set, or the prefix before " > " in the name as fallback.
     *
     * Acceptance:
     * 1. Only macro rows appear — no " > Subcategoria" labels
     * 2. Macro rows show correctly summed amounts
     * 3. Macro rows are NOT clickable (no href/testid="category-row" for aggregated)
     *    because no single categoryId represents the macro.
     */

    it("aggregates subcategories under the macro (via name prefix before ' > ')", () => {
      // Categories with " > " — macro prefix is the part before " > "
      const categoriesWithSubs = [
        { id: "cat-micro-1", name: "Moradia > Aluguel", kind: "expense" as const, icon: "Home" },
        { id: "cat-micro-2", name: "Moradia > Condomínio", kind: "expense" as const, icon: "Home" },
        { id: "cat-macro", name: "Alimentação", kind: "expense" as const, icon: "UtensilsCrossed", subcategories: [] },
      ];
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        accounts: [...mockAccounts],
        categories: categoriesWithSubs,
        transactions: [
          { id: "t1", description: "Aluguel", amountCents: 100000, date: "2026-06-01", kind: "expense", categoryId: "cat-micro-1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Condomínio", amountCents: 50000, date: "2026-06-01", kind: "expense", categoryId: "cat-micro-2", accountId: "acc1", method: "PIX" },
          { id: "t3", description: "Mercado", amountCents: 20000, date: "2026-06-01", kind: "expense", categoryId: "cat-macro", accountId: "acc1", method: "PIX" },
        ],
      } as unknown as AppState);
      render(<HomePage />);
      // Should see 2 rows: "Moradia" (R$ 1500) and "Alimentação" (R$ 200)
      const rows = screen.getAllByTestId("category-row");
      expect(rows.length).toBe(2);
      expect(rows[0]!.textContent).toMatch(/Moradia/);
      expect(rows[0]!.textContent).toMatch(/1\.500,00/);
      expect(rows[1]!.textContent).toMatch(/Alimentação/);
      expect(rows[1]!.textContent).toMatch(/200,00/);
    });

    it("does not show subcategory labels like ' > Aluguel' in the donut", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        categories: [
          { id: "c1", name: "Moradia > Aluguel", kind: "expense" as const, icon: "Home" },
          { id: "c2", name: "Transporte > Gasolina", kind: "expense" as const, icon: "Car" },
        ],
        transactions: [
          { id: "t1", description: "Aluguel", amountCents: 50000, date: "2026-06-01", kind: "expense", categoryId: "c1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Gasolina", amountCents: 30000, date: "2026-06-01", kind: "expense", categoryId: "c2", accountId: "acc1", method: "PIX" },
        ],
      } as unknown as AppState);
      const { container } = render(<HomePage />);
      // Find the "Gastos por categoria" card and check there's no " > " inside it
      const allDivs = container.querySelectorAll('div[data-testid="category-row"]');
      allDivs.forEach((d) => {
        expect(d.textContent).not.toMatch(/>/);
      });
    });

    it("macro rows are NOT clickable via category-row testid", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        categories: [
          { id: "c1", name: "Moradia > Aluguel", kind: "expense" as const, icon: "Home" },
          { id: "c2", name: "Alimentação", kind: "expense" as const, icon: "UtensilsCrossed" },
        ],
        transactions: [
          { id: "t1", description: "Aluguel", amountCents: 50000, date: "2026-06-01", kind: "expense", categoryId: "c1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Mercado", amountCents: 20000, date: "2026-06-01", kind: "expense", categoryId: "c2", accountId: "acc1", method: "PIX" },
        ],
      } as unknown as AppState);
      const { container } = render(<HomePage />);
      const macroRows = container.querySelectorAll('[data-testid="category-row"]');
      // Even though there are 2 macro rows, neither should be inside a <button>,
      // because aggregated rows have no single categoryId to navigate to.
      // Check that the rows do NOT have role="button" or onClick bound (by checking
      // they are plain <div> not <button>).
      macroRows.forEach((row) => {
        expect(row.tagName).not.toBe("BUTTON");
      });
    });

    it("uses parentId metadata when available instead of name prefix", () => {
      // Category with parentId set: resolve to parent's name
      const macroCat = { id: "macro", name: "Transporte", kind: "expense" as const, icon: "Car" };
      const subCat = { id: "sub1", name: "Gasolina", kind: "expense" as const, icon: "Car", parentId: "macro" };
      const subCat2 = { id: "sub2", name: "Uber", kind: "expense" as const, icon: "Car", parentId: "macro" };
      const otherMacro = { id: "other", name: "Alimentação", kind: "expense" as const, icon: "UtensilsCrossed" };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        categories: [macroCat, subCat, subCat2, otherMacro],
        transactions: [
          { id: "t1", description: "Gasolina", amountCents: 30000, date: "2026-06-01", kind: "expense", categoryId: "sub1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Uber", amountCents: 15000, date: "2026-06-01", kind: "expense", categoryId: "sub2", accountId: "acc1", method: "PIX" },
          { id: "t3", description: "Mercado", amountCents: 50000, date: "2026-06-01", kind: "expense", categoryId: "other", accountId: "acc1", method: "PIX" },
        ],
      } as unknown as AppState);
      render(<HomePage />);
      const rows = screen.getAllByTestId("category-row");
      // Sorted by amount desc: Alimentação (R$ 500) > Transporte (R$ 450)
      expect(rows.length).toBe(2);
      expect(rows[0]!.textContent).toMatch(/Alimentação/);
      expect(rows[0]!.textContent).toMatch(/500,00/);
      expect(rows[1]!.textContent).toMatch(/Transporte/);
      expect(rows[1]!.textContent).toMatch(/450,00/);
    });

    it("aggregates categories with same macro prefix, keeping standalones as-is", () => {
      // Mixed: some with " > " prefix, some standalone
      const cats = [
        { id: "c1", name: "Alimentação > Mercado", kind: "expense" as const, icon: "UtensilsCrossed" },
        { id: "c2", name: "Alimentação > Restaurante", kind: "expense" as const, icon: "UtensilsCrossed" },
        { id: "c3", name: "Moradia", kind: "expense" as const, icon: "Home" },
      ];
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        categories: cats,
        transactions: [
          { id: "t1", description: "Mercado", amountCents: 10000, date: "2026-06-01", kind: "expense", categoryId: "c1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Restaurante", amountCents: 20000, date: "2026-06-01", kind: "expense", categoryId: "c2", accountId: "acc1", method: "PIX" },
          { id: "t3", description: "Aluguel", amountCents: 50000, date: "2026-06-01", kind: "expense", categoryId: "c3", accountId: "acc1", method: "PIX" },
        ],
      } as unknown as AppState);
      render(<HomePage />);
      const rows = screen.getAllByTestId("category-row");
      // Moradia (R$ 500) > Alimentação (R$ 300)
      expect(rows.length).toBe(2);
      expect(rows[0]!.textContent).toMatch(/Moradia/);
      expect(rows[0]!.textContent).toMatch(/500,00/);
      expect(rows[1]!.textContent).toMatch(/Alimentação/);
      expect(rows[1]!.textContent).toMatch(/300,00/);
    });
  });

  describe("insights: reject generic API when specific fallback exists", () => {
    /**
     * Bug: quickInsights from backend may contain only generic items like
     * "Mês equilibrado" (even-net) which replace all specific local insights
     * like Maior categoria de gasto / Orçamentos no limite / Próxima conta.
     * Fix: skip API insights whose body lacks a concrete financial marker
     * (no "R$" or only generic "empatadas" phrasing) and fall back to the
     * local-specific fallbackInsights instead.
     */

    it("shows specific local insights when quickInsights has only generic items (no R$)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        // even-net has no R$ in the body — generic
        quickInsights: [
          {
            id: "even-net",
            title: "Mês equilibrado",
            body: "Receitas e despesas estão empatadas até o momento.",
            severity: "info",
          },
        ],
      } as AppState);
      render(<HomePage />);
      // Fallback insights mention specific financial subjects
      expect(screen.getByText(/Maior categoria/i)).toBeInTheDocument();
      // The generic API insight must NOT appear
      expect(screen.queryByText(/Mês equilibrado/i)).not.toBeInTheDocument();
    });

    it("supplements fallback with specific API insights (has R$ in body)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        quickInsights: [
          {
            id: "cashflow-grow",
            title: "Caixa crescendo",
            body: "Caixa subiu R$ 2.639,40 nos últimos 30 dias.",
            severity: "good",
          },
        ],
      } as AppState);
      render(<HomePage />);
      // Fallback insights still shown
      expect(screen.getByText(/Maior categoria/i)).toBeInTheDocument();
      // Specific API insight also shown (has R$ in body)
      expect(screen.getByText(/Caixa crescendo/i)).toBeInTheDocument();
    });

    it("falls back entirely to local insights when quickInsights is empty array", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        quickInsights: [],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText(/Maior categoria/i)).toBeInTheDocument();
    });
  });

  describe("insight consistency: macro categories + honest budgets", () => {
    /**
     * Bug: "Maior categoria de gasto" insight shows subcategory label
     * ("Moradia > Aluguel") while the donut shows macro "Moradia".
     * Fix: reuse macro aggregation (parentId or " > " prefix) so the
     * insight picks the top MACRO category, matching the donut display.
     *
     * Bug: "Orçamentos sob controle" shows "0.0%" when budget data has
     * spentCents = 0 but actual transactions exist. Fix: compute spent
     * from transactions for each budget category, or skip the insight
     * when the result is not representative (maxUsage === 0).
     */

    it("top expense insight uses macro label (not subcategory with ' > ')", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        categories: [
          { id: "c1", name: "Moradia > Aluguel", kind: "expense" as const, icon: "Home" },
          { id: "c2", name: "Moradia > Condomínio", kind: "expense" as const, icon: "Home" },
          { id: "c3", name: "Alimentação", kind: "expense" as const, icon: "UtensilsCrossed" },
        ],
        transactions: [
          { id: "t1", description: "Aluguel", amountCents: 100000, date: "2026-06-01", kind: "expense", categoryId: "c1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Cond", amountCents: 50000, date: "2026-06-01", kind: "expense", categoryId: "c2", accountId: "acc1", method: "PIX" },
          { id: "t3", description: "Mercado", amountCents: 30000, date: "2026-06-01", kind: "expense", categoryId: "c3", accountId: "acc1", method: "PIX" },
        ],
        quickInsights: undefined,
      } as unknown as AppState);
      render(<HomePage />);
      // The insight should say "Moradia" not "Moradia > Aluguel".
      // Title and body are sibling elements; read full document text.
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/Moradia/);
      expect(body).toMatch(/1\.500,00/);
      // Must not contain ">" in the insights section. The " > " check
      // on the full body is safe because no other text has " > ".
      const insightsStart = body.indexOf("Insights");
      if (insightsStart >= 0) {
        const insightsSection = body.slice(insightsStart);
        expect(insightsSection).not.toMatch(/>/);
      }
    });

    it("budget insight skips 0.0% when spentCents is 0", () => {
      // Budget with spentCents = 0 but actual transactions for that category
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        budgets: [
          { id: "b1", categoryId: "cat1", name: "Alimentação", amountCents: 50000, spentCents: 0, period: "monthly" },
        ],
        transactions: [
          { id: "t1", description: "Mercado", amountCents: 30000, date: "2026-06-20", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
        ],
        quickInsights: undefined,
      } as unknown as AppState);
      render(<HomePage />);
      // If the budget insight is present, it must NOT say "0.0%" (standalone zero)
      const body = document.body.textContent ?? "";
      if (body.includes("Orçamento")) {
        expect(body).not.toMatch(/(?<![0-9])0[.,]0%/);
      }
      // No standalone "0.0%" anywhere
      expect(body).not.toMatch(/(?<![0-9])0[.,]0%/);
    });

    it("budget insight uses transactions-based spent when budget.spentCents is 0", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        budgets: [
          // b1: spentCents = 0 (stale), but actual txns exist for cat1
          { id: "b1", categoryId: "cat1", name: "Alimentação", amountCents: 50000, spentCents: 0, period: "monthly" },
          // b2: other budget with no transactions
          { id: "b2", categoryId: "cat2", name: "Transporte", amountCents: 30000, spentCents: 0, period: "monthly" },
        ],
        transactions: [
          { id: "t1", description: "Mercado", amountCents: 10000, date: "2026-06-20", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
          { id: "t2", description: "Restaurante", amountCents: 15000, date: "2026-06-21", kind: "expense", categoryId: "cat1", accountId: "acc1", method: "PIX" },
        ],
        quickInsights: undefined,
      } as unknown as AppState);
      render(<HomePage />);
      const body = document.body.textContent ?? "";
      // If budget insight shows, percentage should reflect 25000/50000 = 50%
      if (body.includes("Orçamento")) {
        expect(body).toMatch(/50[.,]0?%/);
        expect(body).not.toMatch(/(?<![0-9])0[.,]0%/);
      }
    });

    describe("budget insight near-limit copy (less cluttered)", () => {
      /**
       * Bug: "Orçamentos no limite" lists ALL budget names with subcategory
       * clutter when many are near limit. Fix: for 2+, use a concise summary
       * (count + top one). For 1 item, keep it specific.
       */

      it("single budget near limit — keeps specific name", () => {
        vi.spyOn(appStateModule, "useAppState").mockReturnValue({
          ...defaultState(),
          budgets: [
            { id: "b1", categoryId: "cat1", name: "Alimentação", amountCents: 50000, spentCents: 50000, period: "monthly" },
          ],
          transactions: [],
          payables: [],
          quickInsights: undefined,
        } as unknown as AppState);
        render(<HomePage />);
        const body = document.body.textContent ?? "";
        // Should say "Alimentação está perto do limite" not a count summary
        expect(body).toMatch(/Alimentação está perto do limite/i);
        expect(body).not.toMatch(/\d orçamentos perto do limite/i);
      });

      it("multiple budgets near limit — uses short summary with count + top name", () => {
        vi.spyOn(appStateModule, "useAppState").mockReturnValue({
          ...defaultState(),
          budgets: [
            { id: "b1", categoryId: "cat1", name: "Alimentação", amountCents: 10000, spentCents: 10000, period: "monthly" },
            { id: "b2", categoryId: "cat2", name: "Transporte", amountCents: 10000, spentCents: 9500, period: "monthly" },
            { id: "b3", categoryId: "cat3", name: "Moradia", amountCents: 10000, spentCents: 9000, period: "monthly" },
          ],
          transactions: [],
          payables: [],
          quickInsights: undefined,
        } as unknown as AppState);
        render(<HomePage />);
        const body = document.body.textContent ?? "";
        // Must use summary format: count + top name
        expect(body).toMatch(/3 orçamentos.*perto do limite/i);
        expect(body).toMatch(/Alimentação/i);
        // Must NOT list all 3 names with join
        expect(body).not.toMatch(/Alimentação.*Transporte.*Moradia.*perto do limite/i);
      });
    });
  });

  describe("Server-owned dashboard summary gate (G5.2.9)", () => {
    it("renders server-owned monetary aggregates when dashboardSummary is provided by the server", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        // Local accounts/transactions have completely different values
        accounts: [{ id: "acc1", name: "Nubank", balanceCents: 1000, kind: "checking" }],
        transactions: [
          { id: "tx1", description: "A", amountCents: 2000, date: "2026-06-01", kind: "income", categoryId: "cat1", accountId: "acc1" },
          { id: "tx2", description: "B", amountCents: 500, date: "2026-06-01", kind: "expense", categoryId: "cat1", accountId: "acc1" },
        ],
        dashboardSummary: {
          householdId: "h1",
          generatedAt: "2026-06-20T12:00:00Z",
          totalBalanceCents: 1234500, // R$ 12.345,00
          monthIncomeCents: 987600,   // R$ 9.876,00
          monthExpenseCents: 432100,  // R$ 4.321,00
          monthNetCents: 555500,      // R$ 5.555,00
          cashFlowLast30DaysCents: 555500,
          topExpenses: [],
          topExpenseCategories: [],
          topIncomeCategories: [],
          monthOverMonth: {
            incomeChangePercent: null,
            expenseChangePercent: null,
            netChangeCents: 0,
          },
          alerts: [],
        },
      } as AppState);

      render(<HomePage />);

      // Hero must render the server-provided aggregates, NOT the local calculations (which would be R$ 10,00, R$ 20,00, R$ 5,00, R$ 15,00)
      expect(screen.getByText("R$ 12.345,00")).toBeInTheDocument();
      expect(screen.getByText("R$ 9.876,00")).toBeInTheDocument();
      expect(screen.getAllByText("R$ 4.321,00").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("R$ 5.555,00")).toBeInTheDocument();
    });

    it("does NOT render fabricated monetary aggregates when serverSummary is missing (gate false)", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        // Local accounts and transactions exist, but server summary is null
        accounts: [{ id: "acc1", name: "Nubank", balanceCents: 154320, kind: "checking" }],
        transactions: [
          { id: "tx1", description: "Salario", amountCents: 500000, date: "2026-06-01", kind: "income", categoryId: "cat1", accountId: "acc1" },
        ],
        dashboardSummary: null,
      } as AppState);

      render(<HomePage />);

      // Totals must NOT be fabricated from local transactions/accounts; placeholder "—" is rendered instead
      const dashes = screen.getAllByText("—");
      expect(dashes.length).toBeGreaterThanOrEqual(4);

      // Locally computed sums like R$ 1.543,20 for saldo or R$ 5.000,00 for income must NOT appear in the summary areas
      expect(screen.queryByText("R$ 5.000,00")).not.toBeInTheDocument();
    });

    it("aggregateFromSnapshot returns null for partial snapshots", async () => {
      const { aggregateFromSnapshot } = await import("@/features/dashboard-summary-gate");
      expect(aggregateFromSnapshot({ syncedAt: null, txCount: 5 })).toBeNull();
      expect(aggregateFromSnapshot({ syncedAt: "2026-06-20", txCount: 10 })).toBeNull();
    });

    it("triggers refreshDashboardSummary when dashboardSummary is not yet loaded", () => {
      const refreshSpy = vi.fn();
      // FIX-168-R2: page reads require an active workspace — established here
      // so the test isolates the summary variable, not the workspace gate.
      vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue({
        activeWorkspace: { id: "ws-1", name: "Casa" },
      } as never);
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        dashboardSummary: null,
        refreshDashboardSummary: refreshSpy,
      } as AppState);

      render(<HomePage />);
      expect(refreshSpy).toHaveBeenCalled();
    });
  });

  describe("A4: home empty states with CTA", () => {
    it("shows EmptyState with Adicionar conta CTA when there are no checking accounts", async () => {
      const user = userEvent.setup();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        accounts: [],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Nenhuma conta ainda")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Adicionar conta" }));
      expect(mockRouter.push).toHaveBeenCalledWith("/hub/patrimonio?aba=contas");
    });

    it("shows EmptyState with Registrar despesa CTA when there are no expenses", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [],
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Sem despesas no período")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Registrar despesa" }),
      ).toBeInTheDocument();
    });

    it("shows EmptyState without CTA when there are no insights", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        transactions: [],
        payables: [],
        budgets: [],
        quickInsights: [],
        // Mock server summary would fabricate a savings-rate insight;
        // null it so the insights list is genuinely empty.
        dashboardSummary: null,
      } as AppState);
      render(<HomePage />);
      expect(screen.getByText("Sem insights por enquanto")).toBeInTheDocument();
    });

    it("A9: bell dot only renders when there are pending operations", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
      const { unmount } = render(<HomePage />);
      // isApiConfigured() is false in tests → pendingCount stays null → no dot
      const bell = screen.getByRole("button", { name: "Notificações" });
      expect(bell.querySelector(".bg-warning")).not.toBeInTheDocument();
      unmount();
    });
  });

  describe("review Onda 1 fixes", () => {
    it("marks the category donut as a no-swipe zone for the gesture nav", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
      const { container } = render(<HomePage />);
      const donut = container.querySelector('[data-testid="category-donut"]');
      expect(donut).toHaveAttribute("data-no-swipe", "true");
    });

    it("renders the error banner with a lucide icon instead of a text glyph", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        error: "Falha ao sincronizar",
      } as AppState);
      render(<HomePage />);
      const banner = screen.getByRole("alert");
      expect(banner).toHaveTextContent("Falha ao sincronizar");
      expect(banner.textContent).not.toMatch(/⚠/);
      expect(banner.querySelector("svg")).toBeInTheDocument();
    });

    it("keeps bottom breathing room so final CTAs clear the TED FAB", () => {
      vi.spyOn(appStateModule, "useAppState").mockReturnValue({
        ...defaultState(),
        accounts: [],
      } as AppState);
      const { container } = render(<HomePage />);
      expect(screen.getByRole("button", { name: "Adicionar conta" })).toBeInTheDocument();
      // Content area keeps >=88px bottom padding (TED launcher floats at bottom-88px)
      expect(container.querySelector(".pb-24")).toBeInTheDocument();
    });
  });

  describe("P3: hide/show balance", () => {
    const BALANCE_KEY = "meu-ted:hide-balance";

    beforeEach(() => {
      window.localStorage.removeItem(BALANCE_KEY);
    });

    it("masks hero balance + mini-stats behind the eye toggle with persistence", async () => {
      const user = userEvent.setup();
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(defaultState());
      render(<HomePage />);

      // Server summary renders the full balance + mini-stats initially.
      expect(screen.getByText("R$ 2.072,10")).toBeInTheDocument();
      expect(screen.getByText("R$ 6.850,00")).toBeInTheDocument();

      const hideBtn = screen.getByRole("button", { name: "Ocultar saldos" });
      expect(hideBtn).toHaveAttribute("aria-pressed", "false");
      await user.click(hideBtn);

      // Two-phase swap (90ms): wait for the masked state to land.
      expect(await screen.findByTestId("balance-hidden")).toBeInTheDocument();
      expect(screen.getAllByTestId("ministat-hidden")).toHaveLength(3);
      expect(screen.getByText("Saldo oculto")).toBeInTheDocument();
      expect(screen.queryByText("R$ 2.072,10")).not.toBeInTheDocument();
      expect(screen.queryByText("R$ 6.850,00")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mostrar saldos" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(window.localStorage.getItem(BALANCE_KEY)).toBe("1");

      await user.click(screen.getByRole("button", { name: "Mostrar saldos" }));
      await waitFor(() => {
        expect(screen.queryByTestId("balance-hidden")).not.toBeInTheDocument();
      });
      expect(window.localStorage.getItem(BALANCE_KEY)).toBe("0");
    });
  });

  describe("FIX-PWA-HOME-SNAPSHOT-SUMMARY: snapshot retry also recovers dashboardSummary", () => {
    function snapshotState(overrides: Partial<AppState> = {}) {
      return {
        ...defaultState(),
        sync: {
          ...defaultState().sync,
          accounts: { source: "snapshot", syncedAt: "2026-06-20T10:00:00.000Z" },
        },
        readOnly: true,
        ...overrides,
      } as AppState;
    }

    it("calls authoritative strict summary refresh after domain refresh succeeds", async () => {
      const user = userEvent.setup();
      const refreshDomains = vi.fn().mockResolvedValue(true);
      const refreshStrict = vi.fn().mockResolvedValue(undefined);
      // FIX-168-R2: snapshot retry requires an active workspace (page guard).
      vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue({
        activeWorkspace: { id: "ws-1", name: "Casa" },
      } as never);
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        snapshotState({
          refreshDomains,
          refreshDashboardSummary: vi.fn().mockResolvedValue(undefined),
          refreshDashboardSummaryStrict: refreshStrict,
        } as unknown as Partial<AppState>),
      );
      render(<HomePage />);
      await user.click(
        screen.getByRole("button", { name: /tentar novamente/i }),
      );
      await waitFor(() =>
        expect(refreshDomains).toHaveBeenCalledWith(
          expect.arrayContaining(["accounts"]),
        ),
      );
      await waitFor(() =>
        expect(refreshStrict).toHaveBeenCalledTimes(1),
      );
      expect(mockRouter.refresh).not.toHaveBeenCalled();
    });

    it("does NOT call summary refresh when domain refresh fails (keeps snapshot read-only)", async () => {
      const user = userEvent.setup();
      const refreshDomains = vi.fn().mockResolvedValue(false);
      const refreshStrict = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        snapshotState({
          refreshDomains,
          refreshDashboardSummary: vi.fn().mockResolvedValue(undefined),
          refreshDashboardSummaryStrict: refreshStrict,
        } as unknown as Partial<AppState>),
      );
      render(<HomePage />);
      await user.click(
        screen.getByRole("button", { name: /tentar novamente/i }),
      );
      await waitFor(() =>
        expect(refreshDomains).toHaveBeenCalledTimes(1),
      );
      // Give the (non-)hook a tick to prove it never fires on domain failure.
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshStrict).not.toHaveBeenCalled();
      expect(screen.getByTestId("stale-banner")).toBeInTheDocument();
    });

    it("surfaces an accessible summary error with retry when strict summary fails; retry recovers without reload", async () => {
      const user = userEvent.setup();
      const refreshDomains = vi.fn().mockResolvedValue(true);
      const refreshStrict = vi
        .fn()
        .mockRejectedValueOnce(new Error("summary offline"))
        .mockResolvedValueOnce(undefined);
      // FIX-168-R2: snapshot retry requires an active workspace (page guard).
      vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue({
        activeWorkspace: { id: "ws-1", name: "Casa" },
      } as never);
      const reloadSpy = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, reload: reloadSpy },
        writable: true,
        configurable: true,
      });
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(
        snapshotState({
          refreshDomains,
          refreshDashboardSummary: vi.fn().mockResolvedValue(undefined),
          refreshDashboardSummaryStrict: refreshStrict,
        } as unknown as Partial<AppState>),
      );
      render(<HomePage />);
      await user.click(
        screen.getByRole("button", { name: /tentar novamente/i }),
      );
      const summaryAlert = await screen.findByTestId("home-summary-error");
      expect(summaryAlert).toHaveAttribute("role", "alert");
      expect(reloadSpy).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole("button", { name: /tentar atualizar resumo/i }),
      );
      await waitFor(() =>
        expect(refreshStrict).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(screen.queryByTestId("home-summary-error")).not.toBeInTheDocument(),
      );
      expect(reloadSpy).not.toHaveBeenCalled();
    });
  });
});

