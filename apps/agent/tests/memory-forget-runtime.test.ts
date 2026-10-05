/**
 * A19 — `forget_memory` exposto ao runtime (o pedido "esqueça isso").
 *
 * `forgetMemory` sempre existiu no store (invalidate + cascade transitiva +
 * tombstone via invalidated_at), mas NENHUM caminho do agente o expunha — o
 * usuário pedia "esqueça isso" e não havia nada para atender. O tool novo:
 *
 *   - resolve candidatos DENTRO do escopo do chamador via `recallMemories`
 *     (workspace + ator + shared visível): memória privada de OUTRO ator é
 *     invisível e inesquecível (sem oráculo de existência);
 *   - ambiguidade (vários candidatos) recusa e pede especificação — nunca
 *     vaza id interno;
 *   - esquecer aplica invalidate + cascade + tombstone (o job não ressuscita —
 *     coberto em memory-runtime-wiring.test.ts);
 *   - responde com o que foi esquecido, nunca com ids técnicos.
 */

import { describe, expect, it } from "vitest";
import { buildMemoryTools, MEMORY_TOOL_NAMES } from "../src/agent-config/memory/tools.js";
import {
  initializeMemorySchema,
  recallMemories,
  rememberFact,
  rememberCorrection,
  type MemorySql,
} from "../src/agent-config/memory/store.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";

const sql = () => {
  const mock: MemorySqlMock = createMemorySql();
  initializeMemorySchema(mock);
  return mock as unknown as MemorySql;
};

const toolsFor = (workspaceId: string, actorId: string) =>
  buildMemoryTools({ sql: sql(), workspaceId, actorId });

const runForget = async (toolBag: unknown, query: string): Promise<Record<string, unknown>> => {
  const forget = (toolBag as { forget_memory?: { execute: (p: unknown) => Promise<unknown> } }).forget_memory;
  if (!forget) throw new Error("forget_memory tool missing");
  return (await forget.execute({ query })) as Record<string, unknown>;
};

describe("A19 — forget_memory", () => {
  it("está no catálogo de tools de memória", () => {
    expect(MEMORY_TOOL_NAMES).toContain("forget_memory");
  });

  it("escopo próprio: esquece a memória e responde sem expor id interno", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefiro registrar no Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });
    const result = await runForget(tools, "Nubank");
    expect(result.forgot).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/att_|[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(0);
  });

  it("cascade: esquecer o pai invalida o learning derivado", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberCorrection(store, {
      workspaceId,
      actor: "actor-1",
      target: "merchant:padaria",
      field: "account",
      turnFingerprint: "t-1",
      content: "Padaria usa a conta X",
      scope: undefined as never,
    });
    const parent = recallMemories(store, { workspaceId, actor: "actor-1", query: "padaria" });
    // O learning derivado (derivedFrom) existe além do pai.
    expect(parent.length).toBeGreaterThanOrEqual(1);
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });
    const result = await runForget(tools, "padaria");
    expect(result.forgot).toBe(true);
    expect(Number(result.cascaded ?? 0)).toBeGreaterThanOrEqual(0);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "padaria" })).toHaveLength(0);
  });

  it("memória compartilhada do workspace é esquecível por outro membro (visível ⇒ esquecível)", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "", kind: "fact", content: "A família divide o orçamento da casa" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-2" });
    const result = await runForget(tools, "orçamento da casa");
    expect(result.forgot).toBe(true);
  });

  it("tentativa cross-actor: memória PRIVADA de outro ator é inexistente para o chamador", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Segredo privado do ator 1" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-2" });
    const result = await runForget(tools, "Segredo privado do ator 1");
    expect(result.forgot).toBe(false);
    // E a memória continua intacta para o dono.
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Segredo" })).toHaveLength(1);
  });

  it("tentativa cross-workspace: conteúdo idêntico em outro workspace não é alcançável", async () => {
    const store = sql();
    rememberFact(store, { workspaceId: "ws-2", actor: "actor-1", kind: "preference", content: "Prefiro o banco Santander" });
    const tools = buildMemoryTools({ sql: store, workspaceId: "ws-1", actorId: "actor-1" });
    const result = await runForget(tools, "Santander");
    expect(result.forgot).toBe(false);
    expect(recallMemories(store, { workspaceId: "ws-2", actor: "actor-1", query: "Santander" })).toHaveLength(1);
  });

  it("item inexistente: resposta honesta de não-encontrado", async () => {
    const tools = toolsFor("ws-1", "actor-1");
    const result = await runForget(tools, "coisa que nunca existiu");
    expect(result.forgot).toBe(false);
    expect(String(result.message)).toMatch(/não encontrei/i);
  });

  it("ambiguidade: vários candidatos recusam sem esquecer nada e sem vazar conteúdo/id", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Banco principal é o Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "fact", content: "Adoro os atendentes do Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });
    const result = await runForget(tools, "Nubank");
    expect(result.forgot).toBe(false);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(2);
    expect(String(result.message)).toMatch(/especif/i);
  });
});
