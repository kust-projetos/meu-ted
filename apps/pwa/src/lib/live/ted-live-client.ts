import { clearAgentConnectionTokenCache, fetchAgentConnectionToken } from "@/lib/api/agent-auth";

export type TedLiveState = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

type SocketLike = {
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  close: () => void;
};

type Options = {
  workspaceId: string;
  origin?: string;
  enabled?: boolean;
  mintToken?: () => Promise<string>;
  WebSocketImpl?: new (url: string, protocols: string[]) => SocketLike;
  maxAttempts?: number;
  baseDelayMs?: number;
  random?: () => number;
  stableOpenMs?: number;
};

export function createTedLiveClient(options: Options) {
  const enabled = options.enabled ?? process.env.NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED === "1";
  const rawOrigin = options.origin ?? process.env.NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL ?? "";
  const mintToken = options.mintToken ?? (async () => {
    const token = await fetchAgentConnectionToken(options.workspaceId, true);
    clearAgentConnectionTokenCache();
    return token;
  });
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const random = options.random ?? Math.random;
  const stableOpenMs = options.stableOpenMs ?? 10_000;
  let state: TedLiveState = "idle";
  let origin = "";
  let socket: SocketLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let hasOpened = false;
  let stopped = false;
  const frames = new Set<(frame: string) => void>();
  const states = new Set<(state: TedLiveState) => void>();

  const setState = (next: TedLiveState) => {
    if (state === next) return;
    state = next;
    states.forEach((handler) => { try { handler(next); } catch { /* subscriber isolation */ } });
  };
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (stableTimer !== undefined) clearTimeout(stableTimer);
    stableTimer = undefined;
    const current = socket;
    socket = undefined;
    if (current) current.close();
    setState("stopped");
  };
  const schedule = () => {
    if (stopped) return;
    if (attempts >= maxAttempts) { stopped = true; setState("stopped"); return; }
    const delay = baseDelayMs * 2 ** attempts * (0.5 + random());
    attempts++;
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
    setState("reconnecting");
  };
  const connect = async () => {
    if (stopped) return;
    setState(hasOpened ? "reconnecting" : "connecting");
    try {
      const token = await mintToken();
      if (stopped) return;
      const Socket = options.WebSocketImpl ?? (WebSocket as unknown as NonNullable<Options["WebSocketImpl"]>);
      const url = `${origin}/agents/finance-chat-agent/${encodeURIComponent(options.workspaceId)}/live`;
      const current = new Socket(url, ["ted.v1", `bearer.${token}`]);
      socket = current;
      current.onopen = () => {
        if (stopped || socket !== current) return;
        hasOpened = true;
        if (stableTimer !== undefined) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { stableTimer = undefined; if (!stopped && socket === current) attempts = 0; }, stableOpenMs);
        setState("open");
      };
      current.onmessage = (event: MessageEvent) => {
        if (stopped || socket !== current || typeof event.data !== "string") return;
        frames.forEach((handler) => { try { handler(event.data as string); } catch { /* subscriber isolation */ } });
      };
      current.onclose = (event: CloseEvent) => {
        if (socket === current) socket = undefined;
        if (stableTimer !== undefined) clearTimeout(stableTimer);
        stableTimer = undefined;
        if (stopped) return;
        if (event.code === 1000 || (event.code === 1008 && event.reason !== "binding_expired")) { stop(); return; }
        schedule();
      };
    } catch {
      schedule();
    }
  };
  const start = async () => {
    if (state !== "idle" || stopped) return;
    if (!enabled) { stop(); return; }
    try {
      const parsed = new URL(rawOrigin);
      if (parsed.protocol !== "https:") { stop(); return; }
      origin = parsed.origin;
    } catch { stop(); return; }
    if (!options.WebSocketImpl && typeof WebSocket === "undefined") { stop(); return; }
    await connect();
  };
  return {
    start, stop, getState: () => state,
    onFrame(handler: (frame: string) => void) { frames.add(handler); return () => frames.delete(handler); },
    onState(handler: (state: TedLiveState) => void) { states.add(handler); return () => states.delete(handler); },
  };
}
