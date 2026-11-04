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

// ---- 2026-11-04 drift (run 41900996857, job 126823057023): 10 exact shapes ----

test("2026-11-04 drift (41900996857): accepts only the ten exact CI records, rejects mutations", () => {
  const globAdvisory = {
    source: 1244013,
    name: "glob",
    dependency: "glob",
    title: "Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal",
    url: "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
    severity: "moderate",
    cwe: ["CWE-400"],
    cvss: { score: 0, vectorString: null },
    range: ">=9.0.0 <=14.0.1",
  };
  const minimatchAdvisory = {
    source: 1244623,
    name: "minimatch",
    dependency: "minimatch",
    title: "minimatch has potential denial of service via globparts amplification",
    url: "https://github.com/advisories/GHSA-g3hv-75wg-m249",
    severity: "moderate",
    cwe: ["CWE-405"],
    cvss: { score: 0, vectorString: null },
    range: ">=7.0.0 <11.0.1",
  };
  const exact = {
    "@stryker-mutator/core": {
      name: "@stryker-mutator/core",
      severity: "moderate",
      isDirect: true,
      via: ["minimatch"],
      effects: ["@stryker-mutator/typescript-checker", "@stryker-mutator/vitest-runner"],
      range: ">=6.4.2",
      nodes: ["node_modules/@stryker-mutator/core"],
      fixAvailable: { name: "@stryker-mutator/typescript-checker", version: "7.0.0", isSemVerMajor: true },
    },
    "@stryker-mutator/typescript-checker": {
      name: "@stryker-mutator/typescript-checker",
      severity: "moderate",
      isDirect: true,
      via: ["@stryker-mutator/core"],
      effects: [],
      range: ">=7.0.1",
      nodes: ["node_modules/@stryker-mutator/typescript-checker"],
      fixAvailable: { name: "@stryker-mutator/typescript-checker", version: "7.0.0", isSemVerMajor: true },
    },
    "@typescript-eslint/eslint-plugin": {
      name: "@typescript-eslint/eslint-plugin",
      severity: "moderate",
      isDirect: false,
      via: ["@typescript-eslint/parser", "@typescript-eslint/type-utils", "@typescript-eslint/utils"],
      effects: [],
      range: ">=6.16.0",
      nodes: ["node_modules/@typescript-eslint/eslint-plugin"],
      fixAvailable: true,
    },
    "@typescript-eslint/parser": {
      name: "@typescript-eslint/parser",
      severity: "moderate",
      isDirect: false,
      via: ["@typescript-eslint/typescript-estree"],
      effects: ["@typescript-eslint/eslint-plugin", "typescript-eslint"],
      range: ">=6.16.0",
      nodes: ["node_modules/@typescript-eslint/parser"],
      fixAvailable: { name: "eslint-config-next", version: "15.5.29", isSemVerMajor: true },
    },
    "@typescript-eslint/type-utils": {
      name: "@typescript-eslint/type-utils",
      severity: "moderate",
      isDirect: false,
      via: ["@typescript-eslint/typescript-estree", "@typescript-eslint/utils"],
      effects: ["@typescript-eslint/eslint-plugin"],
      range: ">=6.16.0",
      nodes: ["node_modules/@typescript-eslint/type-utils"],
      fixAvailable: true,
    },
    "@typescript-eslint/utils": {
      name: "@typescript-eslint/utils",
      severity: "moderate",
      isDirect: false,
      via: ["@typescript-eslint/typescript-estree"],
      effects: ["typescript-eslint"],
      range: ">=6.16.0",
      nodes: ["node_modules/@typescript-eslint/utils"],
      fixAvailable: { name: "eslint-config-next", version: "15.5.29", isSemVerMajor: true },
    },
    "eslint-config-next": {
      name: "eslint-config-next",
      severity: "moderate",
      isDirect: true,
      via: ["typescript-eslint"],
      effects: [],
      range: ">=15.6.0-canary.0",
      nodes: ["node_modules/eslint-config-next"],
      fixAvailable: { name: "eslint-config-next", version: "15.5.29", isSemVerMajor: true },
    },
    "glob": {
      name: "glob",
      severity: "moderate",
      isDirect: false,
      via: [globAdvisory, "minimatch"],
      effects: ["@node-minify/core", "@opennextjs/cloudflare", "@serwist/build", "@serwist/next"],
      range: "9.0.0 - 14.0.1",
      nodes: ["node_modules/@node-minify/core/node_modules/glob", "node_modules/glob"],
      fixAvailable: { name: "@serwist/next", version: "8.4.4", isSemVerMajor: true },
    },
    "minimatch": {
      name: "minimatch",
      severity: "moderate",
      isDirect: false,
      via: [minimatchAdvisory],
      effects: ["@stryker-mutator/core", "@typescript-eslint/typescript-estree", "glob"],
      range: "7.0.0 - 11.0.0",
      nodes: ["node_modules/@node-minify/core/node_modules/minimatch", "node_modules/minimatch"],
      fixAvailable: { name: "@stryker-mutator/typescript-checker", version: "7.0.0", isSemVerMajor: true },
    },
    "typescript-eslint": {
      name: "typescript-eslint",
      severity: "moderate",
      isDirect: false,
      via: [
        "@typescript-eslint/eslint-plugin",
        "@typescript-eslint/parser",
        "@typescript-eslint/typescript-estree",
        "@typescript-eslint/utils",
      ],
      effects: ["eslint-config-next"],
      range: "*",
      nodes: ["node_modules/typescript-eslint"],
      fixAvailable: { name: "eslint-config-next", version: "15.5.29", isSemVerMajor: true },
    },
  };
  const tenAudit = (vulns) => ({
    vulnerabilities: vulns,
    metadata: { vulnerabilities: { total: Object.keys(vulns).length } },
  });
  const NEW_IDS = new Set([
    "pwa-2026-11-04-stryker-mutator-core-642",
    "pwa-2026-11-04-stryker-mutator-typescript-checker-701",
    "pwa-2026-11-04-typescript-eslint-eslint-plugin-6160",
    "pwa-2026-11-04-typescript-eslint-parser-6160",
    "pwa-2026-11-04-typescript-eslint-type-utils-6160",
    "pwa-2026-11-04-typescript-eslint-utils-6160",
    "pwa-2026-11-04-eslint-config-next-1560-canary",
    "pwa-2026-11-04-glob-900-1401",
    "pwa-2026-11-04-minimatch-700-1100",
    "pwa-2026-11-04-typescript-eslint-star",
  ]);

  // Pre-change allowlist (without the ten new shapes) must BLOCK.
  const withoutNew = allowlist.filter((e) => !NEW_IDS.has(e.id));
  assert.equal(withoutNew.length, allowlist.length - 10);
  const pre = evaluateAudit({ audit: tenAudit({ ...exact }), allowlist: withoutNew, today: TODAY });
  assert.equal(pre.status, "BLOCKED");
  assert.equal(pre.blocked.length, 10);

  // Post-change allowlist ACCEPTS all ten exactly.
  const ok = evaluateAudit({ audit: tenAudit({ ...exact }), allowlist, today: TODAY });
  assert.equal(ok.status, "ACCEPTED");
  assert.equal(ok.blocked.length, 0);

  // Exactness: mutate one canonical field at a time; each must BLOCK.
  for (const key of Object.keys(exact)) {
    const base = exact[key];
    const mutants = [
      { ...base, severity: "high" },
      { ...base, via: ["changed-dependency"] },
      { ...base, effects: ["other-pkg"] },
      { ...base, range: ">=99.0.0" },
    ];
    for (const vuln of mutants) {
      const trial = { ...exact, [key]: vuln };
      const result = evaluateAudit({ audit: tenAudit(trial), allowlist, today: TODAY });
      assert.equal(result.status, "BLOCKED", `expected BLOCKED for mutated ${key}`);
      assert.ok(result.blocked.some((b) => b.name === key), `expected ${key} in blocked`);
    }
  }
});

// ---- pass: no vulnerabilities ----
test("pass: no vulnerabilities", () => {
  const emptyAudit = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
  const result = evaluateAudit({ audit: emptyAudit, allowlist: [], today: TODAY });
  assert.equal(result.status, "PASS");
  assert.equal(result.blocked.length, 0);
});
