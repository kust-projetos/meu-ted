// V4.1 Tasks 3.8-3.10 (SPEC §10.5): the commands layer is the INTENT boundary.
// One user action → one command id; automatic retries reuse it; definitive
// rejections never blind-retry.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCommands, type CommandsContext } from "../commands";
import * as endpoints from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeContext(dispatch = vi.fn()): CommandsContext {
  return { online: true, token: "tok", dispatch, api: endpoints };
}

function txInput() {
  return {
    description: "Mercado",
    amountCents: 15000,
    date: "2026-09-01",
    categoryId: "cat-1",
    accountId: "acc-1",
  };
}

function keyOf(spy: { mock: { calls: unknown[][] } }, call = 0): unknown {
  const args = spy.mock.calls[call] as [{ idempotencyKey?: unknown }] | undefined;
  return args?.[0]?.idempotencyKey;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("commands — command id at the intent boundary (Task 3.8)", () => {
  it("stamps exactly one command id per intent when the caller provides none", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction").mockResolvedValue({ id: "tx-1" } as never);
    const commands = createCommands(makeContext());

    await commands.createExpenseTransaction(txInput());

    expect(apiSpy).toHaveBeenCalledOnce();
    expect(keyOf(apiSpy)).toMatch(UUID_V4);
  });

  it("preserves a caller-provided command id verbatim", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction").mockResolvedValue({ id: "tx-1" } as never);
    const commands = createCommands(makeContext());

    await commands.createExpenseTransaction({ ...txInput(), idempotencyKey: "intent-key-abc" });

    expect(keyOf(apiSpy)).toBe("intent-key-abc");
  });

  it("two distinct intents get two distinct command ids", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockResolvedValueOnce({ id: "tx-1" } as never)
      .mockResolvedValueOnce({ id: "tx-2" } as never);
    const commands = createCommands(makeContext());

    await commands.createExpenseTransaction(txInput());
    await commands.createExpenseTransaction(txInput());

    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(keyOf(apiSpy, 0)).toMatch(UUID_V4);
    expect(keyOf(apiSpy, 1)).toMatch(UUID_V4);
    expect(keyOf(apiSpy, 0)).not.toBe(keyOf(apiSpy, 1));
  });

  it("threads a stable command id for id-only mutations (markPayablePaid)", async () => {
    const apiSpy = vi.spyOn(endpoints, "markPayablePaid").mockResolvedValue({ id: "pay-1" } as never);
    const commands = createCommands(makeContext());

    await commands.markPayablePaid("pay-1", "2026-09-01");

    expect(apiSpy).toHaveBeenCalledOnce();
    expect(apiSpy.mock.calls[0]?.[2]).toMatch(UUID_V4);
  });
});

describe("commands — same id across retry/timeout/unknown (Task 3.9)", () => {
  it("retries a 503 once with the SAME command id and converges", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new ApiError(503, "server.error", "flaky"))
      .mockResolvedValueOnce({ id: "tx-1" } as never);
    const dispatch = vi.fn();
    const commands = createCommands(makeContext(dispatch));

    const res = await commands.createExpenseTransaction(txInput());

    expect(res).toEqual({ id: "tx-1" });
    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(keyOf(apiSpy, 0)).toBe(keyOf(apiSpy, 1));
    expect(dispatch).toHaveBeenCalledWith({ type: "CLEAR_WRITE_ERROR" });
  });

  it("retries a network drop once with the SAME command id", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: "tx-1" } as never);
    const commands = createCommands(makeContext());

    await commands.createExpenseTransaction(txInput());

    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(keyOf(apiSpy, 0)).toBe(keyOf(apiSpy, 1));
  });

  it("id-only mutations retry with the SAME threaded command id", async () => {
    const apiSpy = vi.spyOn(endpoints, "markPayablePaid")
      .mockRejectedValueOnce(new ApiError(500, "server.error", "flaky"))
      .mockResolvedValueOnce({ id: "pay-1" } as never);
    const commands = createCommands(makeContext());

    await commands.markPayablePaid("pay-1", "2026-09-01");

    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(apiSpy.mock.calls[0]?.[2]).toBe(apiSpy.mock.calls[1]?.[2]);
  });

  it("does NOT retry definitive 4xx rejections", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new ApiError(422, "validation.error", "bad input"));
    const commands = createCommands(makeContext());

    await expect(commands.createExpenseTransaction(txInput())).rejects.toMatchObject({ status: 422 });
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry 409 conflicts — surfaces the original-receipt signal", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new ApiError(409, "idempotency.conflict", "replayed"));
    const commands = createCommands(makeContext());

    await expect(commands.createExpenseTransaction(txInput())).rejects.toMatchObject({ status: 409 });
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry domain 409 refusals as idempotency replay (FIX-184)", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new ApiError(409, "in_use", "possui lançamentos ativos"));
    const commands = createCommands(makeContext());

    await expect(commands.createExpenseTransaction(txInput())).rejects.toMatchObject({
      status: 409,
      code: "in_use",
    });
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it("retries 409 idempotency.in_progress once with the SAME command id (FIX-184)", async () => {
    const apiSpy = vi.spyOn(endpoints, "createExpenseTransaction")
      .mockRejectedValueOnce(new ApiError(409, "idempotency.in_progress", "em processamento"))
      .mockResolvedValueOnce({ id: "tx-1" } as never);
    const commands = createCommands(makeContext());

    const res = await commands.createExpenseTransaction(txInput());

    expect(res).toEqual({ id: "tx-1" });
    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(keyOf(apiSpy, 0)).toBe(keyOf(apiSpy, 1));
  });
});
