/**
 * FIX-AGENT-QUOTA-MESSAGE — a denied turn must tell the truth.
 *
 * The Agent relays the usage-gate denial verbatim as HTTP 429 with code
 * `agent.quota_exceeded` (`USAGE_QUOTA_EXCEEDED_CODE`), and `sendAgentMessage`
 * preserves `status`/`code` on the thrown error. Showing the generic "try
 * again" copy for a daily quota that resets tomorrow is misleading: retrying
 * cannot succeed. Every OTHER failure keeps the generic message.
 *
 * FINDING 4 (review): the ledger denies for three different reasons and all
 * arrive as 429. A sliding-window rate limit (`agent.usage_rate_limited`, 20
 * requests/60s) clears in seconds, and the per-request input cap
 * (`agent.usage_input_cap`) is not a budget at all — the same oversized
 * message can never be accepted later — so both need their own copy instead
 * of the daily "try again tomorrow". The similarly named `agent.rate_limited`
 * is the PROVIDER throttle relayed by the Agent and must not be shown as the
 * user's own quota.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentAuth from "@/lib/api/agent-auth";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [],
    loading: false,
    membersLoading: false,
    error: null,
    selectWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    refreshMembers: vi.fn(),
    createWorkspace: vi.fn(),
    inviteMember: vi.fn(),
    acceptInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  };
  return { ...actual, useWorkspace: () => mockWs, useWorkspaceSafe: () => mockWs };
});

const quotaError = (): Error =>
  Object.assign(new Error("Actor daily token budget of 200000 exceeded"), {
    code: "agent.quota_exceeded",
    status: 429,
  });

const sendAndReadAlert = async (error: Error): Promise<string> => {
  const user = userEvent.setup();
  vi.spyOn(agentClient, "sendAgentMessage").mockRejectedValue(error);
  render(<TedChat />);
  await screen.findByRole("region", { name: "Chat com TED" });
  await user.type(screen.getByLabelText("Mensagem para o assistente"), "quanto gastei este mês?");
  await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
  return (await screen.findByRole("alert")).textContent ?? "";
};

describe("TedChat — honest message for a denied daily quota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.spyOn(agentClient, "fetchAgentHistory").mockResolvedValue([]);
    vi.spyOn(agentClient, "fetchActivePendingOperations").mockResolvedValue([]);
    vi.spyOn(agentClient, "fetchActiveUndoProposals").mockResolvedValue([]);
  });

  it("429 agent.quota_exceeded shows the daily-quota message (not the retryable one)", async () => {
    expect(await sendAndReadAlert(quotaError())).toBe("Cota diária do assistente atingida. Tente novamente amanhã.");
  });

  it("429 agent.usage_rate_limited shows the short-wait message (never the daily-quota one)", async () => {
    const rateLimited = Object.assign(new Error("Rate limit exceeded: 20/20 requests in the last 60s"), {
      code: "agent.usage_rate_limited",
      status: 429,
    });

    expect(await sendAndReadAlert(rateLimited)).toBe(
      "Muitas mensagens seguidas. Aguarde alguns instantes e tente de novo.",
    );
  });

  it("429 agent.usage_input_cap tells the user to shorten the message (retrying never works)", async () => {
    const tooLong = Object.assign(
      new Error("Message exceeds maximum allowed input token limit of 2000 (estimated: 5725)"),
      { code: "agent.usage_input_cap", status: 429 },
    );

    expect(await sendAndReadAlert(tooLong)).toBe(
      "Sua mensagem está longa demais para o assistente. Tente encurtar e enviar de novo.",
    );
  });

  it("the PROVIDER 429 (agent.rate_limited) keeps the generic message, not the user's own quota copy", async () => {
    // `agent.rate_limited` is the upstream/provider throttle relayed by the
    // Agent — not the user's own request rate. Attributing it to the user
    // ("you sent too much") would be wrong.
    const providerThrottle = Object.assign(new Error("agent.rate_limited"), {
      code: "agent.rate_limited",
      status: 429,
    });

    expect(await sendAndReadAlert(providerThrottle)).toBe("Não foi possível enviar a mensagem. Tente novamente.");
  });

  it("any other send failure keeps the generic retryable message", async () => {
    const generic = Object.assign(new Error("Operação do agente falhou."), {
      code: "agent.inference_error",
      status: 502,
    });
    expect(await sendAndReadAlert(generic)).toBe("Não foi possível enviar a mensagem. Tente novamente.");
  });
});
