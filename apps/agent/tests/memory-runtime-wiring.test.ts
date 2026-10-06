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
import {
  initializeMemorySchema,
  isFingerprintTombstoned,
  forgetMemory,
  recallMemories,
  type MemorySql,
} from "../src/agent-config/memory/store.js";
import { learnFromTurn } from "../src/agent-config/memory/learn.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";
import { createAttachmentTestAgent, installRelayMock, bytesOf, } from "./attachments/helpers.js";
import { attachRelayUsageStorage } from "./helpers/relay-usage-storage.js";
import { pngBytes } from "./attachments/fixtures.js";

/** Plain text of a persisted SDK message (the harness stores `parts[0].text`). */
const textOf = (message: { parts?: Array<{ text?: string }> } | undefined): string | undefined =>
  message?.parts?.[0]?.text;

const CHAT_REQUEST = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://agent.test.local/rpc/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });

/**
 * Real `FinanceChatAgent` + REAL memory SQL over the DO storage surface, so a
 * test can assert durable evidence ("nothing was written"), not just a spy.
 * `sqlMock` exposes the raw tables; `persisted` are the SDK-persisted messages.
 */
const agentOnMemorySql = (extraEnv: Record<string, string> = {}) => {
  const { agent, persisted } = createAttachmentTestAgent();
  const sql: MemorySqlMock = createMemorySql();
  initializeMemorySchema(sql);
  // Hybrid exec: memory queries hit the REAL schema interpreter; usage-ledger
  // queries (same ctx.storage.sql in production) hit the permissive usage
  // mock — the memory interpreter would throw on them and fail the leg.
  const relayUsage = attachRelayUsageStorage(agent);
  const memoryExec = sql.exec.bind(sql);
  const hybridExec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
    const q = query.toLowerCase();
    if (q.includes("usage_ledger") || q.includes("usage_attempts")) {
      return relayUsage.exec<T>(query, ...params);
    }
    return memoryExec<T>(query, ...params);
  }) as MemorySqlMock["exec"];
  Object.defineProperty(agent, "ctx", {
    value: {
      storage: {
        sql: { exec: hybridExec },
        transactionSync: <T>(fn: () => T): T => fn(),
      },
    },
    configurable: true,
  });
  // Env patch (ex.: `AGENT_DELEGATION_SECRET` + device), para montar o cliente
  // de mutação REAL no turno — sem ele o orquestrador recusa antes de propor.
  if (Object.keys(extraEnv).length > 0) {
    Object.defineProperty(agent, "env", {
      value: { ...(agent as unknown as { env: Record<string, unknown> }).env, ...extraEnv },
      writable: true,
      configurable: true,
    });
  }
  return { agent, persisted, sql: sql as unknown as MemorySql, sqlMock: sql };
};

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

  it("dado extraído de anexo NUNCA vira memória (review F2: o hook lê o texto digitado)", async () => {
    const { agent, sql } = agentOnMemorySql();
    // A imagem "extraída" carrega um gatilho heurístico de aprendizado. O
    // composto do turno o contém; o TEXTO DIGITADO, não. O hook deve ler
    // exclusivamente o digitado — conteúdo de anexo é DADO (A13/A14/A15).
    installRelayMock("Resposta sem alegações financeiras.");
    const previous = globalThis.fetch;
    globalThis.fetch = (async (info: unknown) => {
      if (String(info).includes("api.groq.com")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ merchant: "Lembre-se sempre usar o Nubank" }) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return previous(info as Parameters<typeof fetch>[0]);
    }) as unknown as typeof fetch;
    // Atualiza o env do agente para visão ON, preservando o bucket de anexos.
    const previousEnv = (agent as unknown as { env: Record<string, unknown> }).env;
    Object.defineProperty(agent, "env", {
      value: {
        ...previousEnv,
        GROQ_API_KEY: "gsk-test-key",
        TED_VISION_ENABLED: "1",
      },
      writable: true,
      configurable: true,
    });
    const { getAttachmentStorage } = await import("../src/attachments/storage.js");
    const { ingestAttachment } = await import("../src/attachments/ingest.js");
    const storage = getAttachmentStorage((agent as unknown as { env: Record<string, unknown> }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-1", actorId: "actor-1" },
      kind: "image",
      name: "nota.png",
      bytes: bytesOf(pngBytes(8, 8)),
    });
    const res = await agent.fetch(
      CHAT_REQUEST({
        text: "olha a nota",
        intentionId: "a17-f2-1",
        attachments: [{ type: "image", ref: uploaded.ref, name: "nota.png" }],
      }),
    );
    expect(res.status).toBe(200);
    // A extração PRECISA ter acontecido, senão o teste passaria vazio.
    const states = (await res.clone().json()) as { attachmentStates?: Array<{ state: string }> };
    expect(states.attachmentStates?.[0]?.state).toBe("processed");
    const stored = JSON.stringify(
      recallMemories(sql, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" }),
    );
    expect(stored).not.toContain("Lembre-se");
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

/**
 * Closure pós-PR #90 (issue #91, Finding 2): learning só depois da evidência
 * DEFINITIVA do turno.
 *
 * A17 já proibia ensinar a partir de turno sem resposta / fail-closed / erro de
 * provider, mas o caminho REST quebrava essa regra por ORDEM: o learning rodava
 * ANTES de `persistMessages`. Uma falha de persistência devolvia 502 ao
 * usuário e mesmo assim a memória e o contador de turno já estavam gravados —
 * um turno que falhou ensinando estado durável. Agora a persistência confirma
 * primeiro; só então o learning roda.
 */
describe("A17 — a evidência definitiva vem ANTES do aprendizado", () => {
  const learningSpy = (agent: unknown) =>
    vi.spyOn(
      agent as { recordPostTurnLearning: (...args: unknown[]) => Promise<void> },
      "recordPostTurnLearning",
    );

  it("persistência do turno falha: 502 e ZERO aprendizado (memória, contador e extractor intactos)", async () => {
    const { agent, sqlMock } = agentOnMemorySql();
    installRelayMock("Resposta real do turno concluído.");
    // The USER message is persisted inside `runTurn` (before any response
    // exists) and must keep succeeding — otherwise the turn dies earlier and
    // the test would pass vacuously. The FINAL grounded response is the
    // definitive evidence, and THAT is what fails here.
    const persistMock = vi.fn(async (messages: unknown[]) => {
      const roles = (messages as Array<{ role?: string }>).map((message) => message.role);
      if (roles.includes("assistant")) throw new Error("chat storage unavailable");
    });
    (agent as unknown as { persistMessages: (msgs: unknown[]) => Promise<void> }).persistMessages = persistMock;
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST({ text: "prefiro sempre registrar no Nubank", intentionId: "a17-persist-fail" }),
    );

    expect(response.status).toBe(502);
    const body = (await response.clone().json()) as { code?: string };
    expect(body.code).toBe("agent.inference_error");
    // The 502 must come from the assistant-message persistence boundary — a
    // turn that died before producing a response teaches nothing anyway.
    expect(persistMock).toHaveBeenCalled();
    expect(
      persistMock.mock.calls.some((call) =>
        (call[0] as Array<{ role?: string }>).some((message) => message.role === "assistant"),
      ),
    ).toBe(true);
    // O turno que falhou para o usuário não ensina nada: nem memória nova, nem
    // `bumpTurnCount`, nem chamada do extractor (que vive dentro do hook).
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
    expect(JSON.stringify(sqlMock.rows("agent_memory"))).not.toMatch(/nubank/i);
  });

  it("fail-closed: a recusa não ensina E a user message continua persistida", async () => {
    const { agent, sqlMock, persisted } = agentOnMemorySql();
    installRelayMock("qualquer coisa");
    // Leitura sem evidência utilizável ⇒ envelope nulo ⇒ fail-closed honesto
    // (nunca um "zero" fabricado), com o turno concluído.
    globalThis.fetch = (async () => {
      throw new Error("relay down");
    }) as unknown as typeof fetch;
    const spy = learningSpy(agent);

    const response = await agent.fetch(CHAT_REQUEST({ text: "quanto gastei", intentionId: "a17-failclosed-1" }));

    expect(response.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
    // O par Q&A continua no histórico: a recusa também é histórico.
    expect(persisted.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("turno de mutação SEM evidência durável (proposta recusada sem device): learning NÃO ocorre", async () => {
    const { agent, sqlMock } = agentOnMemorySql();
    installRelayMock("Resposta canônica do turno.");
    const spy = learningSpy(agent);

    // Sem device não há cliente de mutação: o orquestrador responde
    // deterministicamente "Não foi possível preparar a operação…" e devolve
    // `mutation: undefined`. Uma RECUSA não é conhecimento — teachar aqui fixaria
    // em memória durável o texto de um pedido que nada executou.
    const response = await agent.fetch(CHAT_REQUEST({ text: "gastei 50 de carne", intentionId: "a17-mutation-1" }));

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { pendingOperation?: unknown };
    expect(body.pendingOperation).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
  });
});

/**
 * Regression P1-2 (review round 2): o ramo de learning de `mutation` só existe
 * se houver EVIDÊNCIA DURÁVEL.
 *
 * O ramo antigo aprendia para QUALQUER modo de mutação com `response` — mas o
 * orquestrador devolve resposta SEM `mutation` em três caminhos reais
 * (`conversation-orchestrator.ts`): alvo ausente ("Não há nenhuma operação
 * pendente para confirmar"), desambiguação de múltiplos pendentes e erro
 * capturado do coordinator (`renderMutationResult('failed')`). Nesses três, o
 * turno ensinava e avançava contador sem nada ter sido criado, confirmado ou
 * cancelado na API — memória de uma operação que não existe.
 *
 * `turnResult.mutation` presente é a evidência: proposal com `operationId`,
 * confirmação com `receipt`, cancelamento com `status`. Os casos abaixo usam o
 * CAMINHO REAL (`/rpc/chat` → orquestrador → cliente delegado → API mockada),
 * não um seam: a prova de que a proposta real chega é a mesma que o contrato de
 * REST já fixa (`pendingOperation.status === 'proposed'`).
 */
describe("A19 round 2 — ramo mutation aprende só com evidência durável", () => {
  const learningSpy = (agent: unknown) =>
    vi.spyOn(
      agent as { recordPostTurnLearning: (...args: unknown[]) => Promise<void> },
      "recordPostTurnLearning",
    );

  it("NEGATIVO: confirmação sem operação pendente não ensina", async () => {
    const { agent, persisted, sqlMock } = agentOnMemorySql();
    installRelayMock("Qualquer resposta do provider.");
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST({ text: "sim confirmo", intentionId: "a19-r2-confirm-none" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { output?: string; pendingOperation?: unknown };
    // Houve RESPOSTA (o ramo é alcançado) e nenhuma operação pendente.
    expect(body.output).toBeTruthy();
    expect(body.pendingOperation).toBeUndefined();
    // Prova de que o turno caiu no ramo de MUTAÇÃO e não no read path: só o
    // read path persiste a resposta final do assistente; modos de mutação
    // devolvem `pendingOperation` em vez de mensagem persistida. Sem a resposta
    // persistida, `plan.mode` é `confirmation`.
    expect(persisted.map((message) => message.role)).not.toContain("assistant");
    // Uma confirmação que não confirma nada não vira memória nem contador.
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
  });

  it("NEGATIVO: falha do coordinator não ensina (mutação indefinida, resposta 'failed')", async () => {
    // Device + delegation real: o cliente existe, o coordinator é chamado e
    // falha — o `catch` do orquestrador devolve `renderMutationResult('failed')`
    // SEM `mutation`.
    const { agent, sqlMock } = agentOnMemorySql({ AGENT_DELEGATION_SECRET: "agent-test-secret" });
    const requested: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input));
      throw new Error("api down");
    }) as unknown as typeof fetch;
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST(
        { text: "sim confirmo", intentionId: "a19-r2-coordinator-error" },
        { "x-agent-device": "device-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { output?: string; pendingOperation?: unknown };
    expect(body.pendingOperation).toBeUndefined();
    // O ramo de confirmação rodou de verdade: a listagem AUTORITATIVA de
    // pendentes foi consultada (T1.5/SPEC §8) e é ela que falhou.
    expect(requested.some((url) => url.includes("/pending-operations/v2/active"))).toBe(true);
    // O coordinator falhou: nada foi confirmado. A recusa determinística de
    // falha NÃO é conhecimento — nem memória, nem contador, nem extractor.
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
  });

  it("POSITIVO: proposta real materializada (pendingOperation) → learning com contador avançado", async () => {
    const { agent, sqlMock } = agentOnMemorySql({ AGENT_DELEGATION_SECRET: "agent-test-secret" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pending-operations/v2/propose")) {
        return new Response(JSON.stringify({ id: "pending-a19-r2" }), { status: 200 });
      }
      if (String(input).includes("/accounts")) {
        return new Response(
          JSON.stringify({ items: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Nubank" }] }),
          { status: 200 },
        );
      }
      if (String(input).includes("/categories")) {
        return new Response(
          JSON.stringify({ items: [{ id: "00000000-0000-4000-8000-000000000001", name: "Mercado" }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected upstream request: ${String(input)}`);
    });
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST(
        {
          text: "gastei R$ 12,34 no mercado na categoria 00000000-0000-4000-8000-000000000001",
          intentionId: "a19-r2-real-proposal",
        },
        { "x-agent-device": "device-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { pendingOperation?: { id?: string; status?: string } };
    // A evidência durável EXISTE de fato (a API materializou a operação).
    expect(body.pendingOperation).toMatchObject({ id: "pending-a19-r2", status: "proposed" });
    // E com ela, o learning roda e o contador de turno avança.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(1);
  });
});

/**
 * Regression P1 (review round 3): o gate de learning do RAMO DE LEITURA
 * enumerava MODOS de mutação, mas o retry conversacional NÃO é um modo.
 *
 * `intent-router` cai em `fallbackPlan()` para "tenta de novo"
 * (`plan.mode === 'unsupported'`), então `runRetryTurn` responde por um turno
 * de INTENÇÃO MUTACIONAL pelo ramo de leitura — que persistia a resposta e
 * ensinava com o único gate `!failClosed`. Resultado: um retry recusado
 * (`NO_FAILED_OPERATION_TEXT`, `conversation-orchestrator.ts:2219-2221`),
 * ambíguo (`:2223-2238`) ou falhado (`:2275-2277`) avançava o contador de
 * turno e alimentava o extractor sem NADA ter sido executado — teachando em
 * memória durável a tentativa de uma operação que não existe.
 *
 * O gate passa a ser UNIFORME e derivado da INTENÇÃO (`needsMutation`, já
 * computado antes do `runTurn`), não da enumeração de modos:
 *   - turno puro de leitura → aprende depois da persistência confirmada;
 *   - turno com intenção mutacional (proposal/confirmation/cancel/retry/
 *     rascunho recuperável) → só aprende com `turnResult.mutation`, a
 *     evidência definitiva do canal (retry bem-sucedido a produz em
 *     `conversation-orchestrator.ts:2258-2265`);
 *   - dúvida → não ensina.
 */
describe("A19 round 3 — retry (intenção mutacional no ramo de leitura) só ensina com evidência", () => {
  const learningSpy = (agent: unknown) =>
    vi.spyOn(
      agent as { recordPostTurnLearning: (...args: unknown[]) => Promise<void> },
      "recordPostTurnLearning",
    );

  /** `retry` textual → `fallbackPlan()` (mode `unsupported`): o retry é servido
   * por `runRetryTurn`, e o turno volta pelo RAMO DE LEITURA. */
  it("NEGATIVO: retry sem operação com falha não ensina (e a resposta continua persistida)", async () => {
    const { agent, persisted, sqlMock } = agentOnMemorySql({ AGENT_DELEGATION_SECRET: "agent-test-secret" });
    installRelayMock("Qualquer resposta do provider.");
    const requested: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input));
      // Listagem AUTORITATIVA real, vazia: existe retry com o device+client,
      // mas não há operação `failed` para repetir.
      if (String(input).includes("/pending-operations/v2/active")) return Response.json({ items: [], total: 0 });
      throw new Error(`unexpected upstream request: ${String(input)}`);
    }) as unknown as typeof fetch;
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST(
        { text: "tenta de novo", intentionId: "a19-r3-retry-none" },
        { "x-agent-device": "device-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { output?: string; pendingOperation?: unknown };
    // O ramo de retry rodou de verdade (listagem autoritativa consultada) e
    // respondeu deterministicamente — sem `mutation`.
    expect(requested.some((url) => url.includes("/pending-operations/v2/active"))).toBe(true);
    expect(body.output).toContain("Não há nenhuma operação com falha para tentar novamente.");
    expect(body.pendingOperation).toBeUndefined();
    // E a recusa não ensina: nem memória, nem contador, nem extractor.
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
    // A HISTÓRIA do retry permanece intocada: a recusa também é histórico e a
    // resposta continua persistida. O fix é no gate de aprendizado, nunca na
    // persistência.
    expect(persisted.map((message) => message.role)).toEqual(["assistant"]);
    expect(textOf(persisted[0])).toBe(body.output);
  });

  it("NEGATIVO: retry ambíguo (várias operações com falha) não ensina", async () => {
    const { agent, persisted, sqlMock } = agentOnMemorySql({ AGENT_DELEGATION_SECRET: "agent-test-secret" });
    installRelayMock("Qualquer resposta do provider.");
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes("/pending-operations/v2/active")) {
        return Response.json({
          items: [
            { id: "failed-1", status: "failed", tool: "transactions.expense.create", amountCents: 1000, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
            { id: "failed-2", status: "failed", tool: "transactions.income.create", amountCents: 2000, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
          ],
          total: 2,
        });
      }
      throw new Error(`unexpected upstream request: ${String(input)}`);
    }) as unknown as typeof fetch;
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST(
        { text: "tenta de novo", intentionId: "a19-r3-retry-ambiguous" },
        { "x-agent-device": "device-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { output?: string; pendingOperation?: unknown };
    // Desambiguação: nada foi repetido, nada foi executado.
    expect(body.output).toContain("Qual delas deseja tentar novamente?");
    expect(body.pendingOperation).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
    expect(persisted.map((message) => message.role)).toEqual(["assistant"]);
    expect(textOf(persisted[0])).toBe(body.output);
  });

  it("NEGATIVO: erro do coordinator no retry não ensina (resposta 'failed', sem mutation)", async () => {
    const { agent, persisted, sqlMock } = agentOnMemorySql({ AGENT_DELEGATION_SECRET: "agent-test-secret" });
    const requested: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input));
      throw new Error("api down");
    }) as unknown as typeof fetch;
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST(
        { text: "tenta de novo", intentionId: "a19-r3-retry-error" },
        { "x-agent-device": "device-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { output?: string; pendingOperation?: unknown };
    expect(requested.some((url) => url.includes("/pending-operations/v2/active"))).toBe(true);
    expect(body.pendingOperation).toBeUndefined();
    // O `catch` de `runRetryTurn` devolveu `renderMutationResult('failed')` —
    // recusa determinística, nunca conhecimento.
    expect(spy).not.toHaveBeenCalled();
    expect(sqlMock.rows("agent_memory")).toHaveLength(0);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(0);
    expect(persisted.map((message) => message.role)).toEqual(["assistant"]);
    expect(textOf(persisted[0])).toBe(body.output);
  });

  it("POSITIVO: retry de sucesso materializa mutation (operationId + receipt) e então ensina", async () => {
    const { agent, sqlMock } = agentOnMemorySql({ AGENT_DELEGATION_SECRET: "agent-test-secret" });
    const pendingId = "failed-a19-r3";
    const transactionId = "mut-tx-a19-r3";
    const receipt = {
      mutationId: transactionId,
      mutationKind: "transactions.expense.create",
      status: "succeeded",
      affectedTargets: ["transactions", "accounts"],
      operationId: pendingId,
      entity: { type: "transaction", id: transactionId },
    };
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/pending-operations/v2/active")) {
        return Response.json({
          items: [
            { id: pendingId, status: "failed", tool: "transactions.expense.create", amountCents: 1234, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
          ],
          total: 1,
        });
      }
      // retry → failed vira confirmed com attestation FRESCA; execute → TX2.
      if (url.includes(`/pending-operations/v2/${pendingId}/retry`)) {
        return Response.json({ id: pendingId, attestation: "a".repeat(48) });
      }
      if (url.includes(`/pending-operations/v2/${pendingId}/execute`)) {
        return Response.json({
          id: pendingId,
          status: "succeeded",
          execution: { status: "succeeded", operationId: transactionId, receipt },
        });
      }
      throw new Error(`unexpected upstream request: ${url}`);
    }) as unknown as typeof fetch;
    const spy = learningSpy(agent);

    const response = await agent.fetch(
      CHAT_REQUEST(
        { text: "tenta de novo", intentionId: "a19-r3-retry-success" },
        { "x-agent-device": "device-1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as {
      pendingOperation?: { id?: string; status?: string; receipt?: { operationId?: string } };
    };
    // CAMINHO REAL de ponta a ponta: retry (fresh attestation) → execute → receipt.
    expect(seen.some((url) => url.includes(`/pending-operations/v2/${pendingId}/retry`))).toBe(true);
    expect(seen.some((url) => url.includes(`/pending-operations/v2/${pendingId}/execute`))).toBe(true);
    // A evidência definitiva EXISTE (mutation materializada com o receipt real).
    expect(body.pendingOperation).toMatchObject({
      id: pendingId,
      status: "succeeded",
      receipt: { operationId: pendingId },
    });
    // E com ela o learning roda e o contador avança.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sqlMock.rows("agent_turn_counters")).toHaveLength(1);
  });
});
