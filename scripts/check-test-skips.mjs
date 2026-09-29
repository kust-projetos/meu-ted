#!/usr/bin/env node
/**
 * V4.1 Phase 9 (Task 9.4) — skip/todo gate.
 *
 * Fails when a financial-critical test file contains an UNCONDITIONAL
 * `.skip(` / `.todo(` (a test deliberately parked instead of fixed).
 *
 * Env-gated conditional skips — the `ENABLED ? describe : describe.skip`
 * / `DB_URL ? it : it.skip` pattern used pervasively for Postgres suites —
 * are NOT violations: they run in CI with PG and skip cleanly without it.
 * Only unconditional skips in financial-critical paths fail, unless the
 * file is in ALLOWLIST with a documented reason.
 *
 * Usage: node scripts/check-test-skips.mjs [--strict]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_TESTS = path.join(ROOT, "apps", "api", "tests");
const CONTRACTS = path.join(ROOT, "packages", "llm-contracts");

// Financial-critical path matchers (relative posix path, lowercase).
const CRITICAL_PATTERNS = [
  /(^|\/)tests\/writes\//,
  /(^|\/)tests\/concurrency\//,
  /(^|\/)tests\/contract\//,
  /(^|\/)tests\/xlt\//,
  /(^|\/)tests\/integration\/postgres-(payable|goals|financial-integrity|cards|canonical-parity|idempotency|unit-of-work|statement|subscriptions|undo|write-store|store|invites)/,
  /tests\/routes\/(payable|payables|cards|goals|transaction|statement|idempotency|undo|transfer|budget|subscription)/,
  /tests\/approvals\//,
];

/**
 * Explicit allowlist: unconditional skips that are accepted archived debt,
 * each with a reason + owner. Adding an entry here is a conscious decision,
 * not a silent park.
 */
const ALLOWLIST = [
  {
    file: "apps/api/tests/approvals/pending-v2-claim.test.ts",
    reason:
      "pending-v2 Postgres claim suite deferred (Phase 7 decommission scope); in-memory contract covered elsewhere.",
  },
  {
    file: "apps/api/tests/approvals/pending-v2-fault.test.ts",
    reason:
      "pending-v2 fault-injection Postgres suite deferred (Phase 7 decommission scope).",
  },
  {
    file: "apps/api/tests/approvals/pending-v2-recovery-columns.test.ts",
    reason:
      "pending-v2 recovery-columns Postgres suite deferred (Phase 7 decommission scope).",
  },
  {
    file: "apps/api/tests/approvals/pending-v2-lease.test.ts",
    reason:
      "pending-v2 execution-lease Postgres suite deferred (Phase 7 decommission scope).",
  },
  {
    file: "apps/api/tests/approvals/pending-v2-postgres-red.test.ts",
    reason:
      "pending-v2 RED-phase Postgres contract parked until Phase 7 removal decision lands.",
  },
  {
    file: "apps/api/tests/approvals/pending-v2-uncertainty.test.ts",
    reason:
      "pending-v2 execution-uncertainty Postgres suite follows the sibling dual-store pattern (runs in CI with PG, skips cleanly without DATABASE_URL_TEST); in-memory half always runs.",
  },
  {
    file: "apps/api/tests/integration/postgres-write-store.test.ts",
    reason:
      "Legacy ESI write-store contract superseded by keyed-mutations suites; kept as archived debt reference.",
  },
  {
    file: "apps/api/tests/integration/postgres-store.test.ts",
    reason:
      "Legacy ESI store contract superseded by Postgres suites; kept as archived debt reference.",
  },
];

const allowlisted = new Set(ALLOWLIST.map((a) => a.file));

function collectTestFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function isCritical(relPosix) {
  const lower = relPosix.toLowerCase();
  return CRITICAL_PATTERNS.some((re) => re.test(lower));
}

/**
 * Returns unconditional skip/todo hits in file content.
 * A line is env-gated (OK) when it contains both `?` and `:` alongside the
 * skip — the `COND ? it : it.skip` pattern — or when the skip token appears
 * inside a README/code-fence example (handled by only scanning *.test.ts).
 */
function findUnconditionalSkips(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!/\.(skip|todo)\(/.test(line)) continue;
    // Env-gated ternary: `X ? describe : describe.skip` / `X ? it : it.skip`.
    if (line.includes("?") && line.includes(":")) continue;
    hits.push({ line: i + 1, text: trimmed.slice(0, 160) });
  }
  return hits;
}

const files = [...collectTestFiles(API_TESTS), ...collectTestFiles(CONTRACTS)];
const violations = [];
let scannedCritical = 0;

for (const full of files) {
  const rel = path.relative(ROOT, full).split(path.sep).join("/");
  if (!isCritical(rel)) continue;
  scannedCritical++;
  const content = fs.readFileSync(full, "utf8");
  const hits = findUnconditionalSkips(content);
  if (hits.length === 0) continue;
  if (allowlisted.has(rel)) continue;
  violations.push({ file: rel, hits });
}

if (process.argv.includes("--list-allowlist")) {
  console.log(JSON.stringify(ALLOWLIST, null, 2));
}

if (violations.length > 0) {
  console.error(
    `FAIL: ${violations.length} financial-critical file(s) contain unconditional .skip()/.todo():`,
  );
  for (const v of violations) {
    console.error(` - ${v.file}`);
    for (const h of v.hits) console.error(`     L${h.line}: ${h.text}`);
  }
  console.error(
    "Fix the test or add an explicit ALLOWLIST entry with reason in scripts/check-test-skips.mjs.",
  );
  process.exit(1);
}

console.log(
  `OK: skip/todo gate passed — ${scannedCritical} financial-critical file(s) scanned, ` +
    `${ALLOWLIST.length} allowlisted (archived debt with documented reason), 0 new unconditional skips.`,
);
