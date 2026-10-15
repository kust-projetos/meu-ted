import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@/lib/test-utils";
import HomePage from "@/features/home/HomePage";
import SubscriptionsPage from "@/features/subscriptions/SubscriptionsPage";
import * as appStateModule from "@/lib/state/app-state-context";
import * as workspaceModule from "@/lib/auth/workspace-context";
import { mockDashboardSummary } from "@/lib/state/mock-data";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function baseAppState(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [],
    categories: [],
    transactions: [],
    payables: [],
    budgets: [],
    goals: [],
    debts: [],
    subscriptions: [],
    cardStatements: [],
    profile: null,
    quickInsights: [],
    dashboardSummary: null,
    saveProfile: vi.fn(),
    refreshProfile: vi.fn(),
    refreshDashboardSummary: vi.fn().mockResolvedValue(undefined),
    refreshDashboardSummaryStrict: vi.fn().mockResolvedValue(undefined),
    refreshDomains: vi.fn().mockResolvedValue(true),
    sync: {
      accounts: { source: "live", syncedAt: null },
      categories: { source: "live", syncedAt: null },
      transactions: { source: "live", syncedAt: null },
      payables: { source: "live", syncedAt: null },
      budgets: { source: "live", syncedAt: null },
      goals: { source: "live", syncedAt: null },
      subscriptions: { source: "live", syncedAt: null },
      cardStatements: { source: "live", syncedAt: null },
    },
    readOnly: false,
    offlineLocked: false,
    revalidateOfflineSession: vi.fn(),
    loading: false,
    error: null,
    writeError: null,
    clearWriteError: vi.fn(),
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
    addAccount: vi.fn(),
    updateAccount: vi.fn(),
    deactivateAccount: vi.fn(),
    addCategory: vi.fn(),
    updateCategory: vi.fn(),
    deactivateCategory: vi.fn(),
    deleteCategory: vi.fn(),
    applyCategoryDefaults: vi.fn(),
    addCard: vi.fn(),
    updateCard: vi.fn(),
    addSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    refreshSubscriptions: vi.fn().mockResolvedValue(undefined),
    createTransfer: vi.fn(),
    payStatement: vi.fn(),
    createInstallments: vi.fn(),
    createCardPurchase: vi.fn(),
    ...overrides,
  } as unknown as appStateModule.AppState;
}

/**
 * FIX-168-R2 (P2): páginas não disparam reads sem workspace ativo.
 * RED: Home monta sem workspace => refreshDashboardSummary chamado;
 * Assinaturas monta sem workspace => refreshSubscriptions chamado.
 */
describe("FIX-168-R2: páginas sem workspace não disparam reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue(null);
  });

  it("Home monta sem workspace => zero chamadas dashboard", () => {
    const refreshDashboardSummary = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      baseAppState({ dashboardSummary: null, refreshDashboardSummary }),
    );
    render(<HomePage />);
    expect(refreshDashboardSummary).not.toHaveBeenCalled();
  });

  it("Home com workspace ativo mantém o refresh (sem regressão)", () => {
    const refreshDashboardSummary = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      baseAppState({ dashboardSummary: null, refreshDashboardSummary }),
    );
    vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue({
      activeWorkspace: { id: "ws-1", name: "Casa" },
    } as never);
    render(<HomePage />);
    expect(refreshDashboardSummary).toHaveBeenCalledTimes(1);
  });

  it("Assinaturas monta sem workspace => zero chamadas", () => {
    const refreshSubscriptions = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      baseAppState({ refreshSubscriptions }),
    );
    render(<SubscriptionsPage />);
    expect(refreshSubscriptions).not.toHaveBeenCalled();
  });

  it("Assinaturas com workspace ativo mantém o refresh (sem regressão)", () => {
    const refreshSubscriptions = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      baseAppState({ refreshSubscriptions }),
    );
    vi.spyOn(workspaceModule, "useWorkspaceSafe").mockReturnValue({
      activeWorkspace: { id: "ws-1", name: "Casa" },
    } as never);
    render(<SubscriptionsPage />);
    expect(refreshSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("Home sem dashboardSummary mas com resumo do servidor não refaz fetch", () => {
    const refreshDashboardSummary = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStateModule, "useAppState").mockReturnValue(
      baseAppState({ dashboardSummary: mockDashboardSummary, refreshDashboardSummary }),
    );
    render(<HomePage />);
    expect(refreshDashboardSummary).not.toHaveBeenCalled();
  });
});
