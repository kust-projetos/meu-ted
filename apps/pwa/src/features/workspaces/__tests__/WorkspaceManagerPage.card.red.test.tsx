import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import WorkspaceManagerPage from "../WorkspaceManagerPage";

const context = vi.hoisted(() => ({
  workspaces: [
    { id: "ws-shared-1", name: "Empresa Compartilhada", kind: "shared" as const, role: "owner" as const, status: "active" as const },
    { id: "ws-personal-1", name: "Pessoal", kind: "personal" as const, role: "owner" as const, status: "active" as const },
  ],
  activeWorkspace: { id: "ws-shared-1", name: "Empresa Compartilhada", kind: "shared" as const, role: "owner" as const, status: "active" as const },
  members: [
    { userId: "user-1", name: "Alice Owner", email: "alice@example.com", role: "owner" as const },
    { userId: "user-2", name: "Bob Member", email: "bob@example.com", role: "member" as const },
  ],
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

// Mock audit logs endpoint
vi.mock("@/lib/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/endpoints")>();
  return {
    ...actual,
    fetchAuditLogs: vi.fn().mockResolvedValue({
      items: [
        { id: "log-1", workspaceId: "ws-shared-1", actorType: "user", actorId: "user-1", operation: "workspace.rename", eventType: "workspace.rename", payloadHash: "abc", metadata: {}, createdAt: "2026-09-01T10:00:00.000Z" },
      ],
      total: 1,
    }),
  };
});

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api/client");
  return {
    ...actual,
    apiFetch: vi.fn().mockImplementation((path: string) => {
      if (path.includes("/audit-logs")) {
        return Promise.resolve({
          items: [
            { id: "log-1", workspaceId: "ws-shared-1", actorType: "user", actorId: "user-1", operation: "workspace.rename", eventType: "workspace.rename", payloadHash: "abc", metadata: {}, createdAt: "2026-09-01T10:00:00.000Z" },
          ],
          total: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    }),
  };
});

describe("WorkspaceManagerPage card enhancements (RED -> GREEN)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shared workspace card shows invite-by-email field inside the card", () => {
    render(<WorkspaceManagerPage />);
    const cards = document.querySelectorAll("article");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const sharedCard = Array.from(document.querySelectorAll("article")).find(el => el.textContent?.includes("Empresa Compartilhada"));
    expect(sharedCard).toBeDefined();
    // Card must contain an email invite input specifically within the card
    const emailInputInCard = sharedCard!.querySelector("input[type='email'], input[aria-label*='convidado' i], input[placeholder*='email' i]");
    // Also check by label
    const hasInviteInput = !!emailInputInCard || !!sharedCard!.querySelector("input[id*='invite']");
    expect(hasInviteInput).toBe(true);
    // Button invite inside card
    const inviteButtonInCard = Array.from(sharedCard!.querySelectorAll("button")).find(b => /Convidar/i.test(b.textContent || ""));
    expect(inviteButtonInCard).toBeDefined();
  });

  it("shared workspace card displays members list with usernames", () => {
    render(<WorkspaceManagerPage />);
    // Members should be visible inside the shared card
    expect(screen.getByText("Alice Owner")).toBeInTheDocument();
    expect(screen.getByText("Bob Member")).toBeInTheDocument();
    // Emails should also be visible
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("shared workspace card has Logs button that opens audit modal", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManagerPage />);
    const logsButton = screen.getAllByRole("button", { name: /Logs/i })[0];
    expect(logsButton).toBeInTheDocument();
    await user.click(logsButton);
    // Modal should appear with history
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Should show audit log content (operation name) specifically inside modal list
    await waitFor(() => expect(screen.getAllByText("workspace.rename").length).toBeGreaterThanOrEqual(1));
  });

  it("personal workspace card does NOT show invite or members list", () => {
    render(<WorkspaceManagerPage />);
    // Personal card should not have members list - but shared does
    // We verify that personal workspace name exists but doesn't have invite field for personal
    expect(screen.getByRole("heading", { name: "Pessoal" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/E-mail do convidado/i).length).toBeGreaterThan(0);
    const personalCard = Array.from(document.querySelectorAll("article")).find(el => el.textContent?.includes("Pessoal"));
    expect(personalCard).toBeDefined();
    expect(personalCard!.querySelector("input[type='email']")).toBeNull();
  });
});
