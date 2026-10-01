// @vitest-environment node
/**
 * Live closure pure guards — RED→GREEN for closure-live-0930.
 *
 * Proves the strict contract BEFORE any production run: legacy masked
 * behavior would let 4xx/uncertain/receipt-less success, unknown-id
 * mutations, historic replays, absent-undo passes, and count drift through;
 * the new guards reject them. The pre-dispatch authorizers below run inside
 * the Playwright route handler AND here (behavioral allow-once + deny
 * matrix over dummy bodies — nondestructive, no network). No secrets, no
 * prod mutation.
 */
import { describe, expect, it } from "vitest";
import {
  assertDecisionPostSet,
  assertSingleDecisionPost,
  assertUndoOffered,
  auditEntryEntityId,
  authorizePendingDecisionWrite,
  authorizeUndoWrite,
  authorizeVerifyWrite,
  buildClosureMarkers,
  buildIdempotencyKey,
  containsForbiddenHistoricId,
  countByDescription,
  decisionPathFor,
  filterTrackedTransactions,
  findFreshUndoProposal,
  isRunOwnedEntity,
  isUncertainLock,
  readAllPages,
  validateAuditTargetAssociation,
  validateAuthoritativePendingOp,
  validateDecisionPathForOperation,
  validateLedgerCounts,
  validateNoHistoricReuse,
  validateProposalContent,
  validateReceiptBinding,
  validateScopedHeaders,
  validateTxMutationAllowed,
  validateUncertainLock,
  validateUndoRequestBody,
  validateWorkspaceScope,
  CLOSURE_ACTIVE_WS,
} from "./live-closure-guards";

describe("live-closure-guards", () => {
  it("builds unique RUN_ID markers owned by the run", () => {
    const m = buildClosureMarkers("abc123");
    expect(m.accountName).toContain("abc123");
    expect(m.txDescEdit).toContain("abc123");
    expect(isRunOwnedEntity(m.txDesc, "abc123")).toBe(true);
    expect(isRunOwnedEntity("dado antigo sem marcador", "abc123")).toBe(false);
  });

  it("builds persistent numeric idempotency keys (stable per seq, no random churn)", () => {
    expect(buildIdempotencyKey("run1", 0)).toBe("run1-0");
    expect(buildIdempotencyKey("run1", 7)).toBe("run1-7");
    expect(buildIdempotencyKey("run1", 7)).toBe(buildIdempotencyKey("run1", 7));
    expect(() => buildIdempotencyKey("run1", -1)).toThrow();
    expect(() => buildIdempotencyKey("  ", 0)).toThrow();
  });

  it("RED: succeeds-without-receipt is rejected (legacy would resolve as success)", () => {
    expect(() =>
      validateReceiptBinding({ operationId: "op-1", status: "succeeded" }, "op-1"),
    ).toThrow(/canonical execution receipt/);
  });

  it("RED: receipt bound to another operation is rejected", () => {
    expect(() =>
      validateReceiptBinding(
        {
          operationId: "op-1",
          status: "succeeded",
          receipt: {
            status: "succeeded",
            operationId: "op-other",
            mutationId: "mut-1",
            entity: { type: "transaction", id: "tx-1" },
          },
        },
        "op-1",
      ),
    ).toThrow(/canonical execution receipt/);
  });

  it("accepts a canonical succeeded receipt bound to the operation and returns the new entity id", () => {
    expect(
      validateReceiptBinding(
        {
          operationId: "op-1",
          status: "succeeded",
          receipt: {
            status: "succeeded",
            operationId: "op-1",
            mutationId: "mut-1",
            entity: { type: "transaction", id: "tx-new" },
          },
        },
        "op-1",
      ),
    ).toBe("tx-new");
  });

  it("RED: duplicate or missing decision POST fails exactly-once", () => {
    const expected = decisionPathFor(CLOSURE_ACTIVE_WS, "op-1");
    expect(() => assertSingleDecisionPost([], expected)).toThrow(/exactly one/);
    expect(() => assertSingleDecisionPost([expected, expected], expected)).toThrow(/exactly one/);
    expect(() => assertSingleDecisionPost([expected], expected)).not.toThrow();
    expect(() =>
      assertDecisionPostSet([expected], [expected, `${expected}-other`]),
    ).toThrow(/mismatch/);
  });

  it("RED: historic approval/transaction ids are forbidden (never mutated or replayed)", () => {
    expect(containsForbiddenHistoricId("op 14915dbd replay")).toBe(true);
    expect(containsForbiddenHistoricId("tx 60b657d5 replay")).toBe(true);
    expect(containsForbiddenHistoricId("op-novo-uuid")).toBe(false);
    expect(() => validateNoHistoricReuse(["op-novo", "14915dbd"])).toThrow(/forbidden/);
    expect(() => validateNoHistoricReuse(["op-novo", "tx-novo"])).not.toThrow();
  });

  it("workspace scope is strict Test Family", () => {
    expect(() => validateWorkspaceScope(CLOSURE_ACTIVE_WS, CLOSURE_ACTIVE_WS)).not.toThrow();
    expect(() => validateWorkspaceScope("outro-ws", CLOSURE_ACTIVE_WS)).toThrow(/workspace scope/);
  });

  it("header scope requires the test workspace header (case-insensitive)", () => {
    expect(() => validateScopedHeaders({ "X-Workspace-Id": CLOSURE_ACTIVE_WS }, CLOSURE_ACTIVE_WS)).not.toThrow();
    expect(() => validateScopedHeaders({ "x-workspace-id": CLOSURE_ACTIVE_WS }, CLOSURE_ACTIVE_WS)).not.toThrow();
    expect(() => validateScopedHeaders({}, CLOSURE_ACTIVE_WS)).toThrow(/must carry/);
    expect(() => validateScopedHeaders({ "X-Workspace-Id": "outro-ws" }, CLOSURE_ACTIVE_WS)).toThrow(/must carry/);
  });

  it("RED: uncertain result locks the card (no Confirm/Cancel/Retry until refresh)", () => {
    expect(isUncertainLock("approval.execution_uncertain")).toBe(true);
    expect(isUncertainLock("agent.execution_outcome_unknown")).toBe(true);
    expect(isUncertainLock("ok")).toBe(false);
    expect(() =>
      validateUncertainLock("approval.execution_uncertain", { confirm: false, cancel: false, retry: false }),
    ).not.toThrow();
    expect(() =>
      validateUncertainLock("approval.execution_uncertain", { confirm: true, cancel: false, retry: false }),
    ).toThrow(/lock the card/);
  });

  it("RED: PATCH/DELETE on an unknown id is refused (closed set holds only this run's creations)", () => {
    expect(() => validateTxMutationAllowed("tx-unknown", ["tx-run-1"])).toThrow(/closed set/);
    expect(() => validateTxMutationAllowed("", ["tx-run-1"])).toThrow(/empty id/);
    expect(() => validateTxMutationAllowed("tx-run-1", ["tx-run-1"])).not.toThrow();
  });

  it("RED: another run's entity is not owned (description check alone never authorizes the id)", () => {
    expect(isRunOwnedEntity("Teste E2E closure outro-run", "este-run")).toBe(false);
    expect(() => validateTxMutationAllowed("tx-other-run", ["tx-este-run"])).toThrow(/closed set/);
  });

  it("RED: historic operation id in a decision path is refused", () => {
    const historicOp = "14915dbd-0000-4000-8000-000000000000";
    expect(() =>
      validateDecisionPathForOperation(decisionPathFor(CLOSURE_ACTIVE_WS, historicOp), CLOSURE_ACTIVE_WS, historicOp),
    ).toThrow(/forbidden/);
    const op = "11111111-2222-4333-8444-555555555555";
    expect(() =>
      validateDecisionPathForOperation(decisionPathFor(CLOSURE_ACTIVE_WS, op), CLOSURE_ACTIVE_WS, op),
    ).not.toThrow();
    expect(() =>
      validateDecisionPathForOperation(decisionPathFor(CLOSURE_ACTIVE_WS, "op-other"), CLOSURE_ACTIVE_WS, op),
    ).toThrow(/outside this run/);
  });

  it("RED: proposal content must bind before the click (wrong amount/account blocks)", () => {
    const expected = { description: "TED", accountLabel: "Conta X", categoryLabel: "Lanche", amountCents: 200 };
    expect(() => validateProposalContent(expected, expected)).not.toThrow();
    expect(() =>
      validateProposalContent({ ...expected, amountCents: 999 }, expected),
    ).toThrow(/mismatch/);
    expect(() =>
      validateProposalContent({ ...expected, accountLabel: "Outra conta" }, expected),
    ).toThrow(/mismatch/);
  });

  it("RED: authoritative pending-op binding requires exact args (tool/status/amount/desc/account/category)", () => {
    const expected = {
      operationId: "op-1",
      status: "proposed",
      tool: "transactions.expense.create",
      amountCents: 200,
      description: "TED",
      accountId: "acc-1",
      categoryId: "cat-1",
    };
    const actual = {
      id: "op-1",
      status: "proposed",
      tool: "transactions.expense.create",
      amountCents: 200,
      description: "TED",
      date: "2026-09-30",
      accountId: "acc-1",
      categoryId: "cat-1",
    };
    expect(() => validateAuthoritativePendingOp(actual, expected)).not.toThrow();
    expect(() => validateAuthoritativePendingOp({ ...actual, amountCents: 999 }, expected)).toThrow(/amount/);
    expect(() => validateAuthoritativePendingOp({ ...actual, accountId: "acc-2" }, expected)).toThrow(/account/);
    expect(() => validateAuthoritativePendingOp({ ...actual, categoryId: "cat-9" }, expected)).toThrow(/category/);
    expect(() => validateAuthoritativePendingOp({ ...actual, status: "executing" }, expected)).toThrow(/status/);
    expect(() => validateAuthoritativePendingOp({ ...actual, tool: "transactions.income.create" }, expected)).toThrow(/tool/);
    expect(() => validateAuthoritativePendingOp({ ...actual, description: "Outra" }, expected)).toThrow(/description/);
  });

  it("RED: absent undo never passes (fail-blocked, not annotation-pass)", () => {
    expect(() => assertUndoOffered(false, "live undo")).toThrow(/BLOCKED/);
    expect(() => assertUndoOffered(true, "live undo")).not.toThrow();
  });

  it("RED: undo body must name the live proposal (shape + historic audit)", () => {
    expect(validateUndoRequestBody({ decision: "confirm", requestId: "req-live-1" }, "confirm")).toBe("req-live-1");
    expect(() => validateUndoRequestBody({ decision: "confirm" }, "confirm")).toThrow(/requestId/);
    expect(() => validateUndoRequestBody({ decision: "cancel", requestId: "req-live-1" }, "confirm")).toThrow(/must be confirm/);
    expect(() =>
      validateUndoRequestBody({ decision: "confirm", requestId: "req-14915dbd" }, "confirm"),
    ).toThrow(/forbidden/);
  });

  it("RED: ledger recovery counts are exact (1 edited, 0 undone TED, 0 cancelled)", () => {
    const expected = { edited: 1, ted: 0, ted2: 0 };
    expect(() => validateLedgerCounts({ edited: 1, ted: 0, ted2: 0 }, expected)).not.toThrow();
    expect(() => validateLedgerCounts({ edited: 1, ted: 1, ted2: 0 }, expected)).toThrow(/ted/);
    expect(() => validateLedgerCounts({ edited: 0, ted: 0, ted2: 0 }, expected)).toThrow(/edited/);
    expect(() => validateLedgerCounts({ edited: 1, ted: 0 }, expected)).toThrow(/keys mismatch/);
  });

  it("RED: offpage duplicates are counted across the full ledger (>100 items)", () => {
    const items = Array.from({ length: 105 }, (_, i) => ({
      id: `tx-${i}`,
      description: `outra ${i}`,
    }));
    items[0]!.description = "alvo";
    items[104]!.description = "alvo";
    expect(countByDescription(items, "alvo")).toBe(2);
    expect(countByDescription(items.slice(0, 100), "alvo")).toBe(1);
    expect(countByDescription(items, "inexistente")).toBe(0);
  });

  it("readAllPages concatenates every validated page (second-page/offpage duplicates included)", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `tx-${i}`, n: i }));
    all[150]!.id = "dup";
    all[249]!.id = "dup";
    const pager = async (offset: number, limit: number) => ({
      status: 200,
      items: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit,
    });
    const result = await readAllPages(pager, 100);
    expect(result.status).toBe(200);
    expect(result.items).toHaveLength(250);
    expect(result.items.filter((t) => t.id === "dup")).toHaveLength(2);
    expect(result.items.map((t) => t.n)).toEqual(all.map((t) => t.n));
  });

  it("readAllPages FAILs on empty-premature, total-change, offset-mismatch, non-2xx, bad total", async () => {
    const ok = async (offset: number, limit: number) => ({ status: 200, items: [{ id: "a" }], total: 1, offset, limit });
    await expect(readAllPages(ok, 100)).resolves.toMatchObject({ status: 200, items: [{ id: "a" }] });
    const emptyPremature = async (offset: number, limit: number) => ({ status: 200, items: [], total: 5, offset, limit });
    await expect(readAllPages(emptyPremature, 100)).rejects.toThrow(/empty page before total/);
    let calls = 0;
    const totalChange = async (offset: number, limit: number) => {
      calls += 1;
      return { status: 200, items: [{ id: `t${calls}` }], total: calls === 1 ? 3 : 4, offset, limit };
    };
    await expect(readAllPages(totalChange, 100)).rejects.toThrow(/total changed/);
    const offsetMismatch = async (offset: number, limit: number) => ({ status: 200, items: [{ id: "a" }], total: 1, offset: offset + 1, limit });
    await expect(readAllPages(offsetMismatch, 100)).rejects.toThrow(/offset mismatch/);
    const failed = async (offset: number, limit: number) => ({ status: 500, items: [], total: 0, offset, limit });
    await expect(readAllPages(failed, 100)).rejects.toThrow(/failed with status 500/);
    const badTotal = async (offset: number, limit: number) => ({ status: 200, items: [], total: 1.5, offset, limit });
    await expect(readAllPages(badTotal, 100)).rejects.toThrow(/non-integer total/);
  });

  it("filterTrackedTransactions keeps only the created account + tracked descriptions", () => {
    const items = [
      { id: "t1", description: "alvo", amountCents: 100, accountId: "acc-run", categoryId: "cat-1" },
      { id: "t2", description: "alvo", amount_cents: 200, account_id: "acc-run", category_id: "cat-2" },
      { id: "t3", description: "alvo", amountCents: 300, accountId: "acc-outra" },
      { id: "t4", description: "outra", amountCents: 400, accountId: "acc-run" },
    ];
    const tracked = filterTrackedTransactions(items, "acc-run", ["alvo"]);
    expect(tracked).toHaveLength(2);
    expect(tracked[0]).toMatchObject({ id: "t1", amountCents: 100, categoryId: "cat-1" });
    expect(tracked[1]).toMatchObject({ id: "t2", amountCents: 200, categoryId: "cat-2" });
  });

  it("audit association proof needs the single entry bound to the confirmed entity", () => {
    const entry = {
      id: "audit-1",
      operation: "transactions.expense.create",
      actorId: "actor-1",
      effectRef: "tx-new",
      metadata: {},
      createdAt: "2026-09-30T12:01:00.000Z",
    };
    const expected = { entityId: "tx-new", operation: "transactions.expense.create", notBefore: "2026-09-30T12:00:00.000Z" };
    expect(validateAuditTargetAssociation([entry], expected)).toBe("audit-1");
    expect(auditEntryEntityId({ effectRef: "e1", metadata: { entityId: "e2" } })).toBe("e1");
    expect(auditEntryEntityId({ metadata: { entityId: "e2" } })).toBe("e2");
    expect(auditEntryEntityId({})).toBeNull();
    expect(() => validateAuditTargetAssociation([], expected)).toThrow(/BLOCKED/);
    expect(() => validateAuditTargetAssociation([entry, entry], expected)).toThrow(/BLOCKED/);
    expect(() =>
      validateAuditTargetAssociation([{ ...entry, operation: "transactions.income.create" }], expected),
    ).toThrow(/BLOCKED/);
    expect(() =>
      validateAuditTargetAssociation([{ ...entry, createdAt: "2026-09-30T11:00:00.000Z" }], expected),
    ).toThrow(/predates/);
    expect(() =>
      validateAuditTargetAssociation([{ ...entry, id: "audit-14915dbd" }], expected),
    ).toThrow(/forbidden/);
  });

  it("RED: authoritative binding works from presentation ids when top-level args are omitted (lean relay)", () => {
    const expected = {
      operationId: "op-1",
      status: "proposed",
      tool: "transactions.expense.create",
      amountCents: 200,
      description: "TED",
      accountId: "acc-1",
      categoryId: "cat-1",
    };
    const lean = {
      id: "op-1",
      status: "proposed",
      tool: "transactions.expense.create",
      createdAt: "2026-09-30T12:00:00.000Z",
      expiresAt: "2026-09-30T13:00:00.000Z",
      presentation: {
        id: "op-1",
        status: "proposed",
        tool: "transactions.expense.create",
        title: "Confirmar despesa",
        amountCents: 200,
        description: "TED",
        date: "2026-09-30",
        account: { id: "acc-1", label: "Conta X" },
        category: { id: "cat-1", label: "Lanche" },
        expiresAt: "2026-09-30T13:00:00.000Z",
        warnings: [],
      },
    };
    expect(() => validateAuthoritativePendingOp(lean, expected)).not.toThrow();
    // Both sources present and agreeing also binds.
    expect(() =>
      validateAuthoritativePendingOp(
        { ...lean, amountCents: 200, description: "TED", accountId: "acc-1", categoryId: "cat-1" },
        expected,
      ),
    ).not.toThrow();
    // Disagreement between sources blocks (neither is trusted over the other).
    expect(() =>
      validateAuthoritativePendingOp({ ...lean, accountId: "acc-2" }, expected),
    ).toThrow(/disagrees/);
    expect(() =>
      validateAuthoritativePendingOp(
        { ...lean, presentation: { ...lean.presentation, amountCents: 999 } },
        expected,
      ),
    ).toThrow(/amount/);
    // Neither source binds the account.
    expect(() => validateAuthoritativePendingOp({
      id: "op-1",
      status: "proposed",
      tool: "transactions.expense.create",
      amountCents: 200,
      description: "TED",
    }, expected)).toThrow(/account/);
    // Presentation bound to another operation.
    expect(() =>
      validateAuthoritativePendingOp(
        { ...lean, presentation: { ...lean.presentation, id: "op-other" } },
        expected,
      ),
    ).toThrow(/presentation id/);
  });

  it("fresh undo proposal proof requires exactly one new actionable id", () => {
    const before = [{ requestId: "req-old", status: "confirmed", expiresAt: "t" }];
    const after = [...before, { requestId: "req-fresh", status: "proposed", expiresAt: "t" }];
    expect(findFreshUndoProposal(before, after)).toEqual({ requestId: "req-fresh", status: "proposed" });
    expect(() => findFreshUndoProposal(before, before)).toThrow(/BLOCKED/);
    expect(() => findFreshUndoProposal(before, [...after, { requestId: "req-x", status: "proposed", expiresAt: "t" }])).toThrow(/BLOCKED/);
    expect(() =>
      findFreshUndoProposal(before, [...before, { requestId: "req-60b657d5", status: "proposed", expiresAt: "t" }]),
    ).toThrow(/forbidden/);
    expect(() =>
      findFreshUndoProposal(before, [...before, { requestId: "req-z", status: "failed", expiresAt: "t" }]),
    ).toThrow(/not actionable/);
  });

  describe("pre-dispatch agent-write authorizers (route guard contract)", () => {
    const ws = CLOSURE_ACTIVE_WS;
    const op = "11111111-2222-4333-8444-555555555555";
    const expectedDecision = { workspaceId: ws, operationId: op, decision: "confirm" as const };
    const goodBody = JSON.stringify({ decision: "confirm", requestId: "req-1" });

    it("allows the exact authorized decision once", () => {
      const auth = authorizePendingDecisionWrite({ pathWorkspace: ws, operationId: op, bodyText: goodBody }, expectedDecision);
      expect(auth).toEqual({ allowed: true, reason: expect.any(String) });
    });

    it("denies every non-conforming decision write before dispatch", () => {
      expect(authorizePendingDecisionWrite({ pathWorkspace: ws, operationId: op, bodyText: goodBody }, undefined).allowed).toBe(false);
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: ws, operationId: "op-unknown", bodyText: goodBody },
        expectedDecision,
      ).allowed).toBe(false);
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: "outro-ws", operationId: op, bodyText: goodBody },
        expectedDecision,
      ).allowed).toBe(false);
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: ws, operationId: op, bodyText: JSON.stringify({ decision: "cancel", requestId: "req-1" }) },
        expectedDecision,
      ).allowed).toBe(false);
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: ws, operationId: op, bodyText: JSON.stringify({ decision: "confirm" }) },
        expectedDecision,
      ).allowed).toBe(false);
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: ws, operationId: op, bodyText: "not-json" },
        expectedDecision,
      ).allowed).toBe(false);
      expect(authorizePendingDecisionWrite({ pathWorkspace: ws, operationId: op, bodyText: "" }, expectedDecision).allowed).toBe(false);
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: ws, operationId: op, bodyText: JSON.stringify({ decision: "confirm", requestId: "req-1", note: "14915dbd" }) },
        expectedDecision,
      ).allowed).toBe(false);
      // Historic op id can never be registered or dispatched.
      expect(authorizePendingDecisionWrite(
        { pathWorkspace: ws, operationId: "14915dbd", bodyText: goodBody },
        { workspaceId: ws, operationId: "14915dbd", decision: "confirm" },
      ).allowed).toBe(false);
    });

    it("allows the exact captured undo once and denies near-misses", () => {
      const expectedUndo = { workspaceId: ws, requestId: "req-live-9", decision: "confirm" as const };
      const undoBody = JSON.stringify({ decision: "confirm", requestId: "req-live-9" });
      expect(authorizeUndoWrite({ pathWorkspace: ws, bodyText: undoBody }, expectedUndo).allowed).toBe(true);
      expect(authorizeUndoWrite({ pathWorkspace: ws, bodyText: undoBody }, undefined).allowed).toBe(false);
      expect(authorizeUndoWrite(
        { pathWorkspace: ws, bodyText: JSON.stringify({ decision: "confirm", requestId: "req-live-10" }) },
        expectedUndo,
      ).allowed).toBe(false);
      expect(authorizeUndoWrite(
        { pathWorkspace: ws, bodyText: JSON.stringify({ decision: "cancel", requestId: "req-live-9" }) },
        expectedUndo,
      ).allowed).toBe(false);
      expect(authorizeUndoWrite(
        { pathWorkspace: "outro-ws", bodyText: undoBody },
        expectedUndo,
      ).allowed).toBe(false);
      expect(authorizeUndoWrite(
        { pathWorkspace: ws, bodyText: JSON.stringify({ decision: "confirm", requestId: "req-live-9", op: "60b657d5" }) },
        expectedUndo,
      ).allowed).toBe(false);
    });

    it("allows the exact captured verify once and denies near-misses (pre-grant)", () => {
      const expectedVerify = { workspaceId: ws, requestId: "req-live-9", entityType: "transaction", entityId: "tx-new" };
      const goodBody = JSON.stringify({ expectedEntity: { type: "transaction", id: "tx-new" } });
      const actual = { pathWorkspace: ws, pathRequestId: "req-live-9", bodyText: goodBody };
      expect(authorizeVerifyWrite(actual, expectedVerify)).toEqual({ allowed: true, reason: expect.any(String) });
      expect(authorizeVerifyWrite(actual, undefined).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, pathRequestId: "req-other" },
        expectedVerify,
      ).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, pathWorkspace: "outro-ws" },
        expectedVerify,
      ).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, bodyText: JSON.stringify({ expectedEntity: { type: "transaction", id: "tx-other" } }) },
        expectedVerify,
      ).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, bodyText: JSON.stringify({ expectedEntity: { type: "account", id: "tx-new" } }) },
        expectedVerify,
      ).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, bodyText: JSON.stringify({ expectedEntity: { type: "transaction", id: "tx-new" }, extra: 1 }) },
        expectedVerify,
      ).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, bodyText: JSON.stringify({ expectedEntity: { type: "transaction", id: "tx-new", op: "x" } }) },
        expectedVerify,
      ).allowed).toBe(false);
      expect(authorizeVerifyWrite({ ...actual, bodyText: "not-json" }, expectedVerify).allowed).toBe(false);
      expect(authorizeVerifyWrite({ ...actual, bodyText: "" }, expectedVerify).allowed).toBe(false);
      expect(authorizeVerifyWrite(
        { ...actual, bodyText: JSON.stringify({ expectedEntity: { type: "transaction", id: "tx-14915dbd" } }) },
        expectedVerify,
      ).allowed).toBe(false);
    });
  });
});
