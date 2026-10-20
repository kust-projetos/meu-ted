/**
 * accounts.create no PWA (branch feat/ted-account-creation-v2).
 *
 * Evidência live: POST /pending-operations/v2/propose → 201 e
 * GET /v2/active → 200, mas o client exibia "Não foi possível carregar as
 * aprovações agora" — o schema local estrito desconhecia os campos novos
 * (accountName/accountKind/initialBalanceCents) e descartava o payload
 * inteiro. E o gate de receipt exigia entity.type 'transaction', o que
 * travaria o sucesso de accounts.create (entity.type 'account') como
 * não-verificado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePendingOperation, fetchActivePendingOperations } from "../agent-client";
import * as agentAuth from "../agent-auth";

const accountPresentation = {
  id: "op-acc-1",
  status: "proposed",
  tool: "accounts.create",
  title: "Confirmar conta",
  accountName: "nubank",
  accountKind: "bank",
  initialBalanceCents: 14500,
  expiresAt: "2026-10-20T15:30:00.000Z",
  warnings: [],
};

const accountActiveItem = {
  id: "op-acc-1",
  status: "proposed",
  tool: "accounts.create",
  createdAt: "2026-10-20T15:18:00.000Z",
  expiresAt: "2026-10-20T15:30:00.000Z",
  description: "Criar conta nubank",
  presentation: accountPresentation,
};

const accountReceipt = {
  mutationId: "mut-acc-1",
  mutationKind: "accounts.create",
  status: "succeeded",
  affectedTargets: ["accounts", "dashboard-summary"],
  operationId: "op-acc-1",
  entity: { type: "account", id: "acc-1" },
};

const stubAgentAuth = () =>
  vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("accounts.create no client PWA", () => {
  it("active list com presentation de conta carrega (não descarta o payload)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ items: [accountActiveItem], total: 1 }, { status: 200 }),
    );

    const items = await fetchActivePendingOperations("workspace-123");

    expect(items).toHaveLength(1);
    expect(items[0]!.presentation).toMatchObject({
      title: "Confirmar conta",
      accountName: "nubank",
      accountKind: "bank",
      initialBalanceCents: 14500,
    });
  });

  it("decisão succeeded com entity account resolve (não trava como não-verificada)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    stubAgentAuth();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { operationId: "op-acc-1", status: "succeeded", receipt: accountReceipt },
        { status: 200 },
      ),
    );

    const decision = await decidePendingOperation("workspace-123", "op-acc-1", "confirm");

    expect(decision.status).toBe("succeeded");
    if (decision.status === "succeeded") {
      expect(decision.receipt.entity).toMatchObject({ type: "account", id: "acc-1" });
    }
  });
});
