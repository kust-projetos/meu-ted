import { afterEach, describe, expect, it, vi } from "vitest";
import { createTedLiveClient } from "./ted-live-client";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string, public protocols: string[]) { FakeSocket.instances.push(this); }
  open() { this.onopen?.(new Event("open")); }
  closed(code: number, reason = "") { this.onclose?.({ code, reason } as CloseEvent); }
}

afterEach(() => { FakeSocket.instances = []; vi.useRealTimers(); });

describe("createTedLiveClient", () => {
  const setup = (overrides: Record<string, unknown> = {}) => {
    let tokenNumber = 0;
    const mintToken = vi.fn(async () => `token-${++tokenNumber}`);
    const client = createTedLiveClient({
      workspaceId: "ws/a b", origin: "https://agent.example", enabled: true,
      mintToken, WebSocketImpl: FakeSocket as never, baseDelayMs: 1, random: () => 0,
      ...overrides,
    } as never);
    return { client, mintToken };
  };

  it("does not mint or instantiate when disabled or origin is invalid", async () => {
    const off = setup({ enabled: false }); await off.client.start();
    expect(off.mintToken).not.toHaveBeenCalled(); expect(FakeSocket.instances).toHaveLength(0);
    const missing = setup({ origin: "" }); await missing.client.start();
    const http = setup({ origin: "http://agent.example" }); await http.client.start();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(missing.client.getState()).toBe("stopped");
  });

  it("encodes workspace and supplies the exact subprotocols and raw frames", async () => {
    const { client } = setup({ mintToken: async () => "secret" });
    const frames: string[] = []; client.onFrame((frame) => frames.push(frame));
    await client.start();
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("https://agent.example/agents/finance-chat-agent/ws%2Fa%20b/live");
    expect(socket.protocols).toEqual(["ted.v1", "bearer.secret"]);
    socket.open(); socket.onmessage?.({ data: "{raw}" } as MessageEvent);
    expect(frames).toEqual(["{raw}"]); expect(socket.send).not.toHaveBeenCalled();
  });

  it("mints per attempt, retries expired bindings, and stops on disabled close", async () => {
    const mintToken = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    const { client } = setup({ mintToken });
    await client.start(); FakeSocket.instances[0]!.closed(1008, "binding_expired");
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(mintToken).toHaveBeenCalledTimes(2);
    FakeSocket.instances[1]!.closed(1008, "live_sync_disabled");
    expect(client.getState()).toBe("stopped");
    await Promise.resolve(); expect(mintToken).toHaveBeenCalledTimes(2);
  });

  it("stops after max abnormal closes and stop cancels a retry", async () => {
    vi.useFakeTimers();
    const { client } = setup({ maxAttempts: 2 });
    await client.start(); FakeSocket.instances[0]!.closed(1006);
    await vi.advanceTimersByTimeAsync(2);
    FakeSocket.instances[1]!.closed(1006);
    await vi.advanceTimersByTimeAsync(4);
    FakeSocket.instances[2]!.closed(1006);
    expect(client.getState()).toBe("stopped"); expect(FakeSocket.instances).toHaveLength(3);

    const cancel = setup(); await cancel.client.start(); FakeSocket.instances.at(-1)!.closed(1006);
    cancel.client.stop(); await vi.advanceTimersByTimeAsync(100);
    expect(cancel.client.getState()).toBe("stopped"); expect(FakeSocket.instances).toHaveLength(4);
  });

  it("close 1000 stops; 1001 retries only up to maxAttempts", async () => {
    vi.useFakeTimers();
    const normal = setup(); await normal.client.start(); FakeSocket.instances[0]!.closed(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(normal.client.getState()).toBe("stopped"); expect(FakeSocket.instances).toHaveLength(1);
    expect(normal.mintToken).toHaveBeenCalledTimes(1);

    const goingAway = setup({ maxAttempts: 2, stableOpenMs: 50 });
    await goingAway.client.start(); FakeSocket.instances[1]!.open(); FakeSocket.instances[1]!.closed(1001);
    await vi.advanceTimersByTimeAsync(2);
    FakeSocket.instances[2]!.open(); FakeSocket.instances[2]!.closed(1001);
    await vi.advanceTimersByTimeAsync(4);
    FakeSocket.instances[3]!.open(); FakeSocket.instances[3]!.closed(1001);
    expect(goingAway.client.getState()).toBe("stopped");
  });

  it("resets retry budget only after stable open interval", async () => {
    vi.useFakeTimers();
    const { client } = setup({ maxAttempts: 1, stableOpenMs: 10 });
    await client.start(); FakeSocket.instances[0]!.closed(1006);
    await vi.advanceTimersByTimeAsync(2);
    FakeSocket.instances[1]!.open();
    await vi.advanceTimersByTimeAsync(10);
    FakeSocket.instances[1]!.closed(1006);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2]!.closed(1006);
    expect(client.getState()).toBe("stopped");
  });

  it("retries rejected mints with backoff until exhausted", async () => {
    vi.useFakeTimers();
    const mintToken = vi.fn().mockRejectedValue(new Error("mint failed"));
    const { client } = setup({ mintToken, maxAttempts: 2, baseDelayMs: 10 });
    const started = client.start(); await Promise.resolve(); await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5); await Promise.resolve(); await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10); await Promise.resolve(); await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(3);
    await started;
    expect(client.getState()).toBe("stopped"); expect(FakeSocket.instances).toHaveLength(0);
  });

  it("stop during pending mint prevents socket construction", async () => {
    let resolve!: (token: string) => void;
    const { client } = setup({ mintToken: () => new Promise((done) => { resolve = done; }) });
    const pending = client.start(); client.stop(); resolve("burned"); await pending;
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("start is idempotent and stale events after stop are ignored", async () => {
    const { client } = setup(); await Promise.all([client.start(), client.start()]);
    expect(FakeSocket.instances).toHaveLength(1);
    const frames: string[] = []; client.onFrame((frame) => frames.push(frame));
    const old = FakeSocket.instances[0]!; client.stop(); old.open(); old.onmessage?.({ data: "late" } as MessageEvent);
    expect(client.getState()).toBe("stopped"); expect(frames).toEqual([]);
  });

  it("handles missing WebSocket lazily and normalizes origin", async () => {
    const original = globalThis.WebSocket;
    vi.stubGlobal("WebSocket", undefined);
    try {
      const noSocket = createTedLiveClient({ workspaceId: "ws", origin: "https://agent.example", enabled: true, mintToken: vi.fn(async () => "t") });
      await noSocket.start(); expect(noSocket.getState()).toBe("stopped");
    } finally { vi.stubGlobal("WebSocket", original); }
    const { client } = setup({ origin: "https://agent.example/path/" }); await client.start();
    expect(FakeSocket.instances.at(-1)!.url).toBe("https://agent.example/agents/finance-chat-agent/ws%2Fa%20b/live");
  });

  it("stops for an unknown 1008 reason", async () => {
    const { client, mintToken } = setup(); await client.start();
    FakeSocket.instances[0]!.closed(1008, "unknown_reason");
    await Promise.resolve(); expect(client.getState()).toBe("stopped");
    expect(FakeSocket.instances).toHaveLength(1); expect(mintToken).toHaveBeenCalledTimes(1);
  });
});
