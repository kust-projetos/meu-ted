import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import {
  setActiveWorkspaceId,
  clearActiveWorkspaceId,
} from "@/lib/api/client";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";

/**
 * FIX-168-R2 (P2 SECREVIEW-168-167): reads + reconciliation sem workspace
 * ativo devem emitir ZERO I/O e nenhuma publicação tardia.
 *
 * RED primeiro: refreshDashboardSummary / refreshSubscriptions /
 * refreshDomains / reconcileMutation / retryReconciliation disparam fetch
 * mesmo sem workspace; resposta diferida durante archive publica.
 */
function mockApiReads() {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: [],
    total: 0,
  } as never);
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null as never);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchDashboardSummary").mockResolvedValue(null as never);
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
  setOfflineSubjectId("66666666-7777-4888-8999-aaaaaaaaaaaa");
  setSessionStatus({ status: "authenticated", user: { userId: "user-1" } });
  clearActiveWorkspaceId();
});

describe("FIX-168-R2: reads sem workspace emitem zero I/O", () => {
  it("refreshDashboardSummary sem workspace => zero chamadas", async () => {
    mockApiReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = (endpoints.fetchDashboardSummary as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    await act(() => result.current.refreshDashboardSummary());
    expect(
      (endpoints.fetchDashboardSummary as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsBefore);
  });

  it("refreshSubscriptions sem workspace => zero chamadas", async () => {
    mockApiReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = (endpoints.fetchSubscriptions as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    await act(() => result.current.refreshSubscriptions());
    expect(
      (endpoints.fetchSubscriptions as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsBefore);
  });

  it("refreshDomains sem workspace => false e zero I/O", async () => {
    mockApiReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.refreshDomains(["accounts"]);
    });
    expect(ok).toBe(false);
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
  });

  it("refreshDashboardSummaryStrict sem workspace => throw sem I/O", async () => {
    mockApiReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(
      result.current.refreshDashboardSummaryStrict!(),
    ).rejects.toThrow();
    expect(endpoints.fetchDashboardSummary).not.toHaveBeenCalled();
  });

  it("reconcileMutation sem workspace => zero I/O e sem stale", async () => {
    mockApiReads();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let outcome!: Awaited<ReturnType<NonNullable<typeof result.current.reconcileMutation>>>;
    await act(async () => {
      outcome = await result.current.reconcileMutation!({
        mutationKind: "transaction.create",
      });
    });
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(endpoints.fetchTransactions).not.toHaveBeenCalled();
    expect(endpoints.fetchDashboardSummary).not.toHaveBeenCalled();
    expect(outcome.deduped).toBe(true);
    expect(result.current.reconciliationStale).toBeNull();
  });

  it("retryReconciliation sem workspace => zero I/O", async () => {
    mockApiReads();
    // Com workspace: força um stale real (refresh falha).
    setActiveWorkspaceId("ws-1");
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValueOnce(
      new Error("boom"),
    );
    await act(async () => {
      await result.current.reconcileMutation!({ mutationKind: "account.create" });
    });
    await waitFor(() =>
      expect(result.current.reconciliationStale).not.toBeNull(),
    );
    const failedCalls = (endpoints.fetchAccounts as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    // Workspace some antes do retry manual.
    clearActiveWorkspaceId();
    await act(async () => {
      await result.current.retryReconciliation!();
    });
    expect(
      (endpoints.fetchAccounts as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(failedCalls);
  });

  it("resposta diferida durante archive não publica (descarte tardio)", async () => {
    const liveSummary = {
      householdId: "h1",
      generatedAt: new Date().toISOString(),
      totalBalanceCents: 12345,
      monthIncomeCents: 1000,
      monthExpenseCents: 500,
      monthNetCents: 500,
      cashFlowLast30DaysCents: 500,
      topExpenses: [],
      topExpenseCategories: [],
      topIncomeCategories: [],
      monthOverMonth: { incomeChangePercent: null, expenseChangePercent: null },
    };
    let resolveSummary!: (v: typeof liveSummary) => void;
    const pending = new Promise<typeof liveSummary>((resolve) => {
      resolveSummary = resolve;
    });
    mockApiReads();
    (endpoints.fetchDashboardSummary as ReturnType<typeof vi.fn>).mockReturnValue(
      pending as never,
    );
    setActiveWorkspaceId("ws-1");
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refreshDashboardSummary();
    });
    // Archive/remount race: workspace some com o fetch em voo.
    clearActiveWorkspaceId();
    await act(async () => {
      resolveSummary(liveSummary);
      await refreshPromise;
    });
    expect(result.current.dashboardSummary).toBeNull();
  });
});
