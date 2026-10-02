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
    fetchActiveUndoProposals: vi.fn(),
    sendAgentMessage: vi.fn(),
    decideUndoProposal: vi.fn(),
  };
});

describe("TedChat undo rehydration (debt-undo-proposal-rehydration)", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
  });

  it("reload renders the active undo card without sending any decision", async () => {
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-reload", status: "proposed", expiresAt: "2099-01-01T12:00:00.000Z" },
    ]);

    render(<TedChat />);

    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("dedupes the turn-returned card against the rehydrated one", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-9", status: "proposed", expiresAt: "2099-01-01T12:00:00.000Z" },
    ]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-undo",
      status: "completed",
      output: "Encontrei a última ação.",
      undoProposal: {
        requestId: "proposal-9",
        status: "proposed",
        expiresAt: "2099-01-01T12:00:00.000Z",
      },
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz o último",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    expect(screen.getAllByTestId("ted-undo-card")).toHaveLength(1);
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
  });

  it("renders an executing proposal as pending with no decision buttons", async () => {
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-exec", status: "executing", expiresAt: "2099-01-01T12:00:00.000Z" },
    ]);

    render(<TedChat />);

    expect(await screen.findByTestId("ted-undo-pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar desfazer" })).not.toBeInTheDocument();
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
  });

  it("never renders an expired rehydrated summary", async () => {
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-old", status: "proposed", expiresAt: "2020-01-01T00:00:00.000Z" },
    ]);

    render(<TedChat />);

    await waitFor(() => expect(agentClient.fetchActiveUndoProposals).toHaveBeenCalled());
    expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ted-undo-pending")).not.toBeInTheDocument();
  });
});

describe("TedChat undo terminal reconciliation (debt-undo-rehydration-terminal-fix)", () => {
  const FUTURE = "2099-01-01T12:00:00.000Z";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
  });

  it("confirm then reload drops the terminal card instead of reappearing it", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-7", status: "proposed", expiresAt: FUTURE },
    ]);
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();

    // Server-side the proposal is now terminal, so the authoritative list omits it.
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() =>
      expect(agentClient.decideUndoProposal).toHaveBeenCalledWith("ws-1", "proposal-7", "confirm"),
    );
    // The authoritative reload (triggered by the resolution) must drop the
    // terminal card — it must not reappear from old local state.
    await waitFor(() => expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument());
    expect(screen.queryByTestId("ted-undo-confirmed")).not.toBeInTheDocument();
    expect(agentClient.decideUndoProposal).toHaveBeenCalledTimes(1);
  });

  it("cancel then reload drops the cancelled flash instead of reappearing it", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-8", status: "proposed", expiresAt: FUTURE },
    ]);
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-8",
      status: "cancelled",
    });
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-plain",
      status: "completed",
      output: "ok",
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await screen.findByTestId("ted-undo-cancelled")).toBeInTheDocument();

    // Server-side the proposal is terminal; the next authoritative reload
    // (here via a plain follow-up send) must drop it entirely.
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "qual meu saldo?",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("ted-undo-cancelled")).not.toBeInTheDocument());
    expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument();
    expect(agentClient.decideUndoProposal).toHaveBeenCalledTimes(1);
  });

  it("expiry then reload drops the card with zero decisions", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-live", status: "proposed", expiresAt: FUTURE },
    ]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-plain",
      status: "completed",
      output: "ok",
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();

    // Server-side the proposal expired (omitted + marked expired); the next
    // authoritative reload must drop the stale card without any decision.
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "qual meu saldo?",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument());
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
  });

  it("in-flight turn proposal still appears when the active list lags behind", async () => {
    const user = userEvent.setup();
    // Active list knows nothing yet (propagation gap); the turn response is
    // the narrowly justified exception that still mints the card.
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-undo",
      status: "completed",
      output: "Encontrei a última ação.",
      undoProposal: { requestId: "proposal-fresh", status: "proposed", expiresAt: FUTURE },
    });

    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchActiveUndoProposals).toHaveBeenCalled());
    expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz o último",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    expect(agentClient.decideUndoProposal).not.toHaveBeenCalled();
  });
});
