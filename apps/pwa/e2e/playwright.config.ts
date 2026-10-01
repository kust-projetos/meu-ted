import path from "node:path";
import { defineConfig } from "@playwright/test";
import { resolveE2ePorts } from "./support/ports";

// Opt-in local overrides (E2E_FIXTURE_PORT / E2E_NEXT_PORT / E2E_HARNESS_PORT);
// defaults preserve the historical topology (fixture 4010 · Next 3001 · harness 3000).
const { fixturePort: FIXTURE_PORT, nextPort: NEXT_PORT, harnessPort: HARNESS_PORT } =
  resolveE2ePorts(process.env);
// Fail-closed, unconditionally: Playwright starts and cleans up its own
// servers per run and never attaches to a pre-existing (possibly alien)
// process. There is no ownership flag and no reuse pathway.
const PWA_ROOT = path.resolve(__dirname, "..");
const PWA_APP_DIR = PWA_ROOT;

const PRODUCTION_SMOKE = process.env.E2E_PRODUCTION_SMOKE === "1";
if (PRODUCTION_SMOKE && !process.env.E2E_PRODUCTION_URL) {
  throw new Error("E2E_PRODUCTION_URL is required when E2E_PRODUCTION_SMOKE is enabled");
}

export default defineConfig({
  testDir: ".",
  testMatch: "specs/**/*.spec.ts",
  timeout: 45000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,

  use: {
    baseURL: `http://127.0.0.1:${HARNESS_PORT}`,
    headless: true,
    serviceWorkers: "allow",
    extraHTTPHeaders: {
      "x-e2e-test-id": "default-test",
    },
  },

  projects: [
    {
      name: "functional-mobile",
      use: {
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      },
      testMatch: "specs/**/*.spec.ts",
      testIgnore: ["**/pwa-runtime.spec.ts", "**/push-runtime.spec.ts"],
    },
    {
      name: "functional-desktop",
      use: {
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
      },
      testMatch: "specs/**/*.spec.ts",
      testIgnore: ["**/pwa-runtime.spec.ts", "**/push-runtime.spec.ts"],
    },
    {
      name: "pwa-runtime",
      use: {
        viewport: { width: 390, height: 844 },
        serviceWorkers: "allow",
        baseURL: `http://127.0.0.1:${HARNESS_PORT}`,
      },
      testMatch: "**/pwa-runtime.spec.ts",
      fullyParallel: false,
      timeout: 60000,
    },
    {
      name: "push-runtime",
      use: {
        viewport: { width: 390, height: 844 },
        serviceWorkers: "allow",
        baseURL: `http://127.0.0.1:${HARNESS_PORT}`,
        headless: true,
      },
      testMatch: "**/push-runtime.spec.ts",
      fullyParallel: false,
      timeout: 60000,
    },
    {
      name: "production-smoke",
      use: {
        baseURL:
          // Fallback only: live smoke always sets E2E_PRODUCTION_URL (the
          // deploy workflows fail closed when the repo variable is unset).
          process.env.E2E_PRODUCTION_URL || "https://pwa.example",
      },
      testMatch: "**/production-smoke.spec.ts",
      grepInvert: process.env.E2E_PRODUCTION_SMOKE ? undefined : /.*/,
    },
  ],

  webServer: PRODUCTION_SMOKE ? undefined : [
    {
      command: `pnpm exec tsx e2e/fixture-api/server.ts --port ${FIXTURE_PORT}`,
      port: FIXTURE_PORT,
      cwd: PWA_ROOT,
      reuseExistingServer: false,
      timeout: 90000,
    },
    {
      // Next standalone server (harness proxies harness-port → next-port).
      command: `node e2e/standalone-server.mjs`,
      port: NEXT_PORT,
      cwd: PWA_APP_DIR,
      reuseExistingServer: false,
      timeout: 90000,
      env: {
        ...process.env,
        PORT: String(NEXT_PORT),
        HOSTNAME: "127.0.0.1",
        NEXT_PUBLIC_PI_FINANCE_API_BASE_URL: `http://127.0.0.1:${FIXTURE_PORT}`,
        // Root cause fix: the built client calls the relative /api/backend
        // proxy (baked from .env.local at build time), so the runtime
        // NEXT_PUBLIC_* env above never reaches the browser. The proxy route
        // (/api/backend/[...path]) forwards to PWA_BACKEND_PROXY_ORIGIN,
        // defaulting to production — point it at the fixture instead, or the
        // fixture journal stays empty and AUTH-01 can never pass.
        PWA_BACKEND_PROXY_ORIGIN: `http://127.0.0.1:${FIXTURE_PORT}`,
      },
    },
    {
      // SW harness owns /sw.js + /__e2e/sw/deploy; proxies the rest to Next.
      // --fixture lets the harness apply the same CSP accommodation the
      // page.route rewrite applies (SW-served navigations bypass page.route).
      command: `pnpm exec tsx e2e/sw-harness/server.ts --target=${NEXT_PORT} --port=${HARNESS_PORT} --fixture=${FIXTURE_PORT}`,
      port: HARNESS_PORT,
      cwd: PWA_ROOT,
      reuseExistingServer: false,
      timeout: 90000,
    },
  ],
});
