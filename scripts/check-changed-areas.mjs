#!/usr/bin/env node
/**
 * Selects the area-specific gates that apply to a diff.
 *
 * Common commits only run `commit:check`. This script is the opt-in bridge:
 * it runs documentation, governance, agent-policy, PWA-boundary and workflow
 * checks only when the changed paths touch their area.
 *
 * Usage:
 *   node scripts/check-changed-areas.mjs            # run applicable gates
 *   node scripts/check-changed-areas.mjs --dry-run  # print them
 *   node scripts/check-changed-areas.mjs --json     # machine-readable plan
 *   node scripts/check-changed-areas.mjs --base <sha> --github-output
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const AREA_RULES = [
  { area: "api", patterns: [/^apps\/api\//, /^packages\/llm-contracts\//] },
  {
    area: "agent",
    patterns: [
      /^apps\/agent\//,
      /^apps\/codex-broker\//,
      /^apps\/ted-runtime\//,
      /^packages\/llm-contracts\//,
      /^scripts\/generate-agent-tools\.mjs$/,
      /^docs\/architecture\/tool-capability-inventory\.md$/,
    ],
  },
  { area: "docs", patterns: [/^docs\/.*\.md$/, /^README\.md$/, /^AGENTS\.md$/] },
  {
    area: "governance",
    patterns: [
      /^docs\/adr\//,
      /^docs\/decisions\//,
      /^docs\/(ROADMAP|PRODUCT|ARCHITECTURE-CURRENT|ARCHITECTURE-TARGET)\.md$/,
    ],
  },
  { area: "pwa", patterns: [/^apps\/pwa\//] },
  { area: "tests", patterns: [/\.test\.(ts|tsx|mjs)$/, /(^|\/)tests\//] },
  {
    area: "workflows",
    patterns: [/^\.github\/workflows\//, /^scripts\/check-(action-pins|workflows-yaml)\.(mjs|test\.mjs)$/],
  },
];

export const AREA_COMMANDS = {
  docs: ["pnpm docs:lint"],
  governance: ["pnpm plans:check", "pnpm governance:check"],
  agent: ["pnpm architecture:check", "pnpm capabilities:check", "pnpm write-policy:check"],
  pwa: ["pnpm boundary:check"],
  tests: ["pnpm test:skip-gate"],
  workflows: ["pnpm action-pins:check", "pnpm workflows-yaml:check"],
};

export function classifyFiles(files) {
  const areas = {};
  for (const { area, patterns } of AREA_RULES) {
    areas[area] = files.some((file) => patterns.some((pattern) => pattern.test(file)));
  }
  return areas;
}

export function selectCommands(areas) {
  const commands = [];
  for (const [area, enabled] of Object.entries(areas)) {
    if (!enabled) continue;
    for (const command of AREA_COMMANDS[area] ?? []) {
      if (!commands.includes(command)) commands.push(command);
    }
  }
  return commands;
}

function resolveBase(explicitBase) {
  if (explicitBase) return explicitBase;
  try {
    return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    try {
      return execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }
}

function workingTreeFiles() {
  const output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let file = line.slice(3).replace(/^"|"$/g, "");
      const arrow = file.indexOf(" -> ");
      if (arrow >= 0) file = file.slice(arrow + 4);
      return file;
    });
}

function changedFiles(base) {
  const args = base
    ? ["diff", "--name-only", `${base}...HEAD`]
    : ["ls-files"];
  const tracked = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  return [...new Set([...tracked, ...workingTreeFiles()])];
}

function appendGithubOutputs(areas) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  const lines = Object.entries(areas).map(([area, enabled]) => `${area}=${enabled ? "true" : "false"}`);
  fs.appendFileSync(target, `${lines.join("\n")}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const githubOutput = args.includes("--github-output");
  const baseIndex = args.indexOf("--base");
  const explicitBase = baseIndex >= 0 ? args[baseIndex + 1] : undefined;

  const base = resolveBase(explicitBase);
  const files = changedFiles(base);
  const areas = classifyFiles(files);
  const commands = selectCommands(areas);

  if (githubOutput) appendGithubOutputs(areas);

  if (json || dryRun) {
    console.log(JSON.stringify({ base, files, areas, commands }, null, 2));
    return;
  }

  if (commands.length === 0) {
    console.log(`check:area — no area-specific gate for ${files.length} changed file(s)`);
    return;
  }

  for (const command of commands) {
    console.log(`check:area — ${command}`);
    execSync(command, { cwd: ROOT, stdio: "inherit", shell: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
