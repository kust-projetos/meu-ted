/**
 * F1 — o TEXTO que cruza o fio é SOMENTE o que o humano digitou.
 *
 * `handleSend` compunha o texto do envio a partir dos anexos: quando o input
 * estava vazio, o NOME do arquivo virava o texto do usuário; quando havia
 * texto, um marcador `[tipo: nome]` era concatenado ao payload. Como o texto do
 * turno é o que decide (imperativo mutacional no início ⇒ autoexecute; "sim
 * confirmo" ⇒ confirmação), essa contaminação é exatamente o vetor que o F1
 * proíbe: um arquivo chamado `sim confirmo.pdf` escrevia no texto a frase que o
 * roteador de decisão lê.
 *
 * Contrato fixado aqui:
 *   - `text` = texto digitado, trimado, e nada mais;
 *   - `attachments` = `[{ type, ref, name }]` — o anexo viaja pelo SEU campo;
 *   - o bubble otimista continua renderizando nome/tipo (é de exibição).
 *
 * O servidor já sabe renderizar o placeholder de anexo a partir do array
 * (`[anexo <nome>]`), então nada é perdido com o texto limpo.
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
    uploadAttachment: vi
      .fn()
      .mockImplementation(async (_ws: string, input: { kind: string; name?: string }) => ({
        ref: `att_${(input.kind ?? "x").padEnd(20, "0").slice(0, 20)}`,
        kind: input.kind,
        name: input.name ?? "anexo",
        size: 33,
      })),
  };
});

function installMediaMocks() {
  const mockStream = { getTracks: () => [{ stop: vi.fn() }] };
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    writable: true,
    configurable: true,
  });
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => "blob:mock-url");
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();
}

const sentText = (call: unknown): string => (call as [string, string, unknown])[1];
const sentOpts = (call: unknown): { attachments?: Array<{ type: string; name: string; ref?: string }> } =>
  (call as [string, string, { attachments?: Array<{ type: string; name: string; ref?: string }> }])[2];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const okTurn = { turnId: "t1", status: "completed" } as const;

async function uploadPdf(user: ReturnType<typeof userEvent.setup>, container: HTMLElement, name: string) {
  const pdfInput = container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
  expect(pdfInput).not.toBeNull();
  await user.upload(pdfInput, new File(["%PDF-1.7"], name, { type: "application/pdf" }));
  await screen.findByRole("button", { name: new RegExp(`remover ${name.replace(/\./g, "\\.")}`, "i") });
}

describe("F1 — o texto que cruza o fio é só o texto digitado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsState.activeId = "ws-1";
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
    installMediaMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("anexo enviado com sucesso + texto digitado: `text` é EXATAMENTE o que foi digitado", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    await uploadPdf(user, container, "nota-fiscal.pdf");
    await user.type(screen.getByRole("textbox", { name: /mensagem/i }), "gastei 50");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    const call = vi.mocked(agentClient.sendAgentMessage).mock.calls[0];
    expect(sentText(call)).toBe("gastei 50");
    // Nenhum marcador, nenhum nome de arquivo, nenhum sufixo.
    expect(sentText(call)).not.toContain("[pdf:");
    expect(sentText(call)).not.toContain("nota-fiscal");
    // O anexo viaja pelo SEU campo, com a referência opaca.
    expect(sentOpts(call).attachments?.[0]).toMatchObject({ type: "pdf", name: "nota-fiscal.pdf" });
  });

  it("anexo chamado 'sim confirmo.pdf' com input vazio: `text` é string vazia e o anexo vai no array", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const { container } = render(<TedChat />);
    await uploadPdf(user, container, "sim confirmo.pdf");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    const call = vi.mocked(agentClient.sendAgentMessage).mock.calls[0];
    // A frase que o roteador de decisão lê não pode vir do nome do arquivo.
    expect(sentText(call)).toBe("");
    // O nome existe APENAS como metadado no campo próprio do anexo (para
    // exibição/claim validada server-side) — nunca como texto do turno.
    expect(sentOpts(call).attachments?.[0]).toMatchObject({ type: "pdf", name: "sim confirmo.pdf" });
  });

  it("o bubble otimista continua mostrando o anexo (render-only) enquanto o texto carrega só o digitado", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    const pending = deferred<agentClient.AgentTurn>();
    vi.mocked(agentClient.sendAgentMessage).mockReturnValueOnce(pending.promise);
    const { container } = render(<TedChat />);
    await uploadPdf(user, container, "comprovante.pdf");
    await user.type(screen.getByRole("textbox", { name: /mensagem/i }), "gastei 50");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    // While in flight the optimistic bubble is on screen: the typed text is the
    // whole message body and the attachment chip renders from `localAttachments`.
    expect(screen.getByText("gastei 50")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/comprovante\.pdf/)).toBeInTheDocument());
    expect(screen.queryByText(/\[pdf:/)).toBeNull();

    pending.resolve(okTurn);
    await waitFor(() => expect(screen.queryByText(/enviando/)).toBeNull());
  });

  it("retry de um turno com anexo reenvia o MESMO texto limpo (sem re-apender marcador)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    const user = userEvent.setup();
    vi.mocked(agentClient.sendAgentMessage)
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(okTurn);
    const { container } = render(<TedChat />);
    await uploadPdf(user, container, "recibo.pdf");
    await user.type(screen.getByRole("textbox", { name: /mensagem/i }), "gastei 50");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
    await screen.findByRole("button", { name: /tentar novamente/i });
    await user.click(screen.getByRole("button", { name: /tentar novamente/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(agentClient.sendAgentMessage).mock.calls;
    expect(sentText(second)).toBe("gastei 50");
    expect(sentText(first)).toBe(sentText(second));
    // O retry reusa a referência opaca do rascunho — nunca uma URL de blob.
    expect(sentOpts(second).attachments?.[0]?.ref).toMatch(/^att_/);
    expect(JSON.stringify(second)).not.toContain("blob:");
  });

  it("turno sem anexo não muda: `text` é o digitado, sem marcador", async () => {
    const user = userEvent.setup();
    render(<TedChat />);
    await user.type(screen.getByRole("textbox", { name: /mensagem/i }), "gastei 50 de carne");
    await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));

    await waitFor(() => expect(agentClient.sendAgentMessage).toHaveBeenCalledTimes(1));
    const call = vi.mocked(agentClient.sendAgentMessage).mock.calls[0];
    expect(sentText(call)).toBe("gastei 50 de carne");
    expect(sentOpts(call).attachments).toBeUndefined();
  });
});