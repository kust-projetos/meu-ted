#!/usr/bin/env node
/**
 * Workflows YAML structural gate (follow-up #13 — incident 8c6ef48).
 *
 * Textual contracts (action pinning, docs lint) cannot catch a workflow
 * file that is not even parseable YAML: an unquoted step `name:` containing
 * `: ` breaks parsing, so `Gate — all checks` never materializes. This gate
 * parses every `*.yml` / `*.yaml` under `.github/workflows` with a real YAML
 * parser and fails closed on the first sign of structural damage.
 *
 * Policy:
 * - default dir is `.github/workflows`, resolved from the repo ROOT so the
 *   gate behaves the same regardless of the caller's cwd;
 * - `WORKFLOWS_YAML_DIR` overrides the directory (absolute or ROOT-relative)
 *   and exists ONLY for tests — production paths never use it;
 * - a missing directory is fail-closed (exit 1), never a silent pass;
 * - an empty file (no YAML document) is fail-closed: GitHub rejects empty
 *   workflow files, so the gate mirrors that instead of counting them as OK;
 * - ALL parse errors are listed before exiting (same pattern as
 *   check-public-safety.mjs), so one broken file cannot hide another.
 *
 * Exit codes: 0 — every workflow file parsed; 1 — missing dir, empty file,
 * or at least one parse error.
 *
 * Usage: node scripts/check-workflows-yaml.mjs
 *        WORKFLOWS_YAML_DIR=/tmp/fixtures node scripts/check-workflows-yaml.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = process.env.WORKFLOWS_YAML_DIR
  ? path.resolve(ROOT, process.env.WORKFLOWS_YAML_DIR)
  : path.join(ROOT, ".github", "workflows");

console.log("=== Workflows YAML gate ===");

if (!fs.existsSync(WORKFLOWS_DIR) || !fs.statSync(WORKFLOWS_DIR).isDirectory()) {
  console.error(`FAIL: workflows directory not found: ${WORKFLOWS_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort();

const errors = [];
let parsed = 0;

for (const file of files) {
  const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
  if (content.trim() === "") {
    errors.push({ file, message: "empty file (no YAML document)" });
    continue;
  }
  try {
    parse(content);
    parsed++;
  } catch (err) {
    // First line only: full YAML errors carry source snippets that would
    // flood CI logs; the file name plus the parser's headline pin the fault.
    errors.push({ file, message: String(err?.message ?? err).split("\n")[0] });
  }
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} workflow file(s) failed YAML parse:`);
  for (const e of errors) console.error(` - [workflows-yaml] ${e.file}: ${e.message}`);
  process.exit(1);
}

console.log(`OK: workflows-yaml gate passed — ${parsed} workflow file(s) parsed`);
