#!/usr/bin/env node
// PWA audit — deterministic npm audit replacement for phase5 scoped audit gate.
// Creates temp manifest with ONLY apps/pwa deps/devDeps, recursively resolves
// workspace-local packages (or fails closed), runs npm install + npm audit in
// isolated temp directory, deletes temp afterward. All advisories are inherently
// PWA-scoped (siblings excluded by construction). Fails closed on any error.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateAudit } from "./pwa-audit-policy.mjs";
import allowlist from "./pwa-audit-allowlist.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PWA_DIR = path.join(ROOT, "apps", "pwa");
const PWA_PKG_PATH = path.join(PWA_DIR, "package.json");
const LOCKFILE = path.join(ROOT, "pnpm-lock.yaml");
const WORKSPACE_FILE = path.join(ROOT, "pnpm-workspace.yaml");
const TEMP_BASE = path.join(ROOT, "tmp-pwa-audit");

// Isolated npm install timeout — bounded and configurable.
//
// Resolving the full PWA dependency set (~39 direct deps, incl. next/sharp
// plus repo-local `file:` refs) reliably exceeds the old hardcoded 120s on
// Windows, so the install timeout is configurable via
// PWA_AUDIT_INSTALL_TIMEOUT_MS (integer milliseconds): default 600000
// (10 min), min 60000 (1 min), max 1800000 (30 min). Anything malformed or
// out of bounds fails closed; the result is always a finite positive
// integer, so an infinite hang is not representable.
export const INSTALL_TIMEOUT_ENV_VAR = "PWA_AUDIT_INSTALL_TIMEOUT_MS";
export const INSTALL_TIMEOUT_DEFAULT_MS = 600000;
export const INSTALL_TIMEOUT_MIN_MS = 60000;
export const INSTALL_TIMEOUT_MAX_MS = 1800000;

export function resolveInstallTimeout(raw) {
  const value =
    raw === undefined || raw === null ? process.env[INSTALL_TIMEOUT_ENV_VAR] : raw;
  if (value === undefined || value === null) return INSTALL_TIMEOUT_DEFAULT_MS;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `check-pwa-audit: FAIL — malformed ${INSTALL_TIMEOUT_ENV_VAR}=${JSON.stringify(String(value)).slice(0, 60)} (expected integer milliseconds in [${INSTALL_TIMEOUT_MIN_MS}, ${INSTALL_TIMEOUT_MAX_MS}])`,
    );
  }
  const ms = Number(text);
  if (!Number.isSafeInteger(ms) || ms < INSTALL_TIMEOUT_MIN_MS || ms > INSTALL_TIMEOUT_MAX_MS) {
    throw new Error(
      `check-pwa-audit: FAIL — ${INSTALL_TIMEOUT_ENV_VAR}=${text} out of bounds (expected integer milliseconds in [${INSTALL_TIMEOUT_MIN_MS}, ${INSTALL_TIMEOUT_MAX_MS}])`,
    );
  }
  return ms;
}

// True when an execSync failure is the spawn timeout firing (external
// slowness), as opposed to npm itself failing (bad manifest, registry 4xx).
// Lets main() report a timeout distinctly instead of a generic FAIL.
export function isInstallTimeoutError(err) {
  if (!err) return false;
  if (err.code === "ETIMEDOUT") return true;
  return /ETIMEDOUT|timed out/i.test(String(err.message || ""));
}

// Emit the exact record used by the strict allowlist matcher so a newly
// discovered advisory can be triaged without recreating the isolated audit.
export function formatBlockedFinding(blocked, audit) {
  const record = audit?.vulnerabilities?.[blocked.name];
  const suffix = record ? `\n${JSON.stringify(record)}` : "";
  return `check-pwa-audit: BLOCKED ${blocked.name} — ${blocked.reason}${suffix}`;
}

// npm audit must provide the v2 document shape. Treat malformed, truncated,
// or otherwise unexpected output as a gate failure rather than an empty audit.
export function isValidAuditDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!value.vulnerabilities || typeof value.vulnerabilities !== "object" || Array.isArray(value.vulnerabilities)) return false;
  const counts = value.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
  return ["info", "low", "moderate", "high", "critical", "total"].every(
    (key) => Number.isInteger(counts[key]) && counts[key] >= 0,
  );
}

// Workspace-local resolution — never the npm registry.
//
// A `workspace:*` requirement is pinned to the package directory declared in
// pnpm-workspace.yaml and installed via a `file:` reference in the isolated
// temp manifest. Resolving to a bare registry version would either fail
// (private, unpublished) or risk installing an unrelated public package
// (dependency confusion), so anything unresolvable fails closed here.

// Extract the exact direct-dependency versions in the pnpm v9 PWA importer.
// Package snapshot keys are not enough: the same package can resolve to
// multiple versions, while the importer identifies the graph actually used.
export function parseLockfile(raw) {
  const pkgs = {};
  const lines = raw.split("\n");
  let inPwaImporter = false;
  let currentPackage = null;
  for (const line of lines) {
    if (/^  apps\/pwa:\s*$/.test(line)) {
      inPwaImporter = true;
      currentPackage = null;
      continue;
    }
    if (!inPwaImporter) continue;
    if (/^  \S/.test(line)) break;

    const packageMatch = line.match(/^      (?:(?:'([^']+)')|([^:\s]+)):\s*$/);
    if (packageMatch) {
      currentPackage = packageMatch[1] || packageMatch[2];
      continue;
    }
    const versionMatch = line.match(/^        version:\s+([^\s(]+)/);
    if (currentPackage && versionMatch) {
      const version = versionMatch[1];
      if (!version.startsWith("link:")) pkgs[currentPackage] = version;
      currentPackage = null;
    }
  }
  return pkgs;
}

function main() {
  const tempDir = TEMP_BASE + "-" + process.pid;
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const pwaPkg = JSON.parse(fs.readFileSync(PWA_PKG_PATH, "utf-8"));
    const deps = { ...pwaPkg.dependencies, ...pwaPkg.devDependencies };

    // Resolve versions from lockfile AND apply root overrides
    const lockRaw = fs.readFileSync(LOCKFILE, "utf-8");
    const versions = parseLockfile(lockRaw);

    // Read root overrides
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const overrides = rootPkg.pnpm?.overrides || {};

    const { resolvedDeps } = buildResolvedDeps({ root: ROOT, deps, overrides, versions });

    // Write temp package.json with npm-equivalent overrides (npm v10+ supports
    // this field, but NOT pnpm parent selectors like `next>sharp` verbatim —
    // those must be translated to nested objects, see
    // translatePnpmOverridesToNpm). Unsupported selectors fail closed.
    const tempPkg = buildTempManifest({ resolvedDeps, overrides });
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(tempPkg, null, 2));

    // Run npm install (lockfile only, no scripts, no audit noise).
    // The timeout is bounded and configurable (see resolveInstallTimeout);
    // a timeout reports distinctly as external slowness, any other install
    // failure keeps the generic fail-closed path below.
    const installTimeoutMs = resolveInstallTimeout();
    try {
      execSync("npm install --package-lock-only --ignore-scripts --audit=false --legacy-peer-deps", {
        cwd: tempDir,
        stdio: "pipe",
        timeout: installTimeoutMs,
      });
    } catch (installErr) {
      if (isInstallTimeoutError(installErr)) {
        throw new Error(
          `check-pwa-audit: FAIL — isolated npm install timed out after ${Math.round(installTimeoutMs / 1000)}s (${INSTALL_TIMEOUT_ENV_VAR}, max ${INSTALL_TIMEOUT_MAX_MS}ms): external registry/network slowness, retry or raise within bounds`,
        );
      }
      throw installErr;
    }

    // Run npm audit
    let auditOutput;
    let exitCode = 0;
    try {
      auditOutput = execSync("npm audit --json", {
        cwd: tempDir,
        stdio: "pipe",
        timeout: 60000,
        encoding: "utf-8",
      }).stdout;
    } catch (auditErr) {
      auditOutput = auditErr.stdout?.toString() || "{}";
      const parsed = tryParse(auditOutput);
      if (isValidAuditDocument(parsed) && Object.keys(parsed.vulnerabilities).length > 0) {
        // Vulnerabilities found — report them
        exitCode = 1;
      } else {
        // Other audit error (network, etc.) — fail closed
        throw new Error(`npm audit error: ${auditErr.message?.substring(0, 200)}`);
      }
    }

    const parsed = tryParse(auditOutput);
    if (!isValidAuditDocument(parsed)) {
      throw new Error("npm audit returned an invalid document (expected vulnerabilities object)");
    }
    if (Object.keys(parsed.vulnerabilities).length > 0) {
      // Policy evaluation
      const today = new Date().toISOString().slice(0, 10);
      const result = evaluateAudit({ audit: parsed, allowlist, today });

      for (const a of result.accepted) {
        console.error(`check-pwa-audit: ACCEPTED ${a.name} (${a.scope}, expires ${a.expiresOn})`);
      }
      for (const r of result.resolved) {
        console.error(`check-pwa-audit: RESOLVED ${r.name}`);
      }
      for (const b of result.blocked) {
        console.error(formatBlockedFinding(b, parsed));
      }

      if (result.status === "BLOCKED") {
        exitCode = 1;
      } else {
        console.error(`check-pwa-audit: ${result.status} — ${result.accepted.length} accepted, ${result.resolved.length} resolved`);
        exitCode = 0;
      }
    } else {
      // No vulnerabilities or empty audit — policy still applies for PASS
      const today = new Date().toISOString().slice(0, 10);
      const result = evaluateAudit({ audit: parsed, allowlist, today });
      if (result.status === "PASS") {
        console.error("check-pwa-audit: PASS — no advisories");
      }
      exitCode = 0;
    }

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(exitCode);
  } catch (err) {
    // Clean up on failure
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    console.error(`check-pwa-audit: FAIL — ${err.message?.substring(0, 200)}`);
    process.exit(1);
  }
}

function tryParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ---- workspace-local dependency resolution (exported for regression tests) ----

// Extract the `packages:` globs from pnpm-workspace.yaml (minimal parser:
// only the top-level `packages:` list; comments and blank lines skipped).
export function parseWorkspacePatterns(raw) {
  const patterns = [];
  const lines = String(raw).split("\n");
  let inPackages = false;
  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\s/.test(line)) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (m && m[1] && !m[1].startsWith("#")) patterns.push(m[1]);
    } else if (line.trim() !== "" && !line.trim().startsWith("#")) {
      inPackages = false;
    }
  }
  return patterns;
}

// Expand workspace globs to candidate directories under root. Supports exact
// paths and trailing `/*`; any other glob shape is ignored so the lookup
// below fails closed per package instead of guessing.
export function expandWorkspaceCandidateDirs(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const base = path.join(root, pattern.slice(0, -2));
      let entries = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          dirs.push(path.join(base, entry.name));
        }
      }
    } else if (!pattern.includes("*")) {
      dirs.push(path.join(root, pattern));
    }
  }
  return dirs;
}

// Find the repo-local directory of a workspace package by name, using only
// pnpm-workspace.yaml + on-disk package.json files (never node_modules,
// never the registry). Returns the absolute directory or null.
export function findWorkspacePackageDir(root, packageName) {
  let patterns;
  try {
    patterns = parseWorkspacePatterns(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf-8"));
  } catch {
    return null;
  }
  for (const dir of expandWorkspaceCandidateDirs(root, patterns)) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    } catch {
      continue;
    }
    if (pkg && pkg.name === packageName) return dir;
  }
  return null;
}

export function toFileDependency(absDir) {
  return `file:${absDir.replace(/\\/g, "/")}`;
}

// npm cannot consume the `workspace:` protocol, so a workspace-local package
// that itself depends on another workspace package cannot be installed from
// a `file:` reference as-is. Fail closed with a clear message instead of an
// obscure npm error (or worse, a partial install).
export function assertNoNestedWorkspaceDeps(pkgDir, packageName) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
  } catch (err) {
    throw new Error(
      `check-pwa-audit: FAIL — cannot read workspace package "${packageName}": ${err.message}`,
    );
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[field] || {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        throw new Error(
          `check-pwa-audit: FAIL — workspace package "${packageName}" has nested workspace:* dependency "${dep}" (unsupported by isolated npm audit)`,
        );
      }
    }
  }
}

// Resolve one `workspace:*` requirement to a repo-local `file:` spec.
// Throws (fail closed) when the package is missing, escapes the repo, has a
// name mismatch, or carries nested workspace deps.
export function resolveWorkspaceDependency(root, packageName) {
  const dir = findWorkspacePackageDir(root, packageName);
  if (!dir) {
    throw new Error(`check-pwa-audit: FAIL — cannot resolve workspace package "${packageName}"`);
  }
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch (err) {
    throw new Error(
      `check-pwa-audit: FAIL — cannot resolve workspace package "${packageName}": ${err.message}`,
    );
  }
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `check-pwa-audit: FAIL — workspace package "${packageName}" escapes the repository`,
    );
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf-8"));
  } catch (err) {
    throw new Error(
      `check-pwa-audit: FAIL — cannot read workspace package "${packageName}": ${err.message}`,
    );
  }
  if (pkg.name !== packageName) {
    throw new Error(
      `check-pwa-audit: FAIL — workspace package name mismatch for "${packageName}"`,
    );
  }
  assertNoNestedWorkspaceDeps(real, packageName);
  return toFileDependency(real);
}

// Translate pnpm `overrides` selectors to semantically equivalent npm
// `overrides` entries. Supported:
//
// - `pkg: version` (plain name) → verbatim
// - `pkg@spec: version` → verbatim (npm accepts `name@spec` keys)
// - `parent>child: version` → `{ parent: { child: version } }`
// - `a>b>c: version` → `{ a: { b: { c: version } } }`
//   where each chain segment is a bare name, a scoped name (`@scope/name`),
//   or either form with an `@spec` suffix (`nanoid@^3`, `@scope/name@^1`).
// - Scoped names are accepted in every position (`@modelcontextprotocol/sdk`,
//   `@ai-sdk/provider-utils>undici`).
//
// Anything else (empty segments, `>>`, parens/braces/brackets/pipes/amps,
// whitespace, globs, `peer(...)` syntax, non-string values) fails closed with
// an explicit error so a pnpm-only selector can never leak verbatim into the
// temporary npm manifest and silently stop enforcing a pin (e.g. the current
// `next>sharp: 0.34.5` production pin).
const OVERRIDE_NAME = /^(@[^@\s>]+\/[^@\s>]+|[^@\s>]+)(@\S+)?$/;
export function translatePnpmOverridesToNpm(overrides = {}) {
  const npmOverrides = {};
  for (const [selector, version] of Object.entries(overrides)) {
    if (typeof version !== "string" || version === "") {
      throw new Error(
        `check-pwa-audit: FAIL — unsupported pnpm override value for "${selector}" (expected non-empty version string)`,
      );
    }
    if (!selector.includes(">")) {
      if (!OVERRIDE_NAME.test(selector) || /[()*|&:{}\[\],]/.test(selector)) {
        throw new Error(
          `check-pwa-audit: FAIL — unsupported pnpm override selector "${selector}"`,
        );
      }
      npmOverrides[selector] = version;
      continue;
    }
    const parts = selector.split(">");
    for (const part of parts) {
      if (
        !part ||
        !OVERRIDE_NAME.test(part) ||
        /[()*|&:{}\[\],\s]/.test(part)
      ) {
        throw new Error(
          `check-pwa-audit: FAIL — unsupported pnpm override selector "${selector}"`,
        );
      }
    }
    let cursor = npmOverrides;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      if (last) {
        if (cursor[part] !== undefined) {
          throw new Error(
            `check-pwa-audit: FAIL — conflicting pnpm override selector "${selector}"`,
          );
        }
        cursor[part] = version;
      } else {
        if (cursor[part] === undefined) {
          cursor[part] = {};
        } else if (typeof cursor[part] !== "object" || cursor[part] === null) {
          throw new Error(
            `check-pwa-audit: FAIL — conflicting pnpm override selector "${selector}"`,
          );
        }
        cursor = cursor[part];
      }
    }
  }
  return npmOverrides;
}

// Build the isolated temp manifest body. Exported so regression tests can
// assert the real resolved structure (no pnpm-only selector may leak).
export function buildTempManifest({ resolvedDeps, overrides = {} }) {
  return {
    name: "pwa-audit",
    dependencies: resolvedDeps,
    overrides: translatePnpmOverridesToNpm(overrides),
  };
}

// Resolve PWA deps/devDeps to pinned specs for the isolated temp manifest.
// Workspace requirements become repo-local `file:` specs; everything else
// keeps the previous version/override behavior unchanged.
export function buildResolvedDeps({ root, deps, overrides = {}, versions = {} }) {
  const resolvedDeps = {};
  for (const [name, req] of Object.entries(deps)) {
    const finalReq = overrides[name] || req;

    if (typeof finalReq === "string" && finalReq.startsWith("workspace:")) {
      resolvedDeps[name] = resolveWorkspaceDependency(root, name);
    } else if (versions[name]) {
      // The gate audits the exact dependency tree pnpm installs, not a newer
      // registry resolution permitted by a caret or tilde range.
      resolvedDeps[name] = versions[name];
    } else {
      throw new Error(`check-pwa-audit: FAIL — cannot resolve locked version for "${name}"`);
    }
  }
  return { resolvedDeps };
}

// Import-safe: the audit runs only when invoked as a script, so unit tests
// can import the resolvers above without triggering an isolated npm install.
const invokedAsScript =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main();
}
