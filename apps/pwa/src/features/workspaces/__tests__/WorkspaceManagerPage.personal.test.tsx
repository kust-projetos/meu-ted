import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";
import { ApiError } from "@/lib/api/client";
import type { WorkspaceContextValue } from "@/lib/auth/workspace-context";

const context: WorkspaceContextValue = vi.hoisted(() => ({
  workspaces: [
    { id: "ws-archived-personal", name: "Minhas Finanças", kind: "personal" as const, role: "owner" as const, status: "archived" as const },
    { id: "ws-team", name: "Empresa LTDA", kind: "shared" as const, role: "owner" as const, status: "active" as const },
  ],
  activeWorkspace: { id: "ws-team", name: "Empresa LTDA", kind: "shared" as const, role: "owner" as const, status: "active" as const },
  members: [],
  pendingInvites: [],
  ownershipTransfers: [],
  loading: false,
  membersLoading: false,
  pendingInvitesLoading: false,
  ownershipTransfersLoading: false,
  error: null,
  selectWorkspace: vi.fn(),
  refreshWorkspaces: vi.fn(),
  refreshMembers: vi.fn(),
  refreshPendingInvites: vi.fn(),
  refreshOwnershipTransfers: vi.fn(),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  inviteMember: vi.fn(),
  resendInvite: vi.fn(),
  revokeInvite: vi.fn(),
  acceptInvite: vi.fn(),
  removeMember: vi.fn(),
  transferOwnership: vi.fn(),
  acceptTransfer: vi.fn(),
  leave: vi.fn(),
}));

vi.mock("@/lib/auth/workspace-context", () => ({
  useWorkspace: () => context,
  useWorkspaceSafe: () => context,
}));

/**
 * FIX-168-167 (P0 #167): creating a second personal workspace answers 409
 * workspace.invalid (the one-personal rule counts archived workspaces too —
 * kept by design, D1/D2 pending). The UI must explain this BEFORE any POST
 * and offer the restore path instead of surfacing a raw 409.
 *
 * RED first: no explanation, no restore affordance, POST fires blindly.
 */
describe("WorkspaceManagerPage — existing personal workspace (FIX-167)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains that a personal workspace already exists and offers restore instead of a blind create", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    // The archived personal workspace is visible for restore (card action…
    // …plus the form-level restore affordance added by FIX-167).
    expect(
      screen.getAllByRole("button", { name: "Restaurar Minhas Finanças" }),
    ).toHaveLength(2);

    // …the Pessoal kind is disabled with an explanation…
    const kindSelect = screen.getByLabelText("Tipo");
    const personalOption = kindSelect.querySelector('option[value="personal"]');
    expect(personalOption).not.toBeNull();
    expect(personalOption).toHaveAttribute("disabled");
    expect(screen.getByText(/você já possui um workspace pessoal/i)).toBeInTheDocument();

    // …and attempting a personal create never POSTs (stale/programmatic kind
    // selection — the disabled option already blocks the pointer path).
    await user.type(screen.getByLabelText("Nome do workspace"), "Outra pessoal");
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "personal" } });
    await user.click(screen.getByRole("button", { name: "Criar workspace" }));
    expect(context.createWorkspace).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/você já possui um workspace pessoal/i),
    );
  });

  it("maps a 409 workspace.invalid create rejection to the friendly restore guidance", async () => {
    const user = userEvent.setup();
    vi.mocked(context.createWorkspace).mockRejectedValueOnce(
      new ApiError(409, "workspace.invalid", "Usuário já possui um workspace pessoal."),
    );
    render(<WorkspaceManagerPage />);

    await user.type(screen.getByLabelText("Nome do workspace"), "Time novo");
    await user.click(screen.getByRole("button", { name: "Criar workspace" }));

    expect(context.createWorkspace).toHaveBeenCalledWith({ name: "Time novo", kind: "shared" });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/você já possui um workspace pessoal/i),
    );
  });
});
