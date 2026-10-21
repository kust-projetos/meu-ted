/**
 * Card "Desativar conta" (accounts.deactivate — TASK_ID accounts-deactivate-card-pwa).
 *
 * O card reutiliza o wiring de Confirmar/Cancelar dos cards existentes; só a
 * tupla de exibição muda (conta resolvida server-side + nome/tipo/saldo).
 * Sem account válido (label resolvida) degrada sem Confirmar (fail-closed).
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

const deactivatePresentation = (id: string): PendingOperationPresentation => ({
  id,
  status: "proposed",
  tool: "accounts.deactivate",
  title: "Desativar conta",
  account: { id: "acc-1", label: "nubank" },
  accountName: "nubank",
  accountKind: "bank",
  balanceCents: 14500,
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
});

describe("TedApprovalCard accounts.deactivate", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("exibe nome + tipo + saldo no card Desativar conta", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-deact-1",
          status: "proposed",
          operation: "accounts.deactivate",
          presentation: deactivatePresentation("op-deact-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Desativar conta/)).toBeInTheDocument();
    expect(screen.getByText("nubank")).toBeInTheDocument();
    expect(screen.getByText("Banco")).toBeInTheDocument();
    expect(screen.getByText("R$ 145,00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("Confirmar chama o approve V2 com confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-deact-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-deact-1",
        mutationKind: "accounts.deactivate",
        status: "succeeded",
        affectedTargets: ["accounts", "dashboard-summary"],
        operationId: "op-deact-1",
        entity: { type: "account", id: "acc-1" },
      },
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-deact-1",
          status: "proposed",
          operation: "accounts.deactivate",
          presentation: deactivatePresentation("op-deact-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-deact-1",
        "confirm",
      ),
    );
  });

  it("Cancelar chama o cancel V2", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-deact-1",
      status: "cancelled",
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-deact-1",
          status: "proposed",
          operation: "accounts.deactivate",
          presentation: deactivatePresentation("op-deact-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-deact-1",
        "cancel",
      ),
    );
  });

  it("item sem account válido degrada sem Confirmar (só Cancelar)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-deact-bad",
          status: "proposed",
          operation: "accounts.deactivate",
          presentation: {
            id: "op-deact-bad",
            status: "proposed",
            tool: "accounts.deactivate",
            title: "Desativar conta",
            accountName: "nubank",
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
