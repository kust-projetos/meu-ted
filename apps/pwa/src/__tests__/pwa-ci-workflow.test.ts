import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/pwa-ci.yml"), "utf8");

describe("PWA CI audit trigger", () => {
  it("watches the scoped audit scripts it executes", () => {
    expect(workflow).toContain('"scripts/pwa-audit*"');
    expect(workflow).toContain("node --test scripts/pwa-audit-policy.test.mjs");
    expect(workflow).not.toContain('"scripts/check-pwa-audit.mjs"');
  });
});

describe("PWA CI e2e job", () => {
  it("builds shared contracts before the comprehensive E2E runner", () => {
    // The Next build inside run-ci.sh resolves @pi-finance/llm-contracts via
    // dist (gh run 36726347704 failed with "Can't resolve
    // @pi-finance/llm-contracts/types" without it) — same command as quality.
    const e2eJob = workflow.slice(workflow.indexOf("\n  e2e:"));
    expect(e2eJob).toContain("pnpm --filter @pi-finance/llm-contracts build");
    expect(e2eJob).toContain("bash apps/pwa/e2e/run-ci.sh");
    expect(e2eJob.indexOf("pnpm --filter @pi-finance/llm-contracts build")).toBeLessThan(
      e2eJob.indexOf("bash apps/pwa/e2e/run-ci.sh"),
    );
  });
});
