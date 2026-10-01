import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildResolvedDeps,
  buildTempManifest,
  INSTALL_TIMEOUT_DEFAULT_MS,
  INSTALL_TIMEOUT_MAX_MS,
  INSTALL_TIMEOUT_MIN_MS,
  isValidAuditDocument,
  isInstallTimeoutError,
  parseLockfile,
  resolveInstallTimeout,
  resolveWorkspaceDependency,
  translatePnpmOverridesToNpm,
} from "./pwa-audit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// RED contract: workspace:* deps must resolve to a repo-local file: reference
// (never a bare registry version), and anything unresolvable fails closed.

test("workspace dep resolves to a repo-local file: reference", () => {
  const spec = resolveWorkspaceDependency(ROOT, "@pi-finance/llm-contracts");
  assert.match(spec, /^file:/);
  assert.doesNotMatch(spec, /^file:.*node_modules/);
  const target = spec.replace(/^file:/, "");
  const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf-8"));
  assert.equal(pkg.name, "@pi-finance/llm-contracts");
  // Must stay inside the repo (no path escape).
  const rel = path.relative(ROOT, target);
  assert.ok(rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));
});

test("workspace spec is not a bare registry version", () => {
  const { resolvedDeps } = buildResolvedDeps({
    root: ROOT,
    deps: { "@pi-finance/llm-contracts": "workspace:*", zod: "^3.24.1" },
    overrides: {},
    versions: { zod: "3.25.76" },
  });
  assert.match(resolvedDeps["@pi-finance/llm-contracts"], /^file:/);
  assert.equal(resolvedDeps.zod, "3.25.76");
});

test("registry ranges resolve to the version pinned by the lockfile", () => {
  const { resolvedDeps } = buildResolvedDeps({
    root: ROOT,
    deps: { zod: "^3.24.1" },
    overrides: {},
    versions: { zod: "3.25.76" },
  });
  assert.equal(resolvedDeps.zod, "3.25.76");
});

test("current pnpm v9 importer exposes exact PWA dependency versions", () => {
  const lockfile = fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf-8");
  const versions = parseLockfile(lockfile);
  assert.equal(versions.next, "16.3.8");
  assert.equal(versions["@lhci/cli"], "0.15.1");
  assert.equal(versions.wrangler, "4.135.0");
});

test("unlocked registry dependency fails closed", () => {
  assert.throws(
    () => buildResolvedDeps({ root: ROOT, deps: { zod: "^3.24.1" }, overrides: {}, versions: {} }),
    /cannot resolve locked version/,
  );
});

test("audit document requires a vulnerabilities object", () => {
  const valid = {
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  };
  assert.equal(isValidAuditDocument(valid), true);
  for (const invalid of [null, {}, { vulnerabilities: {} }, { vulnerabilities: [] }, { vulnerabilities: null }]) {
    assert.equal(isValidAuditDocument(invalid), false);
  }
});

test("PWA CI watches its audit contract and workflow", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "pwa-ci.yml"), "utf-8");
  assert.match(workflow, /scripts\/__fixtures__\/pwa-audit-current\.json/);
  assert.match(workflow, /docs\/security\/pwa-audit-risk-acceptance\.md/);
  assert.match(workflow, /\.github\/workflows\/pwa-ci\.yml/);
});

test("missing workspace package fails closed", () => {
  assert.throws(
    () => resolveWorkspaceDependency(ROOT, "@pi-finance/does-not-exist"),
    /cannot resolve workspace package/,
  );
});

test("workspace package with nested workspace:* deps fails closed", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-audit-ws-"));
  const pkgDir = path.join(outside, "nested-ws");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@pi-finance/nested-ws-fixture",
      version: "0.1.0",
      dependencies: { "@pi-finance/llm-contracts": "workspace:*" },
    }),
  );
  const wsFile = path.join(outside, "pnpm-workspace.yaml");
  fs.writeFileSync(wsFile, "packages:\n  - 'nested-ws'\n");
  try {
    assert.throws(
      () => resolveWorkspaceDependency(outside, "@pi-finance/nested-ws-fixture"),
      /nested workspace/,
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("audit source no longer resolves workspace packages from node_modules", () => {
  const source = fs.readFileSync(path.join(__dirname, "pwa-audit.mjs"), "utf-8");
  assert.doesNotMatch(source, /join\(ROOT,\s*"node_modules"/);
});

test("current next>sharp override translates to nested npm overrides", () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const overrides = rootPkg.pnpm?.overrides || {};
  assert.equal(overrides["next>sharp"], "0.34.5");
  const translated = translatePnpmOverridesToNpm({ "next>sharp": overrides["next>sharp"] });
  assert.deepEqual(translated, { next: { sharp: "0.34.5" } });
});

test("plain and name@spec overrides pass through verbatim", () => {
  const translated = translatePnpmOverridesToNpm({
    vite: ">=7.3.5",
    "brace-expansion@^1": "1.1.18",
  });
  assert.deepEqual(translated, { vite: ">=7.3.5", "brace-expansion@^1": "1.1.18" });
});

test("multi-level parent chain nests correctly", () => {
  const translated = translatePnpmOverridesToNpm({ "a>b>c": "1.2.3" });
  assert.deepEqual(translated, { a: { b: { c: "1.2.3" } } });
});

test("unsupported pnpm selectors fail closed with explicit error", () => {
  for (const bad of ["next>", ">sharp", "a>>b", "", "foo(bar)", "foo@1 || bar@2", "a b>c"]) {
    assert.throws(() => translatePnpmOverridesToNpm({ [bad]: "1.0.0" }), /unsupported pnpm override selector/);
  }
});

test("conflicting flat + nested override for same parent fails closed", () => {
  assert.throws(
    () => translatePnpmOverridesToNpm({ next: "16.3.5", "next>sharp": "0.34.5" }),
    /conflicting pnpm override selector/,
  );
});

test("temp manifest carries translated overrides and no pnpm-only selector leaks", () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const overrides = rootPkg.pnpm?.overrides || {};
  const manifest = buildTempManifest({ resolvedDeps: { sharp: "0.34.5" }, overrides });
  assert.deepEqual(manifest.overrides?.next, { sharp: "0.34.5" });
  const raw = JSON.stringify(manifest);
  assert.doesNotMatch(raw, /next>sharp/);
  for (const key of Object.keys(manifest.overrides || {})) {
    assert.ok(!key.includes(">"), `pnpm parent selector leaked: ${key}`);
  }
});

// Install-timeout contract: bounded, documented, configurable; malformed or
// out-of-bounds values fail closed; the timeout always stays finite.

test("install timeout defaults to 10 minutes when env is unset", () => {
  const saved = process.env.PWA_AUDIT_INSTALL_TIMEOUT_MS;
  delete process.env.PWA_AUDIT_INSTALL_TIMEOUT_MS;
  try {
    assert.equal(resolveInstallTimeout(), 600000);
    assert.equal(INSTALL_TIMEOUT_DEFAULT_MS, 600000);
  } finally {
    if (saved !== undefined) process.env.PWA_AUDIT_INSTALL_TIMEOUT_MS = saved;
  }
});

test("install timeout accepts explicit values within bounds", () => {
  assert.equal(resolveInstallTimeout("300000"), 300000);
  assert.equal(resolveInstallTimeout(String(INSTALL_TIMEOUT_MIN_MS)), INSTALL_TIMEOUT_MIN_MS);
  assert.equal(resolveInstallTimeout(String(INSTALL_TIMEOUT_MAX_MS)), INSTALL_TIMEOUT_MAX_MS);
});

test("install timeout fails closed on malformed values", () => {
  for (const bad of ["", "abc", "45s", "12.5", "0x10000", "Infinity", "NaN", "  ", "-300000", "0"]) {
    assert.throws(() => resolveInstallTimeout(bad), /PWA_AUDIT_INSTALL_TIMEOUT_MS/);
  }
});

test("install timeout fails closed outside min/max bounds", () => {
  assert.throws(
    () => resolveInstallTimeout(String(INSTALL_TIMEOUT_MIN_MS - 1)),
    /PWA_AUDIT_INSTALL_TIMEOUT_MS/,
  );
  assert.throws(
    () => resolveInstallTimeout(String(INSTALL_TIMEOUT_MAX_MS + 1)),
    /PWA_AUDIT_INSTALL_TIMEOUT_MS/,
  );
  assert.throws(() => resolveInstallTimeout("99999999999"), /PWA_AUDIT_INSTALL_TIMEOUT_MS/);
});

test("install timeout always stays finite", () => {
  const saved = process.env.PWA_AUDIT_INSTALL_TIMEOUT_MS;
  delete process.env.PWA_AUDIT_INSTALL_TIMEOUT_MS;
  try {
    for (const value of [resolveInstallTimeout(), resolveInstallTimeout("600000")]) {
      assert.ok(Number.isFinite(value) && value > 0);
    }
  } finally {
    if (saved !== undefined) process.env.PWA_AUDIT_INSTALL_TIMEOUT_MS = saved;
  }
});

test("audit install step uses the resolved timeout (no hardcoded 120s)", () => {
  const source = fs.readFileSync(path.join(__dirname, "pwa-audit.mjs"), "utf-8");
  assert.match(source, /resolveInstallTimeout\(\)/);
  assert.doesNotMatch(source, /timeout:\s*120000/);
});

test("install timeout errors are distinguished from npm failures", () => {
  const timeoutErr = new Error("spawnSync npm ETIMEDOUT");
  timeoutErr.code = "ETIMEDOUT";
  assert.equal(isInstallTimeoutError(timeoutErr), true);
  assert.equal(isInstallTimeoutError(new Error("spawnSync npm ETIMEDOUT")), true);
  assert.equal(isInstallTimeoutError(new Error("npm error 404 Not Found")), false);
  assert.equal(isInstallTimeoutError(null), false);
});
