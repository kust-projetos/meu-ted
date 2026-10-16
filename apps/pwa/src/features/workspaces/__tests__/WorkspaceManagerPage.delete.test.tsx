import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";
import type { WorkspaceContextValue } from "@/lib/auth/workspace-context";
import type { DeletionInventory, EmptyDeposit } from "@/lib/api/workspaces";

const emptyInventory: DeletionInventory = {
  workspaceId: "ws-arquivado",
  inventoryVersion: "a".repeat(64),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  empty: true,
  counts: { accounts: 0, transactions: 0, memberships_active: 1 },
  purgeBlocked: true,
  agentAttestation: "unverified",
};

const deposited: EmptyDeposit = {
  attestationId: "22222222-2222-4222-8222-222222222222",
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
 * D2 (ADR-027) + FIX-WS-D2-R5: exclusão permanente só de workspace vazio,
 * em 2 passos (1. inventário PG; 2. depósito server-side do Agent com
 * handle opaco) com confirmação forte (versão + nome digitado). O PWA só
 * transporta o UUID opaco — nunca conteúdo/HMAC (invariante A8). Purge
 * com-dados nunca é oferecido.
 */
describe("WorkspaceManagerPage — delete só-vazio (D2 + R5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(context.fetchDeletionInventory).mockResolvedValue(emptyInventory);
    vi.mocked(context.requestAgentEmptyAttestation).mockResolvedValue(deposited);
    vi.mocked(context.deleteWorkspace).mockResolvedValue({
      id: "ws-arquivado",
      deletedAt: new Date().toISOString(),
      inventoryVersion: emptyInventory.inventoryVersion,
    });
  });

  it("fluxo em 2 passos: inventário PG vazio → depósito Agent → delete com SÓ o handle opaco", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Excluir Antigo" }));
    await waitFor(() =>
      expect(context.fetchDeletionInventory).toHaveBeenCalledWith("ws-arquivado"),
    );
    // Passo 2: o depósito é pedido ao Agent vinculado à versão do inventário.
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
        attestationId: deposited.attestationId,
      }),
    );
    // O fio nunca carrega conteúdo/HMAC da prova — só o handle opaco.
    const sent = vi.mocked(context.deleteWorkspace).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toContain("hmac");
    expect(JSON.stringify(sent)).not.toContain("sessions");
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
