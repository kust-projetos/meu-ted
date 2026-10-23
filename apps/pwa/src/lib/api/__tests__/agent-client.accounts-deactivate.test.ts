/**
 * accounts.deactivate no PWA (TASK_ID accounts-deactivate-card-pwa).
 *
 * Contrato (packages/llm-contracts, só leitura): presentation carrega título
 * "Desativar conta" + account {id,label} resolvido server-side (gate do
 * Confirm) + snapshots display-only accountName/accountKind/balanceCents.
 * Recibo succeeded: mutationKind accounts.deactivate + entity.type account.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, fetchActivePendingOperations } from "../agent-client";
import * as agentAuth from "../agent-auth";

const deactivatePresentation = {
  id: "op-deact-1",
  status: "proposed",
  tool: "accounts.deactivate",
  title: "Desativar conta",
  account: { id: "acc-1", label: "nubank" },
  accountName: "nubank",
  accountKind: "bank",
  balanceCents: 14500,
  expiresAt: "2026-10-21T15:30:00.000Z",
  warnings: [],
};

const deactivateActiveItem = {
  id: "op-deact-1",
  status: "proposed",
  tool: "accounts.deactivate",
  createdAt: "2026-10-21T15:18:00.000Z",
  expiresAt: "2026-10-21T15:30:00.000Z",
  description: "Desativar conta nubank",
  presentation: deactivatePresentation,
};

const deactivateReceipt = {
  mutationId: "mut-deact-1",
  mutationKind: "accounts.deactivate",
  status: "succeeded",
  affectedTargets: ["accounts", "dashboard-summary"],
  operationId: "op-deact-1",
  entity: { type: "account", id: "acc-1" },
};

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("accounts.deactivate no client PWA", () => {
  it("active list com presentation de deactivate carrega (não descarta o payload)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [deactivateActiveItem], total: 1 }, { status: 200 }),
    );

    const items = await fetchActivePendingOperations("workspace-123");

    expect(items).toHaveLength(1);
    expect(items[0]!.presentation).toMatchObject({
      title: "Desativar conta",
      account: { id: "acc-1", label: "nubank" },
      accountName: "nubank",
      accountKind: "bank",
      balanceCents: 14500,
    });
  });

  it("decisão succeeded com entity account resolve com expected (contexto do card)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-deact-1", status: "succeeded", receipt: deactivateReceipt },
        { status: 200 },
      ),
    );

    const decision = await decidePendingOperation("workspace-123", "op-deact-1", "confirm", {
      tool: "accounts.deactivate",
      entityId: "acc-1",
    });

    expect(decision.status).toBe("succeeded");
    if (decision.status === "succeeded") {
      expect(decision.receipt.entity).toMatchObject({ type: "account", id: "acc-1" });
    }
  });

  it("HIGH3 decide: sem expected, recibo deactivate falha fechado", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-deact-1", status: "succeeded", receipt: deactivateReceipt },
        { status: 200 },
      ),
    );

    await expect(
      decidePendingOperation("workspace-123", "op-deact-1", "confirm"),
    ).rejects.toMatchObject({ code: "agent.execution_outcome_unknown" });
  });
});
