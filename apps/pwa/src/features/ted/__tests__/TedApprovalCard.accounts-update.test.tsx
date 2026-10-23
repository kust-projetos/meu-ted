/**
 * Card "Renomear conta" (accounts.update — TASK_ID ted-local-account-rename-client).
 *
 * O card reutiliza o wiring de Confirmar/Cancelar dos cards existentes; a
 * tupla de exibição é De → Para: `account` carrega o nome atual
 * (`{ id: accountId, label: expectedName }`, resolvido server-side, gate do
 * Confirm) e `accountName` carrega o nome NOVO. Ambas as labels são
 * obrigatórias (actionability): sem qualquer uma, degrada sem Confirmar
 * (fail-closed).
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
  tool: "accounts.update",
  title: "Renomear conta",
  account: { id: "acc-1", label: "nubank" },
  accountName: "nubank roxo",
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
});

describe("TedApprovalCard accounts.update", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("exibe De → Para no card Renomear conta", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-rename-1",
          status: "proposed",
          operation: "accounts.update",
          presentation: renamePresentation("op-rename-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Renomear conta/)).toBeInTheDocument();
    expect(screen.getByText("De (atual)")).toBeInTheDocument();
    expect(screen.getByText("nubank")).toBeInTheDocument();
    expect(screen.getByText("Para (novo)")).toBeInTheDocument();
    expect(screen.getByText("nubank roxo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("Confirmar chama o approve V2 com confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-rename-1",
      status: "succeeded",
      receipt: {
        mutationId: "mut-rename-1",
        mutationKind: "accounts.update",
        status: "succeeded",
        affectedTargets: ["accounts", "dashboard-summary"],
        operationId: "op-rename-1",
        entity: { type: "account", id: "acc-1" },
      },
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-rename-1",
          status: "proposed",
          operation: "accounts.update",
          presentation: renamePresentation("op-rename-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-rename-1",
        "confirm",
        { tool: "accounts.update", entityId: "acc-1" },
      ),
    );
  });

  it("Cancelar chama o cancel V2", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-rename-1",
      status: "cancelled",
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-rename-1",
          status: "proposed",
          operation: "accounts.update",
          presentation: renamePresentation("op-rename-1"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-rename-1",
        "cancel",
        { tool: "accounts.update", entityId: "acc-1" },
      ),
    );
  });

  it("item sem o nome novo degrada sem Confirmar (só Cancelar)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-rename-bad",
          status: "proposed",
          operation: "accounts.update",
          presentation: {
            id: "op-rename-bad",
            status: "proposed",
            tool: "accounts.update",
            title: "Renomear conta",
            account: { id: "acc-1", label: "nubank" },
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

  it("item sem o nome atual degrada sem Confirmar (só Cancelar)", () => {
    render(
      <TedApprovalCard
        operation={{
          id: "op-rename-bad2",
          status: "proposed",
          operation: "accounts.update",
          presentation: {
            id: "op-rename-bad2",
            status: "proposed",
            tool: "accounts.update",
            title: "Renomear conta",
            accountName: "nubank roxo",
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
