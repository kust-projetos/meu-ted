/**
 * ADR-033 S2 — browser boundary for the runtime's agent self-confirm result.
 *
 * `execution` is a terminal, READ-ONLY DTO that replaces an actionable
 * `proposal`. Strict allowlist: no attestation/idempotency key/hash may cross.
 * A `succeeded` claim is only a success with a canonical receipt bound to the
 * SAME operationId (and tool); otherwise it degrades to `unverified`, never
 * to success. The legacy `proposal` path stays byte-identical.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPendingChatSend,
  sanitizeProposalIntent,
  sanitizeSelfConfirmExecution,
  sendAgentMessage,
  composeChatSend,
  type PendingOperationReceipt,
} from "../agent-client";
import * as agentAuth from "../agent-auth";

const OP_ID = "00000000-0000-4000-8000-000000000001";
const TOOL = "transactions.expense.create";

const receipt = (overrides: Record<string, unknown> = {}): PendingOperationReceipt => ({
  mutationId: "mut-1",
  mutationKind: TOOL,
  status: "succeeded" as const,
  affectedTargets: ["transactions", "accounts"],
  operationId: OP_ID,
  entity: { type: "transaction", id: "tx-1" },
  ...overrides,
});

const execution = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  operationId: OP_ID,
  tool: TOOL,
  status: "succeeded",
  outcome: { status: "succeeded" },
  receipt: receipt(),
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeSelfConfirmExecution — strict read-only DTO", () => {
  it("accepts a succeeded execution with the canonical receipt bound to the same operationId", () => {
    const result = sanitizeSelfConfirmExecution(execution());
    expect(result).toEqual({
      operationId: OP_ID,
      tool: TOOL,
      status: "succeeded",
      receipt: receipt(),
      outcome: { status: "succeeded" },
    });
  });

  it("downgrades succeeded WITHOUT a receipt to unverified (never success)", () => {
    const result = sanitizeSelfConfirmExecution(execution({ receipt: undefined }));
    expect(result).toMatchObject({ status: "unverified", operationId: OP_ID });
    expect(result && "receipt" in result ? result.receipt : undefined).toBeUndefined();
  });

  it("downgrades succeeded with a receipt whose operationId differs to unverified", () => {
    const result = sanitizeSelfConfirmExecution(
      execution({ receipt: receipt({ operationId: "00000000-0000-4000-8000-000000000099" }) }),
    );
    expect(result?.status).toBe("unverified");
  });

  it("downgrades succeeded with a receipt for another tool to unverified", () => {
    const result = sanitizeSelfConfirmExecution(
      execution({ receipt: receipt({ mutationKind: "accounts.create", entity: { type: "account", id: "acc-1" } }) }),
    );
    expect(result?.status).toBe("unverified");
  });

  it("downgrades succeeded with a forged receipt carrying an extra key to unverified", () => {
    const result = sanitizeSelfConfirmExecution(
      execution({ receipt: { ...receipt(), attestation: "secret" } }),
    );
    expect(result?.status).toBe("unverified");
  });

  it("accepts failed (with failureCode) and unverified without a receipt", () => {
    expect(
      sanitizeSelfConfirmExecution(
        execution({ status: "failed", outcome: { status: "failed", failureCode: "in_use" }, receipt: undefined }),
      ),
    ).toEqual({
      operationId: OP_ID,
      tool: TOOL,
      status: "failed",
      outcome: { status: "failed", failureCode: "in_use" },
    });
    expect(
      sanitizeSelfConfirmExecution(
        execution({ status: "unverified", outcome: { status: "unverified" }, receipt: undefined }),
      )?.status,
    ).toBe("unverified");
  });

  it("never displays a receipt smuggled into a failed/unverified terminal", () => {
    const failed = sanitizeSelfConfirmExecution(
      execution({ status: "failed", outcome: { status: "failed" } }),
    );
    expect(failed?.status).toBe("unverified");
    expect(failed && "receipt" in failed ? failed.receipt : undefined).toBeUndefined();
  });

  it("drops the WHOLE value on any extra field (attestation / hash / idempotency key)", () => {
    expect(sanitizeSelfConfirmExecution(execution({ attestation: "one-use" }))).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(execution({ proposalHash: "abc" }))).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(execution({ idempotencyKey: "k" }))).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(execution({ status: "succeeded", extra: true }))).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(execution({ outcome: { status: "succeeded", hash: "h" } }))).toBeUndefined();
  });

  it("drops malformed values (arrays, missing outcome, unknown tool)", () => {
    expect(sanitizeSelfConfirmExecution([])).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(null)).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(execution({ outcome: undefined }))).toBeUndefined();
    expect(sanitizeSelfConfirmExecution(execution({ tool: "transactions.secret.write" }))?.status).toBe("unverified");
  });
});

describe("sendAgentMessage — execution vs legacy proposal", () => {
  const mockFetch = (body: Record<string, unknown>) => {
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("tok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(body));
  };

  it("returns a validated execution and clears the retry anchor (terminal result)", async () => {
    mockFetch({ turnId: "t-exec", status: "completed", output: "Concluído: despesa.", execution: execution() });
    const send = composeChatSend("registre a despesa");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(turn.execution).toMatchObject({ status: "succeeded", operationId: OP_ID });
    expect(loadPendingChatSend("ws-1", null)).toBeNull();
  });

  it("treats an execution with no output as a real (non-failed) result", async () => {
    mockFetch({ turnId: "t-exec-2", status: "completed", execution: execution({ status: "unverified", outcome: { status: "unverified" }, receipt: undefined }) });
    const send = composeChatSend("pague");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(turn.execution?.status).toBe("unverified");
    expect(loadPendingChatSend("ws-1", null)).toBeNull();
  });

  it("downgrades a wire 'succeeded' with no canonical receipt to unverified", async () => {
    mockFetch({
      turnId: "t-exec-3",
      status: "completed",
      output: "Concluído.",
      execution: execution({ receipt: undefined }),
    });
    const turn = await sendAgentMessage("ws-1", "registre", { messageId: "m-3" });
    expect(turn.execution?.status).toBe("unverified");
  });

  it("drops an execution carrying an attestation instead of exposing it", async () => {
    mockFetch({
      turnId: "t-exec-4",
      status: "completed",
      output: "Concluído.",
      execution: execution({ receipt: receipt(), attestation: "sensitive-one-use-capability" }),
    });
    const turn = await sendAgentMessage("ws-1", "registre", { messageId: "m-4" });
    expect(turn.execution).toBeUndefined();
  });

  it("keeps the legacy proposal path unchanged (no execution, anchor retained)", async () => {
    const legacyIntent = {
      tool: TOOL,
      intentionId: "int-legacy",
      normalizedArgs: {
        amountCents: 5000,
        description: "mercado",
        date: "2026-11-06",
        accountId: "11111111-1111-4111-8111-111111111111",
        categoryId: "22222222-2222-4222-8222-222222222222",
      },
    };
    expect(sanitizeProposalIntent(legacyIntent)).toEqual(legacyIntent);
    mockFetch({ turnId: "t-legacy", status: "completed", output: "Vou preparar.", proposal: legacyIntent });
    const send = composeChatSend("registre despesa");
    const turn = await sendAgentMessage("ws-1", send.content, { messageId: send.messageId });
    expect(turn.proposal).toEqual(legacyIntent);
    expect(turn.execution).toBeUndefined();
    expect(loadPendingChatSend("ws-1", null)?.proposal).toEqual(legacyIntent);
  });
});
