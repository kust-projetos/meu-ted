/**
 * TASK_ID=CODER-PWA-R2-FIX — RED→GREEN para os 4 findings do review ted PWA.
 *
 * FIX 1 (HIGH): retry pós-reload perde anexos — a âncora passa a persistir
 *   refs de anexos `{type,ref,name}` e o retry reidrata COM os mesmos anexos;
 *   âncora legada (sem anexos) reidrata como failed SEM retry.
 * FIX 2 (MEDIUM): texto igual suprime intenção distinta — a âncora só é
 *   suprimida quando o histórico traz mensagem própria idêntica com
 *   timestamp >= timestamp da âncora.
 * FIX 3 (MEDIUM): histórico tardio duplica balão restaurado — toda carga de
 *   histórico reconcilia (remove o failed restaurado quando o servidor passa
 *   a trazer a mensagem correspondente).
 * FIX 4 (LOW): guidance "sem contas" com só categorias vazias / dados ainda
 *   não carregados — cópias distintas + gate de carga concluída.
 *
 * Estes testes FALHAM antes dos fixes e PASSAM depois.
 */
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

// App-state controlável por teste (contas/categorias/loading/sync).
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
  };
});

const RETRY = /tentar novamente/i;
const INPUT_PLACEHOLDER = "Pergunte sobre gastos, metas ou pagamentos…";
const SEND = /enviar mensagem/i;
const okTurn = (turnId: string, output = "Resposta de teste do TED."): agentClient.AgentTurn =>
  ({ turnId, status: "completed", output }) as agentClient.AgentTurn;

const ownMsg = (id: string, content: string, createdAt?: string): agentClient.AgentMessage => ({
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
  appStateMock.state = null;
});

afterEach(() => {
  sessionStorage.clear();
});

describe("R2 FIX 1 (HIGH) — retry pós-reload preserva anexos", () => {
  it("âncora com anexos reidrata failed e o retry reenvia os MESMOS anexos sob a mesma identidade", async () => {
    const user = userEvent.setup();
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-anchor-att",
      content: "Segue o comprovante",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [{ type: "image", url: "", name: "nota.jpg", ref: "ref-abc-123" }],
    });

    render(<TedChat />);
    await screen.findByText("online");

    expect(screen.getByText("Segue o comprovante")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: RETRY }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    const call = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]!;
    expect(call[0]).toBe("ws-1");
    expect(call[1]).toBe("Segue o comprovante");
    const opts = call[2] as { messageId?: string; attachments?: Array<{ type: string; ref?: string; name?: string }> };
    expect(opts.messageId).toBe("msg-anchor-att");
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments?.[0]).toMatchObject({ type: "image", ref: "ref-abc-123", name: "nota.jpg" });
  });

  it("âncora legada (sem anexos) reidrata como failed SEM retry e nunca reenvia", async () => {
    // Formato legado: JSON sem `attachments`/`anchorVersion` — como gravado
    // antes do FIX 1. Escrito cru porque a API nova sempre grava o formato novo.
    sessionStorage.setItem(
      "ted.pending-send.ws-1",
      JSON.stringify({
        messageId: "msg-legacy-1",
        content: "texto legado",
        createdAt: "2026-10-13T10:00:00.000Z",
      }),
    );

    render(<TedChat />);
    await screen.findByText("online");

    // Explícito: o balão failed aparece…
    expect(screen.getByText("texto legado")).toBeInTheDocument();
    expect(screen.getByText(/falha no envio/i)).toBeInTheDocument();
    // …mas SEM affordance de retry (reenviar sem os anexos originais mudaria
    // o payload sob a mesma identidade).
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe("R2 FIX 2 (MEDIUM) — texto igual não suprime intenção distinta", () => {
  it("'Bom dia' antigo no histórico + nova âncora 'Bom dia' → ambos visíveis (âncora failed + retry)", async () => {
    histories["ws-1"] = [ownMsg("srv-old", "Bom dia", "2026-10-01T09:00:00.000Z")];
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-anchor-new",
      content: "Bom dia",
      createdAt: "2026-10-13T10:00:00.000Z",
    });

    render(<TedChat />);
    await screen.findByText("online");

    // Dois balões: o confirmado do servidor + o failed reidratado com retry.
    expect(screen.getAllByText("Bom dia")).toHaveLength(2);
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("mensagem própria posterior ao envio (timestamp >= âncora) ainda suprime a âncora", async () => {
    histories["ws-1"] = [ownMsg("srv-new", "Bom dia", "2026-10-13T10:05:00.000Z")];
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-anchor-old",
      content: "Bom dia",
      createdAt: "2026-10-13T10:00:00.000Z",
    });

    render(<TedChat />);
    await screen.findByText("online");

    // O servidor persistiu DEPOIS do envio: um balão só, sem failed local.
    expect(screen.getAllByText("Bom dia")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
  });
});

describe("R2 FIX 3 (MEDIUM) — histórico tardio reconcilia o balão restaurado", () => {
  it("reidrata failed → chega histórico com a mensagem → 1 balão, sem retry duplicado", async () => {
    const user = userEvent.setup();
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-anchor-late",
      content: "paguei o aluguel",
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    histories["ws-1"] = [];

    render(<TedChat />);
    await screen.findByText("online");

    // Reidratado como failed com retry…
    expect(screen.getByText("paguei o aluguel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();

    // …o servidor passa a trazer a mensagem (persistiu afinal) e um novo
    // turno força nova carga de histórico…
    histories["ws-1"] = [ownMsg("srv-late", "paguei o aluguel", "2026-10-13T10:01:00.000Z")];
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t2"));
    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "outra pergunta");
    await user.click(screen.getByRole("button", { name: SEND }));

    // …o failed restaurado sai: UM balão (o do servidor), sem retry.
    await waitFor(() => expect(screen.queryByRole("button", { name: RETRY })).toBeNull());
    expect(screen.getAllByText("paguei o aluguel")).toHaveLength(1);
    expect(screen.queryByText(/falha no envio/i)).toBeNull();
  });
});

describe("R2 FIX 4 (LOW) — guidance distingue contas vs categorias e exige carga", () => {
  it("contas presentes + categorias vazias → copy de categorias (não a de contas)", async () => {
    appStateMock.state = {
      reconcileMutation: vi.fn(async () => undefined),
      accounts: [{ id: "a1", name: "Nubank" }],
      categories: [],
    };

    render(<TedChat />);
    await screen.findByText("online");

    expect(screen.getByTestId("ted-setup-guidance")).toBeInTheDocument();
    expect(screen.getByText(/nenhuma categoria cadastrada/i)).toBeInTheDocument();
    expect(screen.queryByText(/nenhuma conta cadastrada/i)).toBeNull();
    expect(screen.getByRole("link", { name: /ver categorias/i })).toHaveAttribute("href", "/hub/categorias");
  });

  it("dados ainda carregando (loading) → sem guidance enganosa", async () => {
    appStateMock.state = {
      reconcileMutation: vi.fn(async () => undefined),
      accounts: [],
      categories: [],
      loading: true,
    };

    render(<TedChat />);
    await screen.findByText("online");

    expect(screen.queryByTestId("ted-setup-guidance")).toBeNull();
    expect(screen.queryByText(/nenhuma conta cadastrada/i)).toBeNull();
    expect(screen.queryByText(/nenhuma categoria cadastrada/i)).toBeNull();
  });

  it("sync sem syncedAt (domínios não sincronizados) → sem guidance enganosa", async () => {
    appStateMock.state = {
      reconcileMutation: vi.fn(async () => undefined),
      accounts: [],
      categories: [],
      loading: false,
      sync: {
        accounts: { source: "live", syncedAt: null },
        categories: { source: "live", syncedAt: null },
      },
    };

    render(<TedChat />);
    await screen.findByText("online");

    expect(screen.queryByTestId("ted-setup-guidance")).toBeNull();
  });
});
