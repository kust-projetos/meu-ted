/**
 * "desfaz" cancela (decisão do operador): o imperativo/indicativo de desfazer
 * comporta-se como "cancela" nos dois matchers de cancelamento do fluxo de
 * mutação — `resolveConfirmation` (turno de confirmação) e `isCancelText`
 * (rascunho forçado). Escopo deliberado: o vocabulário de cancel do
 * forget two-step (`isForgetCancellationText`) NÃO muda — "desfaz" ali é
 * ambíguo com undo e o two-step permanece conservador.
 *
 * Isolamento F1 preservado: ambos os matchers operam sobre texto já
 * roteado como decisão (decisionText); conteúdo de anexo nunca decide.
 */
import { describe, expect, it } from "vitest";
import { resolveConfirmation } from "../../src/mutations/confirmation-resolver.js";
import { isCancelText } from "../../src/mutations/mutation-draft.js";

describe("desfaz cancela (mutação)", () => {
  it('isCancelText: "desfaz essa operação" cancela', () => {
    expect(isCancelText("desfaz essa operação")).toBe(true);
  });

  it('isCancelText: "desfaça o último lançamento" cancela', () => {
    expect(isCancelText("desfaça o último lançamento")).toBe(true);
  });

  it('isCancelText: "desfazer a proposta" cancela', () => {
    expect(isCancelText("por favor, desfazer a proposta")).toBe(true);
  });

  it("isCancelText: texto sem keyword continua não-cancelando", () => {
    expect(isCancelText("não há nada a fazer")).toBe(false);
    expect(isCancelText("quero registrar um gasto")).toBe(false);
  });

  it('resolveConfirmation: "desfaz" cancela operação pendente', () => {
    expect(resolveConfirmation("desfaz", ["op-1"])).toMatchObject({ kind: "cancel" });
  });

  it('resolveConfirmation: "desfaz tudo" cancela', () => {
    expect(resolveConfirmation("desfaz tudo", ["op-1"])).toMatchObject({ kind: "cancel" });
  });

  it("resolveConfirmation: 'sim' continua confirmando; 'não ...' continua cancelando", () => {
    expect(resolveConfirmation("sim", ["op-1"]).kind).toBe("confirm");
    expect(resolveConfirmation("não desfaz", ["op-1"]).kind).toBe("cancel");
  });
});
