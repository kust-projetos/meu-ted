// V4.1 Tasks 3.8-3.10 (SPEC §10.5 Client command ID): the idempotency key is
// a per-INTENT command id, not a per-HTTP-attempt id. Unit contract for the
// command-id module (intent-boundary creation + retry preservation policy).
import { describe, it, expect, vi } from "vitest";
import { ApiError } from "./client";
import {
  newCommandId,
  ensureCommandId,
  getFailedCommandId,
  isRetryableMutationError,
  isIdempotencyConflict,
  retryMutationWithSameCommandId,
  MAX_COMMAND_ATTEMPTS,
} from "./command-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("command-id — intent-boundary creation (Task 3.8)", () => {
  it("newCommandId mints a valid UUID v4", () => {
    expect(newCommandId()).toMatch(UUID_V4);
  });

  it("two intents get two distinct ids", () => {
    expect(newCommandId()).not.toBe(newCommandId());
  });

  it("ensureCommandId stamps a fresh id when the intent carries none", () => {
    const out = ensureCommandId({ description: "x" });
    expect(out.idempotencyKey).toMatch(UUID_V4);
  });

  it("ensureCommandId never mutates the caller's intent object", () => {
    const input = { description: "x" };
    const out = ensureCommandId(input);
    expect(input).not.toHaveProperty("idempotencyKey");
    expect(out).not.toBe(input);
  });

  it("ensureCommandId preserves a caller-provided id verbatim", () => {
    const input = { description: "x", idempotencyKey: "caller-key-1" };
    const out = ensureCommandId(input);
    expect(out.idempotencyKey).toBe("caller-key-1");
    expect(out).toBe(input);
  });

  it("two retries of one intent share 1 id; two distinct intents get 2 ids", () => {
    const intent = ensureCommandId({ description: "same intent" });
    const retrySameIntent = ensureCommandId(intent);
    expect(retrySameIntent.idempotencyKey).toBe(intent.idempotencyKey);
    const otherIntent = ensureCommandId({ description: "other intent" });
    expect(otherIntent.idempotencyKey).not.toBe(intent.idempotencyKey);
  });
});

describe("command-id — retry preservation policy (Task 3.9)", () => {
  it.each([
    ["network TypeError (connection drop)", new TypeError("fetch failed"), true],
    ["timeout ApiError", new ApiError(408, "network.timeout", "timeout"), true],
    ["408 with unrelated code stays retryable", new ApiError(408, "other.code", "timeout"), true],
    ["409 with network.timeout code (definitive, never retry)", new ApiError(409, "network.timeout", "conflict"), false],
    ["400 with network.timeout code (definitive, never retry)", new ApiError(400, "network.timeout", "bad"), false],
    ["500", new ApiError(500, "server.error", "boom"), true],
    ["502", new ApiError(502, "server.error", "boom"), true],
    ["503", new ApiError(503, "server.error", "boom"), true],
    ["unknown non-ApiError", new Error("weird"), true],
    ["400 definitive rejection", new ApiError(400, "validation.error", "bad"), false],
    ["401", new ApiError(401, "auth.error", "no"), false],
    ["403", new ApiError(403, "auth.forbidden", "no"), false],
    ["404", new ApiError(404, "not_found", "no"), false],
    ["409 domain conflict (definitive, never retry)", new ApiError(409, "conflict", "dup"), false],
    ["409 in_use (definitive domain refusal, never retry)", new ApiError(409, "in_use", "em uso"), false],
    ["409 workspace.invalid (definitive domain refusal, never retry)", new ApiError(409, "workspace.invalid", "pessoal duplicado"), false],
    ["409 approval.not_pending (definitive domain refusal, never retry)", new ApiError(409, "approval.not_pending", "já processada"), false],
    ["409 idempotency.conflict (divergent payload, definitive, never retry)", new ApiError(409, "idempotency.conflict", "payload diferente"), false],
    ["409 idempotency.in_progress (same-key retriable, unknown outcome)", new ApiError(409, "idempotency.in_progress", "em processamento"), true],
    ["409 with empty code (fail-closed, never retry)", new ApiError(409, "", "sem código"), false],
    ["409 with generic code (fail-closed, never retry)", new ApiError(409, "error", "genérico"), false],
    ["422", new ApiError(422, "validation.error", "bad"), false],
    ["caller abort", new DOMException("aborted", "AbortError"), false],
  ])("%s → retryable=%s", (_label, err, expected) => {
    expect(isRetryableMutationError(err)).toBe(expected);
  });

  it("isIdempotencyConflict is true ONLY for typed idempotency 409s (FIX-184)", () => {
    // Authoritative idempotency signals: same-key retriable (in_progress)
    // and divergent-payload conflict — both carry an `idempotency.*` code.
    expect(isIdempotencyConflict(new ApiError(409, "idempotency.conflict", "x"))).toBe(true);
    expect(isIdempotencyConflict(new ApiError(409, "idempotency.in_progress", "x"))).toBe(true);
    // Domain refusals sharing status 409 must NEVER read as idempotency replay.
    for (const code of [
      "conflict",
      "in_use",
      "approval.not_pending",
      "workspace.invalid",
      "agent.version_conflict",
      "agent.runtime_in_use",
      "undo.executing",
      "network.timeout",
      "error",
      "",
    ]) {
      expect(isIdempotencyConflict(new ApiError(409, code, "x"))).toBe(false);
    }
    // Status gate still applies: idempotency codes off-409 are not conflicts.
    expect(isIdempotencyConflict(new ApiError(500, "idempotency.conflict", "x"))).toBe(false);
    expect(isIdempotencyConflict(new ApiError(400, "idempotency.in_progress", "x"))).toBe(false);
    expect(isIdempotencyConflict(new ApiError(500, "server.error", "x"))).toBe(false);
    expect(isIdempotencyConflict(new TypeError("fetch failed"))).toBe(false);
  });

  it("defaults to a bounded attempt budget", () => {
    expect(MAX_COMMAND_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });

  it("reuses the SAME id across a retry after a retryable failure", async () => {
    const seen: string[] = [];
    const attempt = vi.fn(async (commandId: string) => {
      seen.push(commandId);
      if (seen.length === 1) throw new ApiError(503, "server.error", "flaky");
      return "receipt-ok";
    });
    const out = await retryMutationWithSameCommandId(attempt);
    expect(out.result).toBe("receipt-ok");
    expect(out.attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(out.commandId).toBe(seen[0]);
  });

  it("does NOT retry definitive 4xx rejections", async () => {
    const attempt = vi.fn(async (): Promise<string> => {
      throw new ApiError(422, "validation.error", "bad input");
    });
    await expect(retryMutationWithSameCommandId(attempt)).rejects.toMatchObject({ status: 422 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-retry a definitive 400 carrying a network.timeout code (definitive status wins)", async () => {
    const attempt = vi.fn(async (): Promise<string> => {
      throw new ApiError(400, "network.timeout", "bad request with timeout code");
    });
    await expect(retryMutationWithSameCommandId(attempt)).rejects.toMatchObject({ status: 400 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry 409 conflicts (server already holds the original receipt)", async () => {
    const attempt = vi.fn(async (): Promise<string> => {
      throw new ApiError(409, "idempotency.conflict", "replayed");
    });
    await expect(retryMutationWithSameCommandId(attempt)).rejects.toMatchObject({ status: 409 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget, reusing the same id on every attempt", async () => {
    const seen: string[] = [];
    const attempt = vi.fn(async (commandId: string): Promise<string> => {
      seen.push(commandId);
      throw new TypeError("fetch failed");
    });
    await expect(
      retryMutationWithSameCommandId(attempt, { maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(new Set(seen).size).toBe(1);
  });

  it("honours a caller-provided command id", async () => {
    const attempt = vi.fn(async (commandId: string) => `done:${commandId}`);
    const out = await retryMutationWithSameCommandId(attempt, { commandId: "intent-key-9" });
    expect(out.commandId).toBe("intent-key-9");
    expect(out.result).toBe("done:intent-key-9");
    expect(attempt).toHaveBeenCalledWith("intent-key-9");
  });
});

describe("command-id — FIX-184 typed 409 (code, not just status)", () => {
  it("legitimate replay is a 200 success, never a 409 (single attempt, returned verbatim)", async () => {
    const replayed = { id: "tx-1", receipt: { operationId: "op-1" } };
    const attempt = vi.fn(async (commandId: string) => ({ ...replayed, commandId }));
    const out = await retryMutationWithSameCommandId(attempt);
    expect(out.result).toMatchObject({ id: "tx-1" });
    expect(out.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("domain 409 (in_use) is definitive: rejects on the first attempt, never resolves as success", async () => {
    const attempt = vi.fn(async (): Promise<string> => {
      throw new ApiError(409, "in_use", "possui lançamentos ativos");
    });
    const failed = await retryMutationWithSameCommandId(attempt).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed).toMatchObject({ status: 409, code: "in_use" });
    expect(isIdempotencyConflict(failed)).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
    // The intent id still travels on the error for diagnosis — but the error
    // stays an error (no receipt exists to fetch, nothing converts to success).
    expect(typeof getFailedCommandId(failed)).toBe("string");
  });

  it("divergent-key 409 (idempotency.conflict) is definitive: single attempt, surfaced as-is", async () => {
    const attempt = vi.fn(async (): Promise<string> => {
      throw new ApiError(409, "idempotency.conflict", "payload diferente");
    });
    const failed = await retryMutationWithSameCommandId(attempt).catch((e: unknown) => e);
    expect(failed).toMatchObject({ status: 409, code: "idempotency.conflict" });
    expect(isIdempotencyConflict(failed)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("409 idempotency.in_progress retries once with the SAME id and converges", async () => {
    const seen: string[] = [];
    const attempt = vi.fn(async (commandId: string) => {
      seen.push(commandId);
      if (seen.length === 1) throw new ApiError(409, "idempotency.in_progress", "em processamento");
      return "receipt-ok";
    });
    const out = await retryMutationWithSameCommandId(attempt);
    expect(out.result).toBe("receipt-ok");
    expect(out.attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(out.commandId).toBe(seen[0]);
  });

  it("persistent in_progress exhausts the budget reusing the same id on every attempt", async () => {
    const seen: string[] = [];
    const attempt = vi.fn(async (commandId: string): Promise<string> => {
      seen.push(commandId);
      throw new ApiError(409, "idempotency.in_progress", "em processamento");
    });
    const failed = await retryMutationWithSameCommandId(attempt, { maxAttempts: 3 }).catch((e: unknown) => e);
    expect(failed).toMatchObject({ status: 409, code: "idempotency.in_progress" });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(new Set(seen).size).toBe(1);
  });

  it("lost response on the same key: timeout first, manual same-key retry replays the original receipt", async () => {
    const seen: string[] = [];
    const attempt = vi.fn(async (commandId: string) => {
      seen.push(commandId);
      if (seen.length === 1) throw new ApiError(408, "network.timeout", "timeout");
      return { id: "tx-1" };
    });
    const first = await retryMutationWithSameCommandId(attempt, { maxAttempts: 1 }).catch((e: unknown) => e);
    expect(first).toMatchObject({ status: 408 });
    const failedId = getFailedCommandId(first);
    expect(typeof failedId).toBe("string");
    const second = await retryMutationWithSameCommandId(attempt, { commandId: failedId, maxAttempts: 1 });
    expect(second.result).toEqual({ id: "tx-1" });
    expect(seen[0]).toBe(seen[1]);
    expect(second.commandId).toBe(failedId);
  });

  it("malformed 409 (missing/generic code) is fail-closed: definitive, never idempotent", async () => {
    for (const code of ["", "error"]) {
      const attempt = vi.fn(async (): Promise<string> => {
        throw new ApiError(409, code, "corpo sem código autoritativo");
      });
      const failed = await retryMutationWithSameCommandId(attempt).catch((e: unknown) => e);
      expect(failed).toMatchObject({ status: 409 });
      expect(isIdempotencyConflict(failed)).toBe(false);
      expect(isRetryableMutationError(failed)).toBe(false);
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });
});
