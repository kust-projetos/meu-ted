/**
 * Card "Criar categoria" (categories.create) — fatia categories-create-v2-endtoend.
 * Nome + tipo + pai reais; copy "A categoria será criada", nunca lançamento.
 * Receipt category fail-closed em mismatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedApprovalCard } from "../TedApprovalCard";
import * as agentClient from "@/lib/api/agent-client";
import type { PendingOperationPresentation } from "@/lib/api/agent-client";

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return { ...actual, decidePendingOperation: vi.fn() };
});

const categoryPresentation = (id: string): PendingOperationPresentation => ({
  id,
  status: "proposed",
  tool: "categories.create",
  title: "Criar categoria",
  categoryName: "Mercado",
  categoryKind: "expense",
  category: { id: "parent-1", label: "Alimentação" },
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
});

describe("TedApprovalCard categories.create", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("exibe nome + tipo + pai reais, sem copy de lançamento", () => {
    const { container } = render(
      <TedApprovalCard
        operation={{
          id: "op-cat-1",
          status: "proposed",
          operation: "categories.create",
          presentation: categoryPresentation("op-cat-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Criar categoria/)).toBeInTheDocument();
    expect(screen.getByText("Mercado")).toBeInTheDocument();
    expect(screen.getByText("Despesa")).toBeInTheDocument();
    expect(screen.getByText("Alimentação")).toBeInTheDocument();
    expect(container.textContent).toMatch(/categoria será criada/i);
    expect(container.textContent).not.toMatch(/lançamento registrado/i);
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
  });

  it("Confirmar vincula receipt category e rejeita mismatch de transação", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-cat-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-cat-1",
        mutationKind: "categories.create",
        status: "succeeded",
        affectedTargets: ["categories", "transactions"],
        operationId: "op-cat-1",
        entity: { type: "category", id: "cat-1" },
      },
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-1",
          status: "proposed",
          operation: "categories.create",
          presentation: categoryPresentation("op-cat-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
      "workspace-1",
      "op-cat-1",
      "confirm",
      expect.objectContaining({ tool: "categories.create" }),
    );
  });

  it("R7-F7a: operação sem presentation (pai removido) não oferece Confirm — só Cancelar", async () => {
    const user = userEvent.setup();

    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-gone",
          status: "proposed",
          operation: "categories.create",
          summary: "Criar categoria Mercado",
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.queryByRole("button", { name: "Confirmar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.getByText(/Dados da operação incompletos/)).toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
      "workspace-1",
      "op-cat-gone",
      "cancel",
      undefined,
    );
  });
});
