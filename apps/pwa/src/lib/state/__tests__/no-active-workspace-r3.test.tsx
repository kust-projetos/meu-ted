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

const snapshotDb = vi.hoisted(() => ({
  getOfflineSnapshotLockState: vi.fn(),
}));
vi.mock("@/lib/state/snapshot-db", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("@/lib/state/snapshot-db")>();
  return { ...mod, getOfflineSnapshotLockState: snapshotDb.getOfflineSnapshotLockState };
});

/**
 * FIX-168-R3 (P2 SECREVIEW-168-R2):
 * 1. Bootstrap: o gate inicial precede os awaits (migrate/preload/lock);
 *    arquivar durante o preload => runBootstrap dispara requests sem
 *    workspace. Revalidar cancelamento + hasActiveWorkspace imediatamente
 *    antes de runBootstrap; archive durante o preload => zero requests.
 * 2. refreshProfile: mesma disciplina da API (gate canReadFinancial +
 *    descarte tardio); profile sem workspace => zero I/O.
 *
 * RED primeiro: estes testes falham sem o fix.
 */
function mockAllReads() {
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

describe("FIX-168-R3: preload race + refreshProfile sem workspace", () => {
  it("archive durante o preload => runBootstrap emite zero requests", async () => {
    mockAllReads();
    // Trava o preload no lock-report: o bootstrap fica suspenso no await.
    let resolveLock!: (v: { state: "ok" }) => void;
    const lockGate = new Promise<{ state: "ok" }>((resolve) => {
      resolveLock = resolve;
    });
    snapshotDb.getOfflineSnapshotLockState.mockReturnValue(lockGate as never);
    setActiveWorkspaceId("ws-1");

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    // Preload em voo (lock pendente): nenhum fetch financeiro ainda.
    await waitFor(() =>
      expect(snapshotDb.getOfflineSnapshotLockState).toHaveBeenCalled(),
    );
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();

    // Archive durante o preload: workspace some antes de runBootstrap.
    clearActiveWorkspaceId();
    await act(async () => {
      resolveLock({ state: "ok" });
    });

    // Dá vazão a microtasks do bootstrap; sem revalidação, runBootstrap
    // dispararia aqui (RED). Com o fix, zero requests e boot estacionado.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(endpoints.fetchTransactions).not.toHaveBeenCalled();
    expect(endpoints.fetchProfile).not.toHaveBeenCalled();
    expect(endpoints.fetchQuickInsights).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it("refreshProfile sem workspace => zero I/O", async () => {
    mockAllReads();
    snapshotDb.getOfflineSnapshotLockState.mockResolvedValue({
      state: "empty",
    } as never);
    clearActiveWorkspaceId();
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = (endpoints.fetchProfile as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    await act(() => result.current.refreshProfile());
    expect(
      (endpoints.fetchProfile as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsBefore);
  });

  it("refreshProfile com resposta diferida durante archive não publica (descarte tardio)", async () => {
    mockAllReads();
    snapshotDb.getOfflineSnapshotLockState.mockResolvedValue({
      state: "empty",
    } as never);
    const serverProfile = {
      householdId: "h1",
      name: "Servidor",
      email: "srv@example.com",
      phone: "",
      avatarColor: "#0E8C5A",
      greetingStyle: "auto",
      updatedAt: new Date().toISOString(),
    } as never;
    let resolveProfile!: (v: typeof serverProfile) => void;
    const pending = new Promise<typeof serverProfile>((resolve) => {
      resolveProfile = resolve;
    });
    setActiveWorkspaceId("ws-1");
    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile).toBeNull();
    // Só agora trava o profile em voo: o bootstrap já concluiu com o mock
    // resolvido acima; o pending abaixo pertence ao refreshProfile.
    (endpoints.fetchProfile as ReturnType<typeof vi.fn>).mockReturnValue(
      pending as never,
    );
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refreshProfile();
    });
    // Archive/remount race: workspace some com o fetch em voo.
    clearActiveWorkspaceId();
    await act(async () => {
      resolveProfile(serverProfile);
      await refreshPromise;
    });
    expect(result.current.profile).toBeNull();
  });

  it("archive entre o descarte tardio e o resumo => fetchDashboardSummary emite zero calls (FIX-168-R4)", async () => {
    mockAllReads();
    // fetchProfile null => pós-bootstrap segue o ramo reportOfflineLock
    // (2ª chamada do lock). Trava exatamente esse await: o bootstrap já
    // concluiu e o tardy check passou, mas o resumo ainda não foi pedido.
    let resolvePostLock!: (v: { state: "empty" }) => void;
    const postLockGate = new Promise<{ state: "empty" }>((resolve) => {
      resolvePostLock = resolve;
    });
    let lockCalls = 0;
    snapshotDb.getOfflineSnapshotLockState.mockImplementation(() => {
      lockCalls += 1;
      // 1ª chamada (pré-bootstrap) resolve de imediato; as seguintes
      // (inclui o lock pós-bootstrap do ramo profile-null) travam no gate.
      if (lockCalls === 1) return Promise.resolve({ state: "empty" } as never);
      return postLockGate as never;
    });
    setActiveWorkspaceId("ws-1");

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    // Boot suspenso no lock pós-bootstrap: bootstrap concluiu (tardy check
    // passou com workspace) mas o resumo ainda não foi pedido.
    await waitFor(() =>
      expect(
        snapshotDb.getOfflineSnapshotLockState.mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(endpoints.fetchDashboardSummary).not.toHaveBeenCalled();

    // Archive durante o await: workspace some antes do fetch do resumo.
    clearActiveWorkspaceId();
    await act(async () => {
      resolvePostLock({ state: "empty" });
      await new Promise((r) => setTimeout(r, 50));
    });

    // Sem o gate pré-fetch (RED), o resumo seria pedido aqui — órfão
    // (403 workspace_required). Com o fix, zero calls.
    expect(endpoints.fetchDashboardSummary).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
