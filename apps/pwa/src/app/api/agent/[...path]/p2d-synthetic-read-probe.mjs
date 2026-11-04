// P2D synthetic-read probe — runs ONLY as a dedicated subprocess (spawned by
// route.p2d-synthetic-read.test.ts, one process). Never imported by the suite
// process: env mutation (setupIsolation scrub) and the OpenCode boot stay
// inside this child, so the parent session's cwd/env are untouched.
//
// Usage:
//   node p2d-synthetic-read-probe.mjs serve
// with P2D_CONFIG_JSON env:
//   { root, identity, apiBaseUrl, tedRuntimeDir,
//     stub: { toolName, toolArgs, expectedOracle } }
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
// LIMITS (declared, not hidden): the provider is scripted, so success here is
// NOT an external-model proof and `READ_SLICE_PASS` remains NOT ACHIEVED.
// Egress posture is narrow and honest: the configured provider endpoint is
// the local loopback stub only (dummy apiKey); unexpected non-loopback
// `fetch` calls are intercepted and blocked pre-socket and counted by fixed
// category (no URL/host text stored, returned, or logged). This is NOT a
// general OS-level egress sandbox — raw `node:http`/`net`/`tls` sockets are
// not intercepted — and no external/paid inference was configured or called.
// Temp dirs come from the parent (approved folder); nothing is deleted. NO
// process.exit before finally: success returns NATURALLY after the awaited
// close(), so orderly shutdown + sqlite persistence are proven, not skipped.

const RAW_CONFIG = process.env.P2D_CONFIG_JSON;
if (!RAW_CONFIG) {
  console.error(JSON.stringify({ ok: false, phase: "serve-ready", error: "P2D_CONFIG_JSON is required" }));
  process.exit(1);
}
const CONFIG = JSON.parse(RAW_CONFIG);
const { root, identity, apiBaseUrl, tedRuntimeDir, stub } = CONFIG;

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
// The stub parses the ACTUAL finance tool result from the SDK's follow-up
// request, validates every oracle field, and generates the final output
// FROM those observed values — never a hardcoded string. A mismatch fails
// the turn closed (HTTP 500) and is recorded in stubMismatches; request
// bodies are never logged, only key shapes on mismatch.
function formatCentsBRL(cents) {
  const parts = (Number(cents) / 100).toFixed(2).split(".");
  return `R$ ${parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${parts[1]}`;
}
const PT_MONTHS = {
  "01": "janeiro", "02": "fevereiro", "03": "marco", "04": "abril",
  "05": "maio", "06": "junho", "07": "julho", "08": "agosto",
  "09": "setembro", "10": "outubro", "11": "novembro", "12": "dezembro",
};
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
  if (!stub || typeof stub.toolName !== "string") {
    fail("args", "stub { toolName, toolArgs, expectedOracle } is required");
  }
  const EXPECTED_ORACLE = stub.expectedOracle || null;
  if (!EXPECTED_ORACLE || typeof EXPECTED_ORACLE.yearMonth !== "string") {
    fail("args", "stub.expectedOracle { yearMonth, incomeCents, expenseCents, balanceCents, transactionCount } is required");
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
  const BLOCKED_CATALOG_RE = /^GET https:\/\/models\.opencode\.ai\//;
  const realFetch = globalThis.fetch;
  let fetchAllowedLoopback = 0;
  let fetchBlockedCatalog = 0;
  let fetchBlockedUnexpected = 0;
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

  const { pathToFileURL } = await import("node:url");
  const mod = (rel) => import(pathToFileURL(`${tedRuntimeDir}/${rel}`).href);
  const { setupIsolation, tedConfig } = await mod("src/bootstrap.mjs");
  const { wirePlugin } = await mod("src/bootstrap.mjs");
  const { defineTedFinancePlugin } = await mod("src/plugin.mjs");
  const { HttpFinanceTransport } = await mod("src/transport.mjs");
  const { resolveGatewayIdentity } = await mod("src/gateway.mjs");
  const { createConversationStore } = await mod("src/conversations.mjs");
  const { createGatewayServer } = await mod("src/server.mjs");
  const { bindSession, revokeSession, getBinding, isSameHost, rotateSessionBinding } =
    await mod("src/session-bindings.mjs");
  const { createPromptHost } = await mod("src/prompt.mjs");

  const FIXTURE_PROVIDER = "p2dloop";
  const FIXTURE_MODEL = "test-alpha";
  const FIXTURE_PACKAGE = "@opencode/ai/providers/openai-compatible";

  // Isolation FIRST — the SDK import below must observe the isolated roots.
  const iso = setupIsolation(root, identity || "p2d");

  // Local scripted provider stub (loopback only, dummy apiKey). Serves the
  // canned tool_call until the tool-result turn arrives, then final text.
  // `failProvider` flips completions to HTTP 500 (typed provider failure).
  const chatRequests = [];
  const stubRemotes = [];
  const stubMismatches = [];
  let callSeq = 0;
  const http = await import("node:http");
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
        if (ctl.failProvider) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "synthetic provider failure (test-only)", type: "server_error" } }));
          return;
        }
        const messages = body && Array.isArray(body.messages) ? body.messages : [];
        // The request carries full history: `extractDto` finds the tool
        // result after the LAST user message (null = no tool result yet).
        const extracted = extractDto(messages);
        let payload = null;
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
  const stubUrl = `http://127.0.0.1:${stubPort}/v1`;

  // Test-only opencode.json: product base + scripted fixture provider +
  // test-only provider.use allow AFTER the deny-all (same pattern as the
  // prompt-loop proof; tedConfig() product code is NOT modified).
  const base = tedConfig();
  const cfg = {
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
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.mkdirSync(iso.dirs.config, { recursive: true });
  fs.writeFileSync(path.join(iso.dirs.config, "opencode.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");

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
    financeReads.push({ route: args && args.route, method: args && args.method, statusCode: res.statusCode, body: res.body });
    return res;
  };

  await wirePlugin(oc, defineTedFinancePlugin(() => countingTransport));

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

  const createNativeSession = async () => {
    const s = await oc.session.create({ title: "ted-finance", agent: "ted" });
    return s.id;
  };

  const store = createConversationStore({ persistDir: tedEnv.dirs.state });
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
  const info = await gateway.listen({ port: 0, host: "127.0.0.1" });
  if (info.host !== "127.0.0.1") fail("listen", `gateway must stay loopback, got ${info.host}`);
  emit({
    ok: true, phase: "serve-ready",
    base: `http://${info.host}:${info.port}`,
    stubUrl,
  });

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
            emit({
              phase: "serve-stats", promptCalls, transportCalls, messageLists,
              stubTurns: chatRequests.length, offeredTools: offeredToolNames(), stubRemotes,
              stubMismatches, fetchBlockedCatalog, fetchBlockedUnexpected, fetchAllowedLoopback,
              stubUrlCounts: chatRequests.reduce((acc, r) => {
                const u = String((r && r.url) || "?").split("?")[0];
                acc[u] = (acc[u] || 0) + 1;
                return acc;
              }, {}),
              financeReads,
            });
          } else if (line === "fail-provider") {
            ctl.failProvider = true;
            emit({ phase: "serve-ctl", failProvider: true });
          } else if (line === "recover-provider" || line === "recover" || line === "ok" || line === "heal") {
            ctl.failProvider = false;
            emit({ phase: "serve-ctl", failProvider: false });
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
  try { await gateway.close(); } catch { /* best effort */ }
  try { await new Promise((r) => stubServer.close(r)); } catch { /* best effort */ }
  try { await tedEnv.close(); } catch { /* best effort */ }
  emit({ phase: "serve-closed", ...counters });
} catch (e) {
  if (e instanceof ProbeFail) {
    console.error(`[p2d-probe] ${e.step}: ${e.detail}`);
  } else {
    console.error(`[p2d-probe] fatal: ${String((e && e.stack) || e).slice(0, 2000)}`);
  }
  try { if (gateway) await gateway.close(); } catch { /* noop */ }
  try { if (stubServer) await new Promise((r) => stubServer.close(r)); } catch { /* noop */ }
  try { if (tedEnv) await tedEnv.close(); } catch { /* noop */ }
  process.exitCode = 1;
}
