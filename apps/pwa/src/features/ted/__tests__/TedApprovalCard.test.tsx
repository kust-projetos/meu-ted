import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedApprovalCard } from "../TedApprovalCard";
import * as agentClient from "@/lib/api/agent-client";
import type { PendingOperationPresentation } from "@/lib/api/agent-client";

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return { ...actual, decidePendingOperation: vi.fn() };
});

const actionablePresentation = (id: string): PendingOperationPresentation => ({
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
});

describe("TedApprovalCard V2", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("sends only a confirm decision to the authenticated Agent RPC", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-1",
        mutationKind: "transactions.expense.create",
        status: "succeeded",
        affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
        operationId: "op-1",
        entity: { type: "transaction", id: "tx-1" },
      },
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-1",
          status: "proposed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("op-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Confirmar R\$ 850,00/ }));

    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-1",
        "confirm",
      ),
    );
    expect(JSON.stringify(vi.mocked(agentClient.decidePendingOperation).mock.calls)).not.toContain("attestation");
    expect(await screen.findByText(/registrada/i)).toBeInTheDocument();
  });

  it("locks the card after an unverified confirmation result until state is refreshed", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    const uncertain = Object.assign(
      new Error("O resultado desta operação ainda não pôde ser verificado."),
      { code: "approval.execution_uncertain" },
    );
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(uncertain);

    render(
      <TedApprovalCard
        operation={{
          id: "op-uncertain",
          status: "proposed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("op-uncertain"),
        }}
        workspaceId="workspace-1"
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Confirmar R\$ 850,00/ }));

    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar novamente/i })).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("does not render an action for a non-proposed (resolved) shape", () => {
    render(
      <TedApprovalCard
        operation={{ id: "legacy-1", status: "expired", operation: "transactions.expense.create" }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
  });

  it("T3.4 RED: renders Valor/Conta/Categoria/Data from the canonical presentation (INV-02)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "pending-v2-1",
          status: "proposed",
          operation: "transactions.expense.create",
          presentation: {
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
          },
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Confirmar despesa/)).toBeInTheDocument();
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    expect(screen.getByText("Alimentação")).toBeInTheDocument();
    expect(screen.getByText("14/09/2026")).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirmar R\$ 850,00/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("T3.4 RED: legacy payload without presentation fails closed — warning and Cancel only, never blind approval", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "legacy-2",
      status: "cancelled",
    });

    render(
      <TedApprovalCard
        operation={{ id: "legacy-2", status: "proposed", operation: "transactions.expense.create", summary: "Mercado" }}
        workspaceId="workspace-1"
      />,
    );

    // Fail-closed: no financial data to authorize, so no Confirm/Aprovar may render.
    expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.getByText(/não é possível confirmar/i)).toBeInTheDocument();
    // Canceling moves no money, so Cancel stays available.
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "legacy-2",
        "cancel",
      ),
    );
    expect(
      vi.mocked(agentClient.decidePendingOperation).mock.calls.every(([, , decision]) => decision !== "confirm"),
    ).toBe(true);
  });

  it("T3.4 RED: shows the executing state without premature success (INV-03)", () => {
    render(
      <TedApprovalCard
        operation={{ id: "op-exec", status: "executing", operation: "transactions.expense.create" }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/processando opera/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("V3-FIX-CARD-FAILCLOSED RED: proposed + presentation without account/category renders degraded without Confirm", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "pending-v2-degraded",
          status: "proposed",
          operation: "transactions.expense.create",
          presentation: {
            id: "pending-v2-degraded",
            status: "proposed",
            tool: "transactions.expense.create",
            title: "Confirmar despesa",
            amountCents: 85000,
            description: "Mercado",
            date: "2026-09-14",
            expiresAt: "2026-09-14T13:00:00.000Z",
            warnings: ["Dados da conta indisponíveis no momento"],
          },
        }}
        workspaceId="workspace-1"
      />,
    );

    // Financial context is incomplete: the Confirm button must NOT render.
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Dados da operação incompletos/)).toBeInTheDocument();
    // Canceling moves no money, so Cancel stays available.
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    // Whatever data exists is still shown.
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();
  });

  it("T3.3: onResolved receives the decision including the real execution receipt", async () => {    const user = userEvent.setup();
    const onResolved = vi.fn();
    const receipt: agentClient.PendingOperationReceipt = {
      mutationId: "mut-1",
      mutationKind: "transactions.expense.create",
      status: "succeeded" as const,
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-1",
      entity: { type: "transaction", id: "tx-1" },
    };
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-1",
      status: "succeeded",
      receipt,
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-1",
          status: "proposed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("op-1"),
        }}
        workspaceId="workspace-1"
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Confirmar R\$ 850,00/ }));

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        expect.objectContaining({ status: "succeeded", receipt }),
      ),
    );
  });
});

describe("TedApprovalCard mandatory presentation (production functional corrections item 4)", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("proposed rehydrated operation without actionable presentation shows warning and only Cancel — never confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "rehydrated-proposed-1",
      status: "cancelled",
    });

    render(
      <TedApprovalCard
        operation={{
          id: "rehydrated-proposed-1",
          status: "proposed",
          operation: "transactions.expense.create",
          summary: "Rehydrated old pending operation",
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/não é possível confirmar/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "rehydrated-proposed-1",
        "cancel",
      ),
    );
    expect(
      vi.mocked(agentClient.decidePendingOperation).mock.calls.every(([, , decision]) => decision !== "confirm"),
    ).toBe(true);
  });

  it("failed rehydrated operation without actionable presentation shows no Retry and never calls retry", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "rehydrated-failed-1",
          status: "failed",
          operation: "transactions.expense.create",
          summary: "Rehydrated old failed operation",
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/não é possível tentar novamente/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar novamente/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
  });

  it("retry with an uncertain outcome locks like approve — executing, no buttons, single send", async () => {
    const user = userEvent.setup();
    const uncertain = Object.assign(
      new Error("O resultado desta operação ainda não pôde ser verificado."),
      { code: "agent.execution_outcome_unknown" },
    );
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(uncertain);

    render(
      <TedApprovalCard
        operation={{
          id: "failed-actionable-1",
          status: "failed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("failed-actionable-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Tentar novamente/i }));

    // Same lock as approve: unverified message, zero decision buttons left,
    // exactly one retry dispatched (no duplicate resend).
    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar novamente/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).toHaveBeenCalledTimes(1);
    expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
      "workspace-1",
      "failed-actionable-1",
      "retry",
    );
  });

  it("retry with approval.execution_uncertain locks like approve", async () => {
    const user = userEvent.setup();
    const uncertain = Object.assign(
      new Error("O resultado desta operação ainda não pôde ser verificado."),
      { code: "approval.execution_uncertain" },
    );
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(uncertain);

    render(
      <TedApprovalCard
        operation={{
          id: "failed-actionable-1",
          status: "failed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("failed-actionable-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Tentar novamente/i }));

    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar novamente/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).toHaveBeenCalledTimes(1);
  });

  it("retry with a generic error keeps the failed state with Retry available (no lock)", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(new Error("rede instável"));

    render(
      <TedApprovalCard
        operation={{
          id: "failed-actionable-1",
          status: "failed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("failed-actionable-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Tentar novamente/i }));

    expect(await screen.findByText("rede instável")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tentar novamente/i })).toBeInTheDocument();
    expect(screen.queryByText(/resultado desta opera.*atualize/i)).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).toHaveBeenCalledTimes(1);
  });

  it("failed with actionable presentation shows Valor/Conta/Categoria/Data before Retry and retry calls the Agent", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "failed-actionable-1",
      status: "failed",
    });

    const { container } = render(
      <TedApprovalCard
        operation={{
          id: "failed-actionable-1",
          status: "failed",
          operation: "transactions.expense.create",
          presentation: actionablePresentation("failed-actionable-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    // Same actionable financial data the user is re-authorizing must be visible…
    expect(screen.getByText("R$ 850,00")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    expect(screen.getByText("Alimentação")).toBeInTheDocument();
    expect(screen.getByText("14/09/2026")).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();

    // …before the Retry button in reading order.
    const retry = screen.getByRole("button", { name: /Tentar novamente/i });
    const amount = screen.getByText("R$ 850,00");
    expect(amount.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toMatch(/R\$ 850,00/);

    await user.click(retry);
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "failed-actionable-1",
        "retry",
      ),
    );
  });

  it("failed with non-actionable presentation shows warning and no Retry", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "failed-degraded-1",
          status: "failed",
          operation: "transactions.expense.create",
          presentation: {
            id: "failed-degraded-1",
            status: "failed",
            tool: "transactions.expense.create",
            title: "Confirmar despesa",
            amountCents: 85000,
            description: "Mercado",
            date: "2026-09-14",
            expiresAt: "2026-09-14T13:00:00.000Z",
            warnings: ["Dados da conta indisponíveis no momento"],
          },
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/não é possível tentar novamente/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar novamente/i })).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["NaN amount", { amountCents: Number.NaN }],
    ["empty account label", { account: { id: "acc-1", label: "  " } }],
    ["missing date", { date: undefined }],
  ])("proposed with invalid presentation (%s) fails closed — Cancel only", (_label, override) => {
    render(
      <TedApprovalCard
        operation={{
          id: "invalid-presentation-1",
          status: "proposed",
          operation: "transactions.expense.create",
          presentation: { ...actionablePresentation("invalid-presentation-1"), ...override },
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/não é possível confirmar/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
  });

  it("does not synthesize a presentation from the summary — summary-only text never enables Confirm or Retry", () => {
    const { rerender } = render(
      <TedApprovalCard
        operation={{
          id: "summary-only-1",
          status: "proposed",
          operation: "transactions.expense.create",
          summary: "Mercado R$ 850,00 Nubank 14/09/2026",
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();

    rerender(
      <TedApprovalCard
        operation={{
          id: "summary-only-1",
          status: "failed",
          operation: "transactions.expense.create",
          summary: "Mercado R$ 850,00 Nubank 14/09/2026",
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /Tentar novamente/i })).not.toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
  });
});
