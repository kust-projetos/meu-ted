/**
 * categories.update no PWA — os DOIS parsers reais (turno + decisão).
 *
 * Contrato (packages/llm-contracts): presentation carrega título "Renomear
 * categoria" + category {id,label} com o nome ATUAL resolvido server-side
 * (gate do Confirm) + categoryName com o nome NOVO. Recibo succeeded:
 * mutationKind categories.update + entity.type category.
 *
 * Alvo sensível: o recibo tem de casar tool + entity.type + entity.id +
 * operationId + o contexto do card. Qualquer divergência falha fechado
 * (`agent.execution_outcome_unknown`) — nunca um sucesso parcial.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, fetchActivePendingOperations, sendAgentMessage } from "../agent-client";
import * as agentAuth from "../agent-auth";

const renamePresentation = {
  id: "op-cat-rename-1",
  status: "proposed",
  tool: "categories.update",
  title: "Renomear categoria",
  category: { id: "cat-1", label: "QA Viagem Safira" },
  categoryName: "QA Viagem Esmeralda",
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
};

const renameActiveItem = {
  id: "op-cat-rename-1",
  status: "proposed",
  tool: "categories.update",
  createdAt: "2026-10-21T15:18:00.000Z",
  expiresAt: "2026-10-21T15:30:00.000Z",
  description: "Renomear a categoria",
  presentation: renamePresentation,
};

const renameReceipt = {
  mutationId: "mut-cat-rename-1",
  mutationKind: "categories.update",
  status: "succeeded",
  affectedTargets: ["categories", "transactions"],
  operationId: "op-cat-rename-1",
  entity: { type: "category", id: "cat-1" },
};

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("categories.update no client PWA", () => {
  it("active list com presentation de rename carrega (não descarta o payload)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [renameActiveItem], total: 1 }, { status: 200 }),
    );

    const items = await fetchActivePendingOperations("workspace-123");

    expect(items).toHaveLength(1);
    expect(items[0]!.presentation).toMatchObject({
      title: "Renomear categoria",
      category: { id: "cat-1", label: "QA Viagem Safira" },
      categoryName: "QA Viagem Esmeralda",
    });
  });

  it("decisão succeeded com expected (contexto do card) resolve", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-cat-rename-1", status: "succeeded", receipt: renameReceipt },
        { status: 200 },
      ),
    );

    const decision = await decidePendingOperation("workspace-123", "op-cat-rename-1", "confirm", {
      tool: "categories.update",
      entityId: "cat-1",
    });

    expect(decision.status).toBe("succeeded");
    if (decision.status === "succeeded") {
      expect(decision.receipt.entity).toMatchObject({ type: "category", id: "cat-1" });
    }
  });

  it("decisão succeeded SEM expected (alvo sensível) falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-cat-rename-1", status: "succeeded", receipt: renameReceipt },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-rename-1", "confirm"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão com entity.type transação (kind trocado) falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-cat-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, entity: { type: "transaction", id: "cat-1" } },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-rename-1", "confirm", {
        tool: "categories.update",
        entityId: "cat-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão com OUTRO alvo (entityId divergente) falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-cat-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, entity: { type: "category", id: "cat-2" } },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-rename-1", "confirm", {
        tool: "categories.update",
        entityId: "cat-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão com receipt de OUTRA tool falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-cat-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, mutationKind: "categories.create" },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-rename-1", "confirm", {
        tool: "categories.update",
        entityId: "cat-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("decisão com operationId divergente falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          operationId: "op-cat-rename-1",
          status: "succeeded",
          receipt: { ...renameReceipt, operationId: "op-outra" },
        },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-cat-rename-1", "confirm", {
        tool: "categories.update",
        entityId: "cat-1",
      }),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("turno: succeeded com presentation de outra categoria falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t-cat-rename-1",
          status: "completed",
          output: "Renomeada.",
          pendingOperation: {
            id: "op-cat-rename-1",
            status: "succeeded",
            operation: "categories.update",
            presentation: renamePresentation,
            receipt: { ...renameReceipt, entity: { type: "category", id: "cat-2" } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      sendAgentMessage("workspace-123", "renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });

  it("turno: succeeded sem a apresentação (contexto ausente) falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          turnId: "t-cat-rename-2",
          status: "completed",
          output: "Renomeada.",
          pendingOperation: {
            id: "op-cat-rename-1",
            status: "succeeded",
            operation: "categories.update",
            receipt: renameReceipt,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      sendAgentMessage("workspace-123", "renomeie a categoria QA Viagem Safira para QA Viagem Esmeralda"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });
});
