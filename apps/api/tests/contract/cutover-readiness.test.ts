import { describe, it, expect } from "vitest";
import { evaluateCutoverReadiness } from "../../../../scripts/cutover-check.js";

describe("Cutover Readiness Contract", () => {
  it("evaluates all cutover preconditions and passes under current codebase state", async () => {
    const report = await evaluateCutoverReadiness({
      divergenceRateOverride: 0.0,
    });

    expect(report.allPassed).toBe(true);
    expect(report.checks).toHaveLength(5);
    for (const check of report.checks) {
      expect(check.passed).toBe(true);
    }
  });

});
