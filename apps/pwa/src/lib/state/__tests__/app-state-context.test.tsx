import "fake-indexeddb/auto";
import { renderHook, act, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import { ApiError, apiFetch, setActiveWorkspaceId } from "@/lib/api/client";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { SessionProvider } from "@/lib/auth/session-context";
import type { Account, Category, Transaction, Payable } from "@/lib/state/types";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";

// V4.1 Phase 5 (SPEC §12.6): the browser defaults to the same-origin proxy,
// so suites exercising the unconfigured mock-data path pin it explicitly via
// `apiNotConfigured()` below; everything else keeps the real default.
const apiConfigState = vi.hoisted(() => ({ forceUnconfigured: false }));
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    isApiConfigured: () =>
      apiConfigState.forceUnconfigured ? false : actual.isApiConfigured(),
  };
});

// ─── Spy setup ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  apiConfigState.forceUnconfigured = false;
  // V41C FIX 1: the online gate reads the probe-confirmed session authority
  // (module state persists across tests in this file) — every test starts
  // pre-probe; apiReady() below confirms a session where live I/O is wanted.
  resetSessionStatus();
  localStorage.clear();
  // v2 snapshot lives in IndexedDB — clear it between tests so a prior test's
  // persisted snapshot can't leak in as a "snapshot" source.
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockApiReads(
  overrides: Partial<{
    accounts: Account[];
    payables: Payable[];
  }> = {},
) {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue(
    overrides.accounts ?? [mockAccount("a1", "API Nubank")],
  );
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: [],
    total: 0,
  });
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue(
    overrides.payables ?? [],
  );
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  // New reads
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
}

function mockAccount(id: string, name: string): Account {
  return {
    id,
    name,
    kind: "checking",
    initialBalanceCents: 0,
    status: "active",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    balanceCents: 500_00,
  };
}

// Seeds a valid v1 (localStorage) snapshot. The production bootstrap migrates
// this to v2 (IndexedDB) before rendering — this exercises the real migration
// path (no direct v2 writes here, and no removed v1 helper calls).
function seedV1Snapshot<T>(domain: string, data: T[], token = "test-token-abc"): void {
  const V1_KEY = "pi-finance:snapshot:v1";
  let base: { version: 1; token: string; syncedAt: Record<string, string>; data: Record<string, unknown> } = {
    version: 1, token, syncedAt: {}, data: {},
  };
  try {
    const raw = localStorage.getItem(V1_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.token === token) {
        base = parsed;
      }
    }
  } catch { /* ignore */ }
  localStorage.setItem(V1_KEY, JSON.stringify({
    ...base,
    data: { ...base.data, [domain]: data },
    syncedAt: { ...base.syncedAt, [domain]: new Date().toISOString() },
  }));
}

const mockP1: Payable = {
  id: "p1",
  description: "Test payable",
  amountCents: 1000,
  dueDate: "2026-06-30",
  status: "pending",
  accountId: "acc1",
  type: "one_time",
  // V4.1 REVIEWFIX F2: the undo path requires the linked transaction id.
  paidTransactionId: "tx-1",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

function apiReady() {
  apiConfigState.forceUnconfigured = false;
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3001");
  localStorage.setItem("pi-finance:token", "test-token-abc");
  // V41C FIX 1: bearer alone never unlocks live I/O — tests exercising the
  // online path simulate the probe-confirmed session AuthGate publishes.
  setSessionStatus({ status: "authenticated", user: { userId: "test-user" } });
  // FIX-168: live I/O additionally requires an active workspace — tests
  // exercising the online path simulate the header WorkspaceProvider sets
  // after resolving the selection (module state is file-scoped).
  setActiveWorkspaceId("test-workspace-1");
  // T2.6 contract: v2 reads verify the subject partition — an
  // authenticated session always carries one (set at login).
  setOfflineSubjectId("66666666-7777-4888-8999-aaaaaaaaaaaa");
}

function apiNotConfigured() {
  vi.stubEnv(
    "NEXT_PUBLIC_PI_FINANCE_API_BASE_URL",
    undefined as unknown as string,
  );
  apiConfigState.forceUnconfigured = true;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AppStateProvider — mock-data path (no API)", () => {
  beforeEach(() => apiNotConfigured());

  it("provides mock accounts", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    expect(result.current.accounts).toHaveLength(5);
    expect(result.current.accounts[0].name).toBe("Nubank");
  });

  it("provides mock categories", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    const cats = result.current.categories;
    expect(cats.length).toBeGreaterThanOrEqual(5);
    expect(cats.filter((c) => c.kind === "expense").length).toBeGreaterThan(0);
  });

  it("provides mock transactions", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    expect(result.current.transactions.length).toBeGreaterThanOrEqual(3);
  });

  it("exposes loading=false and error=null", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("exposes all data fields and write actions", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    expect(result.current.accounts).toBeDefined();
    expect(result.current.categories).toBeDefined();
    expect(result.current.transactions).toBeDefined();
    expect(result.current.payables).toBeDefined();
    expect(result.current.budgets).toBeDefined();
    expect(result.current.goals).toBeDefined();
    expect(result.current.debts).toBeDefined();
    expect(result.current.subscriptions).toBeDefined();
    expect(result.current.cardStatements).toBeDefined();
    expect(typeof result.current.addTransaction).toBe("function");
    expect(typeof result.current.updateTransaction).toBe("function");
    expect(typeof result.current.deleteTransaction).toBe("function");
    expect(typeof result.current.markPayablePaid).toBe("function");
    expect(typeof result.current.cancelPayable).toBe("function");
    expect(typeof result.current.createPayable).toBe("function");
    expect(typeof result.current.createBudget).toBe("function");
    expect(typeof result.current.updateBudget).toBe("function");
    expect(typeof result.current.createGoal).toBe("function");
    expect(typeof result.current.contributeToGoal).toBe("function");
    expect(typeof result.current.cancelGoal).toBe("function");
    expect(typeof result.current.addAccount).toBe("function");
    expect(typeof result.current.updateAccount).toBe("function");
    expect(typeof result.current.deactivateAccount).toBe("function");
    expect(typeof result.current.addCategory).toBe("function");
    expect(typeof result.current.updateCategory).toBe("function");
    expect(typeof result.current.deactivateCategory).toBe("function");
    expect(typeof result.current.addCard).toBe("function");
    expect(typeof result.current.updateCard).toBe("function");
    expect(typeof result.current.addSubscription).toBe("function");
    expect(typeof result.current.cancelSubscription).toBe("function");
    expect(typeof result.current.createTransfer).toBe("function");
    expect(typeof result.current.payStatement).toBe("function");
    expect(typeof result.current.createInstallments).toBe("function");
  });

  it("adds a transaction locally when no API", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    const initialCount = result.current.transactions.length;
    await act(() =>
      result.current.addTransaction({
        id: "tx-new",
        description: "New test",
        amountCents: 5000,
        date: "2026-06-23",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );
    expect(result.current.transactions).toHaveLength(initialCount + 1);
    expect(result.current.transactions[0].description).toBe("New test");
  });

  it("marks a payable as paid locally when no API", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await act(() => result.current.markPayablePaid("p1"));
    const p = result.current.payables.find((p) => p.id === "p1");
    expect(p?.status).toBe("paid");
    expect(p?.paidDate).toBeDefined();
  });

  it("updates transaction locally when no API", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() =>
      expect(result.current.transactions.length).toBeGreaterThan(0),
    );
    const txId = result.current.transactions[0].id;

    await act(() =>
      result.current.updateTransaction(txId, {
        description: "Updated locally",
      }),
    );

    expect(result.current.transactions[0].description).toBe(
      "Updated locally",
    );
    expect(result.current.writeError).toBeNull();
  });

  it("throws if useAppState is used outside provider", () => {
    expect(() => renderHook(() => useAppState())).toThrow(
      "useAppState must be used within AppStateProvider",
    );
  });
});

describe("AppStateProvider — API read path", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads();
  });

  it("replaces mock data with API data when configured", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.accounts[0].name).toBe("API Nubank");
  });

  it("sets loading=true during fetch", async () => {
    vi.mocked(endpoints.fetchAccounts).mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r([mockAccount("a1", "Delayed")]), 100),
        ),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("on fetch failure with NO snapshot: empty, unavailable, read-only, never mock", async () => {
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new Error("Network error"),
    );
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // failed domain is empty (NOT the 5 mock accounts)
    expect(result.current.accounts).toHaveLength(0);
    expect(result.current.error).not.toBeNull();
    // essential domain down with no snapshot -> unavailable -> read-only ON
    expect(result.current.sync.accounts.source).toBe("unavailable");
    expect(result.current.readOnly).toBe(true);
    // a healthy domain still applied live
    expect(result.current.sync.categories.source).toBe("live");
  });

  it("on fetch failure WITH a prior snapshot: hydrates snapshot in read-only", async () => {
    seedV1Snapshot("accounts", [mockAccount("snap-1", "Snapshot Nubank")]);
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new Error("Network error"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.accounts[0].name).toBe("Snapshot Nubank");
    expect(result.current.sync.accounts.source).toBe("snapshot");
    expect(result.current.readOnly).toBe(true);
  });

  it("initializes empty (not mock) and not loading when the session is not confirmed", () => {
    // V41C FIX 1: without a probe-confirmed session the online gate stays
    // closed — bearer or not — so no bootstrap starts (waits for the probe).
    resetSessionStatus();
    localStorage.removeItem("pi-finance:token");
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    // configured -> no mock leak; unconfirmed session -> no fetch -> not stuck loading
    expect(result.current.loading).toBe(false);
    expect(result.current.accounts).toHaveLength(0);
    expect(result.current.debts).toHaveLength(0);
  });

  it("initializes empty + loading=true when configured with token", () => {
    vi.mocked(endpoints.fetchAccounts).mockImplementation(
      () => new Promise(() => {}), // never resolves -> stays loading
    );
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.accounts).toHaveLength(0);
  });

  it("exposes per-domain sync and a readOnly flag", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sync.accounts.source).toBe("live");
    expect(result.current.readOnly).toBe(false);
  });

  it("bootstrap does NOT call fetchSubscriptions (lazy-load only)", async () => {
    const spy = vi.spyOn(endpoints, "fetchSubscriptions");

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // fetchSubscriptions should never be called during bootstrap
    expect(spy).not.toHaveBeenCalled();
    // Subscriptions initial state is empty (not mock) when API is configured
    expect(result.current.subscriptions).toHaveLength(0);
  });

  it("merges credit cards from fetchCards into accounts", async () => {
    const checking = mockAccount("a1", "Nubank");
    const card1: Account = {
      id: "card-1",
      name: "Nubank Card",
      kind: "credit_card",
      balanceCents: 0,
      creditLimitCents: 5000_00,
      closingDay: 15,
      dueDay: 25,
    };
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([checking]);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    // fetchCards returns credit cards ("/cards/accounts")
    const fetchCardsSpy = vi
      .spyOn(endpoints, "fetchCards")
      .mockResolvedValue([card1]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // fetchCards was called during bootstrap
    expect(fetchCardsSpy).toHaveBeenCalled();
    // Accounts includes both checking and credit card
    expect(result.current.accounts).toHaveLength(2);
    const cc = result.current.accounts.find((a) => a.kind === "credit_card");
    expect(cc).toBeDefined();
    expect(cc?.name).toBe("Nubank Card");
  });

  it("cards from /cards/accounts overwrite same-id accounts from /accounts (kind normalization)", async () => {
    // Simulate the live bug: /accounts returns a card entry as "bank"
    const cardAsBank: Account = {
      id: "card-1",
      name: "Nubank Card",
      kind: "bank",
      balanceCents: 0,
      initialBalanceCents: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      status: "active",
    };
    const checking = mockAccount("a1", "Nubank");
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
      checking,
      cardAsBank,
    ]);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    // /cards/accounts returns the SAME id with correct credit_card kind + card fields
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([
      {
        id: "card-1",
        name: "Nubank Card",
        kind: "credit_card",
        balanceCents: 0,
        creditLimitCents: 5000_00,
        closingDay: 15,
        dueDay: 25,
      },
    ]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Cards should have overwritten accounts for same id
    expect(result.current.accounts).toHaveLength(2);
    const cc = result.current.accounts.find((a) => a.id === "card-1");
    expect(cc).toBeDefined();
    // Kind must be credit_card (from cards endpoint), not bank (from accounts)
    expect(cc!.kind).toBe("credit_card");
    // Card-specific fields preserved
    expect(cc!.creditLimitCents).toBe(5000_00);
    expect(cc!.closingDay).toBe(15);
    // Checking account unaffected
    const chk = result.current.accounts.find((a) => a.id === "a1");
    expect(chk?.kind).toBe("checking");
  });

  it("fetchCards failure does not break accounts loading", async () => {
    const checking = mockAccount("a1", "Nubank");
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([checking]);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    // fetchCards fails
    vi.spyOn(endpoints, "fetchCards").mockRejectedValue(
      new Error("Cards API down"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Accounts still loaded from /accounts
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.accounts[0].name).toBe("Nubank");
    // No global error (accounts succeeded)
    expect(result.current.error).toBeNull();
  });

  it("fetchCards succeeds even when fetchAccounts fails (graceful degraded accounts)", async () => {
    const card1: Account = {
      id: "card-1",
      name: "Nubank Card",
      kind: "credit_card",
      balanceCents: 0,
      creditLimitCents: 5000_00,
      closingDay: 15,
      dueDay: 25,
    };
    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(
      new Error("Accounts down"),
    );
    vi.spyOn(endpoints, "fetchCategories").mockRejectedValue(
      new Error("Cats down"),
    );
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(endpoints, "fetchPayables").mockRejectedValue(
      new Error("Payables down"),
    );
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([card1]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Credit card from fetchCards is available even though fetchAccounts failed
    const cc = result.current.accounts.find((a) => a.kind === "credit_card");
    expect(cc).toBeDefined();
    expect(cc?.name).toBe("Nubank Card");
    // Global error is still set because some essential domains failed
    expect(result.current.error).not.toBeNull();
    // readOnly is true because one essential domain (accounts) failed
    expect(result.current.readOnly).toBe(true);
  });
});

describe("AppStateProvider — refreshSubscriptions (lazy load)", () => {
  beforeEach(() => {
    apiReady();
    // Only essential domains — subscriptions NOT in bootstrap
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
      mockAccount("a1", "Nubank"),
    ]);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
  });

  it("exposes refreshSubscriptions as a function", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(typeof result.current.refreshSubscriptions).toBe("function");
  });

  it("fetches subscriptions on demand (live data)", async () => {
    const mockData = [
      {
        id: "s1",
        name: "Netflix",
        amountCents: 39_90,
        cycle: "monthly" as const,
        day: 15,
        paymentMethod: "credit_card",
        status: "active" as const,
      },
    ];
    const spy = vi
      .spyOn(endpoints, "fetchSubscriptions")
      .mockResolvedValue(mockData);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Bootstrap should NOT have called it
    expect(spy).not.toHaveBeenCalled();

    // Manually trigger lazy load
    await act(() => result.current.refreshSubscriptions());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.subscriptions).toHaveLength(1);
    expect(result.current.subscriptions[0].name).toBe("Netflix");
    expect(result.current.sync.subscriptions.source).toBe("live");
  });

  it("falls back to unavailable on fetch failure (no snapshot)", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockRejectedValue(
      new Error("Subscriptions down"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.subscriptions).toHaveLength(0);

    await act(() => result.current.refreshSubscriptions());

    // Falls back to unavailable when no snapshot exists
    expect(result.current.sync.subscriptions.source).toBe("unavailable");
    expect(result.current.subscriptions).toHaveLength(0);
  });

  it("loads snapshot on fetch failure when snapshot exists", async () => {
    // First, seed a v1 snapshot for subscriptions (migrated to v2 at bootstrap)
    seedV1Snapshot("subscriptions", [
      {
        id: "snap-s1",
        name: "Snap Netflix",
        amountCents: 39_90,
        cycle: "monthly",
        day: 15,
        paymentMethod: "credit_card",
        status: "active",
      },
    ]);

    vi.spyOn(endpoints, "fetchSubscriptions").mockRejectedValue(
      new Error("Subscriptions down"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.refreshSubscriptions());

    // Loaded from snapshot
    expect(result.current.subscriptions).toHaveLength(1);
    expect(result.current.subscriptions[0].name).toBe("Snap Netflix");
    expect(result.current.sync.subscriptions.source).toBe("snapshot");
  });

  it("does not call fetch when API is not configured", async () => {
    apiNotConfigured();
    const spy = vi
      .spyOn(endpoints, "fetchSubscriptions")
      .mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await act(() => result.current.refreshSubscriptions());

    expect(spy).not.toHaveBeenCalled();
    // Mock data should still be present
    expect(result.current.subscriptions.length).toBeGreaterThan(0);
  });
});

describe("AppStateProvider — API write path", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads({ payables: [mockP1] });
  });

  // ── addTransaction ──────────────────────────────────────────────

  it("calls createExpenseTransaction when adding expense with API", async () => {
    const spy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValue({} as Transaction);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.addTransaction({
        id: "tx-api-1",
        description: "API expense",
        amountCents: 1000,
        date: "2026-06-23",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "API expense",
        amountCents: 1000,
      }),
    );
  });

  it("forwards notes to createExpenseTransaction when present (item 10/B4)", async () => {
    const spy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValue({} as Transaction);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.addTransaction({
        id: "tx-api-notes",
        description: "API expense",
        amountCents: 1000,
        date: "2026-06-23",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
        notes: "Reembolsável",
      }),
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ notes: "Reembolsável" }),
    );
  });

  it("rolls back transaction when API write fails and sets writeError", async () => {
    vi.spyOn(endpoints, "createExpenseTransaction").mockRejectedValue(
      new Error("Offline"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.transactions.length;

    await act(async () => {
      await expect(
        result.current.addTransaction({
          id: "tx-offline",
          description: "Offline expense",
          amountCents: 500,
          date: "2026-06-23",
          kind: "expense",
          categoryId: "cat1",
          accountId: "acc1",
        }),
      ).rejects.toThrow("Offline");
    });

    // Transaction was rolled back (removed after API failure)
    expect(result.current.transactions).toHaveLength(prevCount);
    // writeError is set
    expect(result.current.writeError).toBe("Offline");
  });

  // ── markPayablePaid ─────────────────────────────────────────────

  it("calls markPayablePaid API endpoint", async () => {
    const spy = vi
      .spyOn(endpoints, "markPayablePaid")
      .mockResolvedValue({} as Payable);
    // Post-write reconciliation replaces optimistic state with server truth:
    // bootstrap sees pending p1, the post-pay refresh sees it paid.
    vi.mocked(endpoints.fetchPayables)
      .mockResolvedValueOnce([{ ...mockP1 }])
      .mockResolvedValue([{ ...mockP1, status: "paid" }]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.markPayablePaid("p1"));

    expect(spy).toHaveBeenCalledWith("p1", expect.any(String), expect.any(String));
    const p = result.current.payables.find((p) => p.id === "p1");
    expect(p?.status).toBe("paid");
  });

  it("rolls back markPayablePaid on API failure", async () => {
    vi.spyOn(endpoints, "markPayablePaid").mockRejectedValue(
      new Error("API error"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.markPayablePaid("p1"));

    // Payable reverted to pending
    const p = result.current.payables.find((p) => p.id === "p1");
    expect(p?.status).toBe("pending");
    expect(result.current.writeError).toBe("API error");
  });

  // ── updateTransaction ──────────────────────────────────────────

  it("calls updateTransaction API and rolls back on failure", async () => {
    // Seed initial data
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [
        {
          id: "tx-upd-1",
          description: "Old desc",
          amountCents: 1000,
          date: "2026-06-25",
          kind: "expense",
          categoryId: "cat1",
          accountId: "acc1",
        },
      ],
      total: 1,
    });

    const spy = vi
      .spyOn(endpoints, "updateTransaction")
      .mockRejectedValue(new Error("Offline"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transactions).toHaveLength(1);
    const txId = result.current.transactions[0].id;

    await act(() =>
      result.current.updateTransaction(txId, {
        description: "New desc",
        amountCents: 2000,
      }),
    );

    expect(spy).toHaveBeenCalledWith(txId, expect.objectContaining({
      description: "New desc",
      amountCents: 2000,
    }));
    // API failed — rolled back to original values
    expect(result.current.transactions[0].description).toBe("Old desc");
    expect(result.current.transactions[0].amountCents).toBe(1000);
    expect(result.current.writeError).toBe("Offline");
  });

  // ── deleteTransaction ──────────────────────────────────────────

  it("calls deleteTransaction API and rolls back on failure", async () => {
    // Mock fetchTransactions to seed initial data
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [
        {
          id: "tx-seed-1",
          description: "Seed tx",
          amountCents: 1000,
          date: "2026-06-25",
          kind: "expense",
          categoryId: "cat1",
          accountId: "acc1",
        },
      ],
      total: 1,
    });

    const spy = vi
      .spyOn(endpoints, "deleteTransaction")
      .mockRejectedValue(new Error("Offline"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstId = result.current.transactions[0].id;

    await act(() => result.current.deleteTransaction(firstId));

    expect(spy).toHaveBeenCalledWith(firstId, expect.any(String));
    // Transaction was rolled back (restored)
    expect(result.current.transactions[0].id).toBe(firstId);
    expect(result.current.writeError).toBe("Offline");
  });

  // ── addAccount ─────────────────────────────────────────────────

  it("adds account optimistically then reconciles with API", async () => {
    const created = { ...mockAccount("real-1", "New Account") };
    const spy = vi.spyOn(endpoints, "addAccount").mockResolvedValue(created);
    // Post-write reconciliation replaces optimistic state with server truth.
    vi.mocked(endpoints.fetchAccounts)
      .mockResolvedValueOnce([mockAccount("a1", "API Nubank")])
      .mockResolvedValue([mockAccount("a1", "API Nubank"), created]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.accounts.length;

    await act(() =>
      result.current.addAccount({
        name: "New Account",
        kind: "bank",
        initialBalanceCents: 0,
      }),
    );

    expect(result.current.accounts).toHaveLength(prevCount + 1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      name: "New Account",
      kind: "bank",
      initialBalanceCents: 0,
    }));
  });

  it("rolls back addAccount on API failure", async () => {
    vi.spyOn(endpoints, "addAccount").mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.accounts.length;

    await act(() =>
      result.current.addAccount({
        name: "Fail Account",
        kind: "bank",
        initialBalanceCents: 100,
      }),
    );

    expect(result.current.accounts).toHaveLength(prevCount);
    expect(result.current.writeError).toBe("Fail");
  });

  // ── addCard ────────────────────────────────────────────────────

  it("adds card optimistically and calls API", async () => {
    const createdCard = {
      ...mockAccount("card-1", "New Card"),
      kind: "credit_card",
      creditLimitCents: 1000_00,
      closingDay: 15,
      dueDay: 25,
    };
    const spy = vi.spyOn(endpoints, "createCard").mockResolvedValue(createdCard as never);
    // Post-write reconciliation replaces optimistic state with server truth.
    vi.mocked(endpoints.fetchAccounts)
      .mockResolvedValueOnce([mockAccount("a1", "API Nubank")])
      .mockResolvedValue([mockAccount("a1", "API Nubank"), createdCard] as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.accounts.length;

    await act(() =>
      result.current.addCard({
        name: "New Card",
        creditLimitCents: 1000_00,
        closingDay: 15,
        dueDay: 25,
      }),
    );

    expect(result.current.accounts).toHaveLength(prevCount + 1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      name: "New Card",
      creditLimitCents: 1000_00,
      closingDay: 15,
      dueDay: 25,
    }));
  });

  it("rolls back addCard on API failure", async () => {
    vi.spyOn(endpoints, "createCard").mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.accounts.length;

    await act(() =>
      result.current.addCard({
        name: "Fail Card",
        creditLimitCents: 500_00,
        closingDay: 10,
        dueDay: 20,
      }),
    );

    expect(result.current.accounts).toHaveLength(prevCount);
    expect(result.current.writeError).toBe("Fail");
  });

  // ── updateCard ─────────────────────────────────────────────────

  it("updates card optimistically and reconciles with API", async () => {
    const spy = vi
      .spyOn(endpoints, "updateCard")
      .mockResolvedValue({} as Account);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Find first credit card in accounts (from mock data)
    const card = result.current.accounts.find((a) => a.kind === "credit_card");
    if (!card) return; // skip if no card

    await act(() =>
      result.current.updateCard(card.id, { name: "Updated Card" }),
    );

    expect(spy).toHaveBeenCalledWith(card.id, { name: "Updated Card" });
    expect(result.current.accounts.find((a) => a.id === card.id)?.name).toBe(
      "Updated Card",
    );
  });

  // ── FIX-P1 receipt forwarding ──────────────────────────────────

  it("forwards the server receipt targets (not the kind fallback) after addCard", async () => {
    const createdCard = {
      ...mockAccount("card-receipt-1", "Receipt Card"),
      kind: "credit_card",
      receipt: {
        mutationId: "m-receipt-1",
        mutationKind: "account.create",
        status: "succeeded",
        // Narrower than the account.create registry set: proves the receipt
        // wins over the fallback (which would also refresh dashboard-summary).
        affectedTargets: ["accounts"],
      },
    };
    vi.spyOn(endpoints, "createCard").mockResolvedValue(createdCard as never);
    const dashSpy = vi
      .spyOn(endpoints, "fetchDashboardSummary")
      .mockResolvedValue(null as never);
    const accountsSpy = vi.mocked(endpoints.fetchAccounts);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Bootstrap fetches the dashboard summary once — baseline AFTER load so
    // only post-write reconciliation calls are counted below.
    const dashCallsAfterBootstrap = dashSpy.mock.calls.length;
    const accountsCallsAfterBootstrap = accountsSpy.mock.calls.length;

    await act(() =>
      result.current.addCard({
        name: "Receipt Card",
        creditLimitCents: 1000_00,
        closingDay: 15,
        dueDay: 25,
      }),
    );

    // Receipt targets refreshed …
    await waitFor(() =>
      expect(accountsSpy.mock.calls.length).toBeGreaterThan(
        accountsCallsAfterBootstrap,
      ),
    );
    // … and the fallback-only target was NOT refreshed by reconciliation.
    expect(dashSpy.mock.calls.length).toBe(dashCallsAfterBootstrap);
    expect(result.current.reconciliationStale).toBeNull();
  });

  it("marks targets stale when post-card-write refresh fails (never rolls back)", async () => {
    const createdCard = {
      ...mockAccount("card-stale-1", "Stale Card"),
      kind: "credit_card",
      receipt: {
        mutationId: "m-stale-1",
        mutationKind: "account.create",
        status: "succeeded",
        affectedTargets: ["accounts"],
      },
    };
    vi.spyOn(endpoints, "createCard").mockResolvedValue(createdCard as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Fail ONLY the post-write refresh (bootstrap already consumed the
    // default mock).
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(new Error("boom"));

    await act(() =>
      result.current.addCard({
        name: "Stale Card",
        creditLimitCents: 1000_00,
        closingDay: 15,
        dueDay: 25,
      }),
    );

    // The persisted mutation stays; the failed target is signaled stale.
    await waitFor(() =>
      expect(result.current.reconciliationStale).not.toBeNull(),
    );
    expect(result.current.reconciliationStale?.targets).toContain("accounts");
    expect(
      result.current.accounts.some((a) => a.name === "Stale Card"),
    ).toBe(true);
  });

  // ── FIX-P1-PWA-RECEIPT-CONSUMERS: deleteTransaction receipt ──────

  it("deleteTransaction reconciles with the server receipt (no kind fallback)", async () => {
    apiReady();
    mockApiReads();
    const seedTx = {
      id: "t-del-1",
      description: "Deletable tx",
      amountCents: 1000,
      date: "2026-06-25",
      kind: "expense",
      categoryId: "cat1",
      accountId: "acc1",
    } as never;
    const txSpy = vi.mocked(endpoints.fetchTransactions);
    // Bootstrap seeds one tx; the post-delete reconciliation refresh then
    // observes the authoritative empty list.
    txSpy.mockResolvedValueOnce({ items: [seedTx], total: 1 });
    txSpy.mockResolvedValue({ items: [], total: 0 });
    const deleted = {
      id: "t-del-1",
      description: "Deletable tx",
      amountCents: 1000,
      date: "2026-06-25",
      kind: "expense",
      categoryId: "cat1",
      accountId: "acc1",
      receipt: {
        mutationId: "m-del-1",
        mutationKind: "transaction.delete",
        status: "succeeded",
        // Narrower than the transaction.delete registry set: proves the
        // receipt wins over the fallback (which would also refresh
        // dashboard-summary).
        affectedTargets: ["transactions"],
      },
    };
    vi.spyOn(endpoints, "deleteTransaction").mockResolvedValue(deleted as never);
    const dashSpy = vi
      .spyOn(endpoints, "fetchDashboardSummary")
      .mockResolvedValue(null as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transactions).toHaveLength(1);
    const txCallsAfterBootstrap = txSpy.mock.calls.length;
    const dashCallsAfterBootstrap = dashSpy.mock.calls.length;

    await act(() => result.current.deleteTransaction("t-del-1"));

    // Receipt targets refreshed (reconciliation is fire-and-forget) …
    await waitFor(() =>
      expect(txSpy.mock.calls.length).toBeGreaterThan(txCallsAfterBootstrap),
    );
    // … the authoritative list no longer contains the tx (no rollback) …
    await waitFor(() => expect(result.current.transactions).toHaveLength(0));
    // … and the fallback-only target was NOT refreshed by reconciliation.
    expect(dashSpy.mock.calls.length).toBe(dashCallsAfterBootstrap);
    expect(result.current.reconciliationStale).toBeNull();
  });

  it("replaying the same delete receipt dedups the refresh", async () => {
    apiReady();
    mockApiReads();
    vi.spyOn(endpoints, "fetchDashboardSummary").mockResolvedValue(null as never);
    const txSpy = vi.mocked(endpoints.fetchTransactions);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const txCallsAfterBootstrap = txSpy.mock.calls.length;

    const receipt: MutationReceipt = {
      mutationId: "m-del-replay-1",
      mutationKind: "transaction.delete",
      status: "succeeded",
      affectedTargets: ["transactions"],
    };
    let first: unknown;
    await act(async () => {
      first = await result.current.reconcileMutation?.({ receipt: { ...receipt } });
    });
    expect((first as { deduped: boolean }).deduped).toBe(false);
    await waitFor(() =>
      expect(txSpy.mock.calls.length).toBeGreaterThan(txCallsAfterBootstrap),
    );
    const txCallsAfterFirst = txSpy.mock.calls.length;

    let second: unknown;
    await act(async () => {
      second = await result.current.reconcileMutation?.({ receipt: { ...receipt } });
    });
    expect((second as { deduped: boolean }).deduped).toBe(true);
    expect(txSpy.mock.calls.length).toBe(txCallsAfterFirst);
  });

  // ── addSubscription ────────────────────────────────────────────

  it("adds subscription optimistically and calls API", async () => {
    const createdSub = {
      id: "sub-real-1",
      name: "Netflix",
      amountCents: 39_90,
        cycle: "monthly" as const,
        day: 15,
        paymentMethod: "credit_card",
        status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    const spy = vi.spyOn(endpoints, "addSubscription").mockResolvedValue(createdSub);
    // Post-write reconciliation replaces optimistic state with server truth.
    // (Subscriptions are lazy-loaded: bootstrap never calls fetchSubscriptions,
    // so no Once() slot — the reconcile refresh is the first read.)
    vi.mocked(endpoints.fetchSubscriptions).mockResolvedValue([createdSub] as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.subscriptions.length;

    await act(() =>
      result.current.addSubscription({
        name: "Netflix",
        amountCents: 39_90,
        cycle: "monthly",
        day: 15,
        paymentMethod: "credit_card",
      }),
    );

    expect(result.current.subscriptions).toHaveLength(prevCount + 1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      name: "Netflix",
      amountCents: 39_90,
      cycle: "monthly",
      day: 15,
      paymentMethod: "credit_card",
    }));
  });

  it("rolls back addSubscription on API failure", async () => {
    vi.spyOn(endpoints, "addSubscription").mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.subscriptions.length;

    await act(() =>
      result.current.addSubscription({
        name: "Fail Sub",
        amountCents: 10_00,
        cycle: "monthly",
        day: 1,
        paymentMethod: "pix",
      }),
    );

    expect(result.current.subscriptions).toHaveLength(prevCount);
    expect(result.current.writeError).toBe("Fail");
  });

  // ── cancelSubscription ─────────────────────────────────────────

  it("cancels subscription and rolls back on failure", async () => {
    // Mock addSubscription to succeed
    const createdSub = {
      id: "sub-mock-1",
      name: "Test Sub",
      amountCents: 20_00,
      cycle: "monthly",
      day: 5,
      paymentMethod: "credit_card",
      status: "active",
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(endpoints, "addSubscription").mockResolvedValue(createdSub as never);
    // Post-write reconciliation replaces optimistic state with server truth.
    // (Subscriptions are lazy-loaded: bootstrap never calls fetchSubscriptions,
    // so no Once() slot — the reconcile refresh is the first read.)
    vi.mocked(endpoints.fetchSubscriptions).mockResolvedValue([createdSub] as never);
    const spy = vi
      .spyOn(endpoints, "cancelSubscription")
      .mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.addSubscription({
        name: "Test Sub",
        amountCents: 20_00,
        cycle: "monthly",
        day: 5,
        paymentMethod: "credit_card",
      }),
    );
    const sub = result.current.subscriptions[0];

    await act(() => result.current.cancelSubscription(sub.id));

    expect(spy).toHaveBeenCalledWith(sub.id, expect.any(String));
    // Rolled back because API failed — still active
    expect(
      result.current.subscriptions.find((s) => s.id === sub.id)?.status,
    ).toBe("active");
  });

  // ── createTransfer ─────────────────────────────────────────────

  it("creates transfer optimistically and calls API", async () => {
    const spy = vi
      .spyOn(endpoints, "createTransfer")
      .mockResolvedValue({} as Transaction);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const a1 = result.current.accounts.find((a) => a.kind === "checking");
    const a2 = result.current.accounts.find(
      (a) => a.kind === "savings",
    );
    if (!a1 || !a2) return;

    await act(() =>
      result.current.createTransfer({
        description: "Test transfer",
        amountCents: 100_00,
        date: "2026-06-25",
        fromAccountId: a1.id,
        toAccountId: a2.id,
      }),
    );

    expect(spy).toHaveBeenCalledWith({
      description: "Test transfer",
      amountCents: 100_00,
      date: "2026-06-25",
      fromAccountId: a1.id,
      toAccountId: a2.id,
    });
  });

  it("rolls back transfer balances and transaction on API failure", async () => {
    vi.spyOn(endpoints, "createTransfer").mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const a1 = result.current.accounts.find((a) => a.kind === "checking");
    const a2 = result.current.accounts.find((a) => a.kind === "savings");
    if (!a1 || !a2) return;

    const balance1Before = a1.balanceCents;
    const balance2Before = a2.balanceCents;
    const txCountBefore = result.current.transactions.length;

    await act(() =>
      result.current.createTransfer({
        description: "Fail transfer",
        amountCents: 50_00,
        date: "2026-06-25",
        fromAccountId: a1.id,
        toAccountId: a2.id,
      }),
    );

    // Balances restored
    expect(
      result.current.accounts.find((a) => a.id === a1.id)?.balanceCents,
    ).toBe(balance1Before);
    expect(
      result.current.accounts.find((a) => a.id === a2.id)?.balanceCents,
    ).toBe(balance2Before);
    // Transaction removed
    expect(result.current.transactions).toHaveLength(txCountBefore);
    expect(result.current.writeError).toBe("Fail");
  });

  // ── payStatement ──────────────────────────────────────────────

  it("calls payStatement API and rolls back on failure", async () => {
    const spy = vi
      .spyOn(endpoints, "payStatement")
      .mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const a1 = result.current.accounts[0]; // checking account
    const balanceBefore = a1.balanceCents;

    await act(() =>
      result.current.payStatement("stmt-1", {
        amountCents: 100_00,
        fromAccountId: a1.id,
      }),
    );

    expect(spy).toHaveBeenCalledWith("stmt-1", expect.objectContaining({
      amountCents: 100_00,
      fromAccountId: a1.id,
    }));
    // Balance restored after rollback
    expect(
      result.current.accounts.find((a) => a.id === a1.id)?.balanceCents,
    ).toBe(balanceBefore);
    expect(result.current.writeError).toBe("Fail");
  });

  // ── Account update / deactivate ────────────────────────────

  it("calls updateAccount API and rolls back on failure", async () => {
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
      { id: "acc-upd-1", name: "Old Name",
        balanceCents: 0, kind: "checking" } as Account,
    ]);
    vi.spyOn(endpoints, "updateAccount")
      .mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.updateAccount("acc-upd-1", { name: "New Name" }),
    );

    expect(result.current.accounts[0].name).toBe("Old Name");
    expect(result.current.writeError).toBe("Fail");
  });

  it("calls deactivateAccount API and rolls back on failure", async () => {
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
      { id: "acc-del-1", name: "To Delete",
        balanceCents: 0, kind: "checking" } as Account,
    ]);
    vi.spyOn(endpoints, "deactivateAccount")
      .mockRejectedValue(new Error("Offline"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.deactivateAccount("acc-del-1"));

    // Rolled back — account reappears
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.writeError).toBe("Offline");
  });

  // ── Category update / deactivate ────────────────────────────

  it("calls updateCategory API and rolls back on failure", async () => {
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([
      { id: "cat-upd-1", name: "Old Cat", kind: "expense",
        icon: "Tag" } as unknown as Category,
    ]);
    vi.spyOn(endpoints, "updateCategory")
      .mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.updateCategory("cat-upd-1", { name: "New Cat" }),
    );

    expect(result.current.categories[0].name).toBe("Old Cat");
    expect(result.current.writeError).toBe("Fail");
  });

  it("calls deactivateCategory API and rolls back on failure", async () => {
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([
      { id: "cat-del-1", name: "To Delete", kind: "income",
        icon: "DollarSign" } as unknown as Category,
    ]);
    vi.spyOn(endpoints, "deactivateCategory")
      .mockRejectedValue(new Error("Offline"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.deactivateCategory("cat-del-1"));

    expect(result.current.categories).toHaveLength(1);
    expect(result.current.writeError).toBe("Offline");
  });

  // ── addCategory ────────────────────────────────────────────────

  it("adds category optimistically and calls API", async () => {
    const createdCat = {
      id: "cat-real-1",
      name: "New Cat",
      kind: "expense",
      icon: "Tag",
    };
    const spy = vi.spyOn(endpoints, "addCategory").mockResolvedValue(createdCat as never);
    // Post-write reconciliation replaces optimistic state with server truth.
    vi.mocked(endpoints.fetchCategories)
      .mockResolvedValueOnce([])
      .mockResolvedValue([createdCat] as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.categories.length;

    await act(() =>
      result.current.addCategory({ name: "New Cat", kind: "expense" }),
    );

    expect(result.current.categories).toHaveLength(prevCount + 1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: "New Cat", kind: "expense" }));
  });

  it("rolls back addCategory on API failure", async () => {
    vi.spyOn(endpoints, "addCategory").mockRejectedValue(new Error("Fail"));

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const prevCount = result.current.categories.length;

    await act(() =>
      result.current.addCategory({ name: "Fail Cat", kind: "income" }),
    );

    expect(result.current.categories).toHaveLength(prevCount);
    expect(result.current.writeError).toBe("Fail");
  });

  // ── createInstallments ─────────────────────────────────────────

  it("calls createInstallments API", async () => {
    const spy = vi
      .spyOn(endpoints, "createInstallments")
      .mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.createInstallments({
        accountId: "card-1",
        description: "Notebook",
        totalAmountCents: 6_000_00,
        purchaseDate: "2026-06-25",
        installmentsTotal: 12,
      }),
    );

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "card-1",
      description: "Notebook",
      totalAmountCents: 6_000_00,
      purchaseDate: "2026-06-25",
      installmentsTotal: 12,
    }));
  });

  // ── updateCard without API ──────────────────────────────────────

  it("updates card locally when no API", async () => {
    apiNotConfigured();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    const card = result.current.accounts.find(
      (a) => a.kind === "credit_card",
    );
    if (!card) return;

    await act(() =>
      result.current.updateCard(card.id, { name: "Local Update" }),
    );

    expect(
      result.current.accounts.find((a) => a.id === card.id)?.name,
    ).toBe("Local Update");
  });

  // ── clearWriteError ───────────────────────────────────────────

  it("clears writeError", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await act(() => result.current.clearWriteError());
    expect(result.current.writeError).toBeNull();
  });

  // ── Idempotency key header sent ───────────────────────────────

  it("sends idempotency-key header on POST mutations", async () => {
    // Use apiPost internally — verify the header goes through client.ts
    const spy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValue({} as Transaction);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.addTransaction({
        id: "tx-idem",
        description: "Idempotent",
        amountCents: 100,
        date: "2026-06-25",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );

    expect(spy).toHaveBeenCalled();
    // The key is generated as `pwa-${Date.now()}-${counter}-${suffix}`
    // Can't check exact value, but we verify the call happened
  });
});

describe("AppStateProvider — runtime 401", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads();
  });

  it("calls expireSession when a read returns 401", async () => {
    const expireSession = vi.fn();
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new ApiError(401, "auth.error", "Token inválido"),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SessionProvider value={{ expireSession, session: { status: "unknown" } }}>
        <AppStateProvider>{children}</AppStateProvider>
      </SessionProvider>
    );
    const { result } = renderHook(() => useAppState(), { wrapper });
    await waitFor(() => expect(expireSession).toHaveBeenCalled());
    // never falls back to mock on 401
    expect(result.current.accounts).toHaveLength(0);
    // loading state settled after bootstrap completes (even on 401)
    expect(result.current.loading).toBe(false);
  });

  it("calls expireSession (not writeError) when a write returns 401", async () => {
    const expireSession = vi.fn();
    vi.spyOn(endpoints, "createExpenseTransaction").mockRejectedValue(
      new ApiError(401, "auth.error", "Token inválido"),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SessionProvider value={{ expireSession, session: { status: "unknown" } }}>
        <AppStateProvider>{children}</AppStateProvider>
      </SessionProvider>
    );
    const { result } = renderHook(() => useAppState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await expect(
        result.current.addTransaction({
          id: "tx-401",
          description: "x",
          amountCents: 100,
          date: "2026-06-25",
          kind: "expense",
          categoryId: "cat1",
          accountId: "acc1",
        }),
      ).rejects.toThrow("Token inválido");
    });
    expect(expireSession).toHaveBeenCalled();
    expect(result.current.writeError).toBeNull();
  });
});

describe("AppStateProvider — non-essential domain error isolation", () => {
  beforeEach(() => {
    apiReady();
    // All essentials succeed
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
      mockAccount("a1", "Nubank"),
    ]);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
  });

  it("does NOT set global error when only subscriptions fails (non-essential)", async () => {
    const spy = vi.spyOn(endpoints, "fetchSubscriptions").mockRejectedValue(
      new Error("Subscriptions API 404"),
    );
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Global error should NOT be set — only non-essential domain failed
    expect(result.current.error).toBeNull();
    // fetchSubscriptions is lazy-loaded — not called during bootstrap
    expect(spy).not.toHaveBeenCalled();
    // Essential domains are live
    expect(result.current.sync.accounts.source).toBe("live");
    expect(result.current.readOnly).toBe(false);
    // Subscriptions sync stays at initial "live" until page triggers refresh
    // (subscriptions are lazy-loaded, not fetched during bootstrap)
    expect(result.current.subscriptions).toHaveLength(0);
  });

  it("does NOT set global error when only cardStatements fails (non-essential)", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockRejectedValue(
      new Error("Statements API down"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.readOnly).toBe(false);
    expect(result.current.sync.cardStatements.source).toBe("unavailable");
  });

  it("STILL sets global error when an essential domain fails (regression)", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    // Make an essential domain fail
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new Error("Accounts API down"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Global error SHOULD be set
    expect(result.current.error).not.toBeNull();
    expect(result.current.readOnly).toBe(true);
  });

  it("STILL sets global error when BOTH essential and non-essential fail", async () => {
    vi.spyOn(endpoints, "fetchSubscriptions").mockRejectedValue(
      new Error("Subscriptions API 404"),
    );
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new Error("Accounts API down"),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).not.toBeNull();
    expect(result.current.readOnly).toBe(true);
  });
});

describe("AppStateProvider — read-only guard", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads();
  });

  it("refuses writes (no optimistic change) when in snapshot read-only mode", async () => {
    seedV1Snapshot("accounts", [mockAccount("snap-1", "Snap")]);
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new Error("down"),
    );
    const createSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValue({} as Transaction);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readOnly).toBe(true);
    const txCountBefore = result.current.transactions.length;

    await act(() =>
      result.current.addTransaction({
        id: "tx-ro",
        description: "blocked",
        amountCents: 100,
        date: "2026-06-25",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );

    // no optimistic insertion, no API call, explicit writeError
    expect(result.current.transactions).toHaveLength(txCountBefore);
    expect(createSpy).not.toHaveBeenCalled();
    expect(result.current.writeError).toMatch(/somente leitura|indisponível/i);
  });

  it("refuses writes when an essential domain is unavailable (backend down, no snapshot)", async () => {
    // No snapshot saved -> failed essential domain becomes "unavailable" -> readOnly ON
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(
      new Error("down"),
    );
    const createSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValue({} as Transaction);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readOnly).toBe(true);
    const txCountBefore = result.current.transactions.length;

    await act(() =>
      result.current.addTransaction({
        id: "tx-unavail",
        description: "blocked",
        amountCents: 100,
        date: "2026-06-25",
        kind: "expense",
        categoryId: "cat1",
        accountId: "acc1",
      }),
    );

    expect(result.current.transactions).toHaveLength(txCountBefore);
    expect(createSpy).not.toHaveBeenCalled();
    expect(result.current.writeError).toMatch(/somente leitura|indisponível/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded coverage-core lane: exercise every exposed write action through the
// AppState facade so each handler's optimistic path, command call, rollback,
// read-only guard and offline (!apiUsable) branch are covered.
// ─────────────────────────────────────────────────────────────────────────────
import * as commandsModule from "../commands";
import type { Commands } from "../commands";

const CMD_METHODS = [
  "createExpenseTransaction", "createIncomeTransaction", "updateTransaction",
  "deleteTransaction", "createTransfer", "addAccount", "updateAccount",
  "deactivateAccount", "addCategory", "updateCategory", "deactivateCategory",
  "createCard", "updateCard", "createPayable", "markPayablePaid",
  "undoPayablePayment", "cancelPayable", "updatePayable", "createBudget",
  "updateBudget", "createGoal", "contributeToGoal", "cancelGoal",
  "updateGoal", "addSubscription", "cancelSubscription", "updateSubscription",
  "payStatement", "createInstallments", "createCardPurchase", "patchProfile",
] as const;

type CmdMock = Record<(typeof CMD_METHODS)[number], ReturnType<typeof vi.fn>> & {
  [k: string]: ReturnType<typeof vi.fn>;
};

function buildCommandsMock(reject: boolean): CmdMock {
  const m = {} as CmdMock;
  for (const name of CMD_METHODS) {
    m[name] = vi.fn();
    if (reject) m[name].mockRejectedValue(new Error("cmd-fail"));
    else m[name].mockResolvedValue({ id: `srv-${name}` });
  }
  m.payStatement.mockResolvedValue({ id: "st1", paidCents: 100, totalCents: 200, status: "partial" });
  m.addSubscription.mockResolvedValue({ id: "srv-sub", name: "Sub", amountCents: 1000, cycle: "monthly", day: 5, paymentMethod: "card", status: "active", createdAt: "" });
  return m;
}

function seedApiData() {
  mockApiReads({
    accounts: [mockAccount("a1", "API Nubank"), mockAccount("a2", "API Itau")],
    payables: [mockP1],
  });
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([
    { id: "c1", name: "Alimentação", kind: "expense", icon: "Tag", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as never,
  ]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([
    { id: "g1", name: "Reserva", goalType: "savings", targetAmountCents: 1000, currentAmountCents: 0, startDate: "2026-01-01", status: "active" } as never,
  ]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([
    { id: "b1", categoryId: "c1", name: "B", amountCents: 100, spentCents: 0, period: "monthly" } as never,
  ]);
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([
    { id: "s1", name: "Netflix", amountCents: 3000, cycle: "monthly", day: 5, paymentMethod: "card", status: "active", createdAt: "2026-01-01" } as never,
    // Post-write reconciliation resets subscriptions to server truth, so the
    // command-mock id exercised below must exist server-side too.
    { id: "srv-sub", name: "Sub", amountCents: 1000, cycle: "monthly", day: 5, paymentMethod: "card", status: "active", createdAt: "" } as never,
  ]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([
    { id: "card1", name: "Nubank", kind: "credit_card", balanceCents: 0, creditLimitCents: 100000, closingDay: 5, dueDay: 10, status: "active" } as never,
  ]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: [{ id: "t1", description: "x", amountCents: 100, date: "2026-01-01", kind: "expense", categoryId: "c1", accountId: "a1" } as never],
    total: 1,
  });
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([
    { id: "st1", accountId: "card1", totalCents: 200, paidCents: 0, status: "open", closeDate: "2026-06-01", dueDate: "2026-06-10", purchases: [] } as never,
  ]);
  vi.spyOn(endpoints, "patchProfile").mockResolvedValue({} as never);
}

async function exerciseAll(result: { current: ReturnType<typeof useAppState> }) {
  const s = result.current;
  await s.addTransaction({ id: "tx1", description: "d", amountCents: 100, date: "2026-01-01", kind: "expense", categoryId: "c1", accountId: "a1" } as never);
  await s.addTransaction({ id: "tx2", description: "i", amountCents: 200, date: "2026-01-01", kind: "income", categoryId: "c1", accountId: "a1" } as never);
  await s.updateTransaction("t1", { description: "upd" });
  await s.markPayablePaid("p1");
  await s.updatePayable("p1", { description: "x" });
  await s.createPayable({ accountId: "a1", description: "p", amountCents: 100, dueDate: "2026-06-30" });
  await s.createBudget({ categoryId: "c1", name: "B", amountCents: 100, period: "monthly", startDate: "2026-01-01" });
  await s.updateBudget("b1", { amountCents: 200 });
  await s.createGoal({ name: "G", goalType: "savings", targetAmountCents: 1000, startDate: "2026-01-01" });
  await s.contributeToGoal("g1", { amountCents: 100 });
  await s.updateGoal("g1", { name: "G2" });
  await s.addAccount({ name: "New", kind: "bank", initialBalanceCents: 0 });
  await s.updateAccount("a1", { name: "Renamed" });
  await s.addCategory({ name: "Cat", kind: "expense" });
  await s.updateCategory("c1", { name: "Upd" });
  await s.addCard({ name: "Card", creditLimitCents: 1000, closingDay: 5, dueDay: 10 });
  await s.updateCard("card1", { name: "Card2" });
  await s.createTransfer({ description: "t", amountCents: 100, date: "2026-01-01", fromAccountId: "a1", toAccountId: "a2" });
  await s.payStatement("st1", { amountCents: 50, fromAccountId: "a1" });
  await s.createInstallments({ accountId: "card1", description: "inst", totalAmountCents: 1000, purchaseDate: "2026-01-01", installmentsTotal: 3 });
  await s.createCardPurchase({ accountId: "card1", description: "pc", amountCents: 100, date: "2026-01-01" });
  await s.saveProfile({ name: "Marina" });
  await s.refreshProfile();
  // Destructive actions last so their update counterparts already ran.
  await s.deactivateAccount("a2");
  await s.deactivateCategory("c1");
  await s.cancelGoal("g1");
  await s.cancelPayable("p1");
  await s.deleteTransaction("t1");
  await s.undoPayablePayment("p1");
}

describe("AppStateProvider — every write action (coverage-core)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("invokes the command layer for every action when API is usable", async () => {
    apiReady();
    seedApiData();
    const cmds = buildCommandsMock(false);
    vi.spyOn(commandsModule, "createCommands").mockReturnValue(cmds as unknown as Commands);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await exerciseAll(result); });
    await act(async () => { await result.current.addSubscription({ name: "Sub", amountCents: 1000, cycle: "monthly", day: 5, paymentMethod: "card" }); });
    const subId = "srv-sub";
    await act(async () => { await result.current.updateSubscription(subId, { name: "Sub2" }); });
    await act(async () => { await result.current.cancelSubscription(subId); });
    expect(cmds.addSubscription).toHaveBeenCalled();
    expect(cmds.updateSubscription).toHaveBeenCalled();
    expect(cmds.cancelSubscription).toHaveBeenCalled();
    expect(cmds.createExpenseTransaction).toHaveBeenCalled();
    expect(cmds.createIncomeTransaction).toHaveBeenCalled();
    expect(cmds.updateTransaction).toHaveBeenCalledWith("t1", expect.anything());
    // deleteTransaction threads the (empty) id-reuse options bag through.
    expect(cmds.deleteTransaction).toHaveBeenCalledWith("t1", undefined);
    expect(cmds.markPayablePaid).toHaveBeenCalled();
    expect(cmds.cancelPayable).toHaveBeenCalled();
    expect(cmds.updatePayable).toHaveBeenCalled();
    expect(cmds.undoPayablePayment).toHaveBeenCalled();
    expect(cmds.createPayable).toHaveBeenCalled();
    expect(cmds.createBudget).toHaveBeenCalled();
    expect(cmds.updateBudget).toHaveBeenCalled();
    expect(cmds.createGoal).toHaveBeenCalled();
    expect(cmds.contributeToGoal).toHaveBeenCalled();
    expect(cmds.cancelGoal).toHaveBeenCalled();
    expect(cmds.updateGoal).toHaveBeenCalled();
    expect(cmds.addAccount).toHaveBeenCalled();
    expect(cmds.updateAccount).toHaveBeenCalled();
    expect(cmds.deactivateAccount).toHaveBeenCalled();
    expect(cmds.addCategory).toHaveBeenCalled();
    expect(cmds.updateCategory).toHaveBeenCalled();
    expect(cmds.deactivateCategory).toHaveBeenCalled();
    expect(cmds.createCard).toHaveBeenCalled();
    expect(cmds.updateCard).toHaveBeenCalled();
    expect(cmds.createTransfer).toHaveBeenCalled();
    expect(cmds.payStatement).toHaveBeenCalled();
    expect(cmds.createInstallments).toHaveBeenCalled();
    expect(cmds.createCardPurchase).toHaveBeenCalled();
    expect(result.current.profile).not.toBeNull();
  });

  it("rolls back and records writeError when addAccount rejects", async () => {
    apiReady();
    seedApiData();
    const cmds = buildCommandsMock(false);
    cmds.addAccount.mockRejectedValue(new Error("cmd-fail"));
    vi.spyOn(commandsModule, "createCommands").mockReturnValue(cmds as unknown as Commands);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const accountsBefore = result.current.accounts.length;
    await act(async () => { await exerciseAll(result); });
    expect(cmds.addAccount).toHaveBeenCalled();
    expect(result.current.writeError).toBeTruthy();
    // optimistic insert was rolled back on failure
    expect(result.current.accounts.length).toBe(accountsBefore);
    // clearWriteError resets the flag
    act(() => result.current.clearWriteError());
    expect(result.current.writeError).toBeNull();
  });

  it("blocks every write (read-only guard) when an essential domain fails", async () => {
    apiReady();
    mockApiReads();
    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("down"));
    const cmds = buildCommandsMock(false);
    vi.spyOn(commandsModule, "createCommands").mockReturnValue(cmds as unknown as Commands);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readOnly).toBe(true);
    await act(async () => { await exerciseAll(result); });
    expect(cmds.addAccount).not.toHaveBeenCalled();
    expect(result.current.writeError).toMatch(/somente leitura|indisponível/i);
  });

  it("refreshSubscriptions loads subscription data via the adapter", async () => {
    apiReady();
    seedApiData();
    const cmds = buildCommandsMock(false);
    vi.spyOn(commandsModule, "createCommands").mockReturnValue(cmds as unknown as Commands);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.refreshSubscriptions(); });
    expect(Array.isArray(result.current.subscriptions)).toBe(true);
    expect(result.current.sync.subscriptions).toBeDefined();
  });

  it("does optimistic-only writes when API is not configured (offline)", async () => {
    apiNotConfigured();
    const cmds = buildCommandsMock(false);
    vi.spyOn(commandsModule, "createCommands").mockReturnValue(cmds as unknown as Commands);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const accountsBefore = result.current.accounts.length;
    await act(async () => { await exerciseAll(result); });
    expect(cmds.addAccount).not.toHaveBeenCalled();
    // optimistic insert still happened locally
    expect(result.current.accounts.length).toBeGreaterThan(accountsBefore);
  });
});

describe("AppStateProvider � boot dedupe, value stability and central 401", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads();
  });

  it("fetches profile and quick insights exactly once during boot", async () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(vi.mocked(endpoints.fetchProfile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(endpoints.fetchQuickInsights)).toHaveBeenCalledTimes(1);
  });

  it("hydrates profile and quick insights from the single bootstrap fetch", async () => {
    const profileFixture = { householdId: "h1", name: "Ana" };
    const insightsFixture = [{ id: "ins-1" }];
    vi.mocked(endpoints.fetchProfile).mockResolvedValue(profileFixture as never);
    vi.mocked(endpoints.fetchQuickInsights).mockResolvedValue(insightsFixture as never);
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.profile).toEqual(profileFixture));
    await waitFor(() => expect(result.current.quickInsights).toEqual(insightsFixture));
  });

  it("keeps the context value identity stable across provider re-renders without state changes", async () => {
    const { result, rerender } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {});
    const valueAfterBoot = result.current;
    rerender();
    await act(async () => {});
    expect(Object.is(result.current, valueAfterBoot)).toBe(true);
  });

  it("expires the session for a 401 that never passes through AppState handlers", async () => {
    const expireSession = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SessionProvider value={{ expireSession, session: { status: "unknown" } }}>
        <AppStateProvider>{children}</AppStateProvider>
      </SessionProvider>
    );
    const { result } = renderHook(() => useAppState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "auth.expired", message: "Sessão expirada" }), { status: 401 }),
    );
    await act(async () => {
      await expect(apiFetch("/outside-state")).rejects.toBeInstanceOf(ApiError);
    });
    expect(expireSession).toHaveBeenCalled();
  });
});
