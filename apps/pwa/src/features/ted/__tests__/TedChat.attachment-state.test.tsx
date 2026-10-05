/**
 * F6/F7 — a UI de anexos não perde nada em silêncio.
 *
 * - **F6**: com um upload EM VOO, o envio era permitido e o anexo (sem `ref`)
 *   era simplesmente filtrado: a mensagem saía sem ele, sem aviso. Agora o envio
 *   fica bloqueado enquanto houver upload pendente, e a falha de upload é um
 *   estado VISÍVEL por anexo (`uploading` / `ready` / `failed`).
 * - **F7**: o blob do microfone virava `{type, url, name}` sem `ref` — e o
 *   envio filtra por `ref`, então a gravação NUNCA era enviada. Com a
 *   capability de áudio ativa, o blob passa pelo MESMO pipeline de upload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentAuth from "@/lib/api/agent-auth";
import * as agentClient from "@/lib/api/agent-client";

const wsState = vi.hoisted(() => ({ activeId: "ws-1", cache: {} as Record<string, unknown> }));

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const build = (id: string) => ({
    workspaces: [{ id, name: `WS ${id}`, kind: "shared" as const, role: "owner" as const }],
    activeWorkspace: { id, name: `WS ${id}`, kind: "shared" as const, role: "owner" as const },
    members: [{ userId: "user-1", name: "Walisson", email: "a@example.com", role: "owner" as const }],
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
    uploadAttachment: vi.fn().mockResolvedValue({
      ref: "att_0000000000000000",
      kind: "image",
      name: "anexo",
      size: 33,
    }),
  };
});

function installMediaMocks() {
  let lastRecorder: { onstop: (() => void) | null } | null = null;
  const mockRecorder = vi.fn(function (this: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    state: string;
    mimeType: string;
    ondataavailable: null;
    onstop: (() => void) | null;
  }) {
    this.state = "inactive";
    this.mimeType = "audio/webm";
    this.ondataavailable = null;
    this.onstop = null;
    this.addEventListener = vi.fn();
    this.removeEventListener = vi.fn();
    this.start = vi.fn(() => {
      this.state = "recording";
    });
    this.stop = vi.fn(() => {
      this.state = "inactive";
      if (this.onstop) this.onstop();
    });
    lastRecorder = this as unknown as { onstop: (() => void) | null };
  });
  (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = mockRecorder;
  (window as unknown as { MediaRecorder?: unknown }).MediaRecorder = mockRecorder as unknown as typeof MediaRecorder;
  const mockStream = { getTracks: () => [{ stop: vi.fn() }] };
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    writable: true,
    configurable: true,
  });
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => "blob:mock-url");
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();
  // A recorder double that emits a chunk before stopping, so a recording
  // actually produces a Blob.
  return {
    startRecording: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole("button", { name: /gravar áudio/i }));
      await waitFor(() => expect(screen.getByRole("button", { name: /parar gravação/i })).toBeInTheDocument());
    },
    stopRecording: async (user: ReturnType<typeof userEvent.setup>) => {
      const recorder = lastRecorder as unknown as {
        ondataavailable: ((ev: BlobEvent) => void) | null;
        stop: () => void;
      };
      recorder.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) } as BlobEvent);
      await user.click(screen.getByRole("button", { name: /parar gravação/i }));
    },
  };
}

describe("TedChat — anexo pendente nunca some em silêncio (F6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsState.activeId = "ws-1";
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("com upload EM VOO o envio é bloqueado (o anexo não é descartado em silêncio)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    let releaseUpload: (() => void) | null = null;
    vi.mocked(agentClient.uploadAttachment).mockImplementation(
      () => new Promise((resolve) => {
        releaseUpload = () => resolve({ ref: "att_1111111111111111", kind: "image", name: "nota.png", size: 3 });
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(imageInput, new File(["x"], "nota.png", { type: "image/png" }));

    // The upload is still in flight.
    const sendButton = await screen.findByRole("button", { name: /enviar mensagem/i });
    await waitFor(() => expect(sendButton).toBeDisabled());
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();

    // Resolving the upload releases the send.
    releaseUpload?.();
    await waitFor(() => expect(screen.getByRole("button", { name: /enviar mensagem/i })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    const sent = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2];
    expect(sent?.attachments?.[0]).toMatchObject({ ref: "att_1111111111111111", name: "nota.png" });
  });

  it("falha de upload ⇒ anexo marcado `failed` e o envio segue SEM ele, com estado visível", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    vi.mocked(agentClient.uploadAttachment).mockRejectedValue(
      Object.assign(new Error("mismatch"), { code: "attachment_mime_mismatch" }),
    );
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(imageInput, new File(["x"], "ruim.png", { type: "image/png" }));

    // The failure is VISIBLE, both as copy and as the per-attachment state.
    expect(await screen.findByText(/não foi possível enviar o anexo/i)).toBeInTheDocument();
    await screen.findByRole("button", { name: /remover ruim\.png/i });
    expect(await screen.findByText(/falha no envio/i)).toBeInTheDocument();

    // A failed upload must not block the message: it goes without the file.
    await waitFor(() => expect(screen.getByRole("button", { name: /enviar mensagem/i })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    const sent = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2];
    expect(sent?.attachments ?? []).toHaveLength(0);
  });
});

describe("TedChat — áudio do microfone passa pelo pipeline de upload (F7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsState.activeId = "ws-1";
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("com áudio ON: a gravação é upada e a referência é enviada", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "");
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_AUDIO", "1");
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "1");
    vi.mocked(agentClient.uploadAttachment).mockResolvedValue({
      ref: "att_audio000000001",
      kind: "audio",
      name: "audio.webm",
      size: 11,
    });
    const media = installMediaMocks();
    const user = userEvent.setup();
    render(<TedChat />);

    await media.startRecording(user);
    await media.stopRecording(user);

    await waitFor(() => expect(agentClient.uploadAttachment).toHaveBeenCalled());
    await user.type(screen.getByRole("textbox", { name: /mensagem/i }), "olá");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());

    const sent = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2];
    expect(sent?.attachments?.[0]).toMatchObject({ type: "audio", ref: "att_audio000000001" });
  });

  it("com áudio OFF: a gravação não vira anexo fantasma (nada é upado nem enviado)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "");
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_AUDIO", "");
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "1");
    const media = installMediaMocks();
    const user = userEvent.setup();
    render(<TedChat />);

    await media.startRecording(user);
    await media.stopRecording(user);

    // An explicit message, and NO phantom attachment anywhere.
    expect(await screen.findByText(/envio de áudio (não está|não está) disponível|áudio não está disponível/i)).toBeInTheDocument();
    expect(agentClient.uploadAttachment).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /mensagem/i }), "olá");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalled());
    const sent = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2];
    expect(sent?.attachments ?? []).toHaveLength(0);
  });
});