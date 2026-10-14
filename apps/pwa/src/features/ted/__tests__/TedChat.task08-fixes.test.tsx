/**
 * TASK_ID=CODER-PWA-FIXES-08 — RED→GREEN para as 2 lacunas da tarefa 08.
 *
 * FIX 1: a âncora pendente em sessionStorage (`savePendingChatSend` /
 * `loadPendingChatSend`) deve ser reidratada na montagem como balão `failed`
 * com retry — sem reenvio automático, sem inventar card.
 * FIX 2: com workspace sem contas/categorias, o empty state do chat deve
 * mostrar orientação + CTAs (Cadastrar conta / Criar transação) reaproveitando
 * copy e rotas existentes.
 *
 * Estes testes FALHAM antes do fix (documentam a lacuna) e PASSAM depois.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@/lib/test-utils";
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

// App-state controlável por teste: contas/categorias vazias ou preenchidas.
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

beforeEach(() => {
  vi.clearAllMocks();
  wsMock.ws.workspaces = [WS1];
  wsMock.ws.activeWorkspace = WS1;
  vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([]);
  vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
  vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
  appStateMock.state = null;
});

afterEach(() => {
  sessionStorage.clear();
});

describe("FIX 1 — reidratação do balão não-confirmado", () => {
  it("montagem com âncora pendente reidrata o balão como failed com retry, sem reenviar", async () => {
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-anchor-1",
      content: "Gastei R$ 50 no mercado",
      createdAt: new Date().toISOString(),
    });

    render(<TedChat />);
    await screen.findByText("online");

    // O balão reidratado aparece com affordance de retry…
    expect(screen.getByText("Gastei R$ 50 no mercado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument();
    // …e NADA foi reenviado sozinho.
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe("FIX 2 — empty state com orientação", () => {
  it("workspace sem contas/categorias mostra orientação + CTAs (Cadastrar conta / Criar transação)", async () => {
    appStateMock.state = {
      reconcileMutation: vi.fn(async () => undefined),
      accounts: [],
      categories: [],
    };

    render(<TedChat />);
    await screen.findByText("online");

    // Saudação original preservada…
    expect(screen.getByText("Olá! Sou o TED.")).toBeInTheDocument();
    // …mas agora com orientação reaproveitando a copy canônica…
    expect(screen.getByText(/Nenhuma conta cadastrada/i)).toBeInTheDocument();
    // …e CTAs para as telas existentes (sem criar telas).
    const ctaConta = screen.getByRole("link", { name: /cadastrar conta/i });
    const ctaTx = screen.getByRole("link", { name: /criar transação/i });
    expect(ctaConta).toHaveAttribute("href", "/hub/patrimonio?aba=contas");
    expect(ctaTx).toHaveAttribute("href", "/capture");
  });

  it("workspace com contas e categorias mantém o empty state original (sem orientação)", async () => {
    appStateMock.state = {
      reconcileMutation: vi.fn(async () => undefined),
      accounts: [{ id: "a1", name: "Nubank" }],
      categories: [{ id: "c1", name: "Mercado" }],
    };

    render(<TedChat />);
    await screen.findByText("online");

    expect(screen.getByText("Olá! Sou o TED.")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conta cadastrada/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /cadastrar conta/i })).toBeNull();
  });
});
