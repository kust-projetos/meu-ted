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
  listForgetCandidates,
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

/**
 * Closure pós-PR #90 (issue #91, Finding 1): o RANKING do recall passa a gerar
 * candidatos, não a decidir o que é apagado.
 *
 * `recallMemories` pontua por salience × recência + overlap, SEM exigir overlap
 * > 0 — ele devolve o que for o melhor disponível, relacionado ou não. Como
 * alvo único, isso produzia duas falhas: memória ÚNICA e IRRELEVANTE apagada por
 * ser top-1, e ambiguidade falsa com memória obviamente correspondente na lista.
 * O gate determinístico abaixo (cobertura dos tokens do ASSUNTO sobre os
 * stopwords do imperativo) decide a relevância; o ranking só ordena.
 */
describe("A19 — forget_memory só apaga alvo CLARAMENTE correspondente", () => {
  it("relevância vence a contagem: só a memória sobre Nubank é esquecida, sem falsa ambiguidade", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere categoria Alimentação" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Nubank");

    expect(result.forgot).toBe(true);
    expect(result.ambiguous).toBeUndefined();
    // A irrelevante continua de pé: só o alvo foi derrubado. (O recall NÃO
    // exige overlap — por isso a verificação é sobre o conjunto efetivo.)
    const survivors = recallMemories(store, { workspaceId, actor: "actor-1", query: "Prefere" });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.content).toContain("Alimentação");
    expect(survivors[0]?.invalidatedAt).toBeNull();
  });

  it("memória única e IRRELEVANTE não é apagada por ser top-1 (o caso perigoso)", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere categoria Alimentação" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Nubank");

    expect(result.forgot).toBe(false);
    expect(String(result.message)).toBe("Não encontrei uma memória claramente correspondente.");
    // A memória não mencionada pelo pedido segue INTACTA.
    const intact = recallMemories(store, { workspaceId, actor: "actor-1", query: "Alimentação" });
    expect(intact).toHaveLength(1);
    expect(intact[0]?.invalidatedAt).toBeNull();
  });

  it("2+ realmente correspondentes: ambiguidade honesta e NADA apagado (guard de regressão)", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere pagar contas pelo Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere cartão Nubank para compras" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Nubank");

    expect(result.forgot).toBe(false);
    expect(result.ambiguous).toBe(true);
    // A contagem é a dos RELEVANTES, não a dos candidatos do ranking.
    expect(String(result.message)).toContain("2");
    expect(String(result.message)).toMatch(/especif/i);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/att_|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("a memória RELEVANTE de outro ator não é esquecida nem REPORTADA (sem oráculo de existência)", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-2" });

    const result = await runForget(tools, "esqueça Nubank");

    expect(result.forgot).toBe(false);
    expect(result.ambiguous).toBeUndefined();
    // A resposta é a mesma de "não existe": nunca insinua que existe em outro ator.
    expect(String(result.message)).toBe("Não encontrei uma memória claramente correspondente.");
    expect(JSON.stringify(result)).not.toMatch(/nubank/i);
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });

  /**
   * Regression P1-1 (review round 2): o RANKING TRUNCA, o filtro não pode
   * herdar esse corte.
   *
   * `recallMemories(limit: 5)` ordena por score e devolve só o top-5. Duas
   * memórias RELEVANTES com salience 1.0 e 0.1, contra quatro irrelevantes com
   * salience 0.9 (todas do mesmo instante ⇒ recência igual), dão
   * `salience × exp(-age/180) + overlap × 0.5`:
   *
   *   relevante  salience 1.0 → 1.0 + 0.25 = 1.25   (top-1)
   *   irrelevante salience 0.9 → 0.9 + 0     = 0.90   (×4, ocupam 2..5)
   *   relevante  salience 0.1 → 0.1 + 0.25 = 0.35   (FICA DE FORA do top-5)
   *
   * O relevance gate via só a relevante #1, acha "unicidade" e APAGA a única
   * coisa que a pessoa pediu para esquecer. Unicidade de operação destrutiva
   * precisa ser provada sobre TODAS as memórias visíveis no escopo, nunca
   * sobre o recorte de contexto.
   */
  it("o corte do top-5 NÃO pode esconder a ambiguidade: 2 relevantes = nada apagado", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    const actor = "actor-1";
    // Relevantes (contêm o assunto "Nubank"): salience 1.0 e 0.1.
    const strong = rememberFact(store, {
      workspaceId,
      actor,
      kind: "preference",
      content: "Prefere registrar as despesas no Nubank",
      salience: 1.0,
    });
    const weak = rememberFact(store, {
      workspaceId,
      actor,
      kind: "fact",
      content: "Quer que eu pare de citar o Nubank por aqui",
      salience: 0.1,
    });
    // Irrelevantes com salience ALTA: sem nenhum token do assunto.
    for (const content of [
      "Abre o aplicativo do banco pela manhã",
      "Gosta de caminhar no parque aos domingos",
      "Usa caneca térmica no trabalho",
      "Prefere assistir filmes em casa no fim de semana",
    ]) {
      rememberFact(store, { workspaceId, actor, kind: "fact", content, salience: 0.9 });
    }
    expect(strong.stored).toBe(true);
    expect(weak.stored).toBe(true);

    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: actor });
    const result = await runForget(tools, "esqueça Nubank");

    // A segunda relevante é a que o top-5 escondia: sem ela, o tool apagava a
    // primeira achando unicidade. Ambiguidade honesta, NADA esquecido.
    expect(result.forgot).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(String(result.message)).toContain("2");
    // As DUAS RELEVANTES seguem vivas. A verificação usa a resolução sem
    // truncamento de propósito: o recall de contexto devolveria as 5 primeiras
    // e esconderia justamente a de salience 0.1 que este caso existe para provar.
    const alive = listForgetCandidates(store, { workspaceId, actor }).filter((item) => /nubank/i.test(item.content));
    expect(alive).toHaveLength(2);
    expect(alive.every((item) => item.invalidatedAt === null)).toBe(true);
    // E nada foi invalidado no store, nem as irrelevantes.
    const rows = (store as unknown as MemorySqlMock).rows("agent_memory");
    expect(rows.length).toBe(6);
    expect(rows.every((row) => row["invalidated_at"] == null)).toBe(true);
  });

  it("query vazia continua pedindo especificação, sem tocar em nada", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "   ");

    expect(result.forgot).toBe(false);
    expect(String(result.message)).toBe("Diga o que devo esquecer.");
    expect(recallMemories(store, { workspaceId, actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });
});

/**
 * Definitive closure (#96): only a DISCRIMINATIVE match authorizes forgetting.
 *
 * Generic coverage ("minha", "preferência", "banco", "conta") names the
 * domain category or possession — never the target. A candidate is
 * forgettable only with at least one discriminative query token; a query
 * with none authorizes nothing and the tool asks for specifics.
 */
describe("Closure definitiva (#96): só correspondência discriminante autoriza esquecimento", () => {
  it("Caso A runtime: só o Nubank é esquecido, Banco do Brasil fica intacto", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Minha conta favorita é Banco do Brasil" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça minha preferência do banco Nubank");

    expect(result.forgot).toBe(true);
    // Post-state is asserted over `listForgetCandidates` (full visibility, no
    // ranking): `recallMemories` returns the best available items even with
    // zero overlap, so a recall-based "Nubank has 0 results" assertion could
    // never pass while ANY memory survives. What proves the fix: the Nubank
    // memory is gone and exactly the Banco do Brasil one survives intact.
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content)).toEqual(['Minha conta favorita é Banco do Brasil']);
    expect(alive[0]?.invalidatedAt).toBeNull();
  });

  it("Caso B runtime: conta/preferência genéricas nunca apagam Banco do Brasil", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Minha conta principal é Banco do Brasil" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "remova minha conta/preferência do banco Nubank");

    expect(result.forgot).toBe(true);
    // Same visibility-based assertion as Caso A: the survivor must be the
    // Banco do Brasil memory itself (a content check — recall would return
    // the wrong survivor with overlap 0 and pass vacuously).
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content)).toEqual(['Minha conta principal é Banco do Brasil']);
    expect(alive[0]?.invalidatedAt).toBeNull();
  });

  it("Caso C runtime: query sem discriminante pede especificação e nada é invalidado", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere o Itaú" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça minha preferência de banco");

    expect(result.forgot).toBe(false);
    expect(String(result.message)).toMatch(/especif/i);
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content).sort()).toEqual(
      ['Prefere o Itaú', 'Prefere usar Nubank'].sort(),
    );
    expect(alive.every((item) => item.invalidatedAt === null)).toBe(true);
  });

  it("Caso E runtime: discriminante de outro banco não toca no Nubank", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça Banco Inter");

    expect(result.forgot).toBe(false);
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content)).toEqual(['Prefere usar Nubank']);
    expect(alive[0]?.invalidatedAt).toBeNull();
  });

  it("Caso F runtime: só a memória do Nubank é apagada, Alimentação fica intacta", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Banco principal é Nubank" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Categoria principal é Alimentação" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça minha principal preferência de banco Nubank");

    expect(result.forgot).toBe(true);
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content)).toEqual(['Categoria principal é Alimentação']);
    expect(alive[0]?.invalidatedAt).toBeNull();
  });

  /**
   * Review #96 round 2 (P1): function words (politeness, connectives,
   * remember/forget verb family, deictics) leaked into authorization because
   * "discriminative = not listed". Both traps run through the REAL tool flow
   * and assert NO invalidation happened (survivors by exact content).
   */
  it("Cortesia não autoriza: '…do banco Nu, por favor' não apaga a memória que contém 'por'", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nu" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere pagar por Pix" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça minha preferência do banco Nu, por favor");

    expect(result.forgot).toBe(false);
    expect(result.ambiguous).toBeUndefined();
    expect(String(result.message)).toMatch(/especif/i);
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content).sort()).toEqual(['Prefere pagar por Pix', 'Prefere usar Nu'].sort());
    expect(alive.every((item) => item.invalidatedAt === null)).toBe(true);
  });

  it("Deíticos/negação não autorizam: 'não lembre mais disso' não apaga 'Não gosta de café'", async () => {
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "fact", content: "Não gosta de café" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "não lembre mais disso");

    expect(result.forgot).toBe(false);
    expect(String(result.message)).toMatch(/especif/i);
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content)).toEqual(['Não gosta de café']);
    expect(alive[0]?.invalidatedAt).toBeNull();
  });

  it("Contração não autoriza: 'pela conta Nu' não apaga 'Prefere caminhar pela manhã' (re-review 2b)", async () => {
    // Literal reviewer reproduction, round 2b: "nu" is dropped (2 chars),
    // "conta" is generic, "pela" is a contraction — discriminators = {} and
    // the tool must ask for specifics instead of deleting the morning-walk
    // memory (which contained "pela" and was the sole match before the fix).
    const workspaceId = "ws-1";
    const store = sql();
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "preference", content: "Prefere usar Nu" });
    rememberFact(store, { workspaceId, actor: "actor-1", kind: "fact", content: "Prefere caminhar pela manhã" });
    const tools = buildMemoryTools({ sql: store, workspaceId, actorId: "actor-1" });

    const result = await runForget(tools, "esqueça minha preferência pela conta Nu");

    expect(result.forgot).toBe(false);
    expect(result.ambiguous).toBeUndefined();
    expect(String(result.message)).toMatch(/especif/i);
    const alive = listForgetCandidates(store, { workspaceId, actor: "actor-1" });
    expect(alive.map((item) => item.content).sort()).toEqual(['Prefere caminhar pela manhã', 'Prefere usar Nu'].sort());
    expect(alive.every((item) => item.invalidatedAt === null)).toBe(true);
  });
});
