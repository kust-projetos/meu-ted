/**
 * TASK_ID=CODER-TOOLS-PWA-P4 — RED→GREEN: approval lock só sob incerteza real.
 *
 * `handleApprove` travava QUALQUER erro como não-verificado (`lockUnverified`
 * → executing sem botões). Só incerteza real (resultado pós-write desconhecido
 * — `agent.execution_outcome_unknown` / `approval.execution_uncertain`) trava
 * assim; 502/timeout/offline e demais erros são retentáveis e distinguíveis:
 * mantêm o erro legível e os botões. Estes testes FALHAM antes do fix.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/lib/test-utils";
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

const proposedOp = (id: string) => ({
  id,
  status: "proposed" as const,
  operation: "transactions.expense.create",
  presentation: actionablePresentation(id),
});

describe("TedApprovalCard approve: lock só sob incerteza real", () => {
  beforeEach(() => {
    vi.mocked(agentClient.decidePendingOperation).mockClear();
  });

  it("erro genérico no confirm NÃO trava como não-verificado (botões seguem)", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(new Error("Falha de rede."));
    render(<TedApprovalCard operation={proposedOp("op-err")} workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    expect(await screen.findByText("Falha de rede.")).toBeInTheDocument();
    // Retentável e distinguível: botões seguem acionáveis, sem lock.
    expect(screen.getByRole("button", { name: /Confirmar/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.queryByText(/resultado desta opera.*atualize/i)).not.toBeInTheDocument();
  });

  it("502 do proxy (upstream_unavailable) no confirm é erro retentável, não lock", async () => {
    const user = userEvent.setup();
    const proxy502 = Object.assign(new Error("O assistente está indisponível no momento. Tente novamente mais tarde."), {
      code: "upstream_unavailable",
      status: 502,
    });
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(proxy502);
    render(<TedApprovalCard operation={proposedOp("op-502")} workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    expect(await screen.findByText(/indisponível/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirmar/ })).toBeInTheDocument();
    expect(screen.queryByText(/resultado desta opera.*atualize/i)).not.toBeInTheDocument();
  });

  it("incerteza real (execution_uncertain) no confirm AINDA trava como não-verificado", async () => {
    const user = userEvent.setup();
    const uncertain = Object.assign(
      new Error("O resultado desta operação ainda não pôde ser verificado."),
      { code: "approval.execution_uncertain" },
    );
    vi.mocked(agentClient.decidePendingOperation).mockRejectedValue(uncertain);
    render(<TedApprovalCard operation={proposedOp("op-unc")} workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
  });
});
