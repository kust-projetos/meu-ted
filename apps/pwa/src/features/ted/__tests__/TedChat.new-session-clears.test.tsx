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
    fetchActiveUndoProposals: vi.fn(),
    sendAgentMessage: vi.fn(),
    renewAgentSession: vi.fn(),
  };
});

const OLD_HISTORY = [
  { id: "msg-1", actorId: "user-1", role: "user", content: "Meu saldo?", isOwn: true, createdAt: undefined },
  { id: "msg-2", actorId: "ted", role: "assistant", content: "R$ 1.000,00.", isOwn: false, createdAt: undefined },
];

describe("TedChat — Nova sessão limpa o histórico visível", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Evidência live: o servidor segue devolvendo o lote pré-renovação no
    // /rpc/history logo após o POST session/new (nada de mock para []).
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([...OLD_HISTORY]);
    // Sem aprovação/undo ativos por padrão: listas vazias (comportamento atual).
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({ turnId: "t1", status: "completed" });
    vi.mocked(agentClient.renewAgentSession).mockResolvedValue({
      ok: true,
      sessionId: "sess-new",
      previousSessionId: "sess-old",
      messageCount: 2,
      summarized: true,
    });
  });

  it("após o sucesso da Nova sessão, as mensagens antigas somem (só o welcome)", async () => {
    const user = userEvent.setup();
    render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^nova sessão$/i }));
    // Arquivamento server-side preservado: POST session/new chamado sem visibility.
    expect(agentClient.renewAgentSession).toHaveBeenCalledWith("ws-1");
    expect(await screen.findByRole("status")).toHaveTextContent(/Nova sessão iniciada/);
    await waitFor(() => expect(screen.queryByText("Meu saldo?")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("R$ 1.000,00.")).not.toBeInTheDocument());
    // Estado inicial/welcome volta a renderizar.
    expect(await screen.findByText("Olá! Sou o TED.")).toBeInTheDocument();
  });

  it("falha do POST não limpa o chat (fail-closed)", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.renewAgentSession).mockRejectedValueOnce(new Error("boom"));
    render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^nova sessão$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nova sessão/i);
    // Histórico visível preservado.
    expect(screen.getByText("Meu saldo?")).toBeInTheDocument();
  });


});
