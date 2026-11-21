import { describe, expect, it } from "vitest";
import {
  CANONICAL_REDIRECTS,
  routeAlertas,
  routeCompromissos,
  routePatrimonio,
  routePlanejamento,
} from "../routes";

describe("canonical IA routes (item 13)", () => {
  it("builds tab routes with default abas", () => {
    expect(routeCompromissos()).toBe("/compromissos?aba=a-pagar");
    expect(routePatrimonio()).toBe("/hub/patrimonio?aba=contas");
    expect(routePlanejamento()).toBe("/hub/planejamento?aba=orcamentos");
    expect(routeAlertas()).toBe("/hub/alertas?aba=financeiras");
  });

  it("preserves detail params on patrimonio deep links", () => {
    expect(routePatrimonio("contas", { accountId: "acc1" })).toBe(
      "/hub/patrimonio?aba=contas&accountId=acc1",
    );
    expect(routePatrimonio("cartoes", { cardId: "card9" })).toBe(
      "/hub/patrimonio?aba=cartoes&cardId=card9",
    );
  });

  it("redirects every absorbed page route to its canonical tab", () => {
    const bySource = new Map(CANONICAL_REDIRECTS.map((r) => [r.source, r.destination]));
    expect(bySource.get("/a-pagar")).toBe("/compromissos?aba=a-pagar");
    expect(bySource.get("/pending")).toBe("/compromissos?aba=a-pagar");
    expect(bySource.get("/contas")).toBe("/hub/patrimonio?aba=contas");
    expect(bySource.get("/cartoes")).toBe("/hub/patrimonio?aba=cartoes");
    expect(bySource.get("/patrimonio")).toBe("/hub/patrimonio?aba=patrimonio");
    expect(bySource.get("/orcamentos")).toBe("/hub/planejamento?aba=orcamentos");
    expect(bySource.get("/metas")).toBe("/hub/planejamento?aba=metas");
    expect(bySource.get("/assinaturas")).toBe("/hub/planejamento?aba=assinaturas");
    expect(bySource.get("/relatorios")).toBe("/hub/relatorios");
    expect(bySource.get("/alerts")).toBe("/hub/alertas?aba=financeiras");
    expect(bySource.get("/alerts/price")).toBe("/hub/alertas?aba=preco");
    expect(bySource.get("/categorias")).toBe("/hub/categorias");
  });

  it("never redirects API routes or kept real pages", () => {
    const sources = CANONICAL_REDIRECTS.map((r) => r.source);
    for (const kept of ["/pendentes", "/pwa-control", "/perfil", "/workspaces", "/audit", "/convite", "/capture", "/registros", "/"]) {
      expect(sources).not.toContain(kept);
    }
  });
});
