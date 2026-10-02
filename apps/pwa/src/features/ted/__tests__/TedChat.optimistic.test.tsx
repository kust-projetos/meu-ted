/**
 * T5.1 (H-13, SPEC §19) — TED Chat resilience.
 *
 * §19.1 every message (text included) renders immediately in a `sending`
 *      state ("enviando…") and transitions to sent or failed + retry.
 * §19.3 retry resends the EXACT draft (same text, same live attachments,
 *      SAME stable messageId) without retyping; a failed retry keeps the
 *      draft; success consumes it.
 * §19.4 connection status is always pt-BR.
 * §19.5 keyboard hints do not occupy space on touch devices.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
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
  return {
    ...actual,
    useWorkspace: () => mockWs,
    useWorkspaceSafe: () => mockWs,
  };
});

// Partial mock: createChatMessageId/composeChatSend stay REAL (SPEC §7.7
// infra) so tests assert the actual stable-id behavior.
vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn(),
    sendAgentMessage: vi.fn(),
    renewAgentSession: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const okTurn = { turnId: "t1", status: "completed" } as const;
const INPUT_PLACEHOLDER = "Pergunte sobre gastos, metas ou pagamentos…";

async function renderWithHistoryLoaded() {
  vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([
    { id: "srv-1", actorId: "ted", role: "assistant", content: "Olá! Como posso ajudar?", isOwn: false, createdAt: undefined, attachments: undefined },
  ]);
  render(<TedChat />);
  await screen.findByText("Olá! Como posso ajudar?");
}

describe("TedChat — §19.1 optimistic universal (text included)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a text message immediately with 'enviando…' while the send is in flight", async () => {
    const user = userEvent.setup();
    await renderWithHistoryLoaded();

    const pending = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(pending.promise);

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "Quanto gastei no mês?");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    // Immediate optimistic bubble + sending state, while the request hangs.
    expect(screen.getByText("Quanto gastei no mês?")).toBeInTheDocument();
    expect(screen.getByText("enviando…")).toBeInTheDocument();

    pending.resolve(okTurn);
    await waitFor(() => expect(screen.queryByText("enviando…")).not.toBeInTheDocument());
    // The turn succeeded: no failed residue, server history owns the log.
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull();
  });

  it("a failed text message stays visible as failed with a clear label and [Tentar novamente] — never silently discarded", async () => {
    const user = userEvent.setup();
    await renderWithHistoryLoaded();

    vi.mocked(agentClient.sendAgentMessage).mockRejectedValueOnce(new Error("down"));
    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "Olá");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();
    expect(screen.getByText("Olá")).toBeInTheDocument();
    expect(screen.getByText(/falha no envio/i)).toBeInTheDocument();
    expect(screen.queryByText("enviando…")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível enviar a mensagem.");
  });
});

describe("TedChat — §19.3 retry preserves the draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retry resends the exact content with the SAME stable messageId — no retyping", async () => {
    const user = userEvent.setup();
    await renderWithHistoryLoaded();

    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(okTurn);

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "Gastei R$ 50 no mercado");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await screen.findByRole("button", { name: /tentar novamente/i });

    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(2));
    const first = vi.mocked(agentClient.sendAgentMessage).mock.calls[0];
    const second = vi.mocked(agentClient.sendAgentMessage).mock.calls[1];
    expect(second?.[1]).toBe(first?.[1]);
    expect((second?.[2] as { messageId?: string }).messageId).toBe(
      (first?.[2] as { messageId?: string }).messageId,
    );
    expect((second?.[2] as { messageId?: string }).messageId).toBeTruthy();

    // Success consumes the draft: the failed state disappears.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull(),
    );
    expect(screen.queryByText(/falha no envio/i)).toBeNull();
  });

  it("a retry that fails again returns to failed keeping the draft; the next attempt still reuses the same messageId", async () => {
    const user = userEvent.setup();
    await renderWithHistoryLoaded();

    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce(okTurn);

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "Metas do mês");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await screen.findByRole("button", { name: /tentar novamente/i });

    // First retry fails again: message stays failed, draft preserved.
    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();
    expect(screen.getByText("Metas do mês")).toBeInTheDocument();
    expect(screen.getByText(/falha no envio/i)).toBeInTheDocument();

    // Second retry succeeds; every attempt carried the SAME messageId.
    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(3));
    const ids = vi.mocked(agentClient.sendAgentMessage).mock.calls.map(
      (call: Parameters<typeof agentClient.sendAgentMessage>) =>
        (call[2] as { messageId?: string }).messageId,
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
  });

  it("retry keeps the same attachment object URLs alive; failure never revokes them, success consumes and revokes", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => "blob:mock-url");
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    await renderWithHistoryLoaded();

    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(okTurn);

    const imageInput = screen
      .getByRole("region", { name: "Chat com TED" })
      .querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(imageInput, new File(["x"], "nota.png", { type: "image/png" }));
    await screen.findByRole("button", { name: /remover nota\.png/i });
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await screen.findByRole("button", { name: /tentar novamente/i });
    // Object URL must stay alive while the failed draft exists.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-url");

    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(2));

    const firstAtts = (vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2] as {
      attachments?: Array<{ url: string; name: string; type: string }>;
    }).attachments;
    const secondAtts = (vi.mocked(agentClient.sendAgentMessage).mock.calls[1]?.[2] as {
      attachments?: Array<{ url: string; name: string; type: string }>;
    }).attachments;
    expect(secondAtts).toEqual(firstAtts);
    expect(secondAtts?.[0]).toMatchObject({ url: "blob:mock-url", name: "nota.png", type: "image" });

    // Success consumes the draft: local object URLs are revoked afterwards.
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull(),
    );
  });
});

describe("TedChat — §19.4 connection status in pt-BR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps connecting → 'conectando…' and ready → 'online'", async () => {
    const pending = deferred<agentClient.AgentMessage[]>();
    vi.mocked(agentClient.fetchAgentHistory).mockReturnValueOnce(pending.promise);
    render(<TedChat />);

    expect(await screen.findByText("conectando…")).toBeInTheDocument();

    pending.resolve([]);
    await waitFor(() => expect(screen.getByText("online")).toBeInTheDocument());
    expect(screen.queryByText("conectando…")).toBeNull();
  });

  it("maps error → 'indisponível' (never raw English states)", async () => {
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("boom"));
    render(<TedChat />);

    expect(await screen.findByText("indisponível")).toBeInTheDocument();
    expect(screen.queryByText(/^connecting$|^error$/)).toBeNull();
  });

  it("maps streaming → 'escrevendo…' while the agent responds", async () => {
    const user = userEvent.setup();
    await renderWithHistoryLoaded();

    const pending = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(pending.promise);
    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "Olá");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByText("escrevendo…")).toBeInTheDocument();

    pending.resolve(okTurn);
    await waitFor(() => expect(screen.getByText("online")).toBeInTheDocument());
  });
});

describe("TedChat — §19.5 keyboard hints hidden on touch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
  });

  it("hint row carries the (hover:none) and (pointer:coarse) hidden variant and stays visible on desktop", async () => {
    render(<TedChat />);
    const hint = screen.getByText(/Pressione Enter para enviar/).closest("div");
    expect(hint).not.toBeNull();
    const className = hint?.className ?? "";
    // Touch (no physical keyboard): the hint must be hidden…
    expect(className).toMatch(/hover:\s*none/);
    expect(className).toMatch(/pointer:\s*coarse/);
    expect(className).toMatch(/:hidden/);
    // …but desktop keeps it: no unconditional `hidden` class.
    expect(className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});
