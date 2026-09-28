import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";

vi.mock("next/font/local", () => ({
  default: (opts: { variable?: string }) => ({ variable: opts?.variable ?? "--font-mock" }),
}));

const baseContext = vi.hoisted(() => ({
  workspaces: [
    { id: "ws-1", name: "Empresa", kind: "shared" as const, role: "owner" as const, status: "active" as const },
  ],
  activeWorkspace: { id: "ws-1", name: "Empresa", kind: "shared" as const, role: "owner" as const, status: "active" as const },
  members: [
    { userId: "u1", name: "Alice", email: "alice@example.com", role: "owner" as const },
    { userId: "u2", name: "Bob", email: "bob@example.com", role: "member" as const },
  ],
  pendingInvites: [
    { id: "inv-1", householdId: "ws-1", email: "pending@example.com", role: "member" as const, expiresAt: "2026-12-31T00:00:00.000Z" },
  ],
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
  useWorkspace: () => baseContext,
  useWorkspaceSafe: () => baseContext,
}));

// V4.1 Phase 5 (SPEC §12.6): the browser defaults to the same-origin proxy,
// so this UI suite pins the unconfigured mock-data provider path explicitly.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, isApiConfigured: () => false };
});

describe("TASK1 - PWA Mobile enhancements (GREEN)", () => {
  describe("Zoom liberado (A5 / WCAG 1.4.4)", () => {
    it("viewport permite pinch-zoom (sem maximumScale/userScalable false)", async () => {
      const { viewport } = await import("@/app/layout");
      expect(viewport.width).toBe("device-width");
      expect(viewport.initialScale).toBe(1);
      expect(viewport.maximumScale).toBeUndefined();
      expect(viewport.userScalable).not.toBe(false);
      expect(viewport.minimumScale).toBeUndefined();
      expect(viewport.viewportFit).toBe("cover");
    }, 60000);
  });

  describe("Validacao Email Duplicado", () => {

    beforeEach(() => vi.clearAllMocks());

    it("mostra erro ao tentar convidar email já membro (duplicado)", async () => {
      const { default: WorkspaceManagerPage } = await import("../WorkspaceManagerPage");
      const user = userEvent.setup();
      render(<WorkspaceManagerPage />);
      // Usa o campo específico do aside (invite-email) que dispara handleInvite
      const input = document.getElementById("invite-email") as HTMLInputElement;
      expect(input).toBeTruthy();
      await user.clear(input);
      await user.type(input, "ALICE@example.com");
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Convidar membro") as HTMLButtonElement;
      expect(btn).toBeTruthy();
      await user.click(btn);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/já.*membro|duplicado/i));
      expect(baseContext.inviteMember).not.toHaveBeenCalled();
    });

    it("mostra erro ao tentar convidar email já pendente", async () => {
      const { default: WorkspaceManagerPage } = await import("../WorkspaceManagerPage");
      const user = userEvent.setup();
      render(<WorkspaceManagerPage />);
      const input = document.getElementById("invite-email") as HTMLInputElement;
      expect(input).toBeTruthy();
      await user.clear(input);
      await user.type(input, "pending@example.com");
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Convidar membro") as HTMLButtonElement;
      expect(btn).toBeTruthy();
      await user.click(btn);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/já.*convite|pendente|duplicado/i));
      expect(baseContext.inviteMember).not.toHaveBeenCalled();
    });
  });

  describe("Menu Extensivel Categorias", () => {
    it("seções Despesas e Receitas são extensíveis (colapsar/expandir)", async () => {
      const { default: CategoriesPage } = await import("@/features/categories/CategoriesPage");
      const user = userEvent.setup();
      render(<CategoriesPage />);
      // Header agora é button com aria-expanded
      const despesaToggle = screen.getByRole("button", { name: /Despesas/i });
      expect(despesaToggle).toBeInTheDocument();
      expect(despesaToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Alimentação")).toBeInTheDocument();
      await user.click(despesaToggle);
      await waitFor(() => expect(screen.queryByText("Alimentação")).not.toBeInTheDocument());
      expect(despesaToggle).toHaveAttribute("aria-expanded", "false");
      await user.click(despesaToggle);
      await waitFor(() => expect(screen.getByText("Alimentação")).toBeInTheDocument());
    });

    it("Receitas também é extensível", async () => {
      const { default: CategoriesPage } = await import("@/features/categories/CategoriesPage");
      const user = userEvent.setup();
      render(<CategoriesPage />);
      const receitaToggle = screen.getByRole("button", { name: /Receitas/i });
      expect(receitaToggle).toBeInTheDocument();
      expect(screen.getByText("Salário")).toBeInTheDocument();
      await user.click(receitaToggle);
      await waitFor(() => expect(screen.queryByText("Salário")).not.toBeInTheDocument());
      await user.click(receitaToggle);
      await waitFor(() => expect(screen.getByText("Salário")).toBeInTheDocument());
    });
  });
});
