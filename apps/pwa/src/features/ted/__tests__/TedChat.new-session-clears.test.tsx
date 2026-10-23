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
    fetchActivePendingOperations: vi.fn(),
    fetchActiveUndoProposals: vi.fn(),
    sendAgentMessage: vi.fn(),
    renewAgentSession: vi.fn(),
  };
});

const OLD_HISTORY = [
  { id: "msg-1", actorId: "user-1", role: "user", content: "Meu saldo?", isOwn: true, createdAt: undefined, attachments: undefined },
  { id: "msg-2", actorId: "ted", role: "assistant", content: "R$ 1.000,00.", isOwn: false, createdAt: undefined, attachments: undefined },
];

describe("TedChat — Nova sessão limpa o histórico visível", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Evidência live: o servidor segue devolvendo o lote pré-renovação no
    // /rpc/history logo após o POST session/new (nada de mock para []).
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([...OLD_HISTORY]);
    // Sem aprovação/undo ativos por padrão: listas vazias (comportamento atual).
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
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

  it("renovação com aprovação e undo ativos: mensagens vazias + cartões visíveis, sem recarregar mensagens", async () => {
    const user = userEvent.setup();
    // Cartões autoritativos vivos (escopo workspace, não sessão).
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([
      {
        id: "pending-v2-1",
        status: "proposed",
        tool: "transactions.expense.create",
        createdAt: "2026-10-21T10:00:00.000Z",
        expiresAt: "2026-10-21T13:00:00.000Z",
        amountCents: 85000,
        description: "Mercado",
        date: "2026-10-21",
        accountId: "acc-1",
        categoryId: "cat-1",
      },
    ]);
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-live", status: "proposed", expiresAt: "2099-01-01T12:00:00.000Z" },
    ]);
    render(<TedChat />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();
    // Cartões vivos já na tela antes da renovação.
    expect(await screen.findByTestId("ted-approval-item")).toBeInTheDocument();
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    const historyCallsBefore = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;

    await user.click(screen.getByRole("button", { name: /^nova sessão$/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Nova sessão iniciada/);
    // Contrato: chat visível vazio (só o welcome)…
    await waitFor(() => expect(screen.queryByText("Meu saldo?")).not.toBeInTheDocument());
    expect(await screen.findByText("Olá! Sou o TED.")).toBeInTheDocument();
    // …mas os cartões ativos seguem visíveis.
    expect(await screen.findByTestId("ted-approval-item")).toBeInTheDocument();
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    // Nenhuma recarga de mensagens no caminho novo.
    expect(vi.mocked(agentClient.fetchAgentHistory).mock.calls.length).toBe(historyCallsBefore);
    expect(agentClient.fetchActivePendingOperations).toHaveBeenCalledWith("ws-1");
    expect(agentClient.fetchActiveUndoProposals).toHaveBeenCalledWith("ws-1");
  });
});
