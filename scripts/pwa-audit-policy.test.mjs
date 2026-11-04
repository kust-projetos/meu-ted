import assert from "node:assert/strict";
import test from "node:test";
import fixture from "./__fixtures__/pwa-audit-current.json" with { type: "json" };
import allowlist from "./pwa-audit-allowlist.json" with { type: "json" };
import { evaluateAudit } from "./pwa-audit-policy.mjs";

const TODAY = "2026-09-19";

// ---- helpers ----

function makeAllowlistEntry(pkgName, overrides = {}) {
  const vuln = fixture.vulnerabilities[pkgName];
  assert.ok(vuln, `fixture missing vulnerability for ${pkgName}`);
  return {
    id: `pwa-2026-07-27-${pkgName}`,
    scope: "dev-only",
    owner: "project-maintainer",
    justification: "No compatible upstream release as of 2026-07-27.",
    expiresOn: "2026-12-31",
    ...vuln,
    ...overrides,
  };
}

function buildAllowlist(entries) {
  return entries.map((e) => (typeof e === "string" ? makeAllowlistEntry(e) : e));
}

function fixturePackageNames() {
  return Object.keys(fixture.vulnerabilities);
}

// ---- accepted: all fixture entries matched (permanent, no expiry) ----

test("accepted: all fixture entries matched", () => {
  const allowlist = buildAllowlist(fixturePackageNames());
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.blocked.length, 0);
});

test("real allowlist accepts the current audit only through expiring entries", () => {
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.accepted.length, 8);
  assert.ok(result.accepted.every((entry) => entry.expiresOn === "2026-12-31"));
});

// ---- new record: vulnerability not in allowlist ----

test("blocked: new vulnerability not in allowlist", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names.slice(0, -1));
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blocked.length > 0);
});

// ---- changed via: modified dependency chain ----

test("blocked: changed via field", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  allowlist[0].via = ["changed-dependency"];
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
});

// ---- expired: expiresOn before today (still blocks) ----

test("blocked: expired allowlist entry when expiresOn is set", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  allowlist[0].expiresOn = "2026-07-26"; // yesterday
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
});

// ---- expiry is mandatory ----

test("blocked: missing allowlist expiry", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  delete allowlist[0].expiresOn;
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.blocked[0].reason, /missing field: expiresOn/);
});

test("blocked: calendar-invalid allowlist expiry", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  allowlist[0].expiresOn = "2026-02-30";
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.blocked[0].reason, /invalid expiresOn/);
});

test("fixture metadata counts every current vulnerability", () => {
  const count = Object.keys(fixture.vulnerabilities).length;
  assert.equal(fixture.metadata.vulnerabilities.high, count);
  assert.equal(fixture.metadata.vulnerabilities.total, count);
});

// ---- malformed: missing required fields ----

test("blocked: malformed allowlist entry missing id", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  delete allowlist[0].id;
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
});

test("blocked: malformed allowlist entry missing scope", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  delete allowlist[0].scope;
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "BLOCKED");
});

// ---- resolved: allowlist entry no longer in current audit ----

test("resolved: allowlist entry no longer in current audit", () => {
  const names = fixturePackageNames();
  const allowlist = buildAllowlist(names);
  allowlist.push(makeAllowlistEntry(names[0], { name: "resolved-pkg", id: "pwa-2026-07-27-resolved-pkg" }));
  const result = evaluateAudit({ audit: fixture, allowlist, today: TODAY });
  assert.equal(result.status, "ACCEPTED");
  assert.ok(result.resolved.length > 0);
});

// ---- rimraf 2026-11-04 drift: exact CI record (run 41824366393) ----

test("rimraf 2026-11-04: accepts only the exact CI record, rejects mutations", () => {
  const exact = {
    name: "rimraf",
    severity: "moderate",
    isDirect: false,
    via: ["glob"],
    effects: ["chrome-launcher"],
    range: "2.3.0 - 3.0.2 || 4.2.0 - 6.1.3",
    nodes: ["node_modules/rimraf"],
    fixAvailable: { name: "@lhci/cli", version: "0.3.3", isSemVerMajor: true },
  };
  const singleAudit = (vuln) => ({
    vulnerabilities: { rimraf: vuln },
    metadata: { vulnerabilities: { total: 1 } },
  });

  const ok = evaluateAudit({ audit: singleAudit(exact), allowlist, today: TODAY });
  assert.equal(ok.status, "ACCEPTED");
  assert.equal(ok.blocked.length, 0);

  const mutations = [
    { ...exact, severity: "high" },
    { ...exact, via: ["minimatch"] },
    { ...exact, effects: [] },
    { ...exact, range: "2.3.0 - 3.0.2" },
  ];
  for (const vuln of mutations) {
    const result = evaluateAudit({ audit: singleAudit(vuln), allowlist, today: TODAY });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blocked.length > 0);
  }
});

// ---- typescript-eslint 2026-11-04 drift: exact CI records (run 41876660420) ----

test("typescript-eslint 2026-11-04: accepts only the two exact CI records, rejects mutations", () => {
  const pluginExact = {
    name: "@typescript-eslint/eslint-plugin",
    severity: "moderate",
    isDirect: false,
    via: ["@typescript-eslint/parser", "@typescript-eslint/type-utils", "@typescript-eslint/utils", "eslint"],
    effects: ["typescript-eslint"],
    range: "*",
    nodes: ["node_modules/@typescript-eslint/eslint-plugin"],
    fixAvailable: { name: "eslint-config-next", version: "12.0.4", isSemVerMajor: true },
  };
  const parserExact = {
    name: "@typescript-eslint/parser",
    severity: "moderate",
    isDirect: false,
    via: ["@typescript-eslint/typescript-estree", "@typescript-eslint/type-utils", "@typescript-eslint/utils", "eslint"],
    effects: ["@typescript-eslint/eslint-plugin"],
    range: "*",
    nodes: ["node_modules/@typescript-eslint/parser"],
    fixAvailable: { name: "eslint-config-next", version: "12.0.4", isSemVerMajor: true },
  };
  const twoAudit = (pluginVuln, parserVuln) => ({
    vulnerabilities: { "@typescript-eslint/eslint-plugin": pluginVuln, "@typescript-eslint/parser": parserVuln },
    metadata: { vulnerabilities: { total: 2 } },
  });

  const ok = evaluateAudit({ audit: twoAudit(pluginExact, parserExact), allowlist, today: TODAY });
  assert.equal(ok.status, "ACCEPTED");
  assert.equal(ok.blocked.length, 0);

  const pluginMutations = [
    { ...pluginExact, severity: "high" },
    { ...pluginExact, via: ["@typescript-eslint/parser", "@typescript-eslint/type-utils", "eslint"] },
    { ...pluginExact, effects: ["other-pkg"] },
    { ...pluginExact, range: ">=1.0.0" },
  ];
  for (const vuln of pluginMutations) {
    const result = evaluateAudit({ audit: twoAudit(vuln, parserExact), allowlist, today: TODAY });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blocked.length > 0);
  }

  const parserMutations = [
    { ...parserExact, severity: "high" },
    { ...parserExact, via: ["@typescript-eslint/typescript-estree"] },
    { ...parserExact, effects: ["other-pkg"] },
    { ...parserExact, range: ">=1.0.0" },
  ];
  for (const vuln of parserMutations) {
    const result = evaluateAudit({ audit: twoAudit(pluginExact, vuln), allowlist, today: TODAY });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blocked.length > 0);
  }
});

// ---- pass: no vulnerabilities ----
test("pass: no vulnerabilities", () => {
  const emptyAudit = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
  const result = evaluateAudit({ audit: emptyAudit, allowlist: [], today: TODAY });
  assert.equal(result.status, "PASS");
  assert.equal(result.blocked.length, 0);
});
