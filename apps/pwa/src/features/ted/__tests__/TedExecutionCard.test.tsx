import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TedExecutionCard } from "../TedExecutionCard";
import type { SelfConfirmExecution } from "@/lib/api/agent-client";

const RECEIPT = {
  mutationId: "mut-1",
  mutationKind: "transactions.expense.create" as const,
  status: "succeeded" as const,
  affectedTargets: ["transactions" as const],
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

describe("TedExecutionCard — resultado somente leitura", () => {
  it("succeeded: mostra o estado final validado e nenhum botão de decisão", () => {
    render(<TedExecutionCard execution={succeeded} />);
    const card = screen.getByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "succeeded");
    expect(card).toHaveTextContent("Recibo validado");
    expect(screen.queryByRole("button")).toBeNull();
    expect(card).not.toHaveTextContent("mut-1");
    expect(card).not.toHaveTextContent("attestation");
    expect(card).not.toHaveTextContent("hash");
  });

  it("failed: mostra a falha terminal sem Confirmar/Cancelar/Tentar novamente", () => {
    render(<TedExecutionCard execution={failed} />);
    const card = screen.getByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "failed");
    expect(card).toHaveTextContent("Não foi possível concluir a operação");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("unverified: nunca afirma sucesso e permanece sem botões", () => {
    render(<TedExecutionCard execution={unverified} />);
    const card = screen.getByTestId("ted-execution-card");
    expect(card).toHaveAttribute("data-execution-status", "unverified");
    expect(card).toHaveTextContent("Não foi possível verificar a conclusão");
    expect(card).not.toHaveTextContent("concluída");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
