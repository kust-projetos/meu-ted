import "fake-indexeddb/auto";
import { renderHook, act, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import {
  setOfflinePrincipalId,
  setOfflineWorkspaceId,
} from "@/lib/auth/offline-identity";
import { writeV3Snapshot } from "../snapshot-db";
import { setActiveWorkspaceId } from "@/lib/api/client";
import type { Account, Payable, Transaction } from "@/lib/state/types";

/**
 * W1 item 2 (Onda 1) — RED: writes fantasmas e autoridade de escrita.
 *
 * A guarda central de escrita deve ocorrer ANTES de qualquer atualização
 * otimista/efeito em todos os mutadores do provider:
 * - `unknown` (mesmo com device token verificado + cookie recusado) impede
 *   CRUD de transação e outra mutação financeira, não chama endpoint, não
 *   deixa failedWrite fictício e apresenta erro acessível (writeError, que o
 *   WriteErrorBanner expõe com role="alert");
 * - transição de autoridade com callback já montado também falha fechada;
 * - `unreachable` + V3 válido continua somente leitura, sem enfileirar write;
 * - cookie-only autenticado continua escrevendo e reconciliando.
 */

const WS_UUID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PRINCIPAL = "user-write-guard";

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

function mockTx(id: string, description: string): Transaction {
  return {
    id,
    description,
    amountCents: 1000,
    date: "2026-06-25",
    kind: "expense",
    categoryId: "cat1",
    accountId: "a1",
  };
}

function mockPayable(): Payable {
  return {
    id: "p1",
    description: "Conta de luz",
    amountCents: 2000,
    dueDate: "2026-06-30",
    status: "pending",
    accountId: "a1",
    type: "one_time",
    paidTransactionId: "tx-1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function mockApiReads() {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
    mockAccount("a1", "API Nubank"),
  ]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: [mockTx("t1", "Original")],
    total: 1,
  });
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([mockPayable()]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchDashboardSummary").mockResolvedValue(null as never);
}

function mockWriteEndpoints() {
  return {
    createExpense: vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValue({ id: "server-tx" } as Transaction),
    updateTx: vi
      .spyOn(endpoints, "updateTransaction")
      .mockResolvedValue({ id: "t1" } as Transaction),
    deleteTx: vi
      .spyOn(endpoints, "deleteTransaction")
      .mockResolvedValue({ id: "t1" } as Transaction),
    payPayable: vi
      .spyOn(endpoints, "markPayablePaid")
      .mockResolvedValue({ id: "p1" } as Payable),
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
  // FIX-168: live I/O requires an active workspace header alongside the
  // session authority — established here so each test isolates exactly the
  // authority variable it transitions.
  setActiveWorkspaceId(WS_UUID);
});

afterEach(() => {
  resetSessionStatus();
  vi.unstubAllEnvs();
});

describe("AppStateProvider — guarda central de autoridade de escrita (W1 item 2)", () => {
  it("unknown + device token verificado + cookie recusado: addTransaction não altera estado, não chama endpoint, sem failedWrite fictício e com erro acessível", async () => {
    // Device bearer presente (verificado em outro fluxo) mas o probe de
    // cookie recusou a sessão: autoridade permanece `unknown` (pré-probe).
    localStorage.setItem("pi-finance:session-token", "sess-stale-abc");
    localStorage.setItem("pi-finance:token", "dev-verified-abc");
    mockApiReads();
    const writes = mockWriteEndpoints();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });

    await act(async () => {
      await result.current.addTransaction({
        ...mockTx("tx-ghost", "Fantasma"),
      });
    });

    // Nenhum estado otimista fantasma…
    expect(result.current.transactions).toHaveLength(0);
    // …nenhuma tentativa na API…
    expect(writes.createExpense).not.toHaveBeenCalled();
    // …nenhum failedWrite fictício (nada chegou à API, nada há p/ retry)…
    expect(result.current.writeErrorCommandId).toBeNull();
    expect(result.current.retryWriteError).toBeNull();
    // …e um erro acessível (WriteErrorBanner expõe writeError com role=alert).
    expect(result.current.writeError).toMatch(/sessão|login/i);
  });

  it("transição de autoridade com callback montado: authenticated → unknown bloqueia update + payable sem fantasma e sem endpoint", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-valid-abc");
    localStorage.setItem("pi-finance:token", "dev-valid-abc");
    setSessionStatus({
      status: "authenticated",
      user: { userId: "u1", email: "walis@example.com" },
    });
    mockApiReads();
    const writes = mockWriteEndpoints();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(result.current.transactions.map((t) => t.id)).toContain("t1"),
    );
    await waitFor(() =>
      expect(result.current.payables.map((p) => p.id)).toContain("p1"),
    );
    // Histórico limpo: o bootstrap consumiu as leituras; writes ainda intactos.
    writes.updateTx.mockClear();
    writes.payPayable.mockClear();

    // A autoridade cai (expiração/revogação) com o formulário já aberto: o
    // mutador capturado deve ler a autoridade no momento da chamada.
    setSessionStatus({ status: "unknown" });

    await act(async () => {
      await result.current.updateTransaction("t1", {
        description: "Ghost edit",
      });
    });
    await act(async () => {
      await result.current.markPayablePaid("p1");
    });

    // CRUD de transação bloqueado sem fantasma…
    expect(
      result.current.transactions.find((t) => t.id === "t1")?.description,
    ).toBe("Original");
    expect(writes.updateTx).not.toHaveBeenCalled();
    // …outra mutação financeira também bloqueada…
    expect(
      result.current.payables.find((p) => p.id === "p1")?.status,
    ).toBe("pending");
    expect(writes.payPayable).not.toHaveBeenCalled();
    // …com erro acessível e sem retry fictício.
    expect(result.current.writeError).toMatch(/sessão|login/i);
    expect(result.current.writeErrorCommandId).toBeNull();
    expect(result.current.retryWriteError).toBeNull();
  });

  it("transição de autoridade: deleteTransaction bloqueado após perda de sessão", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-valid-abc");
    setSessionStatus({
      status: "authenticated",
      user: { userId: "u1", email: "walis@example.com" },
    });
    mockApiReads();
    const writes = mockWriteEndpoints();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(result.current.transactions.map((t) => t.id)).toContain("t1"),
    );
    writes.deleteTx.mockClear();

    setSessionStatus({ status: "unauthenticated" });

    await act(async () => {
      await result.current.deleteTransaction("t1");
    });

    expect(result.current.transactions.map((t) => t.id)).toContain("t1");
    expect(writes.deleteTx).not.toHaveBeenCalled();
    expect(result.current.writeError).toMatch(/sessão|login/i);
    expect(result.current.retryWriteError).toBeNull();
  });

  it("transição de autoridade com formulário aberto: authenticated → unknown/unreachable bloqueia saveProfile sem PATCH, sem mudança local e com erro acessível", async () => {
    localStorage.setItem("pi-finance:session-token", "sess-valid-abc");
    setSessionStatus({
      status: "authenticated",
      user: { userId: "u1", email: "walis@example.com" },
    });
    mockApiReads();
    const bootProfile = {
      householdId: "h1",
      name: "Marina",
      email: "marina@example.com",
      phone: "",
      avatarColor: "#0E8C5A",
      greetingStyle: "auto",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    vi.mocked(endpoints.fetchProfile).mockResolvedValue(bootProfile as never);
    const patchProfile = vi
      .spyOn(endpoints, "patchProfile")
      .mockResolvedValue({ ...bootProfile, name: "Ghost" } as never);

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(result.current.profile?.name).toBe("Marina"),
    );
    // Consumidor montado sob `authenticated` captura o callback no mount —
    // a guarda deve ser avaliada no momento da chamada, não no mount.
    const mountedSave = result.current.saveProfile;
    patchProfile.mockClear();

    for (const status of ["unknown", "unreachable"] as const) {
      setSessionStatus({ status });

      await act(async () => {
        await mountedSave({ name: "Ghost" });
      });

      // Nenhum PATCH /profile…
      expect(patchProfile).not.toHaveBeenCalled();
      // …nenhuma mudança no profile local…
      expect(result.current.profile?.name).toBe("Marina");
      // …com erro acessível da guarda (nunca falha mascarada do endpoint)…
      expect(result.current.writeError).toMatch(
        /sessão|login|somente leitura|indisponível/i,
      );
      // …e sem retry fictício (não há intent falho para repetir).
      expect(result.current.writeErrorCommandId).toBeNull();
      expect(result.current.retryWriteError).toBeNull();
    }
  });

  it("unreachable + V3 válido continua somente leitura, sem enfileirar escrita", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await writeV3Snapshot(PRINCIPAL, WS_UUID, "accounts", [
      mockAccount("a1", "Conta Offline"),
    ] as never);
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    mockApiReads();
    const writes = mockWriteEndpoints();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readOnly).toBe(true);

    await act(async () => {
      await result.current.addTransaction({ ...mockTx("tx-off", "Offline") });
    });

    expect(
      result.current.transactions.find((t) => t.id === "tx-off"),
    ).toBeUndefined();
    expect(writes.createExpense).not.toHaveBeenCalled();
    expect(result.current.writeError).toMatch(
      /somente leitura|indisponível|sessão|login/i,
    );
    expect(result.current.writeErrorCommandId).toBeNull();
    expect(result.current.retryWriteError).toBeNull();
  });

  it("controle: cookie-only autenticado (zero bearers) continua escrevendo e reconciliando", async () => {
    localStorage.removeItem("pi-finance:token");
    localStorage.removeItem("pi-finance:session-token");
    setSessionStatus({
      status: "authenticated",
      user: { userId: "u1", email: "walis@example.com" },
    });
    mockApiReads();
    const writes = mockWriteEndpoints();

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    writes.createExpense.mockClear();

    await act(async () => {
      await result.current.addTransaction({ ...mockTx("tx-new", "Novo") });
    });

    expect(writes.createExpense).toHaveBeenCalledTimes(1);
    // A reconciliação pós-write recompõe o estado a partir da verdade do
    // servidor (mock: [t1]) — o que prova o ciclo escrita → reconciliação;
    // nenhum fantasma com o id otimista local permanece.
    expect(result.current.transactions.map((t) => t.id)).toContain("t1");
    expect(
      result.current.transactions.find((t) => t.id === "tx-new"),
    ).toBeUndefined();
    expect(result.current.writeError).toBeNull();
  });
});
