/**
 * TASK_ID=CODER-PWA-R3-FIX — RED→GREEN componente para os 3 findings R2.
 *
 * FIX 1 (HIGH): reconciliação pura + retry fiel.
 *   - StrictMode + âncora com anexos: 1 balão failed, retry reenvia os MESMOS
 *     anexos sob a MESMA identidade.
 *   - Histórico tardio (placeholder real) após novo envio: o failed sai, o
 *     servidor vira dono — sem retry órfão, sem draft divergente.
 * FIX 2 (MEDIUM): âncora só-anexo (content="") + texto arbitrário posterior
 *   NÃO reconcilia (failed + retry preservados); placeholder real posterior
 *   reconcilia.
 * FIX 3 (MEDIUM): 11 anexos são bloqueados pré-envio com mensagem (nunca
 *   truncados); âncora overLimit reidrata failed SEM retry.
 *
 * Estes testes FALHAM antes dos fixes e PASSAM depois.
 */
import { StrictMode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

type FakeWorkspace = Readonly<{ id: string; name: string; kind: "shared"; role: "owner" }>;

const WS1: FakeWorkspace = { id: "ws-1", name: "Minhas Finanças", kind: "shared", role: "owner" };

const wsMock = vi.hoisted(() => ({
  ws: {
    workspaces: [] as unknown[],
    activeWorkspace: null as unknown,
    members: [] as unknown[],
    loading: false,
    membersLoading: false,
    error: null as unknown,
    selectWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    refreshMembers: vi.fn(),
    createWorkspace: vi.fn(),
    inviteMember: vi.fn(),
    acceptInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  },
}));

const appStateMock = vi.hoisted(() => ({
  state: null as unknown,
}));

vi.mock("@/lib/state/app-state-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/app-state-context")>();
  return {
    ...actual,
    useOptionalAppState: () => appStateMock.state,
  };
});

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  return {
    ...actual,
    useWorkspace: () => wsMock.ws,
    useWorkspaceSafe: () => wsMock.ws,
  };
});

// Partial mock: save/load/compose ficam REAIS (âncora de verdade em
// sessionStorage); só a rede é dublada.
vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn(),
    fetchActivePendingOperations: vi.fn(),
    fetchActiveUndoProposals: vi.fn(),
    sendAgentMessage: vi.fn(),
    decidePendingOperation: vi.fn(),
    renewAgentSession: vi.fn(),
    uploadAttachment: vi.fn(),
  };
});

const RETRY = /tentar novamente/i;
const INPUT_PLACEHOLDER = "Pergunte sobre gastos, metas ou pagamentos…";
const SEND = /enviar mensagem/i;
const ATTACH_LIMIT_ERROR = /no máximo 10 arquivos/i;
const okTurn = (turnId: string, output?: string): agentClient.AgentTurn =>
  ({ turnId, status: "completed", ...(output ? { output } : {}) }) as agentClient.AgentTurn;

const ownMsg = (
  id: string,
  content: string,
  createdAt?: string,
): agentClient.AgentMessage => ({
  id,
  actorId: "user-1",
  role: "user",
  content,
  isOwn: true,
  createdAt,
});

let histories: Record<string, agentClient.AgentMessage[]>;

beforeEach(() => {
  vi.clearAllMocks();
  histories = { "ws-1": [] };
  wsMock.ws.workspaces = [WS1];
  wsMock.ws.activeWorkspace = WS1;
  vi.mocked(agentClient.fetchAgentHistory).mockImplementation(
    async (workspaceId: string) => histories[workspaceId] ?? [],
  );
  vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
  vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
  vi.mocked(agentClient.sendAgentMessage).mockResolvedValue(okTurn("t1"));
  vi.mocked(agentClient.uploadAttachment).mockImplementation(
    async (_ws: string, input: { kind: string; name?: string }) =>
      ({
        ref: `att_${String(input.name ?? "x").replace(/[^A-Za-z0-9_-]/g, "").padEnd(16, "0")}`,
        kind: input.kind,
        name: input.name ?? "anexo",
        size: 10,
      }) as Awaited<ReturnType<typeof agentClient.uploadAttachment>>,
  );
  appStateMock.state = null;
});

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

describe("R3 FIX 1 (HIGH) — reconciliação pura sob StrictMode + retry fiel", () => {
  it("StrictMode: âncora com anexos reidrata 1 failed e o retry reenvia os MESMOS anexos", async () => {
    const user = userEvent.setup();
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-r3-strict",
      content: "Segue o comprovante",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [{ type: "image", url: "", name: "nota.jpg", ref: "att_0123456789abcdef" }],
    });

    render(
      <StrictMode>
        <TedChat />
      </StrictMode>,
    );
    await screen.findByText("online");

    // Updater puro sob double-invoke: UM balão, UM retry.
    expect(screen.getAllByText("Segue o comprovante")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: RETRY })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: RETRY }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    const call = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]!;
    const opts = call[2] as { messageId?: string; attachments?: Array<{ ref?: string }> };
    expect(opts.messageId).toBe("msg-r3-strict");
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments?.[0]).toMatchObject({ ref: "att_0123456789abcdef" });
  });

  it("StrictMode: placeholder tardio após novo envio reconcilia (failed sai, sem retry órfão)", async () => {
    const user = userEvent.setup();
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-r3-late",
      content: "Segue o comprovante",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [{ type: "image", url: "", name: "nota.jpg", ref: "att_0123456789abcdef" }],
    });
    histories["ws-1"] = [];

    render(
      <StrictMode>
        <TedChat />
      </StrictMode>,
    );
    await screen.findByText("online");
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();

    // O servidor persistiu afinal (placeholder real) e um novo turno força reload.
    histories["ws-1"] = [ownMsg("srv-late", "[anexo nota.jpg]", "2026-10-13T10:01:00.000Z")];
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t2"));
    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "outra pergunta");
    await user.click(screen.getByRole("button", { name: SEND }));

    // Updater impuro deixaria o failed sem draft (retry órfão/infiel) na 2ª passada.
    await waitFor(() => expect(screen.queryByRole("button", { name: RETRY })).toBeNull());
    expect(screen.getByText("[anexo nota.jpg]")).toBeInTheDocument();
    expect(screen.queryByText("Segue o comprovante")).toBeNull();
  });
});

describe("R3 FIX 2 (MEDIUM) — âncora só-anexo não reconcilia com texto arbitrário", () => {
  it("texto arbitrário posterior preserva o failed + retry (sem reenvio automático)", async () => {
    const user = userEvent.setup();
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-r3-attach-only",
      content: "",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [{ type: "image", url: "", name: "nota.jpg", ref: "att_0123456789abcdef" }],
    });
    histories["ws-1"] = [ownMsg("srv-text", "claro, posso ajudar", "2026-10-13T10:05:00.000Z")];

    render(<TedChat />);
    await screen.findByText("online");

    // O texto do servidor NÃO suprime a âncora com anexos: retry segue possível…
    expect(screen.getByText("claro, posso ajudar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();

    // …e o retry é fiel (mesmos anexos, mesma identidade).
    await user.click(screen.getByRole("button", { name: RETRY }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    const call = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]!;
    const opts = call[2] as { messageId?: string; attachments?: Array<{ ref?: string }> };
    expect(opts.messageId).toBe("msg-r3-attach-only");
    expect(opts.attachments).toHaveLength(1);
  });

  it("placeholder real posterior reconcilia a âncora só-anexo", async () => {
    const user = userEvent.setup();
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-r3-attach-only-2",
      content: "",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [{ type: "image", url: "", name: "nota.jpg", ref: "att_0123456789abcdef" }],
    });
    histories["ws-1"] = [];

    render(<TedChat />);
    await screen.findByText("online");
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();

    histories["ws-1"] = [ownMsg("srv-marker", "[anexo nota.jpg]", "2026-10-13T10:01:00.000Z")];
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t2"));
    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "outra pergunta");
    await user.click(screen.getByRole("button", { name: SEND }));

    await waitFor(() => expect(screen.queryByRole("button", { name: RETRY })).toBeNull());
    expect(screen.getByText("[anexo nota.jpg]")).toBeInTheDocument();
  });
});

describe("R3 FIX 3 (MEDIUM) — limite de anexos validado pré-envio, sem truncar", () => {
  it("11 imagens selecionadas: bloqueia o excedente com mensagem (máx. 10 chips)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    await screen.findByText("online");

    const imageInput = container.querySelector(
      'input[type="file"][accept*="image"]',
    ) as HTMLInputElement;
    expect(imageInput).not.toBeNull();
    const files = Array.from(
      { length: 11 },
      (_, i) => new File(["x"], `foto-${i}.png`, { type: "image/png" }),
    );
    await user.upload(imageInput, files);

    // Excedente bloqueado com mensagem — nunca 11 chips, nunca truncado em silêncio.
    expect(await screen.findByText(ATTACH_LIMIT_ERROR)).toBeInTheDocument();
    expect(container.querySelectorAll('img[alt^="foto-"]')).toHaveLength(10);
  });

  it("âncora overLimit reidrata failed SEM retry e nunca reenvia", async () => {
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-r3-overlimit",
      content: "muitas fotos",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: Array.from({ length: 11 }, (_, i) => ({
        type: "image",
        url: "",
        name: `foto-${i}.jpg`,
        ref: `att_over${String(i).padStart(12, "0")}`,
      })),
      overLimit: true,
    });

    render(<TedChat />);
    await screen.findByText("online");

    expect(screen.getByText("muitas fotos")).toBeInTheDocument();
    expect(screen.getByText(/falha no envio/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
  });
});
