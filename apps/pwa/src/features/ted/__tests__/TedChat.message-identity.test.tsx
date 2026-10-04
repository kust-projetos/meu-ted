/**
 * A02 (R02) — identidade de mensagem no cliente (AC05/AC06/AC07).
 *
 * Método REPRODUCE-FIRST: o relato de "mensagem que some" (SPEC §2.1/F13) é
 * HIPÓTESE. Estes testes caracterizam o comportamento REAL da identidade antes
 * de qualquer classificação:
 *  - AC05: um balão por messageId (retry nunca duplica) e reconciliação por ID
 *    (nunca por posição/texto/timestamp);
 *  - AC06: dois textos iguais com messageIds distintos = DUAS mensagens (o
 *    cliente NUNCA deduplica por texto);
 *  - AC07: resultado tardio de request em voo NÃO entra no escopo novo
 *    (troca de workspace / logout durante o request).
 *
 * Os IDs são os JÁ EXISTENTES (SPEC §7.7): `composeChatSend`/`createChatMessageId`
 * ficam REAIS (mock parcial) e viajam como `intentionId` — nenhum ID paralelo
 * é criado aqui.
 *
 * Testes marcados "COMPORTAMENTO REAL (documentado)" fixam o comportamento
 * ATUAL que diverge da promessa e NÃO devem ser "corrigidos" sem decisão de
 * produto + mudança de contrato server-side (ver relatório A02).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";

type FakeWorkspace = Readonly<{ id: string; name: string; kind: "shared"; role: "owner" }>;

const WS1: FakeWorkspace = { id: "ws-1", name: "Minhas Finanças", kind: "shared", role: "owner" };
const WS2: FakeWorkspace = { id: "ws-2", name: "Casa", kind: "shared", role: "owner" };

// vi.hoisted: the factory runs during the import phase, so the mutable
// workspace holder must exist before any import is evaluated.
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

// `reconcileFinancialUi` is the ONLY await between the resolved turn and the
// history refresh — the window the HIGH finding describes. Controlled here so
// the switch can land exactly there.
const appStateMock = vi.hoisted(() => ({ reconcileMutation: vi.fn(async () => undefined) }));

vi.mock("@/lib/state/app-state-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/app-state-context")>();
  return {
    ...actual,
    useOptionalAppState: () => ({ reconcileMutation: appStateMock.reconcileMutation }),
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

// Partial mock: composeChatSend/createChatMessageId stay REAL (SPEC §7.7
// infra) so the tests exercise the actual stable-id behavior.
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets any late continuation (awaited promises/timers) run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const INPUT_PLACEHOLDER = "Pergunte sobre gastos, metas ou pagamentos…";
const SEND = /enviar mensagem/i;
const RETRY = /tentar novamente/i;
const okTurn = (turnId: string, output?: string): agentClient.AgentTurn =>
  ({ turnId, status: "completed", ...(output ? { output } : {}) }) as agentClient.AgentTurn;

const userMsg = (id: string, content: string): agentClient.AgentMessage => ({
  id,
  actorId: "user-1",
  role: "user",
  content,
  isOwn: true,
  createdAt: undefined,
});
const assistantMsg = (id: string, content: string): agentClient.AgentMessage => ({
  id,
  actorId: "ted",
  role: "assistant",
  content,
  isOwn: false,
  createdAt: undefined,
});

/** Server-authoritative history per workspace; tests evolve it mid-flight. */
let histories: Record<string, agentClient.AgentMessage[]>;

function sentMessageIds(): string[] {
  return vi
    .mocked(agentClient.sendAgentMessage)
    .mock.calls.map((call) => (call[2] as { messageId?: string }).messageId ?? "");
}

async function renderReady(): Promise<ReturnType<typeof render>> {
  const view = render(<TedChat />);
  await screen.findByText("online");
  return view;
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), text);
  await user.click(screen.getByRole("button", { name: SEND }));
}

beforeEach(() => {
  vi.clearAllMocks();
  histories = { "ws-1": [], "ws-2": [] };
  wsMock.ws.workspaces = [WS1, WS2];
  wsMock.ws.activeWorkspace = WS1;
  vi.mocked(agentClient.fetchAgentHistory).mockImplementation(
    async (workspaceId: string) => histories[workspaceId] ?? [],
  );
  vi.mocked(agentClient.fetchActivePendingOperations).mockResolvedValue([]);
  vi.mocked(agentClient.fetchActiveUndoProposals).mockResolvedValue([]);
  vi.mocked(agentClient.sendAgentMessage).mockResolvedValue(okTurn("t1"));
});

afterEach(() => {
  sessionStorage.clear();
});

describe("TedChat — AC05: um balão por messageId, sem desaparecimento silencioso", () => {
  it("retry com o MESMO messageId nunca duplica o balão (1 identidade → 1 balão)", async () => {
    const user = userEvent.setup();
    await renderReady();

    const retryFlight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("lost response"))
      .mockReturnValueOnce(retryFlight.promise);

    await send(user, "Gastei R$ 50 no mercado");

    // Falhou: UM balão, com retry, nunca descartado silenciosamente.
    await screen.findByRole("button", { name: RETRY });
    expect(screen.getAllByText("Gastei R$ 50 no mercado")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: RETRY }));
    // Em voo: continua UM balão (o mesmo messageId), não dois.
    expect(screen.getAllByText("Gastei R$ 50 no mercado")).toHaveLength(1);
    expect(screen.getAllByText("enviando…")).toHaveLength(1);

    // O servidor confirma a mensagem pelo MESMO id (histórico paginado/lagging).
    histories["ws-1"] = [userMsg("srv-1", "Gastei R$ 50 no mercado")];
    retryFlight.resolve(okTurn("t1"));

    await waitFor(() => expect(screen.getAllByText("Gastei R$ 50 no mercado")).toHaveLength(1));
    expect(screen.queryByText(/falha no envio/i)).toBeNull();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    // Todo envio compartilhou a MESMA identidade.
    expect(new Set(sentMessageIds()).size).toBe(1);
    expect(sentMessageIds()[0]).toBeTruthy();
  });

  it("a reconciliação segue o messageId: com dois balões de texto igual só o que está em voo muda de estado", async () => {
    const user = userEvent.setup();
    // Uma mensagem JÁ confirmada com o mesmo texto do novo envio.
    histories["ws-1"] = [userMsg("srv-1", "Bom dia")];
    await renderReady();
    expect(screen.getAllByText("Bom dia")).toHaveLength(1);

    const retryFlight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(retryFlight.promise);

    // Segundo envio do MESMO texto: nova identidade, novo balão.
    await send(user, "Bom dia");

    await screen.findByRole("button", { name: RETRY });
    // Dois balões (o confirmado e o novo), e só um em falha: a reconciliação
    // não pode ser por posição nem por texto.
    expect(screen.getAllByText("Bom dia")).toHaveLength(2);
    expect(screen.getAllByText(/falha no envio/i)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: RETRY })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: RETRY }));
    expect(screen.getAllByText("Bom dia")).toHaveLength(2);
    expect(screen.getAllByText("enviando…")).toHaveLength(1);
    expect(screen.queryByText(/falha no envio/i)).toBeNull();

    histories["ws-1"] = [userMsg("srv-1", "Bom dia"), userMsg("srv-2", "Bom dia")];
    retryFlight.resolve(okTurn("t2"));
    await waitFor(() => expect(screen.queryByText("enviando…")).toBeNull());

    // O balão local foi reconciliado pelo id: 2 balões, não 3.
    expect(screen.getAllByText("Bom dia")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    // O retry reenvia o MESMO messageId (identidade estável, SPEC §7.7).
    expect(new Set(sentMessageIds()).size).toBe(1);
    expect(sentMessageIds()[0]).toBeTruthy();
  });

  it("envio lento: enquanto o request não volta existe exatamente UM balão em 'enviando…'", async () => {
    const user = userEvent.setup();
    await renderReady();

    const flight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(flight.promise);

    await send(user, "Quanto gastei no mês?");

    expect(screen.getAllByText("Quanto gastei no mês?")).toHaveLength(1);
    expect(screen.getAllByText("enviando…")).toHaveLength(1);

    // Nada mais entra na lista enquanto o request está em voo (sem dedup, sem
    // duplicata): um balão por messageId em qualquer instante.
    histories["ws-1"] = [userMsg("srv-1", "Quanto gastei no mês?")];
    expect(screen.getAllByText("Quanto gastei no mês?")).toHaveLength(1);

    flight.resolve(okTurn("t1"));
    await waitFor(() => expect(screen.queryByText("enviando…")).toBeNull());
    expect(screen.getAllByText("Quanto gastei no mês?")).toHaveLength(1);
  });

  it("COMPORTAMENTO REAL (documentado): o balão confirmado sai da tela se o histórico bem-sucedido não o trouxer", async () => {
    // Comportamento atual do merge de `loadHistory`: só balões locais
    // "sending"/"failed" sobrevivem a um refresh autoritativo — um balão já
    // confirmado sai da tela se o lote retornado não o contiver.
    //
    // ALCANCE REAL (ver relatório A02): no caminho `/rpc/chat` o DO persiste a
    // mensagem do usuário ANTES de responder (finance-chat-agent.ts:867), então
    // o caso comum não some. A janela existe quando o histórico bem-sucedido
    // não traz a mensagem — p.ex. retry interno de grounding
    // (`isCorrectionRetry`, que suprime a persistência), histórico parcial ou
    // outro cliente na mesma conversa. O `/rpc/history` NÃO devolve o
    // intentionId/messageId, então o cliente não tem como reconciliar por
    // identidade: fixar isto exige eco do id no contrato + decisão de produto.
    const user = userEvent.setup();
    await renderReady();

    await send(user, "Gastei R$ 50 no mercado");
    await waitFor(() => expect(screen.queryByText("enviando…")).toBeNull());

    // O histórico autoritativo respondeu bem, mas sem a mensagem: o balão
    // local confirmado não é retido.
    expect(screen.queryByText("Gastei R$ 50 no mercado")).toBeNull();

    // Quando o histórico passa a trazer a mensagem, ela reaparece — sempre
    // vinda do servidor, nunca do estado local.
    histories["ws-1"] = [userMsg("srv-1", "Gastei R$ 50 no mercado")];
    await send(user, "e o almoço?");
    await waitFor(() => expect(screen.getByText("Gastei R$ 50 no mercado")).toBeInTheDocument());
  });

  it("COMPORTAMENTO REAL (documentado): reload não restaura o balão não confirmado, mas o id âncora persiste em sessionStorage", async () => {
    // Verificação do comportamento atual de recuperação pós-reload: o
    // registro de envio em voo é gravado por `savePendingChatSend`
    // (messageId + texto), porém NADA o consome na montagem — o chat volta
    // apenas do histórico autoritativo do servidor. Uma resposta HTTP perdida
    // (o DO pode ter gravado a mensagem; o cliente não teve confirmação)
    // deixa a mensagem fora da tela até um refresh trazê-la de volta.
    agentClient.savePendingChatSend("ws-1", {
      messageId: "msg-anchor-1",
      content: "Gastei R$ 50 no mercado",
      createdAt: new Date().toISOString(),
    });
    histories["ws-1"] = [];

    await renderReady();

    // Sem bolão local e sem affordance de retry: nada é inventado.
    expect(screen.queryByText("Gastei R$ 50 no mercado")).toBeNull();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(agentClient.sendAgentMessage).not.toHaveBeenCalled();
    // …mas a identidade do envio continua disponível para uma futura
    // recuperação (a âncora de idempotência não é perdida).
    expect(agentClient.loadPendingChatSend("ws-1")?.messageId).toBe("msg-anchor-1");
  });
});

describe("TedChat — AC06: dois textos iguais com IDs distintos = DUAS mensagens (nunca dedup por texto)", () => {
  it("dois envios do mesmo texto viram duas intenções (messageIds distintos) e dois balões", async () => {
    const user = userEvent.setup();
    await renderReady();

    // Ambos ficam sem confirmação: os dois balões coexistem pelo TEMPO
    // todo — o cliente não deduplica por texto em nenhum momento.
    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("down 1"))
      .mockRejectedValueOnce(new Error("down 2"));

    await send(user, "Bom dia");
    await screen.findByRole("button", { name: RETRY });
    await send(user, "Bom dia");

    await waitFor(() => expect(screen.getAllByRole("button", { name: RETRY })).toHaveLength(2));
    expect(screen.getAllByText("Bom dia")).toHaveLength(2);
    expect(screen.getAllByText(/falha no envio/i)).toHaveLength(2);

    const ids = sentMessageIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("uma resposta IDÊNTICA de um turno anterior nunca suprime a resposta do turno atual", async () => {
    const user = userEvent.setup();
    const reply = "Olá! Como posso ajudar?";
    await renderReady();

    // 1º turno: resposta local (o servidor ainda não persistiu nada).
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t1", reply));
    await send(user, "Bom dia");
    await waitFor(() => expect(screen.getAllByText(reply)).toHaveLength(1));

    // O servidor persistiu a 1ª troca: o histórico já contém a MESMA resposta.
    histories["ws-1"] = [userMsg("srv-1", "Bom dia"), assistantMsg("srv-2", reply)];

    // 2º turno: mesmo texto de entrada e resposta byte-idêntica — ainda assim
    // é uma nova mensagem (identidade distinta, nunca texto).
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t2", reply));
    await send(user, "Bom dia");

    await waitFor(() => expect(screen.getAllByText(reply)).toHaveLength(2));
    const ids = sentMessageIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("CONFOUND DOCUMENTADO (comportamento real, NÃO endossado): resposta local não persistida + turno atual idêntico persiste duplicata", async () => {
    // Cenário exato do reviewer (MEDIUM). O fio NÃO carrega identidade
    // autoritativa hoje — evidência:
    //   • `/rpc/chat` responde `{ status, output, pendingOperation?, undoProposal? }`
    //     (finance-chat-agent.ts:2254): NÃO ecoa `turnId`/`intentionId`, então o
    //     cliente cai no fallback `turn-${Date.now()}` (agent-client.ts:499) —
    //     id local, tempo-based, sem relação com o intentionId enviado;
    //   • o DO persiste `id: msg-user-*/msg-asst-*` gerados no servidor e
    //     `metadata: { actorId, workspaceId, createdAt }`
    //     (finance-chat-agent.ts:857-867) — o intentionId do cliente NÃO é
    //     persistido;
    //   • `/rpc/history` devolve só `{ id, actorId, role, content, createdAt,
    //     isOwn, attachments }` (finance-chat-agent.ts:2375-2394) — nenhum
    //     turnId/intentionId.
    // Logo não existe identidade reutilizável para reconciliar a resposta do
    // turno contra o lote, e a heurística de contagem (texto) não dá conta.
    // COMO O COMPORTAMENTO É HOJE (fixado aqui, não endossado):
    //   turno 1 = mutation/confirmation/cancel → resposta assistant NÃO
    //   persistida pelo DO (finance-chat-agent.ts:2200-2203) → fica só local;
    //   turno 2 = read → resposta "X" IGUAL, persistida pelo DO;
    //   o refresh substitui a lista (a cópia local do turno 1 some) e a
    //   heurística conta 1 <= 1 → anexa a cópia local do turno 2 → o MESMO
    //   texto aparece DUAS vezes, ambas do turno 2.
    // Correção exige mudança de protocolo (persistir/ecoar o intentionId) —
    // decisão do Planner, fora do escopo desta fatia.
    const user = userEvent.setup();
    const answer = "Registrei isso aqui.";
    await renderReady();

    // Turno 1: mutation — a resposta não é persistida pelo DO.
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t1", answer));
    await send(user, "Gastei R$ 50 no mercado");
    await waitFor(() => expect(screen.getAllByText(answer)).toHaveLength(1));

    // Turno 2: read — resposta idêntica, AGORA persistida pelo DO (o
    // histórico autoritativo traz a cópia do servidor).
    histories["ws-1"] = [userMsg("srv-2", "e as metas?"), assistantMsg("srv-x", answer)];
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce(okTurn("t2", answer));
    await send(user, "e as metas?");
    await settle();

    // COMPORTAMENTO REAL: duas cópias do mesmo texto (a do servidor + a local
    // do turno 2); a cópia local do turno 1 saiu no refresh.
    expect(screen.getAllByText(answer)).toHaveLength(2);
  });

  it("a retenção local da resposta do turno continua existindo (histórico já persistiu a resposta)", async () => {
    const user = userEvent.setup();
    const reply = "Tudo certo por aqui.";
    await renderReady();

    // O DO persiste a resposta antes de o cliente recarregar o histórico:
    // a retenção local existe justamente para NÃO renderizar a mesma
    // resposta duas vezes.
    const flight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(flight.promise);
    await send(user, "oi");
    histories["ws-1"] = [userMsg("srv-1", "oi"), assistantMsg("srv-ans", reply)];
    flight.resolve(okTurn("t1", reply));
    await settle();

    // Uma única cópia: a do histórico autoritativo.
    expect(screen.getAllByText(reply)).toHaveLength(1);
  });
});

describe("TedChat — AC07: resultado tardio NÃO entra no escopo novo", () => {
  it("troca de workspace durante o request: a resposta do workspace antigo não entra no chat novo", async () => {
    const user = userEvent.setup();
    histories["ws-1"] = [userMsg("ws1-msg", "conversa do ws 1")];
    histories["ws-2"] = [userMsg("ws2-msg", "conversa do ws 2")];
    const view = await renderReady();
    expect(screen.getByText("conversa do ws 1")).toBeInTheDocument();

    const flight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(flight.promise);
    await send(user, "Gastei R$ 50 no mercado");

    // Troca de workspace com o request em voo.
    wsMock.ws.activeWorkspace = WS2;
    view.rerender(<TedChat />); // same instance: reads the new active workspace
    await waitFor(() => expect(screen.getByText("conversa do ws 2")).toBeInTheDocument());
    expect(screen.queryByText("conversa do ws 1")).toBeNull();

    const historyCallsAtSwitch = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    const activeCallsAtSwitch = vi.mocked(agentClient.fetchActivePendingOperations).mock.calls.length;

    // O turno antigo só termina agora.
    flight.resolve(okTurn("t-ws1", "resposta do ws 1"));
    await settle();

    // 1) Nenhum histórico/active-list do escopo antigo é buscado após a troca.
    expect(vi.mocked(agentClient.fetchAgentHistory).mock.calls.slice(historyCallsAtSwitch)).toHaveLength(0);
    expect(vi.mocked(agentClient.fetchActivePendingOperations).mock.calls.slice(activeCallsAtSwitch)).toHaveLength(0);
    // 2) O texto do workspace antigo não aparece no chat novo…
    expect(screen.queryByText("resposta do ws 1")).toBeNull();
    // 3) …e o chat novo continua íntegro.
    expect(screen.getByText("conversa do ws 2")).toBeInTheDocument();
    expect(screen.queryByText("conversa do ws 1")).toBeNull();
  });

  it("troca de workspace durante o request: card de aprovação do workspace antigo não entra no chat novo", async () => {
    const user = userEvent.setup();
    histories["ws-2"] = [];
    const view = await renderReady();

    const flight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(flight.promise);
    await send(user, "Gastei R$ 50 no mercado");

    wsMock.ws.activeWorkspace = WS2;
    view.rerender(<TedChat />);
    await waitFor(() => expect(agentClient.fetchActivePendingOperations).toHaveBeenCalledWith("ws-2"));
    const activeCallsAtSwitch = vi.mocked(agentClient.fetchActivePendingOperations).mock.calls.length;

    flight.resolve({
      turnId: "t-ws1",
      status: "completed",
      output: "Proposta criada no ws 1.",
      pendingOperation: {
        id: "pending-ws1",
        status: "proposed",
        operation: "transactions.expense.create",
        summary: "Mercado",
      },
    } as agentClient.AgentTurn);
    await settle();

    expect(vi.mocked(agentClient.fetchActivePendingOperations).mock.calls.slice(activeCallsAtSwitch)).toHaveLength(0);
    // O card proposed do escopo antigo nunca aparece no chat novo.
    expect(screen.queryByTestId("ted-approval-item")).toBeNull();
    expect(screen.queryByText(/Confirmar despesa/i)).toBeNull();
    expect(screen.queryByText("Proposta criada no ws 1.")).toBeNull();
  });

  it("logout durante o request (sem workspace ativo): o resultado tardio não recarrega histórico do workspace anterior", async () => {
    const user = userEvent.setup();
    histories["ws-1"] = [userMsg("ws1-msg", "conversa do ws 1")];
    const view = await renderReady();
    expect(screen.getByText("conversa do ws 1")).toBeInTheDocument();

    const flight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(flight.promise);
    await send(user, "Gastei R$ 50 no mercado");

    const callsAtLogout = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    wsMock.ws.activeWorkspace = null;
    view.rerender(<TedChat />);
    await waitFor(() => expect(screen.queryByText("conversa do ws 1")).toBeNull());

    flight.resolve(okTurn("t-ws1", "resposta do ws 1"));
    await settle();

    expect(screen.queryByText("resposta do ws 1")).toBeNull();
    expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1);
    // Nenhum histórico do escopo anterior é buscado depois do logout.
    expect(vi.mocked(agentClient.fetchAgentHistory).mock.calls.slice(callsAtLogout)).toHaveLength(0);
  });

  it("falha tardia após a troca de workspace não marca falha nem mostra erro no chat novo", async () => {
    const user = userEvent.setup();
    histories["ws-2"] = [];
    const view = await renderReady();

    const flight = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(flight.promise);
    await send(user, "Gastei R$ 50 no mercado");

    wsMock.ws.activeWorkspace = WS2;
    view.rerender(<TedChat />);
    await waitFor(() => expect(agentClient.fetchActivePendingOperations).toHaveBeenCalledWith("ws-2"));

    flight.reject(new Error("ws-1 caiu"));
    await settle();

    // O erro do escopo antigo não vira erro visível no escopo novo.
    expect(screen.queryByText(/falha no envio/i)).toBeNull();
    expect(screen.queryByText(/indisponível/i)).toBeNull();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
  });
});

/**
 * A02 HIGH — o guard de escopo precisa valer para CADA await que antecede
 * escrita de estado, não só para a resposta inicial do turno. Cada cenário
 * abaixo posiciona a troca de workspace num await diferente da mesma cadeia:
 * (i) entre o turno resolvido e o `loadHistory` (janela do reconciliador
 * financeiro), (ii) durante o fetch de histórico dentro do `loadHistory`,
 * (iii) durante o fetch da active-list dentro do `loadHistory`.
 */
describe("TedChat — AC07 (HIGH): a troca de escopo em QUALQUER await da cadeia aborta a escrita", () => {
  const ws1ActiveOp = {
    id: "pending-ws1",
    status: "proposed",
    tool: "transactions.expense.create",
    createdAt: "2026-09-14T10:00:00.000Z",
    expiresAt: "2099-09-14T13:00:00.000Z",
  };

  it("(i) troca durante o reconciliador financeiro: a continuação do turno antigo não escreve no chat novo", async () => {
    const user = userEvent.setup();
    histories["ws-1"] = [userMsg("ws1-msg", "conversa do ws 1")];
    histories["ws-2"] = [userMsg("ws2-msg", "conversa do ws 2")];
    const reconcileFlight = deferred<unknown>();
    appStateMock.reconcileMutation.mockReturnValueOnce(reconcileFlight.promise as Promise<undefined>);
    const view = await renderReady();

    // Turno com execução real no mesmo round-trip: o reconciliador financeiro
    // roda ANTES de qualquer escrita de mensagens/cards.
    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({
      turnId: "t-ws1",
      status: "completed",
      pendingOperation: {
        id: "pending-ws1",
        status: "succeeded",
        operation: "transactions.expense.create",
        receipt: {
          mutationId: "mut-ws1",
          mutationKind: "transactions.expense.create",
          status: "succeeded",
          affectedTargets: ["transactions"],
          operationId: "pending-ws1",
          entity: { type: "transaction", id: "tx-ws1" },
        },
      },
    } as agentClient.AgentTurn);
    await send(user, "Gastei R$ 50 no mercado");
    await waitFor(() => expect(appStateMock.reconcileMutation).toHaveBeenCalledTimes(1));

    const historyCallsAtSwitch = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    wsMock.ws.activeWorkspace = WS2;
    view.rerender(<TedChat />);
    await waitFor(() => expect(screen.getByText("conversa do ws 2")).toBeInTheDocument());

    // Baseline AFTER the switch's own refresh: only calls issued by the stale
    // continuation of ws-1 are in scope here.
    const callsAfterSwitchRefresh = vi.mocked(agentClient.fetchAgentHistory).mock.calls.length;
    reconcileFlight.resolve(undefined);
    await settle();

    // A continuação do turno de ws-1 NÃO pode recarregar nem escrever nada.
    expect(vi.mocked(agentClient.fetchAgentHistory).mock.calls.slice(callsAfterSwitchRefresh)).toHaveLength(0);
    expect(historyCallsAtSwitch).toBeGreaterThan(0);
    expect(screen.queryByText("conversa do ws 1")).toBeNull();
    expect(screen.getByText("conversa do ws 2")).toBeInTheDocument();
  });

  it("(ii) troca durante o fetch de histórico: o lote do escopo antigo não entra no chat novo", async () => {
    const user = userEvent.setup();
    histories["ws-2"] = [userMsg("ws2-msg", "conversa do ws 2")];
    const view = await renderReady();

    // O refresh disparado pelo turno de ws-1 fica pendente…
    const historyFlight = deferred<agentClient.AgentMessage[]>();
    vi.mocked(agentClient.fetchAgentHistory).mockImplementationOnce(async () => historyFlight.promise);
    await send(user, "Gastei R$ 50 no mercado");
    await waitFor(() => expect(agentClient.fetchAgentHistory).toHaveBeenCalledTimes(2));

    // …a troca acontece enquanto ele está em voo…
    wsMock.ws.activeWorkspace = WS2;
    view.rerender(<TedChat />);
    await waitFor(() => expect(screen.getByText("conversa do ws 2")).toBeInTheDocument());

    // …e o lote de ws-1 chega depois.
    historyFlight.resolve([userMsg("ws1-late", "conversa do ws 1 (atrasada)")]);
    await settle();

    expect(screen.queryByText("conversa do ws 1 (atrasada)")).toBeNull();
    expect(screen.getByText("conversa do ws 2")).toBeInTheDocument();
  });

  it("(iii) troca durante o fetch da active-list: cards do escopo antigo não entram no chat novo", async () => {
    const user = userEvent.setup();
    histories["ws-2"] = [];
    const view = await renderReady();

    // O histórico responde; a active-list de ws-1 fica pendente.
    const activeFlight = deferred<agentClient.ActivePendingOperation[]>();
    vi.mocked(agentClient.fetchActivePendingOperations).mockReturnValueOnce(activeFlight.promise);
    await send(user, "Gastei R$ 50 no mercado");
    await waitFor(() => expect(agentClient.fetchActivePendingOperations).toHaveBeenCalledTimes(2));

    wsMock.ws.activeWorkspace = WS2;
    view.rerender(<TedChat />);
    await waitFor(() => expect(agentClient.fetchActivePendingOperations).toHaveBeenCalledWith("ws-2"));

    activeFlight.resolve([ws1ActiveOp as agentClient.ActivePendingOperation]);
    await settle();

    // O card de aprovação de ws-1 nunca aparece no chat de ws-2.
    expect(screen.queryByTestId("ted-approval-item")).toBeNull();
    expect(screen.queryByText(/Confirmar despesa/i)).toBeNull();
  });
});
