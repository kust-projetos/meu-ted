/**
 * P3 — proposal intent client contract.
 *
 * The PWA accepts the runtime intent ONLY in the exact expense shape, forwards
 * it to the authenticated Agent broker, and never treats it as authority. Card
 * state always comes from the authoritative active list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proposePendingExpense,
  sanitizeProposalIntent,
  sendAgentMessage,
  composeChatSend,
  type ExpenseProposalIntent,
} from "../agent-client";
import * as agentAuth from "../agent-auth";

vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";

const intent = (overrides: Record<string, unknown> = {}): ExpenseProposalIntent => ({
  tool: "transactions.expense.create",
  intentionId: "int-abc",
  normalizedArgs: {
    amountCents: 5000,
    description: "mercado",
    date: "2026-11-06",
    accountId: ACCOUNT,
    categoryId: CATEGORY,
  },
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
});

describe("sanitizeProposalIntent", () => {
  it("accepts only the exact expense intent", () => {
    expect(sanitizeProposalIntent(intent())).toEqual(intent());
    expect(sanitizeProposalIntent({ ...intent(), tool: "transactions.transfer.create" })).toBeUndefined();
    expect(sanitizeProposalIntent({ ...intent(), extra: 1 })).toBeUndefined();
    expect(
      sanitizeProposalIntent({ ...intent(), normalizedArgs: { ...intent().normalizedArgs, workspaceId: "ws" } }),
    ).toBeUndefined();
    expect(
      sanitizeProposalIntent({ ...intent(), normalizedArgs: { ...intent().normalizedArgs, amountCents: 0 } }),
    ).toBeUndefined();
  });
});

describe("proposePendingExpense", () => {
  it("POSTs the intent to the Agent broker with the connection token", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ id: "op-1", existing: false }, { status: 200 });
    });

    const result = await proposePendingExpense("workspace-123", intent());

    expect(result).toEqual({ id: "op-1", existing: false });
    expect(capturedUrl).toBe(
      "https://agent.example.test/agents/finance-chat-agent/workspace-123/rpc/pending-operations/propose",
    );
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["x-agent-connection-token"]).toBe("signed-token-123");
    expect((capturedInit?.headers as Record<string, string>)["X-Workspace-Id"]).toBe("workspace-123");
    expect(JSON.parse(String(capturedInit?.body))).toEqual(intent());
  });

  it("never sends an invalid intent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const err = await proposePendingExpense("ws-1", intent({ tool: "evil" as never })).catch((e) => e);
    expect(err.code).toBe("agent.invalid_proposal");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("propagates a typed broker refusal", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ code: "agent.approval_context_required" }, { status: 401 }),
    );
    const err = await proposePendingExpense("ws-1", intent()).catch((e) => e);
    expect(err.code).toBe("agent.approval_context_required");
  });

  it("rejects a response without an operation id (never invents a card)", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ existing: false }));
    const err = await proposePendingExpense("ws-1", intent()).catch((e) => e);
    expect(err.code).toBe("agent.proposal_failed");
  });
});

describe("sendAgentMessage — proposal field", () => {
  it("returns a valid proposal intent and clears the retry anchor", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ turnId: "t-1", status: "completed", output: "Vou preparar.", proposal: intent() }),
    );
    const send = composeChatSend("Registre uma despesa de R$ 50 no mercado, na conta Nubank.");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(turn.proposal).toEqual(intent());
  });

  it("drops an invalid proposal instead of forwarding it", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        turnId: "t-1",
        status: "completed",
        output: "ok",
        proposal: { ...intent(), tool: "transactions.transfer.create" },
      }),
    );
    const turn = await sendAgentMessage("ws-1", "oi", { messageId: "m-1" });
    expect(turn.proposal).toBeUndefined();
  });
});
