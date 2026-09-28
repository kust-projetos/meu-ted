import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";
import { ApiError } from "@/lib/api/client";
import type { WorkspaceContextValue } from "@/lib/auth/workspace-context";

const context: WorkspaceContextValue = vi.hoisted(() => ({
  workspaces: [
    { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" as const, status: "active" as const },
    { id: "ws-2", name: "Empresa LTDA", kind: "shared" as const, role: "owner" as const, status: "archived" as const },
  ],
  activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" as const, status: "active" as const },
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

describe("WorkspaceManagerPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders active and archived workspaces with role and lifecycle state", () => {
    render(<WorkspaceManagerPage />);

    expect(screen.getByRole("heading", { name: "Meus Espaços" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Minhas Finanças" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Empresa LTDA" })).toBeInTheDocument();
    expect(screen.getByText("Ativo")).toBeInTheDocument();
    expect(screen.getByText("Arquivado")).toBeInTheDocument();
  });

  it("creates a workspace from the manager form", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    await user.type(screen.getByLabelText("Nome do workspace"), "Novo time");
    await user.click(screen.getByRole("button", { name: "Criar workspace" }));

    expect(context.createWorkspace).toHaveBeenCalledWith({ name: "Novo time", kind: "shared" });
  });

  it("confirms archive and restores an archived workspace", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);

    await user.click(screen.getByRole("button", { name: "Arquivar Minhas Finanças" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Arquivar workspace?");
    await user.click(screen.getByRole("button", { name: "Arquivar workspace" }));
    expect(context.archiveWorkspace).toHaveBeenCalledWith("ws-1");

    await user.click(screen.getByRole("button", { name: "Restaurar Empresa LTDA" }));
    expect(context.restoreWorkspace).toHaveBeenCalledWith("ws-2");
  });

  it("owner manages pending invites and initiates ownership transfer in shared workspace", async () => {
    const user = userEvent.setup();
    context.activeWorkspace = { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "owner", status: "active" };
    context.members = [
      { userId: "user-1", name: "Alice Owner", email: "alice@example.com", role: "owner", status: "active" },
      { userId: "user-2", name: "Bob Member", email: "bob@example.com", role: "member", status: "active" },
    ];
    context.pendingInvites = [
      { id: "inv-1", householdId: "ws-2", email: "convidado@example.com", role: "member", expiresAt: "2026-09-07T12:00:00.000Z" },
    ];
    context.ownershipTransfers = [];

    render(<WorkspaceManagerPage />);

    // Check pending invite visibility without tokens/hashes
    expect(screen.getByText("convidado@example.com")).toBeInTheDocument();
    expect(screen.queryByText("hash")).not.toBeInTheDocument();
    expect(screen.queryByText("token")).not.toBeInTheDocument();

    // Resend invite
    await user.click(screen.getByRole("button", { name: "Reenviar convite para convidado@example.com" }));
    expect(context.resendInvite).toHaveBeenCalledWith("inv-1");

    // Revoke invite with confirmation
    await user.click(screen.getByRole("button", { name: "Revogar convite para convidado@example.com" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Revogar convite?");
    await user.click(screen.getByRole("button", { name: "Revogar convite" }));
    expect(context.revokeInvite).toHaveBeenCalledWith("inv-1");

    // Initiate ownership transfer
    expect(screen.getByRole("heading", { name: "Transferir titularidade" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Novo titular"), "user-2");
    await user.click(screen.getByRole("button", { name: "Transferir titularidade" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Transferir titularidade do workspace?");
    await user.click(screen.getByRole("button", { name: "Confirmar transferência" }));
    expect(context.transferOwnership).toHaveBeenCalledWith("user-2");
  });

  it("lists accepted members with role and active status (item 9 regression)", () => {
    context.activeWorkspace = { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "owner", status: "active" };
    context.workspaces = [
      { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "owner", status: "active" },
    ];
    context.members = [
      { userId: "user-1", name: "Alice Owner", email: "alice@example.com", role: "owner", status: "active" },
      { userId: "user-2", name: "Bob Member", email: "bob@example.com", role: "member", status: "active" },
    ];
    context.pendingInvites = [
      { id: "inv-1", householdId: "ws-2", email: "convidado@example.com", role: "member", expiresAt: "2026-09-07T12:00:00.000Z" },
    ];
    context.ownershipTransfers = [];
    render(<WorkspaceManagerPage />);

    // Accepted members appear with role + active status, not "Nenhum membro encontrado."
    expect(screen.getByText("Bob Member")).toBeInTheDocument();
    expect(screen.getByText("Membro")).toBeInTheDocument();
    expect(screen.getAllByText("Ativo").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Nenhum membro encontrado.")).not.toBeInTheDocument();
    // Pending invite is explicitly marked pending.
    expect(screen.getByText("convidado@example.com")).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();

    // Restore the shared context fixture for the tests below.
    context.workspaces = [
      { id: "ws-1", name: "Minhas Finanças", kind: "personal", role: "owner", status: "active" },
      { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "owner", status: "archived" },
    ];
    context.activeWorkspace = { id: "ws-1", name: "Minhas Finanças", kind: "personal", role: "owner", status: "active" };
    context.members = [];
    context.pendingInvites = [];
    context.ownershipTransfers = [];
  });

  it("member can invite a member via email form in shared workspace", async () => {
    const user = userEvent.setup();
    context.activeWorkspace = { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "member", status: "active" };
    context.members = [
      { userId: "user-1", name: "Alice Owner", email: "alice@example.com", role: "owner", status: "active" },
    ];
    context.pendingInvites = [];
    context.ownershipTransfers = [];
    render(<WorkspaceManagerPage />);

    expect(screen.getByRole("heading", { name: "Convidar membro" })).toBeInTheDocument();
    const input = screen.getByLabelText("E-mail do convidado");
    await user.type(input, "novo@example.com");
    await user.click(screen.getByRole("button", { name: "Convidar membro" }));
    expect(context.inviteMember).toHaveBeenCalledWith("novo@example.com");
  });

  it("owner can invite a member via email form in shared workspace", async () => {
    const user = userEvent.setup();
    context.activeWorkspace = { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "owner", status: "active" };
    context.members = [
      { userId: "user-1", name: "Alice Owner", email: "alice@example.com", role: "owner", status: "active" },
    ];
    context.pendingInvites = [];
    context.ownershipTransfers = [];
    render(<WorkspaceManagerPage />);

     expect(screen.getByRole("heading", { name: "Convidar membro" })).toBeInTheDocument();
     const input = screen.getByLabelText("E-mail do convidado");
     await user.type(input, "novo@example.com");
     await user.click(screen.getByRole("button", { name: "Convidar membro" }));
     expect(context.inviteMember).toHaveBeenCalledWith("novo@example.com");
   });

   it("shows clear error when member invites and backend returns invite_forbidden", async () => {
     const user = userEvent.setup();
      context.activeWorkspace = { id: "ws-2", name: "Empresa LTDA", kind: "shared", role: "member", status: "active" };
      context.members = [
        { userId: "user-1", name: "Alice Owner", email: "alice@example.com", role: "owner", status: "active" },
      ];
     context.pendingInvites = [];
     context.ownershipTransfers = [];
     context.inviteMember = vi.fn().mockRejectedValue(new ApiError(403, "auth.invite_forbidden", "invite creation is not authorized"));
     render(<WorkspaceManagerPage />);

     const input = screen.getByLabelText("E-mail do convidado");
     await user.type(input, "novo@example.com");
     await user.click(screen.getByRole("button", { name: "Convidar membro" }));
      await waitFor(() => expect(screen.getByText("Apenas o owner pode convidar quem ainda não possui conta.")).toBeInTheDocument());
    });

  it("retry after load error keeps inline error without unhandled rejection", async () => {
    const user = userEvent.setup();
    context.error = "Não foi possível carregar os workspaces.";
    context.refreshWorkspaces = vi.fn().mockRejectedValue(new Error("offline"));
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      render(<WorkspaceManagerPage />);

      await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
      await waitFor(() => expect(context.refreshWorkspaces).toHaveBeenCalled());
      // Allow a rejected refresh to surface as unhandled if the handler
      // does not consume it (the click handler must .catch after the
      // context already modeled the error).
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).toHaveLength(0);
      // The load error stays inline (manager banner with retry; the header
      // switcher mirrors the same context error) after a failed retry.
      expect(
        screen.getAllByText("Não foi possível carregar os workspaces.").length,
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
      context.error = null;
      context.refreshWorkspaces = vi.fn();
    }
  });
});
