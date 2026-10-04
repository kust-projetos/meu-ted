import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRuntimeFacts } from "./generate-documentation-facts.mjs";

test("runtime documentation facts generator", async (t) => {
  await t.test("generates facts with valid counts, workspaces, and production topology", () => {
    const facts = generateRuntimeFacts();

    assert.ok(facts.counts.apiRoutes > 80, "Must count declared API routes");
    assert.ok(facts.counts.databaseMigrations >= 30, "Must count database migrations up to V030");
    assert.equal(facts.architecture.canonicalPwaPath, "apps/pwa");
    assert.equal(facts.architecture.deprecatedOrigin, "../pi-finance-web");
    assert.equal(facts.production.vpsProvider, "Contabo VPS");
    assert.equal(facts.production.edgeProvider, "Cloudflare");
  });
});
