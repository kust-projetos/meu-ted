import { describe, expect, it, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { WorkspaceProvider, useWorkspace } from "../workspace-context";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { setActiveWorkspaceId } from "@/lib/api/client";
import { setOfflinePrincipalId } from "../offline-identity";

const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceMembers: vi.fn(),
  fetchPendingInvites: vi.fn(),
  fetchOwnershipTransfers: vi.fn(),
  closeAllSockets: vi.fn(),
}));
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("../socket-registry", () => ({ closeAllSockets: api.closeAllSockets }));
vi.mock("@/lib/api/client", () => ({
  isApiConfigured: () => true,
  getAuthToken: () => "user-1",
  setActiveWorkspaceId: vi.fn(),
  clearActiveWorkspaceId: vi.fn(),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
}));

function Probe() {
  const { activeWorkspace, workspaces, selectWorkspace, error, isAuthError } = useWorkspace();
  return (
    <>
      <div data-testid="active">{activeWorkspace?.name ?? "none"}</div>
      <div data-testid="error">{error ?? "no-error"}</div>
      <div data-testid="is-auth-error">{String(isAuthError ?? false)}</div>
      {workspaces.map((workspace) => (
        <button key={workspace.id} onClick={() => void selectWorkspace(workspace.id)}>
          {workspace.name}
        </button>
      ))}
    </>
  );
}

describe("selectWorkspace error recovery (reviewer MEDIUM)", () => {
  beforeEach(() => {
    localStorage.clear();
    setOfflinePrincipalId("user-1");
    vi.clearAllMocks();
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-1", name: "Casa", kind: "personal", role: "owner" },
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "owner" },
    ]);
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
  });

  it("clears the Token inválido alert on retry success with header/label on the destination", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceProvider>
        <Probe />
        <WorkspaceSwitcher />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");

    // First attempt fails during server revalidation.
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("Token inválido"));
    await user.click(screen.getByRole("button", { name: "Equipe" }));

    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Token inválido"));
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("true");
    expect(await screen.findByTestId("workspace-switch-error")).toHaveTextContent("Token inválido");

    // Retry with the same provider succeeds: server revalidates the destination.
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-1", name: "Casa", kind: "personal", role: "owner" },
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "owner" },
    ]);
    await user.click(screen.getByRole("button", { name: "Equipe" }));

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("Equipe"));
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("no-error"));
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("false");
    expect(screen.queryByTestId("workspace-switch-error")).not.toBeInTheDocument();
    expect(vi.mocked(setActiveWorkspaceId)).toHaveBeenLastCalledWith("workspace-2");
  });
});
