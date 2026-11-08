// P2D offline-chat + future live-real modes — behavioral contract (node:test).
//
// Two explicit opt-ins on top of the existing P2D launcher/lifecycle:
//   --offline    real browser → PWA proxy → real gateway → real SDK prompt →
//                loopback OpenAI-compatible provider (dummy key) → real
//                finance tools → synthetic Fastify API. Profile `live`, model
//                and provider from `apps/ted-runtime/src/live-model.json`.
//   --live-real  same chain with the real provider/model, credential loaded
//                ONLY from the two allowlisted local `.env` locations and
//                applied ONLY to the isolated runtime child process.
//
// This file never starts a service, never reads the real `.env`, never calls
// a provider: it exercises the pure contract helpers plus static guards that
// the wiring exists and cannot leak the credential.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OFFLINE_DUMMY_KEY,
  OFFLINE_PROVIDER,
  applyLiveRealCredentialAlias,
  buildOfflineProviderConfig,
  buildOfflineRuntimeEnv,
  buildPlaywrightEnv,
  isLoopbackHttpUrl,
  loadRuntimeCredentialForMode,
  validateOfflineChatReceipt,
} from "./p2d-live-credential.mjs";
import { parsePrepArgs } from "./p2d-live-prep.mjs";
import {
  LIVE_REAL_CATALOG_URL,
  LIVE_REAL_FETCH_GUARD,
  classifyLiveRealRequest,
  createLiveRealFetchGuard,
} from "./p2d-fetch-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const PREP_FILE = path.join(HERE, "p2d-live-prep.mjs");
const HELPER_FILE = path.join(HERE, "p2d-live-credential.mjs");
const CONFIG_FILE = path.join(HERE, "..", "playwright.config.ts");
const PROBE_FILE = path.join(HERE, "p2d-synthetic-read-probe.mjs");
const STACK_FILE = path.join(HERE, "p2d-browser-stack.mts");
const OFFLINE_SPEC = path.join(HERE, "..", "p2d", "p2d-live-offline.spec.ts");
const REAL_SPEC = path.join(HERE, "..", "p2d", "p2d-live-real.spec.ts");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");
const LIVE_MODEL = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "apps", "ted-runtime", "src", "live-model.json"), "utf8"),
).model;
const LIVE_MODEL_ID = String(LIVE_MODEL).split("/")[1];
const CHAT_COMPLETIONS_URL = "https://opencode.ai/inference/go/openai/v1/chat/completions";
const inferenceBody = (model) =>
  JSON.stringify({ model, messages: [{ role: "user", content: "oi" }], stream: true });

const DUMMY_REAL = "test-dummy-real-mode-secret";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("p2d live modes: offline provider contract (pure helpers)", () => {
  it("isLoopbackHttpUrl: loopback http(s) with path, never external/credentials/query", () => {
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:4444/v1"), true);
    assert.equal(isLoopbackHttpUrl("http://localhost:4444/v1"), true);
    assert.equal(isLoopbackHttpUrl("http://[::1]:4444/v1"), true);
    assert.equal(isLoopbackHttpUrl("https://127.0.0.1/v1"), true);
    assert.equal(isLoopbackHttpUrl("https://api.synkroo.com.br/v1"), false);
    assert.equal(isLoopbackHttpUrl("https://api.opencode.ai/v1"), false);
    assert.equal(isLoopbackHttpUrl("http://user:pass@127.0.0.1:4444/v1"), false);
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:4444/v1?x=1"), false);
    assert.equal(isLoopbackHttpUrl(""), false);
  });

  it("offline provider keeps the exact provider/model and points at loopback with the dummy key", () => {
    const base = {
      $schema: "https://opencode.ai/config.json",
      model: "test/base",
      default_agent: "ted",
      agents: { ted: { mode: "primary" } },
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }],
    };
    const cfg = buildOfflineProviderConfig(base, {
      model: LIVE_MODEL,
      baseURL: "http://127.0.0.1:4444/v1",
      apiKey: OFFLINE_DUMMY_KEY,
    });
    assert.equal(cfg.model, LIVE_MODEL);
    assert.equal(cfg.default_agent, "ted");
    assert.equal(cfg.providers[OFFLINE_PROVIDER].settings.baseURL, "http://127.0.0.1:4444/v1");
    assert.equal(cfg.providers[OFFLINE_PROVIDER].settings.apiKey, OFFLINE_DUMMY_KEY);
    assert.equal(cfg.providers[OFFLINE_PROVIDER].models[LIVE_MODEL_ID].modelID, LIVE_MODEL_ID);
    assert.ok(
      cfg.policies.some(
        (p) => p.action === "provider.use" && p.resource === OFFLINE_PROVIDER && p.effect === "allow",
      ),
      "offline provider must be explicitly allowed after the deny-all",
    );
    // The base is not mutated (test-only composition, product config untouched).
    assert.equal(base.model, "test/base");
    assert.equal(base.providers, undefined);
  });

  it("offline provider fails closed on external endpoint, real key or foreign provider", () => {
    const base = { model: "test/base", policies: [] };
    assert.throws(
      () =>
        buildOfflineProviderConfig(base, {
          model: LIVE_MODEL,
          baseURL: "https://api.opencode.ai/v1",
          apiKey: OFFLINE_DUMMY_KEY,
        }),
      /loopback/i,
    );
    assert.throws(
      () =>
        buildOfflineProviderConfig(base, {
          model: LIVE_MODEL,
          baseURL: "http://127.0.0.1:4444/v1",
          apiKey: DUMMY_REAL,
        }),
      /dummy/i,
    );
    assert.throws(
      () =>
        buildOfflineProviderConfig(base, {
          model: "other/model",
          baseURL: "http://127.0.0.1:4444/v1",
          apiKey: OFFLINE_DUMMY_KEY,
        }),
      /provider/i,
    );
  });

  it("offline runtime env: dummy target only, profile live, loopback, no ambient secrets", () => {
    const dirty = {
      PATH: "/usr/bin",
      NODE_OPTIONS: "--inspect",
      HTTP_PROXY: "http://proxy:8080",
      OPENCODE_GO: DUMMY_REAL,
      OPENCODE_GO_API_KEY: DUMMY_REAL,
      DATABASE_URL: "postgres://localhost/x",
      SOME_UNRELATED_SECRET: "unrelated-test-secret",
    };
    const env = buildOfflineRuntimeEnv({
      baseEnv: dirty,
      tedHome: path.join(os.tmpdir(), "p2d-offline-home"),
      tedIdentity: "p2d-offline",
      apiBaseUrl: "http://127.0.0.1:4110",
    });
    assert.equal(env.OPENCODE_GO_API_KEY, OFFLINE_DUMMY_KEY);
    assert.ok(!("OPENCODE_GO" in env));
    assert.equal(env.TED_RUNTIME_PROFILE, "live");
    assert.equal(env.TED_RUNTIME_HOME, path.join(os.tmpdir(), "p2d-offline-home"));
    assert.equal(env.TED_RUNTIME_IDENTITY, "p2d-offline");
    assert.equal(env.TED_API_BASE_URL, "http://127.0.0.1:4110");
    assert.equal(env.TED_P2D_MODE, "offline");
    for (const k of ["NODE_OPTIONS", "HTTP_PROXY", "DATABASE_URL", "SOME_UNRELATED_SECRET"]) {
      assert.ok(!(k in env), `${k} must not reach the offline runtime`);
    }
    assert.ok(!Object.values(env).includes(DUMMY_REAL));
    assert.throws(
      () =>
        buildOfflineRuntimeEnv({
          baseEnv: {},
          tedHome: path.join(os.tmpdir(), "p2d-offline-home"),
          tedIdentity: "p2d-offline",
          apiBaseUrl: "https://api.synkroo.com.br",
        }),
      /loopback/i,
    );
  });

  it("credential selection: offline is always dummy; live-real reads the allowlisted locations", () => {
    const offline = loadRuntimeCredentialForMode({ mode: "offline" });
    assert.equal(offline.source, "dummy");
    assert.equal(offline.value, OFFLINE_DUMMY_KEY);

    const siblingDir = tmpDir("p2d-live-mode-cred-");
    const siblingFile = path.join(siblingDir, ".env");
    fs.writeFileSync(siblingFile, `OPENCODE_GO=${DUMMY_REAL}\n`, "utf8");
    const real = loadRuntimeCredentialForMode({
      mode: "live-real",
      rootDir: path.join(os.tmpdir(), "p2d-no-such-root-mode-xyz"),
      siblingEnvFile: siblingFile,
    });
    assert.equal(real.source, "allowlist");
    assert.equal(real.value, DUMMY_REAL);

    assert.throws(() => loadRuntimeCredentialForMode({ mode: "other" }), /mode/i);
    assert.throws(
      () =>
        loadRuntimeCredentialForMode({
          mode: "live-real",
          rootDir: path.join(os.tmpdir(), "p2d-no-such-root-mode-xyz"),
          siblingEnvFile: path.join(siblingDir, "missing.env"),
        }),
      /OPENCODE_GO/,
    );
    try {
      loadRuntimeCredentialForMode({
        mode: "live-real",
        rootDir: path.join(os.tmpdir(), "p2d-no-such-root-mode-xyz"),
        siblingEnvFile: path.join(siblingDir, "missing.env"),
      });
      assert.fail("should fail closed");
    } catch (e) {
      const msg = String((e && e.message) || e);
      assert.ok(!msg.includes(DUMMY_REAL), "error must never carry the credential");
      assert.ok(!msg.includes(siblingDir), "error must never carry the absolute location");
    }
  });

  it("offline receipt: strict allowlist, live profile, exact model/provider, loopback only", () => {
    const good = {
      ok: true,
      phase: "offline-chat-ready",
      mode: "offline",
      profile: "live",
      provider: OFFLINE_PROVIDER,
      model: LIVE_MODEL,
      agent: "ted",
      providerLoopback: true,
      credentialSource: "dummy",
      fetchGuard: "loopback-only",
    };
    assert.doesNotThrow(() => validateOfflineChatReceipt(good, { expectedModel: LIVE_MODEL }));
    assert.throws(() => validateOfflineChatReceipt({ ...good, providerLoopback: false }), /loopback/i);
    assert.throws(() => validateOfflineChatReceipt({ ...good, credentialSource: "allowlist" }), /credential/i);
    assert.throws(() => validateOfflineChatReceipt({ ...good, profile: "test" }), /profile/i);
    assert.throws(() => validateOfflineChatReceipt({ ...good, agent: "other" }), /agent/i);
    assert.throws(
      () => validateOfflineChatReceipt({ ...good, model: "other/model" }, { expectedModel: LIVE_MODEL }),
      /model/i,
    );
    assert.throws(() => validateOfflineChatReceipt({ ...good, apiKey: "x" }), /unexpected key/i);
  });
});

describe("p2d live modes: live-real credential translation (probe helper only)", () => {
  it("pure helper: copies the preserved alias to the native key and removes the alias", () => {
    const env = { OPENCODE_GO_API_KEY: DUMMY_REAL, OPENCODE_API_KEY: "ambient-must-not-win" };
    assert.equal(applyLiveRealCredentialAlias(env), true);
    assert.equal(env.OPENCODE_API_KEY, DUMMY_REAL);
    assert.ok(!("OPENCODE_GO_API_KEY" in env), "the alias must be removed after the translation");
    // No alias → no native key at all: presence stays false, never hardcoded.
    const empty = { OPENCODE_API_KEY: "ambient" };
    assert.equal(applyLiveRealCredentialAlias(empty), false);
    assert.ok(!("OPENCODE_API_KEY" in empty), "an unaliased native key must never survive");
    assert.throws(() => applyLiveRealCredentialAlias(null), /env/i);
  });

  it("subprocess: only the native key survives in the child env (values never printed)", () => {
    const probe = [
      `import { applyLiveRealCredentialAlias } from ${JSON.stringify(pathToFileURL(HELPER_FILE).href)};`,
      "const present = applyLiveRealCredentialAlias(process.env);",
      'console.log(JSON.stringify({ present, alias: "OPENCODE_GO_API_KEY" in process.env,',
      '  native: "OPENCODE_API_KEY" in process.env }));',
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, OPENCODE_GO_API_KEY: DUMMY_REAL, OPENCODE_API_KEY: "ambient-must-not-win" },
    });
    assert.equal(res.status, 0, String(res.stderr).slice(0, 300));
    assert.deepEqual(JSON.parse(String(res.stdout).trim()), { present: true, alias: false, native: true });
    assert.ok(!String(res.stdout).includes(DUMMY_REAL), "output must never carry the credential value");
    assert.ok(!String(res.stderr).includes(DUMMY_REAL), "stderr must never carry the credential value");
  });
});

describe("p2d live modes: live-real fetch guard (allowlist only, no network)", () => {
  it("allows exactly the official catalog GET (no Authorization) and the official inference host", () => {
    assert.deepEqual(classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, { method: "GET" }), {
      action: "allow-catalog",
      reason: "catalog",
    });
    // The SDK appends the observed `type=chat,decision,image` filter.
    assert.equal(
      classifyLiveRealRequest(`${LIVE_REAL_CATALOG_URL}?type=chat,decision,image`, { method: "GET" }).action,
      "allow-catalog",
    );
    assert.equal(
      classifyLiveRealRequest("https://opencode.ai/inference/go/openai/v1/chat/completions", { method: "POST" }).action,
      "allow-inference",
    );
    assert.equal(LIVE_REAL_FETCH_GUARD, "live-real-allowlist");
  });

  it("denies every other destination before the socket (host/path/port/userinfo/IP/http)", () => {
    const denied = [
      ["https://api.opencode.ai/v1/chat", "destination"],
      ["https://opencode.ai/inference/openai/v1/chat/completions", "inference_path"],
      ["https://opencode.ai/zen/go/v1/usage", "inference_path"],
      ["https://opencode.ai:8443/inference/go/v1/chat/completions", "alternate_port"],
      ["http://opencode.ai/inference/go/v1/chat/completions", "not_https"],
      ["https://user:pass@opencode.ai/inference/go/v1/chat/completions", "credentials_in_url"],
      ["https://127.0.0.1/inference/go/v1/chat/completions", "ip_literal"],
      ["https://[::1]/inference/go/v1/chat/completions", "ip_literal"],
      ["https://models.opencode.ai/other/api.json", "catalog_path"],
      ["https://models.opencode.ai/experimental/v2.0/api.json#frag", "fragment"],
      ["not a url", "invalid_url"],
    ];
    for (const [url, reason] of denied) {
      assert.deepEqual(classifyLiveRealRequest(url, { method: "POST" }), { action: "deny", reason }, url);
    }
    // Catalog must never carry the credential.
    assert.deepEqual(
      classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, {
        method: "GET",
        headers: { authorization: "Bearer dummy-not-a-secret" },
      }),
      { action: "deny", reason: "catalog_authorization" },
    );
    // Non-GET catalog requests are refused too.
    assert.equal(classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, { method: "POST" }).reason, "catalog_method");
  });

  it("catalog: only the official plain-GET header/query shape is accepted", () => {
    // Official 2.2.4 catalog request: plain GET, User-Agent and (optional)
    // If-None-Match only. No credentials of any kind.
    assert.equal(
      classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, {
        method: "GET",
        headers: { "user-agent": "opencode/2.2.4", "if-none-match": 'W/"catalog-v1"' },
      }).action,
      "allow-catalog",
    );
    assert.equal(classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, { method: "GET" }).action, "allow-catalog");
    // Only the tokens the installed source actually requests. `embedding` is
    // NOT part of the observed filter and must be refused (least privilege).
    assert.deepEqual(
      classifyLiveRealRequest(`${LIVE_REAL_CATALOG_URL}?type=chat,decision,image`, { method: "GET" }),
      { action: "allow-catalog", reason: "catalog" },
    );
    for (const query of ["?type=chat,embedding", "?type=embedding", "?type=chat,image,embedding"]) {
      assert.equal(
        classifyLiveRealRequest(`${LIVE_REAL_CATALOG_URL}${query}`, { method: "GET" }).reason,
        "catalog_query",
        query,
      );
    }
    // Credential-shaped headers never reach the catalog, even alongside the
    // allowed ones.
    for (const headers of [
      { cookie: "session=opaque" },
      { "x-api-key": "opaque" },
      { "proxy-authorization": "Basic opaque" },
      { "x-goog-api-key": "opaque" },
      { "x-auth-token": "opaque" },
    ]) {
      assert.equal(
        classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, { method: "GET", headers }).reason,
        "catalog_credential_header",
        JSON.stringify(Object.keys(headers)),
      );
    }
    // Authorization keeps its dedicated reason (explicit, stable contract).
    assert.equal(
      classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, {
        method: "GET",
        headers: { authorization: "Bearer opaque", "user-agent": "opencode/2.2.4" },
      }).reason,
      "catalog_authorization",
    );
    // Any non-contract header is refused too (accept included: the official
    // source sends only User-Agent/If-None-Match).
    for (const headers of [{ accept: "application/json" }, { "x-extra": "1" }]) {
      assert.equal(
        classifyLiveRealRequest(LIVE_REAL_CATALOG_URL, { method: "GET", headers }).reason,
        "catalog_header",
      );
    }
    // Query must be absent or exactly `type=` over the observed token set.
    for (const query of [
      "?x=1",
      "?type=",
      "?type=chat,foo",
      "?type=chat&x=1",
      "?type=chat,chat",
      "?type=chat%2Cembedding",
    ]) {
      assert.equal(
        classifyLiveRealRequest(`${LIVE_REAL_CATALOG_URL}${query}`, { method: "GET" }).reason,
        "catalog_query",
        query,
      );
    }
    // URL credentials, fragments and alternate ports stay refused.
    assert.equal(
      classifyLiveRealRequest("https://user:pass@models.opencode.ai/experimental/v2.0/api.json", { method: "GET" }).reason,
      "credentials_in_url",
    );
    assert.equal(
      classifyLiveRealRequest("https://models.opencode.ai:8443/experimental/v2.0/api.json", { method: "GET" }).reason,
      "alternate_port",
    );
    assert.equal(
      classifyLiveRealRequest("https://models.opencode.ai/experimental/v2.0/api.json#frag", { method: "GET" }).reason,
      "fragment",
    );
  });

  it("forced manual redirects fail closed and only categories/counts/statuses are observed", async () => {
    const calls = [];
    const redirecting = async (input, init) => {
      calls.push({ input, redirect: init && init.redirect });
      return { status: 302, headers: new Map([["location", "https://evil.example/"]]), redirected: false };
    };
    const guard = createLiveRealFetchGuard({
      fetchImpl: redirecting,
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    await assert.rejects(
      () => guard.fetch(CHAT_COMPLETIONS_URL, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) }),
      /redirect blocked/i,
    );
    assert.equal(calls[0].redirect, "manual", "redirects are never followed automatically");
    assert.equal(guard.stats.redirectsBlocked, 1);
    assert.equal(guard.stats.inferenceAllowed, 0);

    const okFetch = async (input, init) => {
      calls.push({ input, redirect: init && init.redirect });
      return { status: 200, redirected: false };
    };
    const okGuard = createLiveRealFetchGuard({
      fetchImpl: okFetch,
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    await okGuard.fetch(LIVE_REAL_CATALOG_URL, { method: "GET" });
    await okGuard.fetch(CHAT_COMPLETIONS_URL, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) });
    assert.deepEqual(
      {
        catalogAllowed: okGuard.stats.catalogAllowed,
        inferenceAttempts: okGuard.stats.inferenceAttempts,
        inferenceAllowed: okGuard.stats.inferenceAllowed,
        inferenceFailures: okGuard.stats.inferenceFailures,
        blocked: okGuard.stats.blocked,
        redirectsBlocked: okGuard.stats.redirectsBlocked,
        catalogStatuses: okGuard.stats.catalogStatuses,
        inferenceStatuses: okGuard.stats.inferenceStatuses,
      },
      {
        catalogAllowed: 1,
        inferenceAttempts: 1,
        inferenceAllowed: 1,
        inferenceFailures: 0,
        blocked: 0,
        redirectsBlocked: 0,
        catalogStatuses: [200],
        inferenceStatuses: [200],
      },
    );
    // No URL/path/body/header value is retained anywhere in the observed stats.
    const serialized = JSON.stringify(okGuard.stats);
    for (const banned of ["opencode.ai", "inference/go", "api.json", "authorization", "bearer"]) {
      assert.ok(!serialized.toLowerCase().includes(banned), `stats must not carry ${banned}`);
    }

    const deniedFetch = async () => {
      throw new Error("must not reach fetch");
    };
    const denyGuard = createLiveRealFetchGuard({
      fetchImpl: deniedFetch,
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    await assert.rejects(() => denyGuard.fetch("https://evil.example/", { method: "POST" }), /blocked/i);
    assert.equal(denyGuard.stats.blocked, 1);
  });

  it("Request + init: the supplied init is preserved and redirects stay manual", async () => {
    const seen = [];
    const okFetch = async (input) => {
      seen.push({
        url: input.url,
        method: input.method,
        redirect: input.redirect,
        initHeader: input.headers.get("x-p2d-init"),
        body: await input.text(),
      });
      return { status: 200, redirected: false };
    };
    const guard = createLiveRealFetchGuard({
      fetchImpl: okFetch,
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    const request = new Request(CHAT_COMPLETIONS_URL, { method: "POST" });
    const body = inferenceBody(LIVE_MODEL_ID);
    await guard.fetch(request, { headers: { "x-p2d-init": "kept" }, body });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].redirect, "manual", "Request + init must still force manual redirects");
    assert.equal(seen[0].initHeader, "kept", "the supplied init must not be discarded");
    assert.equal(seen[0].body, body, "the supplied init body must not be discarded");
    assert.equal(seen[0].method, "POST");
    assert.equal(guard.stats.inferenceAllowed, 1);
    assert.deepEqual(guard.stats.inferenceModels, [LIVE_MODEL_ID]);
  });

  it("a response reporting redirected===true is rejected even with a 200 status", async () => {
    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => ({ status: 200, redirected: true }),
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    await assert.rejects(
      () => guard.fetch(CHAT_COMPLETIONS_URL, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) }),
      /redirect blocked/i,
    );
    assert.equal(guard.stats.redirectsBlocked, 1);
    assert.equal(guard.stats.inferenceAllowed, 0);
  });

  it("requires a fetch implementation and the pinned model id (fail-closed)", () => {
    assert.throws(() => createLiveRealFetchGuard({}), /fetchImpl/i);
    const fetchImpl = async () => ({ status: 200, redirected: false });
    assert.throws(() => createLiveRealFetchGuard({ fetchImpl, apiOrigin: "http://127.0.0.1:4110" }), /expectedModelID/i);
    for (const expectedModelID of [42, "", "not a model!", "x".repeat(81)]) {
      assert.throws(
        () => createLiveRealFetchGuard({ fetchImpl, apiOrigin: "http://127.0.0.1:4110", expectedModelID }),
        /expectedModelID/i,
        String(expectedModelID),
      );
    }
  });

  it("pins the OpenAI-compatible model BEFORE the socket (fallback cannot receive the key)", async () => {
    let calls = 0;
    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, redirected: false };
      },
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    await guard.fetch(CHAT_COMPLETIONS_URL, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) });
    assert.equal(calls, 1);
    assert.deepEqual(
      {
        attempts: guard.stats.inferenceAttempts,
        allowed: guard.stats.inferenceAllowed,
        failures: guard.stats.inferenceFailures,
        models: guard.stats.inferenceModels,
        statuses: guard.stats.inferenceStatuses,
      },
      {
        attempts: 1,
        allowed: 1,
        failures: 0,
        models: [LIVE_MODEL_ID],
        statuses: [200],
      },
    );
    // The body content is never persisted: only the pinned model identifier.
    const serialized = JSON.stringify(guard.stats);
    assert.ok(!serialized.includes("messages"), "request body content is never stored");
    assert.ok(!serialized.includes("stream"), "request body content is never stored");

    const rejected = [
      [{ method: "POST", body: inferenceBody("other-model") }, "inference_model"],
      [{ method: "POST", body: JSON.stringify({ model: "", messages: [] }) }, "inference_model"],
      [{ method: "POST", body: JSON.stringify({ messages: [] }) }, "inference_model"],
      [{ method: "POST", body: JSON.stringify({ model: 42 }) }, "inference_model"],
      [{ method: "POST", body: "not json" }, "inference_body"],
      [{ method: "POST" }, "inference_body"],
      [{ method: "POST", body: JSON.stringify(["array"]) }, "inference_model"],
    ];
    for (const [init, reason] of rejected) {
      await assert.rejects(() => guard.fetch(CHAT_COMPLETIONS_URL, init), new RegExp(reason));
    }
    assert.equal(calls, 1, "no divergent/absent model body may reach the socket");
    assert.equal(guard.stats.inferenceAttempts, 1 + rejected.length);
    assert.equal(guard.stats.inferenceFailures, rejected.length);
    assert.equal(guard.stats.inferenceAllowed, 1);
    assert.equal(guard.stats.blocked, rejected.length);
    assert.deepEqual(guard.stats.inferenceModels, [LIVE_MODEL_ID]);
  });

  it("admits only the POST /chat/completions inference shape", async () => {
    let calls = 0;
    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, redirected: false };
      },
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    const denied = [
      ["https://opencode.ai/inference/go/openai/v1/models", { method: "POST", body: inferenceBody(LIVE_MODEL_ID) }, "inference_shape"],
      [`${CHAT_COMPLETIONS_URL}/extra`, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) }, "inference_shape"],
      [CHAT_COMPLETIONS_URL, { method: "GET" }, "inference_method"],
      [CHAT_COMPLETIONS_URL, { method: "PUT", body: inferenceBody(LIVE_MODEL_ID) }, "inference_method"],
    ];
    for (const [url, init, reason] of denied) {
      await assert.rejects(() => guard.fetch(url, init), new RegExp(reason), `${init.method} ${url}`);
    }
    assert.equal(calls, 0, "unpinnable inference shapes never open a socket");
    assert.equal(guard.stats.inferenceAttempts, 0);
  });

  it("Request + init: model is validated from the effective body without consuming the stream", async () => {
    const seen = [];
    const guard = createLiveRealFetchGuard({
      fetchImpl: async (input) => {
        seen.push({ body: await input.text(), header: input.headers.get("x-p2d-init"), signal: input.signal });
        return { status: 200, redirected: false };
      },
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    // Body lives on the Request itself (no init.body): read from a clone.
    const controller = new AbortController();
    const request = new Request(CHAT_COMPLETIONS_URL, {
      method: "POST",
      body: inferenceBody(LIVE_MODEL_ID),
      signal: controller.signal,
    });
    await guard.fetch(request, { headers: { "x-p2d-init": "kept" } });
    assert.equal(seen.length, 1);
    assert.equal(JSON.parse(seen[0].body).model, LIVE_MODEL_ID);
    assert.equal(seen[0].header, "kept");
    assert.ok(seen[0].signal, "the caller signal is preserved on the forwarded request");
    assert.equal(seen[0].signal.aborted, false);
    controller.abort();
    assert.equal(seen[0].signal.aborted, true, "the forwarded request follows the caller signal");
    assert.deepEqual(guard.stats.inferenceModels, [LIVE_MODEL_ID]);

    // init.body is what fetch actually sends, so it wins over the Request body.
    const other = new Request(CHAT_COMPLETIONS_URL, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) });
    await assert.rejects(() => guard.fetch(other, { body: inferenceBody("other-model") }), /inference_model/);
    assert.equal(seen.length, 1, "the divergent effective body never reaches the socket");
    assert.equal(guard.stats.inferenceFailures, 1);
  });

  it("counts a non-2xx inference response as a failure (statuses still recorded)", async () => {
    const guard = createLiveRealFetchGuard({
      fetchImpl: async () => ({ status: 500, redirected: false }),
      apiOrigin: "http://127.0.0.1:4110",
      expectedModelID: LIVE_MODEL_ID,
    });
    await guard.fetch(CHAT_COMPLETIONS_URL, { method: "POST", body: inferenceBody(LIVE_MODEL_ID) });
    assert.equal(guard.stats.inferenceAttempts, 1);
    assert.equal(guard.stats.inferenceAllowed, 1);
    assert.equal(guard.stats.inferenceFailures, 1);
    assert.deepEqual(guard.stats.inferenceStatuses, [500]);
  });
});

describe("p2d live modes: live-real loopback API allowlist (no network)", () => {
  const API_ORIGIN = "http://127.0.0.1:4110";
  const at = (input, init) => classifyLiveRealRequest(input, init, { apiOrigin: API_ORIGIN });

  it("accepts exactly the four contract pairs (method/path/query/headers/body)", () => {
    assert.deepEqual(
      at(`${API_ORIGIN}/auth/agent-token`, {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=opaque",
          "x-workspace-id": "household-a",
          "x-device-token": "device-opaque",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
      }),
      { action: "allow-api", reason: "api" },
    );
    assert.deepEqual(
      at(`${API_ORIGIN}/auth/devices/me`, {
        method: "GET",
        headers: { "x-device-token": "device-opaque", accept: "application/json" },
      }),
      { action: "allow-api", reason: "api" },
    );
    assert.deepEqual(
      at(`${API_ORIGIN}/accounts`, {
        method: "GET",
        headers: {
          "x-device-token": "device-opaque",
          "x-workspace-id": "household-a",
          accept: "application/json",
        },
      }),
      { action: "allow-api", reason: "api" },
    );
    assert.deepEqual(
      at(`${API_ORIGIN}/dashboard/month-summary?yearMonth=2026-06`, {
        method: "GET",
        headers: {
          "x-device-token": "device-opaque",
          "x-workspace-id": "household-a",
          accept: "application/json",
        },
      }),
      { action: "allow-api", reason: "api" },
    );
    // Trailing slash on the declared origin is the same bare origin.
    assert.equal(
      classifyLiveRealRequest(`${API_ORIGIN}/accounts`, { method: "GET" }, { apiOrigin: `${API_ORIGIN}/` }).action,
      "allow-api",
    );
    // P3 pilot live-real reads: categories + statements GETs allowlisted (reads only, no writes).
    assert.equal(
      classifyLiveRealRequest(`${API_ORIGIN}/categories?kind=expense`, { method: "GET", headers: { "x-device-token": "device-opaque", "x-workspace-id": "household-a", accept: "application/json" } }, { apiOrigin: API_ORIGIN }).action,
      "allow-api",
    );
    assert.equal(
      classifyLiveRealRequest(`${API_ORIGIN}/cards/statements?accountId=11111111-1111-4111-8111-111111111114`, { method: "GET", headers: { "x-device-token": "device-opaque", "x-workspace-id": "household-a", accept: "application/json" } }, { apiOrigin: API_ORIGIN }).action,
      "allow-api",
    );
    // list_card_statements legitimate queries: no filter, accountId, status,
    // limit or any valid combination (API contract in cards.ts:86-90).
    const stmtHeaders = { "x-device-token": "device-opaque", "x-workspace-id": "household-a", accept: "application/json" };
    for (const suffix of [
      "",
      "?accountId=11111111-1111-4111-8111-111111111114",
      "?status=open",
      "?status=partial",
      "?limit=1",
      "?limit=50",
      "?accountId=11111111-1111-4111-8111-111111111114&status=open",
      "?status=open&limit=5",
      "?accountId=11111111-1111-4111-8111-111111111114&status=open&limit=5",
      "?limit=5&status=open&accountId=11111111-1111-4111-8111-111111111114",
    ]) {
      assert.equal(
        classifyLiveRealRequest(`${API_ORIGIN}/cards/statements${suffix}`, { method: "GET", headers: stmtHeaders }, { apiOrigin: API_ORIGIN }).action,
        "allow-api",
        `/cards/statements${suffix}`,
      );
    }
    // Real-model natural calls: /accounts with kind/includeInactive filters (runtime-emitted shapes only).
    for (const suffix of ["", "?kind=bank", "?kind=cash", "?kind=credit_card", "?includeInactive=true", "?kind=bank&includeInactive=false"]) {
      assert.equal(
        classifyLiveRealRequest(`${API_ORIGIN}/accounts${suffix}`, { method: "GET", headers: { "x-device-token": "device-opaque", "x-workspace-id": "household-a", accept: "application/json" } }, { apiOrigin: API_ORIGIN }).action,
        "allow-api",
      );
    }
  });

  it("denies every other loopback origin, method, path, query, header and body", () => {
    const baseHeaders = {
      "x-device-token": "device-opaque",
      "x-workspace-id": "household-a",
      accept: "application/json",
    };
    const denied = [
      // Origin/address family: exact literal only (never localhost/::1/port).
      [`http://localhost:4110/accounts`, { method: "GET", headers: baseHeaders }, "api_origin_mismatch"],
      [`http://[::1]:4110/accounts`, { method: "GET", headers: baseHeaders }, "api_origin_mismatch"],
      [`http://127.0.0.1:4111/accounts`, { method: "GET", headers: baseHeaders }, "api_origin_mismatch"],
      [`https://127.0.0.1:4110/accounts`, { method: "GET", headers: baseHeaders }, "api_origin_mismatch"],
      [`http://127.0.0.1/accounts`, { method: "GET", headers: baseHeaders }, "api_origin_mismatch"],
      // Writes and non-contract routes.
      [`${API_ORIGIN}/accounts`, { method: "POST", headers: baseHeaders, body: "{}" }, "api_method_path"],
      [`${API_ORIGIN}/accounts/123`, { method: "GET", headers: baseHeaders }, "api_method_path"],
      [`${API_ORIGIN}/auth/agent-token`, { method: "GET", headers: baseHeaders }, "api_method_path"],
      [`${API_ORIGIN}/dashboard/month-summary`, { method: "POST", headers: baseHeaders, body: "{}" }, "api_method_path"],
      // Queries: none on /accounts, exact yearMonth=YYYY-MM on the summary.
      [`${API_ORIGIN}/accounts?limit=1`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/auth/devices/me?x=1`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/dashboard/month-summary`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/dashboard/month-summary?yearMonth=2026-13`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/dashboard/month-summary?yearMonth=26-06`, { method: "GET", headers: baseHeaders }, "api_query"],
      [
        `${API_ORIGIN}/dashboard/month-summary?yearMonth=2026-06&limit=1`,
        { method: "GET", headers: baseHeaders },
        "api_query",
      ],
      // Statements: only the contract subsets with uuid/enum/canonical 1-50.
      [`${API_ORIGIN}/cards/statements`, { method: "POST", headers: baseHeaders, body: "{}" }, "api_method_path"],
      [`${API_ORIGIN}/cards/statements`, { method: "PATCH", headers: baseHeaders, body: "{}" }, "api_method_path"],
      [`${API_ORIGIN}/cards/statements`, { method: "DELETE", headers: baseHeaders }, "api_method_path"],
      [`${API_ORIGIN}/cards/statements/123`, { method: "GET", headers: baseHeaders }, "api_method_path"],
      [`${API_ORIGIN}/cards/statements?accountId=not-a-uuid`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?accountId=11111111-1111-4111-8111-111111111114&foo=bar`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?status=invalid`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?status=OPEN`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?limit=0`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?limit=51`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?limit=05`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?limit=abc`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?limit=5&limit=6`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?accountId=11111111-1111-4111-8111-111111111114&accountId=11111111-1111-4111-8111-111111111114`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?limit=`, { method: "GET", headers: baseHeaders }, "api_query"],
      [`${API_ORIGIN}/cards/statements?foo=bar`, { method: "GET", headers: baseHeaders }, "api_query"],
      // Credential headers never reach the synthetic API.
      [
        `${API_ORIGIN}/accounts`,
        { method: "GET", headers: { ...baseHeaders, authorization: "Bearer opaque" } },
        "api_credential_header",
      ],
      [
        `${API_ORIGIN}/accounts`,
        { method: "GET", headers: { ...baseHeaders, "x-api-key": "opaque" } },
        "api_credential_header",
      ],
      [
        `${API_ORIGIN}/accounts`,
        { method: "GET", headers: { ...baseHeaders, cookie: "session=opaque" } },
        "api_credential_header",
      ],
      [
        `${API_ORIGIN}/auth/devices/me`,
        { method: "GET", headers: { "x-device-token": "device-opaque", accept: "application/json", "proxy-authorization": "Basic opaque" } },
        "api_credential_header",
      ],
      // Header allowlist is per route (x-workspace-id is not sent to devices/me).
      [
        `${API_ORIGIN}/auth/devices/me`,
        { method: "GET", headers: baseHeaders },
        "api_header",
      ],
      [
        `${API_ORIGIN}/accounts`,
        { method: "GET", headers: { ...baseHeaders, "x-extra": "1" } },
        "api_header",
      ],
      // POST auth body must be exactly `{}`; GETs carry no body.
      [
        `${API_ORIGIN}/auth/agent-token`,
        {
          method: "POST",
          headers: { ...baseHeaders, cookie: "s=1", "content-type": "application/json" },
          body: '{"a":1}',
        },
        "api_body",
      ],
      [
        `${API_ORIGIN}/auth/agent-token`,
        { method: "POST", headers: { ...baseHeaders, cookie: "s=1", "content-type": "application/json" } },
        "api_body",
      ],
      [`${API_ORIGIN}/accounts`, { method: "GET", headers: baseHeaders, body: "x" }, "api_body"],
      // Content-type is only meaningful on the auth POST, and only JSON.
      [
        `${API_ORIGIN}/auth/agent-token`,
        { method: "POST", headers: { ...baseHeaders, cookie: "s=1", "content-type": "text/plain" }, body: "{}" },
        "api_content_type",
      ],
      [
        `${API_ORIGIN}/accounts`,
        { method: "GET", headers: { ...baseHeaders, "content-type": "application/json" } },
        "api_header",
      ],
      // URL credentials/fragments stay refused on the API origin too.
      [`http://user:pass@127.0.0.1:4110/accounts`, { method: "GET", headers: baseHeaders }, "credentials_in_url"],
      [`${API_ORIGIN}/accounts#frag`, { method: "GET", headers: baseHeaders }, "fragment"],
    ];
    for (const [url, init, reason] of denied) {
      assert.deepEqual(at(url, init), { action: "deny", reason }, `${init.method} ${url}`);
    }
  });

  it("the REAL gateway identity + finance transport calls pass the guard (fake fetch, no network)", async () => {
    const { resolveGatewayIdentity } = await import(
      pathToFileURL(path.join(REPO_ROOT, "apps", "ted-runtime", "src", "gateway.mjs")).href
    );
    const { HttpFinanceTransport } = await import(
      pathToFileURL(path.join(REPO_ROOT, "apps", "ted-runtime", "src", "transport.mjs")).href
    );
    const claims = Buffer.from(JSON.stringify({ sub: "actor-1", deviceId: "device-1" })).toString("base64url");
    const token = `h.${claims}.s`;
    const fakeFetch = async (input) => {
      const url = String(input);
      const body = url.endsWith("/auth/agent-token")
        ? { token, workspace: "household-a", role: "member" }
        : url.endsWith("/auth/devices/me")
          ? { deviceId: "device-1", householdId: "household-a" }
          : url.includes("/cards/statements")
            ? { items: [], total: 0 }
            : url.includes("/accounts")
              ? { items: [], total: 0 }
              : { yearMonth: "2026-06", incomeCents: 0, expenseCents: 0, balanceCents: 0, transactionCount: 0 };
      return { status: 200, redirected: false, json: async () => body };
    };
    const guard = createLiveRealFetchGuard({
      fetchImpl: fakeFetch,
      apiOrigin: API_ORIGIN,
      expectedModelID: LIVE_MODEL_ID,
    });

    const identity = await resolveGatewayIdentity({
      apiBaseUrl: API_ORIGIN,
      cookie: "better-auth.session_token=opaque",
      deviceToken: "device-opaque",
      workspaceId: "household-a",
      fetchImpl: guard.fetch,
    });
    assert.equal(identity.workspace, "household-a");
    assert.equal(identity.deviceId, "device-1");

    const transport = new HttpFinanceTransport({
      baseUrl: API_ORIGIN,
      fetchImpl: guard.fetch,
      timeoutMs: 5000,
    });
    const host = { token: "device-opaque", household: "household-a" };
    await transport.call({ route: "/accounts", method: "GET", host });
    await transport.call({ route: "/dashboard/month-summary?yearMonth=2026-06", method: "GET", host });
    await transport.call({ route: "/cards/statements?accountId=11111111-1111-4111-8111-111111111114", method: "GET", host });

    // Exactly the contract pairs the runtime already sends (identity x2 +
    // accounts + summary + statements); nothing blocked, every response a 200.
    assert.equal(guard.stats.apiAllowed, 5);
    assert.equal(guard.stats.apiBlocked, 0);
    assert.equal(guard.stats.blocked, 0);
    assert.deepEqual(guard.stats.apiStatuses, [200, 200, 200, 200, 200]);
  });

  it("fails closed on a missing/invalid apiOrigin (never a generic localhost release)", () => {
    const fetchImpl = async () => ({ status: 200, redirected: false });
    assert.throws(() => createLiveRealFetchGuard({ fetchImpl }), /apiOrigin/i);
    for (const apiOrigin of [
      42,
      "",
      "http://localhost:4110",
      "http://[::1]:4110",
      "https://127.0.0.1:4110",
      "http://127.0.0.1",
      "http://127.0.0.1:4110/api",
      "http://127.0.0.1:4110?x=1",
      "not a url",
    ]) {
      assert.throws(
        () => createLiveRealFetchGuard({ fetchImpl, apiOrigin }),
        /apiOrigin/i,
        String(apiOrigin),
      );
    }
  });

  it("API branch: manual redirects fail closed and only categories/counts/statuses are observed", async () => {
    const calls = [];
    const okFetch = async (input, init) => {
      calls.push({ input, redirect: init && init.redirect });
      return { status: 200, redirected: false };
    };
    const guard = createLiveRealFetchGuard({
      fetchImpl: okFetch,
      apiOrigin: API_ORIGIN,
      expectedModelID: LIVE_MODEL_ID,
    });
    await guard.fetch(`${API_ORIGIN}/accounts`, { method: "GET" });
    await guard.fetch(`${API_ORIGIN}/dashboard/month-summary?yearMonth=2026-06`, { method: "GET" });
    assert.deepEqual(
      {
        apiAllowed: guard.stats.apiAllowed,
        apiBlocked: guard.stats.apiBlocked,
        apiStatuses: guard.stats.apiStatuses,
        blocked: guard.stats.blocked,
      },
      { apiAllowed: 2, apiBlocked: 0, apiStatuses: [200, 200], blocked: 0 },
    );
    assert.equal(calls[0].redirect, "manual", "API requests are never followed automatically");

    await assert.rejects(() => guard.fetch(`${API_ORIGIN}/accounts`, { method: "POST" }), /blocked/i);
    assert.equal(guard.stats.apiBlocked, 1);
    assert.equal(guard.stats.blocked, 1);
    assert.equal(guard.stats.apiAllowed, 2);

    // Stats carry no URL, route, header or body value.
    const serialized = JSON.stringify(guard.stats);
    for (const banned of ["127.0.0.1", "agent-token", "devices/me", "accounts", "yearMonth", "device-token", "cookie"]) {
      assert.ok(!serialized.toLowerCase().includes(banned.toLowerCase()), `stats must not carry ${banned}`);
    }

    const redirecting = async () => ({ status: 302, redirected: false });
    const redirectGuard = createLiveRealFetchGuard({
      fetchImpl: redirecting,
      apiOrigin: API_ORIGIN,
      expectedModelID: LIVE_MODEL_ID,
    });
    await assert.rejects(() => redirectGuard.fetch(`${API_ORIGIN}/accounts`, { method: "GET" }), /redirect blocked/i);
    assert.equal(redirectGuard.stats.redirectsBlocked, 1);
    assert.equal(redirectGuard.stats.apiAllowed, 0);
    assert.equal(redirectGuard.stats.apiStatuses.length, 0);
  });
});

describe("p2d live modes: Playwright env + launcher selection", () => {
  it("buildPlaywrightEnv selects exactly one mode and never forwards credentials", () => {
    const dirty = {
      PATH: "/usr/bin",
      OPENCODE_GO: DUMMY_REAL,
      OPENCODE_GO_API_KEY: DUMMY_REAL,
      NODE_OPTIONS: "--inspect",
    };
    const offline = buildPlaywrightEnv(dirty, { livePrep: false, offlineChat: true });
    assert.equal(offline.P2D_BROWSER, "1");
    assert.equal(offline.P2D_OFFLINE_CHAT, "1");
    assert.ok(!("P2D_LIVE_PREP" in offline));
    assert.ok(!("P2D_LIVE_REAL" in offline));
    assert.ok(!("OPENCODE_GO" in offline));
    assert.ok(!("OPENCODE_GO_API_KEY" in offline));
    assert.ok(!("NODE_OPTIONS" in offline));

    const real = buildPlaywrightEnv(dirty, { livePrep: false, liveReal: true });
    assert.equal(real.P2D_LIVE_REAL, "1");
    assert.ok(!("P2D_LIVE_PREP" in real));
    assert.ok(!("P2D_OFFLINE_CHAT" in real));
    assert.ok(!("OPENCODE_GO" in real));
    assert.ok(!("OPENCODE_GO_API_KEY" in real));

    assert.throws(
      () => buildPlaywrightEnv({}, { livePrep: true, offlineChat: true }),
      /one mode|exclusive/i,
    );
  });

  it("parsePrepArgs: bare stays live-prep, --offline/--live-real are explicit, mix fails", () => {
    assert.deepEqual(parsePrepArgs([]), { mode: "run" });
    assert.deepEqual(parsePrepArgs(["--offline"]), { mode: "run", flavor: "offline" });
    assert.deepEqual(parsePrepArgs(["--live-real"]), { mode: "run", flavor: "live-real" });
    assert.equal(parsePrepArgs(["--offline", "--live-real"]).mode, "error");
    assert.equal(parsePrepArgs(["--nope"]).mode, "error");
    assert.equal(parsePrepArgs(["--help"]).mode, "help");
  });

  it("CLI --help documents both new opt-ins without starting services", () => {
    const res = spawnSync(process.execPath, [PREP_FILE, "--help"], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    assert.match(String(res.stdout), /--offline/);
    assert.match(String(res.stdout), /--live-real/);
    assert.ok(!String(res.stdout).includes("stage="));
    assert.equal(String(res.stderr), "");
  });

  it("launcher and config select the new specs without leaking credentials", () => {
    const prep = fs.readFileSync(PREP_FILE, "utf8");
    for (const required of ["P2D_OFFLINE_CHAT", "P2D_LIVE_REAL", "p2d-live-offline", "p2d-live-real"]) {
      assert.ok(prep.includes(required), `launcher must contain ${required}`);
    }
    const config = fs.readFileSync(CONFIG_FILE, "utf8");
    for (const required of [
      "P2D_OFFLINE_CHAT",
      "P2D_LIVE_REAL",
      "p2d-live-offline.spec.ts",
      "p2d-live-real.spec.ts",
      "buildPlaywrightEnv(process.env,",
    ]) {
      assert.ok(config.includes(required), `config must contain ${required}`);
    }
    const stack = fs.readFileSync(STACK_FILE, "utf8");
    for (const required of ["P2D_OFFLINE_CHAT", "P2D_LIVE_REAL", 'profile: "live"']) {
      assert.ok(stack.includes(required), `stack must contain ${required}`);
    }
    for (const banned of ["OPENCODE_GO_API_KEY", "OPENCODE_GO", "credentialValue", "loadLiveCredential"]) {
      assert.ok(!stack.includes(banned), `stack must never handle the credential (${banned})`);
    }
  });

  it("probe branches on mode, uses the shared helpers and keeps the loopback guard", () => {
    const src = fs.readFileSync(PROBE_FILE, "utf8");
    for (const required of [
      "buildOfflineProviderConfig",
      "loadRuntimeCredentialForMode",
      "OFFLINE_DUMMY_KEY",
      "writeTedConfig",
      "live-real",
      "offline",
      "retryHookAvailable",
      "guard: non-loopback fetch blocked",
      "details redacted",
      "createLiveRealFetchGuard",
      "live-real-allowlist",
      "apiOrigin",
      "financeToolNames",
      "onEffectiveTools",
      "OPENCODE_API_KEY",
      "sdkProviderID",
      "sdkModelID",
      "stubModels",
      "native snapshot unavailable",
    ]) {
      assert.ok(src.includes(required), `probe must contain ${required}`);
    }
    // Live-real ONLY: this child translates the preserved alias into the
    // native key after isolation; presence is observed, never hardcoded. The
    // prep path and the product bootstrap keep the alias untouched.
    assert.ok(
      src.includes("credentialPresent = applyLiveRealCredentialAlias(process.env)"),
      "probe must translate the alias to the native key on the live-real path",
    );
    assert.ok(
      src.includes('if (MODE === "live-real") {'),
      "the env credential must be supplied on the live-real path only",
    );
    // Offline has no env credential: presence is observed from the composed
    // provider config (the dummy apiKey), never hardcoded.
    assert.ok(
      src.includes("credentialPresent = Boolean(cfg.providers?.[PROVIDER]?.settings?.apiKey)"),
      "offline presence must be observed from the composed provider config",
    );
    // The retry instrumentation must be gated to LIVE_MODE: the default
    // synthetic setup/plugin is never wrapped.
    const pluginAt = src.indexOf("const pluginDef = defineTedFinancePlugin");
    const wrapperAt = src.indexOf("const origSetup = pluginDef.setup.bind(pluginDef)");
    const wireAt = src.indexOf("await wirePlugin(oc, pluginDef)");
    assert.ok(pluginAt !== -1 && wrapperAt !== -1 && wireAt !== -1, "probe must wire the plugin");
    assert.ok(pluginAt < wrapperAt && wrapperAt < wireAt, "retry wrapper sits between plugin and wiring");
    assert.ok(
      src.slice(pluginAt, wrapperAt).includes("if (LIVE_MODE) {"),
      "retry wrapper must be gated to LIVE_MODE (synthetic plugin untouched)",
    );
    // Effective-catalog capture is live-real ONLY: the synthetic plugin gets
    // no extra option at all (no wrapper, no instrumentation).
    const captureAt = src.indexOf("pluginOptions.onEffectiveTools");
    assert.ok(captureAt !== -1, "probe must capture the effective finance catalog");
    assert.ok(
      src.slice(Math.max(0, captureAt - 400), captureAt).includes('MODE === "live-real"'),
      "effective-catalog capture must be gated to live-real (synthetic untouched)",
    );
    // The guard receives the EXACT synthetic API origin (never a generic
    // localhost release) and the pinned model id resolved from
    // live-model.json; the probe also verifies the guard is installed before
    // the SDK import.
    assert.ok(src.includes("expectedModelID"), "probe must pin the inference model id");
    assert.ok(
      src.includes("createLiveRealFetchGuard({") &&
        src.includes("fetchImpl: realFetch,") &&
        src.includes("apiOrigin: apiBaseUrl,") &&
        src.includes("expectedModelID,"),
      "the live-real guard must be pinned to the exact synthetic API origin and model",
    );
    assert.ok(
      src.includes("live-real fetch guard is not installed before the SDK import"),
      "probe must verify the guard is installed before the SDK import",
    );
  });

  it("specs exist and are opt-in only (no real credential handling in the offline spec)", () => {
    const offline = fs.readFileSync(OFFLINE_SPEC, "utf8");
    assert.ok(offline.includes("P2D_OFFLINE_CHAT"));
    assert.ok(offline.includes("promptCalls"));
    assert.ok(offline.includes("forced"));
    assert.ok(offline.includes("exitCode"));
    assert.ok(!offline.includes("OPENCODE_GO_API_KEY"));
    assert.ok(!offline.includes("loadLiveCredential"));
    const real = fs.readFileSync(REAL_SPEC, "utf8");
    assert.ok(real.includes("P2D_LIVE_REAL"));
    assert.ok(real.includes("credentialSource"));
    // The spec proves the loopback API allowlist (the probe's own gateway
    // identity + finance transport calls) and the effective finance catalog.
    for (const required of [
      "apiAllowed",
      "apiBlocked",
      "apiStatuses",
      "financeToolNames",
      "inferenceAttempts",
      "inferenceFailures",
      "inferenceStatuses",
      "inferenceModels",
    ]) {
      assert.ok(real.includes(required), `live-real spec must assert ${required}`);
    }
    // The captured effective catalog must be pinned to exactly the two
    // finance tools (list_categories stays absent), matching the offline
    // request `tools[]` equality.
    assert.ok(
      real.includes('toEqual(["get_month_summary", "list_accounts"])'),
      "live-real spec must pin the exact captured finance catalog",
    );
    // The spec may DOCUMENT the credential boundary, but it must never read
    // or handle it.
    assert.ok(!real.includes("process.env.OPENCODE_GO_API_KEY"));
    assert.ok(!real.includes("loadLiveCredential"));
    // Both E2E specs must prove one browser POST + one native user message +
    // the registered retry hook, not just the SDK prompt counter.
    for (const [label, src] of [
      ["offline", offline],
      ["live-real", real],
    ]) {
      assert.ok(src.includes("rpc/chat"), `${label} must count browser /rpc/chat POSTs`);
      assert.ok(src.includes("userMessages"), `${label} must prove native user messages`);
      assert.ok(src.includes("retryHookRegistered"), `${label} must assert the retry hook registration`);
    }
  });

  it("live-real spec pins the exact tool-driven read slice (2 reads, 1 per route, GET, 2026-06)", () => {
    const real = fs.readFileSync(REAL_SPEC, "utf8");
    // Exactly two tool-driven finance transport calls: a relaxed `>=` bound
    // would let a duplicated/extra tool call pass as the accepted slice.
    assert.match(real, /expect\(stats\.transportCalls\)\.toBe\(2\)/);
    assert.ok(
      !/expect\(stats\.transportCalls\)\.toBeGreaterThanOrEqual/.test(real),
      "live-real must not relax the transportCalls bound",
    );
    assert.match(real, /expect\(reads\.length\)\.toBe\(2\)/);
    assert.ok(
      !/expect\(reads\.length\)\.toBeGreaterThanOrEqual/.test(real),
      "live-real must not relax the financeReads bound",
    );
    // Each required route is executed exactly once (never ">= 1").
    assert.match(real, /expect\(listAccountsCount\)\.toBe\(1\)/);
    assert.match(real, /expect\(getMonthSummaryCount\)\.toBe\(1\)/);
    // The month-summary read is pinned to the month the prompt asked for.
    assert.match(real, /yearMonth=2026-06/);
    // Provider completion requests stay intentionally unpinned: a tool loop
    // may combine or split provider calls, so only the minimum is required.
    assert.match(real, /expect\(\(guard\.inferenceStatuses \?\? \[\]\)\.length\)\.toBeGreaterThanOrEqual\(1\)/);
  });

  it("root package exposes reproducible commands for both modes", () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, "utf8"));
    assert.equal(
      pkg.scripts["test:p2d-offline"],
      "node apps/pwa/e2e/support/p2d-live-prep.mjs --offline",
    );
    assert.equal(
      pkg.scripts["test:p2d-live-real"],
      "node apps/pwa/e2e/support/p2d-live-prep.mjs --live-real",
    );
  });

  it("run-ci.sh runs both P2D node:test contracts without a new runner", () => {
    const runner = fs.readFileSync(path.join(HERE, "..", "run-ci.sh"), "utf8");
    assert.match(runner, /node --test e2e\/support\/p2d-live-credential\.test\.mjs/);
    assert.match(runner, /e2e\/support\/p2d-live-modes\.test\.mjs/);
    assert.ok(!runner.includes("playwright test --config=e2e/p2d"), "no separate P2D runner is introduced");
  });
});

describe("p2d live modes: Playwright config load (static, no servers)", () => {
  const TSX_CLI = path.join(PWA_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

  function configSnapshot(extraEnv) {
    const probe = [
      `(async () => {`,
      `  const m = await import(${JSON.stringify(pathToFileURL(CONFIG_FILE).href)});`,
      `  const cfg = m.default?.default ?? m.default;`,
      `  const ws = cfg.webServer ?? [];`,
      `  const projs = cfg.projects ?? [];`,
      `  const proj = projs.find((p) => p.name === "p2d-synthetic");`,
      `  console.log(JSON.stringify({`,
      `    commands: ws.map((w) => w.command),`,
      `    projects: projs.map((p) => p.name),`,
      `    testMatch: proj ? proj.testMatch : null,`,
      `    env: { offline: process.env.P2D_OFFLINE_CHAT ?? null, real: process.env.P2D_LIVE_REAL ?? null,`,
      `      livePrep: process.env.P2D_LIVE_PREP ?? null, browser: process.env.P2D_BROWSER ?? null,`,
      `      secret: process.env.P2D_PROBE_SECRET ?? null, alias: process.env.OPENCODE_GO ?? null,`,
      `      target: process.env.OPENCODE_GO_API_KEY ?? null, nodeOpts: process.env.NODE_OPTIONS ?? null },`,
      `  }));`,
      `})().catch((e) => { console.error(String((e && e.message) || e)); process.exitCode = 1; });`,
    ].join("\n");
    const env = { ...process.env, ...extraEnv };
    for (const key of ["P2D_LIVE_PREP", "P2D_OFFLINE_CHAT", "P2D_LIVE_REAL"]) {
      if (!(key in extraEnv)) delete env[key];
    }
    const res = spawnSync(process.execPath, [TSX_CLI, "-e", probe], {
      encoding: "utf8",
      timeout: 60000,
      env,
    });
    assert.equal(res.status, 0, String(res.stderr).slice(0, 500));
    return JSON.parse(String(res.stdout).trim());
  }

  it("P2D_OFFLINE_CHAT=1: only stack + Next dev, offline spec, credentials scrubbed", () => {
    const snap = configSnapshot({
      P2D_BROWSER: "1",
      P2D_OFFLINE_CHAT: "1",
      P2D_PROBE_SECRET: "test-dummy-probe-secret",
      OPENCODE_GO: DUMMY_REAL,
      OPENCODE_GO_API_KEY: DUMMY_REAL,
      NODE_OPTIONS: "--inspect",
    });
    assert.equal(snap.commands.length, 2);
    assert.match(snap.commands[0], /p2d-browser-stack/);
    assert.match(snap.commands[1], /next dev/);
    assert.deepEqual(snap.projects, ["p2d-synthetic"]);
    assert.equal(snap.testMatch, "**/p2d/p2d-live-offline.spec.ts");
    assert.equal(snap.env.offline, "1");
    assert.equal(snap.env.real, null);
    assert.equal(snap.env.livePrep, null);
    assert.equal(snap.env.secret, null);
    assert.equal(snap.env.alias, null);
    assert.equal(snap.env.target, null);
    assert.equal(snap.env.nodeOpts, null);
  });

  it("P2D_LIVE_REAL=1: only stack + Next dev, live-real spec, credentials scrubbed", () => {
    const snap = configSnapshot({
      P2D_BROWSER: "1",
      P2D_LIVE_REAL: "1",
      P2D_PROBE_SECRET: "test-dummy-probe-secret",
      OPENCODE_GO: DUMMY_REAL,
      OPENCODE_GO_API_KEY: DUMMY_REAL,
      NODE_OPTIONS: "--inspect",
    });
    assert.equal(snap.commands.length, 2);
    assert.deepEqual(snap.projects, ["p2d-synthetic"]);
    assert.equal(snap.testMatch, "**/p2d/p2d-live-real.spec.ts");
    assert.equal(snap.env.real, "1");
    assert.equal(snap.env.offline, null);
    assert.equal(snap.env.livePrep, null);
    assert.equal(snap.env.alias, null);
    assert.equal(snap.env.target, null);
  });
});
