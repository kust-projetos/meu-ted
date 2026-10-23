/**
 * Card "Renomear categoria" (categories.update — nome-only).
 *
 * O card reutiliza o wiring de Confirmar/Cancelar; a tupla de exibição é
 * De → Para: `category` carrega o nome ATUAL resolvido server-side (gate do
 * Confirm) e `categoryName` carrega o nome NOVO. Sem qualquer uma das duas,
 * o card degrada sem Confirmar (fail-closed) — nunca um "renomear" cego.
 */
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

const renamePresentation = (id: string): PendingOperationPresentation => ({
  id,
  status: "proposed",
  tool: "categories.update",
  title: "Renomear categoria",
  category: { id: "cat-1", label: "QA Viagem Safira" },
  categoryName: "QA Viagem Esmeralda",
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
});

describe("TedApprovalCard categories.update", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("exibe De → Para no card Renomear categoria", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-rename-1",
          status: "proposed",
          operation: "categories.update",
          presentation: renamePresentation("op-cat-rename-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Renomear categoria/)).toBeInTheDocument();
    expect(screen.getByText("De (atual)")).toBeInTheDocument();
    expect(screen.getByText("QA Viagem Safira")).toBeInTheDocument();
    expect(screen.getByText("Para (novo)")).toBeInTheDocument();
    expect(screen.getByText("QA Viagem Esmeralda")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("o efeito anunciado é o de renomear (nunca 'valor registrado')", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-rename-2",
          status: "proposed",
          operation: "categories.update",
          presentation: renamePresentation("op-cat-rename-2"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/A categoria será renomeada nos seus dados\./)).toBeInTheDocument();
    expect(screen.queryByText(/O valor será registrado/)).not.toBeInTheDocument();
  });

  it("Confirmar chama o approve V2 com o alvo da categoria", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-cat-rename-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-cat-rename-1",
        mutationKind: "categories.update",
        status: "succeeded",
        affectedTargets: ["categories", "transactions"],
        operationId: "op-cat-rename-1",
        entity: { type: "category", id: "cat-1" },
      },
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-rename-1",
          status: "proposed",
          operation: "categories.update",
          presentation: renamePresentation("op-cat-rename-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-cat-rename-1",
        "confirm",
        { tool: "categories.update", entityId: "cat-1" },
      ),
    );
  });

  it("item sem o nome novo degrada sem Confirmar (só Cancelar)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-rename-bad",
          status: "proposed",
          operation: "categories.update",
          presentation: {
            id: "op-cat-rename-bad",
            status: "proposed",
            tool: "categories.update",
            title: "Renomear categoria",
            category: { id: "cat-1", label: "QA Viagem Safira" },
            expiresAt: "2026-10-21T15:30:00.000Z",
            warnings: [],
          },
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/não é possível confirmar/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
  });

  it("item sem o nome atual (alvo não resolvido) degrada sem Confirmar (só Cancelar)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-cat-rename-bad2",
          status: "proposed",
          operation: "categories.update",
          presentation: {
            id: "op-cat-rename-bad2",
            status: "proposed",
            tool: "categories.update",
            title: "Renomear categoria",
            categoryName: "QA Viagem Esmeralda",
            expiresAt: "2026-10-21T15:30:00.000Z",
            warnings: [],
          },
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/não é possível confirmar/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(agentClient.decidePendingOperation).not.toHaveBeenCalled();
  });
});
