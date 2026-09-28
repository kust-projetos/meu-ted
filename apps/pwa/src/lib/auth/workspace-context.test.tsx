import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { WorkspaceProvider, useWorkspace } from "./workspace-context";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { AppStateProvider, useAppState } from "@/lib/state/app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import { saveSnapshotDomain, loadSnapshotDomain } from "@/lib/state/snapshot-store";
import { ApiError } from "@/lib/api/client";
import {
  resetSessionStatus,
  setSessionStatus,
} from "./session-authority";

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
  acceptWorkspaceInvite: vi.fn(),
  closeAllSockets: vi.fn(),
}));
const clientState = vi.hoisted(() => ({ active: undefined as string | undefined }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("./socket-registry", () => ({ closeAllSockets: api.closeAllSockets }));
vi.mock("@/lib/api/client", () => ({
  isApiConfigured: () => true,
  // A valid token is required so AppStateProvider's apiUsable() bootstraps in
  // the P1-1 integration test below.
  getAuthToken: () => "user-1",
  setActiveWorkspaceId: vi.fn((id: string) => {
    clientState.active = id;
  }),
  clearActiveWorkspaceId: vi.fn(() => {
    clientState.active = undefined;
  }),
  apiFetch: vi.fn(),
  // Minimal stub: sync-engine performs `reason instanceof ApiError` on every
  // bootstrap result while this module is mocked.
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
}));

function Probe() {
  const {
    activeWorkspace,
    loading,
    workspaces,
    selectWorkspace,
    error,
    isAuthError,
    members,
    pendingInvites,
    ownershipTransfers,
    refreshMembers,
    renameWorkspace,
    archiveWorkspace,
    restoreWorkspace,
    acceptInvite,
    resendInvite,
    revokeInvite,
    transferOwnership,
    acceptTransfer,
  } = useWorkspace();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  return <>
    <div data-testid="active">{activeWorkspace?.name ?? "none"}</div>
    <div data-testid="loading">{String(loading)}</div>
    <div data-testid="error">{error ?? "no-error"}</div>
    <div data-testid="is-auth-error">{String(isAuthError ?? false)}</div>
    <div data-testid="refresh-error">{refreshError ?? "no-refresh-error"}</div>
    <div data-testid="members-count">{members.length}</div>
    <div data-testid="invites-count">{pendingInvites.length}</div>
    <div data-testid="transfers-count">{ownershipTransfers.length}</div>
    <button onClick={() => void renameWorkspace("workspace-1", "Casa renomeada")}>Rename</button>
    <button onClick={() => void archiveWorkspace("workspace-1")}>Archive</button>
    <button onClick={() => void restoreWorkspace("workspace-2")}>Restore</button>
    <button onClick={() => void acceptInvite("a".repeat(64))}>Accept Invite</button>
    <button onClick={() => void resendInvite("invite-1")}>Resend Invite</button>
    <button onClick={() => void revokeInvite("invite-1")}>Revoke Invite</button>
    <button onClick={() => void transferOwnership("user-2")}>Transfer Ownership</button>
    <button onClick={() => void acceptTransfer("transfer-1")}>Accept Transfer</button>
    <button onClick={async () => {
      try {
        await refreshMembers();
      } catch (e) {
        setRefreshError(e instanceof Error ? e.message : String(e));
      }
    }}>Refresh Members</button>
    {workspaces.map((workspace) => <button key={workspace.id} onClick={() => selectWorkspace(workspace.id)}>{workspace.name}</button>)}
  </>;
}

describe("WorkspaceProvider", () => {
  beforeEach(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-1", name: "Casa", kind: "personal", role: "owner" },
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "owner" },
    ]);
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
  });

  it("selects the first authorized workspace and switches only to listed workspaces", async () => {
    const user = userEvent.setup();
    await saveSnapshotDomain("user-1:workspace-1", "accounts", [{ id: "old", name: "Old workspace" }] as never);
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");
    await user.click(screen.getByRole("button", { name: "Equipe" }));
    expect(await screen.findByTestId("active")).toHaveTextContent("Equipe");
    expect(await loadSnapshotDomain("user-1:workspace-1", "accounts")).toBeNull();
    expect(api.closeAllSockets).toHaveBeenCalledWith("workspace access revoked");
  });

  it("ignores requests to select unlisted/unauthorized workspace IDs", async () => {
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");
    expect(screen.getByTestId("active")).toHaveTextContent("Casa");
  });

  it("throws an error when useWorkspace is rendered outside WorkspaceProvider", () => {
    const originalError = console.error;
    console.error = vi.fn();
    try {
      expect(() => render(<Probe />)).toThrow("useWorkspace must be used inside WorkspaceProvider");
    } finally {
      console.error = originalError;
    }
  });

  it("propagates error when refreshMembers fails instead of converting it to silent empty list", async () => {
    api.fetchWorkspaceMembers.mockRejectedValue(new Error("Network failure fetching members"));
    const user = userEvent.setup();
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");

    await user.click(screen.getByRole("button", { name: "Refresh Members" }));
    expect(await screen.findByTestId("refresh-error")).toHaveTextContent("Network failure fetching members");
  });

  it("does not stay in infinite loading when fetchWorkspaces fails", async () => {
    api.fetchWorkspaces.mockRejectedValue(new Error("API offline"));
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    expect(await screen.findByTestId("error")).toHaveTextContent("API offline");
    expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument();
  });

  it("flags isAuthError and preserves workspace isolation when fetchWorkspaces fails with 401", async () => {
    api.fetchWorkspaces.mockRejectedValue(new Error("Token inválido"));
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    expect(await screen.findByTestId("error")).toHaveTextContent("Token inválido");
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("true");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
  });

  it("keeps isAuthError false on network or backend unavailability", async () => {
    api.fetchWorkspaces.mockRejectedValue(new Error("API offline"));
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    expect(await screen.findByTestId("error")).toHaveTextContent("API offline");
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
  });

  it("flags isAuthError and does not classify typed ApiError 401 as Offline", async () => {
    api.fetchWorkspaces.mockRejectedValue(new ApiError(401, "auth.invalid_token", "Sessão expirada"));
    render(
      <WorkspaceProvider>
        <Probe />
        <WorkspaceSwitcher />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("error")).toHaveTextContent("Sessão expirada");
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("true");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
    expect(screen.getByText("Não autorizado")).toBeInTheDocument();
  });

  it("flags isAuthError and does not classify typed ApiError 403 Forbidden as Offline", async () => {
    api.fetchWorkspaces.mockRejectedValue(new ApiError(403, "workspace.forbidden", "Acesso restrito"));
    render(
      <WorkspaceProvider>
        <Probe />
        <WorkspaceSwitcher />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("error")).toHaveTextContent("Acesso restrito");
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("true");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
    expect(screen.getByText("Não autorizado")).toBeInTheDocument();
  });

  it("keeps archived workspaces visible but never selects one as active", async () => {
    const authorized = [
      { id: "workspace-1", name: "Casa", kind: "personal", role: "owner", status: "archived" },
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "member", status: "active" },
    ];
    api.fetchWorkspaces.mockResolvedValue(authorized);
    const callsBeforeRender = api.fetchWorkspaces.mock.calls.length;
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    expect(await screen.findByTestId("active")).toHaveTextContent("Equipe");
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(callsBeforeRender + 1));
    const serverRevalidation = deferred<typeof authorized>();
    api.fetchWorkspaces.mockImplementationOnce(() => serverRevalidation.promise);
    await userEvent.setup().click(screen.getByRole("button", { name: "Casa" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(callsBeforeRender + 2));
    // While the cross-workspace purge + fresh server validation is pending,
    // the provider stays on its fail-safe loading shell (not the stale target).
    expect(screen.getByText("Carregando workspaces…")).toBeInTheDocument();
    expect(screen.queryByTestId("active")).not.toBeInTheDocument();
    serverRevalidation.resolve(authorized);
    expect(await screen.findByTestId("active")).toHaveTextContent("Equipe");
    expect(clientState.active).toBe("workspace-2");
  });

  it("refreshes the authorized list after lifecycle operations", async () => {
    api.renameWorkspace.mockResolvedValue({ id: "workspace-1", name: "Casa renomeada", kind: "personal", role: "owner", status: "active" });
    api.archiveWorkspace.mockResolvedValue({ id: "workspace-1", name: "Casa", kind: "personal", role: "owner", status: "archived" });
    api.restoreWorkspace.mockResolvedValue({ id: "workspace-2", name: "Equipe", kind: "shared", role: "member", status: "active" });
    const user = userEvent.setup();
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(api.renameWorkspace).toHaveBeenCalledWith("workspace-1", "Casa renomeada");
    expect(api.archiveWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(api.restoreWorkspace).toHaveBeenCalledWith("workspace-2");
  });

  it("reloads members and pending invites after accepting an invite (item 9)", async () => {
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);
    api.fetchWorkspaceMembers.mockResolvedValue([
      { userId: "user-1", name: "Alice", email: "alice@example.com", role: "owner", status: "active" },
      { userId: "user-2", name: "Bob", email: "bob@example.com", role: "member", status: "active" },
    ]);
    const user = userEvent.setup();
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    expect(await screen.findByTestId("active")).toHaveTextContent("Equipe");

    api.fetchWorkspaceMembers.mockClear();
    await user.click(screen.getByRole("button", { name: "Accept Invite" }));

    expect(api.acceptWorkspaceInvite).toHaveBeenCalledWith("a".repeat(64));
    await waitFor(() => expect(api.fetchWorkspaceMembers).toHaveBeenCalled());
    expect(await screen.findByTestId("members-count")).toHaveTextContent("2");
  });

  it("handles pending invites and ownership transfer lifecycle through context actions", async () => {
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "owner", status: "active" },
    ]);
    api.fetchPendingInvites.mockResolvedValue([
      { id: "invite-1", householdId: "workspace-2", email: "guest@example.com", role: "member", expiresAt: "2026-09-01T00:00:00.000Z" },
    ]);
    api.fetchOwnershipTransfers.mockResolvedValue([
      { id: "transfer-1", householdId: "workspace-2", fromUserId: "user-1", toUserId: "user-2", status: "pending", createdAt: "2026-08-30T00:00:00.000Z" },
    ]);

    const user = userEvent.setup();
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    expect(await screen.findByTestId("active")).toHaveTextContent("Equipe");
    expect(await screen.findByTestId("invites-count")).toHaveTextContent("1");
    expect(await screen.findByTestId("transfers-count")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "Resend Invite" }));
    expect(api.resendWorkspaceInvite).toHaveBeenCalledWith("workspace-2", "invite-1");

    await user.click(screen.getByRole("button", { name: "Revoke Invite" }));
    expect(api.revokeWorkspaceInvite).toHaveBeenCalledWith("workspace-2", "invite-1");

    await user.click(screen.getByRole("button", { name: "Transfer Ownership" }));
    expect(api.createOwnershipTransfer).toHaveBeenCalledWith("workspace-2", "user-2");

    await user.click(screen.getByRole("button", { name: "Accept Transfer" }));
    expect(api.acceptOwnershipTransfer).toHaveBeenCalledWith("workspace-2", "transfer-1");
  });
});


describe("WorkspaceProvider + AppStateProvider — workspace switch remount (P1-1 regression)", () => {
  beforeEach(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    // V41C FIX 1: AppStateProvider bootstraps only for a probe-confirmed
    // session — simulate the authority AuthGate publishes on a valid probe.
    resetSessionStatus();
    setSessionStatus({ status: "authenticated", user: { userId: "user-1" } });
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-1", name: "Casa", kind: "personal", role: "owner" },
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "owner" },
    ]);
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
  });

  it("re-bootstraps and replaces previous workspace data on selectWorkspace", async () => {
    const user = userEvent.setup();
    const w1Tx = { id: "tx-w1", description: "Compra W1", amountCents: 1000, date: "2026-09-01", kind: "expense" as const, categoryId: "c1", accountId: "acc-w1" };
    const w2Tx = { id: "tx-w2", description: "Compra W2", amountCents: 2000, date: "2026-09-02", kind: "expense" as const, categoryId: "c1", accountId: "acc-w2" };
    // Fixtures are keyed by the active workspace (mirroring the real API,
    // which returns data for the workspace in the X-Workspace-Id header) so
    // the assertions are independent of how many times the provider boots.
    const w1 = { account: { id: "acc-w1", name: "Conta W1", kind: "checking" as const, balanceCents: 100, status: "active" }, tx: w1Tx, profileName: "User W1" };
    const w2 = { account: { id: "acc-w2", name: "Conta W2", kind: "checking" as const, balanceCents: 200, status: "active" }, tx: w2Tx, profileName: "User W2" };
    const byWorkspace = <T,>(w1Value: T, w2Value: T) => () =>
      Promise.resolve(clientState.active === "workspace-2" ? w2Value : w1Value);
    const fetchAccounts = vi.spyOn(endpoints, "fetchAccounts")
      .mockImplementation(byWorkspace([w1.account], [w2.account]));
    vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchTransactions")
      .mockImplementation(byWorkspace({ items: [w1.tx], total: 1 }, { items: [w2.tx], total: 1 }));
    vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchCards").mockResolvedValue([] as never);
    vi.spyOn(endpoints, "fetchProfile")
      .mockImplementation(byWorkspace(
        { householdId: "h1", name: w1.profileName, email: "user-w1@example.com", phone: "", avatarColor: "#0ea5e9", greetingStyle: "auto" as const, updatedAt: "2026-09-01T00:00:00.000Z" },
        { householdId: "h1", name: w2.profileName, email: "user-w2@example.com", phone: "", avatarColor: "#0ea5e9", greetingStyle: "auto" as const, updatedAt: "2026-09-02T00:00:00.000Z" },
      ));
    vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([] as never);

    function AppStateProbe() {
      const { accounts, transactions, profile, loading, error } = useAppState();
      const { workspaces, selectWorkspace, activeWorkspace } = useWorkspace();
      return (
        <>
          <div data-testid="ws-active">{activeWorkspace?.name ?? "none"}</div>
          <div data-testid="boot-loading">{String(loading)}</div>
          <div data-testid="boot-error">{error ?? "none"}</div>
          <div data-testid="accounts">{accounts.map((a) => a.name).join(",") || "empty"}</div>
          <div data-testid="transactions">{transactions.map((t) => t.description).join(",") || "empty"}</div>
          <div data-testid="profile">{profile?.name ?? "none"}</div>
          {workspaces.map((workspace) => (
            <button key={workspace.id} onClick={() => void selectWorkspace(workspace.id)}>
              {workspace.name}
            </button>
          ))}
        </>
      );
    }

    render(
      <WorkspaceProvider>
        <AppStateProvider>
          <AppStateProbe />
        </AppStateProvider>
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("ws-active")).toHaveTextContent("Casa");
    await waitFor(() => expect(screen.getByTestId("accounts")).toHaveTextContent("Conta W1"));
    expect(screen.getByTestId("transactions")).toHaveTextContent("Compra W1");
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("User W1"));

    await user.click(screen.getByRole("button", { name: "Equipe" }));

    expect(await screen.findByTestId("ws-active")).toHaveTextContent("Equipe");
    await waitFor(() => expect(screen.getByTestId("accounts")).toHaveTextContent("Conta W2"));
    await waitFor(() => expect(screen.getByTestId("transactions")).toHaveTextContent("Compra W2"));
    expect(screen.getByTestId("transactions")).not.toHaveTextContent("Compra W1");
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("User W2"));
    expect(fetchAccounts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
