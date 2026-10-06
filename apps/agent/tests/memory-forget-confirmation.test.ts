/**
 * Issue #99 — `forget_memory` em duas etapas: confirmação, cancelamento,
 * expiração, replay, race, isolamento e auditoria (serviço).
 *
 * Cobre §28: B (confirmação), C (cancelamento), H (cross-actor),
 * I (cross-workspace), J (TTL), K (replay), L (race), M (cancel→confirm),
 * N (supersede), O/P (attachment = orquestrador), mais auditoria, preview
 * sem IDs e o guard de learning §30.
 */

import { describe, expect, it } from "vitest";
import {
  cancelForgetMemory,
  confirmForgetMemory,
  isForgetCancellationText,
  isForgetConfirmationText,
  isForgetRequestText,
  proposeForgetMemory,
} from "../src/agent-config/memory/forget-proposals.js";
import {
  FORGET_PROPOSAL_TTL_MS,
  forgetMemory,
  getForgetProposal,
  initializeMemorySchema,
  insertForgetProposal,
  listActiveForgetProposals,
  listForgetCandidates,
  recallMemories,
  rememberFact,
  type ForgetProposalRecord,
  type MemorySql,
} from "../src/agent-config/memory/store.js";
import { learnFromTurn } from "../src/agent-config/memory/learn.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";

const T0 = new Date("2026-10-06T12:00:00.000Z").getTime();

const sql = () => {
  const mock: MemorySqlMock = createMemorySql();
  initializeMemorySchema(mock);
  return mock as unknown as MemorySql;
};

const seed = (store: MemorySql, workspaceId: string, actor: string, contents: string[]): void => {
  for (const content of contents) {
    rememberFact(store, { workspaceId, actor, kind: "preference", content });
  }
};

const alive = (store: MemorySql, snippet: string, workspaceId = "ws-1", actor = "actor-1"): number =>
  listForgetCandidates(store, { workspaceId, actor }).filter((m) => m.content.includes(snippet)).length;

const propose = (
  store: MemorySql,
  query: string,
  opts: { workspaceId?: string; actorId?: string; intentionId?: string; nowMs?: number; emit?: (t: string, f: Record<string, unknown>) => void } = {},
) =>
  proposeForgetMemory(store, {
    workspaceId: opts.workspaceId ?? "ws-1",
    actorId: opts.actorId ?? "actor-1",
    query,
    intentionId: opts.intentionId ?? "i-propose",
    nowMs: opts.nowMs ?? T0,
    ...(opts.emit ? { emit: opts.emit } : {}),
  });

const confirm = (
  store: MemorySql,
  opts: { workspaceId?: string; actorId?: string; intentionId?: string; nowMs?: number; emit?: (t: string, f: Record<string, unknown>) => void } = {},
) =>
  confirmForgetMemory(store, {
    workspaceId: opts.workspaceId ?? "ws-1",
    actorId: opts.actorId ?? "actor-1",
    intentionId: opts.intentionId ?? "i-confirm",
    nowMs: opts.nowMs ?? T0,
    ...(opts.emit ? { emit: opts.emit } : {}),
  });

describe("issue #99 — confirmação em turno posterior (B)", () => {
  it("proposta + 'sim' executa SÓ o alvo proposto e valida o pós-estado", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank", "Prefere categoria Alimentação"]);
    const events: string[] = [];
    const emit = (t: string): void => void events.push(t);
    const alive = (snippet: string): number =>
      listForgetCandidates(store, { workspaceId: "ws-1", actor: "actor-1" }).filter((m) =>
        m.content.includes(snippet),
      ).length;

    const p = propose(store, "esqueça Nubank", { emit });
    expect(p.outcome).toBe("proposed");
    expect(alive("Nubank")).toBe(1);

    const c = confirm(store, { emit });
    expect(c.outcome).toBe("executed");
    expect(alive("Nubank")).toBe(0);
    // A irrelevante sobrevive.
    expect(alive("Alimentação")).toBe(1);
    expect(events).toEqual(["forget.proposed", "forget.confirmed", "forget.executed"]);
  });

  it("auditoria carrega ids/hash, nunca conteúdo sensível", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    const seen: Array<{ t: string; f: Record<string, unknown> }> = [];
    const emit = (t: string, f: Record<string, unknown>): void => void seen.push({ t, f });

    propose(store, "esqueça Nubank", { emit });
    confirm(store, { emit });

    for (const { f } of seen) {
      expect(JSON.stringify(f)).not.toMatch(/Prefere usar Nubank/);
    }
    const proposed = seen.find((e) => e.t === "forget.proposed")!;
    expect(proposed.f.memoryId).toBeTruthy();
    expect(proposed.f.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pergunta de confirmação mostra só preview humano, sem IDs", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    const p = propose(store, "esqueça Nubank");
    expect(p.outcome).toBe("proposed");
    if (p.outcome !== "proposed") throw new Error("unreachable");
    expect(p.message).toMatch(/Quer que eu a esqueça/);
    expect(p.message).toMatch(/Prefere usar Nubank/);
    expect(p.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(p.message).not.toMatch(/workspace|actor|hash|fingerprint/i);
  });
});

describe("issue #99 — cancelamento (C) e cancel→confirm (M)", () => {
  it("'não' cancela: nada apagado; 'sim' posterior NÃO reanima", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    const events: string[] = [];
    const emit = (t: string): void => void events.push(t);

    expect(propose(store, "esqueça Nubank", { emit }).outcome).toBe("proposed");
    const cancelled = cancelForgetMemory(store, { workspaceId: "ws-1", actorId: "actor-1", nowMs: T0, emit });
    expect(cancelled.outcome).toBe("cancelled");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);

    const after = confirm(store, { emit });
    expect(after.outcome).toBe("none");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);
    expect(events).toEqual(["forget.proposed", "forget.cancelled"]);
  });
});

describe("issue #99 — replay idempotente (K)", () => {
  it("redelivery do MESMO turno converge para já-concluído, sem duplo efeito", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);

    expect(propose(store, "esqueça Nubank").outcome).toBe("proposed");
    const first = confirmForgetMemory(store, { workspaceId: "ws-1", actorId: "actor-1", intentionId: "i-same", nowMs: T0 });
    expect(first.outcome).toBe("executed");

    const replay = confirmForgetMemory(store, { workspaceId: "ws-1", actorId: "actor-1", intentionId: "i-same", nowMs: T0 });
    expect(replay.outcome).toBe("already_done");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(0);
  });
});

describe("issue #99 — TTL (J)", () => {
  it("pending expirado: 'sim' NÃO executa e responde expiração", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    const events: string[] = [];
    const emit = (t: string): void => void events.push(t);

    expect(propose(store, "esqueça Nubank", { emit, nowMs: T0 }).outcome).toBe("proposed");
    const late = confirm(store, { emit, nowMs: T0 + FORGET_PROPOSAL_TTL_MS + 1000 });
    expect(late.outcome).toBe("expired");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);
    expect(events).not.toContain("forget.executed");
  });
});

describe("issue #99 — race condition (L)", () => {
  it("alvo invalidado entre proposta e confirmação: aborta, nada apagado", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    expect(propose(store, "esqueça Nubank").outcome).toBe("proposed");

    // Mudança externa: a memória some por outro caminho antes do "sim".
    const target = recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })[0]!;
    forgetMemory(store, { workspaceId: "ws-1", id: target.id });

    const c = confirm(store, {});
    expect(c.outcome).toBe("revalidation_failed");
  });

  it("conteúdo alterado entre proposta e confirmação: aborta, o NOVO estado intacto", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    expect(propose(store, "esqueça Nubank").outcome).toBe("proposed");

    const target = recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })[0]!;
    (store as unknown as { exec<T>(q: string, ...b: unknown[]): Iterable<T> }).exec(
      `UPDATE agent_memory SET content = ? WHERE id = ?`,
      "Prefere usar Itaú agora",
      target.id,
    );

    const c = confirm(store, {});
    expect(c.outcome).toBe("revalidation_failed");
    // O estado NOVO não foi apagado pelo hash antigo.
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Itaú" })).toHaveLength(1);
  });
});

describe("issue #99 — isolamento (H/I)", () => {
  it("H — pending do ator A é invisível para o ator B (sem oráculo)", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Segredo privado do ator 1"]);
    expect(propose(store, "Segredo privado do ator 1", { actorId: "actor-1" }).outcome).toBe("proposed");

    expect(listActiveForgetProposals(store, { workspaceId: "ws-1", actorId: "actor-2" }, T0)).toHaveLength(0);
    const c = confirm(store, { actorId: "actor-2" });
    expect(c.outcome).toBe("none");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Segredo" })).toHaveLength(1);
  });

  it("I — pending do workspace A inalcançável em B", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    expect(propose(store, "esqueça Nubank").outcome).toBe("proposed");

    const c = confirm(store, { workspaceId: "ws-2" });
    expect(c.outcome).toBe("none");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });
});

describe("issue #99 — supersede (N) e ambiguidade ativa", () => {
  it("novo pedido substitui o anterior: só o mais recente confirma", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank para tudo", "Conta principal é Itaú"]);

    const first = propose(store, "esqueça Nubank", { intentionId: "i-1" });
    expect(first.outcome).toBe("proposed");
    const second = propose(store, "esqueça Itaú", { intentionId: "i-2" });
    expect(second.outcome).toBe("proposed");

    if (first.outcome !== "proposed") throw new Error("unreachable");
    expect(getForgetProposal(store, first.proposal.id)?.status).toBe("superseded");

    const c = confirm(store, { intentionId: "i-3" });
    expect(c.outcome).toBe("executed");
    expect(alive(store, "Itaú")).toBe(0);
    expect(alive(store, "Nubank")).toBe(1);
  });

  it("2 pendings ativos simultâneos (race): 'sim' falha fechado, nada apagado", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere pagar contas pelo Nubank", "Prefere cartão Nubank para compras"]);
    const nowIso = new Date(T0).toISOString();
    const later = new Date(T0 + FORGET_PROPOSAL_TTL_MS - 1000).toISOString();
    const base = { workspaceId: "ws-1", actorId: "actor-1", status: "pending" as const, createdAt: nowIso, expiresAt: later, sourceIntentionId: "i-x" };
    const a: ForgetProposalRecord = Object.freeze({ ...base, id: "p-a", memoryId: "m-a", contentHash: "h", memoryPreview: "a" });
    const b: ForgetProposalRecord = Object.freeze({ ...base, id: "p-b", memoryId: "m-b", contentHash: "h", memoryPreview: "b" });
    insertForgetProposal(store, a);
    insertForgetProposal(store, b);

    const c = confirm(store, {});
    expect(c.outcome).toBe("ambiguous");
    expect(alive(store, "contas")).toBe(1);
    expect(alive(store, "cartão")).toBe(1);
  });

  it("sem pending: confirmação e cancelamento respondem ausência, sem efeito", () => {
    const store = sql();
    seed(store, "ws-1", "actor-1", ["Prefere usar Nubank"]);
    expect(confirm(store, {}).outcome).toBe("none");
    expect(cancelForgetMemory(store, { workspaceId: "ws-1", actorId: "actor-1", nowMs: T0 }).outcome).toBe("none");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });
});

describe("issue #99 — matchers de decisão (texto digitado, curtos e inequívocos)", () => {
  it("pedido: imperativo de esquecer, nunca contraparte de lembrar", () => {
    expect(isForgetRequestText("esqueça Nubank")).toBe(true);
    expect(isForgetRequestText("por favor apague isso")).toBe(true);
    expect(isForgetRequestText("não esqueça de pagar a conta")).toBe(false);
    expect(isForgetRequestText("lembre-se do meu banco")).toBe(false);
    expect(isForgetRequestText("nunca esqueça minha preferência")).toBe(false);
    expect(isForgetRequestText("qual meu saldo")).toBe(false);
  });

  it("confirmação: 'sim' e variantes explícitas; imperativo puro é PEDIDO, não confirmação", () => {
    expect(isForgetConfirmationText("sim")).toBe(true);
    expect(isForgetConfirmationText("confirmo")).toBe(true);
    expect(isForgetConfirmationText("pode esquecer")).toBe(true);
    expect(isForgetConfirmationText("sim, esqueça")).toBe(true);
    expect(isForgetConfirmationText("esqueça")).toBe(false);
    expect(isForgetConfirmationText("apague")).toBe(false);
    expect(isForgetRequestText("esqueça")).toBe(true);
    expect(isForgetConfirmationText("talvez")).toBe(false);
    expect(isForgetConfirmationText("não")).toBe(false);
    expect(isForgetConfirmationText("sim, e também me mostre o extrato completo do mês com tudo")).toBe(false);
  });

  it("cancelamento: 'não', 'cancela', 'deixa pra lá'; 'sim' não cancela", () => {
    expect(isForgetCancellationText("não")).toBe(true);
    expect(isForgetCancellationText("cancela")).toBe(true);
    expect(isForgetCancellationText("deixa pra lá")).toBe(true);
    expect(isForgetCancellationText("não esqueça")).toBe(true);
    expect(isForgetCancellationText("sim")).toBe(false);
  });
});

describe("issue #99 — learning §30: proposta/confirmação/cancel/falha não ensinam", () => {
  it("turnos do fluxo de forget não produzem learnings", async () => {
    const store = sql();
    const turnCount = 6;
    const cases: Array<[string, string]> = [
      ["esqueça Nubank", 'Encontrei esta memória:\n"Prefere usar Nubank."\n\nQuer que eu a esqueça?'],
      ["sim", "Pronto, esqueci essa memória."],
      ["não", "Tudo bem, não esqueci nada."],
      ["sim", "Não há nenhuma confirmação de esquecimento pendente."],
      ["esqueça Nubank", "Não encontrei uma memória claramente correspondente."],
    ];
    for (const [userText, assistantText] of cases) {
      const learned = await learnFromTurn(store, {
        workspaceId: "ws-1",
        actorId: "actor-1",
        userText,
        assistantText,
        turnCount,
      });
      expect(learned).toEqual([]);
    }
  });
});
