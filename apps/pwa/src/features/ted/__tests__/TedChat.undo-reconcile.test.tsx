/**
 * FIX-P1-UX #175 — TedChat post-undo reconciliation.
 *
 * The REAL decision result is the UndoResult envelope `{ undone, receipt }`
 * (API `apps/api/src/approvals/undo.ts:185-188`, preserved verbatim by the
 * Agent `finance-chat-agent.ts:2953` as `result`). The receipt that drives
 * the financial reconciler lives at `result.receipt` — never flattened at
 * `result` itself. A confirmed undo reconciles the financial UI
 * (extrato/saldo/dashboard) from that TYPED receipt only; anything else
 * (absent, null, flat, malformed) reloads history with NO reconciliation
 * invented. A cancelled undo changes nothing. A failed refresh marks
 * domains stale in app-state while the authoritative chat history still
 * reloads (never a false success).
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

const reconcileMutation = vi.fn(async () => ({
  targets: [],
  refreshed: [],
  failed: [],
  deduped: false,
}));

vi.mock("@/lib/state/app-state-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/app-state-context")>();
  return { ...actual, useAppState: () => ({ reconcileMutation }), useOptionalAppState: () => ({ reconcileMutation }) };
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

const FUTURE = "2099-01-01T12:00:00.000Z";

const UNDO_RECEIPT = {
  mutationId: "mut-undo-1",
  mutationKind: "transaction.delete",
  status: "succeeded",
  affectedTargets: ["transactions", "accounts", "dashboard-summary"],
  entity: { type: "transaction", id: "tx-1" },
};

/** The REAL UndoResult envelope: API undo.ts:185-188, relayed verbatim by the Agent. */
const UNDO_ENVELOPE_RESULT = {
  undone: { operation: "transactions.expense.create", entityId: "tx-1" },
  receipt: UNDO_RECEIPT,
};

describe("TedChat — post-undo reconciliation (FIX-P1-UX #175)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-7", status: "proposed", expiresAt: FUTURE },
    ]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-plain",
      status: "completed",
      output: "ok",
    });
    reconcileMutation.mockClear();
  });

  it("confirmed undo with the real { undone, receipt } envelope reconciles financial UI AND reloads chat history", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
      result: UNDO_ENVELOPE_RESULT,
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    // Server-side the proposal is now terminal, so the reload omits it.
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);

    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() =>
      expect(reconcileMutation).toHaveBeenCalledWith({ receipt: UNDO_RECEIPT }),
    );
    // The authoritative history reloads after the reconciliation.
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2));
  });

  it("a flattened receipt at result (never the real contract) reconciles NOTHING — history still reloads", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
      // NOT a real shape: the receipt must live at result.receipt.
      result: UNDO_RECEIPT,
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);

    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2));
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  it("confirmed undo with an envelope carrying a malformed receipt never reconciles (no invented mapping)", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
      result: {
        undone: { operation: "transactions.expense.create", entityId: "tx-1" },
        receipt: { mutationKind: "transaction.delete", forged: true },
      },
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);

    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2));
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  it("confirmed undo with a null result reloads history but never invents a reconciliation", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
      result: null,
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);

    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2));
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  it("a failed refresh still reloads the authoritative history (stale is signaled in app-state, never a false success)", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "confirmed",
      result: UNDO_ENVELOPE_RESULT,
    });
    reconcileMutation.mockRejectedValueOnce(new Error("refresh failed"));

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);

    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));

    await waitFor(() =>
      expect(reconcileMutation).toHaveBeenCalledWith({ receipt: UNDO_RECEIPT }),
    );
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2));
  });

  it("cancelled undo changes nothing — no reconciliation, no history reload", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-7",
      status: "cancelled",
    });

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
    const historyCallsAfterMount = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;

    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await screen.findByTestId("ted-undo-cancelled")).toBeInTheDocument();

    expect(reconcileMutation).not.toHaveBeenCalled();
    expect(vi.mocked(agentClient.fetchAgentHistory).mock.calls.length).toBe(historyCallsAfterMount);
  });
});
