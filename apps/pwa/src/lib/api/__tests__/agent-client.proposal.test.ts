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
  loadPendingChatSend,
  savePendingChatSend,
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

  it("accepts the runtime's display summary and forwards only the authoritative fields", () => {
    // The gateway records `summary` for display (tool-defs.mjs). It is NOT
    // authority: the broker contract is exactly tool/intentionId/normalizedArgs.
    const runtimeIntent = { ...intent(), summary: 'Despesa de R$ 50,00 em "mercado"' };
    expect(sanitizeProposalIntent(runtimeIntent)).toEqual(intent());
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
  it("returns a valid proposal intent and keeps the retry anchor for broker recovery", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ turnId: "t-1", status: "completed", output: "Vou preparar.", proposal: intent() }),
    );
    const send = composeChatSend("Registre uma despesa de R$ 50 no mercado, na conta Nubank.");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(turn.proposal).toEqual(intent());
    // The intent is not authority, but it MUST survive the turn so a reload
    // can hand it to the broker again under the SAME intentionId.
    const anchor = loadPendingChatSend("ws-1", null);
    expect(anchor?.messageId).toBe(send.messageId);
    expect(anchor?.proposal).toEqual(intent());
  });

  it("clears the retry anchor on a successful turn without a proposal", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ turnId: "t-1", status: "completed", output: "ok" }),
    );
    const send = composeChatSend("oi");
    await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(loadPendingChatSend("ws-1", null)).toBeNull();
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
    const send = composeChatSend("oi");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(turn.proposal).toBeUndefined();
    expect(loadPendingChatSend("ws-1", null)).toBeNull();
  });
});

describe("pending chat anchor — proposal recovery payload", () => {
  it("round-trips the sanitized intent with the stable message identity", () => {
    const send = composeChatSend("Registre uma despesa de R$ 50 no mercado.", { messageId: "m-recover" });
    savePendingChatSend("ws-1", { ...send, proposal: intent() }, null);
    const anchor = loadPendingChatSend("ws-1", null);
    expect(anchor).toMatchObject({
      messageId: "m-recover",
      content: send.content,
      proposal: intent(),
    });
  });

  it("never rehydrates a malformed proposal", () => {
    const send = composeChatSend("oi", { messageId: "m-bad" });
    savePendingChatSend(
      "ws-1",
      { ...send, proposal: { ...intent(), normalizedArgs: { ...intent().normalizedArgs, amountCents: 0 } } },
      null,
    );
    expect(loadPendingChatSend("ws-1", null)?.proposal).toBeUndefined();
  });
});
