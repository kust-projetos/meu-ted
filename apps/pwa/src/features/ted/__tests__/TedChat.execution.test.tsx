/**
 * ADR-033 S2 — TedChat renders the runtime's agent self-confirm `execution`
 * as a READ-ONLY terminal state (sucesso / falha / não verificado), reuses the
 * structured undo card where one exists, invalidates financial data on success
 * and NEVER offers the old Confirm/Cancel approval card. The legacy `proposal`
 * path keeps its byte-identical card.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";
import { PENDING_OPERATIONS_CHANGED_EVENT } from "@/lib/state/use-pending-operations";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" },
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

const RECEIPT: agentClient.PendingOperationReceipt = {
  mutationId: "mut-1",
  mutationKind: "transactions.expense.create",
  status: "succeeded",
  affectedTargets: ["transactions", "accounts"],
  operationId: "op-1",
  entity: { type: "transaction", id: "tx-1" },
};

const succeededExecution: agentClient.SelfConfirmExecution = {
  operationId: "op-1",
  tool: "transactions.expense.create",
  status: "succeeded",
  receipt: RECEIPT,
  outcome: { status: "succeeded" },
};

const send = async (text = "registre a despesa") => {
  const user = userEvent.setup();
  render(<TedChat />);
  await user.type(screen.getByLabelText("Mensagem para o assistente"), text);
  await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
};

beforeEach(() => {
  vi.restoreAllMocks();
  reconcileMutation.mockClear();
  vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
  vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([]);
  vi.spyOn(agentClient, "fetchActiveUndoProposals").mockResolvedValue([]);
});

describe("TedChat — execution (ADR-033 S2)", () => {
  it("succeeded: read-only terminal card + note, financial invalidation/reconciliation, undo kept, no approval card", async () => {
    const dispatched: Event[] = [];
    const listener = (event: Event) => dispatched.push(event);
    window.addEventListener(PENDING_OPERATIONS_CHANGED_EVENT, listener);
    try {
      vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
        turnId: "turn-exec-ok",
        status: "completed",
        output: "Concluído: despesa de R$ 85,00.",
        execution: succeededExecution,
        undoProposal: {
          requestId: "undo-1",
          status: "proposed",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });

      await send();

      const card = await screen.findByTestId("ted-execution-card");
      expect(card).toHaveAttribute("data-execution-status", "succeeded");
      expect(screen.getByTestId("ted-execution-outcome")).toHaveTextContent("Operação concluída com sucesso");
      await waitFor(() => expect(reconcileMutation).toHaveBeenCalledWith({ receipt: RECEIPT }));
      await waitFor(() => expect(dispatched.length).toBeGreaterThanOrEqual(1));
      expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Confirmar desfazer" })).toBeInTheDocument();
      // No approval card and no approval action: the agent already decided.
      expect(screen.queryByTestId("ted-approval-item")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Confirmar R\$/ })).toBeNull();
      expect(card).not.toHaveTextContent("attestation");
      expect(card).not.toHaveTextContent("hash");
    } finally {
      window.removeEventListener(PENDING_OPERATIONS_CHANGED_EVENT, listener);
    }
  });

  it("failed: terminal failure, no financial reconciliation, no approval card", async () => {
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-exec-fail",
      status: "completed",
      output: "Não foi possível concluir: despesa.",
      execution: {
        operationId: "op-2",
        tool: "transactions.income.create",
        status: "failed",
        outcome: { status: "failed", failureCode: "in_use" },
      },
    });

    await send();

    const card = await screen.findByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "failed");
    expect(card).toHaveTextContent("Não foi possível concluir a operação");
    expect(screen.getByTestId("ted-execution-outcome")).toHaveTextContent("Não foi possível concluir a operação");
    expect(reconcileMutation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ted-approval-item")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirmar R\$/ })).toBeNull();
  });

  it("unverified: never claims success, never reconciles, never offers decision buttons", async () => {
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-exec-unverified",
      status: "completed",
      output: "Não consegui verificar a conclusão da despesa.",
      execution: {
        operationId: "op-3",
        tool: "cards.statement.pay",
        status: "unverified",
        outcome: { status: "unverified" },
      },
    });

    await send();

    const card = await screen.findByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "unverified");
    expect(card).toHaveTextContent("Não foi possível verificar a conclusão");
    expect(screen.getByTestId("ted-execution-outcome")).toHaveTextContent("Não foi possível verificar o resultado");
    expect(reconcileMutation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ted-approval-item")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirmar R\$/ })).toBeNull();
  });

  it("succeeded with a missing receipt arrives as unverified (no false success)", async () => {
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-exec-noreceipt",
      status: "completed",
      output: "Concluído: despesa.",
      // No canonical receipt: the REAL client boundary downgrades this to
      // unverified, so the mock goes through the same sanitizer.
      execution: agentClient.sanitizeSelfConfirmExecution({
        operationId: "op-4",
        tool: "transactions.expense.create",
        status: "succeeded",
        outcome: { status: "succeeded" },
      }),
    });

    await send();

    const card = await screen.findByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "unverified");
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  it("legacy proposal still renders the actionable card with Confirm/Cancel", async () => {
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-legacy",
      status: "completed",
      output: "Preparei a despesa.",
      proposal: {
        tool: "transactions.expense.create",
        intentionId: "int-legacy",
        normalizedArgs: {
          amountCents: 8500,
          description: "Mercado",
          date: "2026-11-20",
          accountId: "11111111-1111-4111-8111-111111111111",
          categoryId: "22222222-2222-4222-8222-222222222222",
        },
      },
    });
    vi.spyOn(agentClient, "proposePendingOperation").mockResolvedValue({ id: "op-legacy", existing: false });
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([
      {
        id: "op-legacy",
        tool: "transactions.expense.create",
        status: "proposed",
        createdAt: "2026-11-20T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        presentation: {
          id: "op-legacy",
          status: "proposed",
          tool: "transactions.expense.create",
          title: "Confirmar despesa",
          amountCents: 8500,
          description: "Mercado",
          date: "2026-11-20",
          account: { id: "acc-1", label: "Nubank" },
          category: { id: "cat-1", label: "Alimentação" },
          expiresAt: "2099-01-01T00:00:00.000Z",
          warnings: [],
        },
      },
    ]);

    await send();

    expect(await screen.findByRole("button", { name: "Confirmar R$ 85,00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.queryByTestId("ted-execution-card")).toBeNull();
  });
});
