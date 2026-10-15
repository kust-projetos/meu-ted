import "fake-indexeddb/auto";
import { useLayoutEffect, useRef } from "react";
import { renderHook, act, waitFor, render, screen, fireEvent } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { ApiError, setActiveWorkspaceId } from "@/lib/api/client";
import * as endpoints from "@/lib/api/endpoints";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import type { Account, Payable, Transaction } from "@/lib/state/types";

// Same API-ready harness as app-state-context.test.tsx: the browser defaults
// to the same-origin proxy, so pin the configured path explicitly.
const apiConfigState = vi.hoisted(() => ({ forceUnconfigured: false }));
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    isApiConfigured: () =>
      apiConfigState.forceUnconfigured ? false : actual.isApiConfigured(),
  };
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSessionStatus();
  apiConfigState.forceUnconfigured = false;
  localStorage.clear();
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

function mockApiReads(overrides: Partial<{ payables: Payable[] }> = {}) {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
    {
      id: "a1",
      name: "API Nubank",
      kind: "checking",
      initialBalanceCents: 0,
      status: "active",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      balanceCents: 500_00,
    } as Account,
  ]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue(overrides.payables ?? []);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
}

function apiReady() {
  apiConfigState.forceUnconfigured = false;
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3001");
  localStorage.setItem("pi-finance:token", "test-token-abc");
  // V41C FIX 1: live bootstrap requires a probe-confirmed session.
  setSessionStatus({ status: "authenticated", user: { userId: "test-user" } });
  setOfflineSubjectId("66666666-7777-4888-8999-aaaaaaaaaaaa");
  // FIX-168: writes additionally require an active workspace header.
  setActiveWorkspaceId("test-workspace-1");
}

const TX = {
  id: "tx-retry-1",
  description: "Mercado",
  amountCents: 15000,
  date: "2026-09-01",
  kind: "expense",
  categoryId: "cat-1",
  accountId: "acc-1",
} as Transaction;

function keyOf(spy: { mock: { calls: unknown[][] } }, call: number): unknown {
  const args = spy.mock.calls[call] as [{ idempotencyKey?: unknown }] | undefined;
  return args?.[0]?.idempotencyKey;
}

describe("write-error manual retry with same commandId (DEBT-CODER-RETRYBANNER)", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads();
  });

  it("exposes a retry affordance when the failed error carries a commandId", async () => {
    vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.addTransaction(TX)).rejects.toThrow("fetch failed");
    });

    expect(result.current.writeError).toMatch(/fetch failed/);
    // The intent id survived on the error and is exposed for manual retry.
    expect(typeof result.current.writeErrorCommandId).toBe("string");
    expect(typeof result.current.retryWriteError).toBe("function");
  });

  it("manual retry reuses the SAME idempotency key (no duplicate effect)", async () => {
    const apiSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: "tx-server-1" } as Transaction);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.addTransaction(TX)).rejects.toThrow("fetch failed");
    });
    const failedId = result.current.writeErrorCommandId;
    expect(typeof failedId).toBe("string");
    // Both automatic attempts already used that same id.
    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(keyOf(apiSpy, 0)).toBe(failedId);
    expect(keyOf(apiSpy, 1)).toBe(failedId);

    await act(async () => {
      await result.current.retryWriteError!();
    });

    expect(apiSpy).toHaveBeenCalledTimes(3);
    expect(keyOf(apiSpy, 2)).toBe(failedId);
    expect(result.current.writeError).toBeNull();
  });

  it("banner click on retry reuses the SAME idempotency key", async () => {
    const apiSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: "tx-server-2" } as Transaction);
    function Harness() {
      const state = useAppState();
      return (
        <>
          <span>{state.loading ? "carregando" : "pronto"}</span>
          <button
            type="button"
            onClick={() =>
              void state.addTransaction(TX).catch(() => {
                /* surfaced via the banner */
              })
            }
          >
            add-tx
          </button>
          <WriteErrorBanner
            message={state.writeError}
            onDismiss={state.clearWriteError}
            onRetry={state.retryWriteError ?? undefined}
          />
        </>
      );
    }
    render(<Harness />, { wrapper: AppStateProvider });
    await waitFor(() => expect(screen.getByText("pronto")).toBeInTheDocument());

    fireEvent.click(screen.getByText("add-tx"));
    const retryButton = await screen.findByRole("button", { name: /tentar de novo/i });
    expect(retryButton).toBeInTheDocument();
    const failedKeys = [keyOf(apiSpy, 0), keyOf(apiSpy, 1)];
    expect(typeof failedKeys[0]).toBe("string");
    expect(failedKeys[0]).toBe(failedKeys[1]);

    fireEvent.click(retryButton);
    await waitFor(() => expect(apiSpy).toHaveBeenCalledTimes(3));
    expect(keyOf(apiSpy, 2)).toBe(failedKeys[0]);
    await waitFor(() =>
      expect(screen.queryByTestId("write-error-banner")).not.toBeInTheDocument(),
    );
  });

  it("offers no retry affordance when the error carries no commandId", async () => {
    mockApiReads({
      payables: [
        {
          id: "p-no-link",
          description: "Sem vínculo",
          amountCents: 1000,
          dueDate: "2026-06-30",
          status: "pending",
        } as Payable,
      ],
    });
    function Harness() {
      const state = useAppState();
      return (
        <>
          <span>{state.loading ? "carregando" : "pronto"}</span>
          <button type="button" onClick={() => void state.undoPayablePayment("p-no-link")}>
            undo-payable
          </button>
          <WriteErrorBanner
            message={state.writeError}
            onDismiss={state.clearWriteError}
            onRetry={state.retryWriteError ?? undefined}
          />
        </>
      );
    }
    render(<Harness />, { wrapper: AppStateProvider });
    await waitFor(() => expect(screen.getByText("pronto")).toBeInTheDocument());

    // Fail-closed validation error: never touches the network, carries no id.
    fireEvent.click(screen.getByText("undo-payable"));
    const banner = await screen.findByTestId("write-error-banner");
    expect(banner).toHaveTextContent(/vinculada/);
    expect(
      screen.queryByRole("button", { name: /tentar de novo/i }),
    ).not.toBeInTheDocument();
  });

  it("immediate layout-phase retry reuses the SAME idempotency key", async () => {
    const apiSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: "tx-server-immediate" } as Transaction);
    function Harness() {
      const state = useAppState();
      const firedRef = useRef(false);
      // Commit/layout-phase probe: fires synchronously after the DOM mutation
      // that exposes writeError + retryWriteError, before passive useEffect
      // hooks can synchronize pending-write refs.
      useLayoutEffect(() => {
        if (!firedRef.current && state.writeError && state.retryWriteError) {
          firedRef.current = true;
          void state.retryWriteError();
        }
      });
      return (
        <>
          <span>{state.loading ? "carregando" : "pronto"}</span>
          <button
            type="button"
            onClick={() =>
              void state.addTransaction(TX).catch(() => {
                /* surfaced via the banner */
              })
            }
          >
            add-tx
          </button>
          <WriteErrorBanner
            message={state.writeError}
            onDismiss={state.clearWriteError}
            onRetry={state.retryWriteError ?? undefined}
          />
        </>
      );
    }
    render(<Harness />, { wrapper: AppStateProvider });
    await waitFor(() => expect(screen.getByText("pronto")).toBeInTheDocument());

    fireEvent.click(screen.getByText("add-tx"));

    // Both automatic attempts fail first; the layout-phase probe retries
    // before passive effects run, so a ref-sync race misses call 3.
    await waitFor(() => expect(apiSpy).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(keyOf(apiSpy, 0)).toBe(keyOf(apiSpy, 1));
    expect(typeof keyOf(apiSpy, 0)).toBe("string");
    expect(keyOf(apiSpy, 2)).toBe(keyOf(apiSpy, 0));
    await waitFor(() =>
      expect(screen.queryByTestId("write-error-banner")).not.toBeInTheDocument(),
    );
  });

  it("definitive 409 carrying a network.timeout code offers no manual retry (FIX-RETRY-STATUS-PRECEDENCE)", async () => {
    const apiSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(
        new ApiError(409, "network.timeout", "conflito com código de timeout"),
      );
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.addTransaction(TX)).rejects.toBeInstanceOf(ApiError);
    });

    // Banner surfaces the definitive error…
    expect(result.current.writeError).toMatch(/conflito com código de timeout/);
    // …but a definitive 409 never arms a same-id manual retry, regardless of code.
    expect(result.current.writeErrorCommandId).toBeNull();
    expect(result.current.retryWriteError).toBeNull();
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it("definitive 409 conflict with a commandId offers no manual retry (FIX-DEFINITIVE-WRITE-RETRY-AFFORDANCE)", async () => {
    const apiSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(
        new ApiError(409, "idempotency.conflict", "conflito de idempotência"),
      );
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.addTransaction(TX)).rejects.toBeInstanceOf(ApiError);
    });

    // Banner surfaces the definitive error…
    expect(result.current.writeError).toMatch(/conflito de idempotência/);
    // …but no manual retry is armed: replaying a definitive 409 could
    // re-execute instead of replaying the original receipt.
    expect(result.current.writeErrorCommandId).toBeNull();
    expect(result.current.retryWriteError).toBeNull();
    // Definitive 409 is never auto-retried either (single attempt).
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it("ordinary definitive 400 with a commandId offers no manual retry (FIX-DEFINITIVE-WRITE-RETRY-AFFORDANCE)", async () => {
    const apiSpy = vi
      .spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(
        new ApiError(400, "validation.error", "requisição inválida"),
      );
    function Harness() {
      const state = useAppState();
      return (
        <>
          <span>{state.loading ? "carregando" : "pronto"}</span>
          <button
            type="button"
            onClick={() =>
              void state.addTransaction(TX).catch(() => {
                /* surfaced via the banner */
              })
            }
          >
            add-tx
          </button>
          <WriteErrorBanner
            message={state.writeError}
            onDismiss={state.clearWriteError}
            onRetry={state.retryWriteError ?? undefined}
          />
        </>
      );
    }
    render(<Harness />, { wrapper: AppStateProvider });
    await waitFor(() => expect(screen.getByText("pronto")).toBeInTheDocument());

    fireEvent.click(screen.getByText("add-tx"));

    const banner = await screen.findByTestId("write-error-banner");
    expect(banner).toHaveTextContent(/requisição inválida/);
    // Banner shows the error but offers no manual retry for a definitive 4xx.
    expect(
      screen.queryByRole("button", { name: /tentar de novo/i }),
    ).not.toBeInTheDocument();
    // Definitive 400 is never auto-retried; and with no retry affordance
    // there is no manual reissue either.
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });
});
