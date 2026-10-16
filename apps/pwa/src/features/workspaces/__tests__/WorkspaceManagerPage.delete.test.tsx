import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";
import type { WorkspaceContextValue } from "@/lib/auth/workspace-context";
import type { AgentEmptyProof, DeletionInventory } from "@/lib/api/workspaces";

const emptyInventory: DeletionInventory = {
  workspaceId: "ws-arquivado",
  inventoryVersion: "a".repeat(64),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  empty: true,
  counts: { accounts: 0, transactions: 0, memberships_active: 1 },
  purgeBlocked: true,
  agentAttestation: "unverified",
};

const agentProof: AgentEmptyProof = {
  workspaceId: "ws-arquivado",
  inventoryVersion: emptyInventory.inventoryVersion,
  counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  hmac: "b".repeat(64),
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
 * D2 (ADR-027) + FIX-WS-D2-R4: exclusão permanente só de workspace vazio,
 * em 2 passos (1. inventário PG; 2. atestação HMAC do Agent) com
 * confirmação forte (versão + nome digitado). O PWA só transporta a prova
 * opaca. Purge com-dados nunca é oferecido.
 */
describe("WorkspaceManagerPage — delete só-vazio (D2 + R4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(context.fetchDeletionInventory).mockResolvedValue(emptyInventory);
    vi.mocked(context.requestAgentEmptyAttestation).mockResolvedValue(agentProof);
    vi.mocked(context.deleteWorkspace).mockResolvedValue({
      id: "ws-arquivado",
      deletedAt: new Date().toISOString(),
      inventoryVersion: emptyInventory.inventoryVersion,
    });
  });

  it("fluxo em 2 passos: inventário PG vazio → atestação Agent → delete com a prova opaca", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    await waitFor(() =>
      expect(context.fetchDeletionInventory).toHaveBeenCalledWith("ws-arquivado"),
    );
    // Passo 2: a prova é pedida ao Agent vinculada à versão do inventário.
    await waitFor(() =>
      expect(context.requestAgentEmptyAttestation).toHaveBeenCalledWith(
        "ws-arquivado",
        emptyInventory.inventoryVersion,
      ),
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
        agentAttestation: "unverified",
        agentProof,
      }),
    );
  });

  it("Agent com conteúdo bloqueia e mostra qual lado falhou (sem tentar o delete)", async () => {
    const user = userEvent.setup();
    const notEmpty = Object.assign(new Error("Exclusão bloqueada: o lado Agent possui conteúdo."), {
      code: "agent.workspace_not_empty",
      status: 409,
    });
    vi.mocked(context.requestAgentEmptyAttestation).mockRejectedValueOnce(notEmpty);
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    await waitFor(() =>
      expect(context.requestAgentEmptyAttestation).toHaveBeenCalledWith(
        "ws-arquivado",
        emptyInventory.inventoryVersion,
      ),
    );
    expect(await screen.findByText(/lado Agent.*ainda possui conteúdo/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Excluir permanentemente" })).not.toBeInTheDocument();
    expect(context.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("Agent indisponível mostra indisponibilidade (sem tentar o delete, com retry)", async () => {
    const user = userEvent.setup();
    const unavailable = Object.assign(new Error("Atestação indisponível."), {
      code: "agent.attestation_unavailable",
      status: 409,
    });
    vi.mocked(context.requestAgentEmptyAttestation).mockRejectedValueOnce(unavailable);
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    expect(await screen.findByText(/Atestação do lado Agent indisponível/i)).toBeInTheDocument();
    expect(context.deleteWorkspace).not.toHaveBeenCalled();
    // Retry re-pede a atestação (o mock seguinte resolve → diálogo conclui).
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() =>
      expect(context.requestAgentEmptyAttestation).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText(/será excluído permanentemente/i)).toBeInTheDocument();
  });

  it("bloqueia a exclusão quando o inventário não está vazio (sem purge, sem atestação)", async () => {
    const user = userEvent.setup();
    vi.mocked(context.fetchDeletionInventory).mockResolvedValueOnce(fullInventory);
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    expect(await screen.findByText(/possui dados e não pode ser excluído/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Excluir permanentemente" })).not.toBeInTheDocument();
    expect(context.requestAgentEmptyAttestation).not.toHaveBeenCalled();
    expect(context.deleteWorkspace).not.toHaveBeenCalled();
  });
});
