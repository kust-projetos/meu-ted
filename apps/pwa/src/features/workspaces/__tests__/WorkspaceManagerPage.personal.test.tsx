import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";
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
  fetchDeletionInventory: vi.fn(),
  requestAgentEmptyAttestation: vi.fn(),
  deleteWorkspace: vi.fn(),
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
 * D1 (ADR-027): N personal workspaces per user. The one-personal FIX-167
 * gate (disabled kind + restore guidance + 409 mapping) is gone: creating
 * another personal workspace POSTs normally.
 */
describe("WorkspaceManagerPage — N personal workspaces (D1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the Pessoal kind enabled even with an existing (archived) personal workspace", () => {
    render(<WorkspaceManagerPage />);

    const kindSelect = screen.getByLabelText("Tipo");
    const personalOption = kindSelect.querySelector('option[value="personal"]');
    expect(personalOption).not.toBeNull();
    expect(personalOption).not.toHaveAttribute("disabled");
    expect(screen.queryByText(/você já possui um workspace pessoal/i)).not.toBeInTheDocument();
  });

  it("creates a second personal workspace without a pre-POST block", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    await user.type(screen.getByLabelText("Nome do workspace"), "Outra pessoal");
    await user.selectOptions(screen.getByLabelText("Tipo"), "personal");
    await user.click(screen.getByRole("button", { name: "Criar workspace" }));

    expect(context.createWorkspace).toHaveBeenCalledWith({ name: "Outra pessoal", kind: "personal" });
  });

  it("surfaces server errors verbatim instead of the one-personal restore guidance", async () => {
    const user = userEvent.setup();
    vi.mocked(context.createWorkspace).mockRejectedValueOnce(new Error("Falha de rede."));
    render(<WorkspaceManagerPage />);

    await user.type(screen.getByLabelText("Nome do workspace"), "Time novo");
    await user.click(screen.getByRole("button", { name: "Criar workspace" }));

    expect(context.createWorkspace).toHaveBeenCalledWith({ name: "Time novo", kind: "shared" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha de rede.");
  });
});
