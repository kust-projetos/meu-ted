import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("documentation facts contract", async (t) => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");

  await t.test("README rejects stale historical falsehoods", () => {
    assert.doesNotMatch(readme, /Monorepo com 2 frentes ativas/i);
    assert.doesNotMatch(readme, /pnpm workspaces \(2 apps\)/i);
    assert.doesNotMatch(readme, /Toda a parte de domínio.*removidos/i);
  });

  await t.test("README accurately describes the current active apps and stack", () => {
    assert.ok(readme.includes("apps/api"));
    assert.ok(readme.includes("apps/pwa"));
    assert.ok(readme.includes("apps/agent"));
    // VPS migration 2026-10-03: the API runtime origin is the Contabo VPS and
    // the pi-financeiro was removed from the Hostinger in the same day.
    assert.ok(readme.includes("Contabo VPS"), "README must name the Contabo VPS as the API runtime");
    assert.doesNotMatch(
      readme,
      /Hostinger VPS[^.\n]{0,80}(apps\/api|API|Backend)/i,
      "README must not present the Hostinger VPS as the API runtime origin",
    );
    assert.ok(readme.includes("Cloudflare"));
  });

  await t.test("AGENTS.md accurately declares canonical pointers and rules", () => {
    assert.ok(agents.includes("apps/pwa/"));
    // Same migration: the API runtime is the Contabo VPS. The Hostinger still
    // hosts other services (ai-memory/synkroo/waha/infisical/hermes), so its
    // historical mention is legitimate and is not asserted against.
    assert.match(agents, /VPS Contabo|Contabo VPS/, "AGENTS.md must name the Contabo VPS as the API runtime");
    assert.doesNotMatch(
      agents,
      /Runtime: Node\.js hospedado na Hostinger/i,
      "AGENTS.md must not declare the Hostinger VPS as the API runtime",
    );
    assert.ok(agents.includes("../pi-finance-web"));
  });
});
