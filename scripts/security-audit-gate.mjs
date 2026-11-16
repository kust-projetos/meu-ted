#!/usr/bin/env node
/**
 * Dependency audit gate: fails on any high/critical advisory that is not in
 * scripts/audit-allowlist.json. Every allowlist entry carries a justification
 * and an `expiresOn` date; an expired entry stops suppressing its advisory, so
 * the exception cannot be forgotten.
 *
 * Usage: node scripts/security-audit-gate.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/** Pure decision, unit-tested. `advisories` is the pnpm audit `advisories` map. */
export const evaluateAudit = (advisories, allowlist, today = new Date().toISOString().slice(0, 10)) => {
  const byId = new Map(allowlist.map((entry) => [entry.id, entry]));
  const blocking = [];
  const allowed = [];
  const expired = [];
  for (const advisory of Object.values(advisories ?? {})) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const id = advisory.github_advisory_id;
    const entry = byId.get(id);
    const row = { id, severity: advisory.severity, module: advisory.module_name, patched: advisory.patched_versions };
    if (!entry) blocking.push(row);
    else if (entry.expiresOn < today) { expired.push({ ...row, expiresOn: entry.expiresOn }); }
    else allowed.push(row);
  }
  return { blocking, expired, allowed, ok: blocking.length === 0 && expired.length === 0 };
};

const main = () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const allowlist = JSON.parse(fs.readFileSync(path.join(root, "scripts", "audit-allowlist.json"), "utf8"));
  const run = spawnSync("pnpm", ["audit", "--json"], { cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(run.stdout); } catch {
    console.error("FAIL: could not parse `pnpm audit --json` output (registry unreachable?).");
    process.exit(2);
  }
  const result = evaluateAudit(report.advisories, allowlist);
  console.log(`audit gate: ${result.blocking.length} blocking, ${result.expired.length} expired exception(s), ${result.allowed.length} allowlisted`);
  for (const row of result.blocking) console.error(`BLOCKING ${row.severity} ${row.id} ${row.module} (patched ${row.patched})`);
  for (const row of result.expired) console.error(`EXPIRED  ${row.severity} ${row.id} ${row.module} (expired ${row.expiresOn})`);
  process.exit(result.ok ? 0 : 1);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
