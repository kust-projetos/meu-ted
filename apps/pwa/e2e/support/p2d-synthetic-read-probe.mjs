// P2D synthetic-read probe — runs ONLY as a dedicated subprocess (spawned by
// e2e/support/route.p2d-synthetic-read.test.tsx, one process). Never imported by the suite
// process: env mutation (setupIsolation scrub) and the OpenCode boot stay
// inside this child, so the parent session's cwd/env are untouched.
//
// Usage:
//   node p2d-synthetic-read-probe.mjs serve
// with P2D_CONFIG_JSON env:
//   { root, identity, apiBaseUrl, tedRuntimeDir,
//     stub: { toolSequence: [{name,args}...], expectedAccounts, expectedOracle } }
//   (two-tool sequence: list_accounts + get_month_summary in ONE admitted
//   conversation; legacy single-tool { toolName, toolArgs, expectedOracle }
//   still accepted) — the stub derives its final text from the observed
//   tool-result DTOs (each validated independently).
//   -> { ok, phase:'serve-ready', base, ... } (real path — manual SDK boot +
//      real conversation store + real loopback gateway + real
//      createPromptHost + real resolveGatewayIdentity against the parent's
//      in-memory API over loopback; real `session.prompt` via a LOCAL
//      scripted OpenAI-compatible stub, zero paid/external inference; the
//      stub derives its final text from the observed tool-result DTO).
// stdin lines:
//   'stats'           -> { phase:'serve-stats', promptCalls, transportCalls,
//                          messageLists, stubTurns, offeredTools, stubRemotes,
//                          stubMismatches, fetchBlockedCatalog,
//                          fetchBlockedUnexpected, fetchAllowedLoopback,
//                          stubUrlCounts,
//                          financeReads: [{ route, method, statusCode, body }] }
//   'fail-provider'   -> stub returns HTTP 500 for completions from now on
//   'recover-provider'-> stub resumes the scripted tool_call/derived-text flow
//   'close'           -> orderly close ({ phase:'serve-closed', ...counters })
//
// Test-only observation seams (declared): promptCalls/messageLists counters
// wrap the REAL 2.2.4 SDK (no behavior change); the finance transport is the
// REAL HttpFinanceTransport pointed at the parent's loopback API, wrapped only
// to count calls and record read DTOs; the provider is a LOCAL scripted stub
// (dummy apiKey). The gateway identity path is fully real (Better-Auth
// session + device + agent-token against the in-memory API).
//
// LIMITS (declared, not hidden): in offline/synthetic the provider is
// scripted, so success there is NOT an external-model proof and
// `READ_SLICE_PASS` remains NOT ACHIEVED. Egress posture is narrow and
// honest: offline/synthetic only reach the local loopback stub (dummy apiKey)
// and any other non-loopback `fetch` is blocked pre-socket by fixed category.
// live-real uses the same `fetch` seam as an allowlist-only guard
// ("live-real-allowlist"): catalog GET on models.opencode.ai (no
// Authorization) and `https://opencode.ai/inference/go/...`, forced manual
// redirects failing closed, everything else blocked pre-socket. Only
// categories/counts/statuses are recorded (no URL/body/header values). None
// of this is a general OS-level egress sandbox — raw `node:http`/`net`/`tls`
// sockets are not intercepted. Temp dirs come from the parent (approved
// folder); nothing is deleted. NO process.exit before finally: success
// returns NATURALLY after the awaited close(), so orderly shutdown + sqlite
// persistence are proven, not skipped.
//
// Credential boundary (live-real ONLY): native OpenCode 2.2.4 resolves the
// `opencode-go` provider from OPENCODE_API_KEY, so THIS child translates the
// preserved OPENCODE_GO_API_KEY alias into the native key after
// `setupIsolation` and before the SDK import (alias removed, only the native
// key survives). The prep path and the product bootstrap are untouched: they
// preserve the alias only and never translate it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { LIVE_REAL_FETCH_GUARD, createLiveRealFetchGuard } from "./p2d-fetch-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const requireFromHere = createRequire(import.meta.url);
const {
  OFFLINE_DUMMY_KEY,
  applyLiveRealCredentialAlias,
  buildOfflineProviderConfig,
  loadLiveModelSelector,
  loadRuntimeCredentialForMode,
} = requireFromHere("./p2d-live-credential.cjs");

const RAW_CONFIG = process.env.P2D_CONFIG_JSON;
if (!RAW_CONFIG) {
  console.error(JSON.stringify({ ok: false, phase: "serve-ready", error: "P2D_CONFIG_JSON is required" }));
  process.exit(1);
}
const CONFIG = JSON.parse(RAW_CONFIG);
const { root, identity, apiBaseUrl, tedRuntimeDir, stub } = CONFIG;

// Runtime modes (test-only):
// - synthetic (default, unchanged): product test profile + fixture provider;
// - offline: product `live` profile + exact provider/model from live-model.json,
//   pointed at the loopback stub with a dummy key;
// - live-real: product `live` profile + native provider/model; the credential
//   is loaded by THIS child from the allowlisted local .env, supplied as the
//   preserved alias and translated to the native OPENCODE_API_KEY after
//   isolation (never written to config/log/evidence).
let MODE = typeof CONFIG.mode === "string" ? CONFIG.mode : "synthetic";
const PROFILE = MODE === "synthetic" ? "test" : CONFIG.profile;
const PROVIDER = MODE === "synthetic" ? "p2dloop" : CONFIG.provider;
const MODEL = MODE === "synthetic" ? "test-alpha" : CONFIG.model;
const CREDENTIAL_SOURCE = MODE === "synthetic" ? "none" : CONFIG.credentialSource;
const LIVE_MODE = MODE === "offline" || MODE === "live-real";

class ProbeFail extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
    this.detail = String(detail ?? "").slice(0, 800);
  }
}
const fail = (step, detail) => { throw new ProbeFail(step, detail); };

const emit = (obj) => console.log(JSON.stringify(obj));

let tedEnv = null;
let gateway = null;
let stubServer = null;
const ctl = { failProvider: false };

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function toolCallEvents({ callId, name, args, model }) {
  const base = {
    id: "chatcmpl-p2d", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, error: null,
  };
  return (
    sseChunk({
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: "assistant", content: null,
          tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    })
    + sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    + "data: [DONE]\n\n"
  );
}

function finalTextEvents(text, model) {
  const base = {
    id: "chatcmpl-p2d", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, error: null,
  };
  return (
    sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })
    + sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + "data: [DONE]\n\n"
  );
}

// DTO → provider-context derivation (test-only, deterministic, local).
// The stub parses the ACTUAL finance tool results from the SDK's follow-up
// requests, validates every oracle field of EACH DTO independently, and
// generates the final output FROM those observed values — never a hardcoded
// string. A mismatch fails the turn closed (HTTP 500) and is recorded in
// stubMismatches; request bodies are never logged, only key shapes on
// mismatch.
//
// Two modes (config-driven):
// - legacy single-tool: stub { toolName, toolArgs, expectedOracle } —
//   summary-only derivation (preserved for backward compatibility);
// - two-tool sequence: stub { toolSequence: [{name,args}...],
//   expectedAccounts, expectedOracle } — list_accounts + get_month_summary
//   in ONE admitted conversation; the final text is derived from BOTH
//   observed DTOs (account names + June summary).
function formatCentsBRL(cents) {
  const parts = (Number(cents) / 100).toFixed(2).split(".");
  return `R$ ${parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${parts[1]}`;
}
const PT_MONTHS = {
  "01": "janeiro", "02": "fevereiro", "03": "marco", "04": "abril",
  "05": "maio", "06": "junho", "07": "julho", "08": "agosto",
  "09": "setembro", "10": "outubro", "11": "novembro", "12": "dezembro",
};
function extractToolDtos(messages) {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === "user") lastUserIdx = i;
  }
  const tools = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i] && messages[i].role === "tool") tools.push(messages[i]);
  }
  return tools.map((t) => {
    const raw = t.content;
    let parsed = raw;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); }
      catch { return { error: "tool content is not JSON", keys: [] }; }
    }
    const candidates = [parsed];
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const k of ["output", "result", "body", "data"]) {
        if (parsed[k] && typeof parsed[k] === "object") candidates.push(parsed[k]);
      }
    }
    return { candidates };
  });
}

function classifyDto(candidates) {
  for (const c of candidates) {
    if (
      c && typeof c === "object" && !Array.isArray(c) &&
      Array.isArray(c.items) &&
      Number.isSafeInteger(c.total)
    ) {
      return { kind: "accounts", dto: c };
    }
  }
  for (const c of candidates) {
    if (
      c && typeof c === "object" && !Array.isArray(c) &&
      typeof c.yearMonth === "string" &&
      Number.isFinite(Number(c.incomeCents)) &&
      Number.isFinite(Number(c.expenseCents)) &&
      Number.isFinite(Number(c.balanceCents)) &&
      Number.isFinite(Number(c.transactionCount))
    ) {
      return { kind: "summary", dto: c };
    }
  }
  const first = candidates[0];
  return {
    kind: "unknown",
    mismatch: "tool DTO shape diverged",
    keys: first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first).slice(0, 20) : [],
  };
}

function validateAccountsDto(dto, expected) {
  if (!Array.isArray(dto.items)) return { mismatch: "accounts items must be an array" };
  if (!Number.isSafeInteger(dto.total) || dto.total < 0) {
    return { mismatch: "accounts total must be a non-negative safe integer" };
  }
  if (dto.items.length !== Number(expected.total)) {
    return { mismatch: `accounts total diverged (got ${dto.items.length}, want ${expected.total})` };
  }
  const observed = dto.items.map((a) => (a && typeof a.name === "string" ? a.name : "")).sort();
  const wanted = [...expected.names].sort();
  if (observed.length !== wanted.length || observed.some((n, i) => n !== wanted[i])) {
    return { mismatch: `accounts names diverged (got [${observed.join("|")}])` };
  }
  return { dto };
}

function validateSummaryDto(dto, expected) {
  for (const k of ["yearMonth", "incomeCents", "expenseCents", "balanceCents", "transactionCount"]) {
    if (String(dto[k]) !== String(expected[k])) {
      return { mismatch: `oracle field ${k} diverged` };
    }
  }
  return { dto };
}

function deriveCombinedText(accountsDto, summaryDto) {
  const names = accountsDto.items.map((a) => a.name).sort();
  const ym = String(summaryDto.yearMonth);
  const monthName = PT_MONTHS[ym.slice(5, 7)] || ym.slice(5, 7);
  return {
    text:
      `SINTESE SINTETICA P2D ${monthName} ${ym.slice(0, 4)} — contas ${names.join(", ")}` +
      ` (${Number(accountsDto.total)} contas)` +
      ` — gastos ${formatCentsBRL(summaryDto.expenseCents)}` +
      ` em ${Number(summaryDto.transactionCount)} transacoes (receitas ${formatCentsBRL(summaryDto.incomeCents)}` +
      `, saldo ${formatCentsBRL(summaryDto.balanceCents)}) — sem inferencia externa, sem rede`,
  };
}

function extractDto(messages) {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === "user") lastUserIdx = i;
  }
  const tools = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i] && messages[i].role === "tool") tools.push(messages[i]);
  }
  if (tools.length === 0) return null;
  const raw = tools[tools.length - 1].content;
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); }
    catch { return { mismatch: "tool content is not JSON", keys: [] }; }
  }
  const candidates = [parsed];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const k of ["output", "result", "body", "data"]) {
      if (parsed[k] && typeof parsed[k] === "object") candidates.push(parsed[k]);
    }
  }
  for (const c of candidates) {
    if (
      c && typeof c === "object" && !Array.isArray(c) &&
      typeof c.yearMonth === "string" &&
      Number.isFinite(Number(c.incomeCents)) &&
      Number.isFinite(Number(c.expenseCents)) &&
      Number.isFinite(Number(c.balanceCents)) &&
      Number.isFinite(Number(c.transactionCount))
    ) {
      return { dto: c };
    }
  }
  return {
    mismatch: "tool DTO shape diverged",
    keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 20) : [],
  };
}
function deriveFinalText(dto, expected) {
  for (const k of ["yearMonth", "incomeCents", "expenseCents", "balanceCents", "transactionCount"]) {
    if (String(dto[k]) !== String(expected[k])) {
      return { mismatch: `oracle field ${k} diverged` };
    }
  }
  const ym = String(dto.yearMonth);
  const monthName = PT_MONTHS[ym.slice(5, 7)] || ym.slice(5, 7);
  return {
    text:
      `SINTESE SINTETICA P2D ${monthName} ${ym.slice(0, 4)} — gastos ${formatCentsBRL(dto.expenseCents)}` +
      ` em ${Number(dto.transactionCount)} transacoes (receitas ${formatCentsBRL(dto.incomeCents)}` +
      `, saldo ${formatCentsBRL(dto.balanceCents)}) — sem inferencia externa, sem rede`,
  };
}

try {
  if (!root || typeof root !== "string") fail("args", "root is required");
  if (!apiBaseUrl || typeof apiBaseUrl !== "string") fail("args", "apiBaseUrl is required");
  if (!tedRuntimeDir || typeof tedRuntimeDir !== "string") fail("args", "tedRuntimeDir is required");
  if (MODE !== "synthetic" && MODE !== "offline" && MODE !== "live-real") {
    fail("args", "mode must be synthetic|offline|live-real");
  }
  if (LIVE_MODE) {
    if (PROFILE !== "live") fail("args", "live modes require profile live");
    if (PROVIDER !== "opencode-go") fail("args", "live modes require provider opencode-go");
    if (typeof MODEL !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(MODEL)) {
      fail("args", "model must be provider/model");
    }
    if (MODE === "offline" && CREDENTIAL_SOURCE !== "dummy") {
      fail("args", "offline mode requires credentialSource dummy");
    }
    if (MODE === "live-real" && CREDENTIAL_SOURCE !== "allowlist") {
      fail("args", "live-real mode requires credentialSource allowlist");
    }
  }
  // Two stub modes (test-only): legacy single-tool
  // { toolName, toolArgs, expectedOracle } or two-tool sequence
  // { toolSequence: [{name,args}...], expectedAccounts, expectedOracle }.
  // P3 proposal mode: { mode: "expense"|"income", toolName, toolArgs } emits
  // the proposal tool call once, then a final text after the tool result.
  // live-real has NO stub: the real model chooses its own tools.
  let STUB_MODE = null;
  let SEQUENCE = null;
  let EXPECTED_ACCOUNTS = null;
  let EXPECTED_ORACLE = null;
  if (MODE !== "live-real") {
    if (!stub || typeof stub !== "object" || Array.isArray(stub)) {
      fail("args", "stub is required for synthetic/offline modes");
    }
    STUB_MODE =
      stub.mode === "expense" || stub.mode === "income" || stub.mode === "card" || stub.mode === "transfer" || stub.mode === "statement"
      ? "proposal"
      : Array.isArray(stub.toolSequence) && stub.toolSequence.length > 0
        ? "sequence"
        : "legacy";
    if (STUB_MODE === "proposal") {
      if (
        stub.toolName !== "propose_expense" &&
        stub.toolName !== "propose_income" &&
        stub.toolName !== "propose_card_purchase" &&
        stub.toolName !== "propose_transfer" &&
        stub.toolName !== "propose_statement_payment"
      ) {
        fail(
          "args",
          "proposal stub requires toolName propose_expense|propose_income|propose_card_purchase|propose_transfer|propose_statement_payment",
        );
      }
      if (!stub.toolArgs || typeof stub.toolArgs !== "object" || Array.isArray(stub.toolArgs)) {
        fail("args", "proposal stub requires toolArgs");
      }
    } else {
      if (MODE === "offline" && STUB_MODE !== "sequence") {
        fail("args", "offline mode requires stub.toolSequence");
      }
      if (STUB_MODE === "sequence") {
        for (const step of stub.toolSequence) {
          if (!step || typeof step.name !== "string" || step.name.length === 0) {
            fail("args", "stub.toolSequence entries require { name, args }");
          }
        }
        SEQUENCE = stub.toolSequence.map((s) => ({ name: s.name, args: s.args || {} }));
        EXPECTED_ACCOUNTS = stub.expectedAccounts || null;
        if (!EXPECTED_ACCOUNTS || !Array.isArray(EXPECTED_ACCOUNTS.names) || !Number.isSafeInteger(EXPECTED_ACCOUNTS.total)) {
          fail("args", "stub.expectedAccounts { names[], total } is required in sequence mode");
        }
      } else if (typeof stub.toolName !== "string") {
        fail("args", "stub { toolName, toolArgs, expectedOracle } is required");
      }
      EXPECTED_ORACLE = stub.expectedOracle || null;
      if (!EXPECTED_ORACLE || typeof EXPECTED_ORACLE.yearMonth !== "string") {
        fail("args", "stub.expectedOracle { yearMonth, incomeCents, expenseCents, balanceCents, transactionCount } is required");
      }
    }
  }
  if (new URL(apiBaseUrl).hostname !== "127.0.0.1") fail("args", "apiBaseUrl must be loopback");

  // Dedicated process: resolving the SDK + provider packages from the
  // ted-runtime workspace (same as the runtime's own test runs). The parent
  // spawns this child with an unrelated cwd; chdir here is process-local.
  process.chdir(tedRuntimeDir);

  // Loopback-only fetch interposition (same precedent as the prompt-loop
  // proof) — NOT an OS/network-namespace sandbox: it intercepts
  // `globalThis.fetch` calls only and does not cover arbitrary
  // `node:http`/`net`/`tls` sockets. What it does prove: (a) the configured
  // provider endpoint is the local loopback stub only (dummy apiKey), (b)
  // unexpected non-loopback fetch calls are blocked pre-socket (throw before
  // any network I/O) and counted by fixed category, (c) completed fetches
  // are counted separately. Blocked attempts are recorded as fixed safe
  // counters only (`sdk_catalog` = known SDK housekeeping,
  // `unexpected_non_loopback` = anything else) — no URL/host text is
  // stored, returned, or logged.
  // Known SDK housekeeping (blocked pre-socket, zero egress): the model
  // catalog and the console config probe. Anything else non-loopback is an
  // unexpected destination and fails the offline proof's expectations.
  const BLOCKED_CATALOG_RE =
    /^GET https:\/\/(?:models\.opencode\.ai\/|opencode\.ai\/console\/api\/v2\/config(?:\?|$))/;
  const realFetch = globalThis.fetch;
  let fetchAllowedLoopback = 0;
  let fetchBlockedCatalog = 0;
  let fetchBlockedUnexpected = 0;
  // Offline/synthetic: loopback-only guard. live-real: the SAME fetch seam
  // becomes an allowlist-only guard ("live-real-allowlist") for the two
  // official destinations — catalog GET (no Authorization) and
  // `https://opencode.ai/inference/go/...` — with forced manual redirects
  // that fail closed. It blocks every other destination before any socket is
  // opened and records only categories/counts/statuses (never URL/body/
  // header values). This is still NOT an OS-level sandbox (raw
  // node:http/net/tls sockets are out of scope); it is the only egress
  // surface the SDK provider uses.
  let liveRealGuard = null;
  if (MODE === "live-real") {
    // Model pin: the expected inference model id is resolved from the
    // repo-owned live-model.json (the same file the stack/PWA read), and
    // CONFIG.model must be exactly that selector — a divergent config fails
    // closed before the guard (and the credential) exists.
    const pinnedModel = loadLiveModelSelector();
    if (pinnedModel !== MODEL) {
      fail("fetch-guard", "live-real model diverged from live-model.json");
    }
    const expectedModelID = pinnedModel.split("/")[1];
    // `apiOrigin` is the EXACT synthetic API origin from CONFIG — the guard
    // admits only that literal loopback origin for the four contract pairs
    // the runtime already sends (`resolveGatewayIdentity` + the finance
    // transport). No generic localhost/::1/other-port release, no write.
    const guard = createLiveRealFetchGuard({
      fetchImpl: realFetch,
      apiOrigin: apiBaseUrl,
      expectedModelID,
    });
    globalThis.fetch = guard.fetch;
    // The guard MUST be installed BEFORE the SDK import below: the SDK/
    // provider resolves `globalThis.fetch` lazily at request time, so a late
    // install would let the first inference POST (and the credential) through
    // unguarded. Verified structurally here, not assumed.
    if (globalThis.fetch !== guard.fetch) {
      fail("fetch-guard", "live-real fetch guard is not installed before the SDK import");
    }
    liveRealGuard = guard.stats;
  } else {
    globalThis.fetch = async (url, init) => {
      let s = "";
      try { s = String(url && url.url ? url.url : url); } catch { s = String(url); }
      let hostname = "";
      try { hostname = new URL(s).hostname; } catch { hostname = ""; }
      if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
        fetchAllowedLoopback++;
        return realFetch(url, init);
      }
      const method = String((init && init.method) || "GET").toUpperCase();
      if (BLOCKED_CATALOG_RE.test(`${method} ${s}`)) fetchBlockedCatalog++;
      else fetchBlockedUnexpected++;
      throw new Error("guard: non-loopback fetch blocked in the P2D proof (zero external inference)");
    };
  }

  // Credential handling (live-real ONLY): this child loads the allowlisted
  // alias value and supplies it to the runtime as OPENCODE_GO_API_KEY — the
  // ONE variable the `live` profile preserves. setupIsolation scrubs the
  // inherited env FIRST (an ambient OPENCODE_API_KEY never survives); the
  // native-key translation happens AFTER isolation, below, on this path only.
  // Offline needs no env credential at all: the loopback provider carries the
  // dummy apiKey in the composed config. The value is never written to
  // config/log/evidence.
  if (MODE === "live-real") {
    const credential = loadRuntimeCredentialForMode({ mode: MODE, rootDir: REPO_ROOT });
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_GO;
    delete process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_GO_API_KEY = credential.value;
  }

  const { pathToFileURL } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const mod = (rel) => import(pathToFileURL(`${tedRuntimeDir}/${rel}`).href);
  const { setupIsolation, tedConfig, writeTedConfig } = await mod("src/bootstrap.mjs");
  const { wirePlugin } = await mod("src/bootstrap.mjs");
  const { defineTedFinancePlugin } = await mod("src/plugin.mjs");
  const { HttpFinanceTransport } = await mod("src/transport.mjs");
  const { resolveGatewayIdentity } = await mod("src/gateway.mjs");
  const { createConversationStore } = await mod("src/conversations.mjs");
  const { createGatewayServer } = await mod("src/server.mjs");
  const { bindSession, revokeSession, getBinding, isSameHost, rotateSessionBinding } =
    await mod("src/session-bindings.mjs");
  const { createPromptHost } = await mod("src/prompt.mjs");

  // P2D browser stack may pin the gateway to a fixed loopback port so the
  // Next process can proxy to it without a rendezvous file (default:
  // ephemeral, as in the route-level proof).
  const GATEWAY_PORT = Number(process.env.P2D_GATEWAY_PORT || 0);
  const FIXTURE_PROVIDER = MODE === "synthetic" ? "p2dloop" : PROVIDER;
  const FIXTURE_MODEL = MODE === "synthetic" ? "test-alpha" : String(MODEL).split("/")[1];
  const FIXTURE_PACKAGE = "@opencode/ai/providers/openai-compatible";

  // Isolation FIRST — the SDK import below must observe the isolated roots.
  // Profile live is explicit for both live modes; synthetic keeps the default
  // test profile exactly as before. The live profile scrubs the inherited env
  // and preserves ONLY the alias OPENCODE_GO_API_KEY (an ambient
  // OPENCODE_API_KEY never survives).
  const iso = setupIsolation(root, identity || "p2d", LIVE_MODE ? "live" : undefined);
  // Native credential translation — P2D live-real ONLY, after isolation and
  // before the SDK import: native OpenCode 2.2.4 resolves `opencode-go` from
  // OPENCODE_API_KEY, so the preserved alias is copied to the native key and
  // then removed, leaving only the native key in this child's env. The product
  // bootstrap is untouched (the prep path keeps the alias only). Offline has
  // no env credential: its dummy apiKey lives in the composed provider config,
  // observed below. `credentialPresent` is OBSERVED in both modes, never
  // hardcoded.
  let credentialPresent = false;
  if (MODE === "live-real") {
    credentialPresent = applyLiveRealCredentialAlias(process.env);
  }

  // Local scripted provider stub (loopback only, dummy apiKey). Serves the
  // canned tool_call until the tool-result turn arrives, then final text.
  // `failProvider` flips completions to HTTP 500 (typed provider failure).
  const chatRequests = [];
  const chatModels = [];
  const stubRemotes = [];
  const stubMismatches = [];
  let callSeq = 0;
  let stubUrl = null;
  const http = await import("node:http");
  if (MODE !== "live-real") {
  stubServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const remote = req.socket && req.socket.remoteAddress;
      if (req.method === "POST") {
        stubRemotes.push(remote);
        let body = null;
        try { body = JSON.parse(raw); } catch { body = { _parseError: raw.slice(0, 200) }; }
        chatRequests.push({ url: req.url, remote, body });
        // Provider selection proof (offline): every loopback POST must carry
        // the exact modelID from live-model.json. The request model is
        // metadata (never the prompt/URL/credential); a mismatch fails the
        // turn closed instead of silently accepting a different model.
        const observedModel = body && typeof body.model === "string" ? body.model : null;
        chatModels.push(observedModel);
        if (MODE === "offline" && observedModel !== FIXTURE_MODEL) {
          stubMismatches.push("provider body.model diverged from live-model.json");
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "synthetic model mismatch (test-only)", type: "server_error" } }));
          return;
        }
        if (ctl.failProvider) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "synthetic provider failure (test-only)", type: "server_error" } }));
          return;
        }
        const messages = body && Array.isArray(body.messages) ? body.messages : [];
        // The request carries full history. Legacy mode: `extractDto`
        // finds the tool result after the LAST user message (null = no tool
        // result yet). Sequence mode: every tool result after the LAST user
        // message is classified (accounts vs summary) and validated
        // INDEPENDENTLY; the next missing tool is offered, and the final
        // text is derived from BOTH observed DTOs only when both validate.
        let payload = null;
        if (STUB_MODE === "proposal") {
          // One proposal tool call per user turn; after the SDK returns the
          // tool result, finish with a deterministic text. The intent itself
          // is attached by the gateway, never derived from this text.
          const toolResults = extractToolDtos(messages);
          if (toolResults.length === 0) {
            payload = toolCallEvents({
              callId: `call_p2d_${++callSeq}`,
              name: stub.toolName,
              args: stub.toolArgs || {},
              model: FIXTURE_MODEL,
            });
          } else {
            payload = finalTextEvents(
              stub.toolName === "propose_income"
                ? "Proposta de receita preparada."
                : stub.toolName === "propose_card_purchase"
                  ? "Proposta de compra no cartão preparada."
                : stub.toolName === "propose_transfer"
                  ? "Proposta de transferência preparada."
                  : stub.toolName === "propose_statement_payment"
                    ? "Proposta de pagamento de fatura preparada."
                    : "Proposta de despesa preparada.",
              FIXTURE_MODEL,
            );
          }
        } else if (STUB_MODE === "sequence") {
          const parsed = extractToolDtos(messages);
          let accountsDto = null;
          let summaryDto = null;
          for (const p of parsed) {
            if (p.error) {
              stubMismatches.push(p.error);
              continue;
            }
            const cls = classifyDto(p.candidates);
            if (cls.kind === "accounts") {
              const v = validateAccountsDto(cls.dto, EXPECTED_ACCOUNTS);
              if (v.dto) accountsDto = v.dto;
              else stubMismatches.push(v.mismatch);
            } else if (cls.kind === "summary") {
              const v = validateSummaryDto(cls.dto, EXPECTED_ORACLE);
              if (v.dto) summaryDto = v.dto;
              else stubMismatches.push(v.mismatch);
            } else {
              stubMismatches.push(cls.mismatch + (cls.keys && cls.keys.length > 0 ? ` keys=[${cls.keys.join(",")}]` : ""));
            }
          }
          if (stubMismatches.length === 0) {
            if (accountsDto && summaryDto) {
              const derived = deriveCombinedText(accountsDto, summaryDto);
              payload = finalTextEvents(derived.text, FIXTURE_MODEL);
            } else {
              const next = !accountsDto
                ? SEQUENCE.find((s) => s.name === "list_accounts") || SEQUENCE[0]
                : SEQUENCE.find((s) => s.name === "get_month_summary") || SEQUENCE[SEQUENCE.length - 1];
              payload = toolCallEvents({ callId: `call_p2d_${++callSeq}`, name: next.name, args: next.args || {}, model: FIXTURE_MODEL });
            }
          }
        } else {
          const extracted = extractDto(messages);
          if (extracted === null) {
            payload = toolCallEvents({ callId: `call_p2d_${++callSeq}`, name: stub.toolName, args: stub.toolArgs || {}, model: FIXTURE_MODEL });
          } else if (extracted.dto) {
            const derived = deriveFinalText(extracted.dto, EXPECTED_ORACLE);
            if (derived.text) {
              payload = finalTextEvents(derived.text, FIXTURE_MODEL);
            } else {
              stubMismatches.push(derived.mismatch);
            }
          } else {
            stubMismatches.push(extracted.mismatch + (extracted.keys && extracted.keys.length > 0 ? ` keys=[${extracted.keys.join(",")}]` : ""));
          }
        }
        if (payload === null) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "synthetic oracle mismatch (test-only)", type: "server_error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.end(payload);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve, reject) => {
    stubServer.once("error", reject);
    stubServer.listen(0, "127.0.0.1", resolve);
  });
  const stubPort = stubServer.address().port;
  stubUrl = `http://127.0.0.1:${stubPort}/v1`;
  }

  // Test-only opencode.json: product base + scripted fixture provider +
  // test-only provider.use allow AFTER the deny-all (same pattern as the
  // prompt-loop proof; tedConfig() product code is NOT modified).
  // - synthetic: test profile + fixture provider (unchanged);
  // - offline: live profile + exact opencode-go provider/model pointed at the
  //   loopback stub with the dummy key;
  // - live-real: the product live config exactly (credential stays in env).
  const fs = await import("node:fs");
  const p3Writes = process.env.TED_OPENCODE_P3_WRITES_ENABLED === "1";
  if (MODE === "live-real") {
    writeTedConfig(iso.dirs.config, "live", { p3Writes });
  } else {
    const base = MODE === "offline" ? tedConfig("live", { p3Writes }) : tedConfig(undefined, { p3Writes });
    const cfg = MODE === "offline"
      ? buildOfflineProviderConfig(base, {
          model: MODEL,
          baseURL: stubUrl,
          apiKey: OFFLINE_DUMMY_KEY,
        })
      : {
          ...base,
          model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
          policies: [
            ...(base.policies || []),
            { action: "provider.use", resource: FIXTURE_PROVIDER, effect: "allow" },
          ],
          providers: {
            [FIXTURE_PROVIDER]: {
              name: "P2D loopback fixture (scripted stub, dummy apiKey)",
              package: FIXTURE_PACKAGE,
              settings: { baseURL: stubUrl, apiKey: "test-fixture-not-a-secret" },
              models: {
                [FIXTURE_MODEL]: {
                  name: `Test ${FIXTURE_MODEL}`,
                  modelID: FIXTURE_MODEL,
                  capabilities: { input: ["text"], output: ["text"] },
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        };
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    fs.writeFileSync(path.join(iso.dirs.config, "opencode.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    if (MODE === "offline") {
      // Observed from the composed config, never hardcoded: the dummy apiKey in
      // `providers.opencode-go.settings` is the ONLY offline credential shape.
      credentialPresent = Boolean(cfg.providers?.[PROVIDER]?.settings?.apiKey);
    }
  }

  // Manual boot (same pattern as the prompt-loop proof): the product
  // createTedEnvironment refuses a foreign provider config by design
  // (writeTedConfig never adopts unknown catalogs), so the fixture provider
  // can only be composed here — real SDK binary, real plugin wiring.
  //
  // The SDK package exposes an import-only "." export, so the bare specifier
  // only resolves from a file under the ted-runtime workspace. This probe
  // lives under apps/pwa (write scope), hence the entry is loaded by file URL
  // derived from the package's own exports map (read-only, no install).
  const fsPkg = await import("node:fs");
  const sdkPkgPath = path.join(tedRuntimeDir, "node_modules", "@opencode", "sdk", "package.json");
  let sdkEntry = "./dist/index.js";
  try {
    const sdkPkg = JSON.parse(fsPkg.readFileSync(sdkPkgPath, "utf8"));
    if (sdkPkg && sdkPkg.exports && sdkPkg.exports["."] && typeof sdkPkg.exports["."].import === "string") {
      sdkEntry = sdkPkg.exports["."].import;
    }
  } catch (e) {
    fail("sdk-package", `cannot read @opencode/sdk exports map: ${String((e && e.message) || e).slice(0, 200)}`);
  }
  const sdk = await import(pathToFileURL(path.join(tedRuntimeDir, "node_modules", "@opencode", "sdk", sdkEntry)).href);
  if (!sdk.OpenCode || typeof sdk.OpenCode.create !== "function") {
    fail("sdk-unavailable", "bare import '@opencode/sdk' failed post-isolation");
  }
  const oc = await sdk.OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });
  if (oc.message && typeof oc.message.list === "function") {
    const origList = oc.message.list.bind(oc.message);
    oc.message.list = async (args) => { messageLists++; return origList(args); };
  }
  if (!oc.session || typeof oc.session.prompt !== "function") {
    fail("sdk-shape", "oc.session.prompt is not a function on the installed SDK");
  }
  {
    const origPrompt = oc.session.prompt.bind(oc.session);
    oc.session.prompt = async (args) => { promptCalls++; return origPrompt(args); };
  }
  // Boot quiescence gate (fail-closed): session.active must exist and return
  // a direct record map before any bind — never bind blind.
  if (typeof oc.session.active !== "function") {
    fail("boot-active", "oc.session.active (function) is required — refusing boot");
  }
  tedEnv = { oc, dirs: iso.dirs, async close() { await oc.close().catch(() => {}); } };

  // SDK-observed model selection (fail-closed): `oc.model.default()` is the
  // native resolution the provider request will use. It must match the exact
  // provider/model from live-model.json; the offline catalog must also contain
  // ONLY the loopback provider (the product deny-all + explicit allow).
  let sdkProviderID = null;
  let sdkModelID = null;
  if (LIVE_MODE) {
    if (!oc.model || typeof oc.model.default !== "function") {
      fail("sdk-model", "oc.model.default (function) is required — refusing boot");
    }
    const rawDefault = await oc.model.default();
    const resolved = rawDefault && rawDefault.data !== undefined ? rawDefault.data : rawDefault;
    sdkProviderID = resolved && typeof resolved.providerID === "string" ? resolved.providerID : null;
    sdkModelID = resolved && typeof resolved.modelID === "string" ? resolved.modelID : null;
    if (sdkProviderID !== PROVIDER || sdkModelID !== String(MODEL).split("/")[1]) {
      fail("sdk-model", "SDK-observed default model diverged from live-model.json");
    }
    if (MODE === "offline") {
      if (!oc.provider || typeof oc.provider.list !== "function") {
        fail("sdk-model", "oc.provider.list (function) is required — refusing offline boot");
      }
      const rawProviders = await oc.provider.list();
      const providers = Array.isArray(rawProviders) ? rawProviders : rawProviders && rawProviders.data;
      if (!Array.isArray(providers) || providers.length !== 1 || providers[0]?.id !== PROVIDER) {
        fail("sdk-model", "offline provider catalog must contain exactly the loopback provider");
      }
    }
  }

  // Real finance transport against the parent's loopback API, wrapped only
  // to count calls and record read DTOs (fail-closed typed errors pass
  // through untouched).
  let promptCalls = 0;
  let messageLists = 0;
  let transportCalls = 0;
  const financeReads = [];
  const realTransport = new HttpFinanceTransport({ baseUrl: apiBaseUrl, timeoutMs: 8000 });
  const countingTransport = async (args) => {
    transportCalls++;
    const res = await realTransport.call(args);
    // live-real stats keep only route/method/status (no DTO body); the
    // offline/synthetic proofs still expose the body for the scripted oracle.
    financeReads.push(
      MODE === "live-real"
        ? { route: args && args.route, method: args && args.method, statusCode: res.statusCode }
        : { route: args && args.route, method: args && args.method, statusCode: res.statusCode, body: res.body },
    );
    return res;
  };

  // Test-only observation of the native retry hook — LIVE modes ONLY: the
  // PRODUCT plugin registers `ctx.session.hook('retry', …)` during setup
  // (retry veto). We only observe availability/registration/invocations — no
  // behavior change. The default synthetic P2D setup/plugin is left completely
  // untouched (no wrapper, no instrumentation).
  let retryHookAvailable = false;
  let retryHookRegistered = false;
  let retryHookInvocations = 0;
  let retryVetoes = 0;
  // live-real ONLY: observe the FINAL effective catalog from the product
  // plugin's existing `onEffectiveTools` seam and keep only the product
  // finance tools (never the native built-ins). Synthetic gets no extra
  // option at all — its plugin setup is byte-behavior identical.
  let financeToolNames = null;
  const pluginOptions = {};
  if (MODE === "live-real") {
    const PRODUCT_FINANCE_TOOLS = new Set(["list_accounts", "get_month_summary", "list_categories"]);
    pluginOptions.onEffectiveTools = (names, error) => {
      if (error || !Array.isArray(names)) {
        financeToolNames = null;
        return;
      }
      financeToolNames = names.filter((n) => typeof n === "string" && PRODUCT_FINANCE_TOOLS.has(n)).sort();
    };
  }
  const pluginDef = defineTedFinancePlugin(() => countingTransport, pluginOptions);
  if (LIVE_MODE) {
    const origSetup = pluginDef.setup.bind(pluginDef);
    pluginDef.setup = async (ctx) => {
      retryHookAvailable = !!(ctx && ctx.session && typeof ctx.session.hook === "function");
      if (retryHookAvailable) {
        try {
          const originalHook = ctx.session.hook;
          const wrappedSession = Object.create(ctx.session);
          wrappedSession.hook = (name, fn) => {
            if (name !== "retry") return originalHook.call(ctx.session, name, fn);
            retryHookRegistered = true;
            const wrapped = (event) => {
              retryHookInvocations++;
              const out = fn(event);
              if (event && event.decision && event.decision.retry === false) retryVetoes++;
              return out;
            };
            return originalHook.call(ctx.session, name, wrapped);
          };
          ctx.session = wrappedSession;
        } catch {
          retryHookRegistered = false;
        }
      }
      return origSetup(ctx);
    };
  }
  await wirePlugin(oc, pluginDef);

  // Test-only session wrapper (declared simplification): per-session
  // serialized bind → run → revoke using the REAL session-bindings. This is
  // NOT the product withAuthenticatedSession (no idle-probe/quarantine —
  // that wrapper is covered by the gateway-auth tests with a stub prompt
  // host; here the prompt host is real and the wrapper choice is explicit).
  const sessionQueues = new Map();
  const withAuthenticatedSession = async (sessionID, host, fn) => {
    if (typeof sessionID !== "string" || sessionID.length === 0) throw new Error("sessionID is required");
    if (!host || typeof host !== "object") throw new Error("host context is required");
    if (typeof fn !== "function") throw new Error("fn is required");
    const execute = async () => {
      await oc.session.get({ sessionID });
      let current = null;
      try { current = getBinding(sessionID) ?? null; } catch { current = null; }
      const live = current && !current.revoked ? current : null;
      if (live) {
        if (!isSameHost(live.host, host)) rotateSessionBinding(sessionID, host);
      } else {
        bindSession(sessionID, host);
      }
      try {
        return await fn();
      } finally {
        try { revokeSession(sessionID); } catch { /* best effort */ }
      }
    };
    const tail = sessionQueues.get(sessionID) ?? Promise.resolve();
    const run = tail.then(execute, execute);
    const settled = run.then(
      (value) => { if (sessionQueues.get(sessionID) === settled) sessionQueues.delete(sessionID); return value; },
      (e) => { if (sessionQueues.get(sessionID) === settled) sessionQueues.delete(sessionID); throw e; },
    );
    sessionQueues.set(sessionID, settled);
    settled.catch(() => {});
    return run;
  };

  let lastSession = null;
  let lastSessionId = null;
  const createNativeSession = async () => {
    const s = await oc.session.create({ title: "ted-finance", agent: "ted" });
    lastSession = s;
    lastSessionId = s && typeof s.id === "string" ? s.id : null;
    return s.id;
  };

  const store = createConversationStore({ persistDir: tedEnv.dirs.state });
  // Test-only conversation index (opaque IDs only): records every
  // conversationId the gateway creates/attaches with its native
  // runtimeSessionId, so the `snapshot-list`/`snapshot` commands can report
  // stability evidence without ever exposing tokens, cookies or text.
  const seenConversations = new Map();
  const noteConversation = (conversationId, runtimeSessionId) => {
    if (typeof conversationId !== "string" || conversationId.length === 0) return;
    const prev = seenConversations.get(conversationId) || {};
    seenConversations.set(conversationId, {
      runtimeSessionId: typeof runtimeSessionId === "string" && runtimeSessionId.length > 0
        ? runtimeSessionId
        : (prev.runtimeSessionId ?? null),
    });
  };
  try {
    const origCreate = store.create.bind(store);
    store.create = (args) => {
      const rec = origCreate(args);
      try { noteConversation(rec && rec.conversationId, rec && rec.runtimeSessionId); } catch { /* index never breaks */ }
      return rec;
    };
  } catch { /* index never breaks */ }
  try {
    const origAttach = store.attachRuntime.bind(store);
    store.attachRuntime = (conversationId, runtimeSessionId, runtimeOwner) => {
      const rec = origAttach(conversationId, runtimeSessionId, runtimeOwner);
      try { noteConversation(conversationId, runtimeSessionId); } catch { /* index never breaks */ }
      return rec;
    };
  } catch { /* index never breaks */ }
  // Rehydrate the index from the persisted store (same root across OS
  // restarts): conversations created/attached by a PREVIOUS probe process
  // are visible to snapshot commands. IDs only, read from the store file
  // the product itself persists — never a transcript import.
  try {
    const raw = fs.readFileSync(path.join(tedEnv.dirs.state, "conversations.json"), "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (Array.isArray(items)) {
      for (const r of items) {
        if (r && typeof r.conversationId === "string") {
          noteConversation(r.conversationId, typeof r.runtimeSessionId === "string" ? r.runtimeSessionId : null);
        }
      }
    }
  } catch { /* fresh root: index starts empty */ }
  const hashText = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
  async function buildSnapshot(conversationId) {
    const tracked = seenConversations.get(conversationId) || null;
    const runtimeSessionId = tracked && tracked.runtimeSessionId ? tracked.runtimeSessionId : null;
    if (!runtimeSessionId) {
      return { phase: "serve-snapshot", conversationId, error: "unknown conversation (no attached native session observed)" };
    }
    const page = await oc.message.list({ sessionID: runtimeSessionId, limit: 50, order: "asc" });
    const rows = Array.isArray(page) ? page : page?.data;
    if (!Array.isArray(rows)) {
      return { phase: "serve-snapshot", conversationId, runtimeSessionId, error: "native history unreadable" };
    }
    const userMessages = [];
    const assistantMessages = [];
    for (const m of rows) {
      if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
      if (m.type === "user" && typeof m.text === "string") {
        userMessages.push({ id: m.id, hash: hashText(m.text) });
      } else if (m.type === "assistant" && Array.isArray(m.content)) {
        const text = m.content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
        if (text.length > 0) assistantMessages.push({ id: m.id, hash: hashText(text) });
      }
    }
    return {
      phase: "serve-snapshot",
      conversationId,
      runtimeSessionId,
      userMessages,
      assistantMessages,
      promptCalls,
      transportCalls,
      stubTurns: chatRequests.length,
      financeReads: financeReads.map((r) => ({ route: r.route, method: r.method, statusCode: r.statusCode })),
    };
  }
  const realHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250, diagnosticsSink: () => {} });
  const promptHost = {
    chat: (args) => realHost.chat(args),
    readRawMessages: (args) => realHost.readRawMessages(args),
    readHistory: (args) => realHost.readHistory(args),
  };

  gateway = createGatewayServer({
    resolveIdentity: ({ cookie, deviceToken, workspaceId }) =>
      resolveGatewayIdentity({ apiBaseUrl, cookie, deviceToken, workspaceId }),
    store,
    promptHost,
    createRuntimeSession: async () => ({ runtimeSessionId: await createNativeSession() }),
    withAuthenticatedSession,
    diagnosticsSink: () => {},
  });
  const info = await gateway.listen({ port: GATEWAY_PORT, host: "127.0.0.1" });
  if (info.host !== "127.0.0.1") fail("listen", `gateway must stay loopback, got ${info.host}`);
  const ready = {
    ok: true, phase: "serve-ready",
    base: `http://${info.host}:${info.port}`,
  };
  if (MODE === "synthetic") {
    // Byte-identical to the historical ready line.
    ready.stubUrl = stubUrl;
  } else {
    Object.assign(ready, {
      mode: MODE,
      profile: PROFILE,
      provider: PROVIDER,
      model: MODEL,
      agent: "ted",
      providerLoopback: MODE === "offline",
      credentialSource: CREDENTIAL_SOURCE,
      // Observed, never hardcoded: live-real observes the native
      // OPENCODE_API_KEY; offline observes the dummy apiKey in the composed
      // provider config.
      credentialPresent,
      fetchGuard: MODE === "offline" ? "loopback-only" : LIVE_REAL_FETCH_GUARD,
      sdkProviderID,
      sdkModelID,
      ...(MODE === "live-real" ? { liveFetchGuard: liveRealGuard, financeToolNames } : {}),
    });
  }
  emit(ready);

  const offeredToolNames = () => {
    for (const r of chatRequests) {
      const tools = r && r.body && Array.isArray(r.body.tools) ? r.body.tools : [];
      const names = tools.map((t) => t && t.function && t.function.name).filter((n) => typeof n === "string");
      if (names.length > 0) return names;
    }
    return [];
  };

  await new Promise((resolve) => {
    let buf = "";
    const onData = async (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          if (line === "stats") {
            const stats = {
              phase: "serve-stats", promptCalls, transportCalls, messageLists,
              stubTurns: chatRequests.length, offeredTools: offeredToolNames(), stubRemotes,
              stubMismatches, fetchBlockedCatalog, fetchBlockedUnexpected, fetchAllowedLoopback,
              stubUrlCounts: chatRequests.reduce((acc, r) => {
                const u = String((r && r.url) || "?").split("?")[0];
                acc[u] = (acc[u] || 0) + 1;
                return acc;
              }, {}),
              financeReads,
            };
            if (MODE !== "synthetic") {
              Object.assign(stats, {
                mode: MODE,
                profile: PROFILE,
                provider: PROVIDER,
                model: MODEL,
                agent: lastSession && typeof lastSession.agent === "string" ? lastSession.agent : null,
                sessionId: lastSessionId,
                providerLoopback: MODE === "offline",
                credentialSource: CREDENTIAL_SOURCE,
                credentialPresent,
                fetchGuard: MODE === "offline" ? "loopback-only" : LIVE_REAL_FETCH_GUARD,
                sdkProviderID,
                sdkModelID,
                ...(MODE === "offline" ? { stubModels: chatModels } : {}),
                ...(MODE === "live-real" ? { liveFetchGuard: liveRealGuard, financeToolNames } : {}),
                retryHookAvailable,
                retryHookRegistered,
                retryHookInvocations,
                retryVetoes,
              });
            }
            emit(stats);
          } else if (line === "fail-provider") {
            ctl.failProvider = true;
            emit({ phase: "serve-ctl", failProvider: true });
          } else if (line === "recover-provider" || line === "recover" || line === "ok" || line === "heal") {
            ctl.failProvider = false;
            emit({ phase: "serve-ctl", failProvider: false });
          } else if (line === "snapshot-list") {
            emit({ phase: "serve-snapshot-list", conversations: [...seenConversations.keys()] });
          } else if (line.startsWith("snapshot ")) {
            const wanted = line.slice("snapshot ".length).trim().slice(0, 80);
            try {
              emit(await buildSnapshot(wanted));
            } catch (e) {
              // live-real: fixed text only (native errors may embed the
              // credential in any form); offline/synthetic keep diagnostics.
              emit({
                phase: "serve-snapshot",
                conversationId: wanted,
                error:
                  MODE === "live-real"
                    ? "native snapshot unavailable (details redacted)"
                    : String((e && e.message) || e).slice(0, 200),
              });
            }
          } else if (line === "close" || line === "exit" || line === "quit") {
            process.stdin.off("data", onData);
            resolve();
            return;
          } else {
            emit({ phase: "serve-ctl", unknown: line.slice(0, 80) });
          }
        } catch (e) {
          emit({ phase: "serve-ctl", error: String((e && e.message) || e).slice(0, 200) });
        }
      }
    };
    process.stdin.on("data", onData);
  });

  const counters = { promptCalls, transportCalls, messageLists, stubTurns: chatRequests.length, stubMismatches };
  // Staged shutdown telemetry (test-only, stdout lines): proves which stage
  // completes if orderly shutdown ever stalls.
  emit({ phase: "serve-closing", stage: "gateway" });
  try { await gateway.close(); } catch { /* best effort */ }
  emit({ phase: "serve-closing", stage: "stub" });
  try {
    // Same orderly pattern as the gateway: destroy idle/keep-alive sockets
    // first (the SDK provider client holds keep-alive connections to the
    // stub), then close. Plain close() would wait for idle sockets and hang
    // shutdown; this only drops transport sockets, never proof state.
    const stubAny = stubServer;
    try {
      if (stubAny && typeof stubAny.closeAllConnections === "function") stubAny.closeAllConnections();
      else if (stubAny && typeof stubAny.closeIdleConnections === "function") stubAny.closeIdleConnections();
    } catch { /* best effort */ }
    await new Promise((r) => stubServer.close(r));
  } catch { /* best effort */ }
  emit({ phase: "serve-closing", stage: "sdk" });
  try { await tedEnv.close(); } catch { /* best effort */ }
  emit({ phase: "serve-closed", ...counters });
} catch (e) {
  // live-real: never surface the original error/cause/stack — SDK internals
  // may embed the credential in any form. Offline/synthetic keep the
  // existing diagnostics (dummy key only, never a real credential).
  if (MODE === "live-real") {
    console.error("[p2d-probe] live-real fatal (details redacted)");
  } else if (e instanceof ProbeFail) {
    console.error(`[p2d-probe] ${e.step}: ${e.detail}`);
  } else {
    console.error(`[p2d-probe] fatal: ${String((e && e.stack) || e).slice(0, 2000)}`);
  }
  try { if (gateway) await gateway.close(); } catch { /* noop */ }
  try { if (stubServer) await new Promise((r) => stubServer.close(r)); } catch { /* noop */ }
  try { if (tedEnv) await tedEnv.close(); } catch { /* noop */ }
  process.exitCode = 1;
}
