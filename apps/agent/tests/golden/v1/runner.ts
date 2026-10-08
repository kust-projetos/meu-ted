/**
 * F4 Golden Workflows (issue #105) — minimal executable runner, v1.
 *
 * Each `status: "executable"` case runs as a turn sequence through the REAL
 * `ConversationOrchestrator` with the REAL `routeIntent` planner (no plan
 * override) against the ISOLATED backend (`./backend.ts`). The only doubles
 * are the transport (`request`), the evidence source and the generative
 * provider stub — all in memory, zero network, zero credentials.
 *
 * Turn results are reduced to the closed action vocabulary (`./schema.ts`)
 * and validated by the acceptance contract (`./contract.ts`), where
 * `false-success` is a HARD FAILURE (INV-03).
 */
import {
  ConversationOrchestrator,
  normalizeRestTurn,
} from "../../../src/orchestration/conversation-orchestrator.js";
import { MutationApiClient } from "../../../src/mutations/mutation-api-client.js";
import { InMemoryMutationDraftStore } from "../../../src/mutations/mutation-draft.js";
import { recallMemories } from "../../../src/agent-config/memory/store.js";
import {
  FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT,
  renderInconclusive,
  renderMutationResult,
} from "../../../src/responses/deterministic-responses.js";
import { IsolatedBackend } from "./backend.js";
import { evaluateContract, type BackendSnapshot, type ExecutedTurn } from "./contract.js";
import type { GoldenAction, GoldenCase } from "./schema.js";

export type GoldenTurnRecord = ExecutedTurn;

export type GoldenCaseResult = Readonly<{
  caseId: string;
  workflow: string;
  status: "pass" | "fail" | "skipped-pending";
  turns: readonly GoldenTurnRecord[];
  backend: BackendSnapshot;
  falseSuccess: boolean;
  findings: readonly { rule: string; severity: "failure" | "error"; detail: string }[];
  providerCalls: number;
  latencyMs: number;
  pendingCapability?: string;
}>;

const FAIL_CLOSED_COPIES = new Set([
  FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT,
  renderInconclusive(),
  renderMutationResult("failed"),
]);

const IDENTITY = {
  actorId: "actor-golden",
  workspaceId: "ws-golden",
  role: "member" as const,
  deviceId: "golden-device-1",
};

const memoryCount = (backend: IsolatedBackend, query: string): number => {
  try {
    return recallMemories(backend.memorySql, { workspaceId: "ws-golden", actor: "actor-golden", query }).length;
  } catch {
    return -1;
  }
};

/** Executes one executable case; pending-capability cases never reach here. */
export const runGoldenCase = async (goldenCase: GoldenCase): Promise<GoldenCaseResult> => {
  const startedAt = Date.now();
  if (goldenCase.status !== "executable") {
    return {
      caseId: goldenCase.id,
      workflow: goldenCase.workflow,
      status: "skipped-pending",
      turns: [],
      backend: { proposalsCreated: 0, executionsSucceeded: 0, ledgerEntries: 0, operationIds: [] },
      falseSuccess: false,
      findings: [],
      providerCalls: 0,
      latencyMs: 0,
      pendingCapability: goldenCase.pendingReason?.capability ?? "unknown",
    };
  }
  const backend = new IsolatedBackend(goldenCase.initialState);
  const client = new MutationApiClient({ request: backend.request as never, events: () => {} });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: client,
    draftStore: new InMemoryMutationDraftStore(),
    entityReader: backend.entityReader,
    evidenceProvider: backend.evidenceProvider,
    responseProvider: backend.responseProvider,
    forgetMemory: { sql: backend.memorySql },
    events: () => {},
  });

  const seedQuery = (goldenCase.initialState.memory ?? [])[0]?.content.slice(0, 16) ?? "";
  const memoryBefore = seedQuery ? memoryCount(backend, seedQuery) : -1;

  const turns: GoldenTurnRecord[] = [];
  let lastOperationId: string | null = null;
  const extraFindings: { rule: string; severity: "failure" | "error"; detail: string }[] = [];

  const inputs = goldenCase.inputs.slice(0, goldenCase.expectations.budget.maxTurns);
  for (const [index, input] of inputs.entries()) {
    const turnStartedAt = Date.now();
    const intentionId = input.intentionId ?? `${goldenCase.id}-t${index + 1}`;
    // Cancel↔operation binding (P1-5.4): `runCancelTurn` returns no mutation,
    // so a cancel turn's operationId would always be null and skip the
    // contract's per-operation check. Bind harness-observed evidence instead:
    // the cancellations already recorded by the previous turn's snapshot.
    const cancelledBefore: readonly string[] =
      turns.length > 0 ? (turns[turns.length - 1]?.cancelledOperationIdsAfterTurn ?? []) : [];
    const pendingOperationIds =
      input.pendingOperationIds === "from-previous" && lastOperationId ? [lastOperationId] : Array.isArray(input.pendingOperationIds) ? [...input.pendingOperationIds] : undefined;
    const body: Record<string, unknown> = { text: input.text, intentionId };
    if (pendingOperationIds) body.pendingOperationIds = pendingOperationIds;
    if (input.attachments) {
      body.attachments = input.attachments.map((attachment) => ({ ...attachment }));
    }
    const turnInput = normalizeRestTurn(body, IDENTITY, input.decisionText !== undefined ? { typedText: input.decisionText } : undefined);
    const providerCallsBefore = backend.providerCalls.length;
    const perTurnEffects = (): Pick<GoldenTurnRecord, "executionsSucceededAfterTurn" | "executedOperationIdsAfterTurn" | "cancellationsAfterTurn" | "cancelledOperationIdsAfterTurn"> => ({
      executionsSucceededAfterTurn: backend.executionsSucceeded,
      executedOperationIdsAfterTurn: backend.ops.filter((op) => op.status === "executed").map((op) => op.id),
      cancellationsAfterTurn: backend.ops.filter((op) => op.status === "cancelled").length,
      cancelledOperationIdsAfterTurn: backend.ops.filter((op) => op.status === "cancelled").map((op) => op.id),
    });
    try {
      const result = await orchestrator.runTurn(turnInput);
      const responseText = result.response?.text ?? "";
      const actions: GoldenAction[] = [];
      if (result.clarification) actions.push("clarification_asked");
      if (result.mutation?.status === "proposed") actions.push("proposal_created");
      if (result.mutation?.status === "succeeded") actions.push("confirmation_executed");
      if (result.failClosed === true || FAIL_CLOSED_COPIES.has(responseText)) actions.push("fail_closed");
      if (result.plan.mode === "read" && responseText && result.failClosed !== true && !FAIL_CLOSED_COPIES.has(responseText)) {
        actions.push("read_answered");
      }
      if (responseText === renderMutationResult("cancelled")) actions.push("cancel_executed");
      if (/Quer que eu a esqueça\?/.test(responseText)) actions.push("forget_proposed");
      if (/Pronto, esqueci essa mem[oó]ria/.test(responseText)) actions.push("forget_executed");
      if (backend.providerCalls.length > providerCallsBefore) actions.push("provider_called");
      if (result.mutation) lastOperationId = result.mutation.operationId;
      const cancelledAfter: readonly string[] = backend.ops.filter((op) => op.status === "cancelled").map((op) => op.id);
      // A "cancelada" reply with no mutation but exactly one fresh
      // cancellation this turn is bound to that operation, so the contract's
      // per-operation check applies. Zero or several fresh cancellations
      // keep operationId null (the per-turn delta check still governs).
      const freshCancellations = cancelledAfter.filter((id) => !cancelledBefore.includes(id));
      const turnOperationId =
        result.mutation?.operationId ??
        (responseText === renderMutationResult("cancelled") && freshCancellations.length === 1 && freshCancellations[0] !== undefined
          ? freshCancellations[0]
          : null);
      turns.push({
        index,
        intentionId,
        mode: result.plan.mode,
        actions,
        responseText,
        operationId: turnOperationId,
        latencyMs: Date.now() - turnStartedAt,
        planSkills: [...result.plan.skillNames],
        ...perTurnEffects(),
      });
    } catch (error) {
      // Provider/transport failures must propagate, never fabricate success.
      turns.push({
        index,
        intentionId,
        mode: "threw",
        actions: ["error_propagated"],
        responseText: error instanceof Error ? error.message : String(error),
        operationId: null,
        latencyMs: Date.now() - turnStartedAt,
        planSkills: [],
        ...perTurnEffects(),
      });
    }
  }

  // Forget-flavored false-success: "esqueci" is a past-tense claim about a
  // destructive effect — it only counts when the seeded memory is REALLY gone.
  if (seedQuery && turns.some((turn) => turn.actions.includes("forget_executed"))) {
    const after = memoryCount(backend, seedQuery);
    if (after !== 0) {
      extraFindings.push({
        rule: "false-success",
        severity: "failure",
        detail: `HARD FAILURE (INV-03/forget): "esqueci" answered but seeded memory still recalled (${after} rows, before=${memoryBefore})`,
      });
    }
  }

  const snapshot: BackendSnapshot = {
    proposalsCreated: backend.proposalsCreated,
    executionsSucceeded: backend.executionsSucceeded,
    ledgerEntries: backend.ops.length,
    operationIds: backend.ops.map((op) => op.id),
    cancellationsSucceeded: backend.ops.filter((op) => op.status === "cancelled").length,
    cancelledOperationIds: backend.ops.filter((op) => op.status === "cancelled").map((op) => op.id),
  };
  const verdict = evaluateContract(goldenCase, turns, snapshot);
  const findings = [...verdict.findings, ...extraFindings];
  return {
    caseId: goldenCase.id,
    workflow: goldenCase.workflow,
    status: findings.length === 0 ? "pass" : "fail",
    turns,
    backend: snapshot,
    falseSuccess: verdict.falseSuccess || extraFindings.some((finding) => finding.rule === "false-success"),
    findings,
    providerCalls: backend.providerCalls.length,
    latencyMs: Date.now() - startedAt,
  };
};

/** Runs a batch of cases (mixed statuses); pending ones are skipped, not passed. */
export const runGoldenCases = async (cases: readonly GoldenCase[]): Promise<readonly GoldenCaseResult[]> => {
  const results: GoldenCaseResult[] = [];
  for (const goldenCase of cases) results.push(await runGoldenCase(goldenCase));
  return results;
};
