/**
 * T3.3 — provider integration (SPEC §15.4–§15.6, §25.6 frontend).
 *
 * RED-first: `reconcileMutation`, `reconciliationStale`,
 * `retryReconciliation` and the `reconciliation-stale-banner` do not exist
 * on AppStateProvider yet.
 */
import "fake-indexeddb/auto";
import { renderHook, act, waitFor, screen } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { setActiveWorkspaceId } from "@/lib/api/client";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";

function mockTx(id: string) {
  return {
    id,
    description: "Seed tx",
    amountCents: 1000,
    date: "2026-06-25",
    kind: "expense",
    categoryId: "cat1",
    accountId: "acc1",
  };
}

function tedReceipt(mutationId: string): MutationReceipt {
  return {
    mutationId,
    mutationKind: "transactions.expense.create",
    status: "succeeded",
    affectedTargets: [
      "transactions",
      "accounts",
      "dashboard-summary",
      "budgets",
      "quick-insights",
    ],
    operationId: "op-1",
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetSessionStatus();
  localStorage.clear();
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3001");
  localStorage.setItem("pi-finance:token", "test-token-abc");
  // V41C FIX 1: live bootstrap requires a probe-confirmed session.
  setSessionStatus({ status: "authenticated", user: { userId: "test-user" } });
  // FIX-168: bootstrap and writes additionally require an active workspace.
  setActiveWorkspaceId("test-workspace-1");
});

function mockReads() {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: [],
    total: 0,
  });
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchDashboardSummary").mockResolvedValue({
    balanceCents: 1,
    incomeCents: 2,
    expenseCents: 3,
    resultCents: -1,
  } as never);
}

describe("AppStateProvider — MutationReconciler integration (T3.3)", () => {
  it("normal write reconciles registry targets incl. dashboard-summary (Home sem reload)", async () => {
    mockReads();
    vi.spyOn(endpoints, "createExpenseTransaction").mockResolvedValue({
      ...mockTx("real-1"),
      receipt: tedReceipt("mut-normal-1"),
    } as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.addTransaction({
        id: "opt-1",
        description: "Mercado",
        amountCents: 850_00,
        date: "2026-09-14",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );

    // Optimistic tx reconciled with the server id AND financial UI refreshed.
    await waitFor(() =>
      expect(endpoints.fetchDashboardSummary).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(endpoints.fetchTransactions).toHaveBeenCalled(),
    );
    expect(result.current.reconciliationStale).toBeNull();
  });

  it("TED approval success reconciles the financial UI (mutationKind fallback até T3.4 expor o receipt)", async () => {
    mockReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.clearAllMocks();

    await act(() =>
      result.current.reconcileMutation!({
        mutationKind: "transactions.expense.create",
      }),
    );

    expect(endpoints.fetchTransactions).toHaveBeenCalled();
    expect(endpoints.fetchDashboardSummary).toHaveBeenCalled();
    // Registry-derived targeting: payable/goal/statement domains untouched.
    expect(endpoints.fetchPayables).not.toHaveBeenCalled();
    expect(endpoints.fetchGoals).not.toHaveBeenCalled();
    expect(endpoints.fetchStatements).not.toHaveBeenCalled();
  });

  it("dedups repeated TED receipts (approval retry não refaz refresh)", async () => {
    mockReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.clearAllMocks();

    const input = { receipt: tedReceipt("mut-ted-dup") };
    await act(() => result.current.reconcileMutation!(input));
    await act(() => result.current.reconcileMutation!(input));

    const txCalls = vi.mocked(endpoints.fetchTransactions).mock.calls.length;
    // bootstrap is cleared; one reconcile = one transactions refresh.
    expect(txCalls).toBe(1);
  });

  it("dedups repeated receipts across re-renders (single persistent reconciler)", async () => {
    mockReads();
    const { result, rerender } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.clearAllMocks();

    const input = { receipt: tedReceipt("mut-rerender-dup") };
    await act(() => result.current.reconcileMutation!(input));
    act(() => {
      rerender();
    });
    await act(() => result.current.reconcileMutation!(input));

    // The second receipt hits the same reconciler instance (seen set kept
    // across the refresh swap) — no second transactions refresh.
    expect(vi.mocked(endpoints.fetchTransactions).mock.calls.length).toBe(1);
  });

  it("refresh failure marks stale + banner + retry (nunca rollback da mutação)", async () => {
    mockReads();
    vi.spyOn(endpoints, "createExpenseTransaction").mockResolvedValue({
      ...mockTx("real-stale"),
      description: "Mercado",
      receipt: tedReceipt("mut-stale-1"),
    } as never);
    // Dashboard refresh fails AFTER the mutation succeeded.
    vi.mocked(endpoints.fetchDashboardSummary).mockRejectedValue(
      new Error("refresh down"),
    );
    // Server truth includes the persisted mutation (no rollback to assert).
    vi.mocked(endpoints.fetchTransactions).mockResolvedValue({
      items: [{ ...mockTx("real-stale"), description: "Mercado" } as never],
      total: 1,
    });

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.addTransaction({
        id: "opt-stale",
        description: "Mercado",
        amountCents: 850_00,
        date: "2026-09-14",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );

    await waitFor(() =>
      expect(result.current.reconciliationStale).not.toBeNull(),
    );
    expect(result.current.reconciliationStale?.message).toBe(
      "Lançamento registrado, mas não foi possível atualizar todos os dados.",
    );
    // Persisted mutation is kept — no rollback.
    expect(
      result.current.transactions.some((t) => t.description === "Mercado"),
    ).toBe(true);
    // Banner is rendered with a retry action (never silent).
    const banner = await screen.findByTestId("reconciliation-stale-banner");
    expect(banner).toHaveTextContent("Lançamento registrado");
    expect(
      screen.getByRole("button", { name: "Tentar novamente" }),
    ).toBeDefined();

    // Retry succeeds once the backend recovers.
    vi.mocked(endpoints.fetchDashboardSummary).mockResolvedValue({
      balanceCents: 1,
      incomeCents: 2,
      expenseCents: 3,
      resultCents: -1,
    } as never);
    await act(() => result.current.retryReconciliation!());
    await waitFor(() =>
      expect(result.current.reconciliationStale).toBeNull(),
    );
    expect(
      screen.queryByTestId("reconciliation-stale-banner"),
    ).toBeNull();
  });
});
