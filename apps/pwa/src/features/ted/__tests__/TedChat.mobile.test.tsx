import { describe, it, expect, vi } from "vitest";
import { render } from "@/lib/test-utils";
import { TedChat } from "../TedChat";
import * as agentAuth from "@/lib/api/agent-auth";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [],
    loading: false,
    membersLoading: false,
    error: null,
    selectWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    refreshMembers: vi.fn(),
    createWorkspace: vi.fn(),
    inviteMember: vi.fn(),
    acceptInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  };
  return { ...actual, useWorkspace: () => mockWs, useWorkspaceSafe: () => mockWs };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn().mockResolvedValue([]),
    sendAgentMessage: vi.fn().mockResolvedValue({ turnId: "t", status: "completed" }),
  };
});

describe("TedChat – PWA page layout (region + internal scroll + safe-area)", () => {
  it("renders a page region (never fixed/modal) filling its page wrapper", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
    const { container } = render(<TedChat />);
    const region = container.querySelector('[data-testid="ted-chat"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("region");
    // Page-bound: no fixed positioning, no backdrop on the chat itself —
    // viewport sizing lives in the TedChatPage wrapper.
    expect(region?.className ?? "").not.toMatch(/fixed/);
    expect(region?.className ?? "").not.toMatch(/bg-black/);
    expect(region?.className ?? "").toMatch(/h-full/);
    vi.restoreAllMocks();
  });

  it("message container evita scroll bleed e permite contido", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
    const { container } = render(<TedChat />);
    const scrollArea = container.querySelector(".overflow-y-auto");
    expect(scrollArea).not.toBeNull();
    const cls = scrollArea?.className ?? "";
    expect(cls).toMatch(/overscroll-contain/);
    // flex-1 with min-h-0 prevents overflow when keyboard opens
    expect(cls).toMatch(/flex-1/);
    // Check parent has min-h-0 or flex-1
    const parentCls = scrollArea?.parentElement?.className ?? "";
    // section should have flex flex-col
    expect(parentCls + cls).toMatch(/flex/);
    vi.restoreAllMocks();
  });

  it("mantém safe-area no footer do teclado", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
    const { container } = render(<TedChat />);
    const footer = container.querySelector("form");
    const footerClass = footer?.className ?? "";
    // Should include safe-area bottom padding on the footer form
    expect(footerClass).toMatch(/safe-area|env\(safe-area-inset-bottom\)/);
    vi.restoreAllMocks();
  });
});
