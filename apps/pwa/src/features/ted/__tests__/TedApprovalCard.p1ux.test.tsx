import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedApprovalCard } from "../TedApprovalCard";
import * as agentClient from "@/lib/api/agent-client";
import type { PendingOperationDecision, PendingOperationPresentation } from "@/lib/api/agent-client";

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

const proposedOp = (id: string) => ({
  id,
  status: "proposed" as const,
  operation: "transactions.expense.create",
  presentation: actionablePresentation(id),
});

describe("TedApprovalCard remote status sync (FIX-P1-UX #171)", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("reflects a remote proposed→executing transition without resurrecting buttons", () => {
    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );
    expect(screen.getByRole("button", { name: /Confirmar/ })).toBeInTheDocument();

    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "executing" }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.getByText(/processando opera/i)).toBeInTheDocument();
  });

  it("reflects a remote proposed→expired transition as a terminal state with no buttons", () => {
    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );

    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "expired" }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/expirada/i)).toBeInTheDocument();
  });

  it("never downgrades a local unverified lock back to proposed (no resurrected buttons)", async () => {
    const user = userEvent.setup();
    const uncertain = Object.assign(
      new Error("O resultado desta operação ainda não pôde ser verificado."),
      { code: "approval.execution_uncertain" },
    );
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(uncertain);

    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();

    // The parent refresh still carries the stale `proposed` snapshot — the
    // local lock must survive it instead of resurrecting Confirm/Cancel.
    rerender(<TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />);

    expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.getByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
  });

  it("ignores a stale proposed GET that arrives after executing (no resurrected buttons)", () => {
    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );
    expect(screen.getByRole("button", { name: /Confirmar/ })).toBeInTheDocument();

    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "executing" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();

    // A defasado refresh that still carries the older `proposed` snapshot
    // must never step the card back to actionable.
    rerender(<TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />);

    expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.getByText(/processando opera/i)).toBeInTheDocument();
  });

  it("preserves a terminal state against a stale proposed GET", () => {
    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );

    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "expired" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/expirada/i)).toBeInTheDocument();

    // The terminal verdict stands: an older snapshot never revives the card.
    rerender(<TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/expirada/i)).toBeInTheDocument();
  });

  it("a more advanced remote state that lands during the RPC wins over the staler RPC verdict", async () => {
    const user = userEvent.setup();
    let resolveRpc!: (
      value: PendingOperationDecision | PromiseLike<PendingOperationDecision>,
    ) => void;
    vi.mocked(agentClient.decidePendingOperation).mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      }),
    );

    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    // While the confirm RPC is in flight, the authoritative refresh reports
    // the operation already succeeded elsewhere.
    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "succeeded" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByText(/registrada/)).toBeInTheDocument();

    // The late RPC verdict is older truth — it must not step the card back
    // to the failure state.
    resolveRpc({ operationId: "op-1", status: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText(/registrada/)).toBeInTheDocument();
    expect(screen.queryByText(/processando opera/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("FIX-P1-UX-R3 HIGH: a stale failed GET after succeeded never regresses the terminal (no resurrected Retry)", () => {
    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-1")} workspaceId="ws-1" />,
    );

    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "succeeded" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByText(/registrada/)).toBeInTheDocument();

    // A defasado refresh carrying the older `failed` terminal must not step
    // the card back to the failure shape — Retry stays buried.
    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "failed" }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.getByText(/registrada/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("FIX-P1-UX-R3 HIGH: a late failed RPC after a succeeded refresh never resurrects Retry", async () => {
    const user = userEvent.setup();
    let resolveRpc!: (decision: { operationId: string; status: "failed" }) => void;
    vi.mocked(agentClient.decidePendingOperation).mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve as (decision: { operationId: string; status: "failed" }) => void;
      }),
    );

    const { rerender } = render(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "failed" }}
        workspaceId="ws-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));

    // While the retry RPC is in flight, the authoritative refresh reports
    // the operation already succeeded elsewhere.
    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "succeeded" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByText(/registrada/)).toBeInTheDocument();

    // The late failed verdict is older truth — it must not regress the card
    // to failed nor resurrect Retry.
    resolveRpc({ operationId: "op-1", status: "failed" });
    await screen.findByText(/registrada/);

    expect(screen.queryByRole("button", { name: /tentar novamente/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("FIX-P1-UX-R3 MEDIUM: failed→executing→succeeded follows a legitimate retry (no stuck failure)", () => {
    const { rerender } = render(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "failed" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();

    // The retry legitimately re-enters execution: the card must follow it
    // instead of freezing on the failure shape.
    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "executing" }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /tentar novamente/i })).not.toBeInTheDocument();
    expect(screen.getByText(/processando opera/i)).toBeInTheDocument();

    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-1"), status: "succeeded" }}
        workspaceId="ws-1"
      />,
    );

    expect(screen.getByText(/registrada/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("FIX-P1-UX-R4: late confirm rejection after a succeeded refresh keeps the definitive terminal (no lock regression)", async () => {
    const user = userEvent.setup();
    let rejectRpc!: (e: unknown) => void;
    vi.mocked(agentClient.decidePendingOperation).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRpc = reject;
      }),
    );

    const { rerender } = render(
      <TedApprovalCard operation={proposedOp("op-r4-confirm")} workspaceId="ws-1" />,
    );
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    // Authoritative refresh lands while the confirm RPC is in flight.
    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-r4-confirm"), status: "succeeded" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByText(/registrada/)).toBeInTheDocument();

    // The late RPC rejection must NOT regress the definitive terminal back
    // to executing/uncertain — the card stays terminal, unlocked.
    rejectRpc(new Error("network down"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText(/registrada/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/resultado desta opera.*atualize/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/processando opera/i)).not.toBeInTheDocument();
  });

  it("FIX-P1-UX-R4: late retry rejection after a succeeded refresh keeps the definitive terminal (no lock regression)", async () => {
    const user = userEvent.setup();
    let rejectRpc!: (e: unknown) => void;
    vi.mocked(agentClient.decidePendingOperation).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRpc = reject;
      }),
    );

    const { rerender } = render(
      <TedApprovalCard
        operation={{ ...proposedOp("op-r4-retry"), status: "failed" }}
        workspaceId="ws-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));

    // Authoritative refresh lands while the retry RPC is in flight.
    rerender(
      <TedApprovalCard
        operation={{ ...proposedOp("op-r4-retry"), status: "succeeded" }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByText(/registrada/)).toBeInTheDocument();

    // Uncertain late rejection must NOT regress the definitive terminal.
    rejectRpc(
      Object.assign(new Error("outcome unknown"), { code: "approval.execution_uncertain" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText(/registrada/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/resultado desta opera.*atualize/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/processando opera/i)).not.toBeInTheDocument();
  });
});
