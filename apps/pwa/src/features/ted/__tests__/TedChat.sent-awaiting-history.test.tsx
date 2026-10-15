/**
 * FIX-169 RED: a bolha enviada some após resposta (P0).
 *
 * (c) POST sucesso + GET defasado => a mensagem original PERMANECE
 * (sent-awaiting-history) até o histórico convergir; nunca some.
 * Convergência => cópia única, sem duplicação.
 * (f) 502/timeout => failed visível, sem sumiço nem falso sucesso.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "../TedChat";
import * as agentClient from "@/lib/api/agent-client";
import { isAnchorSupersededByHistory } from "@/lib/api/agent-client";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "shared" as const, role: "owner" },
    members: [],
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
  };
  return {
    ...actual,
    useWorkspace: () => mockWs,
    useWorkspaceSafe: () => mockWs,
  };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn(),
    sendAgentMessage: vi.fn(),
    renewAgentSession: vi.fn(),
    uploadAttachment: vi.fn(),
  };
});

const INPUT_PLACEHOLDER = "Pergunte sobre gastos, metas ou pagamentos…";
const SEED: agentClient.AgentMessage[] = [
  { id: "srv-1", actorId: "ted", role: "assistant", content: "Olá! Como posso ajudar?", isOwn: false, createdAt: undefined, attachments: undefined },
];

describe("FIX-169 — sent-awaiting-history (consistência eventual)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(c) POST sucesso + histórico defasado => bolha original permanece e resposta aparece, sem retry", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([...SEED]);
    render(<TedChat />);
    await screen.findByText("Olá! Como posso ajudar?");

    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({
      turnId: "t-169",
      status: "completed",
      output: "Proposta registrada.",
    });
    // Histórico ainda NÃO convergiu (lag eventual): só a semente.
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([...SEED]);

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "gastei 90 com carne");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    // A resposta do turno é autoritativa e aparece.
    expect(await screen.findByText("Proposta registrada.")).toBeInTheDocument();
    // A bolha original NÃO some mesmo com o histórico defasado…
    expect(screen.getByText("gastei 90 com carne")).toBeInTheDocument();
    // …e não vira falha: sem botão de retry, sem falso erro.
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull();
    expect(screen.queryByText(/falha no envio/i)).toBeNull();
  });

  it("(c-converge) quando o histórico converge, há cópia única (sem bolha fantasma permanente)", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValueOnce([...SEED]);
    render(<TedChat />);
    await screen.findByText("Olá! Como posso ajudar?");

    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({
      turnId: "t-169",
      status: "completed",
      output: "Proposta registrada.",
    });
    const converged = (): agentClient.AgentMessage[] => [
      ...SEED,
      { id: "srv-user-169", actorId: "u1", role: "user", content: "gastei 90 com carne", isOwn: true, createdAt: new Date().toISOString(), attachments: undefined },
      { id: "srv-asst-169", actorId: "ted", role: "assistant", content: "Proposta registrada.", isOwn: false, createdAt: new Date().toISOString(), attachments: undefined },
    ];
    // Avaliado no momento da chamada (histórico converge DEPOIS do envio —
    // timestamps do servidor >= âncora local, regra do supersede).
    vi.mocked(agentClient.fetchAgentHistory).mockImplementation(async () => converged());

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "gastei 90 com carne");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("enviando…")).toBeNull());
    // Cópia única de cada texto: nada duplicado, nada sumido.
    expect(screen.getAllByText("gastei 90 com carne")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull();
  });

  it("(f) 502/timeout => failed visível com retry, sem sumiço nem falso sucesso", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValue([...SEED]);
    render(<TedChat />);
    await screen.findByText("Olá! Como posso ajudar?");

    vi.mocked(agentClient.sendAgentMessage).mockRejectedValueOnce(
      Object.assign(new Error("Falha ao processar a solicitação."), { status: 502 }),
    );

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "gastei 90 com carne");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    expect(await screen.findByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();
    expect(screen.getByText("gastei 90 com carne")).toBeInTheDocument();
    expect(screen.getByText(/falha no envio/i)).toBeInTheDocument();
  });

  it("(P2-2/DLP) conteúdo divergente (scrub) com a MESMA identidade converge: cópia única do servidor, sem fantasma", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValueOnce([...SEED]);
    render(<TedChat />);
    await screen.findByText("Olá! Como posso ajudar?");

    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({
      turnId: "t-169-dlp",
      status: "completed",
      output: "Proposta registrada.",
    });
    // O servidor persistiu o par com o texto JÁ depurado (DLP) — o conteúdo
    // diverge do digitado, mas a identidade (intentionId) é a do envio.
    vi.mocked(agentClient.fetchAgentHistory).mockImplementation(async () => {
      const sentId = (vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2] as { messageId?: string } | undefined)?.messageId ?? "unknown";
      return [
        ...SEED,
        { id: `msg-user-${sentId}`, actorId: "u1", role: "user", content: "gastei 90 com carne [dado removido]", isOwn: true, createdAt: new Date().toISOString(), attachments: undefined, intentionId: sentId },
        { id: `msg-asst-${sentId}`, actorId: "ted", role: "assistant", content: "Proposta registrada.", isOwn: false, createdAt: new Date().toISOString(), attachments: undefined, intentionId: sentId },
      ];
    });

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "gastei 90 com carne");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("enviando…")).toBeNull());
    // A bolha local (texto cru) foi absorvida pela cópia do servidor (texto
    // depurado): sem fantasma permanente, sem duplicata, sem retry.
    expect(screen.queryByText("gastei 90 com carne")).toBeNull();
    expect(screen.getAllByText("gastei 90 com carne [dado removido]")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull();
  });

  it("(P2-2/skew) timestamp anterior (clock skew) com a MESMA identidade converge: cópia única, sem fantasma", async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.fetchAgentHistory).mockResolvedValueOnce([...SEED]);
    render(<TedChat />);
    await screen.findByText("Olá! Como posso ajudar?");

    vi.mocked(agentClient.sendAgentMessage).mockResolvedValueOnce({
      turnId: "t-169-skew",
      status: "completed",
      output: "Proposta registrada.",
    });
    // Relógio do servidor atrasado: o item autoritativo é ANTERIOR ao envio
    // local — a regra legada (conteúdo + ts>=) nunca absorveria; a identidade sim.
    vi.mocked(agentClient.fetchAgentHistory).mockImplementation(async () => {
      const sentId = (vi.mocked(agentClient.sendAgentMessage).mock.calls[0]?.[2] as { messageId?: string } | undefined)?.messageId ?? "unknown";
      const skewedAt = new Date(Date.now() - 3600_000).toISOString();
      return [
        ...SEED,
        { id: `msg-user-${sentId}`, actorId: "u1", role: "user", content: "gastei 90 com carne", isOwn: true, createdAt: skewedAt, attachments: undefined, intentionId: sentId },
        { id: `msg-asst-${sentId}`, actorId: "ted", role: "assistant", content: "Proposta registrada.", isOwn: false, createdAt: skewedAt, attachments: undefined, intentionId: sentId },
      ];
    });

    await user.type(screen.getByPlaceholderText(INPUT_PLACEHOLDER), "gastei 90 com carne");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("enviando…")).toBeNull());
    expect(screen.getAllByText("gastei 90 com carne")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /tentar novamente/i })).toBeNull();
  });
});

describe("FIX-169-170-R2 (P2-2) RED — reconciliação por identidade (pura)", () => {
  const NOW_ISO = new Date().toISOString();
  const anchor = { content: "gastei 90 com carne", createdAt: NOW_ISO, messageId: "msg-p22-1" };

  it("identidade igual supera conteúdo divergente (DLP) e timestamp anterior (skew)", () => {
    const history = [
      { isOwn: true, content: "gastei 90 com carne [dado removido]", createdAt: new Date(Date.parse(NOW_ISO) - 3600_000).toISOString(), intentionId: "msg-p22-1" },
    ];
    expect(isAnchorSupersededByHistory(anchor, history)).toBe(true);
  });

  it("sem identidade em jogo, a regra legada (conteúdo idêntico + ts>=) continua valendo", () => {
    const legacyAnchor = { content: "gastei 90 com carne", createdAt: NOW_ISO };
    const newer = [{ isOwn: true, content: "gastei 90 com carne", createdAt: new Date(Date.parse(NOW_ISO) + 1000).toISOString() }];
    expect(isAnchorSupersededByHistory(legacyAnchor, newer)).toBe(true);
    const older = [{ isOwn: true, content: "gastei 90 com carne", createdAt: new Date(Date.parse(NOW_ISO) - 1000).toISOString() }];
    expect(isAnchorSupersededByHistory(legacyAnchor, older)).toBe(false);
  });

  it("intentionId de item alheio (isOwn false) nunca supera a âncora", () => {
    const history = [
      { isOwn: false, content: "outro texto", createdAt: NOW_ISO, intentionId: "msg-p22-1" },
    ];
    expect(isAnchorSupersededByHistory(anchor, history)).toBe(false);
  });

  it("identidade distinta não absorve (dois envios iguais seguem dois balões)", () => {
    const history = [
      { isOwn: true, content: "gastei 90 com carne", createdAt: new Date(Date.parse(NOW_ISO) + 1000).toISOString(), intentionId: "msg-outra" },
    ];
    expect(isAnchorSupersededByHistory(anchor, history)).toBe(false);
  });

  it("FIX-169-170-R3: mesmo texto + ts posterior com intentionId DIFERENTE não absorve (send-A vs send-B)", () => {
    const anchorSendA = { content: "mercado", createdAt: NOW_ISO, messageId: "send-A", intentionId: "send-A" };
    const history = [
      { isOwn: true, content: "mercado", createdAt: new Date(Date.parse(NOW_ISO) + 1000).toISOString(), intentionId: "send-B" },
    ];
    expect(isAnchorSupersededByHistory(anchorSendA, history)).toBe(false);
  });

  it("FIX-169-170-R3: item legado sem identidade ainda converge pelo fallback (controle positivo)", () => {
    const anchorSendA = { content: "mercado", createdAt: NOW_ISO, messageId: "send-A", intentionId: "send-A" };
    const history = [
      { isOwn: true, content: "mercado", createdAt: new Date(Date.parse(NOW_ISO) + 1000).toISOString() },
    ];
    expect(isAnchorSupersededByHistory(anchorSendA, history)).toBe(true);
  });
});
