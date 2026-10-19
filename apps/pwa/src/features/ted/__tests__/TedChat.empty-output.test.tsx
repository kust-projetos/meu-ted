/**
 * TASK_ID=CODER-TOOLS-PWA-P3 — RED→GREEN: 200 com `output` ausente/vazio.
 *
 * Um turno 200 sem texto de resposta, sem pendingOperation e sem undoProposal
 * NÃO é sucesso: hoje o balão é marcado `sent` e a âncora (draft) é limpa —
 * falso sucesso sem retry. Estes testes FALHAM antes do fix e PASSAM depois:
 * o balão deve ficar `failed` com retry, e a âncora deve sobreviver para o
 * retry reenviar a MESMA identidade (§7.7).
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
    uploadAttachment: vi.fn(),
  };
});

const RETRY = /tentar novamente/i;
const INPUT_PLACEHOLDER = "Pergunte sobre gastos, metas ou pagamentos…";
const SEND = /enviar mensagem/i;

const emptyTurn = (turnId: string): agentClient.AgentTurn =>
  ({ turnId, status: "completed" }) as agentClient.AgentTurn;

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
  vi.unstubAllEnvs();
});

describe("P3 — turno 200 sem output é falha retentável, nunca sucesso", () => {
  it("output ausente: balão fica failed com retry e a âncora sobrevive", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(emptyTurn("t-empty"));
    render(<TedChat />);
    await screen.findByText("online");

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "qual meu saldo?");
    await user.click(screen.getByRole("button", { name: SEND }));

    // Falso sucesso seria: sem retry, balão sent. O correto é failed + retry.
    expect(await screen.findByRole("button", { name: RETRY })).toBeInTheDocument();

    // A âncora sobrevive: o retry reenvia a MESMA identidade (§7.7).
    const first = vi.mocked(agentClient.sendAgentMessage).mock.calls[0]!;
    const firstId = (first[2] as { messageId?: string }).messageId;
    expect(firstId).toBeTruthy();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(emptyTurn("t-empty-2"));
    await user.click(screen.getByRole("button", { name: RETRY }));
    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(2));
    const second = vi.mocked(agentClient.sendAgentMessage).mock.calls[1]!;
    expect((second[2] as { messageId?: string }).messageId).toBe(firstId);
  });

  it("output só-espaços: também falha com retry em vez de marcar sent", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({
      ...emptyTurn("t-blank"),
      output: "   ",
    } as agentClient.AgentTurn);
    render(<TedChat />);
    await screen.findByText("online");

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "e minhas metas?");
    await user.click(screen.getByRole("button", { name: SEND }));

    expect(await screen.findByRole("button", { name: RETRY })).toBeInTheDocument();
  });
});
