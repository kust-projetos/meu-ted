import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintAllDocumentation, lintMarkdownDocument } from "./lint-docs.mjs";
import { generateRuntimeFacts } from "./generate-documentation-facts.mjs";
import { collectRegisteredTools } from "./check-tool-capability-inventory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function countInventoryRows() {
  const src = read("docs/architecture/tool-capability-inventory.md");
  return src.split("\n").filter((l) => /^\| CAP-/.test(l)).length;
}

function countSqlMigrations() {
  const dir = path.join(ROOT, "apps", "api", "src", "read-models", "sql");
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("V") && f.endsWith(".sql"))
    .sort();
}

test("T13 documentation gates coverage", async (t) => {
  await t.test("lint-docs covers the audit report, flag matrix and living V1 docs", () => {
    const source = read("scripts/lint-docs.mjs");
    for (const doc of [
      "docs/reports/2026-10-17-full-project-review.md",
      "docs/agent/2026-10-18-ted-agent-flag-matrix.md",
      "docs/MEU-TED-V1-FINAL-STATE.md",
      "docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md",
      "docs/RELEASE-PROCESS.md",
    ]) {
      assert.ok(source.includes(doc), `lint-docs.mjs must list ${doc}`);
    }
    const result = lintAllDocumentation();
    assert.equal(result.passed, true, `Doc lint failed: ${result.issues.slice(0, 5).join("; ")}`);
  });

  await t.test("audit report carries no broken relative links", () => {
    const issues = lintMarkdownDocument("docs/reports/2026-10-17-full-project-review.md");
    assert.equal(issues.length, 0, `Broken links remain: ${issues.slice(0, 5).join("; ")}`);
  });

  await t.test("runtime facts derive counts and latest migration from code", () => {
    const facts = generateRuntimeFacts();
    const files = countSqlMigrations();
    assert.equal(facts.counts.databaseMigrations, files.length, "migration count must match the sql tree");
    assert.equal(facts.counts.latestMigration, files[files.length - 1], "latest migration must be the max V* file");
    assert.equal(
      facts.counts.capabilitiesTotal,
      collectRegisteredTools().length,
      "capabilitiesTotal must match generated tools",
    );
    assert.equal(facts.counts.capabilityInventoryRows, countInventoryRows(), "inventory rows must match the doc table");
  });

  await t.test("facts distinguish schema version, product version and live claims", () => {
    const facts = generateRuntimeFacts();
    const rootPkg = JSON.parse(read("package.json"));
    assert.equal(facts.productVersion, rootPkg.version, "product version must come from package.json");
    assert.ok(facts.factsSchemaVersion, "facts must carry their own schema version");
    assert.notEqual(facts.factsSchemaVersion, facts.productVersion, "schema version is not the product version");
    assert.match(facts.production.database, /15/, "codebase evidence is PostgreSQL 15 (CI service, docs)");
    assert.doesNotMatch(facts.production.database, /16\+/, "must not claim PostgreSQL 16+");
  });

  await t.test("CI runs llm-contracts lint and the boundary gate", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /@pi-finance\/llm-contracts.*lint|lint.*@pi-finance\/llm-contracts/, "CI must lint llm-contracts");
    assert.match(ci, /pnpm boundary:check/, "CI must run boundary:check");
  });

  await t.test("pre-commit hook runs boundary and carries no stale lint note", () => {
    const hook = read(".husky/pre-commit");
    assert.match(hook, /pnpm boundary:check/, "hook must run boundary:check");
    assert.doesNotMatch(hook, /only for API and PWA/, "hook must not claim lint runs only for API and PWA");
  });

  await t.test("final validation covers llm-contracts lint, boundary and docs contracts", () => {
    const source = read("scripts/run-final-validation.mjs");
    assert.match(source, /llm-contracts[^`]*lint/, "validate:final must lint llm-contracts explicitly");
    assert.match(source, /pnpm boundary:check/, "validate:final must run boundary:check");
    assert.match(source, /lint-docs\.test\.mjs/, "validate:final must run the docs link contract");
  });

  await t.test("public-safety flags current-provider metadata shapes, not prose or placeholders", async () => {
    const { METADATA_RULES } = await import("./check-public-safety.mjs");
    const matches = (line) => METADATA_RULES.filter((r) => r.re.test(line)).map((r) => r.name);
    // Synthetic fixtures only (TEST-NET-1 / example host): never real identifiers.
    assert.ok(matches("ssh deploy@192.0.2.10 -p 22").length > 0, "ssh user with literal IP must warn");
    assert.ok(matches("host vmi123456.contabo.cloud ready").length > 0, "contabo-assigned host must warn");
    assert.equal(matches("Rodar na Contabo `deploy@<ip-vps-contabo>`").length, 0, "placeholder must not warn");
    assert.equal(matches("Backend de produção roda na **VPS Contabo**").length, 0, "prose must not warn");
    assert.equal(matches("proxied via api.synkroo.com.br edge").length, 0, "public edge DNS must not warn");
  });
});
