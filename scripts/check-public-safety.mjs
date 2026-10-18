#!/usr/bin/env node
// Public-safety gate (V4.1 Phase 6 preparatory — plan Task 6.7, SPEC §13.9).
// Scans git-tracked files for credentials and prohibited operational metadata
// before any repository visibility change.
//
// Exit codes:
//   0 — no ERROR findings (warnings are listed but tolerated in default mode)
//   1 — ERROR findings (real credentials, private keys, tracked .env/dumps)
//   1 — warnings present AND --strict passed (publication-time enforcement)
//
// Policy: allowlist is explicit, minimal, and reasoned. Extend only with a
// documented reason per entry (SPEC §13.9: allowlist mínima e revisável).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STRICT = process.argv.includes("--strict");
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export const SECRET_RULES = [
  { name: "private-key-block", re: /BEGIN (?:RSA |EC |OPENSSH |PGP |)PRIVATE KEY/, severity: "error" },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/, severity: "error" },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/, severity: "error" },
  { name: "openai-style-key", re: /\bsk-(?:ant|proj|svcacct)-[A-Za-z0-9_\-]{20,}/, severity: "error" },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, severity: "error" },
  { name: "google-api-key", re: /AIza[0-9A-Za-z_\-]{35}/, severity: "error" },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/, severity: "error" },
  {
    name: "url-embedded-credentials",
    // Suppresses known placeholder/test credentials — extend only with reason.
    re: /:\/\/[A-Za-z0-9._%\-]+:(?!test\b|pass\b|pw\b|secret\b|password\b|senha\b|change-me\b|<)[^@\s/]{3,}@/,
    severity: "error",
  },
  {
    name: "vapid-private-key",
    re: /VAPID_PRIVATE_KEY\s*[:=]\s*["']?[A-Za-z0-9_\-]{30,}/,
    severity: "error",
  },
];

export const FILENAME_RULES = [
  { name: "tracked-env-file", re: /(?:^|\/)\.env(?:$|\.(?!example))/, severity: "error" },
  { name: "tracked-dev-vars", re: /(?:^|\/)\.dev\.vars$/, severity: "error" },
  { name: "private-key-file", re: /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.[^/]*)?$|\.(?:pem|p12|pfx|keystore)$/, severity: "error" },
  { name: "dump-or-db-file", re: /\.(?:dump|bak|backup|sqlite|sqlite3|db)$|dump\.sql$|backup\.sql$/, severity: "error" },
];

// WARN policy (prohibited operational/personal metadata — SPEC §13.4).
// Fails only with --strict (publication gate). Currently present in tracked
// docs; sanitization is tracked in docs/reports/v4.1-publication-readiness.md.
// T13: provider-agnostic shapes (ssh user with literal IP, assigned hostnames)
// so a VPS migration cannot silently drop coverage; prose ("VPS Contabo"),
// placeholders ("deploy@<ip-vps-contabo>") and the public edge DNS never match.
export const METADATA_RULES = [
  { name: "production-ip", re: /187\.77\.249\.47/, severity: "warn" },
  { name: "vps-host-or-ssh-user", re: /srv1773156|deploy@\d|id_ed25519_hostinger_vps/, severity: "warn" },
  { name: "contabo-assigned-host", re: /\bvmi\d+\.contabo\.(?:cloud|com|net)\b|\b[a-z0-9-]+\.contabo\.(?:cloud|com|net)\b/, severity: "warn" },
  { name: "personal-email", re: /walissonead@|synkrooia@|synkrooia@gmail|convidado\.teste\.pi@/, severity: "warn" },
  { name: "internal-hostname", re: /evo\.synkroo\.com\.br|pi-finance-(?:agent|pwa)\.walissonead\.workers\.dev/, severity: "warn" },
];

// Fully skipped paths (verbatim prefix match). Minimal + reasoned.
const SKIP_PATHS = [
  ".env.example",
  ".env.pi.example",
  "apps/api/.env.example",
  "apps/pwa/.env.example",
  "apps/agent/.dev.vars.example",
  "scripts/anonymized-dump.sql", // synthetic seed data, header-verified (see publication-readiness report)
  "pnpm-lock.yaml", // integrity file; URL-cred rule audited manually
];

// Per-rule allowlist: path prefixes tolerated for a given rule, with reason.
// Policy: narrowest possible scope — whole-directory entries are prohibited
// (review finding 2026-09-16); placeholders are handled by the rule's own
// negative lookahead, not by allowlist.
const RULE_ALLOWLIST = [
  { rule: "private-key-block", path: "apps/agent/tests/transcript-safety.test.ts", reason: "redaction fixture, marker string LIVE-CREDENTIAL" },
  { rule: "private-key-block", path: "apps/agent/src/privacy/redaction.ts", reason: "detection regex source, not a key" },
  { rule: "github-token", path: "apps/agent/src/privacy/history.ts", reason: "detection regex source, not a token" },
  { rule: "url-embedded-credentials", path: "scripts/backup-restore-rehearsal.test.mjs", reason: "ephemeral local test container (postgres:postgres@localhost) — no production credential" },
  { rule: "url-embedded-credentials", path: "scripts/capture-production-topology.test.mjs", reason: "redaction unit-test fixture with fake strings (supersecret/abc123xyz)" },
  { rule: "url-embedded-credentials", path: "docs/ops/2026-08-18-postgres-integration-status.md", reason: "local CI test container (postgres:postgres@127.0.0.1) — ephemeral, no production credential" },
  { rule: "url-embedded-credentials", path: "docs/superpowers/goal-runs/2026-08-24-v032-v033.md", reason: "local rehearsal container (rehearse:rehearse@localhost) — ephemeral, no production credential" },
  // Metadata WARN allowlist (DEBT2-CODER-ALLOWLISTS 2026-09-18): the
  // production endpoint constants migrated out of the repo. Deploy URLs
  // live in gh repo variables (vars.PWA_PROD_URL / vars.AGENT_PROD_URL);
  // API non-prod defaults are example.* placeholders (production is
  // env-required fail-closed); fixtures use example.* or import the runtime
  // constant. The Agent worker reads the PWA_ORIGIN binding (deploy
  // --var PWA_ORIGIN, fallback is the example.* placeholder — production
  // without the binding denies the real PWA, never trusts a third party);
  // the PWA agent proxy reads PWA_AGENT_PROXY_ORIGIN/AGENT_ORIGIN plus
  // PWA_ORIGIN from the Cloudflare runtime (deploy --var, process.env
  // fallback; production missing all three answers 500 without calling
  // upstream); the CORS contract script takes PWA_PROD_URL/PWA_ORIGIN from
  // env and skips the live check when unset (never silently probes prod).
  // What stays below is irreducible without an ops/product decision.
  // Detector definitions (regex source, not values).
  { rule: "vps-host-or-ssh-user", path: "scripts/check-public-safety.mjs", reason: "detector definitions" },
  { rule: "personal-email", path: "scripts/check-public-safety.mjs", reason: "detector definitions" },
  { rule: "vps-host-or-ssh-user", path: "scripts/documentation-gates-t13.test.mjs", reason: "synthetic detector-contract fixture (RFC 5737 TEST-NET-1 IP; no real host/user)" },
  { rule: "contabo-assigned-host", path: "scripts/documentation-gates-t13.test.mjs", reason: "fictional vmi123456.contabo.cloud placeholder pinning the detector contract (no real workspace host)" },
  { rule: "contabo-assigned-host", path: "scripts/check-public-safety.mjs", reason: "detector definitions + contract fixture literals in this allowlist" },
  // Pinned production hosts — irreducible detector-like exceptions
  // (DEBT2-CODER-ALLOWLISTS-FIX, security review HIGH). Each literal below
  // is a value being PINNED for exact-host validation (fail-closed), not a
  // secret and not a live credential: the PWA/agent proxies and the deploy
  // validator accept no other host. Safety gate: edge-gate.test.ts,
  // agent route.test.ts, worker-cors-gate.test.ts and
  // validate-deploy-origins.test.mjs pin the behavior AND the exact host
  // values — any host change breaks those suites before it can ship.
  { rule: "internal-hostname", path: "apps/pwa/src/proxy-utils.ts", reason: "EXPECTED_PWA/AGENT_ORIGIN pins for isExpectedOrigin exact-host validation (fail-closed proxy); covered by edge-gate + route suites" },
  { rule: "internal-hostname", path: "apps/agent/src/worker.ts", reason: "EXPECTED_PWA_ORIGIN pin for isExpectedPwaOrigin CORS validation (fail-closed); covered by worker-cors-gate suite" },
  { rule: "internal-hostname", path: "scripts/validate-deploy-origins.mjs", reason: "EXPECTED_*_HOST pins for deploy-time repo-variable validation (fail-closed); covered by validate-deploy-origins.test.mjs" },
  { rule: "internal-hostname", path: "scripts/validate-deploy-origins.test.mjs", reason: "pins the exact expected host VALUES asserted by the deploy-validation safety gate (no other production-host use)" },
  // Irreducible without ops decision: default EVOLUTION_GO_API_URL for the
  // local pi-stack (override via env / gitignored .env.pi on the VPS).
  // The watchdog command is retired (bridge removed in P3 f640e84) and no
  // test pins this default, so changing it to example.* needs an explicit
  // ops call — kept + allowlisted (fail-safe keep).
  { rule: "internal-hostname", path: "docker/pi-stack/docker-compose.yml", reason: "default EVOLUTION_GO_API_URL for local stack (override via env); changing default needs ops decision (follow-up)" },
];

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function isSkipped(path) {
  return SKIP_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

function allowlisted(rule, path) {
  return RULE_ALLOWLIST.some((a) => a.rule === rule && (path === a.path || path.startsWith(a.path)));
}

function redact(line, match) {
  const preview = match[0].slice(0, 10);
  return `${line.slice(0, 120).replace(/\s+/g, " ")} [pattern-preview: ${preview}…, len=${match[0].length}]`;
}

const errors = [];
const warnings = [];

if (IS_MAIN) {
for (const path of listTrackedFiles()) {
  if (isSkipped(path)) continue;

  for (const rule of FILENAME_RULES) {
    if (rule.re.test(path)) {
      const finding = { rule: rule.name, path, line: 0, detail: "filename matches prohibited pattern" };
      (rule.severity === "error" ? errors : warnings).push(finding);
    }
  }

  let content;
  try {
    const stat = fs.statSync(path);
    if (stat.size > 5 * 1024 * 1024) continue;
    content = fs.readFileSync(path, "utf8");
  } catch {
    continue; // unreadable/binary — filename rules above still applied
  }
  if (content.includes("\0")) continue; // binary

  const lines = content.split("\n");
  for (const group of [SECRET_RULES, METADATA_RULES]) {
    for (const rule of group) {
      for (let i = 0; i < lines.length; i++) {
        const m = rule.re.exec(lines[i]);
        if (!m) continue;
        // Allowlist applies to every severity: metadata WARN entries below are
        // explicit, per-file, and reasoned (same bar as ERROR entries).
        if (allowlisted(rule.name, path)) break;
        const finding = { rule: rule.name, path, line: i + 1, detail: redact(lines[i], m) };
        (rule.severity === "error" ? errors : warnings).push(finding);
        break; // one hit per rule per file keeps the report bounded
      }
    }
  }
}

console.log("=== Public-safety gate ===");
console.log(`Mode: ${STRICT ? "STRICT (warnings block)" : "default (warnings listed only)"}`);
if (errors.length > 0) {
  console.log(`\nERROR findings (${errors.length}):`);
  for (const f of errors) console.log(`  [${f.rule}] ${f.path}:${f.line} — ${f.detail}`);
}
if (warnings.length > 0) {
  console.log(`\nWARN findings (${warnings.length}) — prohibited metadata policy (SPEC §13.4):`);
  for (const f of warnings) console.log(`  [${f.rule}] ${f.path}:${f.line} — ${f.detail}`);
  console.log("  → sanitize or allowlist (with reason) before publication; see docs/reports/v4.1-publication-readiness.md");
}
if (errors.length === 0 && warnings.length === 0) {
  console.log("\nNo findings. Tree is publishable from this gate's perspective.");
}

const failed = errors.length > 0 || (STRICT && warnings.length > 0);
console.log(`\nResult: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
} // end IS_MAIN
