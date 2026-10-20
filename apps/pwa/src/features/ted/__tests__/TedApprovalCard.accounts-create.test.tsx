/**
 * Card "Confirmar conta" (accounts.create) — branch feat/ted-account-creation-v2.
 *
 * O card reutiliza o wiring de Confirmar/Cancelar dos cards de transação;
 * só a tupla de exibição muda (nome + tipo + saldo inicial em vez de
 * valor/descrição/data/conta/categoria).
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

const accountPresentation = (id: string): PendingOperationPresentation => ({
  id,
  status: "proposed",
  tool: "accounts.create",
  title: "Confirmar conta",
  accountName: "nubank",
  accountKind: "bank",
  initialBalanceCents: 14500,
  expiresAt: "2026-10-20T15:30:00.000Z",
  warnings: [],
});

describe("TedApprovalCard accounts.create", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("exibe nome + tipo + saldo inicial formatado no card Confirmar conta", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-acc-1",
          status: "proposed",
          operation: "accounts.create",
          presentation: accountPresentation("op-acc-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Confirmar conta/)).toBeInTheDocument();
    expect(screen.getByText("nubank")).toBeInTheDocument();
    expect(screen.getByText("Banco")).toBeInTheDocument();
    expect(screen.getByText("R$ 145,00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("Confirmar chama o approve V2 com confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-acc-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-acc-1",
        mutationKind: "accounts.create",
        status: "succeeded",
        affectedTargets: ["accounts", "dashboard-summary"],
        operationId: "op-acc-1",
        entity: { type: "account", id: "acc-1" },
      },
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-acc-1",
          status: "proposed",
          operation: "accounts.create",
          presentation: accountPresentation("op-acc-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-acc-1",
        "confirm",
      ),
    );
  });

  it("Cancelar chama o cancel V2", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-acc-1",
      status: "cancelled",
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-acc-1",
          status: "proposed",
          operation: "accounts.create",
          presentation: accountPresentation("op-acc-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-acc-1",
        "cancel",
      ),
    );
  });

  it("presentation de conta incompleta degrada sem Confirmar (só Cancelar)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-acc-bad",
          status: "proposed",
          operation: "accounts.create",
          presentation: {
            id: "op-acc-bad",
            status: "proposed",
            tool: "accounts.create",
            title: "Confirmar conta",
            accountName: "nubank",
            expiresAt: "2026-10-20T15:30:00.000Z",
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
