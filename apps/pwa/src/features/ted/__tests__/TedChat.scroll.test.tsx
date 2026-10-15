/**
 * FIX-P1-UX #173 — TedChat scroll preserves history reading.
 *
 * Auto-scroll fires only when the user is already near the bottom, on their
 * own message, or on mount. A new assistant/turn message while the user reads
 * history must NOT yank the viewport. A visible "Ir à última" jump button
 * recovers the live tail, and reduced-motion users always get instant jumps.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/lib/test-utils";
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

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn(),
    fetchActivePendingOperations: vi.fn(),
    fetchActiveUndoProposals: vi.fn(),
    sendAgentMessage: vi.fn(),
    decideUndoProposal: vi.fn(),
  };
});

const scrollIntoViewMock = vi.fn();

function setListMetrics(list: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(list, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(list, "scrollTop", { value: scrollTop, configurable: true, writable: true });
}

/** Far from the bottom: 2000 - 100 - 500 = 1400px of unread tail. */
function scrollFarUp(list: HTMLElement) {
  setListMetrics(list, 2000, 500, 100);
  fireEvent.scroll(list);
}

/** Within the near-bottom threshold. */
function scrollNearBottom(list: HTMLElement) {
  setListMetrics(list, 2000, 500, 1450);
  fireEvent.scroll(list);
}

describe("TedChat scroll preserves reading (FIX-P1-UX #173)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scrollIntoViewMock.mockClear();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock as unknown as typeof window.HTMLElement.prototype.scrollIntoView;
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-connection-token");
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-1",
      status: "completed",
      output: "resposta do TED",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mount scrolls to the live tail once", async () => {
    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("an incoming assistant message while reading history does NOT yank the viewport, and offers the jump button", async () => {
    const user = userEvent.setup();
    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());
    const list = screen.getByTestId("ted-message-list");

    scrollFarUp(list);
    expect(await screen.findByRole("button", { name: /ir à última/i })).toBeInTheDocument();
    scrollIntoViewMock.mockClear();

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "qual meu saldo?",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    // The assistant answer lands while the user reads history…
    expect(await screen.findByText("resposta do TED")).toBeInTheDocument();
    const callsAfterAnswer = scrollIntoViewMock.mock.calls.length;
    // …and no further scroll follows it (the earlier own-message stick is
    // allowed; the assistant tail must not yank).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(scrollIntoViewMock.mock.calls.length).toBe(callsAfterAnswer);
    // The reader is still parked up: the jump button stays available.
    expect(screen.getByRole("button", { name: /ir à última/i })).toBeInTheDocument();
  });

  it("the jump button scrolls back to the live tail on demand", async () => {
    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());
    const list = screen.getByTestId("ted-message-list");

    scrollFarUp(list);
    const jump = await screen.findByRole("button", { name: /ir à última/i });
    scrollIntoViewMock.mockClear();
    fireEvent.click(jump);

    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("scrolling back near the bottom hides the jump button", async () => {
    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());
    const list = screen.getByTestId("ted-message-list");

    scrollFarUp(list);
    expect(await screen.findByRole("button", { name: /ir à última/i })).toBeInTheDocument();

    scrollNearBottom(list);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /ir à última/i })).not.toBeInTheDocument(),
    );
  });

  it("reduced-motion users always get instant (auto) scroll jumps", async () => {
    const user = userEvent.setup();
    const matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });

    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalled());

    // Every scroll jump under reduced motion is instant — never smooth.
    for (const call of scrollIntoViewMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ behavior: "auto" }));
    }
    expect(scrollIntoViewMock).toHaveBeenCalled();

    scrollIntoViewMock.mockClear();
    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "oi",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    for (const call of scrollIntoViewMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ behavior: "auto" }));
    }
  });

  it("a card-only refresh with an own tail does NOT scroll — scroll fires only on a new send", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([
      { requestId: "proposal-9", status: "proposed", expiresAt: "2099-01-01T12:00:00.000Z" },
    ]);
    // The send fails: the own bubble persists (delivery failed, isOwn true)
    // with NO history reload — the tail is stably the user's own message.
    vi.mocked(agentClient.sendAgentMessage).mockRejectedValueOnce(new Error("rede caiu"));

    render(<TedChat />);
    expect(await screen.findByTestId("ted-undo-card")).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "desfaz isso",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    // The legitimate new-send scroll fired for the optimistic own bubble.
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    expect(scrollIntoViewMock).toHaveBeenCalled();
    scrollIntoViewMock.mockClear();

    // No send from here on: deciding the card only refreshes state
    // (loadHistory + active list). The tail is still the same own message.
    vi.mocked(agentClient.decideUndoProposal).mockResolvedValue({
      requestId: "proposal-9",
      status: "confirmed",
    });
    vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
    const historyCallsBefore = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;

    await user.click(await screen.findByRole("button", { name: "Confirmar desfazer" }));
    // The card decision converged (history reloaded, card terminal/gone).
    await waitFor(() =>
      expect(vi.mocked(agentClient.fetchAgentHistory).mock.calls.length).toBeGreaterThan(historyCallsBefore),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("ted-undo-card")).not.toBeInTheDocument(),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Mere card update with the same own tail: no scroll yank.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // Positive control: a genuinely new send still scrolls to the live tail.
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValue({
      turnId: "turn-2",
      status: "completed",
      output: "nova resposta",
    });
    await user.type(
      screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"),
      "outra pergunta",
    );
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    expect(await screen.findByText("nova resposta")).toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });
});
