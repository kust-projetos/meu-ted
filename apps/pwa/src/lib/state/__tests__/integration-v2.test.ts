import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { renderHook, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import * as snapshotStore from "../snapshot-store";
import {
  writeV2Snapshot,
  readV2Snapshot,
  openSnapshotDb,
  V2_ENVELOPE_KEY,
  STORE_NAME,
} from "../snapshot-db";
import type { Account } from "@/lib/state/types";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { setActiveWorkspaceId } from "@/lib/api/client";

const TOKEN = "test-token-v2";
// T2.6: v2 reads require the subject partition (an authenticated session
// always carries one).
const TEST_SUBJECT = "55555555-6666-4777-8888-999999999999";

function mockAccount(id: string, name: string): Account {
  return {
    id, name, kind: "checking", initialBalanceCents: 0,
    balanceCents: 500_00, status: "active",
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

// Read the raw v2 envelope straight out of IndexedDB (bypassing the
// fingerprint/owner logic) so we can assert the raw token is never stored.
async function readRawEnvelope(): Promise<unknown> {
  const db = await openSnapshotDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(V2_ENVELOPE_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

function stubEnvAndToken(): void {
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3001");
  localStorage.setItem("pi-finance:token", TOKEN);
  // V41C FIX 1: live bootstrap requires a probe-confirmed session.
  setSessionStatus({ status: "authenticated", user: { userId: "test-user" } });
  setOfflineSubjectId(TEST_SUBJECT);
  // FIX-168: live bootstrap additionally requires an active workspace.
  setActiveWorkspaceId("test-workspace-1");
}

function seedV1(domain: string, data: unknown[]): void {
  localStorage.setItem(
    "pi-finance:snapshot:v1",
    JSON.stringify({ version: 1, token: TOKEN, syncedAt: { [domain]: "2026-07-13T00:00:00.000Z" }, data: { [domain]: data } }),
  );
}

describe("v2 snapshot production integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSessionStatus();
    localStorage.clear();
    stubEnvAndToken();
  });

  it("call-site proof: live bootstrap persists v2 via saveSnapshotDomain", async () => {
    const saveSpy = vi.spyOn(snapshotStore, "saveSnapshotDomain");

    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([mockAccount("a1", "Nubank")]);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Production bootstrap must write live data to the v2 (IndexedDB) snapshot.
    expect(saveSpy).toHaveBeenCalled();

    const v2 = await readV2Snapshot(TOKEN, "accounts");
    expect(v2).not.toBeNull();
    expect((v2!.data as unknown[]).length).toBeGreaterThan(0);
  });

  it("v1 offline bootstrap migrates, deletes v1, and renders the snapshot", async () => {
    seedV1("accounts", [mockAccount("snap-1", "V1 Nubank")]);
    // accounts fetch fails → bootstrap must fall back to the migrated v2 snapshot
    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("down"));
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.accounts[0].name).toBe("V1 Nubank");
    expect(result.current.sync.accounts.source).toBe("snapshot");
    // v1 source removed after successful migration
    expect(localStorage.getItem("pi-finance:snapshot:v1")).toBeNull();
    // v2 now holds the data
    const v2 = await readV2Snapshot(TOKEN, "accounts");
    expect(v2).not.toBeNull();
  });

  it("existing v2 offline boot renders snapshot without migration", async () => {
    await writeV2Snapshot(TOKEN, "accounts", [mockAccount("v2-1", "V2 Nubank")]);

    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("down"));
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.accounts[0].name).toBe("V2 Nubank");
    expect(result.current.sync.accounts.source).toBe("snapshot");
  });

  it("corrupt/schema-mismatch v2 is discarded and falls back to unavailable", async () => {
    // Directly corrupt the v2 envelope (wrong schema version).
    const db = await openSnapshotDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(
        { schema: 999, ownerFingerprint: "x", domains: {}, syncedAt: {} },
        V2_ENVELOPE_KEY,
      );
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });

    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(new Error("down"));
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sync.accounts.source).toBe("unavailable");
    expect(result.current.accounts).toHaveLength(0);
  });

  it("raw token is never stored in IndexedDB (only its SHA-256 fingerprint)", async () => {
    await writeV2Snapshot(TOKEN, "accounts", [mockAccount("a1", "Nubank")]);

    const raw = await readRawEnvelope();
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(TOKEN);
    expect((raw as { ownerFingerprint?: string } | null)?.ownerFingerprint).not.toBe(TOKEN);
  });
});
