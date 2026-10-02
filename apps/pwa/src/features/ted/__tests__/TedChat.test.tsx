import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentAuth from "@/lib/api/agent-auth";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [
      { userId: "user-1", name: "Walisson", email: "walisson@example.com", role: "owner" },
      { userId: "user-2", name: "Fernanda", email: "fernanda@example.com", role: "member" },
    ],
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
    fetchAgentHistory: vi.fn(),
    sendAgentMessage: vi.fn(),
  };
});

describe("TedChat Component – Canonical FinanceChatAgent REST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "msg-1", actorId: "user-1", role: "user", content: "Olá TED, meu saldo?", isOwn: true, createdAt: undefined, attachments: undefined },
      { id: "msg-2", actorId: "ted", role: "assistant", content: "Seu saldo é R$ 2.000,00.", isOwn: false, createdAt: undefined, attachments: undefined },
      { id: "msg-3", actorId: "user-2", role: "user", content: "Quanto temos na poupança?", isOwn: false, createdAt: undefined, attachments: undefined },
    ]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-new",
      status: "completed",
      output: "Você tem R$ 5.000,00 na poupança.",
    });
  });

  it("renders as a page region (not a dialog) with the TED name", async () => {
    render(<TedChat />);

    const region = await screen.findByRole("region", { name: "Chat com TED" });
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("data-testid", "ted-chat");
    expect(screen.queryByRole("dialog", { name: "Chat com TED" })).not.toBeInTheDocument();
    expect(await screen.findByText("Olá TED, meu saldo?")).toBeInTheDocument();
  });

  it("renders messages using server isOwn, displays member name for other users and hides raw ID", async () => {
    render(<TedChat />);

    expect(await screen.findByText("Olá TED, meu saldo?")).toBeInTheDocument();
    expect(await screen.findByText("Seu saldo é R$ 2.000,00.")).toBeInTheDocument();
    expect(await screen.findByText("Quanto temos na poupança?")).toBeInTheDocument();

    // User-1 is current user (isOwn=true) -> Display name is "Você"
    expect(screen.getByText("Você")).toBeInTheDocument();

    // User-2 is another member in workspace -> Display name is resolved to "Fernanda", NEVER raw "user-2"
    expect(screen.getByText("Fernanda")).toBeInTheDocument();
    expect(screen.queryByText("user-2")).not.toBeInTheDocument();
  });

  it("does not render export or delete controls without Finance contract", async () => {
    render(<TedChat />);

    expect(await screen.findByText("Olá TED, meu saldo?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /exportar histórico/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /limpar meu histórico/i })).not.toBeInTheDocument();
  });

  it("shows a safe error when canonical history cannot be loaded", async () => {
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("upstream token detail"));

    render(<TedChat />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o histórico.");
    expect(screen.queryByText("upstream token detail")).not.toBeInTheDocument();
  });

  it("sends message and reloads canonical history from server instead of fabricating persistent local authorship", async () => {
    const user = userEvent.setup();

    render(<TedChat />);

    expect(await screen.findByText("Olá TED, meu saldo?")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…");
    await user.type(input, "Quanto temos na poupança?");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    // SPEC §7.7/§19.3: every send carries a stable messageId (retry-safe).
    expect(agentClient.sendAgentMessage).toHaveBeenCalledWith(
      "ws-1",
      "Quanto temos na poupança?",
      expect.objectContaining({ messageId: expect.any(String) }),
    );

    // Verifies loadHistory was called after sendAgentMessage to retrieve canonical server state
    await waitFor(() => {
      expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2);
    });
  });

  it("shows a safe error when sending a message fails", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockRejectedValueOnce(new Error("upstream token detail"));

    render(<TedChat />);
    await screen.findByText("Olá TED, meu saldo?");

    await user.type(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), "Olá");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível enviar a mensagem.");
    expect(screen.queryByText("upstream token detail")).not.toBeInTheDocument();
  });

  it("has no close button (page navigation owns leaving via router/back)", async () => {
    render(<TedChat />);

    expect(await screen.findByText("Olá TED, meu saldo?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fechar chat/i })).not.toBeInTheDocument();
  });
});
