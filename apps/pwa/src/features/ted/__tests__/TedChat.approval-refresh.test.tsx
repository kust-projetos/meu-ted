/**
 * T3.3 — TedChat post-approval path (SPEC §15.4, §25.6 frontend).
 *
 * Approval success refreshes BOTH the chat history (existing behavior,
 * must not regress) AND the financial UI through the single
 * MutationReconciler using the required API execution receipt. Non-success
 * decisions refresh approval/history state only, never financial domains.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/auth/workspace-context")
  >();
  const mockWs = {
    workspaces: [
      {
        id: "ws-1",
        name: "Minhas Finanças",
        kind: "personal" as const,
        role: "owner",
      },
    ],
    activeWorkspace: {
      id: "ws-1",
      name: "Minhas Finanças",
      kind: "personal" as const,
      role: "owner",
    },
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
  const actual = await importOriginal<
    typeof import("@/lib/state/app-state-context")
  >();
  // TedChat reads reconciliation through the optional hook (null outside a
  // provider); keep the throwing hook mocked identically for any surface
  // that still uses it.
  return { ...actual, useAppState: () => ({ reconcileMutation }), useOptionalAppState: () => ({ reconcileMutation }) };
});

beforeEach(() => {
  vi.restoreAllMocks();
  reconcileMutation.mockClear();
});

/**
 * Item 4 (SPEC §16 INV-02): o cartão canônico exige a presentation
 * acionável derivada server-side — sem ela o Confirm nunca renderiza.
 * As fixtures abaixo carregam a presentation na origem canônica (turn
 * output e/ou lista ativa), e os botões usam o nome canônico
 * `Confirmar R$…`.
 */
const actionablePresentation = (
  id: string,
  overrides?: Partial<agentClient.PendingOperationPresentation>,
): agentClient.PendingOperationPresentation => ({
  id,
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
  ...overrides,
});

describe("TedChat — post-approval reconciliation (T3.3)", () => {
  it("approval success reconciles financial UI AND reloads chat history", async () => {
    const user = userEvent.setup();
    const receipt: agentClient.PendingOperationReceipt = {
      mutationId: "mut-op-1",
      mutationKind: "transactions.expense.create",
      status: "succeeded",
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-1",
      entity: { type: "transaction", id: "tx-1" },
    };
    // Deferred history: approving while a reload is in flight must still
    // reconcile first, then reload (SPEC §15.4: chat + financial UI).
    // Only the MOUNT reload gates: the send/decision reloads resolve
    // immediately so the turn card can mount while the mount read is still
    // in flight (executeSend applies the turn card after its own reload).
    let releaseHistory!: (messages: never[]) => void;
    const historyGate = () =>
      new Promise<never[]>((resolve) => {
        releaseHistory = resolve;
      });
    let historyCalls = 0;
    const historySpy = vi
      .spyOn(agentClient, "fetchAgentHistory")
      .mockImplementation(() => {
        historyCalls += 1;
        return historyCalls === 1 ? historyGate() : Promise.resolve([]);
      });
    // FIX-P1: live cards come from the active list — after the decision the
    // operation leaves the active set, so the card clears on reload.
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-1",
      status: "completed",
      pendingOperation: {
        id: "op-1",
        status: "proposed",
        operation: "transactions.expense.create",
        summary: "Mercado",
        presentation: actionablePresentation("op-1"),
      },
    });
    vi.spyOn(agentClient, "decidePendingOperation").mockResolvedValue({
      operationId: "op-1",
      status: "succeeded",
      receipt,
    });

    render(<TedChat />);

    // Send a message that yields a pending approval (history still pending,
    // so the card stays mounted — loadHistory resets pendingOps on resolve).
    await user.type(
      screen.getByLabelText("Mensagem para o assistente"),
      "registre mercado 850",
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(
      await screen.findByRole("button", { name: "Confirmar R$ 850,00" }),
    ).toBeInTheDocument();
    expect(reconcileMutation).not.toHaveBeenCalled();

    const historyCallsAfterProposal = historySpy.mock.calls.length;

    // Approve: the canonical receipt reconciles financial UI, then chat history reloads.
    await user.click(screen.getByRole("button", { name: "Confirmar R$ 850,00" }));

    await waitFor(() =>
      expect(reconcileMutation).toHaveBeenCalledWith({ receipt }),
    );
    await waitFor(() =>
      expect(historySpy.mock.calls.length).toBeGreaterThan(
        historyCallsAfterProposal,
      ),
    );

    // Release the in-flight history reloads; the card resolves to the
    // "registrada" state and no error surfaces.
    releaseHistory([]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Confirmar R$ 850,00" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
  });

  it.each([
    ["cancelled", "proposed", "cancel", "Cancelar"],
    ["failed", "failed", "retry", "Tentar novamente"],
  ] as const)(
    "%s decision refreshes approval state without reconciling financial domains",
    async (decisionStatus, operationStatus, decision, buttonName) => {
      const user = userEvent.setup();
      const operationId = `op-${decisionStatus}`;
      const presentation = actionablePresentation(operationId, { status: operationStatus });
      vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
      vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([
        {
          id: operationId,
          status: operationStatus,
          tool: "transactions.expense.create",
          createdAt: "2026-09-14T10:00:00.000Z",
          expiresAt: "2026-09-14T13:00:00.000Z",
          description: "Mercado",
          presentation,
        },
      ]);
      vi.spyOn(agentClient, "decidePendingOperation").mockResolvedValue({
        operationId,
        status: decisionStatus,
        ...(decisionStatus === "failed" ? { retryable: true } : {}),
      });

      render(<TedChat />);
      await user.click(await screen.findByRole("button", { name: buttonName }));

      await waitFor(() =>
        expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
          "ws-1",
          operationId,
          decision,
        ),
      );
      expect(reconcileMutation).not.toHaveBeenCalled();
    },
  );

  it("real receipt wins: reconciliation consumes the receipt (mutationId dedup), not the kind fallback", async () => {
    const user = userEvent.setup();
    const receipt: agentClient.PendingOperationReceipt = {
      mutationId: "mut-real-1",
      mutationKind: "transactions.expense.create",
      status: "succeeded" as const,
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-1",
      entity: { type: "transaction", id: "tx-1" },
    };
    // Authoritative history keeps the proposed card alive across reloads
    // (loadHistory resets pendingOps from server state on every resolve).
    const historyWithCard: agentClient.AgentMessage[] = [
      {
        id: "msg-1",
        actorId: "user-1",
        role: "user",
        content: "registre mercado 850",
        createdAt: "2026-09-14T10:00:00.000Z",
        isOwn: true,
        pendingOperation: { id: "op-1", status: "proposed", operation: "transactions.expense.create" },
      },
    ];
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue(historyWithCard);
    // FIX-P1: the card stays alive because the op is still in the active list.
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([
      {
        id: "op-1",
        status: "proposed",
        tool: "transactions.expense.create",
        createdAt: "2026-09-14T10:00:00.000Z",
        expiresAt: "2026-09-14T13:00:00.000Z",
        description: "Mercado",
        presentation: actionablePresentation("op-1"),
      },
    ]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-2",
      status: "completed",
      pendingOperation: {
        id: "op-1",
        status: "proposed",
        operation: "transactions.expense.create",
        summary: "Mercado",
        presentation: actionablePresentation("op-1"),
      },
    });
    vi.spyOn(agentClient, "decidePendingOperation").mockResolvedValue({
      operationId: "op-1",
      status: "succeeded",
      receipt,
    });

    render(<TedChat />);

    await user.type(
      screen.getByLabelText("Mensagem para o assistente"),
      "registre mercado 850",
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(await screen.findByRole("button", { name: "Confirmar R$ 850,00" })).toBeInTheDocument();
    reconcileMutation.mockClear();

    await user.click(screen.getByRole("button", { name: "Confirmar R$ 850,00" }));

    // The REAL API-emitted receipt flows to the reconciler: mutationId is
    // present (dedup works), and no fallback kind mapping is used.
    await waitFor(() =>
      expect(reconcileMutation).toHaveBeenCalledWith({ receipt }),
    );
    expect(reconcileMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationKind: expect.anything() }),
    );
  });

  it("receipt-carrying approval keeps the chat history reloading after a reconciliation failure (stale, §15.5)", async () => {
    const user = userEvent.setup();
    const receipt: agentClient.PendingOperationReceipt = {
      mutationId: "mut-real-2",
      mutationKind: "transactions.income.create",
      status: "succeeded" as const,
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-2",
      entity: { type: "transaction", id: "op-2" },
    };
    let historyCalls = 0;
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([
      {
        id: "op-2",
        status: "proposed",
        tool: "transactions.income.create",
        createdAt: "2026-09-14T10:00:00.000Z",
        expiresAt: "2026-09-14T13:00:00.000Z",
        description: "Salário",
        presentation: actionablePresentation("op-2", {
          tool: "transactions.income.create",
          title: "Confirmar receita",
          amountCents: 200000,
          description: "Salário",
        }),
      },
    ]);
    vi.spyOn(agentClient, "fetchAgentHistory").mockImplementation(async () => {
      historyCalls += 1;
      return [
        {
          id: "msg-2",
          actorId: "user-1",
          role: "user",
          content: "registre salário 2000",
          createdAt: "2026-09-14T10:00:00.000Z",
          isOwn: true,
          pendingOperation: { id: "op-2", status: "proposed", operation: "transactions.income.create" },
        },
      ];
    });
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-3",
      status: "completed",
      pendingOperation: {
        id: "op-2",
        status: "proposed",
        operation: "transactions.income.create",
        summary: "Salário",
        presentation: actionablePresentation("op-2", {
          tool: "transactions.income.create",
          title: "Confirmar receita",
          amountCents: 200000,
          description: "Salário",
        }),
      },
    });
    vi.spyOn(agentClient, "decidePendingOperation").mockResolvedValue({
      operationId: "op-2",
      status: "succeeded",
      receipt,
    });
    reconcileMutation.mockRejectedValueOnce(new Error("refresh failed"));

    render(<TedChat />);

    await user.type(
      screen.getByLabelText("Mensagem para o assistente"),
      "registre salário 2000",
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(await screen.findByRole("button", { name: "Confirmar R$ 2.000,00" })).toBeInTheDocument();
    const callsBeforeApproval = historyCalls;
    reconcileMutation.mockClear();

    await user.click(screen.getByRole("button", { name: "Confirmar R$ 2.000,00" }));

    // Reconciliation failed (app-state marks domains stale) but the chat
    // history reload still happens — no rollback, no swallowed reload.
    await waitFor(() =>
      expect(historyCalls).toBeGreaterThan(callsBeforeApproval),
    );
    expect(reconcileMutation).toHaveBeenCalledWith({ receipt });
  });

  it("natural-language confirmation turn that already executed reconciles from the turn receipt", async () => {
    const user = userEvent.setup();
    const receipt: agentClient.PendingOperationReceipt = {
      mutationId: "mut-real-3",
      mutationKind: "transactions.expense.create",
      status: "succeeded" as const,
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-3",
      entity: { type: "transaction", id: "op-3" },
    };
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "sendAgentMessage").mockResolvedValue({
      turnId: "turn-4",
      status: "completed",
      output: "Lançamento registrado com sucesso.",
      // The turn itself reports the execution: succeeded + real receipt.
      pendingOperation: {
        id: "op-3",
        status: "succeeded",
        operation: "transactions.expense.create",
        receipt,
      },
    });

    render(<TedChat />);

    await user.type(
      screen.getByLabelText("Mensagem para o assistente"),
      "confirma",
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() =>
      expect(reconcileMutation).toHaveBeenCalledWith({ receipt }),
    );
    expect(reconcileMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationKind: expect.anything() }),
    );
  });
});
