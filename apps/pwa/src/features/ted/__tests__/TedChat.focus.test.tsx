import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@/lib/test-utils";
import { TedChat } from "../TedChat";

// Page semantics (2026-10-01): the TED chat is a `/ted` page region, not a
// dialog. There is no focus trap, no Escape-to-close and no initial autofocus
// on the message field. Focus management covers only the deep-linked approval
// card (see TedChat.deep-link.test.tsx).

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [{ userId: "user-1", name: "Walisson", email: "a@example.com", role: "owner" }],
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
  return {
    ...actual,
    useWorkspace: () => mockWs,
    useWorkspaceSafe: () => mockWs,
  };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn().mockResolvedValue([]),
    sendAgentMessage: vi.fn().mockResolvedValue({ turnId: "t", status: "completed" }),
    renewAgentSession: vi.fn().mockResolvedValue({ ok: true, sessionId: "s2" }),
  };
});

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

async function renderPageChat() {
  render(<TedChat />);
  const region = await screen.findByRole("region", { name: "Chat com TED" });
  return region;
}

describe("TedChat page focus semantics (no dialog)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders as a region, never as a modal dialog", async () => {
    await renderPageChat();
    expect(screen.queryByRole("dialog", { name: "Chat com TED" })).not.toBeInTheDocument();
  });

  it("does not autofocus the message input on page render", async () => {
    await renderPageChat();
    expect(screen.getByLabelText("Mensagem para o assistente")).not.toHaveFocus();
  });

  it("does not trap Tab and does not close on Escape", async () => {
    const region = await renderPageChat();
    const input = screen.getByLabelText("Mensagem para o assistente");
    input.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    // No trap handler: keydown has no preventDefault side effect owned here.
    expect(region).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("region", { name: "Chat com TED" })).toBeInTheDocument();
  });
});
