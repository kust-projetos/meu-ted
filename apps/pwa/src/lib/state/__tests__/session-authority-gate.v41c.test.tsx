import "fake-indexeddb/auto";
import { renderHook, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { setActiveWorkspaceId } from "@/lib/api/client";
import type { Account } from "@/lib/state/types";

/**
 * V41C-FIX-PWA-P1 FIX 1 (P1, INV-02/AUTH-01) — RED.
 *
 * `apiUsable()` (online gate in app-state-context.tsx) must allow live
 * bootstrap/API ONLY for a server-confirmed `authenticated` session. A
 * legacy bearer in storage must never unlock live I/O by itself:
 * `unknown` (pre-probe) waits for probe resolution, `unreachable` routes
 * exclusively through the V3 offline path, `unauthenticated` stays closed.
 * Compat ON keeps working for the normal legacy boot (bearer + probe
 * succeeds → `authenticated`).
 */

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

function mockApiReads() {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
    mockAccount("a1", "API Nubank"),
  ]);
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
  // FIX-168: the online gate additionally requires an active workspace —
  // established for every test so each case isolates exactly the session
  // authority it asserts (absent authority still blocks with header set).
  setActiveWorkspaceId("test-workspace-1");
});

afterEach(() => {
  resetSessionStatus();
  vi.unstubAllEnvs();
});

describe("AppStateProvider — online gate is session-authority only (V41C FIX 1)", () => {
  it("bearer present + probe unreachable → NO live bootstrap (V3 offline path owns this state)", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-stale-abc");
    localStorage.setItem("pi-finance:token", "dev-stale-abc");
    setSessionStatus({ status: "unreachable" });
    mockApiReads();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts).toHaveLength(0);
  });

  it("bearer present + probe unknown (pre-probe boot) → NO live bootstrap", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-stale-abc");
    localStorage.setItem("pi-finance:token", "dev-stale-abc");
    // authority left at the pre-probe default: { status: "unknown" }
    mockApiReads();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    expect(result.current.loading).toBe(false);
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts).toHaveLength(0);
  });

  it("bearer present + probe unauthenticated → NO live bootstrap", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-stale-abc");
    setSessionStatus({ status: "unauthenticated" });
    mockApiReads();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    expect(result.current.loading).toBe(false);
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts).toHaveLength(0);
  });

  it("compat ON legacy boot preserved: bearer present + probe authenticated → bootstrap runs", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-valid-abc");
    localStorage.setItem("pi-finance:token", "dev-valid-abc");
    setSessionStatus({
      status: "authenticated",
      user: { userId: "u1", email: "walis@example.com" },
    });
    mockApiReads();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(endpoints.fetchAccounts).toHaveBeenCalled();
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.sync.accounts.source).toBe("live");
  });

  it("cookie-only boot preserved: zero bearers + probe authenticated → bootstrap runs", async () => {
    localStorage.removeItem("pi-finance:token");
    localStorage.removeItem("pi-finance:session-token");
    setSessionStatus({
      status: "authenticated",
      user: { userId: "u1", email: "walis@example.com" },
    });
    mockApiReads();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(endpoints.fetchAccounts).toHaveBeenCalled();
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.sync.accounts.source).toBe("live");
  });
});
