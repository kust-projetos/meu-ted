#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findMarkdownFiles(dir = ROOT) {
  const mdFiles = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT, fullPath);

    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".next", "dist", "coverage", ".wrangler"].includes(entry.name)) {
        continue;
      }
      mdFiles.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      mdFiles.push(relPath);
    }
  }

  return mdFiles;
}

export function lintMarkdownDocument(relPath) {
  const fullPath = path.join(ROOT, relPath);
  const content = fs.readFileSync(fullPath, "utf8");
  const issues = [];

  // 1. Check for broken relative links (excluding external URLs and anchors)
  const linkMatches = [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  for (const match of linkMatches) {
    const target = match[2].trim();
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#") || target.startsWith("mailto:") || target.startsWith("file://") || target.startsWith("conversation://")) {
      continue;
    }

    const cleanTarget = target.split("#")[0]?.split("?")[0];
    if (!cleanTarget) continue;

    const baseDir = path.dirname(fullPath);
    const resolvedTarget = cleanTarget.startsWith("/")
      ? path.join(ROOT, cleanTarget.slice(1))
      : path.resolve(baseDir, cleanTarget);

    if (!fs.existsSync(resolvedTarget)) {
      issues.push(`Broken link to '${target}' in ${relPath}`);
    }
  }

  // 2. Check for unresolved template placeholders
  if (/\[INSERT\s+|<placeholder>/i.test(content)) {
    issues.push(`Unresolved placeholder found in ${relPath}`);
  }

  return issues;
}

export function lintAllDocumentation() {
  const docs = [
    "README.md",
    "AGENTS.md",
    "docs/PRODUCT.md",
    "docs/ARCHITECTURE-CURRENT.md",
    "docs/ARCHITECTURE-TARGET.md",
    "docs/ROADMAP.md",
    "docs/adr/README.md",
    "docs/MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md",
    "docs/MEU-TED-SPEC-HARDENING-SIMPLIFICACAO-E-DESCOMISSIONAMENTO-V4.md",
    "docs/superpowers/plans/2026-09-14-meu-ted-v3-hardening.md",
    "docs/superpowers/plans/2026-09-15-meu-ted-v4-hardening.md",
    "docs/runbooks/backup-restore.md",
    // T13: living V1 docs + audit evidence (additive only — never remove entries).
    "docs/MEU-TED-V1-FINAL-STATE.md",
    "docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md",
    "docs/RELEASE-PROCESS.md",
    "docs/agent/2026-10-18-ted-agent-flag-matrix.md",
    "docs/reports/2026-10-17-full-project-review.md",
  ];

  const allIssues = [];
  for (const doc of docs) {
    const full = path.join(ROOT, doc);
    if (!fs.existsSync(full)) {
      allIssues.push(`Missing canonical document: ${doc}`);
      continue;
    }
    const issues = lintMarkdownDocument(doc);
    allIssues.push(...issues);
  }

  return {
    checkedCount: docs.length,
    issues: allIssues,
    passed: allIssues.length === 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = lintAllDocumentation();
  console.log("=== Documentation Consistency Lint ===");
  console.log(`Documents Checked: ${result.checkedCount}`);
  console.log(`Issues Found:      ${result.issues.length}`);
  console.log(`Status:            ${result.passed ? "PASSED ✅" : "FAILED ❌"}`);
  if (!result.passed) {
    for (const issue of result.issues) {
      console.error(` - ${issue}`);
    }
    process.exit(1);
  }
}
