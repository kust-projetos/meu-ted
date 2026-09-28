import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import type { WorkspaceContextValue } from "@/lib/auth/workspace-context";

const mockContext: { value: WorkspaceContextValue } = vi.hoisted(() => ({
  value: {
    workspaces: [
      { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" as const, status: "active" as const },
      { id: "ws-2", name: "Empresa LTDA", kind: "shared" as const, role: "member" as const, status: "active" as const },
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
  },
}));

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  return {
    ...actual,
    useWorkspace: () => mockContext.value,
    useWorkspaceSafe: () => mockContext.value,
  };
});

describe("WorkspaceSwitcher Component (Task 9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.value = {
      workspaces: [
        { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" as const, status: "active" as const },
        { id: "ws-2", name: "Empresa LTDA", kind: "shared" as const, role: "member" as const, status: "active" as const },
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
    };
  });

  it("renders loading state when workspace context is loading", () => {
    mockContext.value = {
      ...mockContext.value,
      loading: true,
      workspaces: [],
      activeWorkspace: null,
    };

    render(<WorkspaceSwitcher />);
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
  });

  it("does not render Offline when workspace loading fails due to authorization error", () => {
    mockContext.value = {
      ...mockContext.value,
      workspaces: [],
      activeWorkspace: null,
      error: "Token inválido",
    };

    render(<WorkspaceSwitcher />);
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
    expect(screen.getByText("Não autorizado")).toBeInTheDocument();
  });

  it("renders clear local-data copy (no bare Offline) when workspace loading fails due to network or backend unavailability", () => {
    mockContext.value = {
      ...mockContext.value,
      workspaces: [],
      activeWorkspace: null,
      error: "API offline",
    };

    render(<WorkspaceSwitcher />);
    expect(screen.getByText("Sem conexão")).toBeInTheDocument();
    expect(screen.getByTitle("Sem conexão – dados locais")).toBeInTheDocument();
    expect(screen.queryByText("Não autorizado")).not.toBeInTheDocument();
  });

  it("renders hero variant styling for authorization error badge", () => {
    mockContext.value = {
      ...mockContext.value,
      workspaces: [],
      activeWorkspace: null,
      error: "HTTP 401",
    };

    render(<WorkspaceSwitcher variant="hero" />);
    const badge = screen.getByText("Não autorizado").closest("div");
    expect(badge).toHaveAttribute("data-variant", "hero");
    expect(badge?.className).toContain("border-danger/40");
  });

  it("renders active workspace name and toggles dropdown list", async () => {
    const user = userEvent.setup();

    render(<WorkspaceSwitcher compact />);
    const trigger = screen.getByRole("button", { name: /selecionar espaço/i });
    expect(trigger).toHaveTextContent("Minhas Finanças");

    // Open dropdown
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("Empresa LTDA")).toBeInTheDocument();

    // Select other workspace
    await user.click(screen.getByRole("option", { name: /Empresa LTDA/i }));
    expect(mockContext.value.selectWorkspace).toHaveBeenCalledWith("ws-2");
  });

  it("keeps archived workspaces out of quick selection and links to management", async () => {
    const user = userEvent.setup();
    mockContext.value = {
      ...mockContext.value,
      workspaces: [
        { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner", status: "active" as const },
        { id: "ws-2", name: "Empresa Arquivada", kind: "shared" as const, role: "owner", status: "archived" as const },
      ],
      activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner", status: "active" as const },
    };

    render(<WorkspaceSwitcher compact />);
    await user.click(screen.getByRole("button", { name: /selecionar espaço/i }));

    expect(screen.queryByRole("option", { name: /Empresa Arquivada/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Gerenciar espaços" })).toHaveAttribute("href", "/workspaces");
  });

  it("renders default variant with surface-1 styling by default", () => {
    render(<WorkspaceSwitcher compact />);
    const trigger = screen.getByRole("button", { name: /selecionar espaço/i });
    expect(trigger.className).toContain("bg-surface-1");
    expect(trigger.className).toContain("border-border-subtle");
    expect(trigger).toHaveAttribute("data-variant", "default");
  });

  it("renders hero variant with translucent styling and white text", () => {
    render(<WorkspaceSwitcher variant="hero" compact />);
    const trigger = screen.getByRole("button", { name: /selecionar espaço/i });
    expect(trigger).toHaveAttribute("data-variant", "hero");
    expect(trigger.className).toContain("bg-white/[0.14]");
    expect(trigger.className).toContain("border-white/15");
    expect(trigger.querySelector(".text-white")).toBeInTheDocument();
  });

  it("renders hero loading state with translucent styling", () => {
    mockContext.value = {
      ...mockContext.value,
      loading: true,
      workspaces: [],
      activeWorkspace: null,
    };

    render(<WorkspaceSwitcher variant="hero" compact />);
    const loadingEl = screen.getByText("Carregando…").closest("div");
    expect(loadingEl).toHaveAttribute("data-variant", "hero");
    expect(loadingEl?.className).toContain("bg-white/[0.14]");
    expect(loadingEl?.className).toContain("border-white/15");
  });

  it("supports opening and selecting workspace in hero variant", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher variant="hero" compact />);
    const trigger = screen.getByRole("button", { name: /selecionar espaço/i });

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Empresa LTDA/i }));
    expect(mockContext.value.selectWorkspace).toHaveBeenCalledWith("ws-2");
  });

  it("only closes after selectWorkspace settles, so the label never announces a workspace whose header is not committed yet", async () => {
    const user = userEvent.setup();
    let resolveSelect!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSelect = resolve;
    });
    mockContext.value = {
      ...mockContext.value,
      selectWorkspace: vi.fn(() => pending),
    };

    render(<WorkspaceSwitcher compact />);
    await user.click(screen.getByRole("button", { name: /selecionar espaço/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Empresa LTDA/i }));
    expect(mockContext.value.selectWorkspace).toHaveBeenCalledWith("ws-2");
    // While the switch commits, the dropdown stays open and options lock.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Empresa LTDA/i })).toBeDisabled();

    resolveSelect();
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("swallows a selectWorkspace rejection: the dropdown still closes and no unhandled rejection escapes the void onClick", async () => {
    const user = userEvent.setup();
    const rejections: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      let rejectSelect!: (reason?: unknown) => void;
      mockContext.value = {
        ...mockContext.value,
        selectWorkspace: vi.fn(
          () =>
            new Promise<void>((_, reject) => {
              rejectSelect = reject;
            }),
        ),
      };

      render(<WorkspaceSwitcher compact />);
      await user.click(screen.getByRole("button", { name: /selecionar espaço/i }));
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      await user.click(screen.getByRole("option", { name: /Empresa LTDA/i }));
      expect(mockContext.value.selectWorkspace).toHaveBeenCalledWith("ws-2");
      // While the switch commits, the dropdown stays open and options lock.
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      await act(async () => {
        rejectSelect(new Error("Network down"));
      });
      await waitFor(() =>
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
      );
      // The label still names the committed workspace (the failure is
      // modeled in context error state, never announced as the new label).
      expect(
        screen.getByRole("button", { name: /selecionar espaço/i }),
      ).toHaveTextContent("Minhas Finanças");

      // Single event-loop yield so a leaked rejection would have dispatched
      // its unhandledrejection by now — a settle flush, not a race barrier.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  it("surfaces a selectWorkspace rejection inline: menu closes, label stays coherent, reason is announced", async () => {
    const user = userEvent.setup();
    let rejectSelect!: (reason?: unknown) => void;
    mockContext.value = {
      ...mockContext.value,
      selectWorkspace: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectSelect = reject;
          }),
      ),
    };

    render(<WorkspaceSwitcher compact />);
    await user.click(screen.getByRole("button", { name: /selecionar espaço/i }));
    await user.click(screen.getByRole("option", { name: /Empresa LTDA/i }));

    await act(async () => {
      rejectSelect(new Error("Network down"));
    });
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    const alert = await screen.findByTestId("workspace-switch-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Network down");
    expect(
      screen.getByRole("button", { name: /selecionar espaço/i }),
    ).toHaveTextContent("Minhas Finanças");
  });

  it("shows the modeled authorization error inline when the list is non-empty", async () => {
    const user = userEvent.setup();
    mockContext.value = {
      ...mockContext.value,
      error: "Token inválido",
    };

    render(<WorkspaceSwitcher compact />);
    const alert = await screen.findByTestId("workspace-switch-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Token inválido");
    // Switcher stays usable: trigger keeps the committed label and the menu opens.
    expect(
      screen.getByRole("button", { name: /selecionar espaço/i }),
    ).toHaveTextContent("Minhas Finanças");
    await user.click(screen.getByRole("button", { name: /selecionar espaço/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("shows the modeled network error inline when the list is non-empty", async () => {
    mockContext.value = {
      ...mockContext.value,
      error: "API offline",
    };

    render(<WorkspaceSwitcher compact />);
    const alert = await screen.findByTestId("workspace-switch-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("API offline");
    expect(
      screen.getByRole("button", { name: /selecionar espaço/i }),
    ).toHaveTextContent("Minhas Finanças");
  });
});
