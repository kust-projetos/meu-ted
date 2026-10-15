import "fake-indexeddb/auto";
import { renderHook, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { setActiveWorkspaceId } from "@/lib/api/client";
import type { Account } from "@/lib/state/types";

/**
 * FIX-AUTH-BOOT FINDING 2 (follow-up T2.5-client, session-first boot).
 *
 * `apiUsable()` (gate de USO de API em app-state-context.tsx) exigia device
 * token para o bootstrap — sessão válida (cookie-first/Opção C, bearer de
 * sessão de compat) sem device token nunca carregava dados.
 *
 * Correção esperada: o gate deixa de exigir device token — sessão válida sem
 * device token permite carga normal (session-first); sem sessão nenhuma, o
 * gate atual é preservado (sem bootstrap). O device token continua como
 * chave de snapshot offline (snapshot keying intocado).
 *
 * RED primeiro: sem device token + bearer de sessão, o bootstrap não dispara.
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
  // FIX-168: the online gate additionally requires an active workspace —
  // established for the whole file so the session assertions keep isolating
  // exactly the session variable (absent session still blocks with header).
  setActiveWorkspaceId("test-workspace-1");
});

describe("AppStateProvider — session-first boot (FIX-AUTH-BOOT FINDING 2)", () => {
  it("sem device token + sessão válida → bootstrap dispara e dados carregam", async () => {
    localStorage.removeItem("pi-finance:token");
    localStorage.setItem("pi-finance:session-token", "sess-valid-abc");
    // V41C FIX 1: o bearer de sessão sozinho não destrava o bootstrap — a
    // autoridade precisa confirmar a sessão (sonda com probe succeeds).
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
    expect(result.current.accounts[0].name).toBe("API Nubank");
    expect(result.current.sync.accounts.source).toBe("live");
  });

  it("sem sessão nenhuma (sem device, sem session) → gate preservado, sem bootstrap", async () => {
    localStorage.removeItem("pi-finance:token");
    localStorage.removeItem("pi-finance:session-token");
    mockApiReads();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    expect(result.current.loading).toBe(false);
    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts).toHaveLength(0);
  });
});
