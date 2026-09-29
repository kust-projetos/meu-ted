/**
 * FIX-P1 RED: reload rehydrates live cards EXCLUSIVELY from the authoritative
 * active list (GET /rpc/pending-operations/active relay), never from history.
 * Presentation is the canonical server-derived DTO.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import { TedChat } from "../TedChat";
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
    sendAgentMessage: vi.fn(),
    decidePendingOperation: vi.fn(),
  };
});

const canonicalPresentation = {
  id: "pending-v2-1",
  status: "proposed",
  tool: "transactions.expense.create",
  title: "Confirmar despesa",
  amountCents: 85000,
  description: "Mercado",
  date: "2026-09-14",
  account: { id: "acc-1", label: "Nubank" },
  category: { id: "cat-1", label: "Alimentação" },
  expiresAt: "2026-09-14T13:00:00.000Z",
  warnings: [],
};

describe("FIX-P1 RED: TedChat reload from active list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({ turnId: "t1", status: "completed" });
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "pending-v2-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-pending-v2-1",
        mutationKind: "transactions.expense.create",
        status: "succeeded",
        affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
        operationId: "pending-v2-1",
        entity: { type: "transaction", id: "tx-pending-v2-1" },
      },
    });
  });

  it("proposal→reload→canonical card→decision: card comes from active list with server presentation", async () => {
    // History carries NO pendingOperation (post-fix contract): the card must
    // still appear, sourced from the active list.
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "msg-1", actorId: "user-1", role: "user", content: "gastei 850 no mercado", isOwn: true, createdAt: undefined, attachments: undefined },
      { id: "msg-2", actorId: "ted", role: "assistant", content: "Proposta registrada. Confirma?", isOwn: false, createdAt: undefined, attachments: undefined },
    ]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([
      {
        id: "pending-v2-1",
        status: "proposed",
        tool: "transactions.expense.create",
        createdAt: "2026-09-14T10:00:00.000Z",
        expiresAt: "2026-09-14T13:00:00.000Z",
        amountCents: 85000,
        description: "Mercado",
        date: "2026-09-14",
        accountId: "acc-1",
        categoryId: "cat-1",
        presentation: canonicalPresentation,
      },
    ]);

    render(<TedChat open={true} onClose={() => {}} />);

    expect(await screen.findByText(/Confirmar despesa/)).toBeInTheDocument();
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    // FIX-P1 labels: the rehydrated card preserves the full server-derived
    // presentation — Valor/Conta/Categoria/Data — never a summary-only card.
    expect(screen.getByText("Alimentação")).toBeInTheDocument();
    expect(screen.getByText("14/09/2026")).toBeInTheDocument();
    // Never a stale success claim (the success banner reads "registrada" as
    // a standalone operation state, not the card's explanatory copy).
    expect(screen.queryByText(/Operação.*registrada/i)).toBeNull();
    expect(screen.queryByText(/concluída/i)).toBeNull();
  });

  it("history-borne pendingOperation is ignored: no card without active list", async () => {
    // Legacy history payload still carries a pendingOperation, but the chat
    // must NOT mint a card from it — active list is empty.
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      {
        id: "msg-2", actorId: "ted", role: "assistant", content: "Proposta.", isOwn: false,
        createdAt: undefined, attachments: undefined,
        pendingOperation: {
          id: "pending-v2-1", status: "proposed", operation: "transactions.expense.create",
          summary: "Mercado", presentation: canonicalPresentation,
        },
      },
    ]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);

    render(<TedChat open={true} onClose={() => {}} />);

    await waitFor(() => expect(agentClient.fetchActivePendingOperations).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Confirmar despesa/)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Confirmar R\$/i })).not.toBeInTheDocument();
  });

  it("active list failure on first load is honest: no card, error signal, history intact", async () => {
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "msg-1", actorId: "user-1", role: "user", content: "Meu saldo?", isOwn: true, createdAt: undefined, attachments: undefined },
    ]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockRejectedValue(new Error("down"));

    render(<TedChat open={true} onClose={() => {}} />);

    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aprovar|confirmar/i })).toBeNull();
  });
});
