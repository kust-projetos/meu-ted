import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";
import { clearTedRuntimeViews, noteTedRuntimeView } from "@/lib/api/ted-runtime-view";

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
    clearTedRuntimeViews();
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

  it("A0/unknown turn shows no cancel and sends without signal (no effective cancel)", async () => {
    const user = userEvent.setup();
    // No server-confirmed B runtime: the view stays unknown (A0 default).
    let resolveSend!: (turn: { turnId: string; status: string; output: string }) => void;
    vi.mocked(agentClient.sendAgentMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve as (turn: { turnId: string; status: string; output: string }) => void;
        }),
    );

    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), "quanto gastei?");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));

    // While the A0 turn is active the submit slot offers NO cancel — the
    // disabled submit stays, and the send carries no abort wiring.
    expect(screen.queryByRole("button", { name: /cancelar envio/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enviar mensagem/i })).toBeDisabled();
    const sentOpts = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(sentOpts?.signal).toBeUndefined();

    resolveSend({ turnId: "t-a0", status: "completed", output: "resposta a0" });
    expect(await screen.findByText("resposta a0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancelar envio/i })).not.toBeInTheDocument();
  });

  it("cancel aborts the in-flight turn, keeps one message, and retry reuses the same identity", async () => {
    const user = userEvent.setup();
    // Server-confirmed B runtime for this conversation: the B history
    // response carries x-ted-runtime, captured the way the real
    // fetchAgentHistory does (TedChat never invents it).
    vi.mocked(agentClient.fetchAgentHistory).mockImplementation(async () => {
      noteTedRuntimeView("ws-1", "opencode");
      return [];
    });
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
