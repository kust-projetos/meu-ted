/**
 * FIX-melhorias item 3 — RED→GREEN da regra pura `isTurnAnswerConvergedByIdentity`.
 *
 * A resposta do turno convergiu quando o lote autoritativo já traz a resposta
 * DESTE turno (item do assistente com o mesmo texto E o intentionId do
 * envio). Sem identidade em jogo, nunca converge (a contagem legada por
 * texto decide). Estes testes FALHAM sem a função e PASSAM com ela.
 */
import { describe, expect, it } from "vitest";
import { isTurnAnswerConvergedByIdentity, type AgentMessage } from "../agent-client";

const asst = (content: string, intentionId?: string): AgentMessage =>
  ({
    id: `srv-${content}-${intentionId ?? "none"}`,
    actorId: "ted",
    role: "assistant",
    content,
    isOwn: false,
    ...(intentionId ? { intentionId } : {}),
  }) as AgentMessage;

const own = (content: string, intentionId?: string): AgentMessage =>
  ({
    id: `own-${content}`,
    actorId: "u1",
    role: "user",
    content,
    isOwn: true,
    ...(intentionId ? { intentionId } : {}),
  }) as AgentMessage;

describe("isTurnAnswerConvergedByIdentity", () => {
  it("mesmo texto + intentionId do envio = convergiu (suprime a cópia local)", () => {
    expect(
      isTurnAnswerConvergedByIdentity("Registrei isso aqui.", "msg-2", [
        own("e as metas?", "msg-2"),
        asst("Registrei isso aqui.", "msg-2"),
      ]),
    ).toBe(true);
  });

  it("mesmo texto com intentionId de OUTRO turno não converge (resposta alheia nunca suprime)", () => {
    expect(isTurnAnswerConvergedByIdentity("Registrei isso aqui.", "msg-2", [asst("Registrei isso aqui.", "msg-1")])).toBe(
      false,
    );
  });

  it("item próprio com a identidade nunca confirma a resposta (só o assistente)", () => {
    expect(isTurnAnswerConvergedByIdentity("mercado", "msg-2", [own("mercado", "msg-2")])).toBe(false);
  });

  it("item legado sem intentionId não converge (regra legada por texto decide)", () => {
    expect(isTurnAnswerConvergedByIdentity("Olá!", "msg-2", [asst("Olá!")])).toBe(false);
  });

  it("sem identidade do turno (read sem intentionId) nunca converge por identidade", () => {
    expect(isTurnAnswerConvergedByIdentity("Olá!", undefined, [asst("Olá!", "msg-1")])).toBe(false);
  });

  it("output vazio ou histórico vazio nunca converge", () => {
    expect(isTurnAnswerConvergedByIdentity("", "msg-2", [asst("", "msg-2")])).toBe(false);
    expect(isTurnAnswerConvergedByIdentity(undefined, "msg-2", [asst("x", "msg-2")])).toBe(false);
    expect(isTurnAnswerConvergedByIdentity("x", "msg-2", [])).toBe(false);
  });

  it("texto diferente com a mesma identidade não converge", () => {
    expect(isTurnAnswerConvergedByIdentity("outra resposta", "msg-2", [asst("Registrei isso aqui.", "msg-2")])).toBe(
      false,
    );
  });
});
