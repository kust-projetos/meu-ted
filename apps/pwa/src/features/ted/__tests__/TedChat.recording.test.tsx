import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentAuth from "@/lib/api/agent-auth";
import * as agentClient from "@/lib/api/agent-client";

// SPEC §17 (H-08): recording só existe após getUserMedia + MediaRecorder + start;
// cleanup único e idempotente em todos os gatilhos de teardown.

const wsState = vi.hoisted(() => ({ activeId: "ws-1", cache: {} as Record<string, unknown> }));

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const build = (id: string) => ({
    workspaces: [{ id, name: `WS ${id}`, kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id, name: `WS ${id}`, kind: "shared" as const, role: "owner" },
    members: [{ userId: "user-1", name: "Walisson", email: "a@example.com", role: "owner" }],
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
  });
  // Identidade estável por workspace: sem isso loadHistory/effects entram em loop.
  const forId = (id: string) => {
    if (!wsState.cache[id]) wsState.cache[id] = build(id);
    return wsState.cache[id];
  };
  return {
    ...actual,
    useWorkspace: () => forId(wsState.activeId),
    useWorkspaceSafe: () => forId(wsState.activeId),
  };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn().mockResolvedValue([]),
    sendAgentMessage: vi.fn().mockResolvedValue({ turnId: "t", status: "completed" }),
    renewAgentSession: vi.fn().mockResolvedValue({ ok: true, sessionId: "s2" }),
  };
});

interface MockRecorder {
  state: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

const mediaCtl = vi.hoisted(() => ({
  instances: [] as MockRecorder[],
  trackStops: [] as ReturnType<typeof vi.fn>[],
  getUserMediaImpl: null as null | (() => Promise<MediaStream>),
  startImpl: null as null | (() => void),
}));

function installMediaMocks() {
  mediaCtl.instances = [];
  mediaCtl.trackStops = [];
  mediaCtl.getUserMediaImpl = null;
  mediaCtl.startImpl = null;

  const defaultStream = () => {
    const trackStop = vi.fn();
    mediaCtl.trackStops.push(trackStop);
    return { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  };

  const getUserMedia = vi.fn(() =>
    mediaCtl.getUserMediaImpl ? mediaCtl.getUserMediaImpl() : Promise.resolve(defaultStream()),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    writable: true,
    configurable: true,
  });

  const MockRecorder = vi.fn(function (this: unknown) {
    const self = this as MockRecorder;
    self.state = "inactive";
    self.ondataavailable = null;
    self.onstop = null;
    self.start = vi.fn(() => {
      if (mediaCtl.startImpl) {
        mediaCtl.startImpl();
        return;
      }
      self.state = "recording";
    });
    self.stop = vi.fn(() => {
      self.state = "inactive";
      if (self.onstop) self.onstop();
    });
    mediaCtl.instances.push(self);
  });
  (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = MockRecorder;
  (window as unknown as { MediaRecorder?: unknown }).MediaRecorder =
    MockRecorder as unknown as typeof MediaRecorder;

  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => "blob:mock-audio");
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();

  return { getUserMedia };
}

describe("TedChat – ciclo de vida do microfone (SPEC §17, H-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsState.activeId = "ws-1";
    // V4 T1.1: the record button only renders with the mic capability on.
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "true");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
    installMediaMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("permissão negada nunca mostra gravando (vai para erro)", async () => {
    const user = userEvent.setup();
    mediaCtl.getUserMediaImpl = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    render(<TedChat />);

    await user.click(screen.getByRole("button", { name: /gravar áudio/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/microfone/i);
    expect(screen.queryByText(/gravando/i)).toBeNull();
    expect(screen.getByRole("button", { name: /gravar áudio/i })).toBeInTheDocument();
  });

  it("solicitando permissão mostra estado neutro, nunca o indicador de gravação", async () => {
    const user = userEvent.setup();
    let resolveGum!: (s: MediaStream) => void;
    mediaCtl.getUserMediaImpl = () =>
      new Promise<MediaStream>((resolve) => {
        resolveGum = resolve;
      });
    render(<TedChat />);

    await user.click(screen.getByRole("button", { name: /gravar áudio/i }));

    expect(await screen.findByText(/solicitando permissão/i)).toBeInTheDocument();
    expect(screen.queryByText(/gravando/i)).toBeNull();

    const trackStop = vi.fn();
    resolveGum({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await waitFor(() => expect(screen.queryByText(/gravando/i)).toBeInTheDocument());
  });

  it("falha em recorder.start vai para erro, sem indicador de gravação", async () => {
    const user = userEvent.setup();
    mediaCtl.startImpl = () => {
      throw new Error("start failed");
    };
    render(<TedChat />);

    await user.click(screen.getByRole("button", { name: /gravar áudio/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/microfone/i);
    expect(screen.queryByText(/gravando/i)).toBeNull();
  });

  it("unmount para o recorder e encerra as tracks", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TedChat />);

    await user.click(screen.getByRole("button", { name: /gravar áudio/i }));
    await waitFor(() => expect(screen.queryByText(/gravando/i)).toBeInTheDocument());

    unmount();

    expect(mediaCtl.instances[0].stop).toHaveBeenCalled();
    expect(mediaCtl.trackStops[0]).toHaveBeenCalled();
  });

  it("troca de workspace encerra as tracks e sai do estado gravando", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TedChat />);

    await user.click(screen.getByRole("button", { name: /gravar áudio/i }));
    await waitFor(() => expect(screen.queryByText(/gravando/i)).toBeInTheDocument());

    wsState.activeId = "ws-2";
    rerender(<TedChat />);

    await waitFor(() => expect(mediaCtl.trackStops[0]).toHaveBeenCalled());
    expect(screen.queryByText(/gravando/i)).toBeNull();
  });

  it("cleanup duplo é seguro (parar + unmount sem exceção)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TedChat />);

    await user.click(screen.getByRole("button", { name: /gravar áudio/i }));
    await waitFor(() => expect(screen.queryByText(/gravando/i)).toBeInTheDocument());

    // Parar via botão (gera anexo de áudio), depois desmontar a página.
    await user.click(screen.getByRole("button", { name: /parar gravação/i }));
    await waitFor(() => expect(screen.queryByText(/gravando/i)).toBeNull());

    expect(() => {
      unmount();
    }).not.toThrow();
    expect(mediaCtl.trackStops[0]).toHaveBeenCalled();
  });
});
