/**
 * Issue #99 §29 — fluxo REAL de forget em duas etapas pelo orquestrador:
 *
 *   user request → runTurn → pending persistido → pergunta publicada →
 *   confirmação em turno posterior → mutação no store → resposta final.
 *
 * Cobre: E2E determinístico do fluxo, veto de anexo (O/P: `confirmo.pdf`
 * nunca confirma), texto explícito + anexo, cross-actor no runtime, TTL no
 * runtime, "sim" sem pending (nada executa) e precedência do pedido vago.
 */

import { describe, expect, it } from "vitest";
import { ConversationOrchestrator, normalizeRestTurn } from "../../src/orchestration/conversation-orchestrator.js";
import {
  initializeMemorySchema,
  listForgetCandidates,
  rememberFact,
  type MemorySql,
} from "../../src/agent-config/memory/store.js";
import { createMemorySql, type MemorySqlMock } from "../helpers/memory-sql.js";

const T0 = new Date("2026-10-06T12:00:00.000Z").getTime();

const setup = (nowRef: { now: number }) => {
  const mock: MemorySqlMock = createMemorySql();
  initializeMemorySchema(mock);
  const sql = mock as unknown as MemorySql;
  const events: Array<{ eventType: string; fields: Record<string, unknown> }> = [];
  const orchestrator = new ConversationOrchestrator({
    forgetMemory: { sql, now: () => nowRef.now },
    responseProvider: async () => "LLM-FALLBACK",
    events: (eventType, fields) => void events.push({ eventType, fields }),
  });
  return { sql, orchestrator, events };
};

const identity = (actorId = "actor-1", workspaceId = "ws-1") => ({
  workspaceId,
  actorId,
  role: "member" as const,
  deviceId: null,
});

const run = (
  orchestrator: ConversationOrchestrator,
  text: string,
  intentionId: string,
  opts: { actorId?: string; workspaceId?: string; attachments?: Array<{ name: string }> } = {},
) =>
  orchestrator.runTurn(
    normalizeRestTurn(
      {
        text,
        intentionId,
        ...(opts.attachments ? { attachments: opts.attachments } : {}),
      },
      identity(opts.actorId, opts.workspaceId),
    ),
  );

const alive = (sql: MemorySql, snippet: string): number =>
  listForgetCandidates(sql, { workspaceId: "ws-1", actor: "actor-1" }).filter((m) =>
    m.content.includes(snippet),
  ).length;

describe("issue #99 §29 — fluxo real em duas etapas (orquestrador)", () => {
  it("pedido → pergunta publicada → 'sim' executa → resposta final valida", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator, events } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    const asked = await run(orchestrator, "esqueça o que falei sobre Nubank", "i-1");
    expect(asked.response?.text).toMatch(/Quer que eu a esqueça/);
    expect(alive(sql, "Nubank")).toBe(1);

    const done = await run(orchestrator, "sim", "i-2");
    expect(done.response?.text).toMatch(/Pronto, esqueci/);
    expect(alive(sql, "Nubank")).toBe(0);

    const types = events.map((e) => e.eventType);
    expect(types).toContain("forget.proposed");
    expect(types).toContain("forget.confirmed");
    expect(types).toContain("forget.executed");
  });

  it("O/P — turno com anexo NUNCA confirma, mesmo com 'sim' digitado e arquivo 'confirmo.pdf'", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    const asked = await run(orchestrator, "esqueça Nubank", "i-1");
    expect(asked.response?.text).toMatch(/Quer que eu a esqueça/);

    const withAttachment = await run(orchestrator, "sim", "i-2", { attachments: [{ name: "confirmo.pdf" }] });
    expect(withAttachment.response?.text).toBe("LLM-FALLBACK");
    expect(alive(sql, "Nubank")).toBe(1);

    // E o pending continua válido: um "sim" limpo posterior executa.
    const done = await run(orchestrator, "sim", "i-3");
    expect(done.response?.text).toMatch(/Pronto, esqueci/);
    expect(alive(sql, "Nubank")).toBe(0);
  });

  it("'não' cancela no runtime; 'sim' posterior cai no legado sem executar", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    await run(orchestrator, "esqueça Nubank", "i-1");
    const cancelled = await run(orchestrator, "não", "i-2");
    expect(cancelled.response?.text).toMatch(/não esqueci nada/);
    expect(alive(sql, "Nubank")).toBe(1);

    const after = await run(orchestrator, "sim", "i-3");
    expect(after.response?.text).toBe("LLM-FALLBACK");
    expect(alive(sql, "Nubank")).toBe(1);
  });

  it("cross-actor no runtime: 'sim' de outro ator não executa nem vaza", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Segredo privado do ator 1" });

    await run(orchestrator, "esqueça o segredo privado", "i-1", { actorId: "actor-1" });
    const foreign = await run(orchestrator, "sim", "i-2", { actorId: "actor-2" });
    expect(foreign.response?.text).toBe("LLM-FALLBACK");
    expect(alive(sql, "Segredo")).toBe(1);
  });

  it("TTL no runtime: 'sim' após expiração não executa e informa expiração", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    await run(orchestrator, "esqueça Nubank", "i-1");
    nowRef.now = T0 + 11 * 60 * 1000;
    const late = await run(orchestrator, "sim", "i-2");
    expect(late.response?.text).toMatch(/expirou/);
    expect(alive(sql, "Nubank")).toBe(1);
  });

  it("'sim' sem pending não executa nada (cai no legado)", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    const res = await run(orchestrator, "sim", "i-1");
    expect(res.response?.text).toBe("LLM-FALLBACK");
    expect(alive(sql, "Nubank")).toBe(1);
  });

  it("query vaga no runtime: pede especificação, sem pending executável", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere uma caminhada pela manhã" });

    const vague = await run(orchestrator, "por gentileza, esqueça uma coisa que eu falei", "i-1");
    expect(vague.response?.text).not.toMatch(/Quer que eu a esqueça/);
    expect(alive(sql, "caminhada")).toBe(1);

    const confirm = await run(orchestrator, "sim", "i-2");
    expect(confirm.response?.text).toBe("LLM-FALLBACK");
    expect(alive(sql, "caminhada")).toBe(1);
  });

  it("mensagem fragmentada: 'esqueça' pede alvo; proposta só com contexto suficiente", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    const fragment = await run(orchestrator, "esqueça", "i-1");
    expect(fragment.response?.text).toMatch(/especificamente/);
    expect(alive(sql, "Nubank")).toBe(1);
  });

  it("round 2 R1 — 'sim, pode não apagar' e 'confirmado, pode cancelar' NÃO executam no runtime", async () => {
    for (const text of ["sim, pode não apagar", "confirmado, pode cancelar"]) {
      const nowRef = { now: T0 };
      const { sql, orchestrator } = setup(nowRef);
      rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

      const asked = await run(orchestrator, "esqueça Nubank", "i-1");
      expect(asked.response?.text).toMatch(/Quer que eu a esqueça/);
      const denied = await run(orchestrator, text, "i-2");
      expect(denied.response?.text).not.toMatch(/Pronto, esqueci/);
      expect(alive(sql, "Nubank")).toBe(1);
    }
  });

  it("round 2 S1 — replay de 'sim' antigo não executa proposta posterior no runtime", async () => {
    const nowRef = { now: T0 };
    const { sql, orchestrator } = setup(nowRef);
    rememberFact(sql, { workspaceId: "ws-1", actor: "actor-1", kind: "preference", content: "Prefere usar Nubank" });

    const nothing = await run(orchestrator, "sim", "i-antiga");
    expect(nothing.response?.text).toBe("LLM-FALLBACK");
    const asked = await run(orchestrator, "esqueça Nubank", "i-nova");
    expect(asked.response?.text).toMatch(/Quer que eu a esqueça/);
    const replay = await run(orchestrator, "sim", "i-antiga");
    expect(replay.response?.text).not.toMatch(/Pronto, esqueci/);
    expect(alive(sql, "Nubank")).toBe(1);
    // Confirmação legítima nova executa.
    const done = await run(orchestrator, "sim", "i-confirm");
    expect(done.response?.text).toMatch(/Pronto, esqueci/);
    expect(alive(sql, "Nubank")).toBe(0);
  });
});
