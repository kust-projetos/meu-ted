/**
 * F4 Golden Workflows (issue #105) — machine-readable JSON reporter, v1.
 *
 * Metrics are measured or explicitly `unknown` — never invented:
 * - `latencyMs` is the wall-clock of the isolated run (real, local).
 * - `tokens`/`cost` are `unknown`: the runner uses a deterministic stub, no
 *   model call happens, so there is nothing to count. A future real-provider
 *   run fills these from the provider response.
 */
import type { GoldenCaseResult } from "../runner.js";

export type GoldenReport = Readonly<{
  version: "1";
  generatedAt: string;
  summary: Readonly<{
    total: number;
    pass: number;
    fail: number;
    skippedPending: number;
    executable: number;
    falseSuccessCases: number;
    successRate: number | null;
    falseSuccessRate: number | null;
    providerCalls: number;
    latencyMs: number;
    tokens: "unknown";
    cost: "unknown";
  }>;
  cases: readonly (Omit<GoldenCaseResult, "turns"> & {
    turns: readonly {
      index: number;
      intentionId: string;
      mode: string;
      actions: readonly string[];
      operationId: string | null;
      latencyMs: number;
      responseExcerpt: string;
    }[];
  })[];
}>;

export const buildGoldenReport = (results: readonly GoldenCaseResult[]): GoldenReport => {
  const pass = results.filter((result) => result.status === "pass").length;
  const fail = results.filter((result) => result.status === "fail").length;
  const skippedPending = results.filter((result) => result.status === "skipped-pending").length;
  const executable = pass + fail;
  const falseSuccessCases = results.filter((result) => result.falseSuccess).length;
  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      pass,
      fail,
      skippedPending,
      executable,
      falseSuccessCases,
      successRate: executable > 0 ? pass / executable : null,
      falseSuccessRate: executable > 0 ? falseSuccessCases / executable : null,
      providerCalls: results.reduce((sum, result) => sum + result.providerCalls, 0),
      latencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
      tokens: "unknown",
      cost: "unknown",
    },
    cases: results.map((result) => ({
      ...result,
      turns: result.turns.map((turn) => ({
        index: turn.index,
        intentionId: turn.intentionId,
        mode: turn.mode,
        actions: turn.actions,
        operationId: turn.operationId,
        latencyMs: turn.latencyMs,
        responseExcerpt: turn.responseText.slice(0, 200),
      })),
    })),
  };
};
