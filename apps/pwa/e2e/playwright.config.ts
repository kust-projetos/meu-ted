import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "@playwright/test";
import { resolveE2ePorts, resolveP2dPorts } from "./support/ports";

// The prep-only contract is required from the strict-CJS single source,
// never reimplemented here: the config is the authority for the Next-env
// preflight and the env scrub on the P2D_LIVE_PREP=1 opt-in path
// (including a direct CLI entrypoint). The Playwright config loader
// transpiles this file to CJS, so the contract MUST be require-safe:
// `./support/p2d-live-credential.cjs` (no `import.meta`, no ESM syntax).
// Requiring the `.mjs` facade here breaks with `SyntaxError: Cannot use
// 'import.meta' outside a module` (the `.mjs` stays the ESM entrypoint for
// `p2d-live-prep.mjs` and the node:test contract only).
const require = createRequire(__filename);
const { assertNoBlockingNextEnvFiles, buildPlaywrightEnv } = require("./support/p2d-live-credential.cjs") as {
  assertNoBlockingNextEnvFiles: (pwaDir: string) => true;
  buildPlaywrightEnv: (baseEnv?: Record<string, string | undefined>) => Record<string, string>;
};

// P2D synthetic-conversation browser stack (test-only, loopback only):
// own Fastify API + gateway probe + Next dev + control server. Started ONLY
// with P2D_BROWSER=1 (or the prep-only P2D_LIVE_PREP=1 opt-in, which implies
// it); the historical topology above is untouched.
const P2D = process.env.P2D_BROWSER === "1";
// Prep-only opt-in (set by pnpm test:p2d-live-prep alongside P2D_BROWSER):
// selects the live-prep spec and implies the p2d-synthetic project so the
// -g selection always has a target. Default path (unset) is untouched.
const LIVE_PREP = process.env.P2D_LIVE_PREP === "1";
const P2D_ACTIVE = P2D || LIVE_PREP;
// Fail-closed, unconditionally: Playwright starts and cleans up its own
// servers per run and never attaches to a pre-existing (possibly alien)
// process. There is no ownership flag and no reuse pathway.
const PWA_ROOT = path.resolve(__dirname, "..");
const PWA_APP_DIR = PWA_ROOT;

// LIVE_PREP authority (fail-closed, BEFORE any port is resolved or any
// webServer is constructed): with P2D_LIVE_PREP=1 this config runs the
// Next-env preflight (contents never read) and replaces process.env with
// the allowlisted Playwright env (same builder the launcher uses), so even
// a direct CLI entrypoint can never start servers with a raw env — no raw
// E2E_*/P2D_* value can reach an error message or a listener. Untouched
// when unset: the default path keeps resolving the ambient env.
if (LIVE_PREP) {
  assertNoBlockingNextEnvFiles(PWA_ROOT);
  const clean = buildPlaywrightEnv(process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
}

// Opt-in local overrides (E2E_FIXTURE_PORT / E2E_NEXT_PORT / E2E_HARNESS_PORT);
// defaults preserve the historical topology (fixture 4010 · Next 3001 · harness 3000).
// Under LIVE_PREP these resolve from the ALREADY-sanitized env above.
const { fixturePort: FIXTURE_PORT, nextPort: NEXT_PORT, harnessPort: HARNESS_PORT } =
  resolveE2ePorts(process.env);
const p2dPorts = resolveP2dPorts(process.env);
const P2D_API_BASE = `http://127.0.0.1:${p2dPorts.apiPort}`;
const P2D_GATEWAY_BASE = `http://127.0.0.1:${p2dPorts.gatewayPort}`;
const P2D_NEXT_BASE = `http://127.0.0.1:${p2dPorts.nextPort}`;

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
    // Prep-only opt-in exposes ONLY the p2d-synthetic project below: a
    // direct CLI can never select functional-mobile/desktop, pwa-runtime
    // or push-runtime with LIVE_PREP=1. Untouched when unset.
    ...(!LIVE_PREP
      ? [
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
        ]
      : []),
    ...(P2D_ACTIVE
      ? [
          {
            // P2D synthetic conversation (test-only, loopback only): real Next/PWA
            // browser → same-origin proxy → real loopback gateway → real SDK →
            // scripted local stub → real finance tools → real Fastify handlers.
            // Registered with P2D_BROWSER=1 (or the prep-only P2D_LIVE_PREP=1
            // opt-in, which implies it), with the stack webServers below;
            // without opt-in the project does not exist. On the live-prep
            // opt-in the selection is forced to the live-prep spec only, on
            // ANY entrypoint (direct CLI included) — no other P2D spec runs.
            name: "p2d-synthetic",
            use: {
              viewport: { width: 390, height: 844 },
              serviceWorkers: "block",
              baseURL: P2D_NEXT_BASE,
            },
            testMatch: LIVE_PREP ? "**/p2d/p2d-live-prep.spec.ts" : "**/p2d/*.spec.ts",
            fullyParallel: false,
            timeout: 600000,
          },
        ]
      : []),
  ],

  webServer: PRODUCTION_SMOKE ? undefined : [
    // Prep-only opt-in (P2D_LIVE_PREP=1, via pnpm test:p2d-live-prep): skip
    // the historical topology (fixture API, standalone Next, SW harness) so
    // ONLY the P2D webServers below run — no extra servers, no
    // .next/standalone copy. Untouched when P2D_LIVE_PREP is unset,
    // including P2D_BROWSER=1.
    ...(!LIVE_PREP
      ? [
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
        ]
      : []),
    // P2D synthetic-conversation stack (P2D_BROWSER=1, or the prep-only
    // P2D_LIVE_PREP=1 opt-in which implies it): the coordinator
    // owns the Fastify API + gateway probe + control server lifecycle, and a
    // separate Next dev process serves the REAL PWA against that stack
    // (NEXT_PUBLIC base forced empty so the browser uses the same-origin
    // proxy; no fixture, no production).
    ...(P2D_ACTIVE
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
