/**
 * T6.1 (§25.4) — browser reload during proposed/executing.
 *
 * Mount-after-reload rehydrates approval cards from AUTHORITATIVE server
 * history only: never invented data, never stale success.
 */
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
    decidePendingOperation: vi.fn(),
  };
});

const serverPresentation = {
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

describe("TedChat — reload rehydration from authoritative active list (FIX-P1/T6.1/§25.4)", () => {
  const onCloseMock = vi.fn();

  const activeItem = (overrides: Record<string, unknown> = {}) => ({
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
    presentation: serverPresentation,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
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

  it("mount after reload with a proposed op renders the card from SERVER state, not local residue", async () => {
    // FIX-P1: history carries no card data; the live card comes from the
    // authoritative active list with the server-derived presentation.
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "msg-1", actorId: "user-1", role: "user", content: "gastei 850 no mercado", isOwn: true, createdAt: undefined, attachments: undefined },
      {
        id: "msg-2", actorId: "ted", role: "assistant", content: "Proposta: Mercado. Confirma?", isOwn: false,
        createdAt: undefined, attachments: undefined,
      },
    ]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([activeItem()]);

    render(<TedChat open={true} onClose={onCloseMock} />);

    // Card values come from the server payload (Valor/Conta/Categoria/Data).
    expect(await screen.findByText(/Confirmar despesa/)).toBeInTheDocument();
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    expect(screen.getByText("Alimentação")).toBeInTheDocument();
    expect(screen.getByText("14/09/2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirmar R\$ 850,00/ })).toBeInTheDocument();
    // Nothing was sent locally after mount — no optimistic residue exists.
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
    // Never a stale success claim.
    expect(screen.queryByText(/Operação.*registrada/i)).toBeNull();
    expect(screen.queryByText(/concluída/i)).toBeNull();
  });

  it("executing status in the active list shows pt-BR processing (INV-03), never success", async () => {
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      {
        id: "msg-2", actorId: "ted", role: "assistant", content: "Processando.", isOwn: false,
        createdAt: undefined, attachments: undefined,
      },
    ]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([
      activeItem({ status: "executing", presentation: { ...serverPresentation, status: "executing" } }),
    ]);

    render(<TedChat open={true} onClose={onCloseMock} />);

    expect(await screen.findByText(/processando operação/i)).toBeInTheDocument();
    expect(screen.queryByText(/Operação.*registrada/i)).toBeNull();
    expect(screen.queryByText(/concluída/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /aprovar|confirmar/i })).toBeNull();
  });

  it("history fetch failure with no prior history shows error/empty state, never a fabricated card", async () => {
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("boom"));

    render(<TedChat open={true} onClose={onCloseMock} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o histórico.");
    expect(screen.queryByRole("button", { name: /aprovar|confirmar/i })).toBeNull();
    expect(screen.getByText("Olá! Sou o TED.")).toBeInTheDocument();
  });

  it("reload failure with prior history preserves it (regression) and invents no card", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
      { id: "msg-1", actorId: "user-1", role: "user", content: "Meu saldo?", isOwn: true, createdAt: undefined, attachments: undefined },
    ]);

    render(<TedChat open={true} onClose={onCloseMock} />);
    expect(await screen.findByText("Meu saldo?")).toBeInTheDocument();

    // Send fails AND the follow-up history reload fails: prior server
    // history must stay on screen with an error signal — no wipe, no card.
    vi.mocked(agentClient.sendAgentMessage).mockRejectedValueOnce(new Error("down"));
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("history down"));

    await user.type(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), "Olá");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Meu saldo?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aprovar|confirmar/i })).toBeNull();
  });
});
