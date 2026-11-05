import path from "node:path";
import { defineConfig } from "@playwright/test";
import { resolveE2ePorts, resolveP2dPorts } from "./support/ports";

// Opt-in local overrides (E2E_FIXTURE_PORT / E2E_NEXT_PORT / E2E_HARNESS_PORT);
// defaults preserve the historical topology (fixture 4010 · Next 3001 · harness 3000).
const { fixturePort: FIXTURE_PORT, nextPort: NEXT_PORT, harnessPort: HARNESS_PORT } =
  resolveE2ePorts(process.env);
// P2D synthetic-conversation browser stack (test-only, loopback only):
// own Fastify API + gateway probe + Next dev + control server. Started ONLY
// with P2D_BROWSER=1; the historical topology above is untouched.
const P2D = process.env.P2D_BROWSER === "1";
const p2dPorts = resolveP2dPorts(process.env);
const P2D_API_BASE = `http://127.0.0.1:${p2dPorts.apiPort}`;
const P2D_GATEWAY_BASE = `http://127.0.0.1:${p2dPorts.gatewayPort}`;
const P2D_NEXT_BASE = `http://127.0.0.1:${p2dPorts.nextPort}`;
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
  // NOTE: scenario repetition for flake detection is NOT configured here.
  // The opt-in E2E_RUNTIME_REPEAT_EACH env is validated by e2e/run-ci.sh and
  // passed as `--repeat-each=N` only to the pwa-runtime / push-runtime gates
  // (repeatEach is top-level and would leak into the functional gates if set
  // here). Contract + unit tests: e2e/support/repeat-each.ts.

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
    ...(P2D
      ? [
          {
            // P2D synthetic conversation (test-only, loopback only): real Next/PWA
            // browser → same-origin proxy → real loopback gateway → real SDK →
            // scripted local stub → real finance tools → real Fastify handlers.
            // Registered only with P2D_BROWSER=1 (with the stack webServers
            // below); without opt-in the project does not exist.
            name: "p2d-synthetic",
            use: {
              viewport: { width: 390, height: 844 },
              serviceWorkers: "block",
              baseURL: P2D_NEXT_BASE,
            },
            testMatch: "**/p2d/*.spec.ts",
            fullyParallel: false,
            timeout: 600000,
          },
        ]
      : []),
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
    // P2D synthetic-conversation stack (P2D_BROWSER=1 only): the coordinator
    // owns the Fastify API + gateway probe + control server lifecycle, and a
    // separate Next dev process serves the REAL PWA against that stack
    // (NEXT_PUBLIC base forced empty so the browser uses the same-origin
    // proxy; no fixture, no production).
    ...(P2D
      ? [
          {
            command: `pnpm exec tsx e2e/support/p2d-browser-stack.mts`,
            port: p2dPorts.ctlPort,
            cwd: PWA_ROOT,
            reuseExistingServer: false,
            timeout: 240000,
            env: {
              ...process.env,
              P2D_API_PORT: String(p2dPorts.apiPort),
              P2D_GATEWAY_PORT: String(p2dPorts.gatewayPort),
              P2D_CTL_PORT: String(p2dPorts.ctlPort),
              P2D_NEXT_PORT: String(p2dPorts.nextPort),
            },
          },
          {
            command: `pnpm exec next dev --webpack --port ${p2dPorts.nextPort} --hostname 127.0.0.1`,
            port: p2dPorts.nextPort,
            cwd: PWA_ROOT,
            reuseExistingServer: false,
            timeout: 240000,
            env: {
              ...process.env,
              PORT: String(p2dPorts.nextPort),
              HOSTNAME: "127.0.0.1",
              PWA_BACKEND_PROXY_ORIGIN: P2D_API_BASE,
              TED_OPENCODE_RUNTIME_ENABLED: "1",
              TED_OPENCODE_GATEWAY_ORIGIN: P2D_GATEWAY_BASE,
              ALLOW_LOCAL_ORIGIN: "1",
              NEXT_PUBLIC_PI_FINANCE_API_BASE_URL: "",
              NEXT_PUBLIC_LEGACY_BEARER_COMPAT: "off",
            },
          },
        ]
      : []),
  ],
});
