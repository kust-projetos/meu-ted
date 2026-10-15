import "fake-indexeddb/auto";
import { renderHook, act, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { setActiveWorkspaceId } from "@/lib/api/client";
import type { Account, CardStatement, Transaction } from "@/lib/state/types";

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

function mockAccount(id: string, name: string, balanceCents: number): Account {
  return {
    id,
    name,
    kind: "checking",
    initialBalanceCents: 0,
    status: "active",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    balanceCents,
  } as Account;
}

function mockApiReads(accounts: Account[]) {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue(accounts);
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

describe("optimistic bank/cash balances may go negative (ADR-018)", () => {
  beforeEach(() => {
    apiReady();
    mockApiReads([
      mockAccount("acc-from", "Checking From", 5_00),
      mockAccount("acc-to", "Checking To", 0),
    ]);
  });

  it("retains a negative optimistic balance on transfer", async () => {
    let resolveApi!: (value: Transaction | PromiseLike<Transaction>) => void;
    vi.spyOn(endpoints, "createTransfer").mockReturnValue(
      new Promise<Transaction>((resolve) => {
        resolveApi = resolve;
      }),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.createTransfer({
        description: "Overdraft transfer",
        amountCents: 10_00,
        date: "2026-09-18",
        fromAccountId: "acc-from",
        toAccountId: "acc-to",
      });
    });
    // Exact delta, no zero floor: 5.00 - 10.00 = -5.00.
    expect(
      result.current.accounts.find((a) => a.id === "acc-from")?.balanceCents,
    ).toBe(-5_00);
    expect(
      result.current.accounts.find((a) => a.id === "acc-to")?.balanceCents,
    ).toBe(10_00);
    await act(async () => {
      resolveApi({} as unknown as Transaction);
      await pending;
    });
  });

  it("retains a negative optimistic balance on card statement payment", async () => {
    let resolveApi!: (value: CardStatement | PromiseLike<CardStatement>) => void;
    vi.spyOn(endpoints, "payStatement").mockReturnValue(
      new Promise<CardStatement>((resolve) => {
        resolveApi = resolve;
      }),
    );

    const { result } = renderHook(() => useAppState(), {
      wrapper: AppStateProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.payStatement("stmt-1", {
        amountCents: 10_00,
        fromAccountId: "acc-from",
      });
    });
    // Exact delta, no zero floor: 5.00 - 10.00 = -5.00.
    expect(
      result.current.accounts.find((a) => a.id === "acc-from")?.balanceCents,
    ).toBe(-5_00);
    await act(async () => {
      resolveApi({ id: "stmt-1" } as unknown as CardStatement);
      await pending;
    });
  });
});
