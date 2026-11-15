// Temporary one-shot local API/PWA/Agent acceptance smoke. Does not save cookies
// or credentials; writes are refused unless the disposable DB marker matches.
import { chromium } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const pwaOrigin = process.env.LOCAL_E2E_PWA_ORIGIN ?? "http://127.0.0.1:3000";
const pgContainer = process.env.LOCAL_E2E_PG_CONTAINER ?? "pi-local-e2e-20260924-01";
const pgDatabase = process.env.LOCAL_E2E_PG_DATABASE ?? "pi_local_e2e_20260924";
const expectedMarker = process.env.LOCAL_E2E_DB_TEST_MARKER;
if (process.env.LOCAL_E2E_ALLOW_MUTATIONS !== "1" || !expectedMarker) {
  throw new Error("Local mutations require LOCAL_E2E_ALLOW_MUTATIONS=1 and a DB marker.");
}
const origin = new URL(pwaOrigin);
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname)) {
  throw new Error("Refusing a non-loopback PWA origin.");
}
// Unique local API instance binding: in the OpenCode Go canary path the API
// launch and this smoke process share the same non-secret BUILD_ID nonce. A
// bare `gitSha=dev` is not unique across dev instances, so require the nonce
// before any invite/DB write and compare it via both routes below.
const opencodeGoOptIn = process.env.LOCAL_E2E_OPENCODE_GO === "1";
const expectedApiBuildId = (process.env.LOCAL_E2E_API_BUILD_ID ?? "").trim();
const LOCAL_E2E_API_BUILD_ID_PATTERN = /^local-e2e-[0-9a-f]{32}$/;
if (opencodeGoOptIn && !LOCAL_E2E_API_BUILD_ID_PATTERN.test(expectedApiBuildId)) {
  throw new Error("Missing or malformed LOCAL_E2E_API_BUILD_ID; refusing test writes without a unique local API instance id.");
}

const marker = execFileSync("docker", [
  "exec", pgContainer, "psql", "-U", "postgres", "-d", pgDatabase, "-Atc",
  "SELECT marker_value FROM public._test_marker LIMIT 1",
], { encoding: "utf8" }).trim();
if (marker !== expectedMarker) throw new Error("Disposable DB marker mismatch; refusing test writes.");

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
// Opt-in OpenCode Go canary: LOCAL_E2E_EMAIL may override the generated test
// email on the default path, but the OpenCode option always runs as the local
// default admin. The relay key stays in the API process env (never in this
// script) and no provider call happens unless LOCAL_E2E_OPENCODE_GO=1.
const emailOverride = (process.env.LOCAL_E2E_EMAIL ?? "").trim() || null;
if (opencodeGoOptIn && emailOverride !== null && emailOverride !== "admin@example.com") {
  throw new Error("The OpenCode Go canary path requires admin@example.com; refusing a different LOCAL_E2E_EMAIL.");
}
const email = opencodeGoOptIn ? "admin@example.com" : (emailOverride ?? `local-e2e-${suffix}@example.test`);
const password = `LocalE2E-${randomBytes(24).toString("base64url")}Aa1!`;
const accountName = `Local E2E Bank ${suffix}`;
const inviteHash = createHash("sha256").update(`local-account-invite:${suffix}`).digest("hex");
const inviteSql = `INSERT INTO account_invites (email,email_normalized,token_hash,expires_at,invited_by) VALUES ('${email}','${email}','${inviteHash}',NOW()+INTERVAL '1 day',NULL)`;
execFileSync("docker", ["exec", pgContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", pgDatabase, "-c", inviteSql], { stdio: "ignore" });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const sessionProbeAuthorization = [];
let deviceRegistrationStatus = null;
page.on("request", (request) => {
  if (new URL(request.url()).pathname.endsWith("/api/backend/auth/session")) {
    sessionProbeAuthorization.push(Boolean(request.headers()["authorization"]));
  }
});
page.on("response", (response) => {
  if (new URL(response.url()).pathname.endsWith("/api/backend/auth/devices/register")) {
    deviceRegistrationStatus = response.status();
  }
});

async function api(path, options = {}) {
  return page.evaluate(async (input) => {
    const headers = { Accept: "application/json" };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    if (input.workspaceId) headers["X-Workspace-Id"] = input.workspaceId;
    if (input.key) headers["Idempotency-Key"] = input.key;
    Object.assign(headers, input.extraHeaders ?? {});
    const response = await fetch(`/api/backend${input.path}`, {
      method: input.method ?? "GET",
      credentials: "include",
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep status */ }
    return { status: response.status, data };
  }, { path, ...options });
}

const expectStatus = (response, expected, label) => {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.status} (${response.data?.code ?? "no-code"})`);
  }
};

try {
  await page.goto(`${pwaOrigin}/`, { waitUntil: "domcontentloaded" });
  const apiHealth = await page.evaluate(async () => {
    const response = await fetch("/api/backend/health", { credentials: "include" });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, gitSha: body.gitSha, buildId: body.buildId };
  });
  expectStatus(apiHealth, 200, "PWA→local API proxy");
  if (apiHealth.gitSha !== "dev") throw new Error("API proxy is not pinned to the local development server.");
  if (opencodeGoOptIn && apiHealth.buildId !== expectedApiBuildId) {
    throw new Error("API proxy instance id mismatch; refusing any model-backed call.");
  }
  const agentHealth = await page.evaluate(async () => {
    const response = await fetch("/api/agent/health", { credentials: "include" });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, buildSha: body.buildSha };
  });
  expectStatus(agentHealth, 200, "PWA→local Agent proxy");
  if (agentHealth.buildSha !== "dev") throw new Error("Agent proxy is not pinned to the local Wrangler Worker.");
  const signup = await api("/auth/sign-up/email", {
    method: "POST", body: { email, password, name: "Local E2E" },
  });
  if (signup.status < 200 || signup.status >= 300) {
    throw new Error(`local signup failed: ${signup.status} (${signup.data?.code ?? "no-code"})`);
  }
  // A standalone account invite creates Better Auth identity only. The local
  // acceptance fixture also needs the app-level users row before workspace
  // creation; keep this test bootstrap confined to the marker-verified DB.
  const identitySql = `INSERT INTO users (auth_user_id,email,name,status,created_at) SELECT id,email,name,'active',NOW() FROM "user" WHERE lower(email)=lower('${email}') ON CONFLICT (auth_user_id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,status='active'`;
  execFileSync("docker", ["exec", pgContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", pgDatabase, "-c", identitySql], { stdio: "ignore" });
  const expectedWorkspaceName = `Local E2E ${suffix}`;
  const workspace = await api("/workspaces", {
    method: "POST", key: randomUUID(), body: { name: expectedWorkspaceName, kind: "shared" },
  });
  expectStatus(workspace, 201, "create workspace");
  const workspaceId = workspace.data.id;
  // Prove the API's POST /workspaces landed in the same marker-verified
  // disposable DB before any provider/model operation. The dev-SHA pins above
  // only prove process identity, not DB identity.
  if (typeof workspaceId !== "string" || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(workspaceId)) {
    throw new Error("workspace id is not a UUID; refusing to continue against an unverified target");
  }
  const workspaceProbe = execFileSync("docker", [
    "exec", pgContainer, "psql", "-U", "postgres", "-d", pgDatabase, "-Atc",
    `SELECT name FROM public.households WHERE id='${workspaceId}'`,
  ], { encoding: "utf8" }).trim();
  if (workspaceProbe !== expectedWorkspaceName) {
    throw new Error("API workspace is missing from the marker-verified DB; refusing any model-backed call");
  }

  expectStatus(await api("/auth/sign-out", { method: "POST" }), 200, "initial sign-out");
  expectStatus(await api("/auth/session"), 401, "session after sign-out");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" }).waitFor({ state: "visible", timeout: 15000 });
  expectStatus(await api("/auth/session"), 200, "cookie session after PWA login");

  // Opt-in OpenCode Go single-relay probe (LOCAL_E2E_OPENCODE_GO=1 only).
  // Runs after the local health sentinels (dev SHA pins above) and the admin
  // login, and only on the marker-verified disposable DB. Prepares the enabled
  // DB rows the relay allowlist resolves from, without any runtime
  // activation/rollout — direct relay does not need it, so a grounding
  // correction cannot retry the same model. Never sends, stores, or prints an
  // apiKey: the key stays in the API process env and the credential endpoint
  // is read by the `configured` boolean only (`masked` is never serialized).
  const OPENCODE_GO_PROVIDER_ID = "opencode-go";
  const OPENCODE_GO_MODEL_ID = "muse-spark-1.3-contributor";
  const OPENCODE_GO_RELAY_URL = "http://127.0.0.1:3310/internal/agent/llm-relay";
  const OPENCODE_GO_API_HEALTH_URL = "http://127.0.0.1:3310/health";
  const OPENCODE_GO_RELAY_SENTINEL = "LOCAL_E2E_RELAY_OK";
  let opencodeGoCanary = null;
  if (opencodeGoOptIn) {
    const relayAdminTokenPresent = (process.env.LOCAL_E2E_AGENT_RUNTIME_ADMIN_TOKEN ?? "").trim().length > 0;
    if (!relayAdminTokenPresent) {
      throw new Error("Missing LOCAL_E2E_AGENT_RUNTIME_ADMIN_TOKEN; refusing the single-relay probe");
    }
    const llmConfig = await api("/admin/agent/llm-config");
    expectStatus(llmConfig, 200, "read admin LLM config");
    // Refuse a second provider attempt: direct relay must not dispatch via a
    // pre-configured fallback. Check before any write, never clear silently.
    // No activate/rollout happens on this path, so the settings below can
    // only gate, never create a second attempt.
    const assertNoFallback = (config, label) => {
      const runtime = config?.data?.runtime;
      if (typeof runtime !== "object" || runtime === null) {
        throw new Error(`${label}: LLM runtime is missing; refusing a second provider attempt`);
      }
      if (
        !Object.prototype.hasOwnProperty.call(runtime, "fallbackProviderId")
        || !Object.prototype.hasOwnProperty.call(runtime, "fallbackModelId")
      ) {
        throw new Error(`${label}: fallback provider/model fields are absent; refusing a second provider attempt`);
      }
      if (runtime.fallbackProviderId !== null || runtime.fallbackModelId !== null) {
        throw new Error(`${label}: fallback provider/model is configured; refusing a second provider attempt`);
      }
    };
    assertNoFallback(llmConfig, "pre-relay LLM runtime");
    const credential = await page.evaluate(async (providerId) => {
      const response = await fetch(`/api/backend/admin/agent/llm-config/providers/${providerId}/credential`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, configured: body?.credential?.configured === true };
    }, OPENCODE_GO_PROVIDER_ID);
    expectStatus(credential, 200, "read opencode-go credential status");
    if (credential.configured !== true) {
      throw new Error("opencode-go credential is not configured; refusing the model-backed call");
    }
    const providerEntry = (llmConfig.data?.providers ?? []).find((p) => p?.id === OPENCODE_GO_PROVIDER_ID);
    if (!providerEntry) throw new Error("opencode-go provider is not registered");
    if (providerEntry.enabled !== true) {
      expectStatus(await api(`/admin/agent/llm-config/providers/${OPENCODE_GO_PROVIDER_ID}/toggle`, {
        method: "POST", body: { enabled: true },
      }), 200, "enable opencode-go provider");
    }
    let modelEntry = (llmConfig.data?.models ?? []).find(
      (m) => m?.providerId === OPENCODE_GO_PROVIDER_ID && m?.modelId === OPENCODE_GO_MODEL_ID,
    );
    if (!modelEntry) {
      const created = await api("/admin/agent/llm-config/models", {
        method: "POST",
        body: {
          providerId: OPENCODE_GO_PROVIDER_ID,
          modelId: OPENCODE_GO_MODEL_ID,
          protocol: "responses",
          privacyClass: "training_prohibited",
          enabled: true,
        },
      });
      expectStatus(created, 201, "register opencode-go model");
      modelEntry = created.data?.model;
    }
    if (modelEntry?.protocol !== "responses" || modelEntry?.privacyClass !== "training_prohibited") {
      throw new Error("opencode-go model classification mismatch; refusing to reclassify");
    }
    if (modelEntry?.enabled !== true) {
      const toggled = await api(`/admin/agent/llm-config/models/${modelEntry.id}/toggle`, {
        method: "POST", body: { enabled: true },
      });
      expectStatus(toggled, 200, "enable opencode-go model");
    }
    // Reread after the enable-only writes and assert the fallback is still
    // null before the one direct relay POST below. No activate/rollout: the
    // relay allowlist resolves from these enabled DB rows directly.
    const postEnable = await api("/admin/agent/llm-config");
    expectStatus(postEnable, 200, "reread admin LLM config");
    assertNoFallback(postEnable, "post-enable LLM runtime");
    opencodeGoCanary = {
      credentialConfigured: true,
      providerEnabled: true,
      modelEnabled: true,
      fallbackNull: true,
    };
  }

  const category = await api("/categories", {
    method: "POST", workspaceId, key: randomUUID(),
    body: { name: `Local E2E ${suffix}`, kind: "expense" },
  });
  expectStatus(category, 201, "create category");
  const accountA = await api("/accounts", {
    method: "POST", workspaceId, key: randomUUID(),
    body: { name: accountName, kind: "bank", initialBalanceCents: 12345 },
  });
  const accountB = await api("/accounts", {
    method: "POST", workspaceId, key: randomUUID(),
    body: { name: `Local E2E Cash ${suffix}`, kind: "cash", initialBalanceCents: 7500 },
  });
  expectStatus(accountA, 201, "create bank account");
  expectStatus(accountB, 201, "create cash account");

  const transactionKey = randomUUID();
  const transactionBody = {
    description: `Local E2E transaction ${suffix}`,
    amountCents: 1234,
    date: new Date().toISOString().slice(0, 10),
    categoryId: category.data.id,
    accountId: accountA.data.id,
  };
  const transaction = await api("/transactions/expense", {
    method: "POST", workspaceId, key: transactionKey, body: transactionBody,
  });
  if (transaction.status < 200 || transaction.status >= 300) {
    throw new Error(`create transaction failed: ${transaction.status} (${transaction.data?.code ?? "no-code"})`);
  }
  const replay = await api("/transactions/expense", {
    method: "POST", workspaceId, key: transactionKey, body: transactionBody,
  });
  if (replay.status < 200 || replay.status >= 300 || replay.data?.id !== transaction.data?.id) {
    throw new Error(`same-key transaction replay mismatch: ${replay.status}`);
  }

  const secondWorkspace = await api("/workspaces", {
    method: "POST", key: randomUUID(), body: { name: `Local E2E isolated ${suffix}`, kind: "shared" },
  });
  expectStatus(secondWorkspace, 201, "create second workspace");
  const isolatedRead = await api("/accounts", { workspaceId: secondWorkspace.data.id });
  expectStatus(isolatedRead, 200, "read second workspace");
  if (isolatedRead.data?.total !== 0) throw new Error("cross-workspace isolation failed");

  const deviceToken = await page.evaluate(() => localStorage.getItem("pi-finance:token"));
  const connection = await api("/auth/agent-token", {
    method: "POST", workspaceId,
    ...(deviceToken ? { extraHeaders: { "x-device-token": deviceToken } } : {}),
  });
  expectStatus(connection, 200, "mint Agent connection token");
  // Deterministic Agent smoke branches (mutually exclusive):
  // - Default path (LOCAL_E2E_OPENCODE_GO !== '1'): exactly one /rpc/chat turn.
  // - Opt-in path (LOCAL_E2E_OPENCODE_GO === '1'): NO /rpc/chat at all; exactly
  //   one direct POST to the internal relay below (one upstream attempt, no
  //   fallback, retry, or correction).
  let agent = null;
  const agentPrompt = `Qual é o saldo da conta ${accountName}?`;
  const agentExpectedText = accountName;
  if (!opencodeGoOptIn) {
    agent = await page.evaluate(async ({ workspaceId, token, intentionId, prompt }) => {
      const response = await fetch(`/api/agent/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/chat`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId, "x-agent-connection-token": token },
        body: JSON.stringify({ text: prompt, intentionId }),
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    }, { workspaceId, token: connection.data.token, intentionId: randomUUID(), prompt: agentPrompt });
  }

  // Opt-in single direct relay probe: exactly one POST from Node (process-only
  // admin token, never into the browser context) to the loopback internal
  // relay — the exact endpoint the Agent uses. Reports only HTTP status,
  // provider/model identifiers, and a sentinel boolean; never body text, IDs,
  // tokens, or credentials.
  if (opencodeGoOptIn) {
    const relayAdminToken = (process.env.LOCAL_E2E_AGENT_RUNTIME_ADMIN_TOKEN ?? "").trim();
    if (!relayAdminToken) {
      throw new Error("Missing LOCAL_E2E_AGENT_RUNTIME_ADMIN_TOKEN; refusing the single-relay probe");
    }
    // Direct origin proof for the exact relay target below: the PWA-proxy
    // check plus the marker/workspace row check prove the proxied path, so
    // prove the loopback API origin itself before the one direct POST. Both
    // routes must carry the same unique instance id; `gitSha=dev` alone is
    // not unique across dev instances on port 3310.
    const directApiHealthResponse = await fetch(OPENCODE_GO_API_HEALTH_URL, {
      method: "GET",
      redirect: "manual",
    });
    if (directApiHealthResponse.status !== 200) {
      throw new Error(`direct API origin health failed: ${directApiHealthResponse.status}`);
    }
    const directApiHealthBody = await directApiHealthResponse.json().catch(() => ({}));
    if (directApiHealthBody?.gitSha !== "dev") {
      throw new Error("Direct API origin is not pinned to the local development server.");
    }
    if (directApiHealthBody?.buildId !== expectedApiBuildId) {
      throw new Error("Direct API origin instance id mismatch; refusing the relay POST.");
    }
    const relayResponse = await fetch(OPENCODE_GO_RELAY_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "x-agent-runtime-admin-token": relayAdminToken },
      body: JSON.stringify({
        provider: OPENCODE_GO_PROVIDER_ID,
        model: OPENCODE_GO_MODEL_ID,
        prompt: `Reply with exactly ${OPENCODE_GO_RELAY_SENTINEL} and nothing else. Synthetic local smoke probe.`,
        system: "You are a local synthetic smoke probe. Reply with the requested sentinel verbatim.",
      }),
    });
    if (relayResponse.status >= 300 && relayResponse.status < 400) {
      throw new Error(`opencode-go single-relay probe redirected: ${relayResponse.status}; refusing to follow`);
    }
    const relayBody = await relayResponse.json().catch(() => ({}));
    const relayText = typeof relayBody?.text === "string" ? relayBody.text : "";
    opencodeGoCanary = {
      ...opencodeGoCanary,
      provider: OPENCODE_GO_PROVIDER_ID,
      model: OPENCODE_GO_MODEL_ID,
      relayStatus: relayResponse.status,
      sentinelPresent: relayText.includes(OPENCODE_GO_RELAY_SENTINEL),
      singleAttempt: true,
    };
    if (relayResponse.status !== 200 || opencodeGoCanary.sentinelPresent !== true) {
      throw new Error(`opencode-go single-relay probe failed: ${relayResponse.status}`);
    }
  }

  expectStatus(await api("/auth/sign-out", { method: "POST" }), 200, "final sign-out");
  expectStatus(await api("/auth/session"), 401, "session after final sign-out");
  const result = {
    signup: signup.status,
    workspace: workspace.status,
    PWAUiLogin: 200,
    cookieOnlySession: !sessionProbeAuthorization.some(Boolean),
    deviceRegistrationStatus,
    legacyDeviceBearerPersisted: Boolean(deviceToken),
    accounts: [accountA.status, accountB.status],
    transaction: transaction.status,
    sameKeyReplay: replay.data?.id === transaction.data?.id,
    crossWorkspaceIsolation: isolatedRead.data?.total === 0,
    localAgent: opencodeGoOptIn ? null : agent.status,
    agentCompleted: opencodeGoOptIn ? null : agent.body?.status === "completed",
    agentGrounded: opencodeGoOptIn ? null : typeof agent.body?.output === "string" && agent.body.output.includes(agentExpectedText),
    agentOutputPreview: opencodeGoOptIn ? null : (typeof agent.body?.output === "string" ? agent.body.output.slice(0, 160) : null),
    opencodeGoCanary,
    logoutThen401: true,
  };
  console.log(JSON.stringify(result));
  if (!result.cookieOnlySession) throw new Error("session probe used a legacy Authorization header");
  if (deviceRegistrationStatus !== 201) throw new Error(`device registration status: ${deviceRegistrationStatus}`);
  if (!result.sameKeyReplay || !result.crossWorkspaceIsolation) throw new Error("idempotency or workspace isolation failed");
  if (!opencodeGoOptIn && (agent.status !== 200 || agent.body?.status !== "completed" || !result.agentGrounded)) {
    throw new Error(`local Agent turn failed: ${agent.status} (${agent.body?.code ?? "no-code"})`);
  }
} finally {
  await browser.close();
}
