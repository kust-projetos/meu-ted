import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [{ userId: "user-1", name: "Walisson", email: "walisson@example.com", role: "owner" }],
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
    renewAgentSession: vi.fn(),
  };
});

describe("TedChat — sessão renovável e memória (Parte B)", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "msg-1", actorId: "user-1", role: "user", content: "Meu saldo?", isOwn: true, createdAt: undefined, attachments: undefined },
      { id: "msg-2", actorId: "ted", role: "assistant", content: "R$ 1.000,00.", isOwn: false, createdAt: undefined, attachments: undefined },
    ]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({ turnId: "t1", status: "completed" });
    vi.mocked(agentClient.renewAgentSession).mockResolvedValue({
      ok: true,
      sessionId: "sess-new",
      previousSessionId: "sess-old",
      messageCount: 2,
      summarized: true,
    });
  });

  it("renova a sessão: limpa o contexto, mantém o chat utilizável e avisa", async () => {
    const user = userEvent.setup();
    render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();

    // Post-renew server history is empty; arrange it before clicking.
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: /nova sessão/i }));
    expect(agentClient.renewAgentSession).toHaveBeenCalledWith("ws-1");
    expect(await screen.findByRole("status")).toHaveTextContent(/Nova sessão iniciada/);
    await waitFor(() => expect(screen.queryByText("Meu saldo?")).not.toBeInTheDocument());
    // History reloads (fresh) after renewal.
    expect(agentClient.fetchAgentHistory).toHaveBeenCalled();
  });

  it("mostra erro seguro quando a renovação falha", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.renewAgentSession).mockRejectedValueOnce(new Error("boom"));
    render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /nova sessão/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nova sessão/i);
  });

  it("exibe toast discreto quando o TED memoriza algo no turno", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "t2",
      status: "completed",
      memorized: ["Prefiro resumos curtos"],
    });
    render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), "Lembre que prefiro resumos curtos");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("TED memorizou: Prefiro resumos curtos");
  });

  it("contrato: reabrir após renovação carrega o histórico da sessão atual", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /nova sessão/i }));
    await waitFor(() => expect(agentClient.renewAgentSession).toHaveBeenCalled());

    // Current session is now empty server-side.
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    unmount();
    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());
    expect(screen.queryByText("Meu saldo?")).not.toBeInTheDocument();
  });
});
