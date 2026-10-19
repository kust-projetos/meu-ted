/**
 * FIX achado P2-2 (Tools+PWA): resposta de aprovação inválida deixava decisões acionáveis.
 *
 * `decidePendingOperation` usava `pendingDecisionSchema.parse(...)` — um
 * `succeeded` com campo extra rejeitado pelo `.strict()` lançava `ZodError`
 * ANTES das verificações que produzem `agent.execution_outcome_unknown`, e o
 * catch do card tratava como erro comum, mantendo Confirmar/Cancelar.
 *
 * Contrato: falhas de parsing/validação de respostas de decisão são resultado
 * NÃO verificado — o card trava como unverified (lock + reconciliação
 * obrigatória), nunca com botões de decisão.
 *
 * Teste integrado cliente→card: usa o `decidePendingOperation` REAL (só
 * rede/token dublados) cobrindo `succeeded` com campo extra.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedApprovalCard } from "../TedApprovalCard";
import { decidePendingOperation } from "@/lib/api/agent-client";
import type { PendingOperationPresentation } from "@/lib/api/agent-client";
import * as agentAuth from "@/lib/api/agent-auth";

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

const validReceipt = (operationId: string) => ({
  mutationId: "mut-1",
  mutationKind: "transactions.expense.create",
  status: "succeeded",
  affectedTargets: ["transactions"],
  operationId,
  entity: { type: "transaction", id: "tx-1" },
});

const decisionResponse = (operationId: string, extra: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      operationId,
      status: "succeeded",
      receipt: validReceipt(operationId),
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("P2-2: decisão inválida trava como não-verificada (cliente→card)", () => {
  it("RED: `succeeded` com campo extra é resultado NÃO verificado no cliente", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionResponse("op-poison", { attestation: "x".repeat(64) }),
    );

    const err = await decidePendingOperation("ws-1", "op-poison", "confirm").then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err).not.toBeNull();
    expect((err as { code?: string })?.code).toBe("agent.execution_outcome_unknown");
  });

  it("RED: card trava sem botões de decisão quando a decisão volta inválida", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionResponse("op-card", { injected: "campo-extra" }),
    );
    render(<TedApprovalCard operation={proposedOp("op-card")} workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    // Lock unverified + reconciliação obrigatória: mensagem de não-verificado…
    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
    // …e NENHUM botão de decisão (nem Confirmar, nem Cancelar, nem Retry).
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).not.toBeInTheDocument();
  });

  it("RED: card trava como não-verificado quando decisão 2xx volta com corpo inválido", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("", { status: 200, headers: { "content-type": "application/json" } }),
    );
    render(<TedApprovalCard operation={proposedOp("op-empty")} workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /Confirmar/ }));

    // Corpo 2xx vazio/truncado = outcome NÃO verificado (execução pode ter
    // ocorrido): lock + reconciliação, nunca botões de decisão.
    expect(await screen.findByText(/resultado desta opera.*atualize/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Confirmar/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).not.toBeInTheDocument();
  });
});
