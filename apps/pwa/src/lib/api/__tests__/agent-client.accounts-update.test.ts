/**
 * accounts.update no PWA (TASK_ID ted-local-account-rename-client).
 *
 * Contrato (packages/llm-contracts, só leitura): presentation carrega título
 * "Renomear conta" + account {id,label} com o nome ATUAL resolvido
 * server-side (gate do Confirm) + accountName com o nome NOVO. Recibo
 * succeeded: mutationKind accounts.update + entity.type account.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, fetchActivePendingOperations, sendAgentMessage } from "../agent-client";
import * as agentAuth from "../agent-auth";

const renamePresentation = {
  id: "op-rename-1",
  status: "proposed",
  tool: "accounts.update",
  title: "Renomear conta",
  account: { id: "acc-1", label: "nubank" },
  accountName: "nubank roxo",
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
};

const renameActiveItem = {
  id: "op-rename-1",
  status: "proposed",
  tool: "accounts.update",
  createdAt: "2026-10-21T15:18:00.000Z",
  expiresAt: "2026-10-21T15:30:00.000Z",
  description: "Renomear conta nubank",
  presentation: renamePresentation,
};

const renameReceipt = {
  mutationId: "mut-rename-1",
  mutationKind: "accounts.update",
  status: "succeeded",
  affectedTargets: ["accounts", "dashboard-summary"],
  operationId: "op-rename-1",
  entity: { type: "account", id: "acc-1" },
};

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("accounts.update no client PWA", () => {
  it("active list com presentation de rename carrega (não descarta o payload)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [renameActiveItem], total: 1 }, { status: 200 }),
    );

    const items = await fetchActivePendingOperations("workspace-123");

    expect(items).toHaveLength(1);
    expect(items[0]!.presentation).toMatchObject({
      title: "Renomear conta",
      account: { id: "acc-1", label: "nubank" },
      accountName: "nubank roxo",
    });
  });

  it("decisão succeeded com entity account resolve com expected (contexto do card)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-rename-1", status: "succeeded", receipt: renameReceipt },
        { status: 200 },
      ),
    );

    const decision = await decidePendingOperation("workspace-123", "op-rename-1", "confirm", {
      tool: "accounts.update",
      entityId: "acc-1",
    });

    expect(decision.status).toBe("succeeded");
    if (decision.status === "succeeded") {
      expect(decision.receipt.entity).toMatchObject({ type: "account", id: "acc-1" });
    }
  });

  it("HIGH3 decide: sem expected, recibo rename (válido e self-consistente) falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-rename-1", status: "succeeded", receipt: renameReceipt },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-rename-1", "confirm"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("HIGH3 decide: sem expected, recibo expense válido passa (policy distinta — sem target prévio)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    const expenseReceipt = {
      mutationId: "mut-tx-1",
      mutationKind: "transactions.expense.create",
      status: "succeeded",
      affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
      operationId: "op-tx-1",
      entity: { type: "transaction", id: "tx-1" },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-tx-1", status: "succeeded", receipt: expenseReceipt },
        { status: 200 },
      ),
    );

    const decision = await decidePendingOperation("workspace-123", "op-tx-1", "confirm");

    expect(decision.status).toBe("succeeded");
  });

  it("decisão succeeded com kind/entidade divergente trava como não-verificada", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, entity: { type: "transaction", id: "acc-1" } },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-rename-1", "confirm"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("HIGH3 decide: recibo de OUTRA tool com expected falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, mutationKind: "accounts.create", entity: { type: "account", id: "acc-1" } },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-rename-1", "confirm", {
        tool: "accounts.update",
        entityId: "acc-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("HIGH3 decide: recibo de OUTRA conta com expected falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, entity: { type: "account", id: "acc-2" } },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-rename-1", "confirm", {
        tool: "accounts.update",
        entityId: "acc-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("HIGH3 decide: recibo transaction válido (outro kind) falha fechado mesmo sem expected", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-rename-1",
          status: "succeeded",
          receipt: {
            mutationId: "mut-tx-1",
            mutationKind: "transaction.create",
            status: "succeeded",
            affectedTargets: ["transactions"],
            operationId: "op-rename-1",
            entity: { type: "transaction", id: "tx-1" },
          },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-rename-1", "confirm"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("HIGH3 decide: recibo fiel com expected passa (happy)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-rename-1", status: "succeeded", receipt: renameReceipt },
        { status: 200 },
      ),
    );

    const decision = await decidePendingOperation("workspace-123", "op-rename-1", "confirm", {
      tool: "accounts.update",
      entityId: "acc-1",
    });

    expect(decision.status).toBe("succeeded");
  });

  it("HIGH3 turno: succeeded com entidade de outra conta que a apresentação falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t-rename-1",
          status: "completed",
          output: "Renomeada.",
          pendingOperation: {
            id: "op-rename-1",
            status: "succeeded",
            operation: "accounts.update",
            presentation: renamePresentation,
            receipt: { ...renameReceipt, entity: { type: "account", id: "acc-2" } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(sendAgentMessage("workspace-123", "renomeie a conta nubank para roxo")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });

  it("HIGH3 turno: succeeded com kind divergente da operação falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t-rename-2",
          status: "completed",
          output: "Renomeada.",
          pendingOperation: {
            id: "op-rename-1",
            status: "succeeded",
            operation: "accounts.update",
            presentation: renamePresentation,
            receipt: { ...renameReceipt, mutationKind: "accounts.create" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(sendAgentMessage("workspace-123", "renomeie a conta nubank para roxo")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });

  it("HIGH3 decide: substituição por expense válido com expected de rename falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    const txId = "44444444-4444-4444-8444-444444444444";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-rename-1",
          status: "succeeded",
          receipt: {
            mutationId: "mut-tx-1",
            mutationKind: "transactions.expense.create",
            status: "succeeded",
            affectedTargets: ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"],
            operationId: "op-rename-1",
            entity: { type: "transaction", id: txId },
          },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-rename-1", "confirm", {
        tool: "accounts.update",
        entityId: "acc-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("HIGH3 turno: presentation (card) diverge do echo — card precede, conflito nega", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    // Shape real do turno (operation genérica do plano + presentation do
    // card): só o gate de precedência card > echo pode negar aqui — sem
    // ele o echo casaria e o turno seria aceito.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t-rename-3",
          status: "completed",
          output: "Renomeada.",
          pendingOperation: {
            id: "op-rename-1",
            status: "succeeded",
            operation: "list_accounts",
            presentation: renamePresentation,
            expected: { tool: "accounts.create" },
            receipt: { ...renameReceipt, mutationKind: "accounts.create", entity: { type: "account", id: "acc-1" } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(sendAgentMessage("workspace-123", "renomeie a conta nubank para roxo")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });

  it("HIGH3 turno: succeeded rename sem presentation (forma real do turno) falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t-rename-3",
          status: "completed",
          output: "Renomeada.",
          pendingOperation: {
            id: "op-rename-1",
            status: "succeeded",
            operation: "list_accounts",
            receipt: renameReceipt,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(sendAgentMessage("workspace-123", "renomeie a conta nubank para roxo")).rejects.toMatchObject({
      code: "agent.execution_outcome_unknown",
    });
  });
});
