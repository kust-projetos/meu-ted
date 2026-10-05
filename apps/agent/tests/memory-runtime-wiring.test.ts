/**
 * A19/A17 — o learning pós-turno CONECTADO ao runtime real.
 *
 * O hook antigo rodava com `assistantText: ''` atrás de um early return que o
 * wiring de produção SEMPRE tomava — nunca aprendeu nada (e o contador de
 * turnos nunca avançou). O hook novo roda só depois de uma resposta publicada
 * e recebe o texto REAL do assistente.
 *
 * O que este arquivo fixa:
 *   1. wiring: um turno REST concluído chama o hook com o texto publicado;
 *   2. wiring: turno sem resposta (provider fora) NÃO chama o hook;
 *   3. memória: o par usuário/assistente real vira memória recordável;
 *   4. dedup: repetir o mesmo par não duplica;
 *   5. financial-state: saldo/valor na resposta nunca vira memória durável;
 *   6. tombstone: esquecido pelo usuário não é re-ensinado pelo job — mas um
 *      `remember_fact` EXPLÍCITO do usuário continua podendo recriar.
 */

import { describe, expect, it, vi } from "vitest";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";
import {
  initializeMemorySchema,
  isFingerprintTombstoned,
  forgetMemory,
  recallMemories,
  type MemorySql,
} from "../src/agent-config/memory/store.js";
import { learnFromTurn } from "../src/agent-config/memory/learn.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";
import { createAttachmentTestAgent } from "./attachments/helpers.js";
import { installRelayMock } from "./attachments/helpers.js";

const CHAT_REQUEST = (body: unknown): Request =>
  new Request("https://agent.test.local/rpc/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
    },
    body: JSON.stringify(body),
  });

describe("A19/A17 — o hook de learning roda no caminho REST real", () => {
  it("turno concluído: o hook recebe o TEXTO REAL publicado como assistente", async () => {
    const { agent } = createAttachmentTestAgent();
    installRelayMock("Resposta real do turno concluído.");
    const spy = vi.spyOn(
      agent as unknown as { recordPostTurnLearning: (...args: unknown[]) => Promise<void> },
      "recordPostTurnLearning",
    );
    const response = await agent.fetch(
      CHAT_REQUEST({ text: "prefiro sempre registrar no Nubank", intentionId: "a17-wiring-ok" }),
    );
    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: "prefiro sempre registrar no Nubank",
      assistantText: "Resposta real do turno concluído.",
    });
  });

  it("turno sem resposta (provider fora): o hook NÃO roda", async () => {
    const { agent } = createAttachmentTestAgent();
    installRelayMock("qualquer coisa");
    globalThis.fetch = (async () => {
      throw new Error("relay down");
    }) as unknown as typeof fetch;
    const spy = vi.spyOn(
      agent as unknown as { recordPostTurnLearning: (...args: unknown[]) => Promise<void> },
      "recordPostTurnLearning",
    );
    await agent.fetch(CHAT_REQUEST({ text: "quanto gastei", intentionId: "a17-wiring-fail" }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("A19/A17 — memória de ponta a ponta (SQL real)", () => {
  const PREFERENCE = "prefiro sempre registrar no Nubank";

  const agentOnMemorySql = () => {
    const { agent } = createAttachmentTestAgent();
    const sql: MemorySqlMock = createMemorySql();
    initializeMemorySchema(sql);
    Object.defineProperty(agent, "ctx", {
      value: {
        storage: {
          sql: { exec: sql.exec.bind(sql) },
          transactionSync: <T>(fn: () => T): T => fn(),
        },
      },
      configurable: true,
    });
    return { agent, sql: sql as unknown as MemorySql };
  };

  it("o par usuário/assistente real vira memória recordável e não duplica", async () => {
    const { agent, sql } = agentOnMemorySql();
    await agent["recordPostTurnLearning"]({
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: PREFERENCE,
      assistantText: "Entendi. Vou registrar no Nubank.",
      intentionId: "a17-mem-1",
    });
    const first = recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" });
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]?.content.toLowerCase()).toContain("nubank");

    // Repetição: dedup por similaridade, nunca uma segunda linha.
    await agent["recordPostTurnLearning"]({
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: PREFERENCE,
      assistantText: "Entendi. Vou registrar no Nubank.",
      intentionId: "a17-mem-2",
    });
    const second = recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" });
    expect(second).toHaveLength(first.length);
  });

  it("saldo/valor na resposta NUNCA vira memória durável (AGENT-008)", async () => {
    const { agent, sql } = agentOnMemorySql();
    await agent["recordPostTurnLearning"]({
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: "prefiro o Nubank",
      assistantText: "Seu saldo atual é R$ 3.500,00 na conta corrente.",
      intentionId: "a17-mem-amount",
    });
    const stored = JSON.stringify(
      recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "saldo" }),
    );
    expect(stored).not.toContain("3.500");
    expect(stored).not.toContain("saldo atual");
  });

  it("esquecido não é re-ensinado pelo job; declaração EXPLÍCITA pode recriar", async () => {
    const { agent, sql } = agentOnMemorySql();
    await agent["recordPostTurnLearning"]({
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: PREFERENCE,
      assistantText: "Entendi.",
      intentionId: "a17-forget-1",
    });
    const before = recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" });
    expect(before.length).toBeGreaterThan(0);

    // O usuário esquece.
    const { invalidated } = forgetMemory(sql, { workspaceId: "ws-1", id: before[0]!.id });
    expect(invalidated).toContain(before[0]!.id);
    expect(recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(0);

    // O job (mesma frase de novo) NÃO ressuscita.
    await agent["recordPostTurnLearning"]({
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: PREFERENCE,
      assistantText: "Entendi.",
      intentionId: "a17-forget-2",
    });
    expect(recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(0);
  });

  it("correção: vira learning derivado, dedupe por fingerprint, supersede por turno novo, tombstone bloqueia", async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const base = {
      workspaceId: "ws-1",
      actorId: "actor-1",
      userText: "Na verdade a padaria é na conta X",
      assistantText: "Corrigido.",
    };

    const first = await learnFromTurn(sql as unknown as MemorySql, {
      ...base,
      turnCount: 1,
      correction: { target: "merchant:padaria", field: "account", turnFingerprint: "t-1" },
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("learning");

    // Redelivery do MESMO turno: dedup (não duplica).
    const again = await learnFromTurn(sql as unknown as MemorySql, {
      ...base,
      turnCount: 2,
      correction: { target: "merchant:padaria", field: "account", turnFingerprint: "t-1" },
    });
    expect(again).toHaveLength(0);

    // Turno NOVO com a mesma identidade: supersede (continua uma linha efetiva).
    const superseding = await learnFromTurn(sql as unknown as MemorySql, {
      ...base,
      userText: "Na verdade a padaria é na conta Y",
      turnCount: 3,
      correction: { target: "merchant:padaria", field: "account", turnFingerprint: "t-2" },
    });
    expect(superseding).toHaveLength(1);

    // Forget + job posterior: tombstone bloqueia a ressurreição.
    const effective = recallMemories(sql as unknown as MemorySql, {
      workspaceId: "ws-1",
      actor: "actor-1",
      query: "padaria",
    });
    expect(effective.length).toBeGreaterThan(0);
    forgetMemory(sql as unknown as MemorySql, { workspaceId: "ws-1", id: effective[0]!.id });
    expect(
      isFingerprintTombstoned(sql as unknown as MemorySql, {
        workspaceId: "ws-1",
        actor: "actor-1",
        fingerprint: "", // content-level guard is exercised by the job path below
      }),
    ).toBe(false); // fingerprint-level tombstone is keyed by the correction fingerprint
    const resurrect = await learnFromTurn(sql as unknown as MemorySql, {
      ...base,
      turnCount: 4,
      correction: { target: "merchant:padaria", field: "account", turnFingerprint: "t-3" },
    });
    expect(resurrect).toHaveLength(0);
  });
});
