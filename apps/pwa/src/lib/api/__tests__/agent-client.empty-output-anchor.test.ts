/**
 * FIX achado P2-1 (Tools+PWA): retry de output vazio perde a identidade após reload.
 *
 * `sendAgentMessage` apagava a âncora (`clearPendingChatSend`) ANTES de o
 * chamador classificar a resposta como falha — um 200 sem `output` e sem
 * decisão estruturada limpava `ted.pending-send.*`, então o retry só
 * funcionava enquanto os refs em memória sobreviviam. Após reload/remount, o
 * `messageId` (identidade §7.7) estava perdido.
 *
 * Contrato: a âncora só é limpa em sucesso real (output não-vazio OU
 * pendingOperation OU undoProposal válidos). Resposta vazia preserva a
 * âncora para retry com a MESMA identidade — inclusive após reload
 * (sessionStorage).
 *
 * Estes testes usam o cliente REAL (só rede/token dublados) — nunca mockam
 * `sendAgentMessage` por inteiro, para exercitar o fluxo da âncora.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendAgentMessage,
  composeChatSend,
  loadPendingChatSend,
} from "../agent-client";
import * as agentAuth from "../agent-auth";

vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
  sessionStorage.clear();
});

const emptyTurnResponse = () =>
  new Response(JSON.stringify({ turnId: "t-empty", status: "completed" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const okTurnResponse = (output = "Seu saldo é R$ 100,00.") =>
  new Response(JSON.stringify({ turnId: "t-ok", status: "completed", output }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("P2-1: resposta vazia preserva a âncora de retry (identidade §7.7)", () => {
  it("RED: 200 sem output mantém a âncora com o MESMO messageId", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => emptyTurnResponse());

    const send = composeChatSend("qual meu saldo?");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });

    // A resposta vazia chega ao chamador (que a classifica como falha retentável)…
    expect(turn.output).toBeUndefined();
    // …MAS a âncora sobrevive com a mesma identidade — o retry reusa o messageId.
    const anchor = loadPendingChatSend("ws-1");
    expect(anchor?.messageId).toBe(send.messageId);
    expect(anchor?.content).toBe(send.content);
  });

  it("RED: reload/remount após resposta vazia preserva o messageId para o retry", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit)?.body)));
      // 1º envio: 200 vazio (falha retentável). Retry: sucesso real.
      return bodies.length === 1 ? emptyTurnResponse() : okTurnResponse();
    });

    const send = composeChatSend("qual meu saldo?");
    await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });

    // Simula reload: estado de módulo zerado, storage persiste.
    const reloaded = loadPendingChatSend("ws-1");
    expect(reloaded?.messageId).toBe(send.messageId);

    // O retry pós-reload reusa a MESMA identidade (nunca gera outra).
    const retry = await sendAgentMessage("ws-1", reloaded!.content, {
      messageId: reloaded!.messageId,
    });
    expect(retry.output).toBeTruthy();
    const first = bodies[0] as { intentionId?: string };
    const second = bodies[1] as { intentionId?: string };
    expect(first.intentionId).toBe(send.messageId);
    expect(second.intentionId).toBe(send.messageId);
  });

  it("sucesso real (output não-vazio) continua limpando a âncora", async () => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => okTurnResponse());

    const send = composeChatSend("qual meu saldo?");
    await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(loadPendingChatSend("ws-1")).toBeNull();
  });
});
