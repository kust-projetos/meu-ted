/**
 * P3.3 — internal transfer approval card.
 *
 * The card is projected server-side from the hash-bound transfer args; the
 * PWA only renders it and sends a decision. Confirm/Reject move no authority
 * into the browser.
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

const FROM_ID = "11111111-1111-4111-8111-111111111111";
const TO_ID = "11111111-1111-4111-8111-111111111112";

const transferPresentation = (id: string): PendingOperationPresentation => ({
  id,
  status: "proposed",
  tool: "transactions.transfer.create",
  title: "Transferência de R$ 300,00",
  amountCents: 30000,
  description: "Transferência Itaú → Nubank",
  date: "2026-11-07",
  fromAccount: { id: FROM_ID, label: "Itaú" },
  toAccount: { id: TO_ID, label: "Nubank" },
  expiresAt: "2026-11-07T13:00:00.000Z",
  warnings: [],
});

const succeededDecision = (id: string): agentClient.PendingOperationDecision => ({
  operationId: id,
  status: "succeeded",
  receipt: {
    mutationId: "mut-transfer",
    mutationKind: "transactions.transfer.create",
    status: "succeeded",
    affectedTargets: ["transactions", "accounts", "dashboard-summary"],
    operationId: id,
    entity: { type: "transaction", id: "tx-transfer-1" },
  },
});

describe("TedApprovalCard — internal transfer", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("renders title, origin and destination from the server presentation and confirms", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue(succeededDecision("op-transfer"));

    render(
      <TedApprovalCard
        operation={{
          id: "op-transfer",
          status: "proposed",
          operation: "transactions.transfer.create",
          presentation: transferPresentation("op-transfer"),
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText(/Transferência de R\$ 300,00/)).toBeInTheDocument();
    expect(screen.getByText("Itaú")).toBeInTheDocument();
    expect(screen.getByText("Nubank")).toBeInTheDocument();
    expect(screen.getByText("Origem")).toBeInTheDocument();
    expect(screen.getByText("Destino")).toBeInTheDocument();
    expect(screen.queryByText("Categoria")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Confirmar R\$ 300,00/ }));

    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-transfer",
        "confirm",
        { tool: "transactions.transfer.create" },
      ),
    );
    expect(await screen.findByText(/registrada/i)).toBeInTheDocument();
    expect(JSON.stringify(vi.mocked(agentClient.decidePendingOperation).mock.calls)).not.toContain("attestation");
  });

  it("offers Rejeitar and sends a cancel decision without moving money", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({
      operationId: "op-transfer-cancel",
      status: "cancelled",
    });

    render(
      <TedApprovalCard
        operation={{
          id: "op-transfer-cancel",
          status: "proposed",
          operation: "transactions.transfer.create",
          presentation: transferPresentation("op-transfer-cancel"),
        }}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rejeitar" }));

    await waitFor(() =>
      expect(agentClient.decidePendingOperation).toHaveBeenCalledWith(
        "workspace-1",
        "op-transfer-cancel",
        "cancel",
        { tool: "transactions.transfer.create" },
      ),
    );
    expect(await screen.findByText(/cancelada/i)).toBeInTheDocument();
  });

  it("never offers Confirm when either account label is missing (fail-closed)", () => {
    const degraded = transferPresentation("op-transfer-degraded");
    delete degraded.toAccount;

    render(
      <TedApprovalCard
        operation={{
          id: "op-transfer-degraded",
          status: "proposed",
          operation: "transactions.transfer.create",
          presentation: degraded,
        }}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });
});
