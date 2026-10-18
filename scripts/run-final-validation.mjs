#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VAL_GATES = [
  { id: "VAL.1", name: "Reproducible Frozen Install", command: "git diff --exit-code -- pnpm-lock.yaml" },
  { id: "VAL.2", name: "Lint & Documentation", command: "pnpm --filter @pi-finance/llm-contracts --fail-if-no-match lint && pnpm lint && pnpm docs:lint" },
  { id: "VAL.3", name: "TypeScript Compilation", command: "pnpm typecheck" },
  { id: "VAL.4", name: "API Unit & Contract Tests", command: "pnpm --filter meu-ted-api --fail-if-no-match test" },
  { id: "VAL.5", name: "Agent Tests & Deterministic Evals", command: "pnpm --filter pi-finance-agent --fail-if-no-match test && pnpm --filter pi-finance-agent --fail-if-no-match eval:ted-v2" },
  { id: "VAL.6", name: "Codex Broker", command: "pnpm --filter pi-finance-codex-broker --fail-if-no-match typecheck && pnpm --filter pi-finance-codex-broker --fail-if-no-match test && pnpm --filter pi-finance-codex-broker --fail-if-no-match build" },
  { id: "VAL.7", name: "PWA Unit & Contract Tests", command: "pnpm --filter pwa --fail-if-no-match test" },
  { id: "VAL.8", name: "Architecture Invariants", command: "pnpm architecture:check" },
  { id: "VAL-V4.9", name: "Workspace Agent Decommission Guards (ARCH-V4-06a/b)", command: "node scripts/check-legacy-runtime-references.mjs --check=all" },
  { id: "VAL.9", name: "Capabilities, Write Policy, Boundary & Governance", command: "pnpm capabilities:check && pnpm write-policy:check && pnpm boundary:check && pnpm governance:check" },
  { id: "VAL.10", name: "Canonical Documentation Contracts", command: "node --test scripts/canonical-docs-contract.test.mjs scripts/documentation-facts-contract.test.mjs scripts/lint-docs.test.mjs scripts/documentation-gates-t13.test.mjs" },
  { id: "VAL.11", name: "Builds & Distribution Artifacts", command: "pnpm build:all" },
  { id: "VAL.12", name: "Security & Container Smoke", command: "pnpm security:check && pnpm container:smoke" },
  { id: "VAL.13", name: "Production Smoke Contract", command: "pnpm production:smoke:contract" },
  // V4.1 Phase 9 (Task 9.5): CI/CD hardening gates. Integration/concurrency/XLT
  // suites are env-gated per-file (skip cleanly without Postgres, run with it),
  // so they are unconditional commands; migration validation reports a skip
  // without DATABASE_URL instead of failing (see scripts/migration-validate.mjs).
  { id: "VAL.14", name: "API Integration Suite (all)", command: "pnpm --filter meu-ted-api --fail-if-no-match test:integration:all" },
  { id: "VAL.15", name: "Financial Concurrency Suite", command: "pnpm --filter meu-ted-api --fail-if-no-match test:concurrency" },
  { id: "VAL.16", name: "XLT Suite", command: "pnpm --filter meu-ted-api --fail-if-no-match test:xlt" },
  { id: "VAL.17", name: "Skip/Todo + Action-Pin Gates", command: "pnpm test:skip-gate && pnpm action-pins:check" },
  { id: "VAL.18", name: "Migration Validation + Dependency Audit", command: "node scripts/migration-validate.mjs && pnpm security:deps" },
];

export function executeValidationGate(gate, executor = execFileSync) {
  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  try {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArg = isWindows ? "/c" : "-c";

    const output = executor(shell, [shellArg, gate.command], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    stdout = output || "";
  } catch (err) {
    exitCode = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout || "";
    stderr = err.stderr || err.message || "";
  }

  const endedAt = new Date().toISOString();
  return {
    id: gate.id,
    name: gate.name,
    command: gate.command,
    startedAt,
    endedAt,
    exitCode,
    status: exitCode === 0 ? "PASSED" : "FAILED",
    summary: exitCode === 0 ? "Execution completed successfully with exit code 0" : `Execution failed with exit code ${exitCode}`,
    stdoutPreview: (stdout || "").slice(0, 300),
    stderrPreview: (stderr || "").slice(0, 300),
  };
}

export function runFinalValidation(gates = VAL_GATES, executor = execFileSync) {
  const results = [];
  let allPassed = true;

  for (const gate of gates) {
    const res = executeValidationGate(gate, executor);
    results.push(res);
    if (res.exitCode !== 0) {
      allPassed = false;
      break; // fail-closed on first error
    }
  }

  return {
    evaluatedAt: new Date().toISOString(),
    totalGates: gates.length,
    executedGates: results.length,
    passedGates: results.filter((r) => r.status === "PASSED").length,
    failedGates: results.filter((r) => r.status === "FAILED").length,
    allPassed,
    results,
  };
}

export function generateFinalValidationMarkdown(report) {
  return `# Final Project Validation Report (VAL.1–VAL.18)

**Evaluated At:** ${report.evaluatedAt}  
**Status:** ${report.allPassed ? "PASSED ✅" : "FAILED ❌"}  
**Total Gates:** ${report.totalGates} | **Passed:** ${report.passedGates} | **Failed:** ${report.failedGates}  

## Gate Execution Ledger

| ID | Gate Name | Command | Exit Code | Status |
|---|---|---|---|---|
${report.results.map((r) => `| **${r.id}** | ${r.name} | \`${r.command}\` | ${r.exitCode} | ${r.status === "PASSED" ? "PASS ✅" : "FAIL ❌"} |`).join("\n")}

## Execution Details

${report.results
  .map(
    (r) => `### ${r.id} — ${r.name}
- **Command:** \`${r.command}\`
- **Duration:** ${r.startedAt} → ${r.endedAt}
- **Result:** ${r.summary}
`
  )
  .join("\n")}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log("=== Running Project Final Validation (VAL.1–VAL.18) ===");
  const report = runFinalValidation();
  const reportsDir = path.join(ROOT, "docs", "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const jsonPath = path.join(reportsDir, "2026-09-13-final-validation.json");
  const mdPath = path.join(reportsDir, "2026-09-13-final-validation.md");


  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(mdPath, generateFinalValidationMarkdown(report), "utf8");

  console.log(`Validation finished with status: ${report.allPassed ? "PASSED ✅" : "FAILED ❌"}`);
  console.log(`Saved artifacts to:`);
  console.log(` - ${jsonPath}`);
  console.log(` - ${mdPath}`);

  if (!report.allPassed) {
    process.exit(1);
  }
}
