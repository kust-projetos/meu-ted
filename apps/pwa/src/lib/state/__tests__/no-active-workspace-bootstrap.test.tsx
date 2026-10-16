import { describe, expect, it, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@/lib/test-utils";
import { WorkspaceProvider, useWorkspace } from "@/lib/auth/workspace-context";
import { AppStateProvider, useAppState } from "@/lib/state/app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { getActiveWorkspaceId } from "@/lib/api/client";

const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceMembers: vi.fn(),
  fetchPendingInvites: vi.fn(),
  resendWorkspaceInvite: vi.fn(),
  revokeWorkspaceInvite: vi.fn(),
  fetchOwnershipTransfers: vi.fn(),
  createOwnershipTransfer: vi.fn(),
  acceptOwnershipTransfer: vi.fn(),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  fetchDeletionInventory: vi.fn(),
  requestAgentEmptyAttestation: vi.fn(),
  deleteWorkspace: vi.fn(),
  acceptWorkspaceInvite: vi.fn(),
  closeAllSockets: vi.fn(),
}));
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("@/lib/auth/socket-registry", () => ({ closeAllSockets: api.closeAllSockets }));

/**
 * FIX-168-167 (P0 #168): archiving the last active workspace must leave the
 * PWA in a no-active-workspace state where ZERO financial GETs fire
 * (bootstrap/I-O blocked) while workspace management (list/restore) stays
 * reachable.
 *
 * RED first: after archiving the only active workspace, AppState still
 * bootstraps financial domains (fetchAccounts called) — want zero calls.
 */
describe("FIX-168: archive-last-active blocks financial bootstrap, keeps management", () => {
  beforeEach(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    localStorage.clear();
    resetSessionStatus();
    setSessionStatus({ status: "authenticated", user: { userId: "user-1" } });
    api.fetchWorkspaces.mockResolvedValue([
      { id: "ws-1", name: "Casa", kind: "personal", role: "owner", status: "active" },
    ]);
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
    api.archiveWorkspace.mockImplementation(async () => {
      api.fetchWorkspaces.mockResolvedValue([
        { id: "ws-1", name: "Casa", kind: "personal", role: "owner", status: "archived" },
      ]);
      return { id: "ws-1", name: "Casa", kind: "personal", role: "owner", status: "archived" };
    });
    api.restoreWorkspace.mockImplementation(async () => {
      api.fetchWorkspaces.mockResolvedValue([
        { id: "ws-1", name: "Casa", kind: "personal", role: "owner", status: "active" },
      ]);
      return { id: "ws-1", name: "Casa", kind: "personal", role: "owner", status: "active" };
    });
    vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 } as never);
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null as never);
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchDashboardSummary").mockResolvedValue(null as never);
  });

  function Probe() {
    const { activeWorkspace, archiveWorkspace, restoreWorkspace, workspaces } = useWorkspace();
    const { loading } = useAppState();
    return (
      <>
        <div data-testid="ws-active">{activeWorkspace?.name ?? "none"}</div>
        <div data-testid="ws-count">{workspaces.length}</div>
        <div data-testid="boot-loading">{String(loading)}</div>
        <button onClick={() => void archiveWorkspace("ws-1")}>Archive last</button>
        <button onClick={() => void restoreWorkspace("ws-1")}>Restore last</button>
      </>
    );
  }

  it("fires zero financial GETs after the last active workspace is archived, keeps list/restore reachable", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(
      <WorkspaceProvider>
        <AppStateProvider>
          <Probe />
        </AppStateProvider>
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("ws-active")).toHaveTextContent("Casa");
    // Initial boot (active workspace present) must have run to completion.
    await waitFor(() => expect(screen.getByTestId("boot-loading")).toHaveTextContent("false"));
    const callsBefore = (endpoints.fetchAccounts as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole("button", { name: "Archive last" }));
    expect(await screen.findByTestId("ws-active")).toHaveTextContent("none");
    expect(getActiveWorkspaceId()).toBeUndefined();

    const callsAfterArchive = (endpoints.fetchAccounts as ReturnType<typeof vi.fn>).mock.calls.length;
    // The no-workspace remount must not issue new financial reads.
    await waitFor(() => expect(screen.getByTestId("boot-loading")).toHaveTextContent("false"));
    expect((endpoints.fetchAccounts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterArchive);

    // Management stays reachable: list still returns the archived workspace…
    expect(screen.getByTestId("ws-count")).toHaveTextContent("1");
    // …and restore re-activates it.
    await user.click(screen.getByRole("button", { name: "Restore last" }));
    expect(await screen.findByTestId("ws-active")).toHaveTextContent("Casa");
    expect(api.restoreWorkspace).toHaveBeenCalledWith("ws-1");
  });
});
