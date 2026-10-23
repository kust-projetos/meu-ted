/**
 * categories.create no PWA — parsers REAIS, sem mock de decisão (R7-F7b).
 *
 * Ambos os parsers (`sanitizePendingOperation` no turno +
 * `decidePendingOperation` na decisão) rejeitam mismatch de
 * tool/entidade/operationId com `agent.execution_outcome_unknown` —
 * nunca sucesso falso. Espelha `agent-client.accounts-update.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, sendAgentMessage } from "../agent-client";
import * as agentAuth from "../agent-auth";

const categoryPresentation = {
  id: "op-cat-1",
  status: "proposed",
  tool: "categories.create",
  title: "Criar categoria",
  categoryName: "Mercado",
  categoryKind: "expense",
  category: { id: "parent-1", label: "Alimentação" },
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
};

const catReceipt = {
  mutationId: "mut-cat-1",
  mutationKind: "categories.create",
  status: "succeeded",
  affectedTargets: ["categories", "transactions"],
  operationId: "op-cat-1",
  entity: { type: "category", id: "cat-1" },
};

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const decisionOk = (receipt: unknown, operationId = "op-cat-1") =>
  Response.json({ operationId, status: "succeeded", receipt }, { status: 200 });

const turnOk = (pendingOperation: unknown) =>
  new Response(
    JSON.stringify({
      turnId: "t-cat-1",
      status: "completed",
      output: "Categoria criada.",
      pendingOperation,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("categories.create no client PWA (parsers reais)", () => {
  it("decisão fiel com expected do card → succeeded", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionOk(catReceipt),
    );

    const decision = await decidePendingOperation("workspace-123", "op-cat-1", "confirm", {
      tool: "categories.create",
    });

    expect(decision.status).toBe("succeeded");
    if (decision.status === "succeeded") {
      expect(decision.receipt.entity).toMatchObject({ type: "category", id: "cat-1" });
    }
  });

  it("decisão fiel sem expected passa (kind-only: entidade criada na execução)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionOk(catReceipt),
    );

    const decision = await decidePendingOperation("workspace-123", "op-cat-1", "confirm");

    expect(decision.status).toBe("succeeded");
  });

  it("decisão: recibo de despesa com expected de categoria falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionOk({
        mutationId: "mut-tx-1",
        mutationKind: "transactions.expense.create",
        status: "succeeded",
        affectedTargets: ["transactions"],
        operationId: "op-cat-1",
        entity: { type: "transaction", id: "tx-1" },
      }),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-1", "confirm", { tool: "categories.create" }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão: entidade transação com kind de categoria falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionOk({ ...catReceipt, entity: { type: "transaction", id: "cat-1" } }),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-1", "confirm", { tool: "categories.create" }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão: operationId divergente falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionOk({ ...catReceipt, operationId: "op-outra" }),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-1", "confirm", { tool: "categories.create" }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão: recibo de outra tool (accounts.create) com expected de categoria falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      decisionOk({
        mutationId: "mut-acc-1",
        mutationKind: "accounts.create",
        status: "succeeded",
        affectedTargets: ["accounts"],
        operationId: "op-cat-1",
        entity: { type: "account", id: "acc-1" },
      }),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-1", "confirm", { tool: "categories.create" }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão: succeeded sem recibo falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ operationId: "op-cat-1", status: "succeeded" }, { status: 200 }),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-1", "confirm", { tool: "categories.create" }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("turno: succeeded fiel com presentation de categoria resolve com recibo", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      turnOk({
        id: "op-cat-1",
        status: "succeeded",
        operation: "categories.create",
        presentation: categoryPresentation,
        receipt: catReceipt,
      }),
    );

    const turn = await sendAgentMessage("workspace-123", "crie categoria Mercado de despesa");

    expect(turn.pendingOperation?.status).toBe("succeeded");
    if (turn.pendingOperation?.status === "succeeded") {
      expect(turn.pendingOperation.receipt.entity).toMatchObject({ type: "category", id: "cat-1" });
    }
  });

  it("turno: succeeded com kind divergente da presentation falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      turnOk({
        id: "op-cat-1",
        status: "succeeded",
        operation: "categories.create",
        presentation: categoryPresentation,
        receipt: { ...catReceipt, mutationKind: "transactions.expense.create", entity: { type: "transaction", id: "tx-1" } },
      }),
    );

    await expect(
      sendAgentMessage("workspace-123", "crie categoria Mercado de despesa"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("turno: succeeded com operationId divergente falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      turnOk({
        id: "op-cat-1",
        status: "succeeded",
        operation: "categories.create",
        presentation: categoryPresentation,
        receipt: { ...catReceipt, operationId: "op-outra" },
      }),
    );

    await expect(
      sendAgentMessage("workspace-123", "crie categoria Mercado de despesa"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("turno: presentation de outra tool com recibo de categoria falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      turnOk({
        id: "op-rename-1",
        status: "succeeded",
        operation: "accounts.update",
        presentation: {
          id: "op-rename-1",
          status: "proposed",
          tool: "accounts.update",
          title: "Renomear conta",
          account: { id: "acc-1", label: "nubank" },
          accountName: "nubank roxo",
          expiresAt: "2026-10-21T15:30:00.000Z",
          warnings: [],
        },
        receipt: { ...catReceipt, operationId: "op-rename-1" },
      }),
    );

    await expect(
      sendAgentMessage("workspace-123", "renomeie a conta nubank"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });
});
