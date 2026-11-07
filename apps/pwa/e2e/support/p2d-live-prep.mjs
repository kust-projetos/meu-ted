// P2D live-prep launcher — thin opt-in entrypoint, no supervision.
//
// The Playwright `p2d-synthetic` project owns the services through its
// `webServer` entries (`apps/pwa/e2e/playwright.config.ts`: the UNCHANGED
// `p2d-browser-stack.mts` stack + real Next dev PWA, both with
// `reuseExistingServer: false`). This module NEVER spawns the API, the
// gateway, the stack or the PWA, and it owns no process tree, no
// close-probe and no shutdown coordinator: importing it is inert, and the
// only opt-in that starts anything is invoking this file as a CLI, which
// selects the P2D_LIVE_PREP opt-in via env flags and loads the Playwright
// CLI IN THIS PROCESS — Playwright becomes the root process and owns its
// webServers, including SIGINT/SIGTERM handling. The Playwright config is
// the authority for the Next-env preflight and the env scrub (it enforces
// both on every entrypoint, including a direct CLI call).
//
// Single command (repo root): `pnpm test:p2d-live-prep`
//   node apps/pwa/e2e/support/p2d-live-prep.mjs [--help]
//
// What the delegated run executes (all under Playwright lifecycle):
//   `e2e/p2d/p2d-live-prep.spec.ts` (selected via `-g`, skipped unless
//   `P2D_LIVE_PREP=1`, so default P2D runs are unaffected) proves the HTTP
//   responses against the Playwright-owned stack/PWA and boots the real
//   live TED runtime in the worker process itself (allowlisted env applied
//   before the SDK import, restored in full afterwards — no extra process
//   to survive a worker kill). Prep-only: no message, no prompt, no
//   inference, no live `/rpc/chat` listener.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { isCliEntry } from "./p2d-live-credential.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_ROOT = path.resolve(HERE, "..", "..");

const PLAYWRIGHT_PROJECT = "p2d-synthetic";

// One selection per opt-in. `live-prep` is the historical default (bare
// invocation); `--offline` runs the full offline chat with the loopback
// provider; `--live-real` is the future real-provider command (credential
// loaded ONLY inside the isolated runtime child, never here).
const MODES = {
  "live-prep": { flag: "P2D_LIVE_PREP", grep: "p2d-live-prep" },
  offline: { flag: "P2D_OFFLINE_CHAT", grep: "p2d-live-offline" },
  "live-real": { flag: "P2D_LIVE_REAL", grep: "p2d-live-real" },
};
const MODE_FLAGS = ["P2D_LIVE_PREP", "P2D_OFFLINE_CHAT", "P2D_LIVE_REAL"];

/**
 * Pure CLI parsing (exercised in an isolated subprocess, never imported
 * into a test runner): `--help` is inert (usage only, no credential
 * read, no network, no spawn, no Playwright load); bare invocation loads
 * Playwright in-process (the single opt-in); anything else fails closed.
 * `--offline` and `--live-real` are mutually exclusive.
 */
export function parsePrepArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--help") || args.includes("-h")) return { mode: "help" };
  const offline = args.includes("--offline");
  const liveReal = args.includes("--live-real");
  if (offline && liveReal) {
    return { mode: "error", message: "p2d-live-prep: --offline and --live-real are mutually exclusive (fail-closed)" };
  }
  const unknown = args.filter((a) => a !== "--offline" && a !== "--live-real");
  if (unknown.length > 0) {
    return { mode: "error", message: `p2d-live-prep: unknown args ${JSON.stringify(unknown).slice(0, 120)} (fail-closed)` };
  }
  if (offline) return { mode: "run", flavor: "offline" };
  if (liveReal) return { mode: "run", flavor: "live-real" };
  return { mode: "run" };
}

function usage() {
  return [
    "p2d-live-prep: prep-only live TED verification (opt-in, never CI).",
    "",
    "Usage: node apps/pwa/e2e/support/p2d-live-prep.mjs [--help]",
    "       node apps/pwa/e2e/support/p2d-live-prep.mjs --offline",
    "       node apps/pwa/e2e/support/p2d-live-prep.mjs --live-real",
    "",
    "Bare invocation loads the existing Playwright P2D lifecycle in-process",
    `(project "${PLAYWRIGHT_PROJECT}", webServer-owned stack + PWA) running`,
    'only the "p2d-live-prep" spec (skipped unless P2D_LIVE_PREP=1).',
    "",
    "--offline  runs the full offline chat (real browser → PWA proxy →",
    "           real gateway/SDK → loopback OpenAI-compatible provider",
    "           with a dummy key → finance tools → synthetic API). The",
    "           runtime profile stays live and the provider/model come",
    "           from apps/ted-runtime/src/live-model.json.",
    "--live-real is the future real-provider run. It reads the alias",
    "           OPENCODE_GO from the two allowlisted local .env files and",
    "           supplies it as OPENCODE_GO_API_KEY ONLY to the isolated",
    "           runtime child; setupIsolation scrubs the inherited env and",
    "           preserves that alias. The P2D live-real probe then maps the",
    "           alias to the native OPENCODE_API_KEY that OpenCode 2.2.4",
    "           resolves for `opencode-go` (alias removed); the prep path and",
    "           the product bootstrap never map it. PWA/Next/Playwright never",
    "           see it. Not executed by CI and not run by default.",
    "",
    "WARNING: do NOT run --live-real until the operator explicitly confirms",
    "the scope of the authorization, the current quota and Extra Usage. This",
    "command performs real provider inference; it is not verified here.",
    "",
    "This launcher spawns nothing and supervises no tree:",
    "Playwright is the root process and cleans up its own webServers.",
    "The Playwright config enforces the Next-env preflight, the env",
    "scrub and the mode-only selection on every entrypoint.",
  ].join("\n");
}

/**
 * Loads the Playwright CLI in THIS process (the cli.js entrypoint only
 * requires `playwright/lib/program` and parses `process.argv`). Private
 * helper: called solely from the CLI run path below, never exported, so
 * importing this module can never start Playwright as a side effect.
 * Runs with `process.argv` rewritten to the Playwright invocation and cwd
 * at the PWA root. No child process is created; Playwright owns SIGINT/SIGTERM
 * and its webServer lifecycle, including on Windows. Preflight and env scrub
 * are the config's job (it runs them before any webServer is constructed).
 */
function loadPlaywrightCli(flavor = "live-prep") {
  const selection = MODES[flavor] ?? MODES["live-prep"];
  const requireFromPwa = createRequire(path.join(PWA_ROOT, "package.json"));
  let cliPath;
  try {
    cliPath = requireFromPwa.resolve("@playwright/test/cli");
  } catch {
    throw new Error("p2d-live-prep: @playwright/test CLI unresolvable from apps/pwa (fail-closed)");
  }
  process.chdir(PWA_ROOT);
  process.argv = [
    process.argv[0],
    cliPath,
    "test",
    "--config",
    "e2e/playwright.config.ts",
    "--project",
    PLAYWRIGHT_PROJECT,
    "-g",
    selection.grep,
  ];
  createRequire(import.meta.url)(cliPath);
}

async function main() {
  const parsed = parsePrepArgs(process.argv.slice(2));
  if (parsed.mode === "help") {
    console.log(usage());
    return { ok: true };
  }
  if (parsed.mode === "error") throw new Error(parsed.message);
  // Opt-in flags only. The Playwright config is the authority for the
  // Next-env preflight and the env scrub: it enforces both before any
  // webServer is constructed, on every entrypoint (including a direct
  // CLI call that bypasses this launcher). Exactly one mode is selected;
  // the other flags are cleared so ambient values can never select two.
  const flavor = parsed.flavor ?? "live-prep";
  for (const key of MODE_FLAGS) delete process.env[key];
  process.env.P2D_BROWSER = "1";
  if (flavor === "offline") process.env.P2D_OFFLINE_CHAT = "1";
  else if (flavor === "live-real") process.env.P2D_LIVE_REAL = "1";
  else process.env.P2D_LIVE_PREP = "1";
  loadPlaywrightCli(flavor);
  return { ok: true };
}

// Strict CLI guard (shared helper): importing this module never starts
// anything — the file must BE the invoked script to run.
const invokedAsCli = isCliEntry({ argv1: process.argv?.[1], moduleUrl: import.meta.url });
if (invokedAsCli) {
  main().then(
    () => {},
    (e) => {
      console.error(String((e && e.message) || e).slice(0, 300));
      if (!process.exitCode) process.exitCode = 1;
    },
  );
}
