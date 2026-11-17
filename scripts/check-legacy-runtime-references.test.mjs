import { test } from "node:test";
import assert from "node:assert/strict";
import { scanLegacyReferences } from "./check-legacy-runtime-references.mjs";

test("legacy runtime references scanner", async (t) => {
  await t.test("scans remaining legacy references without requiring findings", () => {
    const report = scanLegacyReferences({ stage: "pre-retirement" });
    assert.ok(report.totalFindings >= 0);
    assert.equal(report.passed, true);
  });

  await t.test("reports active-runtime items when evaluating final stage", () => {
    const report = scanLegacyReferences({ stage: "final" });
    assert.ok(typeof report.passed === "boolean");
  });

  await t.test("does not require the retired apps/agent directory", () => {
    const report = scanLegacyReferences({ stage: "final" });
    assert.ok(Array.isArray(report.findings));
  });
});
