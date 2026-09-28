/**
 * Active workspace preference — reload/remount persistence (cross-workspace
 * write guard).
 *
 * Contract under test:
 * - a selected workspace survives a provider remount (full reload): boot
 *   restores the stored id AND the API client header follows it;
 * - a stored id that is absent/invalid/non-member/archived falls back to
 *   the first accessible workspace and the fallback is persisted;
 * - a stored entry bound to another principal is never honored (no
 *   cross-user inheritance) and logout teardown wipes the entry.
 *
 * The server-side fetchWorkspaces() list stays the authority in every case.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { WorkspaceProvider, useWorkspace } from "../workspace-context";
import {
  ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY,
  readActiveWorkspacePreference,
  writeActiveWorkspacePreference,
} from "../active-workspace-preference";
import {
  getOfflinePrincipalId,
  setOfflinePrincipalId,
} from "../offline-identity";
import { clearSensitiveSession } from "@/lib/session";

const WS_PERSONAL = "11111111-1111-4111-8111-111111111111";
const WS_FAMILY = "22222222-2222-4222-8222-222222222222";
const WS_UNKNOWN = "33333333-3333-4333-8333-333333333333";

const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceMembers: vi.fn(),
  fetchPendingInvites: vi.fn(),
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
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("../socket-registry", () => ({ closeAllSockets: api.closeAllSockets }));
vi.mock("@/lib/api/client", () => ({
  isApiConfigured: () => true,
  getAuthToken: () => "user-1",
  setActiveWorkspaceId: vi.fn((id: string) => {
    clientState.active = id;
  }),
  clearActiveWorkspaceId: vi.fn(() => {
    clientState.active = undefined;
  }),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
}));

function Probe() {
  const { activeWorkspace, workspaces, selectWorkspace } = useWorkspace();
  return (
    <>
      <div data-testid="active-id">{activeWorkspace?.id ?? "none"}</div>
      <div data-testid="active-name">{activeWorkspace?.name ?? "none"}</div>
      {workspaces.map((workspace) => (
        <button key={workspace.id} onClick={() => void selectWorkspace(workspace.id)}>
          {workspace.name}
        </button>
      ))}
    </>
  );
}

function mockWorkspaceList(familyStatus: "active" | "archived" = "active") {
  api.fetchWorkspaces.mockResolvedValue([
    { id: WS_PERSONAL, name: "junio", kind: "personal", role: "owner", status: "active" },
    { id: WS_FAMILY, name: "Test Family", kind: "shared", role: "owner", status: familyStatus },
  ]);
}

describe("active workspace preference across reload", () => {
  beforeEach(() => {
    localStorage.clear();
    clientState.active = undefined;
    api.fetchWorkspaces.mockReset();
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
    mockWorkspaceList();
    setOfflinePrincipalId("user-1");
  });

  it("restores the persisted selection and header on fresh boot when still a member", async () => {
    expect(writeActiveWorkspacePreference("user-1", WS_FAMILY)).toBe(true);

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("active-name")).toHaveTextContent("Test Family");
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_FAMILY);
    // The API client header follows the restored workspace (writes land there).
    await waitFor(() => expect(clientState.active).toBe(WS_FAMILY));
  });

  it("survives a provider remount after in-session selection (reload simulation)", async () => {
    const user = userEvent.setup();
    const first = render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("junio");

    await user.click(screen.getByRole("button", { name: "Test Family" }));
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Test Family");
    await waitFor(() => expect(clientState.active).toBe(WS_FAMILY));
    // The switch keeps the user principal (rebindable) while persisting.
    expect(getOfflinePrincipalId()).toBe("user-1");

    // Full reload: unmount destroys the in-memory id; the fresh provider
    // must come back on Test Family, never on the first workspace.
    first.unmount();
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Test Family");
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_FAMILY);
    await waitFor(() => expect(clientState.active).toBe(WS_FAMILY));
  });

  it("falls back to the first accessible workspace and persists the fallback when the stored id is no longer a member", async () => {
    expect(writeActiveWorkspacePreference("user-1", WS_UNKNOWN)).toBe(true);

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("active-name")).toHaveTextContent("junio");
    await waitFor(() => expect(clientState.active).toBe(WS_PERSONAL));
    expect(readActiveWorkspacePreference("user-1")).toBe(WS_PERSONAL);
  });

  it("falls back when the stored workspace is archived", async () => {
    mockWorkspaceList("archived");
    expect(writeActiveWorkspacePreference("user-1", WS_FAMILY)).toBe(true);

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("active-name")).toHaveTextContent("junio");
    await waitFor(() => expect(clientState.active).toBe(WS_PERSONAL));
    expect(readActiveWorkspacePreference("user-1")).toBe(WS_PERSONAL);
  });

  it("ignores corrupt or non-UUID stored entries", async () => {
    localStorage.setItem(ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY, "not-json{{{");

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("active-name")).toHaveTextContent("junio");
    await waitFor(() => expect(clientState.active).toBe(WS_PERSONAL));
  });

  it("never inherits the previous user's workspace (identity partition)", async () => {
    expect(writeActiveWorkspacePreference("user-A", WS_FAMILY)).toBe(true);
    setOfflinePrincipalId("user-B");

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("active-name")).toHaveTextContent("junio");
    await waitFor(() => expect(clientState.active).toBe(WS_PERSONAL));
    // The previous user's binding is not readable under the new identity…
    expect(readActiveWorkspacePreference("user-A")).toBeNull();
    // …and the boot persisted the fallback under the current principal.
    expect(readActiveWorkspacePreference("user-B")).toBe(WS_PERSONAL);
  });

  it("wipes the preference on full identity teardown (logout/revocation)", async () => {
    expect(writeActiveWorkspacePreference("user-1", WS_FAMILY)).toBe(true);

    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
      clearOfflineIdentity: true,
    });

    expect(localStorage.getItem(ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY)).toBeNull();
    expect(getOfflinePrincipalId()).toBeNull();
  });
});
