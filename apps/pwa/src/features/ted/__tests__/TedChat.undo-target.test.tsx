/**
 * FIX-P1-UX #172 — TedChat carries the display-safe undo target projection
 * to the card on both real paths (active-list rehydration, turn field).
 * A projected target renders its human-reviewable fields; a legacy
 * target-less proposal keeps the summary shape with the RPC-only confirm
 * (the fixed target stays server-side by contract — never invented here).
 */
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
    fetchAgentHistory: vi.fn(),
    fetchActivePendingOperations: vi.fn(),
    fetchActiveUndoProposals: vi.fn(),
    sendAgentMessage: vi.fn(),
    decideUndoProposal: vi.fn(),
  };
});

const TARGET = {
  kind: "Despesa",
  description: "Mercado",
  amountCents: 85000,
  accountLabel: "Nubank",
  occurredOn: "2026-09-14",
};

describe("TedChat — undo target projection reaches the card (FIX-P1-UX #172)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-plain",
      status: "completed",
      output: "ok",
    });
  });

  it("rehydrated proposal with a target renders the projected fields", async () => {
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-7", status: "proposed", expiresAt: "2099-01-01T12:00:00Z", target: TARGET },
    ]);

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();

    expect(screen.getByText("Despesa")).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    expect(screen.getByText("14/09/2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar desfazer" })).toBeInTheDocument();
  });

  it("turn proposal with a target renders the projected fields", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-undo",
      status: "completed",
      output: "Encontrei a última ação.",
      undoProposal: {
        requestId: "proposal-9",
        status: "proposed",
        expiresAt: "2099-01-01T12:00:00Z",
        target: TARGET,
      },
    });

    render(<TedChat />);

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz o último",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
  });

  it("legacy target-less proposal keeps the summary shape with the RPC-only confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-7", status: "proposed", expiresAt: "2099-01-01T12:00:00Z" },
    ]);
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    expect(screen.getByText("Desfazer a última ação registrada.")).toBeInTheDocument();

    // The fixed target stays server-side: confirm names only the proposal.
    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));
    await waitFor(() =>
      expect(agentClient.decideUndoProposal).toHaveBeenCalledWith("ws-1", "proposal-7", "confirm"),
    );
  });
});
