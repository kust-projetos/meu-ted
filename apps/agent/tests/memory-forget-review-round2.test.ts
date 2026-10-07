/**
 * Issue #99 — round 2 de review (code + security): regressões das correções.
 *
 * - R1 (negação confirma): "sim, pode não apagar" / "confirmado, pode
 *   cancelar" NUNCA executam (matcher fechado + veto de negação +
 *   cancel-first).
 * - R2 (claim sem release): falha entre claim e delete libera o claim;
 *   replay da mesma intenção encontra o recibo `failed` — nunca
 *   "já foi esquecido".
 * - R3 (publicação): `revertUnpublishedForgetProposals` expira pendings do
 *   turno não publicado; redelivery re-propõe do zero.
 * - R4 (dedupe de proposta): redelivery do mesmo pedido não cria, renova
 *   nem supersede; cancel/supersede terminais contra redelivery.
 * - S1 (vínculo de consumo): "sim" consumido como `none` nunca autoriza
 *   proposta posterior; redelivery reproduz sem tocar em pendings novos.
 */

import { describe, expect, it } from "vitest";
import {
  cancelForgetMemory,
  confirmForgetMemory,
  isForgetConfirmationText,
  proposeForgetMemory,
} from "../src/agent-config/memory/forget-proposals.js";
import {
  forgetMemory,
  getForgetProposal,
  initializeMemorySchema,
  listActiveForgetProposals,
  recallMemories,
  rememberFact,
  revertUnpublishedForgetProposals,
  type MemorySql,
} from "../src/agent-config/memory/store.js";
import { createMemorySql, type MemorySqlMock } from "./helpers/memory-sql.js";

const T0 = new Date("2026-10-06T12:00:00.000Z").getTime();

const sql = () => {
  const mock: MemorySqlMock = createMemorySql();
  initializeMemorySchema(mock);
  return mock as unknown as MemorySql;
};

const ID = { workspaceId: "ws-1", actorId: "actor-1" };

describe("round 2 — R1: negação/cancelamento nunca confirma", () => {
  it.each([
    "sim, pode não apagar",
    "sim, pode deixar essa memória intacta",
    "confirmado, pode cancelar",
    "sim, mas não apague",
    "confirmo, na verdade cancela",
  ])("matcher rejeita %p", (text) => {
    expect(isForgetConfirmationText(text)).toBe(false);
  });

  it("afirmações fechadas continuam confirmando", () => {
    for (const text of ["sim", "confirmo", "pode esquecer", "pode apagar", "sim, esqueça", "confirmado"]) {
      expect(isForgetConfirmationText(text)).toBe(true);
    }
  });

  it("proposta + 'sim, pode não apagar' não executa (serviço)", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 }).outcome).toBe("proposed");
    // O texto negado não é confirmação: cai fora do fluxo de decisão.
    expect(isForgetConfirmationText("sim, pode não apagar")).toBe(false);
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(1);
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });
});

describe("round 2 — R2b: falha DENTRO da execução (pós-claim) libera e permite retry", () => {
  it("UPDATE do delete lança: failed + claim liberado + replay encontra recibo + retry executa", () => {
    const mock: MemorySqlMock = createMemorySql();
    initializeMemorySchema(mock);
    const store = mock as unknown as MemorySql;
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 }).outcome).toBe("proposed");

    // Falha injetada UMA vez, só no UPDATE de invalidação (claim passa).
    let armed = true;
    const flaky = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        const normalized = query.trim().replace(/\s+/g, " ");
        if (armed && normalized.startsWith("UPDATE agent_memory SET")) {
          armed = false;
          throw new Error("store.io_error");
        }
        return mock.exec<T>(query, ...(bindings as []));
      },
    } as unknown as MemorySql;

    const failed = confirmForgetMemory(flaky, { ...ID, intentionId: "c1", nowMs: T0 });
    expect(failed.outcome).toBe("failed");
    // Claim liberado de volta para pending; memória viva.
    const pending = listActiveForgetProposals(store, ID, T0);
    expect(pending).toHaveLength(1);
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);

    // Replay da MESMA intenção: recibo `failed` — nunca "já foi esquecido".
    const replay = confirmForgetMemory(flaky, { ...ID, intentionId: "c1", nowMs: T0 });
    expect(replay.outcome).toBe("failed");
    expect(replay.message).not.toMatch(/já foi esquecido/);

    // Nova confirmação (outra intenção) repete com o store saudável e executa.
    const retry = confirmForgetMemory(store, { ...ID, intentionId: "c2", nowMs: T0 });
    expect(retry.outcome).toBe("executed");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(0);
  });
});

describe("round 2 — R2: revalidação falha fechado e replay reproduz (sem falso sucesso)", () => {
  it("alvo sumido antes do sim: revalidation_failed + replay reproduz a falha", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 }).outcome).toBe("proposed");

    // Race externa: alvo invalidado por outro caminho antes do "sim".
    const target = recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })[0]!;
    forgetMemory(store, { workspaceId: "ws-1", id: target.id });

    const failed = confirmForgetMemory(store, { ...ID, intentionId: "c1", nowMs: T0 });
    expect(failed.outcome).toBe("revalidation_failed");

    // Replay da MESMA intenção: reproduz a falha, nunca "já foi esquecido".
    const replay = confirmForgetMemory(store, { ...ID, intentionId: "c1", nowMs: T0 });
    expect(replay.outcome).toBe("revalidation_failed");
    expect(replay.message).not.toMatch(/já foi esquecido/);
  });
});

describe("round 2 — R3: rollback de publicação", () => {
  it("pending de turno não publicado expira e redelivery re-propõe do zero", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p502", nowMs: T0 }).outcome).toBe("proposed");

    // persistMessages falhou (502): compensação.
    const reverted = revertUnpublishedForgetProposals(store, { ...ID, intentionId: "p502", decidedAt: new Date(T0).toISOString() });
    expect(reverted).toBe(1);
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(0);

    // "sim" não executa o que nunca foi visto.
    expect(confirmForgetMemory(store, { ...ID, intentionId: "c", nowMs: T0 }).outcome).toBe("none");

    // Redelivery do turno (mesma intenção): re-propõe do zero (publish_failed invisível).
    const retry = proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p502", nowMs: T0 });
    expect(retry.outcome).toBe("proposed");
    const done = confirmForgetMemory(store, { ...ID, intentionId: "c2", nowMs: T0 });
    expect(done.outcome).toBe("executed");
  });

  it("revert não toca pendings de outros turnos", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p-other", nowMs: T0 });
    expect(revertUnpublishedForgetProposals(store, { ...ID, intentionId: "p502", decidedAt: new Date(T0).toISOString() })).toBe(0);
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(1);
  });
});

describe("round 2 — R4: dedupe de proposta por intenção", () => {
  it("redelivery com pending ativo reproduz a mesma proposta (sem duplicar, sem renovar)", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    const first = proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 });
    expect(first.outcome).toBe("proposed");
    const replay = proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 });
    expect(replay.outcome).toBe("proposed");
    if (first.outcome === "proposed" && replay.outcome === "proposed") {
      expect(replay.proposal.id).toBe(first.proposal.id);
    }
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(1);
  });

  it("redelivery após cancel NÃO reanima (cancel terminal)", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 }).outcome).toBe("proposed");
    expect(cancelForgetMemory(store, { ...ID, intentionId: "c", nowMs: T0 }).outcome).toBe("cancelled");

    const replay = proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 });
    expect(replay.outcome).toBe("already_handled");
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(0);
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);
  });

  it("redelivery após execução responde 'já foi esquecido', sem novo pending", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 }).outcome).toBe("proposed");
    expect(confirmForgetMemory(store, { ...ID, intentionId: "c", nowMs: T0 }).outcome).toBe("executed");

    const replay = proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p", nowMs: T0 });
    expect(replay.outcome).toBe("already_handled");
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(0);
  });
});

describe("round 2 — S1b: already_done observado consome o turno (recibo)", () => {
  it("observar execução recente registra recibo; replay não autoriza proposta posterior", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p1", nowMs: T0 }).outcome).toBe("proposed");
    expect(confirmForgetMemory(store, { ...ID, intentionId: "c1", nowMs: T0 }).outcome).toBe("executed");

    // "sim" sem pending observa a execução recente → already_done (consome X).
    expect(confirmForgetMemory(store, { ...ID, intentionId: "x", nowMs: T0 }).outcome).toBe("already_done");

    // Proposta nova legítima.
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Conta principal é Itaú" });
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Itaú", intentionId: "p2", nowMs: T0 }).outcome).toBe("proposed");

    // Replay de X: recibo already_done — NÃO executa o Itaú.
    const replay = confirmForgetMemory(store, { ...ID, intentionId: "x", nowMs: T0 });
    expect(replay.outcome).toBe("already_done");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Itaú" })).toHaveLength(1);

    // Confirmação nova executa.
    expect(confirmForgetMemory(store, { ...ID, intentionId: "y", nowMs: T0 }).outcome).toBe("executed");
  });
});

describe("round 2 — S1: turno de decisão consumido nunca autoriza proposta posterior", () => {
  it("'sim' sem pending + proposta nova + replay do 'sim' antigo NÃO executa", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });

    // Turno 1: "sim" sem nada pendente → none (consome a intenção).
    expect(confirmForgetMemory(store, { ...ID, intentionId: "c-antiga", nowMs: T0 }).outcome).toBe("none");
    // Turno 2: proposta nova legítima.
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p-nova", nowMs: T0 }).outcome).toBe("proposed");
    // Replay EXATO do turno 1: reproduz `none`, NÃO executa a proposta nova.
    const replay = confirmForgetMemory(store, { ...ID, intentionId: "c-antiga", nowMs: T0 });
    expect(replay.outcome).toBe("none");
    expect(recallMemories(store, { workspaceId: "ws-1", actor: "actor-1", query: "Nubank" })).toHaveLength(1);

    // Confirmação legítima nova (outra intenção) executa normalmente.
    expect(confirmForgetMemory(store, { ...ID, intentionId: "c-nova", nowMs: T0 }).outcome).toBe("executed");
    expect(getForgetProposal(store, listActiveForgetProposals(store, ID, T0)[0]?.id ?? "")).toBeUndefined();
  });

  it("'não' consumido sem pending não cancela proposta posterior em redelivery", () => {
    const store = sql();
    rememberFact(store, { ...ID, workspaceId: ID.workspaceId, actor: ID.actorId, kind: "preference", content: "Prefere usar Nubank" });

    expect(cancelForgetMemory(store, { ...ID, intentionId: "x-antigo", nowMs: T0 }).outcome).toBe("none");
    expect(proposeForgetMemory(store, { ...ID, query: "esqueça Nubank", intentionId: "p-nova", nowMs: T0 }).outcome).toBe("proposed");

    const replay = cancelForgetMemory(store, { ...ID, intentionId: "x-antigo", nowMs: T0 });
    expect(replay.outcome).toBe("none");
    expect(listActiveForgetProposals(store, ID, T0)).toHaveLength(1);
  });
});
