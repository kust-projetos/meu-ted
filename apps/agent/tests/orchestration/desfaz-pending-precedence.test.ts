/**
 * P1-5.1 (TASK_ID=P1-5.1-DESFAZ) — "desfaz" precedence over proposing an undo.
 *
 * Verified old behavior: `runUndoTurn` ran before cancel routing and "desfaz"
 * matches both `hasUndoIntent` and `isCancelText`, so "desfaz" with an active
 * pending draft/operation always proposed an undo of an OLDER action instead
 * of cancelling the pending one.
 *
 * New contract (orchestrator level, `decisionText`-routed throughout):
 * - pending financial target + "desfaz"/"desfaz isso"/"cancela" → cancel path
 *   via PendingOperationCoordinator (same contract as "cancela" today);
 * - pending AND an undo-eligible prior action → clarification asking which
 *   (cancel pending vs undo previous), executing NOTHING;
 * - neither → deterministic "nothing to undo/cancel" reply, no proposal;
 * - attachment-derived "cancela" never decides on the mutation fallback path;
 * - negations ("não desfaz", "desfaz não", "não cancela") never cancel/propose;
 * - textual confirmation still NEVER executes undo.
 *
 * TDD: these tests were written RED against the old routing (pending +
 * "desfaz" proposed an undo), then turned GREEN by the orchestrator fix.
 */
import { describe, expect, it } from "vitest";
import {
  CANCEL_NEGATION_TEXT,
  ConversationOrchestrator,
  NOTHING_TO_UNDO_OR_CANCEL_TEXT,
  UNDO_CANCEL_TWO_TARGET_TEXT,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from "../../src/orchestration/conversation-orchestrator.js";
import {
  MutationApiClient,
  type MutationRequest,
} from "../../src/mutations/mutation-api-client.js";
import {
  InMemoryMutationDraftStore,
  buildDraftRecord,
} from "../../src/mutations/mutation-draft.js";
import {
  SqlUndoProposalStore,
  initializeUndoProposalSchema,
} from "../../src/mutations/undo-proposal.js";
import { NO_PENDING_CANCEL_TEXT } from "../../src/orchestration/pending-operation-coordinator.js";
import { renderInconclusive } from "../../src/responses/deterministic-responses.js";
import { createMemorySql } from "../helpers/memory-sql.js";

const IDENTITY: AuthenticatedIdentity = {
  actorId: "actor-1",
  workspaceId: "ws-1",
  role: "member",
  deviceId: "device-1",
};

const DRAFT_CTX = { workspaceId: "ws-1", actorId: "actor-1", deviceId: "device-1" } as const;

type FakeOp = {
  id: string;
  status: "proposed" | "confirmed" | "cancelled";
  tool: string;
  amountCents: number;
  description: string;
};

const pendingOp = (id = "op-1"): FakeOp => ({
  id,
  status: "proposed",
  tool: "transactions.expense.create",
  amountCents: 5000,
  description: "Mercado",
});

/** Authoritative V2 approval surface double (listing + cancel only). */
const makeClient = (initial: FakeOp[] = []) => {
  const ops = new Map<string, FakeOp>(initial.map((op) => [op.id, { ...op }]));
  const calls: string[] = [];
  const request = (async (method: string, path: string) => {
    if (method === "GET" && path === "/pending-operations/v2/active") {
      calls.push("listActive");
      const items = [...ops.values()]
        .filter((op) => op.status === "proposed" || op.status === "confirmed")
        .map((op) => ({
          id: op.id,
          status: op.status,
          tool: op.tool,
          createdAt: "2026-10-08T00:00:00.000Z",
          expiresAt: "2026-10-08T01:00:00.000Z",
          amountCents: op.amountCents,
          description: op.description,
        }));
      return { items, total: items.length };
    }
    const cancelMatch = /^\/pending-operations\/v2\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]!);
      calls.push(`cancel:${id}`);
      const op = ops.get(id);
      if (!op || (op.status !== "proposed" && op.status !== "confirmed")) {
        throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      }
      op.status = "cancelled";
      return { id, status: "cancelled" };
    }
    throw new Error(`unexpected API request in test: ${method} ${path}`);
  }) as unknown as MutationRequest;
  return { api: new MutationApiClient({ request }), calls, ops };
};

const makeUndo = (targetId: string | null, opts: { throws?: boolean } = {}) => {
  const mock = createMemorySql();
  initializeUndoProposalSchema(mock);
  const store = new SqlUndoProposalStore(
    mock as unknown as ConstructorParameters<typeof SqlUndoProposalStore>[0],
  );
  let previewCalls = 0;
  const preview = async (): Promise<{ id: string } | null> => {
    previewCalls += 1;
    if (opts.throws) throw Object.assign(new Error("preview.timeout"), { code: "preview.timeout" });
    return targetId === null ? null : { id: targetId };
  };
  return { store, preview, previewCalls: () => previewCalls };
};

const seedActiveDraft = (draftStore: InMemoryMutationDraftStore): void => {
  draftStore.getOrCreate(
    buildDraftRecord({
      workspaceId: IDENTITY.workspaceId,
      actorId: IDENTITY.actorId,
      deviceId: IDENTITY.deviceId ?? null,
      intentionId: "draft-origin-1",
      tool: "transactions.expense.create",
      resolvedArgs: {
        kind: "expense",
        amountCents: 5000,
        description: "Mercado",
        date: "2026-10-08",
        accountId: "",
        categoryId: "",
      },
      missingFields: ["accountId", "categoryId"],
      question: "Qual conta?",
    }),
  );
};

const setup = (opts: { ops?: FakeOp[]; undoTarget?: string | null; withDraft?: boolean; previewThrows?: boolean } = {}) => {
  const { api, calls, ops } = makeClient(opts.ops ?? []);
  const undo = makeUndo(opts.undoTarget === undefined ? "audit-op-1" : opts.undoTarget, {
    ...(opts.previewThrows ? { throws: true as const } : {}),
  });
  const draftStore = new InMemoryMutationDraftStore();
  if (opts.withDraft) seedActiveDraft(draftStore);
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    draftStore,
    entityReader: {
      listAccounts: async () => [],
      listCategories: async () => [],
    },
    undoProposals: { store: undo.store, preview: undo.preview },
  });
  const run = (text: string, intentionId: string, typedText?: string) =>
    orchestrator.runTurn(
      normalizeRestTurn(
        { text, intentionId },
        IDENTITY,
        typedText === undefined ? undefined : { typedText },
      ),
    );
  const cancelCalls = (): string[] => calls.filter((call) => call.startsWith("cancel:"));
  return { orchestrator, run, calls, cancelCalls, ops, draftStore, undo };
};

describe("P1-5.1 desfaz precedence over undo proposal", () => {
  it("AC1: single pending op + no undo target + 'desfaz isso' → cancel path, no proposal", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: null });
    const result = await h.run("desfaz isso", "intent-desfaz-1");
    expect(h.cancelCalls()).toEqual(["cancel:op-1"]);
    expect(h.ops.get("op-1")?.status).toBe("cancelled");
    expect(result.undoProposal).toBeUndefined();
    expect(h.undo.store.get("intent-desfaz-1")).toBeUndefined();
    expect(result.response?.text).toBe("Operação cancelada com segurança.");
  });

  it("AC1-parity: 'cancela' under the same setup cancels identically (control)", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: null });
    const result = await h.run("cancela", "intent-cancela-1");
    expect(h.cancelCalls()).toEqual(["cancel:op-1"]);
    expect(result.undoProposal).toBeUndefined();
    expect(result.response?.text).toBe("Operação cancelada com segurança.");
  });

  it("AC1: 'cancela' with pending + undo target still cancels (no arbitration off undo intent)", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    const result = await h.run("cancela", "intent-cancela-2");
    expect(h.cancelCalls()).toEqual(["cancel:op-1"]);
    expect(result.undoProposal).toBeUndefined();
    expect(result.response?.text).toBe("Operação cancelada com segurança.");
  });

  it("AC1-draft: active draft only + 'desfaz isso' → same contract as 'cancela' (draft discarded, identical reply)", async () => {
    const h = setup({ ops: [], undoTarget: null, withDraft: true });
    const result = await h.run("desfaz isso", "intent-desfaz-draft-1");
    // Control fixture: the exact deterministic copy is owned by P1-5.3, so
    // this suite pins PARITY with "cancela" (same coordinator path, same
    // reply) instead of a literal.
    const control = setup({ ops: [], undoTarget: null, withDraft: true });
    const controlResult = await control.run("cancela", "intent-cancela-draft-1");
    expect(h.cancelCalls()).toEqual([]);
    expect(result.undoProposal).toBeUndefined();
    expect(h.undo.store.get("intent-desfaz-draft-1")).toBeUndefined();
    expect(result.response?.text).toBe(controlResult.response?.text);
    expect(h.draftStore.listActive({ ...DRAFT_CTX }, Date.now())).toHaveLength(0);
  });

  it("AC1-draft-parity: 'cancela' with only a draft discards it with no proposal (control)", async () => {
    const h = setup({ ops: [], undoTarget: null, withDraft: true });
    const result = await h.run("cancela", "intent-cancela-draft-1");
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.draftStore.listActive({ ...DRAFT_CTX }, Date.now())).toHaveLength(0);
  });

  it("AC3: pending op AND undo-eligible prior + 'desfaz' → clarification, NOTHING executes", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    const result = await h.run("desfaz", "intent-desfaz-two-1");
    expect(result.response?.text).toBe(UNDO_CANCEL_TWO_TARGET_TEXT);
    expect(result.clarification).toBeDefined();
    expect(result.undoProposal).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.undo.store.get("intent-desfaz-two-1")).toBeUndefined();
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("AC2: no pending + undo-eligible + 'desfaz o último lançamento' → undo proposal preserved byte-for-byte", async () => {
    const h = setup({ ops: [], undoTarget: "audit-op-1" });
    const result = await h.run("desfaz o último lançamento", "intent-undo-ok-1");
    expect(result.undoProposal).toMatchObject({ requestId: "intent-undo-ok-1", status: "proposed" });
    expect(result.response?.text).toMatch(/confirme no botão/i);
    expect(h.undo.store.get("intent-undo-ok-1")?.targetLastOperationId).toBe("audit-op-1");
    expect(h.cancelCalls()).toEqual([]);
  });

  it("AC4: no pending + preview null + 'desfaz' → deterministic nothing-to-undo-or-cancel, no proposal", async () => {
    const h = setup({ ops: [], undoTarget: null });
    const result = await h.run("desfaz", "intent-nothing-1");
    expect(result.response?.text).toBe(NOTHING_TO_UNDO_OR_CANCEL_TEXT);
    expect(result.undoProposal).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    expect(h.undo.store.get("intent-nothing-1")).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
  });

  it("AC6: 'não desfaz nada' with pending + target → negation, nothing executes", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-1" });
    const result = await h.run("não desfaz nada", "intent-neg-1");
    expect(result.response?.text).toBe("Entendido — nada será desfeito.");
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.undo.store.get("intent-neg-1")).toBeUndefined();
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("AC6: 'desfaz não' with pending + target → negation, nothing executes", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-1" });
    const result = await h.run("desfaz não", "intent-neg-2");
    expect(result.response?.text).toBe("Entendido — nada será desfeito.");
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.undo.store.get("intent-neg-2")).toBeUndefined();
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("AC6: 'não cancela' with a pending op → NEVER cancels", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: null });
    const result = await h.run("não cancela", "intent-neg-cancel-1");
    expect(result.response?.text).toBe(CANCEL_NEGATION_TEXT);
    expect(h.cancelCalls()).toEqual([]);
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("AC6-redelivery: same intentionId 'desfaz isso' twice converges (single cancel, no new state)", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: null });
    const first = await h.run("desfaz isso", "intent-redeliver-1");
    expect(first.response?.text).toBe("Operação cancelada com segurança.");
    const second = await h.run("desfaz isso", "intent-redeliver-1");
    expect(h.cancelCalls()).toEqual(["cancel:op-1"]);
    expect(second.response?.text).toBe(NOTHING_TO_UNDO_OR_CANCEL_TEXT);
    expect(second.undoProposal).toBeUndefined();
    expect(h.undo.store.get("intent-redeliver-1")).toBeUndefined();
  });

  it("AC6-redelivery-undo: same intentionId proposing undo twice reuses the single row", async () => {
    const h = setup({ ops: [], undoTarget: "audit-op-1" });
    const first = await h.run("desfaz o último", "intent-redeliver-undo-1");
    const second = await h.run("desfaz o último", "intent-redeliver-undo-1");
    expect(first.undoProposal?.requestId).toBe("intent-redeliver-undo-1");
    expect(second.undoProposal?.requestId).toBe("intent-redeliver-undo-1");
    expect(h.undo.store.get("intent-redeliver-undo-1")?.status).toBe("proposed");
    expect(h.cancelCalls()).toEqual([]);
  });

  it("AC5: attachment-derived 'cancela' never decides on the mutation fallback path", async () => {
    const h = setup({ ops: [], undoTarget: null, withDraft: true });
    const typed = "Nubank";
    const composed = "Nubank\n[transcrição do anexo de áudio (STT): o cliente disse cancela]";
    const result = await h.run(composed, "intent-attach-1", typed);
    expect(h.cancelCalls()).toEqual([]);
    expect(result.response?.text).not.toBe(NO_PENDING_CANCEL_TEXT);
    expect(result.response?.text).not.toBe("Operação cancelada com segurança.");
    expect(result.undoProposal).toBeUndefined();
    // The draft survives: the cancel path would have discarded it.
    expect(h.draftStore.listActive({ ...DRAFT_CTX }, Date.now()).length).toBeGreaterThan(0);
  });

  it("AC7: textual confirmation of undo NEVER executes, even with pending + target", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-1" });
    const result = await h.run("confirmo, pode desfazer", "intent-confirm-text-1");
    expect(result.response?.text).toBe(
      "Para desfazer, confirme no botão da proposta. A confirmação por texto não desfaz.",
    );
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.undo.store.get("intent-confirm-text-1")).toBeUndefined();
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("P1-UNKNOWN: preview throws + pending present → inconclusive, ZERO state change", async () => {
    // A preview timeout must NOT be read as "no undo target": with a pending
    // op present the old code took the cancel path and destroyed the pending
    // operation when a prior undo-eligible action may actually exist.
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-9", withDraft: true, previewThrows: true });
    const result = await h.run("desfaz", "intent-unknown-pending-1");
    expect(h.undo.previewCalls()).toBeGreaterThan(0);
    expect(result.response?.text).toBe(renderInconclusive());
    expect(result.undoProposal).toBeUndefined();
    expect(result.mutation).toBeUndefined();
    // No cancel call, no draft discard, no undo proposal row.
    expect(h.cancelCalls()).toEqual([]);
    expect(h.ops.get("op-1")?.status).toBe("proposed");
    expect(h.draftStore.listActive({ ...DRAFT_CTX }, Date.now())).toHaveLength(1);
    expect(h.undo.store.get("intent-unknown-pending-1")).toBeUndefined();
  });

  it("P1-UNKNOWN-NO-PENDING: preview throws + no pending → normal undo path fails closed on its own", async () => {
    const h = setup({ ops: [], previewThrows: true });
    const result = await h.run("desfaz o último", "intent-unknown-nopending-1");
    expect(result.response?.text).toBe("Não foi possível preparar o desfazer agora. Tente novamente.");
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.undo.store.get("intent-unknown-nopending-1")).toBeUndefined();
  });

  it("P2-CHOICE-PREVIOUS: turn1 question → turn2 'desfaz a anterior' ⇒ undo proposal, no execution", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    const first = await h.run("desfaz", "intent-choice-1");
    expect(first.response?.text).toBe(UNDO_CANCEL_TWO_TARGET_TEXT);
    const second = await h.run("desfaz a anterior", "intent-choice-2");
    expect(second.undoProposal).toMatchObject({ requestId: "intent-choice-2", status: "proposed" });
    expect(second.response?.text).toMatch(/confirme no botão/i);
    expect(h.undo.store.get("intent-choice-2")?.targetLastOperationId).toBe("audit-op-9");
    // The pending op is untouched: proposal only, execution stays with the button.
    expect(h.cancelCalls()).toEqual([]);
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("P2-CHOICE-PENDING: turn1 question → turn2 'cancela a pendente' ⇒ cancel path", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    const first = await h.run("desfaz", "intent-choice-3");
    expect(first.response?.text).toBe(UNDO_CANCEL_TWO_TARGET_TEXT);
    const second = await h.run("cancela a pendente", "intent-choice-4");
    expect(second.response?.text).toBe("Operação cancelada com segurança.");
    expect(h.cancelCalls()).toEqual(["cancel:op-1"]);
    expect(second.undoProposal).toBeUndefined();
    expect(h.undo.store.get("intent-choice-4")).toBeUndefined();
  });

  it("P2-CHOICE-BARE: 'a anterior' ⇒ proposal; 'a pendente' ⇒ cancel", async () => {
    const h1 = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    await h1.run("desfaz", "intent-bare-1");
    const prev = await h1.run("a anterior", "intent-bare-2");
    expect(prev.undoProposal).toMatchObject({ requestId: "intent-bare-2", status: "proposed" });
    expect(h1.cancelCalls()).toEqual([]);
    expect(h1.ops.get("op-1")?.status).toBe("proposed");

    const h2 = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    await h2.run("desfaz", "intent-bare-3");
    const pend = await h2.run("a pendente", "intent-bare-4");
    expect(pend.response?.text).toBe("Operação cancelada com segurança.");
    expect(h2.cancelCalls()).toEqual(["cancel:op-1"]);
    expect(pend.undoProposal).toBeUndefined();
  });

  it("P2-AMBIGUOUS: a non-selector answer re-clarifies, never executes", async () => {
    const h = setup({ ops: [pendingOp()], undoTarget: "audit-op-9" });
    await h.run("desfaz", "intent-amb-1");
    const second = await h.run("desfaz tudo", "intent-amb-2");
    expect(second.response?.text).toBe(UNDO_CANCEL_TWO_TARGET_TEXT);
    expect(second.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.ops.get("op-1")?.status).toBe("proposed");
    expect(h.undo.store.get("intent-amb-2")).toBeUndefined();
  });

  it("P2-PREVIOUS-NO-TARGET: 'desfaz a anterior' + pending but NO undo target ⇒ nothing-to-undo, pending untouched", async () => {
    // The user explicitly selected the previous action, NOT the pending op —
    // cancelling the pending here would execute against the explicit choice.
    const h = setup({ ops: [pendingOp()], undoTarget: null });
    const result = await h.run("desfaz a anterior", "intent-prev-none-1");
    expect(result.response?.text).toBe(NOTHING_TO_UNDO_OR_CANCEL_TEXT);
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
    expect(h.ops.get("op-1")?.status).toBe("proposed");
  });

  it("P2-PENDING-NO-PENDING: bare 'a pendente' with nothing pending ⇒ deterministic no-op", async () => {
    const h = setup({ ops: [], undoTarget: null });
    const result = await h.run("a pendente", "intent-pend-none-1");
    expect(result.response?.text).toBe(NO_PENDING_CANCEL_TEXT);
    expect(result.undoProposal).toBeUndefined();
    expect(h.cancelCalls()).toEqual([]);
  });
});
