import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBootstrap } from "../sync-engine";
import type { AppStateAction } from "../state-reducer";
import * as endpoints from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { clearActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api/client";
import * as snapshotStore from "../snapshot-store";

/**
 * V4.1 Phase 5 (Task 5.9 + D10): a 403 auth.workspace_forbidden during bootstrap
 * means the membership is gone — the PWA must take the unauthenticated
 * transition (expireSession, which purges the snapshot), never fall back to
 * rendering the stale offline snapshot.
 */
describe("bootstrap revocation (D10)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    // Revogação pressupõe boot com workspace (FIX-168 zero-I/O no engine).
    clearActiveWorkspaceId();
    setActiveWorkspaceId("ws-test-1");
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
  });

  function rejectAllRevoked(): void {
    const revoked = new ApiError(403, "auth.workspace_forbidden", "Acesso restrito");
    vi.spyOn(endpoints, "fetchAccounts").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchCategories").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchTransactions").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchPayables").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchBudgets").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchGoals").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchStatements").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchCards").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchProfile").mockRejectedValue(revoked);
    vi.spyOn(endpoints, "fetchQuickInsights").mockRejectedValue(revoked);
  }

  it("expires the session when every domain answers 403 workspace_forbidden", async () => {
    rejectAllRevoked();
    const dispatched: AppStateAction[] = [];
    const expireSession = vi.fn();
    await runBootstrap("revoked-token", (a) => dispatched.push(a), expireSession);
    expect(expireSession).toHaveBeenCalledOnce();
  });

  it("never serves snapshot data for a revoked membership", async () => {
    rejectAllRevoked();
    const dispatched: AppStateAction[] = [];
    await runBootstrap(
      "revoked-token",
      (a) => dispatched.push(a),
      vi.fn(),
      { accounts: { data: [{ id: "stale" }], syncedAt: new Date().toISOString() } },
    );
    expect(dispatched.some((a) => a.type === "DOMAIN_SNAPSHOT")).toBe(false);
  });
});
