import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [{ userId: "user-1", name: "Walisson", email: "walisson@example.com", role: "owner" }],
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
  return {
    ...actual,
    useWorkspace: () => mockWs,
    useWorkspaceSafe: () => mockWs,
  };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn(),
    sendAgentMessage: vi.fn(),
    renewAgentSession: vi.fn(),
  };
});

describe("TedChat P2 — cancel affordance in the composer submit slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.renewAgentSession).mockResolvedValue({
      ok: true,
      sessionId: "sess-new",
      previousSessionId: null,
      messageCount: 0,
      summarized: false,
    });
  });

  it("gateway-only turn always offers cancel and aborts the in-flight send", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockImplementation(
      async (_ws, _text, opts) =>
        await new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), "quanto gastei?");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));

    const signal = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await user.click(await screen.findByRole("button", { name: /cancelar envio/i }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();
  });

  it("cancel aborts the in-flight turn, keeps one message, and retry reuses the same identity", async () => {
    const user = userEvent.setup();
    const seenMessageIds: Array<string | undefined> = [];
    let sendCalls = 0;
    vi.mocked(agentClient.sendAgentMessage).mockImplementation(
      async (_ws: string, _text: string, opts?: { messageId?: string; signal?: AbortSignal }) => {
        sendCalls += 1;
        seenMessageIds.push(opts?.messageId);
        if (sendCalls === 1) {
          // First flight hangs until the caller aborts (cancel path).
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
          throw new Error("unreachable");
        }
        return { turnId: "t-retry", status: "completed", output: "resposta" };
      },
    );

    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), "quanto gastei?");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    expect(sendCalls).toBe(1);
    expect(
      (vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined)?.signal,
    ).toBeInstanceOf(AbortSignal);

    // While the turn is active the submit slot offers cancel — no second send.
    const cancel = await screen.findByRole("button", { name: /cancelar envio/i });
    expect(screen.queryByRole("button", { name: /enviar mensagem/i })).not.toBeInTheDocument();
    expect(sendCalls).toBe(1);

    await user.click(cancel);

    // Cancel settles into the existing failed+retry UX (same error slot).
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível enviar a mensagem/);
    const retry = await screen.findByRole("button", { name: /tentar novamente/i });
    expect(sendCalls).toBe(1);

    // Retry reuses the SAME stable identity (SPEC §7.7) — single in-flight.
    await user.click(retry);
    await waitFor(() => expect(sendCalls).toBe(2));
    expect(seenMessageIds[0]).toBeTruthy();
    expect(seenMessageIds[1]).toBe(seenMessageIds[0]);
    expect(await screen.findByText("resposta")).toBeInTheDocument();
  });
});
