#!/usr/bin/env node
// Checks remaining legacy integrations; A0/WorkspaceAgent retirement checks
// were removed with the runtime they guarded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_FILES = [
  "apps/whatsapp-bridge/src/server.ts",
  "apps/whatsapp-bridge/src/agent-runner.ts",
  "apps/whatsapp-bridge/src/process-manager.ts",
  ".pi/extensions/financial-tools/index.ts",
  "docs/ops/vps-access.md",
  "docs/architecture/runtime-ownership-matrix.md",
];
export const LEGACY_PATTERNS = [
  { name: "Evolution Webhook", pattern: /\/webhooks\/evolution/g, category: "rollback-only" },
  { name: "Bridge Subprocess", pattern: /AgentRunner|ProcessManager/g, category: "rollback-only" },
  { name: "Pi RPC Extension", pattern: /\.pi\/extensions\/financial-tools/g, category: "rollback-only" },
  { name: "Evolution Env Vars", pattern: /EVOLUTION_API_URL|EVOLUTION_API_KEY|EVOLUTION_INSTANCE/g, category: "secret-name" },
  { name: "Legacy Pi Web App", pattern: /\.\.\/pi-finance-web/g, category: "historical-doc" },
];

export function scanLegacyReferences({ stage = "pre-retirement" } = {}) {
  const findings = [];
  for (const relativePath of CHECK_FILES) {
    const file = path.join(ROOT, relativePath);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const item of LEGACY_PATTERNS) {
      item.pattern.lastIndex = 0;
      if (item.pattern.test(content)) findings.push({ item: item.name, category: item.category, path: relativePath, stage });
    }
  }
  const activeRuntimeCount = findings.filter((f) => f.category === "active-runtime").length;
  const secretNameCount = findings.filter((f) => f.category === "secret-name").length;
  return {
    stage, totalFindings: findings.length, activeRuntimeCount, secretNameCount,
    rollbackOnlyCount: findings.filter((f) => f.category === "rollback-only").length,
    findings, passed: stage !== "final" || (activeRuntimeCount === 0 && secretNameCount === 0),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const stage = process.argv.includes("--stage=final") ? "final" : "pre-retirement";
  const report = scanLegacyReferences({ stage });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
