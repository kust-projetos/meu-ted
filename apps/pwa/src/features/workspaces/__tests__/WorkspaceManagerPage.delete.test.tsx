import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";
import type { WorkspaceContextValue } from "@/lib/auth/workspace-context";
import type { DeletionInventory } from "@/lib/api/workspaces";

const emptyInventory: DeletionInventory = {
  workspaceId: "ws-arquivado",
  inventoryVersion: "a".repeat(64),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  empty: true,
  counts: { accounts: 0, transactions: 0, memberships_active: 1 },
  purgeBlocked: true,
  agentAttestation: "unverified",
};

const fullInventory: DeletionInventory = {
  ...emptyInventory,
  empty: false,
  counts: { accounts: 2, transactions: 5, memberships_active: 1 },
};

const context: WorkspaceContextValue = vi.hoisted(() => ({
  workspaces: [
    { id: "ws-arquivado", name: "Antigo", kind: "shared" as const, role: "owner" as const, status: "archived" as const },
  ],
  activeWorkspace: null,
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
 * D2 (ADR-027): exclusão permanente só de workspace vazio, com
 * confirmação forte (inventário versionado + nome digitado).
 * Purge com-dados nunca é oferecido.
 */
describe("WorkspaceManagerPage — delete só-vazio (D2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(context.fetchDeletionInventory).mockResolvedValue(emptyInventory);
    vi.mocked(context.deleteWorkspace).mockResolvedValue({
      id: "ws-arquivado",
      deletedAt: new Date().toISOString(),
      inventoryVersion: emptyInventory.inventoryVersion,
    });
  });

  it("abre o diálogo de exclusão com inventário e exige o nome digitado", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    await waitFor(() =>
      expect(context.fetchDeletionInventory).toHaveBeenCalledWith("ws-arquivado"),
    );
    expect(await screen.findByText(/será excluído permanentemente/i)).toBeInTheDocument();

    // Sem o nome exato, o botão permanece desabilitado.
    const confirmButton = screen.getByRole("button", { name: "Excluir permanentemente" });
    expect(confirmButton).toBeDisabled();
    await user.type(screen.getByLabelText(/para confirmar/i), "Antigo");
    expect(confirmButton).not.toBeDisabled();

    await user.click(confirmButton);
    await waitFor(() =>
      expect(context.deleteWorkspace).toHaveBeenCalledWith("ws-arquivado", {
        workspaceId: "ws-arquivado",
        inventoryVersion: emptyInventory.inventoryVersion,
        expiresAt: emptyInventory.expiresAt,
      }),
    );
  });

  it("bloqueia a exclusão quando o inventário não está vazio (sem purge)", async () => {
    const user = userEvent.setup();
    vi.mocked(context.fetchDeletionInventory).mockResolvedValueOnce(fullInventory);
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    expect(await screen.findByText(/possui dados e não pode ser excluído/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Excluir permanentemente" })).not.toBeInTheDocument();
    expect(context.deleteWorkspace).not.toHaveBeenCalled();
  });
});
