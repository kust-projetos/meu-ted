import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import { TedMessage } from "../TedMessage";
import * as agentAuth from "@/lib/api/agent-auth";
import * as agentClient from "@/lib/api/agent-client";

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
  const forId = (id: string) => {
    if (!wsState.cache[id]) wsState.cache[id] = build(id);
    return wsState.cache[id];
  };
  return { ...actual, useWorkspace: () => forId(wsState.activeId), useWorkspaceSafe: () => forId(wsState.activeId) };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn().mockResolvedValue([]),
    sendAgentMessage: vi.fn().mockResolvedValue({ turnId: "t", status: "completed" }),
    renewAgentSession: vi.fn().mockResolvedValue({ ok: true, sessionId: "s2" }),
    uploadAttachment: vi.fn().mockResolvedValue({ url: "https://cdn.test/img.png" }),
  };
});

function installMediaMocks() {
  const mockRecorder = vi.fn(function (this: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    state: string;
    ondataavailable: null;
    onstop: (() => void) | null;
  }) {
    this.state = "inactive";
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
}

describe("TedChat – attachment capability gate (SPEC §18, H-09)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsState.activeId = "ws-1";
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
    installMediaMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("default (sem pipeline, mic off): nenhum botão de anexo de arquivo nem file input alcançável; microfone T1.1 ausente", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "");
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "");
    const { container } = render(<TedChat />);
    await screen.findByRole("button", { name: /enviar mensagem/i });
    expect(screen.queryByRole("button", { name: /gravar áudio/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /anexar imagem/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /anexar pdf/i })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("com pipeline habilitado (flag=1): botões e inputs de imagem/PDF aparecem (gate é real, não remoção)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const { container } = render(<TedChat />);
    expect(await screen.findByRole("button", { name: /anexar imagem/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /anexar pdf/i })).toBeInTheDocument();
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement | null;
    const pdfInput = container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement | null;
    expect(imageInput).not.toBeNull();
    expect(pdfInput).not.toBeNull();
    expect(imageInput?.accept).toMatch(/image\//);
    expect(pdfInput?.accept).toMatch(/pdf/);
  });

  it("com pipeline habilitado: selecionar imagem mostra preview; remover revoga a object URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    expect(imageInput).not.toBeNull();
    const file = new File(["fake-image"], "foto.png", { type: "image/png" });
    await user.upload(imageInput, file);
    await waitFor(() => {
      expect(container.innerHTML).toMatch(/foto\.png|preview|object-cover/i);
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
    const removeBtn = await screen.findByRole("button", { name: /remover foto\.png/i });
    await user.click(removeBtn);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remover foto\.png/i })).toBeNull();
    });
  });

  it("envio com sucesso revoga as object URLs dos anexos", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(imageInput, new File(["x"], "nota.png", { type: "image/png" }));
    await screen.findByRole("button", { name: /remover nota\.png/i });
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await waitFor(() => {
      expect(agentClient.sendAgentMessage).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });
  });

  it("unmount (navegação para fora da página) revoga URLs restantes", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container, unmount } = render(<TedChat />);
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(imageInput, new File(["x"], "a.png", { type: "image/png" }));
    await screen.findByRole("button", { name: /remover a\.png/i });
    // Page-bound: não há "fechar" — o teardown é o unmount (navegação).
    unmount();
    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });

    // Segundo ciclo: anexo pendente no unmount também é revogado.
    vi.mocked(URL.revokeObjectURL).mockClear();
    const second = render(<TedChat />);
    const secondInput = second.container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(secondInput, new File(["y"], "b.png", { type: "image/png" }));
    await second.findByRole("button", { name: /remover b\.png/i });
    second.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("troca de workspace e nova sessão revogam URLs pendentes", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container, rerender } = render(<TedChat />);
    const imageInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(imageInput, new File(["x"], "ws.png", { type: "image/png" }));
    await screen.findByRole("button", { name: /remover ws\.png/i });

    wsState.activeId = "ws-2";
    rerender(<TedChat />);
    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remover ws\.png/i })).toBeNull();
    });

    // Nova sessão também limpa e revoga.
    wsState.activeId = "ws-1";
    rerender(<TedChat />);
    const freshInput = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    await user.upload(freshInput, new File(["z"], "sess.png", { type: "image/png" }));
    await screen.findByRole("button", { name: /remover sess\.png/i });
    vi.mocked(URL.revokeObjectURL).mockClear();
    await user.click(screen.getByRole("button", { name: /nova sessão/i }));
    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remover sess\.png/i })).toBeNull();
    });
  });
});

describe("TedMessage – renderização de anexos", () => {
  it("renderiza imagem quando message possui attachment de imagem", () => {
    const msg = {
      id: "m1",
      actorId: "user-1",
      role: "user",
      content: "Veja minha nota",
      createdAt: new Date().toISOString(),
      isOwn: true,
      attachments: [{ type: "image" as const, url: "https://cdn.test/img.png", name: "nota.png" }],
    } as unknown as Parameters<typeof TedMessage>[0]["message"];
    const { container } = render(<TedMessage message={msg} isCurrentUser={true} senderName="Você" />);
    const img = container.querySelector('img[src="https://cdn.test/img.png"]');
    expect(img).not.toBeNull();
  });

  it("renderiza áudio player quando attachment é áudio", () => {
    const msg = {
      id: "m2",
      actorId: "user-1",
      role: "user",
      content: "",
      createdAt: new Date().toISOString(),
      isOwn: true,
      attachments: [{ type: "audio" as const, url: "https://cdn.test/audio.webm", name: "audio.webm" }],
    } as unknown as Parameters<typeof TedMessage>[0]["message"];
    const { container } = render(<TedMessage message={msg} isCurrentUser={true} senderName="Você" />);
    const audio = container.querySelector('audio[src="https://cdn.test/audio.webm"]');
    expect(audio).not.toBeNull();
  });

  it("renderiza link de PDF quando attachment é pdf", () => {
    const msg = {
      id: "m3",
      actorId: "user-1",
      role: "user",
      content: "Segue extrato",
      createdAt: new Date().toISOString(),
      isOwn: true,
      attachments: [{ type: "pdf" as const, url: "https://cdn.test/doc.pdf", name: "extrato.pdf" }],
    } as unknown as Parameters<typeof TedMessage>[0]["message"];
    const { container } = render(<TedMessage message={msg} isCurrentUser={true} senderName="Você" />);
    const link = container.querySelector('a[href="https://cdn.test/doc.pdf"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toMatch(/extrato\.pdf|pdf/i);
  });
});
