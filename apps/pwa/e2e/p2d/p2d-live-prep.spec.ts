/**
 * P2D live-prep — opt-in live TED runtime proof on Playwright-owned services.
 *
 * Runs ONLY via `pnpm test:p2d-live-prep` (which sets `P2D_LIVE_PREP=1` and
 * selects this spec with `-g p2d-live-prep`); the file-level skip below
 * keeps default P2D runs (`P2D_BROWSER=1` without the opt-in) unaffected —
 * the synthetic conversation spec stays byte-identical and green.
 *
 * Lifecycle ownership: Playwright `webServer` entries
 * (`e2e/playwright.config.ts`, `reuseExistingServer: false`) own the
 * synthetic Fastify/in-memory API, the synthetic P2D gateway and the real
 * Next dev PWA, and the Playwright worker process owns this live boot.
 * This spec spawns NOTHING — no API/stack/PWA child, no runtime child
 * process, no supervisor. The real TED runtime boots IN THIS WORKER
 * (already an isolated process): the allowlisted env is applied before the
 * SDK import (whose roots are captured at import time) and `process.env`
 * is restored in full afterwards, on success and on failure. If this
 * worker were terminated abruptly, there is no extra child to survive —
 * by construction, not by supervision.
 *
 * Prep-only: proves HTTP responses + the live boot receipt (profile live,
 * credential present in the swapped-in env only, repo-owned model,
 * loopback origins, no listener). NEVER sends a message, never calls
 * session.prompt, never attempts provider inference, never exposes a live
 * `/rpc/chat`. P2D counters prove zero prompt/provider/tool calls. No
 * financial writes (journal re-read after the PWA served).
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveP2dPorts } from "../support/ports";

// No import.meta for the spec's own location: Playwright loads specs
// through a CJS transform (precedent:
// e2e/xlt/xlt-06-canonical-agent-runtime.spec.ts). The .mjs contract is
// loaded via require (Node >=22.12 supports require(esm)); the product
// entrypoints below are loaded via file URLs (works in both CJS and ESM).
const require = createRequire(__filename);
const {
  LIVE_CREDENTIAL_ALIAS,
  LIVE_CREDENTIAL_TARGET,
  assertIsolatedHome,
  buildLiveRuntimeEnv,
  isLoopbackOrigin,
  loadLiveCredential,
  loadLiveModelSelector,
  resolveConfiguredLiveModel,
  validateLivePrepReceipt,
  withLiveBootBoundary,
  LIVE_BOOT_FAILURE_MESSAGE,
} = require("../support/p2d-live-credential.mjs") as {
  LIVE_BOOT_FAILURE_MESSAGE: string;
  LIVE_CREDENTIAL_ALIAS: string;
  LIVE_CREDENTIAL_TARGET: string;
  assertIsolatedHome: (home: string) => string;
  buildLiveRuntimeEnv: (args: {
    baseEnv?: Record<string, string | undefined>;
    credentialValue: string;
    tedHome: string;
    tedIdentity: string;
    apiBaseUrl: string;
    profile?: string;
  }) => NodeJS.ProcessEnv;
  isLoopbackOrigin: (value: string) => boolean;
  loadLiveCredential: (args: { rootDir: string; alias?: string }) => { alias: string; value: string };
  loadLiveModelSelector: (args?: { liveModelFile?: string }) => string;
  resolveConfiguredLiveModel: (args?: { tedRuntimeDir?: string }) => Promise<string>;
  validateLivePrepReceipt: (receipt: unknown, opts?: { expectedModel?: string }) => true;
  withLiveBootBoundary: <T>(envVars: Record<string, string | undefined>, fn: (env: NodeJS.ProcessEnv) => Promise<T> | T, target?: NodeJS.ProcessEnv) => Promise<T>;
};

const HERE = __dirname;
const PWA_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const TED_RUNTIME_DIR = path.resolve(PWA_ROOT, "..", "ted-runtime");

const ports = resolveP2dPorts(process.env);
const API_BASE = `http://127.0.0.1:${ports.apiPort}`;
const GATEWAY_BASE = `http://127.0.0.1:${ports.gatewayPort}`;
const CTL_BASE = `http://127.0.0.1:${ports.ctlPort}`;
const PWA_BASE = `http://127.0.0.1:${ports.nextPort}`;

function expectedModel(): string {
  return loadLiveModelSelector();
}

function approvedTmpRoot(prefix: string): string {
  const base =
    process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "Temp", "opencode") : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

type LiveReceipt = {
  ok: boolean;
  phase: string;
  profile: string;
  model: string;
  credentialPresent: boolean;
  apiLoopback: boolean;
  listenerExposed: boolean;
};

/**
 * Boots the real live TED runtime IN THIS WORKER (already an isolated
 * process) and returns its prep-only receipt. The allowlisted env is
 * applied before the SDK import (whose roots are captured at import time)
 * and `process.env` is restored in full afterwards, on success and on
 * failure, via the shared `withLiveBootBoundary`. No child process is ever
 * created — if this worker were terminated abruptly, there is no extra
 * runtime process to survive, by construction, not by supervision.
 */
async function runLiveBootOnce(runtimeEnv: NodeJS.ProcessEnv): Promise<LiveReceipt> {
  // COMPLETE boot boundary with a SINGLE fixed-text exit: the ENTIRE
  // withLiveBootBoundary call — env swap, validations, model check, dynamic
  // imports, the live boot AND the restore — converts ANY failure into the
  // fixed allowlisted message. No original error, cause or stack ever
  // reaches the Playwright reporter (SDK/runtime internals may embed the
  // credential in any form: literal, encoded or fragmented). Sentinel
  // success is the only non-throwing path.
  let receipt: LiveReceipt | null = null;
  await withLiveBootBoundary(runtimeEnv, async () => {
      if (process.env.TED_RUNTIME_PROFILE !== "live") {
        throw new Error("p2d-live-prep: TED_RUNTIME_PROFILE must be exactly 'live' (fail-closed)");
      }
      // Presence boolean ONLY — the value is never assigned, logged or forwarded.
      const credentialPresent =
        typeof process.env[LIVE_CREDENTIAL_TARGET] === "string" && process.env[LIVE_CREDENTIAL_TARGET].length > 0;
      if (!credentialPresent) {
        throw new Error(`p2d-live-prep: ${LIVE_CREDENTIAL_TARGET} is absent — refusing live boot (fail-closed)`);
      }
      const apiBaseUrl = process.env.TED_API_BASE_URL;
      if (typeof apiBaseUrl !== "string" || !isLoopbackOrigin(apiBaseUrl)) {
        throw new Error("p2d-live-prep: TED_API_BASE_URL must be a bare loopback origin (fail-closed)");
      }
      const tedHome = process.env.TED_RUNTIME_HOME;
      if (typeof tedHome !== "string" || tedHome.length === 0) {
        throw new Error("p2d-live-prep: TED_RUNTIME_HOME is required (fail-closed)");
      }
      const home = assertIsolatedHome(tedHome);
      const identity = process.env.TED_RUNTIME_IDENTITY || "live-prep";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(identity)) {
        throw new Error("p2d-live-prep: TED_RUNTIME_IDENTITY must be a single safe path segment (fail-closed)");
      }
      const model = await resolveConfiguredLiveModel();
      if (model !== loadLiveModelSelector()) {
        throw new Error("p2d-live-prep: configured live model diverged from live-model.json (fail-closed)");
      }

      // Product boot AFTER every check above (SDK import observes the
      // allowlisted env; live profile preserves ONLY the mapped credential
      // key). The gateway listener is replaced by a prep-only stub: wiring
      // construction is proven, then `listen` throws the sentinel — no
      // socket, no live `/rpc/chat`. The product's own close guarantee
      // releases the SDK env before the sentinel propagates. No prompt
      // exists anywhere on this path.
      const { startTedRuntime } = await import(pathToFileURL(path.join(TED_RUNTIME_DIR, "src", "main.mjs")).href);
      let gatewayWired = false;
      const prepOnlyGatewayServer = (opts: {
        resolveIdentity?: unknown;
        store?: unknown;
        promptHost?: unknown;
        createRuntimeSession?: unknown;
      }) => {
        if (
          !opts ||
          typeof opts.resolveIdentity !== "function" ||
          !opts.store ||
          !opts.promptHost ||
          typeof opts.createRuntimeSession !== "function"
        ) {
          throw new Error("p2d-live-prep: gateway wiring diverged (fail-closed)");
        }
        gatewayWired = true;
        const sentinel = new Error("p2d-live-prep: listener disabled in prep-only (no live /rpc/chat is exposed)");
        (sentinel as NodeJS.ErrnoException).code = "live_prep_no_listen";
        return {
          server: null,
          listen: async () => {
            throw sentinel;
          },
          close: async () => {},
        };
      };
      let sentinelSeen = false;
      try {
        await startTedRuntime({
          env: {
            TED_RUNTIME_HOME: home,
            TED_RUNTIME_IDENTITY: identity,
            TED_API_BASE_URL: apiBaseUrl,
            TED_RUNTIME_PROFILE: "live",
          },
          deps: { createGatewayServer: prepOnlyGatewayServer },
          diagnosticsSink: () => {},
        });
      } catch (inner) {
        if (inner && (inner as { code?: string }).code === "live_prep_no_listen" && gatewayWired) {
          sentinelSeen = true;
          // Expected: wiring proven, SDK closed by the product guarantee,
          // no listener ever bound.
        } else {
          throw new Error("p2d-live-prep: live runtime boot failed (fail-closed)");
        }
      }
      if (!sentinelSeen) {
        throw new Error("p2d-live-prep: live runtime boot failed (fail-closed)");
      }
      const liveReceipt: LiveReceipt = {
        ok: true,
        phase: "live-prep-ready",
        profile: "live",
        model,
        credentialPresent: true,
        apiLoopback: true,
        listenerExposed: false,
      };
      validateLivePrepReceipt(liveReceipt, { expectedModel: model });
      receipt = liveReceipt;
  });
  if (receipt === null) throw new Error(LIVE_BOOT_FAILURE_MESSAGE);
  return receipt;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

test.describe.configure({ mode: "serial" });

test.describe("p2d-live-prep (opt-in live runtime proof, prep-only)", () => {
  test.skip(process.env.P2D_LIVE_PREP !== "1", "opt-in only: run via pnpm test:p2d-live-prep");

  test("stack + PWA respond and live runtime boots without a listener", async () => {
    // NOTE: the Next-env preflight runs in the launcher CLI BEFORE Playwright
    // (and its webServers) start — checking here would be too late.
    // Credential from the two known local locations only; mapped SOLELY
    // into the live runtime env below (temporarily applied to this worker,
    // restored afterwards; never logged, never asserted by value).
    const credential = loadLiveCredential({ rootDir: REPO_ROOT, alias: LIVE_CREDENTIAL_ALIAS });
    const model = expectedModel();

    // 1. Playwright-owned stack health (fresh run owned by webServer).
    const ctlHealth = await getJson(`${CTL_BASE}/health`);
    expect(ctlHealth.status).toBe(200);
    expect((ctlHealth.body as { probeRunning?: boolean })?.probeRunning).toBe(true);

    // 2. Synthetic API /health DTO (safe route, direct proof).
    const api = await getJson(`${API_BASE}/health`);
    expect(api.status).toBe(200);
    const apiBody = api.body as Record<string, unknown>;
    expect(apiBody?.status).toBe("ok");
    for (const key of ["gitSha", "buildId", "builtAt"]) {
      expect(typeof apiBody?.[key]).toBe("string");
    }

    // 3. Synthetic gateway safe GET: expected Fastify 404 (no prompt).
    const gateway = await getJson(`${GATEWAY_BASE}/`);
    expect(gateway.status).toBe(404);
    expect((gateway.body as { code?: string })?.code).toBe("gateway.not_found");

    // 4. Journal: zero financial writes at start.
    const journal = await getJson(`${CTL_BASE}/p2d/journal`);
    expect(journal.status).toBe(200);
    expect((journal.body as { financialWrites?: unknown[] })?.financialWrites).toEqual([]);

    // 5. Real PWA (Playwright-owned Next dev) answers 200.
    const pwa = await getJson(`${PWA_BASE}/`);
    expect(pwa.status).toBe(200);

    // 6. Journal re-read AFTER the PWA served: whole window covered.
    const journalFinal = await getJson(`${CTL_BASE}/p2d/journal`);
    expect(journalFinal.status).toBe(200);
    expect((journalFinal.body as { financialWrites?: unknown[] })?.financialWrites).toEqual([]);

    // 7. Live TED boot in this worker: profile live, isolated home,
    // loopback API; boots the real runtime with the listener replaced by a
    // prep-only stub. The allowlisted env is swapped in only for the boot
    // and restored in full afterwards. No /rpc/chat ever exists.
    const runtimeEnv = buildLiveRuntimeEnv({
      baseEnv: process.env,
      credentialValue: credential.value,
      tedHome: approvedTmpRoot("ted-live-prep"),
      tedIdentity: "live-prep",
      apiBaseUrl: API_BASE,
    });
    const receipt = await runLiveBootOnce(runtimeEnv);
    expect(receipt.phase).toBe("live-prep-ready");
    expect(receipt.profile).toBe("live");
    expect(receipt.model).toBe(model);
    expect(receipt.credentialPresent).toBe(true);
    expect(receipt.apiLoopback).toBe(true);
    expect(receipt.listenerExposed).toBe(false);

    // The P2D stack also runs a local scripted provider for other specs.
    // This prep-only path must leave its prompt/provider/tool counters at zero.
    const stats = await getJson(`${CTL_BASE}/p2d/stats`);
    expect(stats.status).toBe(200);
    const counters = stats.body as Record<string, unknown>;
    expect(counters.promptCalls).toBe(0);
    expect(counters.stubTurns).toBe(0);
    expect(counters.transportCalls).toBe(0);
  });
});
