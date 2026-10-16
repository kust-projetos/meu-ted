/**
 * TDD Unit Tests for Sync Engine (sync-engine.ts)
 *
 * Covers:
 * - Happy Path: Online bootstrap fetching 10 endpoints, DOMAIN_LIVE dispatches, accounts/cards merge, BOOTSTRAP_COMPLETE
 * - Failure Path: 401 Unauthorized short-circuit + expireSession, DOMAIN_UNAVAILABLE for rejected endpoints
 * - Edge / Concurrency: SnapshotPreload offline boot fallback, cards without accounts, parallel save awaiting
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBootstrap, type SnapshotPreload } from "../sync-engine";
import type { AppStateAction } from "../state-reducer";
import * as endpoints from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { clearActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api/client";
import type { Account } from "../types";
import * as snapshotStore from "../snapshot-store";

function mockAccount(id: string, name: string): Account {
  return {
    id,
    name,
    kind: "checking",
    balanceCents: 10000,
    status: "active",
  };
}

describe("PWA Sync Engine — sync-engine.ts", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    // O engine exige workspace ativo (FIX-168 zero-I/O): os boots felizes
    // assumem workspace presente — declarado explicitamente aqui.
    clearActiveWorkspaceId();
    setActiveWorkspaceId("ws-test-1");
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });

  // ── 1. HAPPY PATH (>= 3 cases) ──────────────────────────────────────────────
  describe("Happy Path", () => {
    it("1.1 Full bootstrap dispatches BOOTSTRAP_START, DOMAIN_LIVE for all domains, and finishes with BOOTSTRAP_COMPLETE", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([mockAccount("acc-1", "Nubank")]);
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([{ id: "cat-1", name: "Alimentação", kind: "expense", icon: "food" }]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [{ id: "tx-1", description: "Mercado", amountCents: 5000, date: "2026-08-19", kind: "expense", categoryId: "cat-1", accountId: "acc-1" }], total: 1 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([{ id: "pay-1", description: "Luz", amountCents: 15000, dueDate: "2026-08-25", status: "pending" }]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue({ householdId: "h1", name: "User", email: "user@test.com", phone: "", avatarColor: "#fff", greetingStyle: "auto", updatedAt: "2026-08-19" });
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      const expireSession = vi.fn();
      await runBootstrap("test-token", dispatch, expireSession);

      expect(dispatched[0].type).toBe("BOOTSTRAP_START");
      expect(dispatched[dispatched.length - 1].type).toBe("BOOTSTRAP_COMPLETE");

      const liveActions = dispatched.filter((a) => a.type === "DOMAIN_LIVE");
      expect(liveActions.length).toBeGreaterThanOrEqual(6);
      expect(expireSession).not.toHaveBeenCalled();
    });

    it("1.2 returns the profile and quick insights fetched during bootstrap (dedupes provider refetch)", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      const profileFixture = { householdId: "h1", name: "User", email: "user@test.com", phone: "", avatarColor: "#fff", greetingStyle: "auto", updatedAt: "2026-08-19" };
      const insightsFixture = [{ id: "ins-1", title: "Gastos", body: "x" }];
      vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([mockAccount("acc-1", "Nubank")]);
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(profileFixture as never);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue(insightsFixture as never);

      const result = await runBootstrap("test-token", dispatch, vi.fn());

      expect(result).toEqual({ profile: profileFixture, quickInsights: insightsFixture });
    });

    it("1.2 Correctly merges credit cards into accounts domain", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      const bankAccount = mockAccount("acc-1", "Itaú Corrente");
      const creditCard: Account = {
        id: "card-1",
        name: "Itaú Click",
        kind: "credit_card",
        balanceCents: 0,
        creditLimitCents: 500000,
        closingDay: 10,
        dueDay: 20,
      };

      vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([bankAccount]);
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([creditCard]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      await runBootstrap("test-token", dispatch, vi.fn());

      const accountsLive = dispatched.find(
        (a) => a.type === "DOMAIN_LIVE" && a.domain === "accounts",
      ) as { type: "DOMAIN_LIVE"; data: Account[] } | undefined;

      expect(accountsLive).toBeDefined();
      expect(accountsLive!.data).toHaveLength(2);
      expect(accountsLive!.data).toContainEqual(bankAccount);
      expect(accountsLive!.data).toContainEqual(creditCard);
    });

    it("1.3 Handles transactions response unwrapping { items, total }", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      const mockTx = { id: "tx-1", description: "Padaria", amountCents: 1200, date: "2026-08-19", kind: "expense" as const, categoryId: "c1", accountId: "a1" };
      vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [mockTx], total: 1 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      await runBootstrap("test-token", dispatch, vi.fn());

      const txLive = dispatched.find(
        (a) => a.type === "DOMAIN_LIVE" && a.domain === "transactions",
      ) as { type: "DOMAIN_LIVE"; data: unknown[] } | undefined;

      expect(txLive).toBeDefined();
      expect(txLive!.data).toEqual([mockTx]);
    });
  });

  // ── 2. FAILURE PATH (>= 3 cases) ────────────────────────────────────────────
  describe("Failure Path", () => {
    it("2.1 401 Unauthorized short-circuits bootstrap, calls expireSession and dispatches BOOTSTRAP_401", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(
        new ApiError(401, "auth.invalid_token", "Sessão expirada"),
      );
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      const expireSession = vi.fn();
      await runBootstrap("test-token", dispatch, expireSession);

      expect(expireSession).toHaveBeenCalledOnce();
      expect(dispatched.some((a) => a.type === "BOOTSTRAP_401")).toBe(true);
      expect(dispatched.some((a) => a.type === "BOOTSTRAP_COMPLETE")).toBe(false);
    });

    it("2.1b returns empty extras when boot short-circuits on 401", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };
      vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new ApiError(401, "auth.invalid_token", "Invalid token"));
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      const result = await runBootstrap("test-token", dispatch, vi.fn());
      expect(result).toEqual({ profile: null, quickInsights: [] });
    });

    it("2.2 Network failure on essential domain without preload marks domain as DOMAIN_UNAVAILABLE", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("Timeout"));
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      await runBootstrap("test-token", dispatch, vi.fn());

      const accountsUnavailable = dispatched.some(
        (a) => a.type === "DOMAIN_UNAVAILABLE" && a.domain === "accounts",
      );
      expect(accountsUnavailable).toBe(true);
      expect(dispatched[dispatched.length - 1].type).toBe("BOOTSTRAP_COMPLETE");
    });

    it("2.3 Non-essential domain rejection (e.g. quickInsights) does not abort essential bootstrap", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([mockAccount("a1", "Conta")]);
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockRejectedValue(new Error("Service unavailable"));

      await runBootstrap("test-token", dispatch, vi.fn());

      expect(dispatched.some((a) => a.type === "DOMAIN_LIVE" && a.domain === "accounts")).toBe(true);
      expect(dispatched[dispatched.length - 1].type).toBe("BOOTSTRAP_COMPLETE");
    });
  });

  // ── 3. EDGE & CONCURRENCY CASES (>= 3 cases) ────────────────────────────────
  describe("Edge & Concurrency Cases", () => {
    it("3.1 Falls back to SnapshotPreload for failed domain, dispatching DOMAIN_SNAPSHOT", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("Offline"));
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      const preload: SnapshotPreload = {
        accounts: {
          data: [mockAccount("a-snap", "Offline Nubank")],
          syncedAt: "2026-08-18T12:00:00.000Z",
        },
      };

      await runBootstrap("test-token", dispatch, vi.fn(), preload);

      const accountsSnap = dispatched.find(
        (a) => a.type === "DOMAIN_SNAPSHOT" && a.domain === "accounts",
      ) as { type: "DOMAIN_SNAPSHOT"; data: Account[]; syncedAt: string } | undefined;

      expect(accountsSnap).toBeDefined();
      expect(accountsSnap!.data[0].id).toBe("a-snap");
      expect(accountsSnap!.syncedAt).toBe("2026-08-18T12:00:00.000Z");
    });

    it("3.2 If accounts endpoint fails but cards succeeds, accounts domain uses card data", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      const card: Account = { id: "card-only", name: "Cartão Único", kind: "credit_card", balanceCents: 0 };
      vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("Failed"));
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([card]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      await runBootstrap("test-token", dispatch, vi.fn());

      const accountsLive = dispatched.find(
        (a) => a.type === "DOMAIN_LIVE" && a.domain === "accounts",
      ) as { type: "DOMAIN_LIVE"; data: Account[] } | undefined;

      expect(accountsLive).toBeDefined();
      expect(accountsLive!.data).toEqual([card]);
    });

    it("3.3 Awaits all snapshot persistence promises before dispatching BOOTSTRAP_COMPLETE", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };

      let saveResolved = false;
      vi.spyOn(snapshotStore, "saveSnapshotDomain").mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        saveResolved = true;
      });

      vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([mockAccount("a1", "Conta")]);
      vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
      vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
      vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
      vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

      await runBootstrap("test-token", dispatch, vi.fn());

      expect(saveResolved).toBe(true);
      expect(dispatched[dispatched.length - 1].type).toBe("BOOTSTRAP_COMPLETE");
    });

    it("3.4 syncTransactionsPage fetches paginated transactions and dispatches DOMAIN_LIVE", async () => {
      const dispatched: AppStateAction[] = [];
      const dispatch = (a: AppStateAction) => { dispatched.push(a); };
      const txs = [{ id: "tx-page-1", description: "Test", amountCents: 1000, date: "2026-08-19", kind: "expense" as const, categoryId: "c1", accountId: "a1" }];

      const spy = vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
        items: txs,
        total: 100,
        page: 2,
        limit: 25,
      });

      const { syncTransactionsPage } = await import("../sync-engine");
      const result = await syncTransactionsPage("token-1", { page: 2, limit: 25 }, dispatch);

      expect(result.page).toBe(2);
      expect(result.limit).toBe(25);
      expect(result.total).toBe(100);
      expect(result.items).toEqual(txs);
      expect(spy).toHaveBeenCalledWith({ page: 2, limit: 25 });
      expect(dispatched.some((a) => a.type === "DOMAIN_LIVE" && a.domain === "transactions")).toBe(true);
    });
  });
});
