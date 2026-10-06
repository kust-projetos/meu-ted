/**
 * Issue #99 — closure definitiva do `forget_memory` em duas etapas.
 *
 * RED: estes testes descrevem o comportamento NORMATIVO novo e FALHAM contra
 * a implementação atual (auto-delete lexical no primeiro turno):
 *
 *   - pedido claro ("esqueça Nubank") NÃO apaga no primeiro turno: cria uma
 *     PROPOSTA pendente e mantém a memória viva;
 *   - query vaga/artigo falso ("por gentileza, esqueça uma coisa que eu
 *     falei" × "Prefere uma caminhada pela manhã") NADA apaga;
 *   - termo inexistente, múltiplos candidatos e query vaga continuam fail-closed.
 *
 * A confirmação explícita em turno posterior (`confirm_forget_memory` /
 * `cancel_forget_memory` + intercepção determinística no orquestrador) é
 * coberta em `memory-forget-confirmation.test.ts` (GREEN).
 */

import { describe, expect, it } from "vitest";
import { buildMemoryTools } from "../src/agent-config/memory/tools.js";
import {
  initializeMemorySchema,
  recallMemories,
  rememberFact,
  type MemorySql,
} from "../src/agent-config/memory/store.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";

const sql = () => {
  const mock: MemorySqlMock = createMemorySql();
  initializeMemorySchema(mock);
  return mock as unknown as MemorySql;
};

const runForget = async (toolBag: unknown, query: string): Promise<Record<string, unknown>> => {
  const forget = (toolBag as { forget_memory?: { execute: (p: unknown) => Promise<unknown> } }).forget_memory;
  if (!forget) throw new Error("forget_memory tool missing");
  return (await forget.execute({ query })) as Record<string, unknown>;
};

describe("issue #99 — forget em duas etapas (RED)", () => {
  it("A — pedido claro cria PROPOSTA e mantém a memória viva (nunca delete direto)", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Nubank");

    // Normativo §3/§13: 1 candidato ⇒ pending, NUNCA forgetMemory().
    expect(result.forgot).toBe(false);
    expect(result.proposed).toBe(true);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });

  it("RED §27 — cortesia vaga NÃO apaga a memória errada", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere uma caminhada pela manhã" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "por gentileza, esqueça uma coisa que eu falei");

    expect(result.forgot).toBe(false);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "caminhada" })).toHaveLength(1);
  });

  it("E — falso artigo NÃO apaga", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere uma caminhada pela manhã" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça uma coisa");

    expect(result.forgot).toBe(false);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "caminhada" })).toHaveLength(1);
  });

  it("G — termo inexistente: nada apagado", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Inter");

    expect(result.forgot).toBe(false);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });

  it("F — múltiplos candidatos: ambiguidade, nada apagado", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere pagar contas pelo Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere cartão Nubank para compras" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Nubank");

    expect(result.forgot).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(2);
  });

  it("D — query vaga sem alvo: nada apagado, sem proposta arbitrária", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere categoria Alimentação" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça uma coisa que eu falei");

    expect(result.forgot).toBe(false);
    expect(result.proposed).not.toBe(true);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Alimentação" })).toHaveLength(1);
  });
});
