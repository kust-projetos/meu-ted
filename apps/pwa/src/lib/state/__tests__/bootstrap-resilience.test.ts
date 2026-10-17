import { describe, expect, it, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { runBootstrap } from "../sync-engine";
import { type AppStateAction } from "../state-reducer";
import { ApiError } from "@/lib/api/client";
import { clearActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api/client";
import * as endpoints from "@/lib/api/endpoints";

vi.mock("@/lib/api/endpoints", () => ({
  fetchAccounts: vi.fn(),
  fetchCategories: vi.fn(),
  fetchTransactions: vi.fn(),
  fetchPayables: vi.fn(),
  fetchBudgets: vi.fn(),
  fetchGoals: vi.fn(),
  fetchStatements: vi.fn(),
  fetchCards: vi.fn(),
  fetchProfile: vi.fn(),
  fetchQuickInsights: vi.fn(),
}));

describe("Bootstrap resilience and finite state transitions", () => {
  beforeEach(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    vi.clearAllMocks();
    // O engine exige workspace ativo (FIX-168 zero-I/O): boot com workspace.
    clearActiveWorkspaceId();
    setActiveWorkspaceId("ws-test-1");
  });

  it("short-circuits on 401, calls expireSession and dispatches BOOTSTRAP_401 to exit loading", async () => {
    const actions: AppStateAction[] = [];
    const dispatch = (action: AppStateAction) => actions.push(action);
    const expireSession = vi.fn();

    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(new ApiError(401, "auth.invalid_token", "Invalid token"));
    vi.mocked(endpoints.fetchCategories).mockResolvedValue([]);
    vi.mocked(endpoints.fetchTransactions).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(endpoints.fetchPayables).mockResolvedValue([]);
    vi.mocked(endpoints.fetchBudgets).mockResolvedValue([]);
    vi.mocked(endpoints.fetchGoals).mockResolvedValue([]);
    vi.mocked(endpoints.fetchStatements).mockResolvedValue([]);
    vi.mocked(endpoints.fetchCards).mockResolvedValue([]);
    vi.mocked(endpoints.fetchProfile).mockResolvedValue(null as never);
    vi.mocked(endpoints.fetchQuickInsights).mockResolvedValue([]);

    await runBootstrap("token-123", dispatch, expireSession);

    expect(expireSession).toHaveBeenCalled();
    expect(actions).toEqual([
      { type: "BOOTSTRAP_START" },
      { type: "BOOTSTRAP_401" },
    ]);
  });

  it("completes bootstrap with BOOTSTRAP_COMPLETE even when endpoints time out (408) with snapshot preload fallback", async () => {
    const actions: AppStateAction[] = [];
    const dispatch = (action: AppStateAction) => actions.push(action);
    const expireSession = vi.fn();

    // Accounts times out with 408
    vi.mocked(endpoints.fetchAccounts).mockRejectedValue(new ApiError(408, "network.timeout", "Tempo limite de conexão excedido."));
    vi.mocked(endpoints.fetchCategories).mockResolvedValue([]);
    vi.mocked(endpoints.fetchTransactions).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(endpoints.fetchPayables).mockResolvedValue([]);
    vi.mocked(endpoints.fetchBudgets).mockResolvedValue([]);
    vi.mocked(endpoints.fetchGoals).mockResolvedValue([]);
    vi.mocked(endpoints.fetchStatements).mockResolvedValue([]);
    vi.mocked(endpoints.fetchCards).mockResolvedValue([]);
    vi.mocked(endpoints.fetchProfile).mockResolvedValue(null as never);
    vi.mocked(endpoints.fetchQuickInsights).mockResolvedValue([]);

    const preloadedAccounts = [{ id: "acc-preloaded", name: "Preloaded Bank", kind: "bank" as const, balanceCents: 500, status: "active" }];

    await runBootstrap("token-123", dispatch, expireSession, {
      accounts: { data: preloadedAccounts, syncedAt: "2026-08-29T10:00:00.000Z" },
    });

    expect(expireSession).not.toHaveBeenCalled();
    expect(actions.some((a) => a.type === "BOOTSTRAP_START")).toBe(true);
    expect(actions.some((a) => a.type === "DOMAIN_SNAPSHOT" && a.domain === "accounts")).toBe(true);
    expect(actions.some((a) => a.type === "SET_ERROR")).toBe(true);
    expect(actions.some((a) => a.type === "BOOTSTRAP_COMPLETE")).toBe(true);
  });

  it("completes bootstrap with BOOTSTRAP_COMPLETE even when snapshot writes fail", async () => {
    const actions: AppStateAction[] = [];
    const dispatch = (action: AppStateAction) => actions.push(action);
    const expireSession = vi.fn();

    vi.mocked(endpoints.fetchAccounts).mockResolvedValue([{ id: "acc-1", name: "Checking", kind: "bank" as const, balanceCents: 100, status: "active" }]);
    vi.mocked(endpoints.fetchCategories).mockResolvedValue([]);
    vi.mocked(endpoints.fetchTransactions).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(endpoints.fetchPayables).mockResolvedValue([]);
    vi.mocked(endpoints.fetchBudgets).mockResolvedValue([]);
    vi.mocked(endpoints.fetchGoals).mockResolvedValue([]);
    vi.mocked(endpoints.fetchStatements).mockResolvedValue([]);
    vi.mocked(endpoints.fetchCards).mockResolvedValue([]);
    vi.mocked(endpoints.fetchProfile).mockResolvedValue(null as never);
    vi.mocked(endpoints.fetchQuickInsights).mockResolvedValue([]);

    await runBootstrap("token-123", dispatch, expireSession);

    const hasStart = actions.some((a) => a.type === "BOOTSTRAP_START");
    const hasComplete = actions.some((a) => a.type === "BOOTSTRAP_COMPLETE");
    expect(hasStart).toBe(true);
    expect(hasComplete).toBe(true);
  });
});
