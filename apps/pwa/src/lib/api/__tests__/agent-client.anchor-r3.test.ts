/**
 * TASK_ID=CODER-PWA-R3-FIX — RED→GREEN para os 3 findings do review R2 (PWA).
 *
 * FIX 1 (HIGH): updater de reconciliação impuro + retry sem draft fiel.
 *   `resolveRetrySend` decide o retry fora do updater: com draft, reusa;
 *   sem draft e com anexos (no snapshot ou no balão), RECUSA (null);
 *   sem draft e texto puro, recompõe o mesmo messageId.
 * FIX 2 (MEDIUM): âncora só-anexo (content="") nunca reconcilia com texto
 *   arbitrário — só com mensagem própria posterior que carrega evidência de
 *   anexo (placeholder `[anexo …]`, portador de extração real ou attachments
 *   no item), com timestamp posterior. Sem ordem confiável: fail-closed.
 * FIX 3 (MEDIUM): âncora com mais anexos que o limite do servidor (10, o
 *   mesmo 413 do Agent) nunca trunca — persiste marcada `overLimit` (sem
 *   retry). Limite alinhado ao servidor, não teto inventado.
 *
 * Estes testes FALHAM antes dos fixes e PASSAM depois.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  composeChatSend,
  isAnchorSupersededByHistory,
  loadPendingChatSend,
  resolveRetrySend,
  savePendingChatSend,
  type OutgoingAttachment,
} from "../agent-client";

afterEach(() => {
  sessionStorage.clear();
});

const att = (name: string, ref = "att_0123456789abcdef"): OutgoingAttachment => ({
  type: "image",
  url: "",
  name,
  ref,
});

const manyAtts = (n: number): OutgoingAttachment[] =>
  Array.from({ length: n }, (_, i) => att(`foto-${i}.jpg`, `att_ref${String(i).padStart(12, "0")}`));

describe("R3 FIX 2 — âncora só-anexo só reconcilia com evidência de anexo", () => {
  const anchor = {
    messageId: "msg-attach-only",
    content: "",
    createdAt: "2026-10-13T10:00:00.000Z",
    attachments: [att("nota.jpg")],
  };

  it("placeholder real do servidor ([anexo …]) posterior supera a âncora", () => {
    expect(
      isAnchorSupersededByHistory(anchor, [
        { isOwn: true, content: "[anexo nota.jpg]", createdAt: "2026-10-13T10:01:00.000Z" },
      ]),
    ).toBe(true);
  });

  it("extração real (portador de visão) posterior supera a âncora", () => {
    expect(
      isAnchorSupersededByHistory(anchor, [
        {
          isOwn: true,
          content:
            "[dados extraídos do anexo de imagem (visão): conteúdo do usuário, para revisão manual]\nvalor 42.50",
          createdAt: "2026-10-13T10:02:00.000Z",
        },
      ]),
    ).toBe(true);
  });

  it("texto arbitrário posterior NUNCA supera âncora com anexos", () => {
    expect(
      isAnchorSupersededByHistory(anchor, [
        { isOwn: true, content: "claro, posso ajudar", createdAt: "2026-10-13T10:05:00.000Z" },
      ]),
    ).toBe(false);
  });

  it("placeholder ANTERIOR ao envio não supera (ordem importa)", () => {
    expect(
      isAnchorSupersededByHistory(anchor, [
        { isOwn: true, content: "[anexo nota.jpg]", createdAt: "2026-10-13T09:59:00.000Z" },
      ]),
    ).toBe(false);
  });

  it("texto idêntico posterior sem evidência de anexo não supera âncora com anexos", () => {
    const textAnchor = {
      messageId: "msg-text-att",
      content: "Segue o comprovante",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [att("nota.jpg")],
    };
    expect(
      isAnchorSupersededByHistory(textAnchor, [
        { isOwn: true, content: "Segue o comprovante", createdAt: "2026-10-13T10:05:00.000Z" },
      ]),
    ).toBe(false);
  });

  it("FIX-169-170-R3: evidência de anexo com intentionId DIFERENTE não supera (outro envio)", () => {
    const anchorSendA = {
      messageId: "send-A",
      intentionId: "send-A",
      content: "",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [att("nota.jpg")],
    };
    expect(
      isAnchorSupersededByHistory(anchorSendA, [
        { isOwn: true, content: "[anexo nota.jpg]", createdAt: "2026-10-13T10:05:00.000Z", intentionId: "send-B" },
      ]),
    ).toBe(false);
  });

  it("FIX-169-170-R3: evidência de anexo com a MESMA identidade supera (controle positivo)", () => {
    const anchorSendA = {
      messageId: "send-A",
      intentionId: "send-A",
      content: "",
      createdAt: "2026-10-13T10:00:00.000Z",
      attachments: [att("nota.jpg")],
    };
    expect(
      isAnchorSupersededByHistory(anchorSendA, [
        { isOwn: true, content: "[anexo nota.jpg]", createdAt: "2026-10-13T10:05:00.000Z", intentionId: "send-A" },
      ]),
    ).toBe(true);
  });

  it("sem timestamps confiáveis: fail-closed (mantém o failed, nunca suprime)", () => {
    expect(
      isAnchorSupersededByHistory(
        { ...anchor, createdAt: "not-a-date" },
        [{ isOwn: true, content: "[anexo nota.jpg]", createdAt: "2026-10-13T10:05:00.000Z" }],
      ),
    ).toBe(false);
  });

  it("âncora de texto puro mantém a regra antiga (idêntico posterior suprime)", () => {
    expect(
      isAnchorSupersededByHistory(
        { content: "Bom dia", createdAt: "2026-10-13T10:00:00.000Z" },
        [{ isOwn: true, content: "Bom dia", createdAt: "2026-10-13T10:05:00.000Z" }],
      ),
    ).toBe(true);
    expect(
      isAnchorSupersededByHistory(
        { content: "Bom dia", createdAt: "2026-10-13T10:00:00.000Z" },
        [{ isOwn: true, content: "outra coisa", createdAt: "2026-10-13T10:05:00.000Z" }],
      ),
    ).toBe(false);
  });
});

describe("R4 FIX — marcador de anexo vale só como prefixo estrutural", () => {
  const anchor = {
    messageId: "msg-attach-only",
    content: "",
    createdAt: "2026-10-13T10:00:00.000Z",
    attachments: [att("nota.jpg")],
  };

  it("citação do marcador no meio do texto NÃO supera (fail-closed, mantém retry)", () => {
    expect(
      isAnchorSupersededByHistory(anchor, [
        {
          isOwn: true,
          content: "O que significa [anexo nota.jpg]?",
          createdAt: "2026-10-13T10:05:00.000Z",
        },
      ]),
    ).toBe(false);
  });

  it("mensagem que ABRE com o marcador + timestamp posterior SUPERA", () => {
    expect(
      isAnchorSupersededByHistory(anchor, [
        {
          isOwn: true,
          content: "[anexo nota.jpg] resumo do comprovante",
          createdAt: "2026-10-13T10:05:00.000Z",
        },
      ]),
    ).toBe(true);
  });
});

describe("R3 FIX 3 — âncora acima do limite nunca trunca (overLimit, sem retry)", () => {
  it("11 anexos persistem marcados overLimit (limite do servidor = 10)", () => {
    const send = composeChatSend("", { attachments: manyAtts(11) });
    savePendingChatSend("ws-1", send);
    const restored = loadPendingChatSend("ws-1");
    expect(restored?.messageId).toBe(send.messageId);
    expect(restored?.overLimit).toBe(true);
  });

  it("10 anexos fazem round-trip fiel (limite exato ainda é válido)", () => {
    const send = composeChatSend("dez fotos", { attachments: manyAtts(10) });
    savePendingChatSend("ws-1", send);
    const restored = loadPendingChatSend("ws-1");
    expect(restored?.overLimit).not.toBe(true);
    expect(restored?.attachments).toHaveLength(10);
    expect(restored?.attachments?.[0]).toMatchObject({ type: "image", name: "foto-0.jpg" });
  });
});

describe("R3 FIX 1 — retry sem draft fiel é recusado", () => {
  it("com draft armazenado: reusa o draft (mesma identidade, mesmos anexos)", () => {
    const stored = composeChatSend("Segue o comprovante", { attachments: [att("nota.jpg")] });
    const resolved = resolveRetrySend({
      messageId: stored.messageId,
      failed: { content: "Segue o comprovante" },
      stored,
    });
    expect(resolved).toBe(stored);
  });

  it("sem draft + snapshot com anexos: RECUSA (null) — reenviar mudaria o payload", () => {
    expect(
      resolveRetrySend({
        messageId: "msg-x",
        failed: { content: "Segue o comprovante" },
        snapshotAttachments: [att("nota.jpg")],
      }),
    ).toBeNull();
  });

  it("sem draft + balão com anexos locais: RECUSA (null)", () => {
    expect(
      resolveRetrySend({
        messageId: "msg-x",
        failed: {
          content: "olha a foto",
          attachments: [{ type: "image", url: "blob:http://x/1", name: "foto.png" }],
        },
      }),
    ).toBeNull();
  });

  it("sem draft + texto puro: recompõe o mesmo messageId e conteúdo", () => {
    const resolved = resolveRetrySend({
      messageId: "msg-text",
      failed: { content: "Bom dia" },
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.messageId).toBe("msg-text");
    expect(resolved?.content).toBe("Bom dia");
    expect(resolved?.attachments ?? []).toHaveLength(0);
  });
});
