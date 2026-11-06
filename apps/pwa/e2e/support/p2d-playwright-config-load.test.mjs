// P2D Playwright config-load regression (node:test, static only).
//
// Proves `e2e/playwright.config.ts` loads under the REAL Playwright CLI
// loader (`test --list`: parses the config, lists tests, starts NO
// webServer, runs NO spec, reads NO credential, opens NO listener).
// Fails on the `createRequire`-of-`.mjs` loader bug (`SyntaxError: Cannot
// use 'import.meta' outside a module`); passes when the config requires the
// helper's strict CJS entry. Never invokes the live runner (`p2d-live-prep`),
// never sets P2D_BROWSER/P2D_LIVE_PREP, never touches `.env` contents.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_ROOT = path.resolve(HERE, "..", "..");
const PLAYWRIGHT_CLI = path.join(PWA_ROOT, "node_modules", "@playwright", "test", "cli.js");

describe("p2d playwright config load (static --list, no servers)", () => {
  it("loads e2e/playwright.config.ts without the import.meta loader error", () => {
    const env = { ...process.env };
    // Default path only: the require(.mjs) ran unconditionally at the top
    // of the config, so even the default load proves the cause — and the
    // opt-in flags must never be set by a static load test.
    delete env.P2D_BROWSER;
    delete env.P2D_LIVE_PREP;
    const res = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", "--list", "--config", "e2e/playwright.config.ts"], {
      cwd: PWA_ROOT,
      encoding: "utf8",
      timeout: 120000,
      env,
    });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    assert.ok(!out.includes("import.meta"), `config must not fail on import.meta (static load):\n${out.slice(0, 2000)}`);
    assert.ok(!out.includes("SyntaxError"), `config must load without SyntaxError (static load):\n${out.slice(0, 2000)}`);
    assert.equal(res.status, 0, `playwright --list must exit 0 (static load):\n${out.slice(0, 2000)}`);
  });
});
