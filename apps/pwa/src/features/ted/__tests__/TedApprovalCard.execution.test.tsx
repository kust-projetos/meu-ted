/**
 * ADR-033 S2 — the self-confirm terminal card is READ ONLY. It reuses the
 * approval card's visual language/copy but never renders Confirm/Cancel/Retry
 * and never prints a receipt id, attestation or proposal hash. The legacy
 * `proposal` card stays untouched.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TedApprovalCard, TedExecutionCard } from "../TedApprovalCard";
import type { SelfConfirmExecution } from "@/lib/api/agent-client";

const RECEIPT = {
  mutationId: "mut-1",
  mutationKind: "transactions.expense.create" as const,
  status: "succeeded" as const,
  affectedTargets: ["transactions"],
  operationId: "op-1",
  entity: { type: "transaction" as const, id: "tx-1" },
};

const succeeded: SelfConfirmExecution = {
  operationId: "op-1",
  tool: "transactions.expense.create",
  status: "succeeded",
  receipt: RECEIPT,
  outcome: { status: "succeeded" },
};

const failed: SelfConfirmExecution = {
  operationId: "op-2",
  tool: "transactions.income.create",
  status: "failed",
  outcome: { status: "failed", failureCode: "in_use" },
};

const unverified: SelfConfirmExecution = {
  operationId: "op-3",
  tool: "cards.statement.pay",
  status: "unverified",
  outcome: { status: "unverified" },
};

describe("TedExecutionCard — read-only terminal states", () => {
  it("succeeded: shows the validated terminal state and no decision buttons", () => {
    render(<TedExecutionCard execution={succeeded} />);
    const card = screen.getByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "succeeded");
    expect(card).toHaveTextContent("Recibo validado");
    expect(screen.queryByRole("button")).toBeNull();
    expect(card).not.toHaveTextContent("mut-1");
    expect(card).not.toHaveTextContent("attestation");
    expect(card).not.toHaveTextContent("hash");
  });

  it("failed: shows the terminal failure with no Retry/Confirm/Cancel", () => {
    render(<TedExecutionCard execution={failed} />);
    const card = screen.getByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "failed");
    expect(card).toHaveTextContent("Não foi possível concluir a operação");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("unverified: never claims success and stays button-free", () => {
    render(<TedExecutionCard execution={unverified} />);
    const card = screen.getByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "unverified");
    expect(card).toHaveTextContent("Não foi possível verificar a conclusão");
    expect(card).not.toHaveTextContent("concluída");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("legacy approval card stays identical", () => {
  it("a proposed operation with actionable presentation still renders Confirmar/Cancelar", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-legacy",
          status: "proposed",
          operation: "transactions.expense.create",
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
        }}
        workspaceId="ws-1"
      />,
    );
    expect(screen.getByRole("button", { name: "Confirmar R$ 85,00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.queryByTestId("ted-execution-card")).toBeNull();
  });
});
