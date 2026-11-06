// P2D live-prep credential + prep-only guards (test-only infra, never bundled).
//
// SINGLE SOURCE OF TRUTH for the live-prep contract helpers. This file is
// strict CommonJS (no `import.meta`, no ESM syntax) so the Playwright
// config loader — which transpiles `e2e/playwright.config.ts` to CJS and
// loads every dependency through `require()` — can load it. Requiring the
// ESM twin (`.mjs`) from the config breaks with `SyntaxError: Cannot use
// 'import.meta' outside a module`; requiring THIS file never does.
//
// The ESM twin (`p2d-live-credential.mjs`) is a thin facade that re-exports
// everything defined here, so existing ESM importers (`p2d-live-prep.mjs`,
// the node:test contract) keep working with zero logic duplication.
//
// Pure helpers with no side effects on import. Lives in e2e/support (never
// bundled into the PWA): the prep-only live launcher (p2d-live-prep.mjs),
// the opt-in live spec and the node:test contract share these.
//
// Secrecy posture (declared):
// - The local credential alias OPENCODE_GO is read ONLY here, from exactly
//   two known locations in order — `<repo root>/.env`, then ONLY the sibling
//   checkout `../pi-financeiro/.env` (no generic search) — with the official
//   `node:util.parseEnv`. Missing alias in both is fail-closed. Error/log
//   paths carry key names and coarse location labels (`raiz`,
//   `pi-financeiro`) only — never values, never absolute paths.
// - Runtime envs are built from a minimal allowlist (no `process.env` spread):
//   only Node-spawn essentials (PATH/Path case-insensitive, SystemRoot,
//   ComSpec, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA, HOME) plus
//   PLAYWRIGHT_BROWSERS_PATH (a path, never a secret) and explicit
//   per-process values. NODE_OPTIONS, proxies, every provider key,
//   DATABASE_URL and unrelated secrets are dropped.
// - The secret is supplied ONLY as the explicit alias OPENCODE_GO_API_KEY to
//   the live runtime env, applied temporarily to the dedicated process BEFORE
//   its SDK import/boot (and restored right after). setupIsolation scrubs the
//   inherited env FIRST and preserves ONLY that alias (an ambient
//   OPENCODE_API_KEY is never preserved). The alias→native translation
//   (`applyLiveRealCredentialAlias`: OPENCODE_API_KEY, the key OpenCode 2.2.4
//   resolves for `opencode-go`) belongs EXCLUSIVELY to the P2D live-real probe
//   child — never to the prep path or the product bootstrap. The secret never
//   reaches PWA or stack envs.
// - Prep-only by construction: the boot never opens a live listener
//   (`listenerExposed:false`, no `/rpc/chat` with the real credential), never
//   sends a message, never calls session.prompt, never attempts provider
//   inference. The strict receipt allowlist rejects any extra key — claimed
//   evidence is limited to what these validators observe (synthetic journal,
//   HTTP proofs, boot receipt booleans).
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- strict CJS is required by Playwright's config loader. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { pathToFileURL } = require("node:url");
/* eslint-enable @typescript-eslint/no-require-imports */

const LIVE_CREDENTIAL_ALIAS = "OPENCODE_GO";
const LIVE_CREDENTIAL_TARGET = "OPENCODE_GO_API_KEY";
// Native key OpenCode 2.2.4 resolves for the `opencode-go` provider. Only the
// P2D live-real probe child translates the alias into this key.
const LIVE_CREDENTIAL_NATIVE = "OPENCODE_API_KEY";
const LIVE_MODEL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Offline-chat mode (P2D_OFFLINE_CHAT=1 / --offline): the exact provider from
// the repo-owned live model selector, pointed at a LOOPBACK OpenAI-compatible
// stub with a dummy key. The provider id stays `opencode-go` on purpose (the
// SDK/provider/model are the real ones); the HTTP endpoint is what proves no
// external inference. The dummy key is the only credential shape this mode
// accepts, so a real credential can never be smuggled into the offline path.
const OFFLINE_PROVIDER = "opencode-go";
const OFFLINE_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
const OFFLINE_DUMMY_KEY = "test-offline-dummy-not-a-secret";
const RUNTIME_MODES = ["offline", "live-real"];

/**
 * Env file names the Next dev server loads in NODE_ENV=development
 * (`.env`, `.env.local`, `.env.development`, `.env.development.local`).
 * `.env.example` is intentionally absent: Next never loads it. Name-based
 * preflight only — contents are never read.
 */
const NEXT_ENV_BLOCKED_NAMES = [".env", ".env.local", ".env.development", ".env.development.local"];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Minimal Node-spawn base (exact set; key match is case-insensitive).
 * `PLAYWRIGHT_BROWSERS_PATH` is a PATH (not a secret): Playwright resolves
 * its browser binaries from it, and dropping it broke the official
 * `pnpm test:p2d-offline` command on machines whose browsers live outside the
 * default location.
 */
const SPAWN_BASE_KEYS = new Set([
  "PATH",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
]);

/**
 * Loopback http(s) URL with an optional PATH (e.g. `/v1`) — used for provider
 * baseURLs. Credentials, query strings and fragments are refused; external
 * hosts are refused. `isLoopbackOrigin` stays the stricter bare-origin check
 * for API bases.
 */
function isLoopbackHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  return true;
}

/** Bare loopback http(s) origin only (no path/search/hash/credentials). */
function isLoopbackOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return false;
  return true;
}

/**
 * Strict CLI-entry predicate (pure, shared): the module file must BE the
 * invoked script. A suffix/predicate match on our own URL would also fire
 * when the module is merely imported (e.g. by unit tests) and start the
 * runner as a side effect — that exact bug ran the full prep once and
 * must never recur. Both live-prep entrypoints share this helper so the
 * strictness cannot diverge again.
 */
function isCliEntry({ argv1, moduleUrl } = {}) {
  if (typeof argv1 !== "string" || typeof moduleUrl !== "string") return false;
  try {
    return moduleUrl === pathToFileURL(path.resolve(argv1)).href;
  } catch {
    return false;
  }
}

/**
 * Exactly the two known local credential locations, in order (no generic
 * search): `<rootDir>/.env`, then ONLY the sibling checkout
 * `../pi-financeiro/.env`. `siblingEnvFile` overrides the second entry
 * (tests pass fixture files; production always uses the default).
 */
function resolveLiveEnvCandidates({ rootDir, envFileName = ".env", siblingEnvFile } = {}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new Error("p2d-live-prep: rootDir is required (fail-closed)");
  }
  return [path.join(rootDir, envFileName), siblingEnvFile ?? defaultSiblingEnvFile(rootDir)];
}

/** Default sibling location derived from the repo root (pure, no fs access). */
function defaultSiblingEnvFile(rootDir) {
  return path.resolve(rootDir, "../pi-financeiro/.env");
}

/**
 * Reads the live credential alias from the known locations in order
 * (official `node:util.parseEnv`). Unreadable files are skipped; a file that
 * exists without the alias falls through to the next candidate. Fail-closed
 * when neither yields a non-empty alias. Errors name the alias and coarse
 * location labels only — never values, never absolute paths.
 */
function loadLiveCredential({ rootDir, envFileName = ".env", siblingEnvFile, alias = LIVE_CREDENTIAL_ALIAS } = {}) {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new Error("p2d-live-prep: alias is required (fail-closed)");
  }
  const candidates = resolveLiveEnvCandidates({ rootDir, envFileName, siblingEnvFile });
  for (const file of candidates) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // absent/unreadable: try the next known location
    }
    let parsed;
    try {
      parsed = parseEnv(raw);
    } catch {
      throw new Error("p2d-live-prep: .env ilegível (raiz|pi-financeiro) — refusing live boot (fail-closed)");
    }
    const value = parsed[alias];
    if (typeof value === "string" && value.trim().length > 0) {
      return { alias, value };
    }
    // Present but alias-less: fall through to the next known location.
  }
  throw new Error(
    `p2d-live-prep: alias ${alias} ausente nos .env conhecidos (raiz, pi-financeiro) — refusing live boot (fail-closed)`,
  );
}

/**
 * Minimal spawn base: only the allowlisted keys survive (first spelling
 * wins, matched case-insensitively). Everything else — NODE_OPTIONS,
 * proxies, provider keys, DATABASE_URL, unrelated secrets — is dropped.
 */
function pickSpawnBase(baseEnv) {
  const out = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (typeof value !== "string") continue;
    if (SPAWN_BASE_KEYS.has(String(key).toUpperCase()) && !(key in out)) {
      out[key] = value;
    }
  }
  return out;
}

/** Copy of `env` without either credential key (fail-closed scrub). */
function stripCredentialKeys(env) {
  const out = { ...(env ?? {}) };
  delete out[LIVE_CREDENTIAL_ALIAS];
  delete out[LIVE_CREDENTIAL_TARGET];
  return out;
}

const CRED_HERE = __dirname;
const TED_RUNTIME_DIR = path.resolve(CRED_HERE, "..", "..", "..", "ted-runtime");
const LIVE_MODEL_FILE = path.join(TED_RUNTIME_DIR, "src", "live-model.json");

function approvedTempBase() {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "Temp", "opencode");
  }
  return os.tmpdir();
}

/** Refuses the shared OpenCode home/config/auth: only an approved temp home. */
function assertIsolatedHome(home) {
  if (typeof home !== "string" || home.length === 0) {
    throw new Error("p2d-live-prep: TED_RUNTIME_HOME is required (fail-closed)");
  }
  if (!path.isAbsolute(home)) {
    throw new Error("p2d-live-prep: TED_RUNTIME_HOME must be absolute (fail-closed)");
  }
  const resolved = path.resolve(home);
  if (resolved === path.resolve(os.homedir())) {
    throw new Error("p2d-live-prep: refusing shared user home (fail-closed)");
  }
  const base = path.resolve(approvedTempBase());
  const tmp = path.resolve(os.tmpdir());
  if (!(resolved === base || resolved.startsWith(base + path.sep) || resolved === tmp || resolved.startsWith(tmp + path.sep))) {
    throw new Error("p2d-live-prep: TED_RUNTIME_HOME must live under the approved temp base (fail-closed)");
  }
  const lowered = resolved.toLowerCase();
  if (lowered.includes(`${path.sep}.config${path.sep}opencode`) || lowered.endsWith(`${path.sep}.opencode`)) {
    throw new Error("p2d-live-prep: refusing shared OpenCode config/auth home (fail-closed)");
  }
  return resolved;
}

/** Reads the repo-owned live model selector (pure fs + strict shape). */
function loadLiveModelSelector({ liveModelFile = LIVE_MODEL_FILE } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(liveModelFile, "utf8");
  } catch {
    throw new Error("p2d-live-prep: live-model.json unreadable — refusing live boot without a pinned native default (fail-closed)");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("p2d-live-prep: live-model.json is not valid JSON — refusing live boot (fail-closed)");
  }
  const model = parsed && typeof parsed === "object" ? parsed.model : null;
  if (typeof model !== "string" || !LIVE_MODEL_RE.test(model.trim())) {
    throw new Error("p2d-live-prep: live-model.json must hold a non-empty provider/model string (fail-closed)");
  }
  return model.trim();
}

/**
 * Proves the configured live model WITHOUT importing the SDK: dynamically
 * imports ONLY the product bootstrap config generator (`tedConfig('live')`
 * — the module imports node builtins only) and requires strict equality
 * with the repo-owned `live-model.json` read above.
 */
async function resolveConfiguredLiveModel({ tedRuntimeDir = TED_RUNTIME_DIR } = {}) {
  const { tedConfig } = await import(pathToFileURL(path.join(tedRuntimeDir, "src", "bootstrap.mjs")).href);
  const configured = tedConfig("live");
  const fileModel = loadLiveModelSelector();
  if (!configured || configured.model !== fileModel) {
    throw new Error("p2d-live-prep: bootstrap live config diverged from live-model.json (fail-closed)");
  }
  return configured.model;
}

/**
 * Runs `fn` with the `target` env replaced EXACTLY by `envVars` (full swap
 * applied temporarily to the dedicated worker process: the SDK import that
 * follows observes only the allowlisted values), then restores the exact
 * previous snapshot in `finally`, on success and on error. Only `target`
 * (default `process.env`) is touched; nothing else. The spec uses this to
 * boot the live runtime in its own isolated worker process.
 */
async function withScrubbedEnv(envVars, fn, target = process.env) {
  if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) {
    throw new Error("p2d-live-prep: envVars must be an object (fail-closed)");
  }
  if (typeof fn !== "function") {
    throw new Error("p2d-live-prep: fn is required (fail-closed)");
  }
  if (!target || typeof target !== "object") {
    throw new Error("p2d-live-prep: env target is required (fail-closed)");
  }
  const prev = { ...target };
  try {
    for (const key of Object.keys(target)) delete target[key];
    for (const [key, value] of Object.entries(envVars)) {
      if (value !== undefined) target[key] = value;
    }
    return await fn(target);
  } finally {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, prev);
  }
}

/**
 * Fixed boot-failure text (the ONLY diagnostic the live boot may surface).
 * A constant message — never the original error, its cause or its stack —
 * so SDK/runtime internals cannot leak the credential in any form (literal,
 * encoded or fragmented). Sentinel success never throws.
 */
const LIVE_BOOT_FAILURE_MESSAGE = "p2d-live-prep: live runtime boot failed (details redacted)";

/**
 * Live-boot boundary: runs `boot` under the scrubbed env and converts ANY
 * failure — env swap, validation, dynamic import, SDK boot, restore —
 * into the single allowlisted fixed message. Never carries the original
 * error, its cause or its stack, so SDK/runtime internals cannot leak the
 * credential in any form (literal, encoded or fragmented). A resolving
 * `boot` (sentinel path) returns its value untouched.
 */
async function withLiveBootBoundary(envVars, boot, target = process.env) {
  try {
    return await withScrubbedEnv(envVars, boot, target);
  } catch {
    throw new Error(LIVE_BOOT_FAILURE_MESSAGE);
  }
}

/**
 * Name-based preflight for `apps/pwa`: returns the subset of
 * NEXT_ENV_BLOCKED_NAMES present as files. Uses existence checks only —
 * contents are never read. `.env.example` is never reported (Next does not
 * load it). Only ENOENT means "absent": any other inspection error
 * (EACCES, ENOTDIR, …) fails closed without revealing paths or contents.
 */
function findBlockingNextEnvFiles(pwaDir, { statSync = fs.statSync } = {}) {
  if (typeof pwaDir !== "string" || pwaDir.length === 0) {
    throw new Error("p2d-live-prep: pwaDir is required (fail-closed)");
  }
  if (typeof statSync !== "function") {
    throw new Error("p2d-live-prep: statSync is required (fail-closed)");
  }
  const found = [];
  for (const name of NEXT_ENV_BLOCKED_NAMES) {
    let st;
    try {
      st = statSync(path.join(pwaDir, name));
    } catch (e) {
      if (e && e.code === "ENOENT") continue; // absent: not blocking
      throw new Error("p2d-live-prep: unable to inspect Next env files (fail-closed; contents never read)");
    }
    if (st.isFile()) found.push(name);
  }
  return found;
}

/** Fail-closed when Next-loadable env files exist in `apps/pwa` (names only). */
function assertNoBlockingNextEnvFiles(pwaDir, opts) {
  const found = findBlockingNextEnvFiles(pwaDir, opts);
  if (found.length > 0) {
    throw new Error(
      `p2d-live-prep: refusing run with Next-loadable env files in apps/pwa (${found.join(", ")}) — remove or rename them (fail-closed; contents never read)`,
    );
  }
  return true;
}

/** Asserts the synthetic journal shows zero financial writes; returns 0. */
function assertNoFinancialWrites(journalBody) {
  const writes = journalBody?.financialWrites;
  if (!Array.isArray(writes) || writes.length !== 0) {
    throw new Error("p2d-live-prep: synthetic journal shows financial writes (fail-closed)");
  }
  return 0;
}

/**
 * Env for the live TED runtime boot ONLY: allowlisted base + the explicit
 * OPENCODE_GO_API_KEY alias input (the live profile preserves ONLY that alias
 * and scrubs every other credential var, including an ambient
 * OPENCODE_API_KEY) + explicit TED_* pins. It is applied temporarily to the
 * dedicated Playwright worker process for the SDK boot and restored in full
 * afterwards — never to PWA/stack envs, which carry no secrets by config.
 * The alias→native translation belongs to the P2D live-real probe child
 * (`applyLiveRealCredentialAlias`), never to the product bootstrap.
 */
function buildLiveRuntimeEnv({ baseEnv = {}, credentialValue, tedHome, tedIdentity, apiBaseUrl, profile = "live" } = {}) {
  if (typeof credentialValue !== "string" || credentialValue.length === 0) {
    throw new Error("p2d-live-prep: credential is required for the live runtime env (fail-closed)");
  }
  if (profile !== "live") {
    throw new Error("p2d-live-prep: live runtime env requires profile live (fail-closed)");
  }
  if (!isLoopbackOrigin(apiBaseUrl)) {
    throw new Error("p2d-live-prep: apiBaseUrl must be a bare loopback origin (fail-closed)");
  }
  if (typeof tedHome !== "string" || tedHome.length === 0 || !path.isAbsolute(tedHome)) {
    throw new Error("p2d-live-prep: tedHome must be an absolute isolated home (fail-closed)");
  }
  if (typeof tedIdentity !== "string" || tedIdentity.length === 0) {
    throw new Error("p2d-live-prep: tedIdentity is required (fail-closed)");
  }
  const out = stripCredentialKeys(pickSpawnBase(baseEnv));
  out[LIVE_CREDENTIAL_TARGET] = credentialValue;
  out.TED_RUNTIME_PROFILE = profile;
  out.TED_RUNTIME_HOME = tedHome;
  out.TED_RUNTIME_IDENTITY = tedIdentity;
  out.TED_API_BASE_URL = apiBaseUrl;
  return out;
}

/**
 * Offline-chat runtime env: the same minimal allowlist as the live boot, but
 * the only credential shape accepted is the dummy key. Profile stays `live`
 * so the SDK/model/provider are the real ones; the provider baseURL is the
 * loopback stub (composed separately by `buildOfflineProviderConfig`).
 */
function buildOfflineRuntimeEnv({ baseEnv = {}, tedHome, tedIdentity, apiBaseUrl, profile = "live" } = {}) {
  if (profile !== "live") {
    throw new Error("p2d-live-prep: offline runtime env requires profile live (fail-closed)");
  }
  if (!isLoopbackOrigin(apiBaseUrl)) {
    throw new Error("p2d-live-prep: offline apiBaseUrl must be a bare loopback origin (fail-closed)");
  }
  if (typeof tedHome !== "string" || tedHome.length === 0 || !path.isAbsolute(tedHome)) {
    throw new Error("p2d-live-prep: offline tedHome must be an absolute isolated home (fail-closed)");
  }
  if (typeof tedIdentity !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tedIdentity)) {
    throw new Error("p2d-live-prep: offline tedIdentity must be a single safe path segment (fail-closed)");
  }
  const out = stripCredentialKeys(pickSpawnBase(baseEnv));
  out[LIVE_CREDENTIAL_TARGET] = OFFLINE_DUMMY_KEY;
  out.TED_RUNTIME_PROFILE = profile;
  out.TED_RUNTIME_HOME = tedHome;
  out.TED_RUNTIME_IDENTITY = tedIdentity;
  out.TED_API_BASE_URL = apiBaseUrl;
  out.TED_P2D_MODE = "offline";
  return out;
}

/**
 * Test-only provider composition for the offline mode. Keeps the exact
 * `provider/model` from `live-model.json`, adds the `provider.use` allow after
 * the product deny-all, and points ONLY that provider at the loopback stub.
 * Fails closed on an external baseURL, a non-dummy key or a foreign provider.
 * Returns a new object; the product base config is never mutated.
 */
function buildOfflineProviderConfig(baseConfig, { model, baseURL, apiKey, name } = {}) {
  if (!baseConfig || typeof baseConfig !== "object" || Array.isArray(baseConfig)) {
    throw new Error("p2d-live-prep: offline base config must be an object (fail-closed)");
  }
  if (typeof model !== "string" || !LIVE_MODEL_RE.test(model.trim())) {
    throw new Error("p2d-live-prep: offline model must be provider/model (fail-closed)");
  }
  const [provider, modelID] = model.trim().split("/");
  if (provider !== OFFLINE_PROVIDER) {
    throw new Error(`p2d-live-prep: offline provider must be ${OFFLINE_PROVIDER} (fail-closed)`);
  }
  if (!isLoopbackHttpUrl(baseURL)) {
    throw new Error("p2d-live-prep: offline provider baseURL must be loopback (fail-closed)");
  }
  if (apiKey !== OFFLINE_DUMMY_KEY) {
    throw new Error("p2d-live-prep: offline provider requires the dummy key only (fail-closed)");
  }
  const policies = Array.isArray(baseConfig.policies) ? [...baseConfig.policies] : [];
  if (
    !policies.some(
      (p) => p && p.action === "provider.use" && p.resource === provider && p.effect === "allow",
    )
  ) {
    policies.push({ action: "provider.use", resource: provider, effect: "allow" });
  }
  return {
    ...baseConfig,
    model: `${provider}/${modelID}`,
    policies,
    providers: {
      ...(baseConfig.providers && typeof baseConfig.providers === "object" && !Array.isArray(baseConfig.providers)
        ? baseConfig.providers
        : {}),
      [provider]: {
        name:
          typeof name === "string" && name.length > 0
            ? name
            : "TED P2D offline loopback provider (dummy apiKey)",
        package: OFFLINE_PROVIDER_PACKAGE,
        settings: { baseURL, apiKey },
        models: {
          [modelID]: {
            name: `Offline ${modelID}`,
            modelID,
            capabilities: { input: ["text"], output: ["text"] },
            limit: { context: 32000, output: 4000 },
          },
        },
      },
    },
  };
}

/**
 * Credential selection for a runtime mode:
 * - `offline`  → always the dummy key (no file read, no real credential);
 * - `live-real` → the allowlisted local alias only (`loadLiveCredential`).
 * Returns `{ value, source }`; callers must keep `value` inside the isolated
 * runtime process and never log/write it.
 */
function loadRuntimeCredentialForMode({ mode, rootDir, envFileName = ".env", siblingEnvFile } = {}) {
  if (mode === "offline") return { value: OFFLINE_DUMMY_KEY, source: "dummy" };
  if (mode === "live-real") {
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      throw new Error("p2d-live-prep: rootDir is required for live-real credentials (fail-closed)");
    }
    const cred = loadLiveCredential({ rootDir, envFileName, siblingEnvFile });
    return { value: cred.value, source: "allowlist" };
  }
  throw new Error("p2d-live-prep: unknown runtime mode (fail-closed)");
}

/**
 * P2D live-real ONLY (never the prep path, never the product bootstrap):
 * native OpenCode 2.2.4 resolves the `opencode-go` provider from
 * OPENCODE_API_KEY, so the alias preserved by the live profile is translated
 * into the native key and then removed — the isolated child keeps ONLY the
 * native key. Pure env transform: the caller passes the target env (the value
 * is never read from `process.env` here, never logged). Returns the OBSERVED
 * presence boolean (false when no alias value exists; an unaliased native key
 * never survives).
 */
function applyLiveRealCredentialAlias(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("p2d-live-prep: env object is required for the live-real alias (fail-closed)");
  }
  const aliasValue = env[LIVE_CREDENTIAL_TARGET];
  delete env[LIVE_CREDENTIAL_TARGET];
  if (typeof aliasValue === "string" && aliasValue.length > 0) {
    env[LIVE_CREDENTIAL_NATIVE] = aliasValue;
  } else {
    // No alias value → no native key at all (an ambient native key never
    // survives; presence is observed from the native key, never assumed).
    delete env[LIVE_CREDENTIAL_NATIVE];
  }
  return Boolean(env[LIVE_CREDENTIAL_NATIVE]);
}

const OFFLINE_RECEIPT_KEYS = new Set([
  "ok",
  "phase",
  "mode",
  "profile",
  "provider",
  "model",
  "agent",
  "providerLoopback",
  "credentialSource",
  "fetchGuard",
]);

/** Strict offline-chat receipt: no credential field can ever be added. */
function validateOfflineChatReceipt(receipt, { expectedModel } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("p2d-live-prep: offline receipt must be an object (fail-closed)");
  }
  for (const key of Object.keys(receipt)) {
    if (!OFFLINE_RECEIPT_KEYS.has(key)) {
      throw new Error(`p2d-live-prep: offline receipt carries unexpected key '${key}' (fail-closed)`);
    }
  }
  if (receipt.ok !== true) throw new Error("p2d-live-prep: offline receipt ok must be true (fail-closed)");
  if (receipt.phase !== "offline-chat-ready") {
    throw new Error("p2d-live-prep: offline receipt phase must be offline-chat-ready (fail-closed)");
  }
  if (receipt.mode !== "offline") throw new Error("p2d-live-prep: offline mode must be offline (fail-closed)");
  if (receipt.profile !== "live") throw new Error("p2d-live-prep: offline profile must be live (fail-closed)");
  if (receipt.provider !== OFFLINE_PROVIDER) {
    throw new Error(`p2d-live-prep: offline provider must be ${OFFLINE_PROVIDER} (fail-closed)`);
  }
  if (typeof receipt.model !== "string" || !LIVE_MODEL_RE.test(receipt.model)) {
    throw new Error("p2d-live-prep: offline model must be provider/model (fail-closed)");
  }
  if (typeof expectedModel === "string" && expectedModel.length > 0 && receipt.model !== expectedModel) {
    throw new Error("p2d-live-prep: offline model diverged from live-model.json (fail-closed)");
  }
  if (receipt.agent !== "ted") throw new Error("p2d-live-prep: offline agent must be ted (fail-closed)");
  if (receipt.providerLoopback !== true) {
    throw new Error("p2d-live-prep: offline provider must be loopback (fail-closed)");
  }
  if (receipt.credentialSource !== "dummy") {
    throw new Error("p2d-live-prep: offline credential source must be dummy (fail-closed)");
  }
  if (receipt.fetchGuard !== "loopback-only") {
    throw new Error("p2d-live-prep: offline fetch guard must be loopback-only (fail-closed)");
  }
  return true;
}

/** P2D loopback ports forwarded to the launcher process (validated, else omitted). */
const PLAYWRIGHT_PORT_KEYS = ["P2D_API_PORT", "P2D_GATEWAY_PORT", "P2D_CTL_PORT", "P2D_NEXT_PORT"];

/**
 * Scrubbed env for the launcher process before it loads the Playwright CLI
 * in-process: the minimal spawn base (no `process.env` spread — NODE_OPTIONS,
 * proxies, provider keys, DATABASE_URL and unrelated secrets are dropped)
 * plus ONLY the flags the P2D run needs. This reinstates the `pickSpawnBase`
 * secrecy the raw `{...process.env}` spread had reopened.
 *
 * Exactly one mode is selected: the default (no opts) preserves the existing
 * `P2D_LIVE_PREP=1` prep-only path; `offlineChat` / `liveReal` select the new
 * opt-ins. The credential keys are stripped in every case.
 */
function buildPlaywrightEnv(baseEnv = {}, { livePrep = true, offlineChat = false, liveReal = false } = {}) {
  const selected = [livePrep, offlineChat, liveReal].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("p2d-live-prep: select at most one mode (live-prep|offline|live-real) — fail-closed");
  }
  const out = stripCredentialKeys(pickSpawnBase(baseEnv));
  out.P2D_BROWSER = "1";
  if (livePrep) out.P2D_LIVE_PREP = "1";
  if (offlineChat) out.P2D_OFFLINE_CHAT = "1";
  if (liveReal) out.P2D_LIVE_REAL = "1";
  for (const key of PLAYWRIGHT_PORT_KEYS) {
    const raw = baseEnv?.[key];
    if (typeof raw === "string" && raw !== "") {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) out[key] = String(n);
    }
  }
  return out;
}

/** Validates the synthetic API `GET /health` DTO (safe route, GET only). */
function expectApiHealthBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("p2d-live-prep: synthetic api /health must return a JSON object (fail-closed)");
  }
  if (body.status !== "ok") {
    throw new Error("p2d-live-prep: synthetic api /health status must be ok (fail-closed)");
  }
  for (const key of ["gitSha", "buildId", "builtAt"]) {
    if (typeof body[key] !== "string") {
      throw new Error(`p2d-live-prep: synthetic api /health field ${key} must be a string (fail-closed)`);
    }
  }
  return true;
}

/**
 * Validates the synthetic P2D gateway safe-GET proof: the loopback gateway
 * answers unknown GET routes with its expected Fastify 404 — a response
 * proof with no prompt, no inference, no request egress.
 */
function expectGatewayNotFound({ status, body } = {}) {
  if (status !== 404) {
    throw new Error("p2d-live-prep: synthetic gateway safe GET must answer 404 (fail-closed)");
  }
  if (!body || typeof body !== "object" || body.code !== "gateway.not_found") {
    throw new Error("p2d-live-prep: synthetic gateway 404 must carry code gateway.not_found (fail-closed)");
  }
  return true;
}

const RECEIPT_KEYS = new Set(["ok", "phase", "profile", "model", "credentialPresent", "apiLoopback", "listenerExposed"]);

/**
 * Validates the live-prep-ready receipt (strict key allowlist). Prep-only is
 * structural: `listenerExposed` must be false (the boot never binds a live
 * `/rpc/chat` listener with the real credential) and no extra key is
 * accepted — evidence is limited to these booleans/ids plus the HTTP proofs
 * above, never a measured prompt count.
 */
function validateLivePrepReceipt(receipt, { expectedModel } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("p2d-live-prep: receipt must be an object (fail-closed)");
  }
  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_KEYS.has(key)) {
      throw new Error(`p2d-live-prep: receipt carries unexpected key '${key}' (fail-closed; prep-only)`);
    }
  }
  if (receipt.ok !== true) {
    throw new Error("p2d-live-prep: receipt ok must be true (fail-closed)");
  }
  if (receipt.phase !== "live-prep-ready") {
    throw new Error("p2d-live-prep: receipt phase must be live-prep-ready (fail-closed)");
  }
  if (receipt.profile !== "live") {
    throw new Error("p2d-live-prep: profile must be live (fail-closed)");
  }
  if (typeof receipt.model !== "string" || !LIVE_MODEL_RE.test(receipt.model)) {
    throw new Error("p2d-live-prep: model must be a provider/model selector (fail-closed)");
  }
  if (typeof expectedModel === "string" && expectedModel.length > 0 && receipt.model !== expectedModel) {
    throw new Error("p2d-live-prep: model diverged from the repo-owned live-model.json (fail-closed)");
  }
  if (receipt.credentialPresent !== true) {
    throw new Error("p2d-live-prep: credential presence must be true inside the swapped-in runtime env (fail-closed)");
  }
  if (receipt.apiLoopback !== true) {
    throw new Error("p2d-live-prep: financial origins must be loopback (fail-closed)");
  }
  if (receipt.listenerExposed !== false) {
    throw new Error("p2d-live-prep: no live listener may be exposed in prep-only (fail-closed)");
  }
  return true;
}

/** Sanitizes an error for logs: redacts a leaked secret value, caps length. */
function sanitizePrepError(err, secretValue) {
  let msg = String((err && err.message) || err || "unknown error");
  if (typeof secretValue === "string" && secretValue.length > 0) {
    msg = msg.split(secretValue).join("[redacted]");
  }
  return msg.slice(0, 300);
}

module.exports = {
  LIVE_BOOT_FAILURE_MESSAGE,
  LIVE_CREDENTIAL_ALIAS,
  LIVE_CREDENTIAL_NATIVE,
  LIVE_CREDENTIAL_TARGET,
  LIVE_MODEL_RE,
  NEXT_ENV_BLOCKED_NAMES,
  OFFLINE_DUMMY_KEY,
  OFFLINE_PROVIDER,
  OFFLINE_PROVIDER_PACKAGE,
  RUNTIME_MODES,
  applyLiveRealCredentialAlias,
  assertIsolatedHome,
  assertNoBlockingNextEnvFiles,
  assertNoFinancialWrites,
  buildLiveRuntimeEnv,
  buildOfflineProviderConfig,
  buildOfflineRuntimeEnv,
  buildPlaywrightEnv,
  defaultSiblingEnvFile,
  expectApiHealthBody,
  expectGatewayNotFound,
  findBlockingNextEnvFiles,
  isCliEntry,
  isLoopbackHttpUrl,
  isLoopbackOrigin,
  loadLiveCredential,
  loadLiveModelSelector,
  loadRuntimeCredentialForMode,
  pickSpawnBase,
  resolveConfiguredLiveModel,
  resolveLiveEnvCandidates,
  sanitizePrepError,
  stripCredentialKeys,
  validateLivePrepReceipt,
  validateOfflineChatReceipt,
  withLiveBootBoundary,
  withScrubbedEnv,
};
