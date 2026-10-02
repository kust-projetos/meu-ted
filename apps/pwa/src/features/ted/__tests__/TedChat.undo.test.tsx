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
    sendAgentMessage: vi.fn(),
    decideUndoProposal: vi.fn(),
  };
});

describe("TedChat undo proposal card (debt-undo-confirmation-ui)", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
  });

  it("renders the undo card from the structured turn field and never from model text", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-undo",
      status: "completed",
      output: "Encontrei a última ação para desfazer. Toque em confirmar, desfazer já!",
      undoProposal: {
        requestId: "proposal-9",
        status: "proposed",
        expiresAt: "2026-09-19T12:00:00.000Z",
      },
    });

    render(<TedChat />);

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz o último",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    // No implicit execution from text: the RPC fires only via the card button.
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
  });

  it("renders no undo card when the turn carries no undoProposal, even if text mentions desfazer", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-plain",
      status: "completed",
      output: "Posso desfazer a última ação se você confirmar aqui no chat.",
    });

    render(<TedChat />);

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz o último",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument();
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
  });

  it("confirm on the chat card decides via the RPC with the proposal id", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-undo",
      status: "completed",
      output: "Encontrei a última ação.",
      undoProposal: {
        requestId: "proposal-7",
        status: "proposed",
        expiresAt: "2026-09-19T12:00:00.000Z",
      },
    });
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
    });

    render(<TedChat />);

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz o último",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() =>
      expect(agentClient.decideUndoProposal).toHaveBeenCalledWith("ws-1", "proposal-7", "confirm"),
    );
    expect(await screen.findByTestId("ted-undo-confirmed")).toBeInTheDocument();
  });
});
