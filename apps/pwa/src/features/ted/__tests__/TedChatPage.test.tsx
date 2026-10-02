import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/lib/test-utils";
import { TedChatPage } from "../TedChatPage";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" },
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

const navigation = vi.hoisted(() => ({
  search: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

describe("TedChatPage (/ted)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigation.search = "";
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
  });

  it("renders the page-bound chat region without an operationId", async () => {
    render(<TedChatPage />);
    expect(await screen.findByRole("region", { name: "Chat com TED" })).toBeInTheDocument();
    expect(screen.queryByTestId("ted-approval-focused")).not.toBeInTheDocument();
  });

  it("passes ?operationId= through as the focused operation (honest fallback)", async () => {
    navigation.search = "operationId=op-missing";
    render(<TedChatPage />);
    expect(await screen.findByRole("region", { name: "Chat com TED" })).toBeInTheDocument();
    expect(
      await screen.findByText("Operação não encontrada nesta conversa."),
    ).toBeInTheDocument();
  });

  it("bounds the chat above the fixed BottomNav (no overlap, internal scroll)", async () => {
    const { container } = render(<TedChatPage />);
    await screen.findByRole("region", { name: "Chat com TED" });
    const main = container.querySelector("main");
    expect(main?.className ?? "").toMatch(/var\(--tab-bar-height\)/);
    expect(main?.className ?? "").toMatch(/safe-area-inset-bottom/);
    // Height regression pin (review finding): the wrapper may NOT carry a
    // rigid pixel min-height (e.g. min-h-[480px]) — on short viewports it
    // would exceed the space above the fixed BottomNav and produce an
    // external scrollbar with the composer rendered offscreen.
    const wrapper = main?.querySelector("div");
    expect(wrapper?.className ?? "").toMatch(/100dvh/);
    expect(wrapper?.className ?? "").not.toMatch(/min-h-\[\d+px\]/);
  });
});
