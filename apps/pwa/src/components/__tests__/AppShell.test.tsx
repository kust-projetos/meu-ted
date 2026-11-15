import { render, screen, act, waitForElementToBeRemoved, within, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import AppShell from "../AppShell";
import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
  bodyScrollLockCount,
} from "@/lib/ui/overlay-a11y";
import * as appStateModule from "@/lib/state/app-state-context";
import { mockAccounts, mockCategories, ALL_MOCK_TRANSACTIONS, mockPayables, mockBudgets, mockGoals } from "@/lib/state/mock-data";
import type { AppState } from "@/lib/state/app-state-context";

let mockPath = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(mockPath === "/hub/patrimonio" ? "aba=cartoes" : ""),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/api/auth", () => ({
  fetchPendingMe: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}));

function defaultState(): AppState {
  return {
    accounts: [...mockAccounts], categories: [...mockCategories],
    transactions: [...ALL_MOCK_TRANSACTIONS], payables: [...mockPayables],
    budgets: [...mockBudgets], goals: [...mockGoals],
    debts: [], subscriptions: [], loading: false, error: null,
    addTransaction: vi.fn(), deleteTransaction: vi.fn(), markPayablePaid: vi.fn(),
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
    createCardPurchase: vi.fn(),
    updateTransaction: vi.fn(), cancelPayable: vi.fn(), updatePayable: vi.fn(),
    undoPayablePayment: vi.fn(), createPayable: vi.fn(), createBudget: vi.fn(),
    updateBudget: vi.fn(), createGoal: vi.fn(), contributeToGoal: vi.fn(), cancelGoal: vi.fn(),
    updateGoal: vi.fn(), updateAccount: vi.fn(), deactivateAccount: vi.fn(),
    updateCategory: vi.fn(), deactivateCategory: vi.fn(), deleteCategory: vi.fn(),
    applyCategoryDefaults: vi.fn(), updateSubscription: vi.fn(), refreshSubscriptions: vi.fn(),
    refreshDomains: vi.fn(),
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
  };
}

async function openSheetViaFab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Novo lançamento"));
  await user.click(screen.getByRole("button", { name: "Despesa" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
}

function navButton(label: string): HTMLButtonElement {  const bottomNav = document.querySelector('[data-nav="bottom"]');
  const elements = screen.getAllByText(label);
  const button = elements
    .map((el) => el.closest("button"))
    .find((b) => b && (!bottomNav || bottomNav.contains(b)));
  if (!button) throw new Error(`Button for ${label} not found`);
  return button as HTMLButtonElement;
}

function expectActive(label: string) {
  expect(navButton(label)).toHaveStyle({ color: "var(--color-primary)" });
}

function expectInactive(label: string) {
  expect(navButton(label)).toHaveStyle({ color: "var(--color-text-muted)" });
}

describe("AppShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPath = "/";
  });

  afterEach(() => {
    while (bodyScrollLockCount() > 0) releaseBodyScrollLock();
  });

  describe("rendering", () => {
    it("renders children", () => {
      render(<AppShell><div data-testid="content">Hello</div></AppShell>);
      expect(screen.getByTestId("content")).toBeInTheDocument();
    });

    it("renders bottom navigation", () => {
      render(<AppShell><div>Content</div></AppShell>);
      expect(screen.getAllByText("Início").length).toBeGreaterThanOrEqual(1);
      const bottomNav = document.querySelector('[data-nav="bottom"]');
      expect(bottomNav).toBeInTheDocument();
    });
  });

  describe("responsive shell", () => {
    it("wraps content in a responsive container with --shell-max-w variable", () => {
      const { container } = render(
        <AppShell><div data-testid="content">Hello</div></AppShell>,
      );
      const shell = container.querySelector('[data-shell="root"]') as HTMLElement;
      expect(shell).toBeInTheDocument();
      expect(shell.className).toMatch(/max-w-\[var\(--shell-max-w\)\]/);
    });

    it("uses mx-auto to center the shell on wide viewports", () => {
      const { container } = render(
        <AppShell><div>Content</div></AppShell>,
      );
      const shell = container.querySelector('[data-shell="root"]') as HTMLElement;
      expect(shell.className).toMatch(/mx-auto/);
    });
  });

  describe("active nav state", () => {
    it("highlights Início for /", () => {
      mockPath = "/";
      render(<AppShell><div>Content</div></AppShell>);
      expectActive("Início");
      expectInactive("Relatórios");
    });

    it("highlights Extrato for /registros", () => {
      mockPath = "/registros";
      render(<AppShell><div>Content</div></AppShell>);
      expectActive("Extrato");
      expectInactive("Início");
    });

    it("leaves tabs inactive for commitments", () => {
      mockPath = "/compromissos";
      render(<AppShell><div>Content</div></AppShell>);
      expectInactive("Cartões");
      expectInactive("Início");
    });

    it("highlights Cartões only for its selected tab", () => {
      mockPath = "/hub/patrimonio";
      render(<AppShell><div>Content</div></AppShell>);
      expectActive("Cartões");
      expectInactive("Início");
    });

    it.each(["/perfil", "/capture", "/convite"])(
      "leaves every tab inactive on non-tab route %s",
      (route) => {
        mockPath = route;
        render(<AppShell><div>{route}</div></AppShell>);
        expectInactive("Início");
        expectInactive("Relatórios");
      },
    );
  });

  describe("sheet navigation", () => {
    it("opens the quick actions disclosure when FAB is clicked", async () => {
      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);
      await user.click(screen.getByLabelText("Novo lançamento"));
      expect(screen.getByRole("group", { name: "Ações de novo lançamento" })).toBeInTheDocument();
      expect(screen.getByText("Despesa")).toBeInTheDocument();
    });

    it("opens the preselected expense sheet from the FAB quick actions", async () => {
      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);
      await user.click(screen.getByLabelText("Novo lançamento"));
      await user.click(screen.getByRole("button", { name: "Despesa" }));
      expect(screen.getByText("Nova despesa")).toBeInTheDocument();
    });
  });

  describe("sheet close behaviors", () => {
    it("closes sheet when navigating between tabs", async () => {
      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      // Open sheet via FAB quick menu
      await openSheetViaFab(user);

      // Click bottom nav "Extrato"
      await user.click(navButton("Extrato"));

      // Sheet should close (exit animation plays, then no dialog remains)
      await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes sheet via Escape key", async () => {
      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      // Open sheet via FAB quick menu
      await openSheetViaFab(user);

      // Press Escape
      await user.keyboard("{Escape}");

      // Sheet should close (exit animation plays, then no dialog remains)
      await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes sheet and leaves no residual overlay", async () => {
      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      // Open sheet via FAB quick menu
      await openSheetViaFab(user);

      // Close via backdrop
      const dialog = screen.getByRole("dialog");
      const overlay = dialog.firstElementChild;
      await user.click(overlay!);

      // After close, no dialog should remain (past the exit animation)
      await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("add transaction flow", () => {
    it("adds an expense and calls addTransaction", async () => {
      const addSpy = vi.fn().mockResolvedValue(undefined);
      const state = { ...defaultState(), addTransaction: addSpy };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(state);

      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      await openSheetViaFab(user);
      const amountInput = screen.getByPlaceholderText("0,00");
      await user.type(amountInput, "5000");
      const descInput = screen.getByPlaceholderText(/Aluguel, mercado/);
      await user.type(descInput, "Mercado semanal");
      // Category via picker sheet (nested dialog: the picker is the last one).
      await user.click(screen.getByRole("button", { name: "Selecionar categoria" }));
      const catDialog = (await screen.findAllByRole("dialog")).at(-1)!;
      await user.click(within(catDialog).getByRole("button", { name: "Alimentação" }));
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      // Origin via picker sheet.
      await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
      const originDialog = (await screen.findAllByRole("dialog")).at(-1)!;
      await user.click(within(originDialog).getByRole("button", { name: /Nubank/ }));
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      await user.click(screen.getByText("Salvar"));

      expect(addSpy).toHaveBeenCalledTimes(1);
      const callArg = addSpy.mock.calls[0][0];
      expect(callArg.kind).toBe("expense");
      expect(callArg.amountCents).toBe(5000);
      expect(callArg.description).toBe("Mercado semanal");
    });

    it("uses createTransfer for transfers", async () => {
      const transferSpy = vi.fn().mockResolvedValue(undefined);
      const state = { ...defaultState(), createTransfer: transferSpy };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(state);

      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      await openSheetViaFab(user);
      await user.click(screen.getByText("Transferência"));
      const amountInput = screen.getByPlaceholderText("0,00");
      await user.type(amountInput, "10000");
      const descInput = screen.getByPlaceholderText(/Aluguel, mercado/);
      await user.type(descInput, "PIX para poupança");
      const nubankButtons = screen.getAllByText("Nubank");
      await user.click(nubankButtons[0]); // origin
      const interButtons = screen.getAllByText("Inter");
      // last Inter chip is under Destino (entrada)
      await user.click(interButtons[interButtons.length - 1]);
      await user.click(screen.getByText("Transferir"));

      expect(transferSpy).toHaveBeenCalledTimes(1);
      expect(transferSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: "PIX para poupança", amountCents: 10000 }),
      );
    });

    it("calls createInstallments when installments are active", async () => {
      const installmentsSpy = vi.fn().mockResolvedValue(undefined);
      const state = { ...defaultState(), createInstallments: installmentsSpy };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(state);

      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      await openSheetViaFab(user);
      const valorInput = screen.getByPlaceholderText(/0,00/);
      await user.type(valorInput, "600000");
      const descInput = screen.getByPlaceholderText(/Aluguel, mercado/);
      await user.type(descInput, "Notebook");
      // Card origin (B2+B3): segmented toggle + origin sheet.
      await user.click(screen.getByRole("button", { name: "Cartão" }));
      await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
      const originDialog = (await screen.findAllByRole("dialog")).at(-1)!;
      await user.click(within(originDialog).getByRole("button", { name: /Nubank Crédito/ }));
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      await user.click(screen.getByText("12x"));
      await user.click(screen.getByText("Salvar em 12x"));

       expect(installmentsSpy).toHaveBeenCalledTimes(1);
       expect(installmentsSpy).toHaveBeenCalledWith(
         expect.objectContaining({ totalAmountCents: 600000, installmentsTotal: 12, description: "Notebook" }),
       );
     });

    it("routes a 1x card expense to createCardPurchase, never addTransaction (H-01)", async () => {
      const purchaseSpy = vi.fn().mockResolvedValue(undefined);
      const addSpy = vi.fn().mockResolvedValue(undefined);
      const state = { ...defaultState(), createCardPurchase: purchaseSpy, addTransaction: addSpy };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(state);

      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      await openSheetViaFab(user);
      await user.type(screen.getByPlaceholderText(/0,00/), "10000");
      await user.type(screen.getByPlaceholderText(/Aluguel, mercado/), "Almoço");
      await user.click(screen.getByRole("button", { name: "Cartão" }));
      await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
      const originDialog = (await screen.findAllByRole("dialog")).at(-1)!;
      await user.click(within(originDialog).getByRole("button", { name: /Nubank Crédito/ }));
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: /^Salvar$/ }));

      expect(purchaseSpy).toHaveBeenCalledTimes(1);
      expect(purchaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 10000, description: "Almoço" }),
      );
      expect(addSpy).not.toHaveBeenCalled();
    });

    it("forwards notes and subcategoryId to createInstallments (M-04)", async () => {
      const installmentsSpy = vi.fn().mockResolvedValue(undefined);
      const state = { ...defaultState(), createInstallments: installmentsSpy };
      vi.spyOn(appStateModule, "useAppState").mockReturnValue(state);

      const user = userEvent.setup();
      render(<AppShell><div>Content</div></AppShell>);

      await openSheetViaFab(user);
      await user.type(screen.getByPlaceholderText(/0,00/), "600000");
      await user.type(screen.getByPlaceholderText(/Aluguel, mercado/), "Notebook");
      await user.click(screen.getByRole("button", { name: "Cartão" }));
      await user.click(screen.getByRole("button", { name: "Selecionar conta ou cartão" }));
      const originDialog = (await screen.findAllByRole("dialog")).at(-1)!;
      await user.click(within(originDialog).getByRole("button", { name: /Nubank Crédito/ }));
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      await user.click(screen.getByText("12x"));
      await user.click(screen.getByRole("button", { name: "Mais detalhes" }));
      await user.type(screen.getByLabelText("Observações"), "Para o trabalho");
      await user.click(screen.getByText("Salvar em 12x"));

      expect(installmentsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ notes: "Para o trabalho" }),
      );
    });
    });

   it("shows pending invites badge when there are pending invites", async () => {
     const { fetchPendingMe } = await import("@/lib/api/auth");
     (fetchPendingMe as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [{ id: "inv-1", householdId: "ws-1", email: "convidado@example.com", role: "member", expiresAt: "2026-09-07T12:00:00.000Z" }], total: 1 });
     render(<AppShell><div>Content</div></AppShell>);
     expect(await screen.findByLabelText(/convite\(s\) pendente\(s\)/)).toBeInTheDocument();
     expect(screen.getByText("1")).toBeInTheDocument();
   });

    it("does not show pending invites badge when there are no pending invites", async () => {
      render(<AppShell><div>Content</div></AppShell>);
      expect(screen.queryByLabelText(/convite\(s\) pendente\(s\)/)).not.toBeInTheDocument();
    });

    it("hides the pending invites badge while an overlay is open (v2 A1/A7)", async () => {
      const { fetchPendingMe } = await import("@/lib/api/auth");
      (fetchPendingMe as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [{ id: "inv-1", householdId: "ws-1", email: "convidado@example.com", role: "member", expiresAt: "2026-09-07T12:00:00.000Z" }], total: 1 });
      render(<AppShell><div>Content</div></AppShell>);
      expect(await screen.findByLabelText(/convite\(s\) pendente\(s\)/)).toBeInTheDocument();
      await act(async () => {
        acquireBodyScrollLock();
      });
      expect(screen.queryByLabelText(/convite\(s\) pendente\(s\)/)).not.toBeInTheDocument();
      await act(async () => {
        releaseBodyScrollLock();
      });
      expect(screen.getByLabelText(/convite\(s\) pendente\(s\)/)).toBeInTheDocument();
      expect(screen.getByTestId("pending-invites-badge").querySelector("svg")).toBeInTheDocument();
    });

  });
