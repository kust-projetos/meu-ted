import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/test-utils";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

const live = vi.hoisted(() => ({
  workspaceId: "ws-1",
  frame: undefined as ((value: string) => void) | undefined,
  state: undefined as ((value: "idle" | "connecting" | "open" | "reconnecting" | "stopped") => void) | undefined,
  currentState: "idle" as "idle" | "connecting" | "open" | "reconnecting" | "stopped",
  start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), onFrame: vi.fn((handler: (value: string) => void) => {
    live.frame = handler;
    return vi.fn();
  }),
  getState: vi.fn(() => live.currentState),
  onState: vi.fn((handler: typeof live.state extends infer T ? Exclude<T, undefined> : never) => {
    live.state = handler;
    return vi.fn();
  }),
}));

vi.mock("@/lib/live/ted-live-client", () => ({ createTedLiveClient: vi.fn(() => live) }));
vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const activeWorkspace = { get id() { return live.workspaceId; }, name: "Test", kind: "personal", role: "owner" };
  const ws = { activeWorkspace, members: [] };
  return { ...actual, useWorkspaceSafe: () => ws };
});
vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return { ...actual, fetchAgentHistory: vi.fn().mockResolvedValue([]), sendAgentMessage: vi.fn(), fetchActivePendingOperations: vi.fn().mockResolvedValue([]), fetchActiveUndoProposals: vi.fn().mockResolvedValue([]) };
});
import { createTedLiveClient } from "@/lib/live/ted-live-client";

beforeEach(() => {
  vi.clearAllMocks();
  live.frame = undefined;
  live.state = undefined;
  live.currentState = "idle";
  live.workspaceId = "ws-1";
  vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "0");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("TedChat live sync", () => {
  it("does not create a client or refetch while disabled", async () => {
    render(<TedChat />);
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(1));
    expect(createTedLiveClient).not.toHaveBeenCalled();
  });

  it("throttles a burst with one leading and one trailing history revalidation", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    render(<TedChat />);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.frame).toBeDefined();
    await act(async () => { live.frame!("a"); await vi.advanceTimersByTimeAsync(0); });
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    expect(baseline).toBe(2);
    await act(async () => {
      live.frame!("b"); live.frame!("c"); live.frame!("d");
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline + 1);
  });

  it("coalesces frames received during an in-flight refresh into one follow-up", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    render(<TedChat />);
    await vi.advanceTimersByTimeAsync(0);
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    let resolveFirst!: (value: []) => void;
    let resolveFollowUp!: (value: []) => void;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(agentClient.fetchAgentHistory)
      .mockImplementationOnce(() => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<[]>(resolve => { resolveFirst = value => { inFlight--; resolve(value); }; });
      })
      .mockImplementationOnce(() => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<[]>(resolve => { resolveFollowUp = value => { inFlight--; resolve(value); }; });
      });
    await act(async () => { live.frame!("first"); await vi.advanceTimersByTimeAsync(0); });
    expect(inFlight).toBe(1);
    await act(async () => { live.frame!("during-first"); });
    expect(vi.mocked(agentClient.fetchAgentHistory)).toHaveBeenCalledTimes(baseline + 1);
    await act(async () => { resolveFirst([]); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(vi.mocked(agentClient.fetchAgentHistory)).toHaveBeenCalledTimes(baseline + 2);
    expect(inFlight).toBe(1);
    expect(maxInFlight).toBe(1);
    await act(async () => { resolveFollowUp([]); await Promise.resolve(); });
    expect(inFlight).toBe(0);
  });

  it("does not refresh from live frames while a message is streaming", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    render(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const pending = new Promise<agentClient.AgentTurn>(() => {});
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(pending);
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), { target: { value: "Olá" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /enviar mensagem/i })); });
    expect(screen.getByText("escrevendo…")).toBeInTheDocument();
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    await act(async () => {
      live.frame!("during-send-1"); live.frame!("during-send-2");
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(vi.mocked(agentClient.fetchAgentHistory)).toHaveBeenCalledTimes(baseline);
    expect(screen.getByText("escrevendo…")).toBeInTheDocument();
  });

  it("refreshes once when streaming ends after coalescing its frames", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    render(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let rejectSend!: (reason: Error) => void;
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(new Promise((_, reject) => { rejectSend = reject; }));
    fireEvent.change(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), { target: { value: "Olá" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /enviar mensagem/i })); });
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    await act(async () => { live.frame!("during-stream"); await vi.advanceTimersByTimeAsync(3000); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline);
    await act(async () => { rejectSend(new Error("send failed")); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText("escrevendo…")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline + 1);
  });

  it("discards an older silent response when a newer send refresh completes first", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    render(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let resolveSilent!: (value: agentClient.AgentMessage[]) => void;
    let resolveSendHistory!: (value: agentClient.AgentMessage[]) => void;
    vi.mocked(agentClient.fetchAgentHistory)
      .mockImplementationOnce(() => new Promise(resolve => { resolveSilent = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSendHistory = resolve; }));
    await act(async () => { live.frame!("start-old-silent"); await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({ output: "Resposta nova" } as agentClient.AgentTurn);
    fireEvent.change(screen.getByPlaceholderText("Pergunte sobre gastos, metas ou pagamentos…"), { target: { value: "Nova pergunta" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /enviar mensagem/i })); await Promise.resolve(); });
    const latest: agentClient.AgentMessage[] = [{ id: "latest", actorId: "ted", role: "assistant", content: "Resposta nova", createdAt: undefined, isOwn: false }];
    await act(async () => { resolveSendHistory(latest); await Promise.resolve(); });
    await act(async () => { resolveSilent([]); await Promise.resolve(); });
    expect(screen.getByText("Resposta nova")).toBeInTheDocument();
  });

  it("revalidates once after reconnecting to open", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    render(<TedChat />);
    await vi.advanceTimersByTimeAsync(0);
    live.currentState = "reconnecting"; live.state!("reconnecting");
    live.currentState = "open"; live.state!("open");
    await vi.advanceTimersByTimeAsync(0);
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps status and error unchanged across a successful silent refresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("initial failure"));
    render(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/não foi possível carregar o histórico/i)).toBeInTheDocument();
    const error = screen.getByText(/não foi possível carregar o histórico/i).textContent;
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    await act(async () => { live.frame!("silent-success"); await vi.advanceTimersByTimeAsync(0); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline + 1);
    expect(screen.getByText(error!)).toBeInTheDocument();
    expect(screen.queryByText("carregando histórico")).not.toBeInTheDocument();
  });

  it("keeps status and error unchanged when a silent history refresh fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("initial failure"));
    render(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const error = screen.getByText(/não foi possível carregar o histórico/i).textContent;
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    vi.mocked(agentClient.fetchAgentHistory).mockRejectedValueOnce(new Error("history failed"));
    await act(async () => { live.frame!("silent-failure"); await vi.advanceTimersByTimeAsync(0); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline + 1);
    expect(screen.getByText(error!)).toBeInTheDocument();
  });

  it("stops the old workspace client and ignores its frame after a workspace change", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    const view = render(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const oldFrame = live.frame!;
    const baseline = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    live.workspaceId = "ws-2";
    view.rerender(<TedChat />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(live.stop).toHaveBeenCalled();
    oldFrame("stale-ws-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(baseline);
  });

  it("does not create refresh work or requests while disabled", async () => {
    vi.useFakeTimers();
    render(<TedChat />);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(createTedLiveClient).not.toHaveBeenCalled();
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the client and cancels a pending debounce on unmount", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED", "1");
    vi.useFakeTimers();
    const view = render(<TedChat />);
    await vi.advanceTimersByTimeAsync(0);
    live.frame!("frame");
    view.unmount();
    expect(live.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(1);
  });
});
