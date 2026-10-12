/**
 * F4 Golden Workflows (issue #105) — isolated backend, v1.
 *
 * Everything the runner touches lives in memory: an append-only operation
 * ledger with idempotency-key semantics, seeded entity lists, a deterministic
 * evidence provider and a claim-free response stub. No Worker runtime, no
 * network, no production, no real money, no LLM.
 *
 * The fake `request` implements just enough of the authoritative V2 approval
 * API for `MutationApiClient` to run its REAL code path (propose → confirm →
 * execute with receipt validation): the client, the executor and the
 * coordinator are production code; only the transport is doubled.
 */
import type { ApiRequestOptions } from "../../../src/tools/api-client.js";
import type { EntityReader, EntitySummary } from "../../../src/mutations/entity-resolver.js";
import type { EvidenceEnvelope } from "../../../src/evidence/evidence-envelope.js";
import { createEvidenceEnvelope } from "../../../src/evidence/evidence-envelope.js";
import {
  initializeMemorySchema,
  rememberFact,
  type MemorySql,
} from "../../../src/agent-config/memory/store.js";
import { createMemorySql, type MemorySqlMock } from "../../helpers/memory-sql.js";
import type { GoldenInitialState } from "./schema.js";

export type IsolatedOp = Readonly<{
  id: string;
  tool: string;
  normalizedArgs: Record<string, unknown>;
  idempotencyKey: string;
  status: "proposed" | "executed" | "cancelled";
  transactionId: string | null;
  /**
   * Round 3 P1-A: authoritative proposal-time stamps, like the real
   * `pending-v2` API (`createdAt` is when the proposal was created, NOT the
   * listing time). The confirmation temporal check compares these against
   * the intention's first-sighting instant — a listing-time stamp would be
   * born after the sighting by construction and would invert the fence.
   */
  createdAt: string;
  expiresAt: string;
}>;

const stableStringify = (value: unknown): string => JSON.stringify(value) ?? "";

export class IsolatedBackend {
  readonly ops: IsolatedOp[] = [];
  readonly providerCalls: string[] = [];
  private readonly byIdempotency = new Map<string, { id: string; bodyHash: string }>();
  // Review round 4 P1-B: authoritative intentionId frontier (mirror of
  // `pending_operation_confirmation_intentions`): first bind wins, repeats
  // return the stored instant, confirm enforces the operation binding.
  private readonly intentions = new Map<string, { firstSeenAt: string }>();
  private readonly intentionBindings = new Map<string, string>();
  private intentionKey(headers: Record<string, string | number | undefined>, intentionId: string): string {
    const ws = String(headers['x-workspace-id'] ?? '');
    const actor = String(headers['x-actor-id'] ?? '');
    const device = String(headers['x-device-id'] ?? '');
    return `${ws}|${actor}|${device}|${intentionId}`;
  }
  private opSeq = 0;
  private txSeq = 0;
  private proposeFailuresLeft: number;
  private readonly proposeAlwaysFails: boolean;
  private readonly reads: NonNullable<GoldenInitialState["reads"]>;
  private readonly readData: GoldenInitialState["readData"];
  private readonly absenceReason: string;
  readonly accounts: EntitySummary[];
  readonly categories: EntitySummary[];
  readonly memorySql: MemorySql;

  constructor(initial: GoldenInitialState = {}) {
    this.reads = initial.reads ?? "ok-empty";
    this.readData = initial.readData;
    this.absenceReason = initial.absenceReason ?? "period_empty";
    this.proposeFailuresLeft = initial.faults?.failProposeTimes ?? 0;
    this.proposeAlwaysFails = initial.faults?.failProposeAlways ?? false;
    this.accounts = (initial.accounts ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
    this.categories = (initial.categories ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
    const mock: MemorySqlMock = createMemorySql();
    initializeMemorySchema(mock as unknown as MemorySql);
    this.memorySql = mock as unknown as MemorySql;
    for (const memory of initial.memory ?? []) {
      rememberFact(this.memorySql, {
        workspaceId: "ws-golden",
        actor: "actor-golden",
        kind: memory.kind,
        content: memory.content,
      });
    }
  }

  get proposalsCreated(): number {
    return this.ops.length;
  }

  get executionsSucceeded(): number {
    return this.ops.filter((op) => op.status === "executed").length;
  }

  /** The exact `requestPiApiJson`-shaped seam `MutationApiClient` calls. */
  readonly request = async <T>(method: string, path: string, opts: ApiRequestOptions = {}): Promise<T> => {
    const ok = (value: unknown): Promise<T> => Promise.resolve(value as T);
    if (method === "POST" && path === "/pending-operations/v2/propose") {
      if (this.proposeAlwaysFails) throw Object.assign(new Error("golden.transient_propose_failure"), { statusCode: 503 });
      if (this.proposeFailuresLeft > 0) {
        this.proposeFailuresLeft -= 1;
        throw Object.assign(new Error("golden.transient_propose_failure"), { statusCode: 503 });
      }
      const body = (opts.body ?? {}) as { tool?: unknown; normalizedArgs?: unknown; expiresAt?: unknown };
      const key = opts.idempotencyKey ?? "";
      const bodyHash = stableStringify({ tool: body.tool, normalizedArgs: body.normalizedArgs });
      const seen = this.byIdempotency.get(key);
      if (seen) {
        // SPEC §7.7.1: same (key, payload) replays the existing operation;
        // a divergent payload under the same key is a conflict, never a
        // second operation.
        if (seen.bodyHash !== bodyHash) throw Object.assign(new Error("idempotency.conflict"), { statusCode: 409 });
        return ok({ id: seen.id, existing: true });
      }
      this.opSeq += 1;
      const id = `golden-op-${this.opSeq}`;
      this.ops.push({
        id,
        tool: typeof body.tool === "string" ? body.tool : "unknown",
        normalizedArgs: (body.normalizedArgs ?? {}) as Record<string, unknown>,
        idempotencyKey: key,
        status: "proposed",
        transactionId: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      this.byIdempotency.set(key, { id, bodyHash });
      return ok({ id, existing: false });
    }
    const activeMatch = method === "GET" && path === "/pending-operations/v2/active";
    if (activeMatch) {
      const items = this.ops
        .filter((op) => op.status === "proposed")
        .map((op) => ({
          id: op.id,
          status: "proposed",
          tool: op.tool,
          createdAt: op.createdAt,
          expiresAt: op.expiresAt,
        }));
      return ok({ items, total: items.length });
    }
    const confirmMatch = method === "POST" && /^\/pending-operations\/v2\/[^/]+\/confirm$/.test(path);
    if (confirmMatch) {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      const op = this.ops.find((entry) => entry.id === id);
      if (!op || op.status !== "proposed") throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      // Review round 4 P1-B: intentionId→operationId enforcement (mirror of
      // the API): identical re-binds proceed, divergent bindings are refused
      // with zero effect.
      const confirmBody = (opts.body ?? {}) as { intentionId?: unknown };
      if (typeof confirmBody.intentionId === "string" && confirmBody.intentionId !== "") {
        const key = this.intentionKey(opts.headers ?? {}, confirmBody.intentionId);
        const bound = this.intentionBindings.get(key);
        if (bound !== undefined && bound !== id) {
          throw Object.assign(new Error("approval.intention_conflict"), { statusCode: 409, code: "approval.intention_conflict" });
        }
        if (bound === undefined) this.intentionBindings.set(key, id);
      }
      return ok({ id, attestation: `golden-attestation-${id}-0123456789abcdef` });
    }
    // Review round 4 P1-B: authoritative intention bind (first durable writer
    // wins; repeats return the stored instant with any bound operation).
    const bindMatch = method === "POST" && path === "/pending-operations/v2/confirmation-intentions/bind";
    if (bindMatch) {
      const bindBody = (opts.body ?? {}) as { intentionId?: unknown };
      const intentionId = typeof bindBody.intentionId === "string" ? bindBody.intentionId : "";
      if (!intentionId) throw Object.assign(new Error("validation.error"), { statusCode: 400 });
      const key = this.intentionKey(opts.headers ?? {}, intentionId);
      const existing = this.intentions.get(key);
      if (existing) {
        return ok({ firstSeenAt: existing.firstSeenAt, fresh: false, operationId: this.intentionBindings.get(key) ?? null });
      }
      const at = new Date().toISOString();
      this.intentions.set(key, { firstSeenAt: at });
      return ok({ firstSeenAt: at, fresh: true, operationId: this.intentionBindings.get(key) ?? null });
    }
    const executeMatch = method === "POST" && /^\/pending-operations\/v2\/[^/]+\/execute$/.test(path);
    if (executeMatch) {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      const index = this.ops.findIndex((entry) => entry.id === id);
      const op = this.ops[index];
      if (!op || op.status !== "proposed") throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      // Review round 4 P1-B: divergent intention bindings are refused with
      // zero effect (mirror of the API execute verify).
      const executeBody = (opts.body ?? {}) as { intentionId?: unknown };
      if (typeof executeBody.intentionId === "string" && executeBody.intentionId !== "") {
        const key = this.intentionKey(opts.headers ?? {}, executeBody.intentionId);
        const bound = this.intentionBindings.get(key);
        if (bound !== undefined && bound !== id) {
          throw Object.assign(new Error("approval.intention_conflict"), { statusCode: 409, code: "approval.intention_conflict" });
        }
      }
      this.txSeq += 1;
      const transactionId = `golden-tx-${this.txSeq}`;
      const mutationId = `golden-mutation-${this.txSeq}`;
      const mutationKind = op.tool === "transactions.income.create" ? "transactions.income.create" : "transactions.expense.create";
      const affectedTargets =
        mutationKind === "transactions.income.create"
          ? ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"]
          : ["transactions", "accounts", "dashboard-summary", "budgets", "quick-insights"];
      this.ops[index] = { ...op, status: "executed", transactionId };
      const receipt = {
        mutationId,
        mutationKind,
        status: "succeeded",
        affectedTargets,
        operationId: id,
        entity: { type: "transaction", id: transactionId },
      };
      return ok({
        id,
        status: "succeeded",
        execution: { status: "succeeded", operationId: transactionId, mutationId, receipt },
      });
    }
    const cancelMatch = method === "POST" && /^\/pending-operations\/v2\/[^/]+\/cancel$/.test(path);
    if (cancelMatch) {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      const index = this.ops.findIndex((entry) => entry.id === id);
      const op = this.ops[index];
      if (!op) throw Object.assign(new Error("approval.not_found"), { statusCode: 404 });
      this.ops[index] = { ...op, status: "cancelled", transactionId: op.transactionId };
      return ok({ id, status: "cancelled" });
    }
    throw Object.assign(new Error(`golden.unmocked_request:${method}:${path}`), { statusCode: 500 });
  };

  readonly entityReader: EntityReader = {
    listAccounts: async () => [...this.accounts],
    listCategories: async () => [...this.categories],
  };

  /** Evidence for the read path, per the case `reads` scenario. */
  readonly evidenceProvider = async (): Promise<EvidenceEnvelope> => {
    const at = new Date().toISOString();
    if (this.reads === "throw") throw new Error("golden.evidence_transport_failure");
    if (this.reads === "error") {
      return createEvidenceEnvelope([
        { ref: "accounts", source: "isolated", retrievedAt: at, status: "error", reason: "permanent_error", data: null },
        { ref: "transactions", source: "isolated", retrievedAt: at, status: "error", reason: "permanent_error", data: null },
      ]);
    }
    if (this.reads === "ok-data") {
      const accounts = (this.readData?.accounts ?? this.accounts) as unknown;
      const transactions = (this.readData?.transactions ?? []) as unknown;
      return createEvidenceEnvelope([
        { ref: "accounts", source: "isolated", retrievedAt: at, status: "ok", data: accounts },
        { ref: "transactions", source: "isolated", retrievedAt: at, status: "ok", data: transactions },
      ]);
    }
    return createEvidenceEnvelope([
      { ref: "accounts", source: "isolated", retrievedAt: at, status: "empty", reason: this.absenceReason as never, data: [] },
      { ref: "transactions", source: "isolated", retrievedAt: at, status: "empty", reason: this.absenceReason as never, data: [] },
    ]);
  };

  /**
   * Deterministic oracle stub for the generative provider: neutral,
   * claim-free pt-BR text. If a golden response ever carries a financial
   * success claim, it comes from deterministic production copy — which is
   * exactly what the contract validates against the ledger.
   */
  readonly responseProvider = async (): Promise<string> => {
    this.providerCalls.push("response");
    return "Resposta de leitura do harness isolado, sem alegações financeiras.";
  };
}
